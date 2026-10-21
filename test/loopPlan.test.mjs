/**
 * Offline tests for the loop route's planning and shaping (`src/loopPlan.js`).
 *
 *   node --test test/loopPlan.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isToolRefusal,
  looksLikeErrorText,
  looksLikePtcPrompt,
  parseGlobText,
  parseSentinel,
  planVendorCall,
  programFor,
  shapeLoopResults,
  stripReadRendering,
} from '../src/loopPlan.js'

const plan = (name, input, options) => {
  const result = planVendorCall(name, input, options)
  assert.equal(result.error, undefined, `unexpected planning error: ${result.error}`)
  return result
}
const results = (entries) => new Map(Object.entries(entries).map(([key, value]) => [key, typeof value === 'string' ? { text: value, isError: false } : value]))
const textOf = (answer) => answer.content[0].text

/* ── planning ───────────────────────────────────────────────────────────── */

test('execute_command becomes one bash call with the description DSH requires', () => {
  const p = plan('execute_command', { command: 'pwd && ls', workdir: 'src', timeout: 300000 })
  assert.deepEqual(p.calls, [{
    key: 'cmd',
    dshTool: 'bash',
    arguments: { command: 'pwd && ls', description: 'lanagent 委派: pwd && ls', workdir: 'src', timeoutMs: 300000 },
  }])
})

test('read_files plans one read per path, keeping the slot and path', () => {
  const p = plan('read_files', { paths: ['a.md', 'b.md'] })
  assert.deepEqual(p.calls.map((c) => [c.key, c.dshTool, c.arguments.file_path, c.path]), [
    ['read:0', 'read', 'a.md', 'a.md'],
    ['read:1', 'read', 'b.md', 'b.md'],
  ])
})

test('list_files builds the glob pattern from path and recursive', () => {
  assert.equal(plan('list_files', { path: 'src', recursive: 'true' }).calls[0].arguments.pattern, 'src/**/*')
  assert.equal(plan('list_files', { path: '.' }).calls[0].arguments.pattern, '*')
  assert.equal(plan('list_files', { path: '.' }).calls[0].arguments.path, undefined)
})

test('search_files dispatches Grep and Glob shapes', () => {
  const grep = plan('search_files', { claude_name: 'Grep', pattern: 'hit', path: 'src', glob: '*.ts' })
  assert.deepEqual(grep.calls[0].arguments, { pattern: 'hit', path: 'src', include: '*.ts' })
  const glob = plan('search_files', { claude_name: 'Glob', pattern: '*.md' })
  assert.deepEqual(glob.calls[0], { key: 'glob', dshTool: 'glob', arguments: { pattern: '*.md' } })
  const legacy = plan('search_files', { path: 'src', regex: 'TODO', file_pattern: '*.md' })
  assert.deepEqual(legacy.calls[0].arguments, { pattern: 'TODO', path: 'src', include: '*.md' })
})

test('replace_in_file plans one edit per SEARCH/REPLACE block', () => {
  const diff = ['--- SEARCH', 'old-1', '===', 'new-1', '+++ REPLACE', '--- SEARCH', 'old-2', '===', 'new-2', '+++ REPLACE'].join('\n')
  const p = plan('replace_in_file', { path: 'a.md', diff })
  assert.deepEqual(p.calls.map((c) => c.arguments), [
    { file_path: 'a.md', old_string: 'old-1\n', new_string: 'new-1\n' },
    { file_path: 'a.md', old_string: 'old-2\n', new_string: 'new-2\n' },
  ])
})

test('use_mcp_tool targets the toolbox name directly, or an mcp__ route', () => {
  assert.equal(plan('use_mcp_tool', { server_name: 'dsh_toolbox', tool_name: 'todo_write', arguments: { todos: [] } }).calls[0].dshTool, 'todo_write')
  assert.equal(plan('use_mcp_tool', { server_name: 'serial', tool_name: 'list_ports', arguments: {} }).calls[0].dshTool, 'mcp__serial__list_ports')
})

