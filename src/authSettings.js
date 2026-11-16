/**
 * Account/password surface for the LAN Agent settings page.
 *
 * The route layer is deliberately thin: it owns HTTP concerns (method, same
 * origin, JSON body size) while every credential decision stays in
 * {@link LanAgentAuth} and the DSH credential seam. In particular:
 *
 *   - the password is never echoed back, logged, or stored anywhere but the
 *     credential store;
 *   - credentials are persisted only AFTER a login succeeds, so a typo cannot
 *     replace a working account;
 *   - a manual login may skip the automatic retry backoff, but the per-hour
 *     attempt cap always applies (account-lockout protection).
 *
 * @module src/authSettings
 */

import { LanAgentError, FailureCode } from './errors.js'

/** Largest login body the route accepts; an account and a password fit easily. */
export const MAX_AUTH_BODY_BYTES = 16 * 1024

/** A login request is bounded so a hung vendor endpoint cannot park the route. */
export const LOGIN_TIMEOUT_MS = 20_000

const MAX_ACCOUNT_LENGTH = 256
const MAX_PASSWORD_LENGTH = 1024

/** A route-level refusal, carrying the HTTP status the handler should send. */
export class AuthSettingsError extends Error {
  /**
   * @param {string} message user-facing, safe to display and to log.
   * @param {number} [status] HTTP status.
   */
  constructor(message, status = 400) {
    super(message)
    this.name = 'AuthSettingsError'
    this.status = status
  }
}

/**
 * Validate the shape of a login submission.
 *
 * The account is trimmed (a copy-pasted leading space is never meaningful);
 * the password is kept exactly as typed, because whitespace can be part of it.
 *
 * @param {unknown} value
 * @returns {{user: string, password: string}}
 * @throws {AuthSettingsError} when a field is missing, empty, or too long.
 */
export function parseLoginInput(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthSettingsError('the login body must be a JSON object', 400)
  }
  const user = typeof value.user === 'string' ? value.user.trim() : ''
  const password = typeof value.password === 'string' ? value.password : ''
  if (user.length === 0) throw new AuthSettingsError('the account name is required', 400)
  if (password.length === 0) throw new AuthSettingsError('the password is required', 400)
  if (user.length > MAX_ACCOUNT_LENGTH) {
    throw new AuthSettingsError(`the account name must be at most ${MAX_ACCOUNT_LENGTH} characters`, 400)
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new AuthSettingsError(`the password must be at most ${MAX_PASSWORD_LENGTH} characters`, 400)
  }
  return { user, password }
}

/**
 * Build the settings-page account operations.
 *
 * @param {object} options
 * @param {import('./auth.js').LanAgentAuth} options.auth
 * @param {() => object|undefined} options.credentials per-operation lookup, the
 *   same thunk the route uses for turns (the service may register after mount).
 * @param {{warn?: Function, info?: Function}} [options.logger]
 */
