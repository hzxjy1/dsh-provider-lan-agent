/**
 * The `ctx.subagents` provider that runs one headless CLI delegation.
 *
 * A child in another process cannot honor parent-enforced start features, so
 * the provider reports only the capabilities it really has
 * (`NO_START_CAPABILITIES`), never inherits the parent's conversation, and is
 * paired with a tool row configured `maxDepth: provider-managed`: the
 * delegation budget belongs to the child, not to the parent.
 *
 * The provider is registered ONLY while the CLI binary exists, so the tool row
 * mounts and withdraws the model-facing tool with it — a missing binary leaves
 * no broken tool behind for any agent to call.
 *
 * @module src/subagent/provider
 */

import { assertUsableCwd, NO_START_CAPABILITIES, settleRunResult, subprocessRunHandle } from '@deepseek-ai/dsh-subagent'

import { CLI_BASENAME, PLUGIN_NAME, PROVIDER } from '../vendorName.js'
import { resolveChildCwd } from './config.js'
import { promptText, readAll, seedAuth, spawnCli, stripBanner, tail } from './runner.js'
import { cliHint } from './status.js'
import { binaryPresent } from './watch.js'

const PREFIX = PLUGIN_NAME

/**
 * Build the provider registered on `ctx.subagents`.
 *
 * @param {object} ctx plugin context.
 * @param {object} config resolved configuration.
 * @returns {object} the provider.
 */
export function makeProvider(ctx, config) {
  return {
    name: PROVIDER,
    capabilities: NO_START_CAPABILITIES,
    /** The CLI gets a self-contained task and never sees the parent's history. */
    inheritsParentContext: false,
    async start(request) {
      // The watch should have withdrawn the provider already; this covers the
      // race between the file disappearing and the state settling.
      if (!binaryPresent(config.binaryPath)) throw new Error(cliHint(config.binaryPath))
      const requestedCwd = typeof request.cwd === 'string' && request.cwd.length > 0 ? request.cwd : undefined
      const parentCwd = request.parent?.meta?.cwd
      const cwd = resolveChildCwd(config.configuredCwd, requestedCwd, parentCwd)
      assertUsableCwd(PREFIX, 'resolved cwd', cwd)
      await seedAuth(ctx, config)

      const prompt = promptText(request.prompt)
      if (prompt.trim().length === 0) throw new Error(`${PREFIX}: the delegated prompt carried no text`)

      const model = request.agentOptions?.model ?? config.model
      // The delegation deadline is the provider's own policy; the request
      // signal stays the seam's cancellation channel and is classified apart.
      const deadline = AbortSignal.timeout(config.timeoutMs)
      const spawnSignal = AbortSignal.any([request.signal, deadline])
      const handle = spawnCli(ctx, config, { cwd, model, prompt, signal: spawnSignal })

      let cancelled = false
      const onAbort = () => {
        cancelled = true
      }
      request.signal.addEventListener('abort', onAbort, { once: true })

      /** Why the run failed, when it did; the seam's result carries no message. */
      let failureNote = ''
      const attempt = async () => {
        try {
          const outcome = await handle.done
          const stdout = readAll(handle.collected?.stdout)
          const stderr = readAll(handle.collected?.stderr)
          if (request.signal.aborted) throw new Error(`${PREFIX}: delegation cancelled`)
          if (deadline.aborted) throw new Error(`${PREFIX}: ${CLI_BASENAME} exceeded ${config.timeoutMs} ms`)
          if (outcome.exitCode !== 0) {
            throw new Error(
              `${PREFIX}: ${CLI_BASENAME} exited with ${outcome.exitCode ?? outcome.signal}`
              + (tail(stderr) || tail(stdout) ? `: ${tail(stderr) || tail(stdout)}` : ''),
            )
          }
          const text = stripBanner(stdout).trim()
          if (text.length === 0) throw new Error(`${PREFIX}: ${CLI_BASENAME} produced no answer`)
          return { output: [{ type: 'text', text }], stopReason: 'completed' }
        } catch (error) {
          failureNote = String(error?.message ?? error)
          throw error
        }
      }

      const result = settleRunResult({
        attempt,
        collectOutput: () => {
          const blocks = []
          const text = stripBanner(readAll(handle.collected?.stdout)).trim()
          if (text.length > 0) blocks.push({ type: 'text', text })
          // A failure has no field of its own to travel in, so the reason rides
          // the output; without it an errored delegation renders as empty.
          if (failureNote.length > 0) blocks.push({ type: 'text', text: failureNote })
          return blocks
        },
        cancelled: () => cancelled,
        signal: request.signal,
        onAbort,
        onError: (error, stopReason) => {
          ctx.logger?.warn?.(`${PREFIX}: delegation failed (${stopReason}): ${error?.message ?? error}`)
        },
      })

      return subprocessRunHandle({
        id: `${CLI_BASENAME}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        result,
        signal: request.signal,
        onAbort,
        requestCancel: () => {
          cancelled = true
        },
        teardown: async () => {
          await handle.terminate()
        },
      })
    },
  }
}
