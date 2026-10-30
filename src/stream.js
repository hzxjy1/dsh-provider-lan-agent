/**
 * Vendor stream decoding for `POST /chatbot/v3/task-agent`.
 *
 * The body is NOT SSE and NOT one JSON document: it is a concatenation of
 * compact JSON objects (`{"code":"0","data":{…}}{"code":"0",…}`), delivered in
 * arbitrary network chunks. Two measured facts drive this module (design notes §2):
 *
 *   1. Objects split across reads. `createJsonStreamParser()` carries the
 *      trailing partial object into the next feed and slices objects by brace
 *      matching that skips quotes and escapes — the same algorithm the vendor's
 *      own clients use.
 *
 *   2. `data.block[0].content` is a CUMULATIVE SNAPSHOT of that block, not a
 *      delta: the same block id arrives again and again with a longer string,
 *      and `partial` stays `false` throughout. DSH wants deltas, so the mapper
 *      diffs by block id and emits only the new tail.
 *
 *   3. A turn may END WITHOUT AN ANSWER and still look finished: the service
 *      declares `task_status: 'completed'` whatever its model did, and a cut
 *      connection simply stops the body. Both used to become `finish: stop`, so
 *      "it stopped by itself" was indistinguishable from a completed turn. The
 *      mapper now tracks whether answer text and tool calls actually happened
 *      and reports the three empty/truncated shapes as protocol errors.
 *
 * @module src/stream
 */

import { LanAgentError, FailureCode, classifyVendorCode } from './errors.js'

/**
 * Incremental parser for the concatenated-JSON body.
 *
 * @returns {(text: string) => object[]} feed one decoded chunk, get the complete
 *   objects it finished (possibly none).
 */
export function createJsonStreamParser() {
  let pending = ''
  return (text) => {
    const out = []
    const source = pending + text
    pending = ''
    let start = -1
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i]
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === '{') {
        if (depth === 0) start = i
        depth += 1
      } else if (ch === '}') {
        depth -= 1
        if (depth === 0 && start !== -1) {
          const slice = source.slice(start, i + 1)
          try {
            out.push(JSON.parse(slice))
          } catch {
            // A well-formed object that JSON.parse rejects is a vendor protocol
            // change, not a framing artefact: the brace matcher already proved
            // the object is complete. Surface it instead of silently dropping.
            throw new LanAgentError(`lanagent: undecodable stream object: ${slice.slice(0, 200)}`, { code: FailureCode.protocol })
          }
          start = -1
        }
      }
    }
    if (depth > 0 && start !== -1) pending = source.slice(start)
    return out
  }
}

/** Block types the vendor emits that DSH has no place for. Logged once each. */
const IGNORED_BLOCK_TYPES = new Set([
  'todo_list_snapshot', 'command_result', 'html_artifact', 'queue', 'subagent', 'error',
])

/**
 * The vendor's server narrates its tool turns in plain text blocks
 * ("Generating 386 chars for tool **Bash**" — measured 2026-10-15, session
 * logs): progress lines for its own GUI, not part of the answer. The real tool
 * call travels on the WebSocket channel and is already shown as a DSH card, so
 * these narrations are dropped here. The match is FULL-TEXT on purpose: a block
 * that merely starts like this and grows into real content (cumulative
 * snapshots) must never lose that content.
 */
const TOOL_NARRATION = /^Generating (?:\d+ chars? for tool [^\n]*|long tool, cost \(\d+(?:\.\d+)? ?s\))$/
const isToolNarration = (text) => TOOL_NARRATION.test(text.trim())

