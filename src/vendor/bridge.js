/**
 * The bridge runner for the vendor-request seam.
 *
 * This is the out-of-band execution route: the vendor's WebSocket request is
 * answered in the same turn, with no agent-loop round trip. The seam owns
 * vocabulary, mapping, and shaping; this module owns only the small amount of
 * glue that turns a plan into `ctx.tools.execute()` calls and feeds the
 * outcomes back into `render`.
 *
 * The loop route (`index.js` + `src/loopRoute.js`) is the other runner. Both
 * must converge on the same plan and the same answer.
 *
 * @module src/vendor/bridge
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import { collectEnvironment, contentText, readMemoryInfo } from '../tools.js'
import { interpret, render } from './registry.js'

/** Clip the human summary recorded in the audit trail. */
function summarize(answer) {
  const text = answer?.error !== undefined
    ? String(answer.error.message ?? '')
    : (answer?.content ?? []).map((block) => (block?.type === 'text' ? String(block.text ?? '') : '')).join(' ')
  return text.length <= 240 ? text : `${text.slice(0, 240)}…`
}

/** Is `path` inside `root` (segment boundary, not string prefix)? */
function inside(path, root) {
  const base = String(root ?? '').replace(/\/+$/, '')
  return base.length > 0 && (path === base || path.startsWith(`${base}/`))
}

/**
 * Read a file for plan-time SEARCH/REPLACE resolution.
 *
 * Reads are limited to the session workspace and the resolved mapping targets:
 * the resolver must not become a way to read a file the sandboxed `edit` would
 * refuse. Outside that set the plan is refused with the vendor's own guidance.
 */
function createDocumentReader(workspace, mappings) {
  const roots = [workspace, ...mappings.map((mapping) => mapping.to)].filter((root) => typeof root === 'string' && root.length > 0)
  return async (path) => {
    const absolute = isAbsolute(path) ? path : resolve(workspace, path)
    if (!roots.some((root) => inside(absolute, isAbsolute(root) ? root : resolve(workspace, root)))) return undefined
    try {
      return await readFile(absolute, 'utf8')
    } catch {
      return undefined
    }
  }
}

/**
 * Build the vendor-facing handler for the out-of-band route.
 *
 * @param {object} options
 * @param {(name: string, args: object, context: {signal: AbortSignal, callId: string}) => Promise<object>} options.run
 *   invokes a DSH tool through `ctx.tools.execute()` (normally `src/dispatch.js`).
 * @param {string} [options.cwd] the session workspace.
 * @param {readonly {from: string, to: string}[]} [options.mappings] resolved path mappings.
 * @param {string} [options.toolboxName] synthetic MCP server name.
 * @param {(name: string) => string|undefined} [options.resolveTool] bare toolbox name -> DSH name.
 * @param {readonly string[]} [options.availableTools]
 * @param {Record<string, string>} [options.documents] plan-time file contents (tests).
 * @param {(path: string) => Promise<string|undefined>} [options.readDocument]
 * @param {(vendor: string) => Promise<object|undefined>} [options.localAnswer]
 * @param {(name: string) => void} [options.onExecuted] called after each real execution.
 * @param {(record: object) => void} [options.audit] called once per vendor request.
 * @param {{warn?: Function, debug?: Function}} [options.logger]
 * @returns {(params: object, context: {signal: AbortSignal, callId: string, meta?: object}) => Promise<object>}
 */
export function createToolBridge({
  run,
  cwd,
  mappings = [],
  toolboxName = 'dsh_toolbox',
  resolveTool,
  availableTools,
  documents,
  readDocument,
  localAnswer,
  onExecuted,
  audit,
  logger,
}) {
  const workspace = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
  const reader = readDocument ?? createDocumentReader(workspace, mappings)
  const answerLocally = localAnswer ?? (async (vendor) => {
    if (vendor !== 'get_environment_info') return undefined
    const memory = await readMemoryInfo('')
    return { content: [{ type: 'text', text: await collectEnvironment(workspace, memory) }] }
  })

  return async function handleVendorToolCall(params, context = {}) {
    const startedAt = Date.now()
    const name = String(params?.name ?? '')
    // The vendor nests the tool's own fields under `arguments`; the seam gets
    // exactly that map and applies path mapping itself.
    const input = params?.arguments !== null && typeof params?.arguments === 'object' ? params.arguments : {}

    const plan = await interpret(name, input, {
      cwd: workspace,
      mappings,
      toolboxName,
      resolveTool,
      availableTools,
      documents,
      readDocument: reader,
      localAnswer: answerLocally,
      logger,
    })

    const record = (answer, detail, extra = {}) => audit?.({
      name,
      args: plan.mappedArguments ?? input,
      ok: answer?.error === undefined,
      ...detail === undefined ? {} : { detail },
      durationMs: Date.now() - startedAt,
      dshTool: plan.kind === 'local' ? '(local)' : (plan.calls ?? []).map((call) => call.dshTool).join(','),
      route: plan.kind === 'local' ? 'local' : plan.kind === 'refusal' ? 'refusal' : context.meta?.route,
      ...extra,
      ...detail === undefined ? { summary: summarize(answer) } : {},
    })

    if (plan.kind !== 'dsh') {
      const answer = render(plan, new Map(), { cwd: workspace })
      record(answer, answer.error?.message)
      return answer
    }

    const outcomes = new Map()
    for (const call of plan.calls) {
      const callId = plan.calls.length === 1 && typeof context.callId === 'string'
        ? context.callId
        : `${String(context.callId ?? 'lanagent')}:${call.key}`
      try {
        const result = await run(call.dshTool, call.arguments, { ...context, callId })
        onExecuted?.(call.dshTool)
        outcomes.set(call.key, {
          text: contentText(result) || String(result?.error?.message ?? ''),
          isError: result?.isError === true,
          ...result?.value === undefined ? {} : { value: result.value },
        })
      } catch (error) {
        outcomes.set(call.key, { text: error instanceof Error ? error.message : String(error), isError: true })
      }
      if (context.meta !== undefined) context.meta.dshTool = plan.calls.map((entry) => entry.dshTool).join(',')
      if (outcomes.get(call.key)?.isError === true && plan.continueOnError !== true) break
    }

    const answer = render(plan, outcomes, { cwd: workspace })
    record(answer, answer.error?.message)
    return answer
  }
}
