/**
 * Offline tests for the loop transport (`src/loopPlan.js`): the program
 * envelope, refusal detection, outcome normalization, and the two text
 * renderings the seam needs. Translation and vendor shaping are covered by the
 * contract tests, not here.
 *
 *   node --test test/loopPlan.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isToolRefusal,
  looksLikeErrorText,
  looksLikePtcPrompt,
  outcomesForPlan,
  parseGlobText,
  parseSentinel,
  programFor,
  SENTINEL_CLOSE,
  SENTINEL_OPEN,
  stripReadRendering,
  withStyle,
} from '../src/loopPlan.js'
import { interpret, render } from '../src/vendor/registry.js'

const textOf = (answer) => (answer?.content ?? []).map((block) => block.text).join('')

/* ── refusal detection ──────────────────────────────────────────────────── */

test('isToolRefusal recognises the PTC collapse so the session can switch style', () => {
  assert.equal(isToolRefusal({ text: 'error: unknown tool "bash"', isError: true }), true)
  assert.equal(isToolRefusal({ text: 'Tool bash is not available in this presentation', isError: true }), true)
  assert.equal(isToolRefusal({ text: 'unknown tool "bash"', isError: false }), false)
  assert.equal(isToolRefusal({ text: '/work', isError: false }), false)
})

test('a refusal is recognised even when the message carries no isError flag', () => {
  const text = 'Error: unknown tool "bash": only `run_code` is callable directly — call `bash` from inside a `run_code` program instead'
  assert.equal(isToolRefusal({ text, isError: false }), true)
  assert.equal(isToolRefusal({ text, isError: undefined }), true)
  assert.equal(isToolRefusal({ text: 'bash: command not found', isError: true }), false)
})

test('looksLikeErrorText covers the flag and DSH\'s rendered failures', () => {
  assert.equal(looksLikeErrorText({ text: '/work', isError: false }), false)
  assert.equal(looksLikeErrorText({ text: 'Error: boom', isError: false }), true)
  assert.equal(looksLikeErrorText({ text: '', isError: true }), true)
  assert.equal(looksLikeErrorText({ text: 'error: lowercase is command output', isError: false }), false)
})

test('looksLikePtcPrompt reads the presentation out of the system prompt', () => {
  const real = 'You have access to the programmatic tool calling interface. `run_code` is the only tool you can call directly.'
  assert.equal(looksLikePtcPrompt(real), true)
  assert.equal(looksLikePtcPrompt('run_code is the only tool you can call directly'), true)
  assert.equal(looksLikePtcPrompt('only `run_code` is callable directly'), true)
  assert.equal(looksLikePtcPrompt('You may call every tool, including run_code.'), false)
  assert.equal(looksLikePtcPrompt(''), false)
  assert.equal(looksLikePtcPrompt(undefined), false)
})

/* ── transport wrapping ──────────────────────────────────────────────────── */

const nativePlan = () => ({
  kind: 'dsh',
  vendor: 'read_files',
  calls: [
    { key: 'read:0', dshTool: 'read', arguments: { file_path: 'a.md' } },
    { key: 'read:1', dshTool: 'read', arguments: { file_path: 'b.md' } },
  ],
  mappedArguments: { paths: ['a.md', 'b.md'] },
})

test('withStyle native keeps the plan calls as the transport', () => {
  const plan = withStyle(nativePlan(), 'native')
  assert.equal(plan.style, 'native')
  assert.deepEqual(plan.transportCalls, plan.calls)
})

test('withStyle run_code hands over one program and keeps the native calls', () => {
  const plan = withStyle(nativePlan(), 'run_code')
  assert.equal(plan.style, 'run_code')
  assert.equal(plan.calls.length, 2, 'native calls stay available for rendering and audit')
  assert.equal(plan.transportCalls.length, 1)
  assert.equal(plan.transportCalls[0].key, 'run_code')
  assert.equal(plan.transportCalls[0].dshTool, 'run_code')
  assert.match(plan.transportCalls[0].arguments.description, /read_files/)
  assert.match(plan.transportCalls[0].arguments.code, /tools\["read"\]/)
})

test('withStyle never nests run_code inside another run_code program', () => {
  const plan = {
    kind: 'dsh',
    vendor: 'run_code',
    calls: [{ key: 'run_code', dshTool: 'run_code', arguments: { code: 'return 1' } }],
  }
  const wrapped = withStyle(plan, 'run_code')
  assert.equal(wrapped.style, 'native')
  assert.deepEqual(wrapped.transportCalls, plan.calls)
})