/**
 * Translate vendor stream objects into DSH `StreamChunk`s.
 *
 * Text blocks become `block-start` + `text-delta` + (on close) `block-end`.
 * `tool_use` blocks produce NO chunk on purpose: this adapter executes the
 * vendor's tools itself over the WebSocket channel (design notes §5.5-5.6), so
 * handing DSH a `tool-call` would start a second, competing tool loop.
 *
 * @param {object} [options]
 * @param {(block: object) => void} [options.onToolUse] called for each distinct
 *   `tool_use` block, in arrival order.
 * @param {(data: object) => void} [options.onTokenUsage] raw `token_usage` data,
 *   observed for diagnostics only; it is never converted into a DSH usage chunk.
 * @param {() => (number | undefined)} [options.localUsage] local request pressure
 *   from the host token meter. Called once when the vendor turn completes; its
 *   value becomes the DSH usage sample (the vendor `used_tokens` does not
 *   describe this request). Omitted for auxiliary calls.
 * @param {(info: {reason: object, message?: string, sawAnswerText: boolean, sawToolCalls: boolean, finishReason: string|null}) => void}
 *   [options.onTerminal] called once, when this mapper produces the turn's
 *   terminal chunk. This is the turn-outcome trace: the reason (including the
 *   three empty/truncated failures), whether any answer text was shown, and
 *   whether a tool call happened. Never allowed to throw into the stream.
 * @param {{warn?: Function, debug?: Function}} [options.logger]
 */