test('DSH names and mcp__ names pass through unchanged', () => {
  const p = plan('bash', { command: 'pwd', description: 'd' })
  assert.deepEqual(p.calls[0], { key: 'passthrough', dshTool: 'bash', arguments: { command: 'pwd', description: 'd' } })
  assert.equal(plan('mcp__serial__read', { n: 1 }).calls[0].dshTool, 'mcp__serial__read')
})

test('unplannable requests and the excluded preflight are reported, not guessed', () => {
  assert.match(planVendorCall('frobnicate', {}).error, /frobnicate/)
  assert.match(planVendorCall('get_environment_info', {}).error, /环境预检/)
  assert.match(planVendorCall('execute_command', { command: '  ' }).error, /command 参数为空/)
  assert.match(planVendorCall('replace_in_file', { path: 'a.md', diff: 'nope' }).error, /SEARCH/)
})

/* ── read rendering ─────────────────────────────────────────────────────── */

test('stripReadRendering unwraps tags, line numbers and the end-of-file footer', () => {
  const rendered = ['<path>/w/a.md</path>', '<type>file</type>', '<content>', '1: one', '2: two', '', '(End of file - total 2 lines)', '</content>'].join('\n')
  assert.equal(stripReadRendering(rendered), 'one\ntwo')
})

test('stripReadRendering keeps a truncation footer as a note', () => {
  const rendered = ['<path>a.md</path>', '<type>file</type>', '<content>', '1: one', '', '(Showing lines 1-1 of 99. Use offset=2 to continue.)', '</content>'].join('\n')
  const out = stripReadRendering(rendered)
  assert.match(out, /^one/)
  assert.match(out, /已截断/)
  assert.match(out, /Showing lines 1-1 of 99/)
})

test('stripReadRendering leaves non-wrapped text alone', () => {
  assert.equal(stripReadRendering('just text'), 'just text')
})

test('parseGlobText normalizes paths and reports the empty result', () => {
  assert.deepEqual(parseGlobText('/work/src/a.ts\n/work/b.md', '/work'), ['src/a.ts', 'b.md'])
  assert.deepEqual(parseGlobText('No files found', '/work'), [])
  assert.deepEqual(parseGlobText('', '/work'), [])
})

/* ── shaping ────────────────────────────────────────────────────────────── */

test('execute_command shapes the loop text into the vendor payload', () => {
  const p = plan('execute_command', { command: 'pwd' })
  const shaped = shapeLoopResults(p, results({ cmd: '/work\n' }))
  assert.deepEqual(JSON.parse(textOf(shaped)), { success: true, output: '/work', error: '' })
})

test('read_files merges every slot into a {path: content} map and notes failures', () => {
  const p = plan('read_files', { paths: ['a.md', 'b.md'] })
  const shaped = shapeLoopResults(p, results({
    'read:0': { text: '<path>a.md</path>\n<type>file</type>\n<content>\n1: A\n\n(End of file - total 1 lines)\n</content>', isError: false },
    'read:1': { text: 'ENOENT: no such file', isError: true },
  }))
  assert.deepEqual(JSON.parse(textOf(shaped)), { 'a.md': 'A', 'b.md': '[读取失败] ENOENT: no such file' })
})

test('list_files and search_files shape text; write and replace answer success', () => {
  const list = shapeLoopResults(plan('list_files', { path: '.' }), results({ glob: '/w/a.ts\n/w/b.md' }), { cwd: '/w' })
  assert.deepEqual(JSON.parse(textOf(list)), ['a.ts', 'b.md'])

  const search = shapeLoopResults(plan('search_files', { claude_name: 'Grep', pattern: 'x' }), results({ grep: 'a.ts:3:hit' }))
  assert.equal(textOf(search), 'a.ts:3:hit')

  assert.equal(textOf(shapeLoopResults(plan('write_to_file', { path: 'a', content: 'b' }), results({ write: 'wrote' }))), 'success')
  const diff = ['--- SEARCH', 'o', '===', 'n', '+++ REPLACE'].join('\n')
  assert.equal(textOf(shapeLoopResults(plan('replace_in_file', { path: 'a', diff }), results({ 'edit:0': 'edited' }))), 'success')
})