export function createAuthSettings({ auth, credentials, logger }) {
  const service = () => {
    const candidate = typeof credentials === 'function' ? credentials() : credentials
    if (candidate === null || candidate === undefined) return undefined
    return typeof candidate.resolve === 'function' ? candidate : undefined
  }

  /**
   * Current presence state, with `serviceReachable`/`writable` re-read from the
   * live service rather than inferred from an earlier call.
   *
   * @returns {Promise<object>}
   */
  const status = async () => {
    const snapshot = await auth.status()
    const reachable = service() !== undefined
    return {
      ...snapshot,
      serviceReachable: reachable,
      writable: reachable && snapshot.writable === true,
    }
  }

  /**
   * Log in, then persist the credentials that worked.
   *
   * An empty submission means "log in with what the store already holds" — the
   * button a configured deployment sees after a restart, when the memory-only
   * JWT is gone.
   *
   * @param {object} [payload]
   * @param {string} [payload.user]
   * @param {string} [payload.password]
   * @returns {Promise<object>} the refreshed status plus `saved`/`saveError`/
   *   `source`; `mode` always stays the configured auth mode.
   */
  const login = async (payload = {}) => {
    if (auth.mode !== 'login') {
      throw new AuthSettingsError('auth.mode is "token"; the account form is not used', 409)
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new AuthSettingsError('the login body must be a JSON object', 400)
    }
    // An EMPTY object means "sign in with the stored pair". A body that names a
    // field at all is a form submission, even when the field is empty — the
    // validation error is clearer than silently falling back to the store.
    const namesAField = Object.prototype.hasOwnProperty.call(payload, 'user')
      || Object.prototype.hasOwnProperty.call(payload, 'password')
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(LOGIN_TIMEOUT_MS) : undefined

    if (!namesAField) {
      auth.invalidate()
      await auth.token(signal)
      // `source` describes THIS action; `mode` must keep reporting the auth
      // mode the status carries. Overloading `mode` here once made the client
      // believe the route had switched to a mode it does not render, so the
      // change-account button stopped opening the form.
      return { ...(await status()), saved: false, source: 'stored' }
    }

    const { user, password } = parseLoginInput(payload)
    const store = service()
    if (store === undefined) {
      throw new AuthSettingsError('the credentials service is not reachable, so the account cannot be saved', 503)
    }
    if (typeof store.set !== 'function') {
      throw new AuthSettingsError('the credentials service does not accept writes, so the account cannot be saved', 503)
    }

    // Login FIRST. The store is only touched after the vendor accepted these
    // credentials, so a typo can never displace a working pair.
    await auth.login(user, password, signal)

    let saved = true
    let saveError = ''
    try {
      await store.set(auth.userRef, user)
      await store.set(auth.passwordRef, password)
    } catch (error) {
      saved = false
      saveError = error instanceof Error ? error.message : String(error)
      // The JWT is already live; only persistence failed. Surface it instead of
      // claiming the credentials were stored.
      logger?.warn?.(`lanagent: login succeeded but saving the account failed: ${saveError}`)
    }
    return { ...(await status()), saved, saveError, source: 'form' }
  }

  /**
   * Drop the in-memory JWT. Stored credentials stay, so the next turn logs in
   * again automatically.
   *
   * @returns {Promise<object>}
   */
  const logout = async () => {
    auth.invalidate()
    return { ...(await status()), saved: false, source: 'logout' }
  }

  return { status, login, logout }
}

/**
 * Map an error to the HTTP status and message the settings route returns.
 *
 * @param {unknown} error
 * @returns {{status: number, message: string}}
 */
export function projectAuthError(error) {
  if (error instanceof AuthSettingsError) return { status: error.status, message: error.message }
  if (error?.name === 'AbortError') return { status: 504, message: 'the login request timed out' }
  if (error instanceof LanAgentError) {
    const status = error.code === FailureCode.missingCredential
      ? 400
      : error.code === FailureCode.unauthorized
        ? 401
        : 502
    return { status, message: error.message }
  }
  return { status: 500, message: error instanceof Error ? error.message : String(error) }
}

/**
 * Read a bounded JSON object body from an HTTP request.
 *
 * @param {AsyncIterable<Buffer|string>} req
 * @param {number} [limit]
 * @returns {Promise<object>}
 */
export async function readJsonBody(req, limit = MAX_AUTH_BODY_BYTES) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new AuthSettingsError('the request body is too large', 413)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new AuthSettingsError('the request body must be JSON', 400)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthSettingsError('the request body must be a JSON object', 400)
  }
  return value
}

/**
 * Whether a state-changing request came from this page's own origin.
 *
 * A missing header (curl, a test, a non-browser client) is allowed; a present
 * and different origin is refused, which is what makes the credential write
 * unreachable from a cross-site form. Same-origin fetches send Origin on POST.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isSameOrigin(req) {
  const origin = req?.headers?.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  const host = req?.headers?.host
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Write one JSON response without caching.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
export function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}
