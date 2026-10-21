/**
 * The vendor's tool channel.
 *
 * `task-agent` runs its agent loop on the SERVER and delegates every tool
 * execution to the client over a WebSocket dedicated to the turn:
 * `wss://<host>/ws-api/coagent/<session_id>`. The server pushes a JSON-RPC
 * `tools/call` request and waits for the matching response on the same socket
 * (`ServerCmd` correlates the two). Measured behaviour that shapes this module
 * (design notes §2):
 *
 *   - **An unanswered call stalls the turn until the tool's own deadline.** The
 *     first probe measured a ~30s stall, but that was the INITIALIZATION
 *     preflight (`get_environment_info` unanswered delays `task_status: init`);
 *     answering a real tool call 45s and 130s late was still accepted, with
 *     keepalive `system_info` chunks arriving about once a second meanwhile
 *     (design notes §20). A quiet channel still wastes a turn, so answering
 *     something promptly remains the right default.
 *   - The server tolerates an error response and adapts (`code != 0`,
 *     `result: null`), so "not available" is a legitimate answer.
 *   - Client identity and the JWT ride inside each frame (`accessToken`), not
 *     on the handshake — the socket URL carries only the session id.
 *
 * This module owns the transport, the heartbeat, the correlation envelope, and
 * the deadline. What a tool call MEANS is the handler's business: M1 answers
 * everything with an explicit "not available" error, M2 replaces the handler
 * with real DSH tool execution.
 *
 * @module src/ws
 */

import { LanAgentError, FailureCode } from './errors.js'

/** Heartbeat cadence; the vendor's own client uses 10s and a 5s response grace. */
const HEARTBEAT_MS = 10_000

/** Generate a client-side request id, mirroring the vendor client's shape. */
const clientCmd = () => Math.random().toString(16).slice(2).padEnd(16, '0')

/**
 * One tool channel for one turn.
 */
export class ToolChannel {
  /**
   * @param {object} options
   * @param {string} options.url full `ws(s)://` URL including the session id.
   * @param {string} options.token JWT sent `accessToken` in every frame.
   * @param {(params: object, context?: {responder: object}) => Promise<{content?: object[], error?: object}|{deferred: true}>} options.handler
 *   The handler answers by return value, or parks the call by returning
 *   `{deferred: true}` and answering later through `context.responder` — that is
 *   how the loop execution route hands a call to DSH's agent loop and answers it
 *   on the next step (design notes §21).
   * @param {{warn?: Function, debug?: Function}} [options.logger]
   */
  constructor({ url, token, handler, logger }) {
    this.url = url
    this.token = token
    this.handler = handler
    this.logger = logger
    /** @type {WebSocket|undefined} */
    this.socket = undefined
    this.heartbeat = undefined
    this.closed = false
    /** Diagnostics: how many tool calls arrived and how they were answered. */
    this.calls = 0
  }

  get isOpen() {
    return this.socket !== undefined && this.socket.readyState === 1
  }

