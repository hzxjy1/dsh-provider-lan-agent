/**
 * The cross-stream rendezvous behind the loop execution route.
 *
 * WHY THIS EXISTS
 * ---------------
 * A native "run command" card — and native approvals, and `tool/call` rows in
 * the session — only appear when the *assistant message* we return contains a
 * `tool-call` block, because the conversation view renders tool calls from the
 * assistant message and ignores `tool/call` events entirely (design notes §21).
 * The bridge cannot both answer the vendor's WebSocket call immediately and let
 * the loop execute the tool, so a turn is suspended across two DSH steps:
 *
 *   stream #1  the vendor asks for a tool
 *              → we park the WebSocket request, stop reading the vendor stream
 *                (leaving it OPEN), and end the assistant message with a
 *                `tool-call` block plus `finish: tool-calls`
 *   [DSH's loop executes it natively: approvals, sandbox, transcript, live UI]
 *   stream #2  DSH calls us again with the tool result in history
 *              → we answer the parked WebSocket request in the vendor's own
 *                result shape, then RESUME the parked vendor stream and forward
 *                its remaining chunks as this step's answer
 *
 * The vendor's own budget is the per-tool `timeout` it sends (`execute_command`
 * carries 300000ms; measured ceiling ≈333s), not a fixed 30s — so a realistic
 * approval or command fits. If the loop is still not done when that budget runs
 * out, the parked call is answered with a timeout error and the vendor stream is
 * drained in the background, so the vendor's answer is not lost: the next step
 * replays it.
 *
 * This module owns that state machine. It talks to the vendor stream through a
 * pump (an async generator of DSH chunks) so it can be tested without a network.
 *
 * @module src/loopRoute
 */

/**
 * Default per-tool budget when the vendor sends no timeout of its own.
 *
 * The vendor declares 300000ms for `execute_command` and its measured ceiling is
 * ≈333s, so a 240000ms budget used to expire BEFORE the vendor's own deadline:
 * our "tool did not finish" error answered the call while the vendor was still
 * waiting, and its model then gave up on the step. The value now sits above the
 * measured ceiling, so it only ever bounds a turn the vendor has abandoned too.
 */
export const DEFAULT_TOOL_BUDGET_MS = 360_000

/**
 * Budget for a parked interactive question (`ask_user_question`).
 *
 * A tool that waits for a human has no meaningful vendor timeout: the vendor's
 * own `timeout` field was never meant for "how long may the user think". Expiring
 * this at the normal budget told the vendor's model the question failed, and the
 * user's eventual answer arrived for a turn that had already given up.
 *
 * Nine minutes is the practical ceiling rather than a preference: in a PTC
 * session the question runs inside a generated `run_code` program, and DSH caps
 * that program's wall clock at 600000ms TOTAL, nested waits included. Staying one
 * minute under the cap lets this budget answer the vendor with a clean timeout
 * before DSH kills the program under it. In a native session the same value
 * applies for consistency.
 */
export const ASK_USER_BUDGET_MS = 540_000

/**
 * How long to wait for sibling tool requests before suspending the turn.
 *
 * Sibling `mcp_request` frames that arrive within this window share ONE
 * assistant step — one message with several tool-call blocks — so the loop runs
 * them in the same step instead of one step per call.
 *
 * Measured caveat: this deployment's vendor server SERIALIZES its own tool calls
 * (it sent the second `tool_use` ~1.0s after the first, following our answer), so
 * this window does not batch that pattern — waiting long enough would add a
 * second to every call. It exists for frames that really do arrive together.
 */
export const DEFAULT_COLLECT_MS = 40

/** Build the chunks that end an assistant message with one tool call. */
export function toolCallChunks({ callId, name, arguments: args, index = 0 }) {
  const argsJson = typeof args === 'string' ? args : JSON.stringify(args ?? {})
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id: callId, name, argumentsDelta: argsJson },
    { type: 'block-end', index, block: { type: 'tool-call', id: callId, name, arguments: argsJson } },
  ]
}

/**
 * Pull the loop's tool results out of the messages DSH hands the next step.
 *
 * @param {readonly object[]} messages
 * @param {Iterable<string>} callIds the call ids we are waiting on.
 * @returns {Map<string, {text: string, isError: boolean}>}
 */
