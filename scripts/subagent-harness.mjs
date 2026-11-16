/**
 * Standalone harness for the optional CLI subagent capability
 * (`@local/dsh-provider-lan-agent/subagent`).
 *
 * Mounts a minimal Cordis context with the REAL `LocalSubprocessRuntime`, calls
 * the entry's `apply()` (capturing the provider it registers), and drives
 * `provider.start()` directly. This exercises the plugin's own code path —
 * argv, env, collect readers, banner stripping, cancellation, deadlines, and
 * the never-rejecting result contract — without installing anything into a
 * profile.
 *
 * Run `test/make-anchor.sh` first: the entry imports bare `@deepseek-ai/*`
 * specifiers, which resolve from THIS directory only through the dev anchor.
 * Remove the anchor afterwards (it points into the nix store).
 *
 *   node test/subagent-harness.mjs
 *
 * NOTE: section 2 and later run a REAL delegation against the vendor backend.
 * A live token must be reachable — the harness context exposes no credentials
 * seam, so the token file is the only source it can use.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import * as plugin from '../subagent.js'
import { CLI_BASENAME, CLI_HOME_DIRNAME, PROVIDER } from '../src/vendorName.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = join(HERE, '..')
const CLI_BIN = join(PLUGIN_DIR, 'bin', CLI_BASENAME)
const TOKEN_FILE = join('~', CLI_HOME_DIRNAME, 'auth', 'prod', 'token')

const baseConfig = {
  binaryPath: CLI_BIN,
  homeDir: join(PLUGIN_DIR, 'home'),
  model: 'deepseek-v4.1-flash',
  tokenFile: TOKEN_FILE,
  timeoutMs: 180_000,
}

let pass = 0
let fail = 0
function check(label, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Mount the real subprocess seam and register the plugin's provider for real. */
async function mountProvider(config) {
  const root = new Context()
  await root.plugin(SubprocessLocal, {})
  let provider
  const ctx = {
    subprocess: root.subprocess,
    get: () => undefined,
    effect: (fn) => fn(),
    subagents: {
      registerProvider(candidate) {
        provider = candidate
        return () => {}
      },
    },
  }
  plugin.apply(ctx, config)
  return { provider, root }
}

function startRequest(prompt, cwd = PLUGIN_DIR) {
  return {
    prompt: [{ type: 'text', text: prompt }],
    parent: { meta: { cwd } },
    signal: new AbortController().signal,
  }
}