test('a failing call becomes an error envelope carrying the tool message', () => {
  const list = shapeLoopResults(plan('list_files', { path: '.' }), results({ glob: { text: 'permission denied', isError: true } }))
  assert.equal(list.content, undefined)
  assert.match(list.error.message, /permission denied/)

  const edit = shapeLoopResults(plan('replace_in_file', { path: 'a', diff: ['--- SEARCH', 'o', '===', 'n', '+++ REPLACE'].join('\n') }), results({
    'edit:0': { text: 'SEARCH 块未能应用', isError: true },
  }))
  assert.match(edit.error.message, /SEARCH 块未能应用/)
})

/* ── the generated-program style (PTC sessions) ─────────────────────────── */

const programPlan = (name, input, options) => {
  const result = planVendorCall(name, input, { style: 'run_code', ...options })
  assert.equal(result.error, undefined, `unexpected planning error: ${result.error}`)
  assert.equal(result.style, 'run_code')
  return result
}
/** Wrap structured values the way the generated program reports them. */
const programResult = (values) => results({ run_code: `<<<LANAGENT-RESULT>>>${JSON.stringify(values)}<<<LANAGENT-END>>>` })

test('a run_code plan keeps the native calls and hands over one program', () => {
  const p = programPlan('read_files', { paths: ['a.md', 'b.md'] })
  assert.equal(p.calls.length, 1)
  assert.equal(p.calls[0].dshTool, 'run_code')
  assert.match(p.calls[0].arguments.description, /read_files/)
  assert.match(p.calls[0].arguments.code, /tools\["read"\]/)
  assert.equal(p.nativeCalls.length, 2)
})