export function createStreamMapper({ onToolUse, onTokenUsage, localUsage, onTerminal, logger } = {}) {
  /** @type {Map<string, {index: number, text: string, closed: boolean}>} */
  const texts = new Map()
  /** @type {Map<string, {index: number, text: string, closed: boolean}>} */
  const reasonings = new Map()
  /** @type {Set<string>} */
  const toolUseIds = new Set()
  const ignoredReported = new Set()
  let nextIndex = 0
  let finishReason = null
  let terminal = false
  let sawToolCalls = false
  /**
   * Did this turn show the user any answer text? A completion with none of it is
   * the vendor stopping without saying anything — the shape the GUI used to
   * show as a clean "finished". Reasoning does NOT count: the user saw nothing.
   */
  let sawAnswerText = false
  /** Answer text arrived since the last tool call (the step's own final answer). */
  let sawAnswerTextSinceTool = false

  const ensureText = (key, chunks) => {
    let state = texts.get(key)
    if (state === undefined) {
      state = { index: nextIndex, text: '', closed: false }
      nextIndex += 1
      texts.set(key, state)
      chunks.push({ type: 'block-start', index: state.index, blockType: 'text' })
    }
    return state
  }

  /** The turn did show the user answer text (not reasoning, not narration). */
  const markAnswerText = () => {
    sawAnswerText = true
    sawAnswerTextSinceTool = true
  }

  const closeTexts = (chunks) => {
    for (const state of texts.values()) {
      if (state.closed) continue
      state.closed = true
      chunks.push({ type: 'block-end', index: state.index, block: { type: 'text', text: state.text } })
    }
  }

  const ensureReasoning = (key, chunks) => {
    let state = reasonings.get(key)
    if (state === undefined) {
      state = { index: nextIndex, text: '', closed: false }
      nextIndex += 1
      reasonings.set(key, state)
      chunks.push({ type: 'block-start', index: state.index, blockType: 'reasoning' })
    }
    return state
  }

  const closeReasonings = (chunks) => {
    for (const state of reasonings.values()) {
      if (state.closed) continue
      state.closed = true
      chunks.push({ type: 'block-end', index: state.index, block: { type: 'reasoning', text: state.text } })
    }
  }

  const takeLocalUsage = (chunks) => {
    let pressure
    try {
      pressure = localUsage?.()
    } catch {
      // A measurement failure must never break the turn: the host then falls
      // back to its own surface estimate.
      return
    }
    if (typeof pressure !== 'number' || !Number.isFinite(pressure) || pressure <= 0) return
    const tokens = Math.round(pressure)
    chunks.push({ type: 'usage', usage: { inputTokens: tokens, outputTokens: 0, totalTokens: tokens } })
  }

  /** One line per finished vendor turn, for the audit trail (never throws). */
  const reportTerminal = (reason, message) => {
    try {
      onTerminal?.({ reason, message, sawAnswerText, sawToolCalls, finishReason })
    } catch {
      // A diagnostic must never break the turn it describes.
    }
  }

  /** A protocol-error finish, with the same message kept for the audit trail. */
  const errorFinish = (message) => ({
    reason: { kind: 'error', failure: new LanAgentError(message, { code: FailureCode.protocol }).toFailure() },
    message,
  })

  /**
   * How a turn the vendor DECLARED COMPLETE should end.
   *
   * "Completed" is the vendor service's word, not evidence that its model
   * answered: it ends a task just as readily when the model gave up right after
   * a tool call, or when the turn produced nothing at all. Both used to become
   * `finish: stop`, i.e. a finished-looking turn with no answer — the exact
   * shape a user reports as "it stopped by itself".
   */
  const completionFinish = () => {
    if (!sawAnswerText && !sawToolCalls) {
      return errorFinish('lanagent: the vendor reported task completion without any answer text or tool call')
    }
    if (sawToolCalls && !sawAnswerTextSinceTool) {
      return errorFinish('lanagent: the vendor reported task completion after a tool call, without a final answer')
    }
    return { reason: { kind: finishReason === 'max-tokens' ? 'max-tokens' : 'stop' } }
  }

  return {
    /**
     * Feed one decoded stream object.
     *
     * @param {object} obj one object from {@link createJsonStreamParser}.
     * @returns {object[]} DSH chunks produced by this object.
     */
    mapObject(obj) {
      const chunks = []
      const verdict = classifyVendorCode(obj?.code, obj?.message ?? obj?.msg ?? obj?.error?.reason)
      if (!verdict.ok) {
        throw new LanAgentError(verdict.message, { code: verdict.failureCode, retryable: verdict.retryable === true })
      }
      const data = obj?.data
      if (data === null || typeof data !== 'object') return chunks

      const block = Array.isArray(data.block) ? data.block[0] : undefined
      if (block !== undefined && block !== null) {
        if (block.type === 'text') {
          const key = typeof block.id === 'string' && block.id.length > 0 ? block.id : 'text-0'
          const content = typeof block.content === 'string' ? block.content : ''
          // A pure narration block is dropped whole (never opened, never
          // closed); a mixed block keeps its text and its progress line
          // verbatim — trimming inside a real answer would corrupt it.
          if (content.trim().length > 0 && isToolNarration(content)) {
            logger?.debug?.(`lanagent: dropped tool narration block (${content.trim().slice(0, 60)})`)
          } else {
            const state = ensureText(key, chunks)
            const grew = content.length > state.text.length
            if (state.closed) {
              // A cumulative snapshot that grew after its block was closed (a
              // reused block id): there is no open index for the tail to land on.
              // Still record that an answer arrived — otherwise the completion
              // check would blame the vendor for an answer this mapper dropped —
              // and say so, because losing text silently is the failure that
              // check exists to make visible.
              if (grew && content.slice(state.text.length).trim().length > 0) {
                markAnswerText()
                logger?.warn?.(
                  `lanagent: dropped ${content.length - state.text.length} chars of an already-closed text block (block ${key})`,
                )
              }
            } else if (grew) {
              chunks.push({ type: 'text-delta', index: state.index, text: content.slice(state.text.length) })
              state.text = content
              if (content.trim().length > 0) markAnswerText()
            }
          }
        } else if (block.type === 'thinking') {
          // The service emits its reasoning as a separate cumulative `thinking`
          // block, next to the visible answer. DSH has a distinct reasoning
          // channel, so map it rather than dropping it (the desktop client shows
          // exactly these blocks in its collapsible thinking panel).
          const content = String(block.content ?? block.text ?? '')
          if (content.length > 0) {
            const key = typeof block.id === 'string' && block.id.length > 0 ? `thinking:${block.id}` : 'thinking-0'
            const state = ensureReasoning(key, chunks)
            if (!state.closed && content.length > state.text.length) {
              chunks.push({ type: 'reasoning-delta', index: state.index, text: content.slice(state.text.length) })
              state.text = content
            }
          }
        } else if (block.type === 'tool_use') {
          // A tool call ends the visible segment of THIS step. Close the open
          // text/reasoning blocks now: if they stay open until task completion,
          // the final `block-end` replays every earlier step's text into the
          // last assistant message (measured: the final summary was followed by
          // the whole turn's intermediate narration).
          closeReasonings(chunks)
          closeTexts(chunks)
          sawToolCalls = true
          // The next answer text has to arrive AFTER this call, or the turn is
          // being closed without a final answer.
          sawAnswerTextSinceTool = false
          const id = typeof block.id === 'string' ? block.id : ''
          if (id.length > 0 && !toolUseIds.has(id)) {
            toolUseIds.add(id)
            onToolUse?.(block)
          }
        } else if (block.type === 'system_info') {
          if (block.event === 'token_usage' && block.data !== null && typeof block.data === 'object') {
            const used = Number(block.data.used_tokens)
            if (Number.isFinite(used)) {
              // Deliberately do NOT translate `used_tokens` into a DSH `usage`
              // chunk. It is the vendor agent's own conversation counter (same
              // `chatId` across the DSH session), not the prompt size of this
              // request. Reporting it as `inputTokens` makes DSH's token meter
              // treat the remote context as local pressure; local compaction
              // cannot shrink that counter, so pressure stays above the
              // threshold and compaction repeats every turn. The raw sample is
              // still exposed for diagnostics.
              onTokenUsage?.(block.data)
            }
          }
        } else if (!ignoredReported.has(block.type)) {
          ignoredReported.add(block.type)
          logger?.debug?.(`lanagent: ignoring vendor block type "${block.type}"`)
        }
      } else if (typeof data.content === 'string' && data.content.length > 0) {
        // Older payload shape: text at `data.content` with no block wrapper.
        const state = ensureText('content', chunks)
        if (!state.closed && data.content.length > state.text.length) {
          chunks.push({ type: 'text-delta', index: state.index, text: data.content.slice(state.text.length) })
          state.text = data.content
          if (data.content.trim().length > 0) markAnswerText()
        }
      }

      if (data.finish_reason === 'length') finishReason = 'max-tokens'
      if (data.finish_reason === 'tool_calls') sawToolCalls = true

      if (typeof data.task_status === 'string') {
        if (data.task_status === 'completed') {
          closeReasonings(chunks)
          closeTexts(chunks)
          takeLocalUsage(chunks)
          const finish = completionFinish()
          chunks.push({ type: 'finish', reason: finish.reason })
          reportTerminal(finish.reason, finish.message)
          terminal = true
        } else if (data.task_status !== 'init' && data.task_status !== 'running') {
          closeReasonings(chunks)
          closeTexts(chunks)
          const finish = errorFinish(
            typeof data.message === 'string' && data.message.length > 0
              ? data.message
              : `lanagent: task ended as "${data.task_status}"`,
          )
          chunks.push({ type: 'finish', reason: finish.reason })
          reportTerminal(finish.reason, finish.message)
          terminal = true
        }
      }
      return chunks
    },

    /** Index the next block would take; a tool-call block continues the sequence. */
    nextBlockIndex() {
      return nextIndex
    },

    /**
     * Close the stream at the transport level (body ended, abort, or error).
     *
     * The vendor's terminal `task_status` is normally what finishes a turn, but
     * a dropped connection ends the body without one — DSH still needs the
     * stream to close its blocks and end with exactly one terminal chunk.
     *
     * Every way of reaching this method without an explicit `reason` is a
     * FAILURE, not a finished turn: the vendor always sends `task_status` when
     * it is done, so a body that closes first was cut, or the service hung up
     * mid-turn. Defaulting to `stop` (as this used to) is how a truncated reply
     * and a finished one became indistinguishable in the transcript.
     *
     * @param {object} [reason] a DSH finish reason; defaults to a protocol error.
     * @returns {object[]} DSH chunks.
     */
    end(reason) {
      if (terminal) return []
      const chunks = []
      closeReasonings(chunks)
      closeTexts(chunks)
      if (reason !== undefined) {
        chunks.push({ type: 'finish', reason })
        reportTerminal(reason, reason.kind === 'error' ? reason.failure?.message : undefined)
      } else {
        const message = sawToolCalls && !sawAnswerText
          ? 'lanagent: the vendor stream ended while a tool call was still pending'
          : !sawAnswerText && !sawToolCalls
            ? 'lanagent: the vendor stream ended before producing any answer or tool call'
            : 'lanagent: the vendor stream ended without a terminal task status (the connection was cut)'
        const finish = errorFinish(message)
        chunks.push({ type: 'finish', reason: finish.reason })
        reportTerminal(finish.reason, finish.message)
      }
      terminal = true
      return chunks
    },
  }
}