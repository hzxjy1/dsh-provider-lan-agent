/**
 * The CLI invocation: argv shape, isolated HOME, seeded auth, banner stripping.
 *
 * The one-shot contract (measured against the pinned binary, linux-x64):
 *
 *   HOME=<isolated> <CLI_LOG_ENV>=0 \
 *   <cli> --env <env> --cwd <dir> --no-mcp --full-delegation \
 *         --model <group-id> --mode action <prompt>
 *
 *   exit 0, and stdout is a fixed banner followed by the answer. The banner is
 *   matched by prefix, so a changed URL or wording does not reintroduce it.
 *
 * Authentication never goes through an interactive login: the JWT is resolved
 * from the credential seam (or the token file) and written into the CLI's own
 * config, which it accepts. The token is re-seeded before every run, so a
 * rotated credential reaches the next delegation with no restart.
 *
 * @module src/subagent/runner
 */

import { dirname, join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

import { CLI_HOME_DIRNAME, CLI_LOG_ENV, PLUGIN_NAME } from '../vendorName.js'

/** In-memory cap for the answer; it is a final report, not a transcript. */
export const STDOUT_MAX_BYTES = 1 << 20

/** In-memory cap for diagnostics; only the tail is ever reported. */
export const STDERR_MAX_BYTES = 1 << 16

/** Leading banner lines the CLI prints before the answer. */
const BANNER = [/^log → /u, /^环境: /u, /^✅\s*已登录/u, /^🤖\s*全委托模式/u, /^ℹ️\s*未登录/u]

/**
 * Flatten the delegated prompt into the single positional argument the CLI
 * takes. Non-text blocks (images, attachments) have no CLI equivalent and are
 * reported by omission rather than silently rendered as text.
 *
 * @param {readonly object[]} blocks the request's content blocks.
 * @returns {string}
 */
export function promptText(blocks) {
  const parts = []
  for (const block of blocks ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n\n')
}

/**
 * Read one collected stream in full.
 *
 * @param {{readFrom?: Function}|undefined} reader
 * @returns {string}
 */
export function readAll(reader) {
  if (reader === undefined) return ''
  return reader.readFrom(0).text ?? ''
}

/**
 * Drop the CLI's leading banner, keeping the answer.
 *
 * @param {string} text raw stdout.
 * @returns {string}
 */
export function stripBanner(text) {
  const lines = text.split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index].trimEnd()
    if (line.length === 0 || BANNER.some((pattern) => pattern.test(line))) {
      index += 1
      continue
    }
    break
  }
  return lines.slice(index).join('\n')
}

/**
 * Last few lines of a diagnostic stream, for a failure message.
 *
 * @param {string} text
 * @param {number} [lines]
 * @returns {string}
 */
export function tail(text, lines = 4) {
  const parts = text.trim().split('\n')
  return parts.slice(-lines).join(' / ').slice(0, 600)
}

/**
 * Resolve the JWT the CLI should hold: the credential seam first, then the
 * vendor CLI's own token file.
 *
 * @param {object} ctx plugin context.
 * @param {object} config resolved configuration.
 * @returns {Promise<string|undefined>}
 */
export async function resolveToken(ctx, config) {
  try {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(config.credentialsRef)
      if (hit?.value) return hit.value.trim()
    }
  } catch {
    /* a credential seam that refuses this reference falls through to the file */
  }
  if (config.tokenFile !== undefined) {
    try {
      const text = await readFile(config.tokenFile, 'utf8')
      if (text.trim().length > 0) return text.trim()
    } catch {
      /* an unreadable import source leaves the CLI's stored session in place */
    }
  }
  return undefined
}

/**
 * Make the CLI's own login state current. The CLI re-reads its config at
 * startup, so writing the token here is the whole authentication step.
 *
 * @param {object} ctx plugin context.
 * @param {object} config resolved configuration.
 */
export async function seedAuth(ctx, config) {
  if (config.serverUrl.length === 0 || config.username.length === 0) {
    // No deployment-supplied origin/account. Leave the CLI's own login state
    // exactly as it is: writing blanks would erase a working config, and the
    // package itself never knows the right values.
    ctx.logger?.warn?.(`${PLUGIN_NAME}: no serverUrl/username from the deployment; leaving the CLI login state untouched (set LAN_AGENT_SERVER_URL / LAN_AGENT_USERNAME or $DSH_HOME/lan-agent.deployment.json)`)
    return
  }
  const token = await resolveToken(ctx, config)
  if (token === undefined) return
  const authDir = join(config.homeDir, CLI_HOME_DIRNAME, 'CLI')
  const authPath = join(authDir, 'cli-config.json')
  let current = {}
  try {
    current = JSON.parse(await readFile(authPath, 'utf8'))
  } catch {
    current = {}
  }
  if (current.token === token) return
  await mkdir(authDir, { recursive: true })
  const next = {
    ...current,
    server_url: config.serverUrl,
    auth_base_path: config.authBasePath,
    username: config.username,
    token,
    token_issued_at: new Date().toISOString(),
  }
  await writeFile(authPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

/**
 * Spawn one headless CLI run.
 *
 * @param {object} ctx plugin context.
 * @param {object} config resolved configuration.
 * @param {{cwd: string, model: string, prompt: string, signal: AbortSignal}} input
 * @returns {object} the subprocess handle.
 */
export function spawnCli(ctx, config, { cwd, model, prompt, signal }) {
  const argv = [
    config.binaryPath,
    '--env', config.envName,
    '--cwd', cwd,
    '--no-mcp',
    ...(config.fullDelegation
      ? ['--full-delegation']
      : ['--permission-mode', config.permissionMode]),
    ...(config.allowedTools === undefined ? [] : ['--allowedTools', ...config.allowedTools]),
    '--model', model,
    '--mode', config.mode,
    '--max-budget-usd', String(config.maxBudgetUsd),
    prompt,
  ]
  return ctx.subprocess.spawn({
    argv,
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: STDOUT_MAX_BYTES },
      stderr: { maxBytes: STDERR_MAX_BYTES },
    },
    graceMs: config.graceMs,
    signal,
    env: {
      ...scrubbedParentEnv(),
      HOME: config.homeDir,
      [CLI_LOG_ENV]: '0',
      PATH: `${dirname(config.binaryPath)}:${process.env.PATH ?? ''}`,
    },
  })
}