test('the program reports one entry per call and swallows individual failures', () => {
  const code = programFor([
    { key: 'read:0', dshTool: 'read', arguments: { file_path: 'a.md' } },
    { key: 'read:1', dshTool: 'read', arguments: { file_path: 'b.md' } },
  ])
  assert.match(code, /^const results = \[\]/)
  assert.match(code, /try \{ results\.push\(\{ ok: true/)
  assert.match(code, /catch \(error\) \{ results\.push\(\{ ok: false/)
  assert.match(code, /LANAGENT-RESULT/)
})

test('parseSentinel finds the payload through any envelope or escaping', () => {
  assert.deepEqual(parseSentinel(`{"logs":[],"result":"<<<LANAGENT-RESULT>>>[{"ok":true}]<<<LANAGENT-END>>>"}`), [{ ok: true }])
  assert.deepEqual(parseSentinel('<<<LANAGENT-RESULT>>>[]<<<LANAGENT-END>>>'), [])
  assert.equal(parseSentinel('no markers here'), undefined)
  assert.equal(parseSentinel('<<<LANAGENT-RESULT>>>not json<<<LANAGENT-END>>>'), undefined)
})

test('a run_code plan shapes structured values with the proven formatters', () => {
  const bash = programPlan('execute_command', { command: 'pwd' })
  const shaped = shapeLoopResults(bash, programResult([{ ok: true, value: { stdout: { text: '/work\n' }, stderr: { text: '' }, exitCode: 0 } }]))
  assert.deepEqual(JSON.parse(textOf(shaped)), { success: true, output: '/work', error: '' })

  const read = programPlan('read_files', { paths: ['a.md', 'b.md'] })
  const mapped = shapeLoopResults(read, programResult([
    { ok: true, value: { lines: [{ number: 1, text: 'A' }], totalLines: 1, offset: 1 } },
    { ok: false, error: 'ENOENT' },
  ]))
  assert.deepEqual(JSON.parse(textOf(mapped)), { 'a.md': 'A', 'b.md': '[读取失败] ENOENT' })

  const grep = programPlan('search_files', { claude_name: 'Grep', pattern: 'x' })
  assert.equal(textOf(shapeLoopResults(grep, programResult([
    { ok: true, value: { matches: [{ path: 'a.ts', lineNumber: 3, line: 'hit' }] } },
  ]))), 'a.ts:3:hit')

  const glob = programPlan('list_files', { path: '.' }, { cwd: '/w' })
  assert.deepEqual(JSON.parse(textOf(shapeLoopResults(glob, programResult([{ ok: true, value: { paths: ['/w/a.ts'] } }]), { cwd: '/w' }))), ['a.ts'])
})

test('a failing program call becomes the vendor error envelope, and a broken payload is reported', () => {
  const bash = programPlan('execute_command', { command: 'pwd' })
  const shaped = shapeLoopResults(bash, programResult([{ ok: false, error: 'ENOENT: no such file' }]))
  assert.match(shaped.error.message, /ENOENT/)

  const broken = shapeLoopResults(bash, results({ run_code: 'the tool produced no markers' }))
  assert.match(broken.error.message, /没有返回可解析的结果/)
})

test('isToolRefusal recognises the PTC collapse so the session can switch style', () => {
  assert.equal(isToolRefusal({ text: 'error: unknown tool "bash"', isError: true }), true)
  assert.equal(isToolRefusal({ text: 'Tool bash is not available in this presentation', isError: true }), true)
  assert.equal(isToolRefusal({ text: 'unknown tool "bash"', isError: false }), false)
  assert.equal(isToolRefusal({ text: '/work', isError: false }), false)
})

test('the PTC announcement in the system prompt is recognised, so no call is wasted', () => {
  const real = 'You are an AI agent powered by DeepSeek Harness.\n\n`run_code` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.'
  assert.equal(looksLikePtcPrompt(real), true)
  assert.equal(looksLikePtcPrompt('run_code is the only tool you can call directly'), true)
  assert.equal(looksLikePtcPrompt('only `run_code` is callable directly'), true)
  assert.equal(looksLikePtcPrompt('You may call every tool, including run_code.'), false)
  assert.equal(looksLikePtcPrompt(''), false)
  assert.equal(looksLikePtcPrompt(undefined), false)
})

test('a refusal is recognised even when the message carries no isError flag', () => {
  // Measured: the refusal reached the adapter as a plain tool message. Trusting
  // the flag alone reshaped it into a successful command output and the vendor
  // retried the same command four times.
  const text = 'Error: unknown tool "bash": only `run_code` is callable directly — call `bash` from inside a `run_code` program instead'
  assert.equal(isToolRefusal({ text, isError: false }), true)
  assert.equal(isToolRefusal({ text, isError: undefined }), true)
  assert.equal(isToolRefusal({ text: 'bash: command not found', isError: true }), false)
  assert.equal(isToolRefusal({ text: 'unknown tool "x"', isError: true }), true)
  assert.equal(isToolRefusal({ text: 'unknown tool "x"', isError: false }), false)
})

test('a refused command is reported as an error, not as output that ran', () => {
  const text = 'Error: unknown tool "bash": only `run_code` is callable directly — call `bash` from inside a `run_code` program instead'
  const shaped = shapeLoopResults(plan('execute_command', { command: 'pwd && ls' }), results({ cmd: { text, isError: false } }))
  assert.equal(shaped.content, undefined, 'no success envelope')
  assert.match(shaped.error.message, /only `run_code` is callable directly/)
})

test('a failed write or edit is never reported as success', () => {
  const write = shapeLoopResults(plan('write_to_file', { path: '/root/x.md', content: 'x' }), results({
    write: { text: "Error: EACCES: permission denied, open '/root/x.md'", isError: false },
  }))
  assert.equal(write.content, undefined)
  assert.match(write.error.message, /EACCES/)

  const diff = ['--- SEARCH', 'o', '===', 'n', '+++ REPLACE'].join('\n')
  const edit = shapeLoopResults(plan('replace_in_file', { path: '/root/x.md', diff }), results({
    'edit:0': { text: 'Error: EACCES: permission denied', isError: false },
  }))
  assert.equal(edit.content, undefined)
  assert.match(edit.error.message, /EACCES/)
})

test('looksLikeErrorText covers the flag and DSH\'s rendered failures', () => {
  assert.equal(looksLikeErrorText({ text: '/work', isError: false }), false)
  assert.equal(looksLikeErrorText({ text: 'Error: boom', isError: false }), true)
  assert.equal(looksLikeErrorText({ text: '', isError: true }), true)
  assert.equal(looksLikeErrorText({ text: 'error: lowercase is command output', isError: false }), false)
})

test('the generated edit program falls back to a tolerant read-patch-write', async () => {
  // This runs the REAL generated source against a fake SDK: `edit` refuses (the
  // way DSH's exact matcher would), so the program must read, patch the matched
  // lines, and write — and report the fallback instead of claiming the edit ran.
  const plan = planVendorCall('replace_in_file', {
    path: 'a.md',
    diff: ['--- SEARCH', 'beta', '===', 'BETA-2', '+++ REPLACE'].join('\n'),
  }, { style: 'run_code' })
  assert.equal(plan.error, undefined)
  const program = plan.calls[0].arguments.code
  const calls = []
  const tools = {
    edit: async () => { throw new Error('SEARCH 块未找到') },
    read: async () => ({ lines: [{ number: 1, text: 'alpha' }, { number: 2, text: 'beta   ' }] }),
    write: async (args) => { calls.push(['write', args]); return { path: args.file_path } },
  }
  const run = new Function('tools', `return (async () => { ${program} })()`)
  const output = await run(tools)
  const payload = JSON.parse(output.slice(output.indexOf('<<<LANAGENT-RESULT>>>') + '<<<LANAGENT-RESULT>>>'.length, output.indexOf('<<<LANAGENT-END>>>')))
  assert.equal(payload[0].ok, true, JSON.stringify(payload))
  assert.equal(payload[0].value.fuzzy, true, 'the fallback is reported, not hidden')
  assert.deepEqual(calls.map(([name]) => name), ['write'])
  assert.equal(calls[0][1].content, 'alpha\nBETA-2')
})

test('the generated program still reports a plain edit when the exact match works', async () => {
  const plan = planVendorCall('replace_in_file', { path: 'a.md', diff: ['--- SEARCH', 'beta', '===', 'BETA-2', '+++ REPLACE'].join('\n') }, { style: 'run_code' })
  const output = await new Function('tools', `return (async () => { ${plan.calls[0].arguments.code} })()`)(
    { edit: async () => ({ ok: true }) },
  )
  const payload = JSON.parse(output.slice(output.indexOf('<<<LANAGENT-RESULT>>>') + '<<<LANAGENT-RESULT>>>'.length, output.indexOf('<<<LANAGENT-END>>>')))
  assert.equal(payload[0].ok, true)
  assert.equal(payload[0].via, 'edit')
  assert.equal(payload[0].value.fuzzy, undefined)
})

test('a bare MCP tool name resolves to its toolbox entry, and an unknown one lists the options', () => {
  // This branch was untested, which is why the bare name reached the program as
  // `tools["browser_navigate"]` and failed with "is not a function".
  const resolved = planVendorCall('use_mcp_tool', {
    server_name: 'dsh_toolbox',
    tool_name: 'browser_navigate',
    arguments: { url: 'https://example.com' },
  }, {
    toolboxName: 'dsh_toolbox',
    style: 'run_code',
    resolveTool: (name) => (name === 'browser_navigate' ? 'mcp__playwright-edge__browser_navigate' : undefined),
    availableTools: ['mcp__playwright-edge__browser_navigate'],
  })
  assert.equal(resolved.error, undefined)
  assert.match(resolved.calls[0].arguments.code, /tools\["mcp__playwright-edge__browser_navigate"\]/)

  const unknown = planVendorCall('use_mcp_tool', { server_name: 'dsh_toolbox', tool_name: 'nope' }, {
    toolboxName: 'dsh_toolbox',
    resolveTool: () => undefined,
    availableTools: ['skill', 'todo_write'],
  })
  assert.match(unknown.error, /没有名为 "nope" 的工具/)
  assert.match(unknown.error, /skill, todo_write/)
})