test('programFor reports one entry per call and swallows individual failures', async () => {
  const code = programFor([
    { key: 'read:0', dshTool: 'read', arguments: { file_path: 'a.md' } },
    { key: 'read:1', dshTool: 'read', arguments: { file_path: 'b.md' } },
  ])
  assert.match(code, /^const results = \[\]/)
  assert.match(code, /try \{/)
  assert.match(code, /catch \(error\)/)
  assert.doesNotMatch(code, /FUZZY|placeholder/i)

  const tools = {
    read: async (args) => {
      if (args.file_path === 'b.md') throw new Error('ENOENT')
      return { lines: [{ number: 1, text: 'A' }], totalLines: 1, offset: 1 }
    },
  }
  const output = await new Function('tools', `return (async () => { ${code} })()`)(tools)
  const payload = parseSentinel(output)
  assert.equal(payload.length, 2)
  assert.equal(payload[0].ok, true)
  assert.equal(payload[1].ok, false)
  assert.match(payload[1].error, /ENOENT/)
})

test('parseSentinel finds the payload through any envelope or escaping', () => {
  assert.deepEqual(parseSentinel(`{"logs":[],"result":"${SENTINEL_OPEN}[{"ok":true}]${SENTINEL_CLOSE}"}`), [{ ok: true }])
  assert.deepEqual(parseSentinel(`${SENTINEL_OPEN}[]${SENTINEL_CLOSE}`), [])
  assert.equal(parseSentinel('no markers here'), undefined)
  assert.equal(parseSentinel(`${SENTINEL_OPEN}not json${SENTINEL_CLOSE}`), undefined)
})

/* ── outcome normalization ─────────────────────────────────────────────── */

test('outcomesForPlan: native results map by call id', () => {
  const plan = withStyle(nativePlan(), 'native')
  const ids = new Map([['read:0', 'c:read:0'], ['read:1', 'c:read:1']])
  const results = new Map([
    ['c:read:0', { text: 'A', isError: false }],
    ['c:read:1', { text: 'Error: ENOENT', isError: true }],
  ])
  const outcomes = outcomesForPlan(plan, results, ids)
  assert.equal(outcomes.get('read:0').text, 'A')
  assert.equal(outcomes.get('read:1').isError, true)
})

test('outcomesForPlan: a program payload becomes structured outcomes', () => {
  const plan = withStyle(nativePlan(), 'run_code')
  const ids = new Map([['run_code', 'c:run_code']])
  const results = new Map([['c:run_code', {
    text: `${SENTINEL_OPEN}[{"ok":true,"value":{"lines":[{"number":1,"text":"A"}],"totalLines":1,"offset":1}},{"ok":false,"error":"ENOENT"}]${SENTINEL_CLOSE}`,
    isError: false,
  }]])
  const outcomes = outcomesForPlan(plan, results, ids)
  assert.equal(outcomes.get('read:0').value.totalLines, 1)
  assert.equal(outcomes.get('read:1').isError, true)
  assert.match(outcomes.get('read:1').text, /ENOENT/)
})

test('outcomesForPlan: a broken payload makes every call fail honestly', () => {
  const plan = withStyle(nativePlan(), 'run_code')
  const ids = new Map([['run_code', 'c:run_code']])
  const outcomes = outcomesForPlan(plan, new Map([['c:run_code', { text: 'no markers', isError: false }]]), ids)
  assert.equal([...outcomes.values()].every((entry) => entry.isError === true), true)
})

/* ── seam integration ──────────────────────────────────────────────────── */

test('interpret -> withStyle -> outcomesForPlan -> render keeps the vendor answer', async () => {
  const plan = await interpret('read_files', { paths: ['a.md', 'b.md'] }, { cwd: '/w' })
  const wrapped = withStyle(plan, 'run_code')
  const ids = new Map([['run_code', 'c:run_code']])
  const results = new Map([['c:run_code', {
    text: `${SENTINEL_OPEN}[{"ok":true,"value":{"lines":[{"number":1,"text":"A"}],"totalLines":1,"offset":1}},{"ok":false,"error":"ENOENT"}]${SENTINEL_CLOSE}`,
    isError: false,
  }]])
  const answer = render(wrapped, outcomesForPlan(wrapped, results, ids), { cwd: '/w' })
  assert.deepEqual(JSON.parse(textOf(answer)), { 'a.md': 'A', 'b.md': '[读取失败] ENOENT' })
})

/* ── text renderings the seam depends on ───────────────────────────────── */

test('stripReadRendering removes tags, line numbers, and keeps a truncation note', () => {
  const text = '<path>a.md</path>\n<type>file</type>\n<content>\n1: one\n2: two\n\n(End of file - total 2 lines)\n</content>'
  assert.equal(stripReadRendering(text), 'one\ntwo')
  const cut = '<path>a.md</path>\n<type>file</type>\n<content>\n1: one\n\n(Showing lines 1 of 9)\n</content>'
  assert.match(stripReadRendering(cut), /已截断/)
})

test('parseGlobText turns the rendered list into workspace-relative paths', () => {
  assert.deepEqual(parseGlobText('/w/a.ts\n/w/b.ts', '/w'), ['a.ts', 'b.ts'])
  assert.deepEqual(parseGlobText('No files found', '/w'), [])
})