export function extractToolResults(messages, callIds) {
  const wanted = new Set([...callIds].map(String))
  const found = new Map()
  for (const message of messages ?? []) {
    if (message === null || typeof message !== 'object' || message.role !== 'tool') continue
    const id = String(message.toolCallId ?? '')
    if (!wanted.has(id)) continue
    const text = (Array.isArray(message.content) ? message.content : [])
      .map((block) => (block !== null && typeof block === 'object' && block.type === 'text' ? String(block.text ?? '') : ''))
      .filter((part) => part.length > 0)
      .join('\n')
    found.set(id, { text, isError: message.isError === true })
  }
  return found
}

/**
 * Is this DSH call the agent loop continuing the parked step, or new user input?
 *
 * The parked calls' results being *somewhere* in the history is NOT enough to
 * tell them apart: after an aborted turn those results are already recorded, so
 * a brand-new prompt looks exactly like a continuation. Claiming the parked turn
 * for it swallows the user's new text — the stream resumes the OLD vendor turn
 * and the text never reaches the request body (measured: two consecutive turns
 * of session 5791332e were eaten this way; design notes §29).
 *
 * A genuine continuation has one shape: the LAST non-system message is the tool
 * result the loop just produced for this parked call.
 *
 * @param {object} parked the parked turn record (needs `calls[].ids`).
 * @param {readonly object[]} messages DSH `GenerateOptions.messages`.
 * @returns {boolean}
 */
export function isLoopContinuation(parked, messages) {
  const wanted = new Set(
    (parked?.calls ?? []).flatMap((call) => [...(call.ids?.values?.() ?? [])].map(String)),
  )
  if (wanted.size === 0) return false
  const list = messages ?? []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index]
    if (message === null || typeof message !== 'object') continue
    if (message.role === 'system' || message.role === 'developer') continue
    return message.role === 'tool' && wanted.has(String(message.toolCallId ?? ''))
  }
  return false
}

/**
 * The budget timer's body.
 *
 * This runs in a timer callback, OUTSIDE every error boundary: an exception here
 * is an uncaught exception that takes the whole host process down (measured — a
 * scope slip in the caller's budget hook killed a running DSH). Each step is
 * therefore guarded on its own: the vendor still gets its answer, and a failing
 * hook is reported rather than propagated.
 *
 * @param {object} record the parked call.
 * @param {{warn?: Function}} [logger]
 */