async function main() {
  console.log('== 1. 注册与配置校验 ==')
  {
    const { provider, root } = await mountProvider(baseConfig)
    check(`provider 名为 ${PROVIDER}`, provider?.name === PROVIDER, provider?.name)
    check(
      'capabilities 全 false（外部进程不支持父级强加特性）',
      provider?.capabilities?.outputSchema === false
        && provider?.capabilities?.toolFilter === false
        && provider?.capabilities?.persona === false
        && provider?.capabilities?.depthLimit === false,
      JSON.stringify(provider?.capabilities),
    )
    check('inheritsParentContext = false', provider?.inheritsParentContext === false)
    await root.fiber.dispose()
  }
  {
    // The M2 contract inverted the old behaviour: a missing binary must NOT
    // fail the mount (it would take this row — and, merged, nothing else —
    // down, and would make the settings banner impossible). It withdraws the
    // provider instead, so the model-facing tool never appears.
    let threw = ''
    let provider
    try {
      ;({ provider } = await mountProvider({ ...baseConfig, binaryPath: join(PLUGIN_DIR, 'bin', 'does-not-exist') }))
    } catch (error) {
      threw = String(error.message ?? error)
    }
    check('二进制缺失不抛错', threw === '', threw.slice(0, 100))
    check('二进制缺失时不注册 provider（工具对任何 agent 都不存在）', provider === undefined, String(provider))
  }
  {
    let threw = ''
    try {
      await mountProvider({ ...baseConfig, model: '' })
    } catch (error) {
      threw = String(error.message ?? error)
    }
    check('空 model 被拒（后端无 model 会永久挂起）', threw.includes('model must be a non-empty string'), threw.slice(0, 80))
  }

  console.log('== 2. 真实委派（happy path）==')
  const { provider, root } = await mountProvider(baseConfig)
  {
    const t0 = Date.now()
    const run = await provider.start(startRequest('Reply with exactly the single word: PONG'))
    check('run.localAgent 为 undefined（远程子代理）', run.localAgent === undefined)
    check('run.id 非空', typeof run.id === 'string' && run.id.length > 0, run.id)
    const result = await run.result
    const text = result.output.map((b) => b.text ?? '').join('')
    check('stopReason = completed', result.stopReason === 'completed', result.stopReason)
    check('答案里没有横幅残留', !/环境: |已登录|全委托模式|^log → /mu.test(text), JSON.stringify(text.slice(0, 80)))
    check('答案命中 PONG', /PONG/u.test(text), JSON.stringify(text.slice(0, 120)))
    console.log(`        （耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，返回 ${JSON.stringify(text.slice(0, 60))}）`)
    await run.dispose()
  }

  console.log('== 3. 空 prompt 被拒 ==')
  {
    let threw = ''
    try {
      await provider.start({
        prompt: [],
        parent: { meta: { cwd: PLUGIN_DIR } },
        signal: new AbortController().signal,
      })
    } catch (error) {
      threw = String(error.message ?? error)
    }
    check('空 prompt 让 start 直接拒绝', threw.includes('no text'), threw.slice(0, 80))
  }

  console.log('== 4. 取消（aborted）==')
  {
    const controller = new AbortController()
    const run = await provider.start({
      prompt: [{ type: 'text', text: 'Count slowly from 1 to 200, one number per line.' }],
      parent: { meta: { cwd: PLUGIN_DIR } },
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 2500)
    const result = await run.result
    check('取消后 stopReason = aborted', result.stopReason === 'aborted', result.stopReason)
    await run.dispose()
  }

  console.log('== 5. 失败路径必须可读，且绝不挂死 ==')
  {
    // Deterministic non-zero exit: an executable that is not the CLI at all.
    const { provider: p2 } = await mountProvider({ ...baseConfig, binaryPath: '/bin/false' })
    const run = await p2.start(startRequest('hello'))
    const result = await run.result
    const text = result.output.map((b) => b.text ?? '').join(' ')
    check('非零退出 → stopReason = error', result.stopReason === 'error', result.stopReason)
    check('失败原因出现在 output 里（否则工具结果是空的）', /exited with/u.test(text), JSON.stringify(text.slice(0, 120)))
  }
  {
    // Deterministic deadline: a 1 ms budget aborts the run immediately.
    const { provider: p3 } = await mountProvider({ ...baseConfig, timeoutMs: 1 })
    const t0 = Date.now()
    const run = await p3.start(startRequest('hello'))
    const result = await run.result
    const elapsed = (Date.now() - t0) / 1000
    const text = result.output.map((b) => b.text ?? '').join(' ')
    check('deadline 触发 → stopReason = error', result.stopReason === 'error', result.stopReason)
    check('超时原因出现在 output 里', /exceeded/u.test(text), JSON.stringify(text.slice(0, 120)))
    check(`deadline 立即生效（${elapsed.toFixed(1)}s）`, elapsed < 15, `${elapsed.toFixed(1)}s`)
  }
  {
    // Recorded behaviour, not an aspiration: the backend does NOT validate the
    // model string, so a typo silently falls back to its default model instead
    // of failing. The `--model` FLAG is still mandatory (without it the backend
    // streams keepalives forever), but its VALUE is not checked.
    const { provider: p4 } = await mountProvider({ ...baseConfig, model: 'no-such-model-xyz' })
    const run = await p4.start(startRequest('Reply with exactly the single word: PONG'))
    const result = await run.result
    check('未知 model 不被拒绝（服务端回落默认模型）', result.stopReason === 'completed', result.stopReason)
    await run.dispose()
  }

  await root.fiber.dispose()
  console.log(`\n== 结果: ${pass} 通过 / ${fail} 失败 ==`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('harness 崩了:', error)
  process.exit(2)
})
