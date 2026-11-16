/**
 * Offline tests for the settings-page account surface.
 *
 * Two layers are covered:
 *   - `LanAgentAuth.status()` / `login()`: presence facts never leak the account
 *     or the password, and a manual login is allowed to correct a password that
 *     the automatic backoff is currently holding off.
 *   - `src/authSettings.js`: validation, persistence only after a successful
 *     login, the empty submission that reuses stored credentials, same-origin
 *     refusal, and the bounded JSON body reader.
 *
 * Nothing here touches the network or the real credential store.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { LanAgentAuth } from '../src/auth.js'
import { FailureCode, LanAgentError } from '../src/errors.js'
import {
  AuthSettingsError,
  createAuthSettings,
  isSameOrigin,
  parseLoginInput,
  projectAuthError,
  readJsonBody,
} from '../src/authSettings.js'

/** A ref-aware credential stub that also records writes. */
function storeOf(values = {}, { writable = true } = {}) {
  const store = {
    values: { ...values },
    resolve: async (ref) => (ref in store.values ? { value: store.values[ref], source: 'file' } : undefined),
    describe: async (ref) => ({ configured: ref in store.values, writable }),
    set: async (ref, value) => { store.values[ref] = value },
  }
  return store
}

/** An auth-like object whose login is a spy, for the route-layer tests. */
function fakeAuth({ mode = 'login' } = {}) {
  return {
    mode,
    userRef: 'LAN_AGENT_USER',
    passwordRef: 'LAN_AGENT_PASSWORD',
    cached: undefined,
    loginCalls: [],
    invalidations: 0,
    tokenCalls: 0,
    async status() {
      const configured = this.cached !== undefined
      return {
        mode: this.mode,
        userRef: this.userRef,
        passwordRef: this.passwordRef,
        userConfigured: configured,
        passwordConfigured: configured,
        userSource: configured ? 'file' : '',
        passwordSource: configured ? 'file' : '',
        loggedIn: configured,
        serviceReachable: true,
        writable: true,
        backoffMs: 0,
        lastError: '',
      }
    },
    async login(user, password) {
      this.loginCalls.push({ user, password })
      this.cached = 'JWT-LOGIN'
      return this.cached
    },
    async token() {
      this.tokenCalls += 1
      this.cached = 'JWT-STORED'
      return this.cached
    },
    invalidate() {
      this.invalidations += 1
      this.cached = undefined
    },
  }
}

/* ── auth status and manual login ───────────────────────────────────────── */

test('status: reports presence and source without exposing the account', async () => {
  const auth = new LanAgentAuth({
    baseURL: 'https://example.invalid',
    credentials: storeOf({ LAN_AGENT_USER: 'alice' }),
    env: {},
  })
  const status = await auth.status()
  assert.equal(status.mode, 'login')
  assert.equal(status.userRef, 'LAN_AGENT_USER')
  assert.equal(status.passwordRef, 'LAN_AGENT_PASSWORD')
  assert.equal(status.userConfigured, true)
  assert.equal(status.passwordConfigured, false)
  assert.equal(status.userSource, 'file')
  assert.equal(status.serviceReachable, true)
  assert.equal(status.writable, true)
  assert.equal(status.loggedIn, false)
  assert.equal(JSON.stringify(status).includes('alice'), false, 'a status must never carry the account value')
})

test('status: an environment-sourced account is reported as configured', async () => {
  const auth = new LanAgentAuth({
    baseURL: 'https://example.invalid',
    credentials: () => undefined,
    env: { LAN_AGENT_USER: 'env-user', LAN_AGENT_PASSWORD: 'env-pw' },
  })
  const status = await auth.status()
  assert.equal(status.userConfigured, true)
  assert.equal(status.passwordConfigured, true)
  assert.equal(status.userSource, 'environment')
  assert.equal(status.serviceReachable, false)
  assert.equal(status.writable, false, 'without a service there is nowhere to persist a new pair')
})

test('login: supplied credentials are used directly, and the token is cached', async () => {
  const original = globalThis.fetch
  let sent
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body)
    return { ok: true, status: 200, json: async () => ({ code: '0', data: { token: 'JWT-MANUAL' } }) }
  }
  try {
    const store = storeOf({})
    const auth = new LanAgentAuth({ baseURL: 'https://example.invalid', credentials: store, env: {} })
    assert.equal(await auth.login('  bob  ', 'pw'), 'JWT-MANUAL')
    assert.deepEqual(sent, { user: 'bob', password: 'pw' })
    assert.deepEqual(store.values, {}, 'login itself must not persist; the route saves after success')
    const status = await auth.status()
    assert.equal(status.loggedIn, true)
  } finally {
    globalThis.fetch = original
  }
})