export function fireBudget(record, logger) {
  if (record.answered) return
  record.answered = true
  const seconds = Math.round((record.budgetMs ?? 0) / 1000)
  logger?.warn?.(`lanagent: ${record.vendorTool} did not finish within ${seconds}s; answering the vendor with a timeout error while the tool keeps running`)
  try {
    record.respond({ error: { code: -10001, message: `工具 ${record.vendorTool} 在 ${seconds}s 内未完成（DSH 侧可能仍在执行或等待审批）` } })
  } catch (error) {
    logger?.warn?.(`lanagent: answering the expired call failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    record.onBudgetExhausted?.()
  } catch (error) {
    logger?.warn?.(`lanagent: the budget hook threw (the parked stream will not be drained): ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** A suspension that never fires; used while draining a parked stream. */
const never = () => new Promise(() => {})

/**
 * Iterate a parked vendor pump until it ends or the turn is suspended again.
 *
 * An async generator keeps its yield point, so stopping iteration parks the
 * HTTP stream exactly where it was. The one piece of bookkeeping that matters:
 * the `next()` that was in flight when we parked must be handed on, or its chunk
 * is lost forever.
 *
 * @param {object} options
 * @param {AsyncGenerator<object>} options.pump
 * @param {Promise<void>} options.suspension resolves when a call is parked.
 * @param {Promise<object>} [options.resumeWith] a `next()` left in flight by an earlier park.
 * @param {(pending: Promise<object>) => void} [options.onSuspend]
 * @returns {AsyncGenerator<object>}
 */
export async function* drainWithSuspension({ pump, suspension, resumeWith, onSuspend }) {
  let pending = resumeWith ?? pump.next()
  for (;;) {
    const raced = await Promise.race([
      pending.then((value) => ({ kind: 'chunk', value })),
      suspension.then(() => ({ kind: 'park' })),
    ])
    if (raced.kind === 'park') {
      onSuspend?.(pending)
      return
    }
    const { done, value } = raced.value
    if (done) return
    yield value
    pending = pump.next()
  }
}

/**
 * Per-session rendezvous state.
 *
 * @param {object} options
 * @param {{warn?: Function, debug?: Function}} [options.logger]
 * @param {number} [options.defaultBudgetMs]
 */
export function createLoopRoute({ logger, defaultBudgetMs = DEFAULT_TOOL_BUDGET_MS, collectMs = DEFAULT_COLLECT_MS } = {}) {
  /** @type {Map<string, object>} */
  const sessions = new Map()

  const stateFor = (sessionKey) => {
    let state = sessions.get(sessionKey)
    if (state === undefined) {
      state = {
        /** Parked vendor stream, when a turn is suspended. */
        parked: undefined,
        /** The suspension the CURRENT stream is racing, if any. */
        suspend: undefined,
        /** Calls parked during the current stream. */
        pending: [],
      }
      sessions.set(sessionKey, state)
    }
    return state
  }

  return {
    /**
     * Prepare the suspension a new stream will race.
     *
     * @param {string} sessionKey
     * @returns {{ promise: Promise<void>, fire: () => void }}
     */
    arm(sessionKey) {
      const state = stateFor(sessionKey)
      // A previous suspension's grace timer must not fire into the new one.
      clearTimeout(state.suspend?.graceTimer)
      let fire
      const promise = new Promise((resolve) => { fire = resolve })
      state.suspend = { promise, fire, armed: true }
      state.pending = []
      return state.suspend
    },

    /** Register one parked WebSocket call for the current turn. */
    park(sessionKey, entry) {
      const state = stateFor(sessionKey)
      const budget = Number.isFinite(entry.budgetMs) && entry.budgetMs > 0 ? entry.budgetMs : defaultBudgetMs
      const record = { ...entry, budgetMs: budget, answered: false, timer: undefined }
      record.timer = setTimeout(() => { fireBudget(record, logger) }, budget)
      record.timer?.unref?.()
      state.pending.push(record)
      const suspend = state.suspend
      if (suspend !== undefined && suspend.scheduled !== true) {
        // One grace window per suspension, however many calls land inside it.
        suspend.scheduled = true
        if (!(collectMs > 0)) suspend.fire()
        else {
          suspend.graceTimer = setTimeout(() => suspend.fire(), collectMs)
          suspend.graceTimer?.unref?.()
        }
      }
      return record
    },

    /** Calls parked during the current stream (the ones the loop must run). */
    pendingOf(sessionKey) {
      return stateFor(sessionKey).pending
    },

    /** Store the parked vendor stream; the next stream resumes it. */
    suspend(sessionKey, { pump, pendingRead, mapper, cancel, release }) {
      const state = stateFor(sessionKey)
      const calls = state.pending
      state.suspend = undefined
      // 'release' closes the turn's channel and detaches the abort listener; it
      // used to be dropped here, which made every later release a no-op and
      // leaked the WebSocket (design notes §31).
      state.parked = { pump, pendingRead, mapper, cancel, release, calls, mode: 'live', buffer: [] }
      state.pending = []
      return state.parked
    },

    /**
     * Take the parked turn, if any, and forget it here: the caller now owns it.
     *
     * @param {string} sessionKey
     */
    resume(sessionKey) {
      const state = stateFor(sessionKey)
      const parked = state.parked
      state.parked = undefined
      return parked
    },

    /** Read the parked turn without taking it (used when a budget expires). */
    peek(sessionKey) {
      return sessions.get(sessionKey)?.parked
    },

    /** Whether a turn is parked for this session. */
    isParked(sessionKey) {
      return sessions.get(sessionKey)?.parked !== undefined
    },

    /** Forget everything for one session (dispose, or a dead turn). */
    drop(sessionKey) {
      const state = sessions.get(sessionKey)
      if (state === undefined) return
      clearTimeout(state.suspend?.graceTimer)
      // Both the calls of a suspended turn and the ones parked by a stream that
      // has not suspended yet: an unanswered vendor call would otherwise wait
      // out its whole budget for a result that will never come.
      try {
        state.parked?.cancel?.()
      } catch (error) {
        logger?.warn?.(`lanagent: cancelling a parked turn failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      for (const call of [...state.parked?.calls ?? [], ...state.pending]) {
        if (!call.answered) {
          call.answered = true
          call.respond({ error: { code: -10001, message: 'lanagent: 本轮已中止，工具结果不会再回传' } })
        }
        clearTimeout(call.timer)
      }
      state.parked?.pump?.return?.(undefined)
      // The parked record owns the turn's channel and the turn's abort listener;
      // dropping the state must close them too, or an abandoned turn leaks an
      // open WebSocket and its tool handler.
      state.parked?.release?.()?.catch?.(() => {})
      sessions.delete(sessionKey)
    },

    /** Every session currently known (dispose walks this). */
    keys() {
      return [...sessions.keys()]
    },
  }
}
