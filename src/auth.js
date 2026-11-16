/**
 * Authentication for the lanagent route.
 *
 * Flow (measured): `POST /common-api/authCenter/login` with `{user, password}`
 * returns `data.token`, a 30-day JWT with no refresh token. Every later request
 * carries it as a bare `Authorization` header (no `Bearer`). When the vendor
 * answers `-103`/`-106` the token is gone and the only fix is to log in again.
 *
 * Three properties matter more than the code:
 *
 *   1. **The password never leaves the login path.** The settings page may hand
 *      it over once, this module sends it only to the login endpoint, and the
 *      durable copy lives in the DSH credential store — never in a plugin
 *      config file, a log, or this module's memory.
 *
 *   2. **The JWT stays in memory.** Nothing is written back to disk, so this
 *      plugin leaves no credential file behind (unlike the CLI-wrapping
 *      subagent provider, which seeds the CLI's own config).
 *
 *   3. **Login failures back off.** The vendor documents no password-error code
 *      because nobody probed it — for fear of locking the SSO account. So an
 *      unknown failure must never become a retry storm: attempts are
 *      single-flighted and exponentially backed off, with a per-hour cap.
 *
 * @module src/auth
 */

import { LanAgentError, FailureCode } from './errors.js'

/**
 * Read one config field, tolerating both shapes the loader can hand a plugin:
 * a plain value (no `Config` schema) and schemastery's `.volatile()` reference
 * accessor (`field.get()`).
 *
 * @param {object} config
 * @param {string} key
 * @param {*} fallback
 */
export function configValue(config, key, fallback) {
  const raw = config?.[key]
  if (raw === undefined || raw === null) return fallback
  if (typeof raw === 'object' && typeof raw.get === 'function') {
    const value = raw.get()
    return value === undefined ? fallback : value
  }
  return raw
}

/** Exact ref names the settings surface and the docs use. */
export const DEFAULT_USER_REF = 'LAN_AGENT_USER'
export const DEFAULT_PASSWORD_REF = 'LAN_AGENT_PASSWORD'
export const DEFAULT_TOKEN_REF = 'LAN_AGENT_TOKEN'

/**
 * Owns the JWT: resolve, log in, cache, invalidate.
 */
export class LanAgentAuth {
  /**
   * @param {object} options
   * @param {string} options.baseURL
   * @param {string} [options.user] plain-config fallback for the account name;
   *   the credential reference wins when both are set.
   * @param {'login'|'token'} [options.mode]
   * @param {string} [options.userRef]
   * @param {string} [options.passwordRef]
   * @param {string} [options.tokenRef]
   * @param {string} [options.tokenFile]
   * @param {object} [options.backoff] `{initialMs, maxMs, maxAttemptsPerHour}`
   * @param {object|(() => object|undefined)} [options.credentials] the
   *   `credentials` service, or a thunk returning it. The thunk is strongly
   *   preferred and is what the callers use: this plugin mounts long before the
   *   credentials service may be registered, so a service captured at mount
   *   time can be `undefined` forever, and the seam requires re-reading per
   *   operation anyway (that is what makes a rotated secret reach the next
   *   request without a restart).
   * @param {object} [options.env] environment lookup (defaults to `process.env`).
   * @param {{info?: Function, warn?: Function, debug?: Function}} [options.logger]
   */
  constructor({
    baseURL, user = '', mode = 'login', userRef = DEFAULT_USER_REF, passwordRef = DEFAULT_PASSWORD_REF,
    tokenRef = DEFAULT_TOKEN_REF, tokenFile = '', backoff = {}, credentials, env = process.env, logger,
  }) {
    this.baseURL = baseURL.replace(/\/+$/, '')
    this.user = typeof user === 'string' ? user : ''
    this.userRef = userRef
    this.mode = mode
    this.passwordRef = passwordRef
    this.tokenRef = tokenRef
    this.tokenFile = tokenFile
    this.initialMs = Number(backoff.initialMs) > 0 ? Number(backoff.initialMs) : 30_000
    this.maxMs = Number(backoff.maxMs) > 0 ? Number(backoff.maxMs) : 1_800_000
    this.maxAttemptsPerHour = Number(backoff.maxAttemptsPerHour) > 0 ? Number(backoff.maxAttemptsPerHour) : 6
    this.credentials = credentials
    this.env = env
    this.logger = logger
    /** @type {string|undefined} */
    this.cached = undefined
    /** @type {Promise<string>|undefined} single-flight login */
    this.inflight = undefined
    this.failureCount = 0
    this.notBefore = 0
    /** @type {number[]} timestamps of recent failed attempts, for the hourly cap */
    this.failures = []
    /**
     * The last failed attempt's user-facing message, kept only for the settings
     * page. It never contains the account name or the password.
     * @type {string}
     */
    this.lastError = ''
  }

