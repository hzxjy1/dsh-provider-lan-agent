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
 * @param {(data: object) => void} [options.onTokenUsage] raw `token_usage` data.
 * @param {{warn?: Function, debug?: Function}} [options.logger]
 */
export function createStreamMapper({ onToolUse, onTokenUsage, logger } = {}) {
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
  let usage = null

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

  const takeUsage = (chunks) => {
    if (usage === null) return
    // The vendor reports only a context total (`used_tokens`), which covers
    // input + history; per-direction accounting is not on the wire, so output
    // stays 0 and the total is what the number actually measures.
    chunks.push({
      type: 'usage',
      usage: { inputTokens: usage.usedTokens, outputTokens: 0, totalTokens: usage.usedTokens },
    })
    usage = null
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
            if (!state.closed) {
              if (content.length > state.text.length) {
                chunks.push({ type: 'text-delta', index: state.index, text: content.slice(state.text.length) })
                state.text = content
              }
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
          const id = typeof block.id === 'string' ? block.id : ''
          if (id.length > 0 && !toolUseIds.has(id)) {
            toolUseIds.add(id)
            onToolUse?.(block)
          }
        } else if (block.type === 'system_info') {
          if (block.event === 'token_usage' && block.data !== null && typeof block.data === 'object') {
            const used = Number(block.data.used_tokens)
            if (Number.isFinite(used)) {
              usage = { usedTokens: used }
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
        }
      }

      if (data.finish_reason === 'length') finishReason = 'max-tokens'
      if (data.finish_reason === 'tool_calls') sawToolCalls = true

      if (typeof data.task_status === 'string') {
        if (data.task_status === 'completed') {
          closeReasonings(chunks)
          closeTexts(chunks)
          takeUsage(chunks)
          chunks.push({ type: 'finish', reason: { kind: finishReason === 'max-tokens' ? 'max-tokens' : 'stop' } })
          terminal = true
        } else if (data.task_status !== 'init' && data.task_status !== 'running') {
          closeReasonings(chunks)
          closeTexts(chunks)
          takeUsage(chunks)
          chunks.push({
            type: 'finish',
            reason: {
              kind: 'error',
              failure: new LanAgentError(
                typeof data.message === 'string' && data.message.length > 0
                  ? data.message
                  : `lanagent: task ended as "${data.task_status}"`,
                { code: FailureCode.protocol },
              ).toFailure(),
            },
          })
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
     * @param {object} [reason] a DSH finish reason; defaults to a protocol error.
     * @returns {object[]} DSH chunks.
     */
    end(reason) {
      if (terminal) return []
      const chunks = []
      closeReasonings(chunks)
      closeTexts(chunks)
      takeUsage(chunks)
      if (reason !== undefined) {
        chunks.push({ type: 'finish', reason })
      } else if (sawToolCalls) {
        chunks.push({
          type: 'finish',
          reason: {
            kind: 'error',
            failure: new LanAgentError('lanagent: the vendor turn ended while a tool call was still pending', {
              code: FailureCode.protocol,
            }).toFailure(),
          },
        })
      } else {
        chunks.push({ type: 'finish', reason: { kind: 'stop' } })
      }
      terminal = true
      return chunks
    },
  }
}