/**
 * `@local/dsh-provider-lan-agent` — browser half.
 *
 * One settings section (`settings.section`, id `lanagent-audit`). It shows the
 * deploy-time account state first — an account/password form when the service
 * has no stored login yet, and a status/relogin card when it does — then the
 * translation diagnostics for the agent's tool requests: what it asked for,
 * which DSH call ran, and how it was answered. Loop calls also appear in the
 * conversation; this page is the cross-route view that additionally covers
 * refusals, local answers, and parked requests.
 *
 * Both halves arrive over the plugin's own same-origin routes, so this module
 * needs no typed Remote binding and no dependency beyond the `react` the shell
 * already provides. Colour comes only from theme variables, so the page
 * survives a scheme switch.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-provider-lan-agent',
  factory: require => {
    const React = require('react')
    const { createElement: h, Fragment, useCallback, useEffect, useRef, useState } = React

    const NS = 'settings.lanagentAudit'
    const inject = ['slots', 'locale']
    const ENDPOINT = '/lanagent/audit'
    const ENDPOINT_CLI = '/lanagent/cli'
    const AUTH_ENDPOINT = '/lanagent/auth'
    const AUTH_LOGIN_ENDPOINT = '/lanagent/auth/login'
    const AUTH_LOGOUT_ENDPOINT = '/lanagent/auth/logout'
    const REFRESH_MS = 10_000
    const CLI_REFRESH_MS = 30_000
    const AUTH_REFRESH_MS = 30_000

    const DICT = {
      zh: {
        nav: 'LAN Agent',
        accountTitle: '账号登录',
        accountMissing: '未配置登录凭据',
        accountConfigured: '凭据已配置',
        accountLoggedIn: '已登录',
        accountNotLoggedIn: '未登录',
        accountUser: '账号',
        accountPassword: '密码',
        accountSubmit: '保存并登录',
        accountLogin: '登录',
        accountChange: '更换账号密码',
        accountCancel: '取消',
        accountLogout: '退出登录',
        accountChecking: '检查中…',
        accountTokenMode: '使用已有 JWT，不需要账号密码。',
        accountTokenBadge: 'Token 模式',
        accountServiceDown: '凭据服务不可用，无法保存。',
        accountReadOnly: '凭据存储只读，无法保存。',
        accountWorking: '正在登录…',
        accountSaved: '已保存并登录。',
        accountSavedPartial: '已登录，但凭据未保存。',
        accountLoginOk: '已登录。',
        accountLoggedOut: '已退出。',
        accountFailed: '操作失败：',
        accountRequired: '请填写账号和密码。',
        accountBackoff: '登录冷却还剩 ',
        title: 'LAN Agent 工具调用诊断',
        description: '厂商 agent 在服务端决定调用；这里按请求 id 展示翻译、路由与结果，包括被拒绝和本地应答的请求。loop 调用同时也会出现在会话里。',
        refresh: '刷新',
        auto: '每 10 秒自动刷新',
        empty: '还没有工具调用记录。',
        disabled: '审计日志未启用：请在插件那一行配置 toolAuditFile（例如 $DSH_HOME/lan-agent-tool-audit.jsonl）。',
        file: '审计文件',
        loaded: '已加载',
        records: '条记录',
        colTime: '时间',
        colTool: '厂商请求',
        colDsh: 'DSH 执行',
        colRoute: '路由',
        colMs: '耗时',
        colOk: '结果',
        detail: '详情',
        ok: '成功',
        pending: '停放中',
        failed: '失败',
        readError: '读取审计日志失败：',
        cliMissing: '缺少 CLI 软件；装了插件的你知道在哪里下载，请把它放到 ',
      },
      en: {
        nav: 'LAN Agent',
        accountTitle: 'Account login',
        accountMissing: 'No login credentials',
        accountConfigured: 'Credentials configured',
        accountLoggedIn: 'Signed in',
        accountNotLoggedIn: 'Not signed in',
        accountUser: 'Account',
        accountPassword: 'Password',
        accountSubmit: 'Save and sign in',
        accountLogin: 'Sign in',
        accountChange: 'Change account',
        accountCancel: 'Cancel',
        accountLogout: 'Sign out',
        accountChecking: 'Checking…',
        accountTokenMode: 'Uses an existing JWT; no account/password needed.',
        accountTokenBadge: 'Token mode',
        accountServiceDown: 'Credentials service unavailable; cannot save.',
        accountReadOnly: 'Credential store is read-only; cannot save.',
        accountWorking: 'Signing in…',
        accountSaved: 'Saved and signed in.',
        accountSavedPartial: 'Signed in, but the credentials were not saved.',
        accountLoginOk: 'Signed in.',
        accountLoggedOut: 'Signed out.',
        accountFailed: 'Request failed: ',
        accountRequired: 'Enter both the account and the password.',
        accountBackoff: 'Login cooldown: ',
        title: 'LAN Agent tool diagnostics',
        description: 'The agent decides server-side; this view lists translation, route, and result per request id — including refusals and local answers. Loop calls also appear in the conversation.',
        refresh: 'Refresh',
        auto: 'Auto-refreshes every 10s',
        empty: 'No tool calls recorded yet.',
        disabled: 'Audit log disabled: set toolAuditFile on the plugin row (e.g. $DSH_HOME/lan-agent-tool-audit.jsonl).',
        file: 'Audit file',
        loaded: 'Loaded',
        records: 'records',
        colTime: 'Time',
        colTool: 'Vendor request',
        colDsh: 'DSH tool',
        colRoute: 'Route',
        colMs: 'Took',
        colOk: 'Result',
        detail: 'Detail',
        ok: 'ok',
        pending: 'in loop',
        failed: 'failed',
        readError: 'Could not read the audit log: ',
        cliMissing: 'The optional CLI is not installed. Put the file you already have at ',
      },
    }

    const CSS = `
.apl_audit { display: flex; flex-direction: column; gap: 12px; color: var(--dsw-alias-label-primary); }
.apl_audit h2 { margin: 0; font-size: 15px; font-weight: 600; }
.apl_audit p { margin: 0; font-size: 13px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.apl_audit .apl_bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.apl_audit button { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.apl_audit button:hover { border-color: var(--dsw-alias-border-l2); }
.apl_audit .apl_meta { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.apl_audit .apl_meta code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.apl_audit .apl_warn { font-size: 12px; color: var(--dsw-alias-state-warn-primary); }
.apl_audit .apl_rows { display: flex; flex-direction: column; gap: 6px; }
.apl_audit .apl_row { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
.apl_audit .apl_rowhead { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.apl_audit .apl_time { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.apl_audit .apl_tool { font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.apl_audit .apl_tag { font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary); }
.apl_audit .apl_ok { color: var(--dsw-alias-state-success-primary); }
.apl_audit .apl_fail { color: var(--dsw-alias-state-error-primary); }
.apl_audit .apl_wait { color: var(--dsw-alias-state-idle-primary); }
.apl_audit .apl_body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  color: var(--dsw-alias-label-secondary); white-space: pre-wrap; word-break: break-all; max-height: 6.5em; overflow: hidden; }
.apl_auth { display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 12px; }
.apl_auth .apl_badges { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.apl_auth .apl_oktag { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.apl_auth .apl_warn { color: var(--dsw-alias-state-error-primary); word-break: break-word; }
.apl_auth .apl_okmsg { font-size: 12px; color: var(--dsw-alias-state-success-primary); }
.apl_auth .apl_authform { display: flex; flex-direction: column; gap: 10px; max-width: 440px; }
.apl_auth .apl_authform label { display: flex; flex-direction: column; gap: 5px; font-size: 12px;
  color: var(--dsw-alias-label-secondary); }
.apl_auth .apl_authform input { font: inherit; font-size: 13px; padding: 6px 9px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); }
.apl_auth .apl_authform input:hover { border-color: var(--dsw-alias-border-l2); }
.apl_auth .apl_authform input:focus { border-color: var(--dsw-alias-border-l2); outline: 1px solid var(--dsw-alias-border-l2); outline-offset: 1px; }
.apl_auth .apl_authform input:disabled { opacity: 0.6; }
.apl_auth .apl_note { opacity: 0.85; }
.apl_banner { display: flex; align-items: flex-start; gap: 8px; box-sizing: border-box; width: 100%;
  padding: 10px 12px; border-radius: 8px; font-size: 13px; line-height: 1.5;
  color: var(--dsw-alias-state-warn-primary, #6b5200);
  background: var(--dsw-alias-state-warn-tertiary, #fff6d8);
  border: 1px solid var(--dsw-alias-state-warn-secondary, #e8b931); }
.apl_banner code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
`

    function localeTag(ctx) {
      try {
        const snapshot = typeof ctx.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx.locale?.getSnapshot?.()
        const value = snapshot?.active ?? ctx.locale?.locale
        return typeof value === 'string' ? value : document.documentElement.lang || 'en'
      } catch { return 'en' }
    }

    const clock = (ms) => {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    function Panel(props) {
      const t = props.t
      const [feed, setFeed] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const alive = useRef(true)

      const load = useCallback(async () => {
        setBusy(true)
        try {
          const response = await fetch(`${ENDPOINT}?limit=200`, { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const body = await response.json()
          if (!alive.current) return
          setFeed(body)
          setError(body.error === undefined ? '' : String(body.error))
        } catch (cause) {
          if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (alive.current) setBusy(false)
        }
      }, [])

      useEffect(() => {
        alive.current = true
        void load()
        const timer = setInterval(() => { void load() }, REFRESH_MS)
        return () => { alive.current = false; clearInterval(timer) }
      }, [load])

      const records = Array.isArray(feed?.records) ? feed.records : []
      const row = (record, index) => {
        // `ok: null` is the loop route's parked record: the verdict arrives with
        // the resumed step's record, so this row only says "handed to the loop".
        const ok = record.ok === true
        const pending = record.ok === null || record.ok === undefined
        const detailText = record.detail !== undefined && record.detail !== null ? String(record.detail) : ''
        return h('div', { className: 'apl_row', key: `${record.time ?? 0}-${index}` }, [
          h('div', { className: 'apl_rowhead', key: 'head' }, [
            h('span', { className: 'apl_time', key: 'time' }, clock(record.time)),
            h('span', { className: 'apl_tool', key: 'name' }, String(record.name ?? '?')),
            h('span', { className: 'apl_tag', key: 'dsh' }, `→ ${String(record.dshTool ?? '—')}`),
            record.route === undefined ? null : h('span', { className: 'apl_tag', key: 'route' }, String(record.route)),
            h('span', { className: 'apl_tag', key: 'ms' }, `${String(record.durationMs ?? '—')}ms`),
            h('span', { className: ok ? 'apl_ok' : pending ? 'apl_wait' : 'apl_fail', key: 'ok' }, ok ? t('ok') : pending ? t('pending') : t('failed')),
          ]),
          h('div', { className: 'apl_body', key: 'args' }, String(record.args ?? '')),
          detailText.length > 0
            ? h('div', { className: 'apl_body', key: 'detail' }, `${t('detail')}: ${detailText}`)
            : (record.summary ? h('div', { className: 'apl_body', key: 'summary' }, String(record.summary)) : null),
        ])
      }

      return h('div', { className: 'apl_audit' }, [
        // Account state comes first: a deployment with no credentials must land
        // on the inputs, not on a diagnostics page that cannot run a turn.
        h(AccountCard, { key: 'account', t }),
        // The CLI banner belongs to THIS plugin's page: it is about this
        // plugin's optional capability, not about the harness in general.
        h(CliBanner, { key: 'cli', t }),
        h('h2', { key: 'title' }, t('title')),
        h('p', { key: 'desc' }, t('description')),
        h('div', { className: 'apl_bar', key: 'bar' }, [
          h('button', { key: 'refresh', type: 'button', onClick: () => { void load() }, disabled: busy }, t('refresh')),
          h('span', { className: 'apl_meta', key: 'auto' }, t('auto')),
          h('span', { className: 'apl_meta', key: 'count' }, feed === null ? '' : `${records.length} ${t('records')}`),
        ]),
        error.length > 0 ? h('p', { className: 'apl_warn', key: 'error' }, `${t('readError')}${error}`) : null,
        feed !== null && feed.enabled === false ? h('p', { className: 'apl_warn', key: 'disabled' }, t('disabled')) : null,
        feed !== null && feed.file ? h('p', { className: 'apl_meta', key: 'file' }, [t('file'), ': ', h('code', { key: 'code' }, String(feed.file))]) : null,
        records.length === 0
          ? h('p', { key: 'empty' }, t('empty'))
          : h('div', { className: 'apl_rows', key: 'rows' }, records.map(row)),
      ])
    }

    /**
     * The settings banner for the optional CLI capability. It renders nothing
     * unless a watch has actually looked (`known`) and found the file missing
     * — a deployment without the subagent row never sees it.
     */
    function CliBanner(props) {
      const t = props.t
      const [status, setStatus] = useState(null)
      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const response = await fetch(ENDPOINT_CLI, { headers: { accept: 'application/json' } })
            if (!response.ok) return
            const body = await response.json()
            if (alive) setStatus(body)
          } catch {
            /* advisory only: a failed read simply shows nothing */
          }
        }
        void load()
        const timer = setInterval(() => { void load() }, CLI_REFRESH_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      if (status === null || status.known !== true || status.present === true) return null
      return h('div', { className: 'apl_banner' }, [
        h('span', { key: 'label' }, t('cliMissing')),
        h('code', { key: 'path' }, String(status.path ?? '')),
      ])
    }

    /**
     * The account card at the top of this plugin's own settings page.
     *
     * The form is forced open whenever the credential store has no complete
     * pair, which is the requested behaviour: a deployment that has never been
     * configured sees the account/password inputs immediately. Once both
     * credentials exist the card shrinks to status plus sign-in/change/sign-out
     * controls, and the JWT stays in the Host's memory.
     */
    function AccountCard(props) {
      const t = props.t
      const [status, setStatus] = useState(null)
      const [loadError, setLoadError] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [showForm, setShowForm] = useState(false)
      const [user, setUser] = useState('')
      const [password, setPassword] = useState('')
      const alive = useRef(true)

      const load = useCallback(async () => {
        try {
          const response = await fetch(AUTH_ENDPOINT, { headers: { accept: 'application/json' } })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(body.error !== undefined ? String(body.error) : `HTTP ${response.status}`)
          if (!alive.current) return
          setStatus(body)
          setLoadError('')
        } catch (cause) {
          if (alive.current) setLoadError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])

      useEffect(() => {
        alive.current = true
        void load()
        const timer = setInterval(() => { void load() }, AUTH_REFRESH_MS)
        return () => { alive.current = false; clearInterval(timer) }
      }, [load])

      const call = async (path, payload) => {
        const response = await fetch(path, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error !== undefined ? String(body.error) : `HTTP ${response.status}`)
        return body
      }

      const submit = async (event) => {
        if (event !== undefined && typeof event.preventDefault === 'function') event.preventDefault()
        setError('')
        setNotice('')
        if (user.trim().length === 0 || password.length === 0) {
          setError(t('accountRequired'))
          return
        }
        setBusy(true)
        try {
          const body = await call(AUTH_LOGIN_ENDPOINT, { user, password })
          if (!alive.current) return
          setStatus(body)
          setPassword('')
          setShowForm(false)
          if (body.saved === false) {
            setNotice(t('accountSavedPartial'))
            if (typeof body.saveError === 'string' && body.saveError.length > 0) setError(body.saveError)
          } else {
            setNotice(t('accountSaved'))
          }
        } catch (cause) {
          if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      const loginStored = async () => {
        setError('')
        setNotice('')
        setBusy(true)
        try {
          const body = await call(AUTH_LOGIN_ENDPOINT, {})
          if (!alive.current) return
          setStatus(body)
          setNotice(t('accountLoginOk'))
        } catch (cause) {
          if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      const logout = async () => {
        setError('')
        setNotice('')
        setBusy(true)
        try {
          const body = await call(AUTH_LOGOUT_ENDPOINT, {})
          if (!alive.current) return
          setStatus(body)
          setNotice(t('accountLoggedOut'))
        } catch (cause) {
          if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (alive.current) setBusy(false)
        }
      }

      if (status === null) {
        return h('div', { className: 'apl_auth' }, [
          h('h2', { key: 'title' }, t('accountTitle')),
          loadError.length > 0
            ? h('p', { className: 'apl_warn', key: 'loadError' }, `${t('accountFailed')}${loadError}`)
            : h('p', { className: 'apl_meta', key: 'checking' }, t('accountChecking')),
        ])
      }

      // The auth mode is a closed set: `token` or `login`. Treat anything else
      // as login so an action label accidentally returned in `mode` (the bug
      // that made “更换账号密码” inert after sign-out) can never hide the form.
      const mode = status.mode === 'token' ? 'token' : 'login'
      const isToken = mode === 'token'
      const hasAccount = status.userConfigured === true
      const hasPassword = status.passwordConfigured === true
      const configured = hasAccount && hasPassword
      const writable = status.serviceReachable === true && status.writable === true
      // Missing credentials force the inputs open; a configured pair only opens
      // them when the operator asks to change the account.
      const formVisible = mode === 'login' && (configured ? showForm : true)

      const form = formVisible ? h('form', { className: 'apl_authform', key: 'form', onSubmit: submit }, [
        h('label', { key: 'user' }, [
          h('span', { key: 'label' }, t('accountUser')),
          h('input', {
            key: 'input',
            type: 'text',
            autoComplete: 'username',
            value: user,
            disabled: busy || !writable,
            onChange: (event) => setUser(event.target.value),
          }),
        ]),
        h('label', { key: 'password' }, [
          h('span', { key: 'label' }, t('accountPassword')),
          h('input', {
            key: 'input',
            type: 'password',
            autoComplete: 'current-password',
            value: password,
            disabled: busy || !writable,
            onChange: (event) => setPassword(event.target.value),
          }),
        ]),
        h('div', { className: 'apl_bar', key: 'actions' }, [
          h('button', { key: 'submit', type: 'submit', disabled: busy || !writable }, busy ? t('accountWorking') : t('accountSubmit')),
          configured
            ? h('button', {
              key: 'cancel',
              type: 'button',
              disabled: busy,
              onClick: () => { setShowForm(false); setPassword(''); setError('') },
            }, t('accountCancel'))
            : null,
        ]),
      ]) : null

      const controls = configured && !formVisible ? h('div', { className: 'apl_bar', key: 'controls' }, [
        status.loggedIn
          ? h('button', { key: 'logout', type: 'button', disabled: busy, onClick: () => { void logout() } }, t('accountLogout'))
          : h('button', { key: 'login', type: 'button', disabled: busy, onClick: () => { void loginStored() } }, t('accountLogin')),
        writable
          ? h('button', {
            key: 'change',
            type: 'button',
            disabled: busy,
            onClick: () => { setShowForm(true); setError(''); setNotice('') },
          }, t('accountChange'))
          : null,
      ]) : null

      return h('div', { className: 'apl_auth' }, [
        h('h2', { key: 'title' }, t('accountTitle')),
        h('div', { className: 'apl_badges', key: 'badges' }, isToken
          ? [h('span', { className: 'apl_tag', key: 'token' }, t('accountTokenBadge'))]
          : [
            h('span', { className: configured ? 'apl_tag apl_oktag' : 'apl_tag apl_fail', key: 'configured' },
              configured ? t('accountConfigured') : t('accountMissing')),
            configured
              ? h('span', { className: status.loggedIn === true ? 'apl_tag apl_oktag' : 'apl_tag', key: 'login' },
                status.loggedIn === true ? t('accountLoggedIn') : t('accountNotLoggedIn'))
              : null,
          ]),
        mode === 'token' ? h('p', { className: 'apl_meta', key: 'token' }, t('accountTokenMode')) : null,
        mode === 'login' && !writable
          ? h('p', { className: 'apl_warn', key: 'nowrite' },
            status.serviceReachable === true ? t('accountReadOnly') : t('accountServiceDown'))
          : null,
        status.backoffMs > 0 && status.loggedIn !== true
          ? h('p', { className: 'apl_warn', key: 'backoff' }, `${t('accountBackoff')}${Math.ceil(status.backoffMs / 1000)}s`)
          : null,
        error.length > 0
          ? h('p', { className: 'apl_warn', key: 'error' }, `${t('accountFailed')}${error}`)
          : (status.loggedIn !== true && typeof status.lastError === 'string' && status.lastError.length > 0
            ? h('p', { className: 'apl_warn', key: 'lastError' }, status.lastError)
            : null),
        notice.length > 0 ? h('p', { className: 'apl_okmsg', key: 'notice' }, notice) : null,
        loadError.length > 0 ? h('p', { className: 'apl_warn', key: 'loadError' }, `${t('accountFailed')}${loadError}`) : null,
        form,
        controls,
      ])
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'lanagent: audit dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', '@local/dsh-provider-lan-agent')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'lanagent: audit styles')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'lanagent-audit',
        order: 36,
        label: () => t('nav'),
        locale: NS,
      }, props => h(Panel, { ...props, t: Object.assign(x => t(x), { locale: localeTag(ctx) }) })))
    }

    return { inject, apply }
  },
})