  /** Drop the cached JWT so the next call re-authenticates. */
  invalidate() {
    this.cached = undefined
  }

  /**
   * Resolve the credentials service for THIS operation.
   *
   * Never cached: a service looked up at mount time may not exist yet, and a
   * service captured once would freeze the seam's per-operation contract.
   *
   * @returns {object|undefined}
   */
  #credentialsService() {
    const candidate = typeof this.credentials === 'function' ? this.credentials() : this.credentials
    if (candidate === null || candidate === undefined) return undefined
    return typeof candidate.resolve === 'function' ? candidate : undefined
  }

  /**
   * Resolve one credential reference and report which layer supplied it.
   *
   * The value is a secret; callers that serialize a status must keep only the
   * source label and drop the value.
   *
   * @param {string} ref
   * @returns {Promise<{value: string, source: string}|undefined>}
   */
  async #resolve(ref) {
    const service = this.#credentialsService()
    if (service !== undefined) {
      const hit = await service.resolve(ref)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) {
        const source = typeof hit.source === 'string' && hit.source.length > 0 ? hit.source : 'store'
        return { value: hit.value, source }
      }
    }
    const ambient = this.env?.[ref]
    return typeof ambient === 'string' && ambient.length > 0 ? { value: ambient, source: 'environment' } : undefined
  }

  /**
   * Resolve one credential reference: the DSH credential seam first (provider
   * store first since dsh 0.2.1-rc.2, then the environment and `.env` files),
   * then the raw environment as a fallback for compositions without a
   * credentials service.
   *
   * @param {string} ref
   * @returns {Promise<string|undefined>}
   */
  async resolveRef(ref) {
    const hit = await this.#resolve(ref)
    return hit?.value
  }

  /**
   * Presence facts for the settings page — never a value.
   *
   * A configured credential is not a live JWT: the JWT is memory-only and a
   * restart drops it, while the stored account/password survive. The page uses
   * that difference to offer "log in" instead of asking for the credentials
   * again.
   *
   * @returns {Promise<{
   *   mode: string,
   *   userRef: string,
   *   passwordRef: string,
   *   tokenRef: string,
   *   userConfigured: boolean,
   *   passwordConfigured: boolean,
   *   userSource: string,
   *   passwordSource: string,
   *   loggedIn: boolean,
   *   serviceReachable: boolean,
   *   writable: boolean,
   *   backoffMs: number,
   *   lastError: string,
   * }>}
   */
  async status() {
    const account = await this.#accountStatus()
    const password = await this.#resolve(this.passwordRef)
    // A note about a missing half is stale as soon as that half appears (the
    // store can be edited from the Models page or the file while this page is
    // open). A rejected login is a different failure and stays visible.
    if (account !== undefined && /no account name behind/.test(this.lastError)) this.lastError = ''
    if (password !== undefined && /no password behind/.test(this.lastError)) this.lastError = ''
    const service = this.#credentialsService()
    let writable = false
    if (service !== undefined && typeof service.describe === 'function') {
      try {
        const [accountInfo, passwordInfo] = await Promise.all([
          service.describe(this.userRef),
          service.describe(this.passwordRef),
        ])
        writable = accountInfo?.writable !== false && passwordInfo?.writable !== false
      } catch (error) {
        this.logger?.warn?.(`lanagent: cannot describe credential refs: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return {
      mode: this.mode,
      userRef: this.userRef,
      passwordRef: this.passwordRef,
      tokenRef: this.tokenRef,
      userConfigured: account !== undefined,
      passwordConfigured: password !== undefined,
      userSource: account?.source ?? '',
      passwordSource: password?.source ?? '',
      loggedIn: this.cached !== undefined,
      serviceReachable: service !== undefined,
      writable,
      backoffMs: Math.max(0, this.notBefore - Date.now()),
      // "No account/password" is already visible as the two presence flags;
      // repeating the long internal hint here only clutters the form. A login
      // rejection is different and stays visible.
      lastError: this.cached === undefined && !/no account name behind|no password behind/.test(this.lastError)
        ? this.lastError
        : '',
    }
  }

  /**
   * Return a usable JWT, logging in when needed.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  async token(signal) {
    if (this.cached !== undefined) return this.cached
    if (this.mode === 'token') {
      const existing = (await this.resolveRef(this.tokenRef)) ?? (await this.readTokenFile())
      if (existing === undefined) {
        throw new LanAgentError(
          `lanagent: auth.mode is "token" but ${this.tokenRef} (or auth.tokenFile) is not configured`,
          { code: FailureCode.missingCredential },
        )
      }
      this.cached = existing.trim()
      this.logger?.info?.('lanagent: using a configured JWT (auth.mode=token); no login performed')
      return this.cached
    }
    this.inflight ??= this.#login(signal).finally(() => { this.inflight = undefined })
    return await this.inflight
  }

  /** Read a JWT from the optional file path, for `auth.mode: token`. */
  async readTokenFile() {
    if (typeof this.tokenFile !== 'string' || this.tokenFile.trim().length === 0) return undefined
    try {
      const { readFile } = await import('node:fs/promises')
      const text = await readFile(this.tokenFile, 'utf8')
      return text.trim().length > 0 ? text.trim() : undefined
    } catch (error) {
      this.logger?.warn?.(`lanagent: cannot read auth.tokenFile: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /**
   * Log in with credentials supplied by the settings page, without reading the
   * store first.
   *
   * The caller persists them only after this resolves, so a typo never replaces
   * a working credential. A manual attempt is allowed during the automatic
   * backoff — a human correcting a password is not a retry storm — while the
   * per-hour cap still applies.
   *
   * @param {string} account
   * @param {string} password
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  async login(account, password, signal) {
    if (this.mode !== 'login') {
      throw new LanAgentError('lanagent: auth.mode is "token"; no account login is performed', {
        code: FailureCode.badRequest,
      })
    }
    const user = typeof account === 'string' ? account.trim() : ''
    if (user.length === 0) {
      throw new LanAgentError('lanagent: the account name is empty', { code: FailureCode.missingCredential })
    }
    if (typeof password !== 'string' || password.length === 0) {
      throw new LanAgentError('lanagent: the password is empty', { code: FailureCode.missingCredential })
    }
    this.#guardLogin({ manual: true })
    return await this.#attempt(user, password, signal)
  }

  /**
   * Perform exactly one login attempt, honoring the backoff window.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  async #login(signal) {
    this.#guardLogin()
    const account = await this.#resolveAccount()
    const password = await this.resolveRef(this.passwordRef)
    if (password === undefined) {
      const message = `lanagent: no password behind credential ref "${this.passwordRef}"; open the LAN Agent settings page to enter the account and password, or export it in the launching environment${this.#reachabilityHint()}`
      this.lastError = message
      throw new LanAgentError(message, { code: FailureCode.missingCredential })
    }
    return await this.#attempt(account, password, signal)
  }

  /**
   * Enforce the attempt budget.
   *
   * The time-based backoff protects the automatic path; a manual attempt skips
   * only that window. The hourly cap is never skipped, because it is what keeps
   * an unknown password-error code from locking the SSO account.
   *
   * @param {{manual?: boolean}} [options]
   */
  #guardLogin({ manual = false } = {}) {
    const now = Date.now()
    if (!manual && now < this.notBefore) {
      const waitMs = this.notBefore - now
      throw new LanAgentError(
        `lanagent: login is backing off for another ${Math.ceil(waitMs / 1000)}s after repeated failures`,
        { code: FailureCode.unauthorized },
      )
    }
    const cutoff = now - 3_600_000
    this.failures = this.failures.filter((at) => at > cutoff)
    if (this.failures.length >= this.maxAttemptsPerHour) {
      throw new LanAgentError(
        `lanagent: ${this.failures.length} failed logins within the last hour; refusing to try again (account lockout protection)`,
        { code: FailureCode.unauthorized },
      )
    }
  }

  /**
   * Send one login request and adopt its token.
   *
   * @param {string} account
   * @param {string} password
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  async #attempt(account, password, signal) {
    let response
    let body
    try {
      response = await fetch(`${this.baseURL}/common-api/authCenter/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: account, password }),
        ...signal === undefined ? {} : { signal },
      })
      body = await response.json()
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      const message = `lanagent: login request failed: ${error instanceof Error ? error.message : String(error)}`
      this.#recordFailure(message)
      throw new LanAgentError(message, { code: FailureCode.network, cause: error })
    }

    const code = String(body?.code ?? '')
    const token = body?.data?.token
    if (code !== '0' && code !== '200') {
      // The response body may echo account state; the vendor code is enough to
      // act on, so only the code reaches the log.
      const message = `lanagent: login rejected (vendor code ${code || 'unknown'})`
      this.#recordFailure(message)
      throw new LanAgentError(message, { code: FailureCode.unauthorized, status: response.status })
    }
    if (typeof token !== 'string' || token.length === 0) {
      const message = 'lanagent: login succeeded but returned no token'
      this.#recordFailure(message)
      throw new LanAgentError(message, { code: FailureCode.protocol })
    }
    this.failureCount = 0
    this.notBefore = 0
    this.lastError = ''
    this.cached = token
    // The account name is treated as hidden information now, so it is not
    // echoed back into logs.
    this.logger?.info?.('lanagent: login succeeded')
    return token
  }

  /**
   * Resolve the account name for one login.
   *
   * The credential reference wins over the plain-config `user` field: the whole
   * point of the reference is that the account does not have to appear in a
   * deployment file. A config value that disagrees is not silently ignored —
   * that would be a confusing way to log into the wrong account — so it warns.
   *
   * @returns {Promise<string>}
   */
  async #resolveAccount() {
    const fromRef = await this.#resolve(this.userRef)
    if (fromRef !== undefined) {
      if (this.user.length > 0 && this.user !== fromRef.value) {
        this.logger?.warn?.(`lanagent: ${this.userRef} and the row's \`user\` disagree; using the credential reference`)
      }
      return fromRef.value
    }
    if (this.user.length > 0) return this.user
    const message = `lanagent: no account name behind ${this.userRef}, and the row sets no \`user\` fallback; open the LAN Agent settings page to enter the account and password, or export ${this.userRef}${this.#reachabilityHint()}`
    this.lastError = message
    throw new LanAgentError(message, { code: FailureCode.missingCredential })
  }

  /**
   * The account for status only: the plain-config fallback is a valid account,
   * but status reports it without triggering the disagreement warning that a
   * real login should emit.
   *
   * @returns {Promise<{value: string, source: string}|undefined>}
   */
  async #accountStatus() {
    const fromRef = await this.#resolve(this.userRef)
    if (fromRef !== undefined) return fromRef
    return this.user.length > 0 ? { value: this.user, source: 'config' } : undefined
  }

  /**
   * Distinguish the two ways a credential can be missing: the seam is not
   * reachable from this plugin at all, or it is reachable and the reference
   * simply holds nothing. Without this the message sends the reader to the
   * wrong place — the store looked fine while the service was the problem.
   *
   * @returns {string}
   */
  #reachabilityHint() {
    return this.#credentialsService() === undefined
      ? ' (the credentials service is not reachable from this plugin right now)'
      : ' (the credentials service is reachable, but that reference resolves to nothing)'
  }

  /**
   * Advance the backoff window after one failed attempt.
   *
   * @param {string} [message] the user-facing failure, retained for the
   *   settings page (never the account or password).
   */
  #recordFailure(message = '') {
    this.lastError = typeof message === 'string' ? message : ''
    this.failures.push(Date.now())
    const delay = Math.min(this.initialMs * 2 ** this.failureCount, this.maxMs)
    this.failureCount += 1
    this.notBefore = Date.now() + delay
    this.logger?.warn?.(`lanagent: login failed; next attempt allowed in ${Math.round(delay / 1000)}s`)
  }
}