test('login: a manual attempt may correct a password during the automatic backoff', async () => {
  const original = globalThis.fetch
  let attempt = 0
  globalThis.fetch = async () => {
    attempt += 1
    if (attempt === 1) return { ok: true, status: 200, json: async () => ({ code: '-2' }) }
    return { ok: true, status: 200, json: async () => ({ code: '0', data: { token: 'JWT-FIXED' } }) }
  }
  try {
    const auth = new LanAgentAuth({
      baseURL: 'https://example.invalid',
      credentials: storeOf({}),
      env: {},
      backoff: { initialMs: 60_000, maxMs: 60_000, maxAttemptsPerHour: 5 },
    })
    await assert.rejects(auth.login('bob', 'wrong'), (error) => error.code === FailureCode.unauthorized)
    assert.match(auth.lastError, /vendor code -2/)
    const afterFailure = await auth.status()
    assert.ok(afterFailure.backoffMs > 0, 'a failure starts the automatic backoff window')
    assert.match(afterFailure.lastError, /vendor code -2/)

    // The human corrected the password: the manual path skips notBefore.
    assert.equal(await auth.login('bob', 'right'), 'JWT-FIXED')
    const afterSuccess = await auth.status()
    assert.equal(afterSuccess.loggedIn, true)
    assert.equal(afterSuccess.backoffMs, 0)
    assert.equal(afterSuccess.lastError, '')
  } finally {
    globalThis.fetch = original
  }
})

test('status: a missing-credential note disappears once that half is configured', async () => {
  const store = storeOf({})
  const auth = new LanAgentAuth({ baseURL: 'https://example.invalid', credentials: store, env: {} })
  await assert.rejects(auth.token(), (error) => error.code === FailureCode.missingCredential)
  assert.match(auth.lastError, /no account name behind/)
  assert.equal((await auth.status()).lastError, '', 'the presence flags already say what is missing')

  store.values.LAN_AGENT_USER = 'bob'
  store.values.LAN_AGENT_PASSWORD = 'pw'
  const status = await auth.status()
  assert.equal(status.lastError, '', 'the now-stale missing-account note must not be shown')
  assert.equal(status.userConfigured, true)
  assert.equal(status.passwordConfigured, true)
})

test('login: token mode refuses an account login', async () => {
  const auth = new LanAgentAuth({
    baseURL: 'https://example.invalid',
    mode: 'token',
    credentials: storeOf({}),
    env: {},
  })
  await assert.rejects(auth.login('bob', 'pw'), (error) => error.code === FailureCode.badRequest)
})

/* ── route-layer behaviour ──────────────────────────────────────────────── */

test('settings login: credentials are persisted only after the vendor accepts them', async () => {
  const auth = fakeAuth()
  const store = storeOf({})
  const settings = createAuthSettings({ auth, credentials: () => store })
  const result = await settings.login({ user: '  bob ', password: 'pw' })
  assert.deepEqual(auth.loginCalls, [{ user: 'bob', password: 'pw' }])
  assert.equal(store.values.LAN_AGENT_USER, 'bob')
  assert.equal(store.values.LAN_AGENT_PASSWORD, 'pw')
  assert.equal(result.saved, true)
  assert.equal(result.loggedIn, true)
  assert.equal(result.mode, 'login', 'the action must not overwrite the auth mode the client renders')
  assert.equal(result.source, 'form')
  assert.equal(JSON.stringify(result).includes('pw'), false, 'the response must never echo the password')
})

test('settings login: a rejected login leaves an existing pair untouched', async () => {
  const auth = fakeAuth()
  auth.login = async () => { throw new LanAgentError('lanagent: login rejected (vendor code -2)', { code: FailureCode.unauthorized }) }
  const store = storeOf({ LAN_AGENT_USER: 'old', LAN_AGENT_PASSWORD: 'old-pw' })
  const settings = createAuthSettings({ auth, credentials: () => store })
  await assert.rejects(settings.login({ user: 'new', password: 'new-pw' }), (error) => error.code === FailureCode.unauthorized)
  assert.equal(store.values.LAN_AGENT_USER, 'old')
  assert.equal(store.values.LAN_AGENT_PASSWORD, 'old-pw')
})

test('settings login: named-but-empty fields are a validation error, not a stored login', async () => {
  const auth = fakeAuth()
  const settings = createAuthSettings({ auth, credentials: () => storeOf({}) })
  await assert.rejects(settings.login({ user: '', password: '' }), (error) => {
    assert.ok(error instanceof AuthSettingsError)
    assert.equal(error.status, 400)
    return true
  })
  assert.equal(auth.tokenCalls, 0)
})

test('settings login: an empty submission reuses the stored pair', async () => {
  const auth = fakeAuth()
  const store = storeOf({ LAN_AGENT_USER: 'bob', LAN_AGENT_PASSWORD: 'pw' })
  const settings = createAuthSettings({ auth, credentials: () => store })
  const result = await settings.login({})
  assert.equal(auth.invalidations, 1)
  assert.equal(auth.tokenCalls, 1)
  assert.deepEqual(auth.loginCalls, [])
  assert.equal(result.mode, 'login', 'a stored re-login is still login mode')
  assert.equal(result.source, 'stored')
  assert.equal(result.loggedIn, true)
})

