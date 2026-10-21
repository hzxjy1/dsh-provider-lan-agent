/**
 * `@local/dsh-provider-lan-agent` — browser half.
 *
 * One settings section (`settings.section`, id `lanagent-audit`) showing what the
 * vendor's agent actually asked DSH to run, because that activity is invisible
 * everywhere else: the bridge executes tool calls out of band, so the
 * conversation never receives a Tool call row and no card is drawn (design notes
 * §19). The Host already records every request, including the ones its own
 * translation refuses; this page renders that record.
 *
 * Data arrives over the plugin's same-origin `/lanagent/audit` route — the Host
 * half serves it from the same JSONL file the audit writer appends to — so this
 * module needs no typed Remote binding and no dependency beyond the `react` the
 * shell already provides. Colour comes only from theme variables, so the page
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
    const REFRESH_MS = 10_000

    const DICT = {
      zh: {
        nav: 'LAN Agent',
        title: 'LAN Agent 工具调用',
        description: '厂商的 agent 在服务端决定调用，实际执行发生在 DSH 里；这些调用不进对话流，所以在这里逐条记录。',
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
        colRoute: '路径',
        colMs: '耗时',
        colOk: '结果',
        detail: '详情',
        ok: '成功',
        pending: '已交 loop',
        failed: '失败',
        readError: '读取审计日志失败：',
      },
      en: {
        nav: 'LAN Agent',
        title: 'LAN Agent tool calls',
        description: 'The vendor agent decides server-side; execution happens in DSH. These calls never enter the conversation, so they are listed here.',
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