  /**
   * Open the channel and wait for the handshake.
   *
   * @param {object} options
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<ToolChannel>} this channel, for chaining.
   */
  async open({ signal, timeoutMs = 5000 } = {}) {
    if (typeof WebSocket === 'undefined') {
      throw new LanAgentError('lanagent: this runtime has no global WebSocket, so the vendor tool channel cannot open', {
        code: FailureCode.protocol,
      })
    }
    await new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      const socket = new WebSocket(this.url)
      this.socket = socket
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        rejectPromise(new LanAgentError('lanagent: tool channel handshake timed out', { code: FailureCode.network }))
      }, timeoutMs)
      const abort = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        rejectPromise(signal?.reason ?? new Error('aborted'))
      }
      signal?.addEventListener('abort', abort, { once: true })
      socket.addEventListener('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.#startHeartbeat()
        resolvePromise()
      })
      socket.addEventListener('error', (event) => {
        this.logger?.debug?.(`lanagent: tool channel error: ${event?.message ?? 'unknown'}`)
        if (settled) return
        settled = true
        clearTimeout(timer)
        rejectPromise(new LanAgentError('lanagent: tool channel failed to open', { code: FailureCode.network }))
      })
      socket.addEventListener('message', (event) => { void this.#onMessage(event) })
      socket.addEventListener('close', () => {
        this.closed = true
        this.#stopHeartbeat()
      })
    })
    return this
  }

  /** Close the channel and stop the heartbeat. */
  async close() {
    this.closed = true
    this.#stopHeartbeat()
    const socket = this.socket
    this.socket = undefined
    if (socket === undefined) return
    try {
      socket.close()
    } catch {
      // Closing an already-failed socket is not an error worth surfacing.
    }
  }

  #startHeartbeat() {
    this.#stopHeartbeat()
    this.heartbeat = setInterval(() => {
      if (!this.isOpen) return
      this.#send({ heartbeat: true })
    }, HEARTBEAT_MS)
    // Never hold the process open for a heartbeat.
    this.heartbeat?.unref?.()
  }

  #stopHeartbeat() {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  /** Send one client frame with the shared identity envelope. */
  #send({ heartbeat = false, serverCmd, data, code = 0, message = '' }) {
    if (!this.isOpen) return
    const frame = {
      clientCmd: clientCmd(),
      command: heartbeat ? 'heartbeat' : 'mcp_request',
      accessToken: this.token,
      ...heartbeat ? { timestamp: Date.now() } : { ServerCmd: serverCmd, code, message, data },
    }
    try {
      this.socket.send(JSON.stringify(frame))
    } catch (error) {
      this.logger?.debug?.(`lanagent: tool channel send failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Dispatch one server request, then answer it on the same socket. */
  async #onMessage(event) {
    let frame
    try {
      frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      return
    }
    if (frame === null || typeof frame !== 'object') return
    // The server's heartbeat acknowledgement carries no request id.
    if (frame.command === 'heartbeat_response') return
    if (frame.ServerCmd === undefined || frame.command !== 'mcp_request') return

    const request = frame.data ?? {}
    const params = request.params ?? {}
    this.calls += 1
    let answered = false
    /** Answer this call exactly once, now or from a later step. */
    const responder = {
      answer: (answer) => {
        if (answered) return
        answered = true
        if (answer?.error !== undefined) {
          this.logger?.debug?.(`lanagent: tool "${String(params.name)}" answered with error: ${String(answer.error.message ?? '')}`)
          this.#send({
            serverCmd: frame.ServerCmd,
            code: -1,
            message: String(answer.error.message ?? 'tool failed'),
            data: { jsonrpc: '2.0', id: request.id ?? 1, result: null, error: answer.error },
          })
          return
        }
        this.#send({
          serverCmd: frame.ServerCmd,
          data: { jsonrpc: '2.0', id: request.id ?? 1, result: { content: answer?.content ?? [] } },
        })
      },
    }
    let answer
    try {
      answer = await this.handler(params, { responder })
    } catch (error) {
      answer = {
        error: {
          code: -32603,
          message: `lanagent tool bridge failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      }
    }
    if (answer?.deferred === true) return
    responder.answer(answer)
  }
}

/**
 * The M1 handler: every tool call is answered with an actionable refusal.
 *
 * This exists so the vendor's server is never left waiting on the client. The
 * message names the tool so the vendor's agent can pick a different route, and
 * so the transcript explains why nothing ran.
 *
 * @param {{warn?: Function}} [logger]
 * @returns {(params: object) => Promise<{error: object}>}
 */
export function createRefusingHandler(logger) {
  return async (params) => {
    const name = String(params?.name ?? 'unknown')
    logger?.warn?.(`lanagent: vendor asked for tool "${name}" but the tool bridge is not enabled yet (M1)`)
    return {
      error: {
        code: -10001,
        message: `工具 ${name} 在当前配置下不可用：DSH 尚未启用 lanagent 工具桥。请直接基于已知信息作答，或告知用户你缺少哪项能力。`,
      },
    }
  }
}