test('settings login: token mode is refused with 409', async () => {
  const settings = createAuthSettings({ auth: fakeAuth({ mode: 'token' }), credentials: () => storeOf({}) })
  await assert.rejects(settings.login({ user: 'bob', password: 'pw' }), (error) => {
    assert.ok(error instanceof AuthSettingsError)
    assert.equal(error.status, 409)
    return true
  })
})

test('settings login: a missing credentials service is refused before a login is attempted', async () => {
  const auth = fakeAuth()
  const settings = createAuthSettings({ auth, credentials: () => undefined })
  await assert.rejects(settings.login({ user: 'bob', password: 'pw' }), (error) => {
    assert.ok(error instanceof AuthSettingsError)
    assert.equal(error.status, 503)
    return true
  })
  assert.deepEqual(auth.loginCalls, [], 'nothing to persist, so no login should be attempted')
})

test('settings login: a failed save reports that the live token was not persisted', async () => {
  const auth = fakeAuth()
  const store = storeOf({})
  store.set = async () => { throw new Error('disk is read-only') }
  const settings = createAuthSettings({ auth, credentials: () => store, logger: { warn() {} } })
  const result = await settings.login({ user: 'bob', password: 'pw' })
  assert.equal(result.saved, false)
  assert.equal(result.saveError, 'disk is read-only')
  assert.equal(result.loggedIn, true, 'the session token is already live')
})

test('settings logout: drops the token without deleting stored credentials', async () => {
  const auth = fakeAuth()
  auth.cached = 'JWT'
  const store = storeOf({ LAN_AGENT_USER: 'bob', LAN_AGENT_PASSWORD: 'pw' })
  const settings = createAuthSettings({ auth, credentials: () => store })
  const result = await settings.logout()
  assert.equal(auth.invalidations, 1)
  assert.equal(auth.cached, undefined)
  assert.equal(store.values.LAN_AGENT_USER, 'bob')
  assert.equal(result.loggedIn, false)
  assert.equal(result.mode, 'login', 'logout must not clobber the auth mode: the change-account form depends on it')
  assert.equal(result.source, 'logout')
})

/* ── validation and HTTP helpers ────────────────────────────────────────── */

test('parseLoginInput: trims the account, preserves the password, rejects empties', () => {
  assert.deepEqual(parseLoginInput({ user: ' bob ', password: ' pw ' }), { user: 'bob', password: ' pw ' })
  assert.throws(() => parseLoginInput({ user: '', password: 'pw' }), AuthSettingsError)
  assert.throws(() => parseLoginInput({ user: 'bob', password: '' }), AuthSettingsError)
  assert.throws(() => parseLoginInput(null), AuthSettingsError)
})

test('readJsonBody: reads a bounded JSON object, and distinguishes empty from invalid', async () => {
  async function* chunks(...values) {
    for (const value of values) yield Buffer.from(value)
  }
  assert.deepEqual(await readJsonBody(chunks('{"user":"a",', '"password":"b"}')), { user: 'a', password: 'b' })
  assert.deepEqual(await readJsonBody(chunks('   ')), {})
  await assert.rejects(readJsonBody(chunks('{')), (error) => error.status === 400)
  await assert.rejects(readJsonBody(chunks('[]')), (error) => error.status === 400)
  await assert.rejects(readJsonBody(chunks('x'.repeat(64)), 16), (error) => error.status === 413)
})

test('isSameOrigin: missing header allowed, a different origin refused', () => {
  assert.equal(isSameOrigin({ headers: {} }), true)
  assert.equal(isSameOrigin({ headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } }), true)
  assert.equal(isSameOrigin({ headers: { origin: 'http://evil.example', host: '127.0.0.1:3080' } }), false)
  assert.equal(isSameOrigin({ headers: { origin: 'null', host: '127.0.0.1:3080' } }), false)
})

test('projectAuthError: maps route refusals and auth failures to HTTP statuses', () => {
  assert.deepEqual(projectAuthError(new AuthSettingsError('nope', 415)), { status: 415, message: 'nope' })
  assert.equal(projectAuthError(new LanAgentError('bad input', { code: FailureCode.missingCredential })).status, 400)
  assert.equal(projectAuthError(new LanAgentError('rejected', { code: FailureCode.unauthorized })).status, 401)
  assert.equal(projectAuthError(new LanAgentError('offline', { code: FailureCode.network })).status, 502)
  const timeout = new Error('timed out')
  timeout.name = 'AbortError'
  assert.deepEqual(projectAuthError(timeout), { status: 504, message: 'the login request timed out' })
})
