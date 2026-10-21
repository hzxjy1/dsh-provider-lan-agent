/**
 * Tool dispatch: direct, or through the `run_code` transport.
 *
 * DSH presents a scope's tools in one of two ways, and the difference decides
 * whether this plugin may call a tool at all:
 *
 *   - **direct** scopes: `ctx.tools.execute({ name: 'bash', … })` dispatches.
 *   - **`ptc` scopes** (programmatic tool calling): the model sees exactly one
 *     tool, `run_code`, and the registry refuses every other model-direct call:
 *     `collapses()` in `@deepseek-ai/dsh-tools` returns true for any name other
 *     than `run_code` without a `parent` token, and the executor answers
 *     `UNKNOWN_TOOL` with "only `run_code` is callable directly — call `X` from
 *     inside a `run_code` program instead".
 *
 * A real session in this deployment ran under `ptc`, so the bridge's direct
 * `bash` dispatch was refused, the vendor's model received the refusal, and it
 * told the user its "tool interface rejects shell calls". The fix is to follow
 * the contract DSH documents for exactly this case: wrap the call in a small
 * program and let the `run_code` SDK make it a nested sub-dispatch.
 *
 * Both routes yield the tool's canonical JSON value, so everything downstream
 * (result shaping in `src/tools.js`) is unchanged. The only difference is where
 * that value lives: a direct call publishes it as `result.value`, while
 * `run_code` publishes `{ logs, result, sandbox }` and the program's `return`
 * lands in `result.value.result`.
 *
 * @module src/dispatch
 */

/** How this plugin reaches DSH tools. */
export const DispatchMode = Object.freeze({
  /** Try direct first; fall back to `run_code` when the registry refuses. */
  auto: 'auto',
  /** Always call the tool directly. */
  direct: 'direct',
  /** Always go through a `run_code` program. */
  runCode: 'run_code',
})

/** The reserved PTC transport name (mirrors `RUN_CODE_NAME` in dsh-tools). */
export const RUN_CODE = 'run_code'

/** Error code the registry uses for a tool that cannot be called this way. */
const UNKNOWN_TOOL = 'UNKNOWN_TOOL'

/**
 * Whether a result is the registry's "this call is not allowed directly"
 * refusal rather than a tool's own failure.
 *
 * @param {object} result a `ToolExecutionResult`.
 * @returns {boolean}
 */
export function isDirectDispatchRefusal(result) {
  return result?.isError === true && result?.error?.info?.code === UNKNOWN_TOOL
}

/**
 * Build the program body that performs one tool call.
 *
 * The result is wrapped in a marker object instead of returning the value
 * directly: `run_code` reports a program-level failure for an uncaught
 * `ToolCallError`, and the vendor's model is better served by the failing
 * tool's own message than by "program failed".
 *
 * `JSON.stringify` emits valid JavaScript for the argument map, and the body is
 * erasable-syntax TypeScript as the transport requires (no annotations needed).
 *
 * @param {string} name DSH tool name.
 * @param {unknown} args losslessly JSON-serializable arguments.
 * @returns {string}
 */
export function programFor(name, args) {
  return [
    'try {',
    `  return { ok: true, value: await tools[${JSON.stringify(name)}](${JSON.stringify(args)}) }`,
    '} catch (error) {',
    "  return { ok: false, message: String(error?.message ?? error), toolName: String(error?.toolName ?? '') }",
    '}',
  ].join('\n')
}

/**
 * Create the per-turn dispatcher.
 *
 * @param {object} options
 * @param {object} options.tools the `ctx.tools` service.
 * @param {object} [options.agent] the initiating Agent; required for approvals
 *   and for the PTC sub-dispatch to be logged against the session.
 * @param {string} [options.mode] a {@link DispatchMode} value.
 * @param {Map<string,string>} [options.routes] remembered route per session, so
 *   a PTC session pays the refused attempt only once.
 * @param {string} [options.sessionKey] key into `routes`.
 * @param {{debug?: Function, warn?: Function}} [options.logger]
 * @returns {(name: string, args: unknown, context: {signal: AbortSignal, callId: string}) => Promise<object>}
 */
export function createToolDispatcher({ tools, agent, mode = DispatchMode.auto, routes = new Map(), sessionKey = '', logger }) {
  const agentField = agent === undefined ? {} : { agent }

  const callDirect = async (name, args, context) => await tools.execute({
    callId: context.callId,
    name,
    arguments: args,
    signal: context.signal,
    ...agentField,
  })

  const callThroughProgram = async (name, args, context) => {
    const outer = await tools.execute({
      callId: context.callId,
      name: RUN_CODE,
      arguments: { code: programFor(name, args), description: `lanagent 委派的 ${name} 调用` },
      signal: context.signal,
      ...agentField,
    })
    if (outer?.isError === true) return outer
    const outcome = outer?.value?.result
    if (outcome === null || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean') {
      // The program printed instead of returning, or the transport changed
      // shape. Pass the rendered content through rather than inventing a value.
      return { isError: false, value: undefined, content: outer?.content ?? [] }
    }
    if (outcome.ok === true) return { isError: false, value: outcome.value, content: outer?.content ?? [] }
    return {
      isError: true,
      error: {
        message: String(outcome.message ?? `tool ${name} failed`),
        info: { name, code: 'PTC_TOOL_CALL_FAILED' },
      },
      content: outer?.content ?? [],
    }
  }

  return async function dispatch(name, args, context) {
    // The audit panel wants the tool that actually ran, not just the vendor's
    // name for it: this is the layer that knows both.
    if (context?.meta !== undefined) context.meta.dshTool = name
    // The transport itself is always directly callable — it is the one name a
    // `ptc` scope accepts — so an explicit run_code request never gets wrapped
    // in a program that would call run_code from inside run_code.
    if (name === RUN_CODE) return await callDirect(name, args, context)
    const remembered = routes.get(sessionKey)
    const preferred = mode === DispatchMode.auto ? (remembered ?? DispatchMode.direct) : mode
    if (preferred !== DispatchMode.runCode) {
      const result = await callDirect(name, args, context)
      if (mode !== DispatchMode.auto || !isDirectDispatchRefusal(result)) {
        if (context?.meta !== undefined) context.meta.route = DispatchMode.direct
        return result
      }
      routes.set(sessionKey, DispatchMode.runCode)
      logger?.debug?.(`lanagent: this session presents PTC; routing ${name} through ${RUN_CODE} from now on`)
    }
    if (context?.meta !== undefined) context.meta.route = DispatchMode.runCode
    return await callThroughProgram(name, args, context)
  }
}
