/**
 * Failure vocabulary for the lanagent route.
 *
 * Two layers meet here:
 *   - the vendor's application codes, which arrive inside an HTTP 200 body
 *     (`-103`/`-106` login gone, `-107` overloaded, `-200` bad request), and
 *   - DSH's `LlmFailure`, which the finish chunk carries.
 *
 * All vendor codes are strings in practice (`{"code":"0"}` succeeded in every
 * probe), so comparisons always stringify before testing.
 *
 * @module src/errors
 */

/** DSH-facing failure codes this adapter produces. */
export const FailureCode = {
  unauthorized: 'UNAUTHORIZED',
  missingCredential: 'MISSING_CREDENTIAL',
  overloaded: 'OVERLOADED',
  badRequest: 'BAD_REQUEST',
  protocol: 'LAN_AGENT_PROTOCOL',
  network: 'LAN_AGENT_NETWORK',
  toolUnavailable: 'LAN_AGENT_TOOL_UNAVAILABLE',
}

/** Vendor application codes that mean the JWT is gone and a re-login may help. */
const AUTH_CODES = new Set(['-103', '-106'])

/**
 * Classify one vendor `code` value.
 *
 * @param {unknown} raw the `code` field of a stream object.
 * @returns {{ ok: boolean, failureCode?: string, retryable?: boolean, message: string }}
 */
export function classifyVendorCode(raw, message) {
  const code = String(raw ?? '')
  const text = typeof message === 'string' && message.length > 0 ? message : `lanagent error ${code}`
  if (code === '0' || code === '200' || code === '') return { ok: true, message: text }
  if (AUTH_CODES.has(code)) return { ok: false, failureCode: FailureCode.unauthorized, retryable: false, message: text }
  // -107 is the vendor's own "模型当前访问量过大" — the next attempt may land on
  // a quieter shard, so this one is worth retrying.
  if (code === '-107') return { ok: false, failureCode: FailureCode.overloaded, retryable: true, message: text }
  if (code === '-200') return { ok: false, failureCode: FailureCode.badRequest, retryable: false, message: text }
  return { ok: false, failureCode: `LAN_AGENT_${code}`, retryable: false, message: text }
}

/**
 * Whether the error is the vendor's "previous task still running" rejection.
 *
 * The vendor runs one task per chat: right after an aborted turn its server-side
 * task may still be finishing, and a fresh POST is rejected with
 * `-200 上一个任务仍在执行中` (measured 2026-10-19). The rejection is the stream's
 * first object, so nothing has been streamed and a short bounded retry is safe;
 * every other BAD_REQUEST cause must surface instead of retrying.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isVendorTaskBusy(error) {
  return error instanceof LanAgentError
    && error.code === FailureCode.badRequest
    && /仍在执行|仍在运行|稍后重试|try again later/i.test(error.message)
}

/** One adapter-side failure, carrying everything DSH's finish chunk needs. */
export class LanAgentError extends Error {
  /**
   * @param {string} message human-readable, shown to the user.
   * @param {object} [options]
   * @param {string} [options.code] a {@link FailureCode} value.
   * @param {number} [options.status] HTTP status when one was seen.
   * @param {number} [options.retryAfterMs] provider-advertised backoff.
   * @param {boolean} [options.retryable] whether DSH's retry layer may re-run.
   */
  constructor(message, { code = FailureCode.protocol, status, retryAfterMs, retryable = false, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'LanAgentError'
    this.code = code
    this.status = status
    this.retryAfterMs = retryAfterMs
    this.retryable = retryable
  }

  /** Project into the plain `LlmFailure` object a finish chunk carries. */
  toFailure() {
    return {
      message: this.message,
      code: this.code,
      ...this.status === undefined ? {} : { status: this.status },
      ...this.retryAfterMs === undefined ? {} : { providerRetryAfterMs: this.retryAfterMs },
    }
  }
}
