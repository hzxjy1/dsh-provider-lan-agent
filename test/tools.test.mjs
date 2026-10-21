import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
/**
 * Offline tests for the tool bridge (`src/tools.js`).
 *
 * A fake `run` stands in for `ctx.tools.execute()`, so every assertion here is
 * about the TRANSLATION: which DSH tool is called, with which arguments, and
 * what text the vendor's model receives back. Both directions matter — a wrong
 * argument shape fails loudly, a wrong result shape quietly teaches the model
 * to misread its own tool output.
 *
 *   node --test test/tools.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { contentText, formatExecuteCommand, formatGrepValue, formatReadValue, parseSearchReplaceBlocks, readMemoryInfo, toWorkspaceRelative } from '../src/tools.js'
import { createToolBridge } from '../src/vendor/bridge.js'
import { VENDOR_MEMORY_ROOT } from '../src/paths.js'

/** Record calls and answer with a canned DSH-shaped result. */
function recorder(answers = {}) {
  const calls = []
  const run = async (name, args, context) => {
    calls.push({ name, args, callId: context?.callId })
    const answer = answers[name]
    if (typeof answer === 'function') return answer(args)
    return answer ?? { isError: false, value: {}, content: [{ type: 'text', text: 'ok' }] }
  }
  return { run, calls }
}

const bridgeFor = (answers, options = {}) => {
  const { run, calls } = recorder(answers)
  const handle = createToolBridge({ run, cwd: '/work', logger: {}, ...options })
  return { handle, calls }
}
const ctx = { signal: new AbortController().signal, callId: 'call-1' }

/* ── diff parsing ───────────────────────────────────────────────────────── */

test('diff: parses the canonical and the alternate marker spellings', () => {
  const canonical = [
    '------- SEARCH',
    'const a = 1;',
    '=======',
    'const a = 2;',
    '+++++++ REPLACE',
  ].join('\n')
  assert.deepEqual(parseSearchReplaceBlocks(canonical), [{ search: 'const a = 1;\n', replace: 'const a = 2;\n' }])

  const alternate = ['<<< SEARCH', 'x', '===', 'y', '>>> REPLACE'].join('\n')
  assert.deepEqual(parseSearchReplaceBlocks(alternate), [{ search: 'x\n', replace: 'y\n' }])
})

test('diff: parses multiple blocks and keeps blank lines', () => {
  const diff = [
    '--- SEARCH',
    'one',
    '',
    'two',
    '===',
    'ONE',
    '+++ REPLACE',
    '--- SEARCH',
    'three',
    '===',
    'THREE',
    '+++ REPLACE',
  ].join('\n')
  const blocks = parseSearchReplaceBlocks(diff)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].search, 'one\n\ntwo\n')
  assert.equal(blocks[0].replace, 'ONE\n')
  assert.equal(blocks[1].search, 'three\n')
})

test('diff: malformed input is reported, not silently applied', () => {
  assert.throws(() => parseSearchReplaceBlocks('--- SEARCH\nno terminator\n'))
  assert.throws(() => parseSearchReplaceBlocks('nothing here'))
  assert.throws(() => parseSearchReplaceBlocks('=== \n+++ REPLACE'))
})

/* ── result shaping ─────────────────────────────────────────────────────── */

test('bash result: stdout, stderr, non-zero exit, timeout, and background', () => {
  const ok = JSON.parse(formatExecuteCommand({ kind: 'foreground', exitCode: 0, stdout: { text: 'hi\n' }, stderr: { text: '' }, timedOut: false, aborted: false }))
  assert.deepEqual(ok, { success: true, output: 'hi', error: '' })

  const both = JSON.parse(formatExecuteCommand({ kind: 'foreground', exitCode: 0, stdout: { text: 'out' }, stderr: { text: 'err' }, timedOut: false, aborted: false }))
  assert.equal(both.output, 'out\nerr')

  const bad = JSON.parse(formatExecuteCommand({ kind: 'foreground', exitCode: 2, stdout: { text: '' }, stderr: { text: 'boom' }, timedOut: false, aborted: false }))
  assert.equal(bad.success, true, 'the vendor reports success even for a non-zero exit')
  assert.match(bad.output, /boom/)
  assert.match(bad.output, /退出码 2/)

  const empty = JSON.parse(formatExecuteCommand({ kind: 'foreground', exitCode: 0, stdout: { text: '' }, stderr: { text: '' }, timedOut: false, aborted: false }))
  assert.equal(empty.output, '命令执行完成，退出码: 0')

  const timed = JSON.parse(formatExecuteCommand({ kind: 'foreground', exitCode: null, stdout: { text: '' }, stderr: { text: '' }, timedOut: true, aborted: false }))
  assert.match(timed.output, /命令超时/)

  assert.match(JSON.parse(formatExecuteCommand({ kind: 'background', jobId: 'job-7' })).output, /job-7/)
  assert.match(JSON.parse(formatExecuteCommand({ kind: 'promoted', jobId: 'job-8', timeoutMs: 1000, output: 'partial' })).output, /job-8/)
})

test('read result: reconstructs bare content and flags truncation', () => {
  const value = { path: 'a.md', offset: 1, totalLines: 2, lines: [{ number: 1, text: 'one' }, { number: 2, text: 'two' }] }
  assert.equal(formatReadValue(value), 'one\ntwo')

  const truncated = { path: 'b.md', offset: 1, totalLines: 99, lines: [{ number: 1, text: 'one' }] }
  assert.match(formatReadValue(truncated), /已截断：文件共 99 行/)
})

test('grep result: ripgrep-style lines and the empty answer', () => {
  assert.equal(formatGrepValue({ matches: [{ path: 'a.md', lineNumber: 7, line: 'hello' }] }), 'a.md:7:hello')
  assert.equal(formatGrepValue({ matches: [] }), 'No matches found')
})

test('paths: absolute paths inside the workspace become relative', () => {
  assert.equal(toWorkspaceRelative('/work/src/a.ts', '/work'), 'src/a.ts')
  assert.equal(toWorkspaceRelative('/elsewhere/a.ts', '/work'), '/elsewhere/a.ts')
  assert.equal(toWorkspaceRelative('/work', '/work'), '.')
})

test('contentText: joins text blocks and ignores the rest', () => {
  assert.equal(contentText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb')
})

/* ── vendor tool → DSH tool ─────────────────────────────────────────────── */

test('read_files: one read per path, answered as a {path: content} map', async () => {
  const { handle, calls } = bridgeFor({
    read: (args) => ({ isError: false, value: { path: args.file_path, offset: 1, totalLines: 1, lines: [{ number: 1, text: `内容:${args.file_path}` }] } }),
  })
  const answer = await handle({ name: 'read_files', block_id: 'b1', arguments: { paths: ['a.md', 'b.md'] } }, ctx)
  assert.deepEqual(calls.map((call) => [call.name, call.args.file_path, call.callId]), [
    ['read', 'a.md', 'call-1:read:0'],
    ['read', 'b.md', 'call-1:read:1'],
  ])
  assert.deepEqual(JSON.parse(answer.content[0].text), { 'a.md': '内容:a.md', 'b.md': '内容:b.md' })
})

test('read_files: a partial failure keeps every success and reports the failed path', async () => {
  const { handle } = bridgeFor({
    read: (args) => (args.file_path === 'b.md'
      ? { isError: true, error: { message: 'ENOENT' } }
      : { isError: false, value: { path: args.file_path, offset: 1, totalLines: 1, lines: [{ number: 1, text: `内容:${args.file_path}` }] } }),
  })
  const answer = await handle({ name: 'read_files', arguments: { paths: ['a.md', 'b.md'] } }, ctx)
  const payload = JSON.parse(answer.content[0].text)
  assert.equal(payload['a.md'], '内容:a.md')
  assert.match(payload['b.md'], /^\[读取失败\] ENOENT$/)
})

test('read_files: a total failure is an error envelope the model can act on', async () => {
  const { handle } = bridgeFor({ read: { isError: true, error: { message: 'ENOENT' } } })
  const answer = await handle({ name: 'read_files', arguments: { paths: ['missing.md'] } }, ctx)
  assert.match(answer.error.message, /missing\.md/)
  assert.match(answer.error.message, /ENOENT/)
  assert.equal(answer.content, undefined)
})

test('the bridge maps vendor paths and shell spellings before dispatch', async () => {
  const mappings = [{ from: VENDOR_MEMORY_ROOT, to: '/work/.lan-agent-memory' }]
  const { handle, calls } = bridgeFor({
    read: { isError: false, value: { lines: [{ number: 1, text: 'x' }], totalLines: 1 } },
    bash: { isError: false, value: { kind: 'foreground', exitCode: 0, stdout: { text: 'x' }, stderr: { text: '' }, timedOut: false, aborted: false } },
  }, { mappings })
  await handle({ name: 'read_files', arguments: { paths: [`${VENDOR_MEMORY_ROOT}/projects/-/memory/MEMORY.md`] } }, ctx)
  assert.equal(calls[0].args.file_path, '/work/.lan-agent-memory/projects/-/memory/MEMORY.md')

  await handle({ name: 'execute_command', arguments: { command: `cat ${VENDOR_MEMORY_ROOT}/notes.md` } }, ctx)
  assert.equal(calls[1].args.command, 'cat /work/.lan-agent-memory/notes.md')
})

test('execute_command: adds the description DSH requires and keeps timeout/workdir', async () => {
  const { handle, calls } = bridgeFor({
    bash: { isError: false, value: { kind: 'foreground', exitCode: 0, stdout: { text: 'ok' }, stderr: { text: '' }, timedOut: false, aborted: false } },
  })
  const answer = await handle({
    name: 'execute_command',
    arguments: { command: 'ls -la\nsecond line', workdir: 'src', timeout: 5000, requires_approval: false, run_in_background: false },
  }, ctx)
  assert.equal(calls[0].name, 'bash')
  assert.equal(calls[0].args.command, 'ls -la\nsecond line')
  assert.equal(calls[0].args.workdir, 'src')
  assert.equal(calls[0].args.timeoutMs, 5000)
  assert.match(calls[0].args.description, /^lanagent 委派: ls -la/)
  assert.equal(calls[0].args.run_in_background, undefined)
  assert.deepEqual(JSON.parse(answer.content[0].text), { success: true, output: 'ok', error: '' })
})

test('execute_command: the dot workdir is dropped so DSH uses the session cwd', async () => {
  const { handle, calls } = bridgeFor({ bash: { isError: false, value: { kind: 'foreground', exitCode: 0, stdout: { text: '' }, stderr: { text: '' }, timedOut: false, aborted: false } } })
  await handle({ name: 'execute_command', arguments: { command: 'pwd', workdir: '.', timeout: 300000 } }, ctx)
  assert.equal(calls[0].args.workdir, undefined)
  assert.equal(calls[0].args.timeoutMs, 300000)
})

test('list_files: recursive flag becomes a glob pattern, answer is a path array', async () => {
  const { handle, calls } = bridgeFor({ glob: { isError: false, value: { root: '/work', paths: ['/work/src/a.ts', '/work/README.md'] } } })
  const answer = await handle({ name: 'list_files', arguments: { path: 'src', recursive: 'true' } }, ctx)
  assert.equal(calls[0].name, 'glob')
  assert.equal(calls[0].args.pattern, 'src/**/*')
  assert.equal(calls[0].args.path, 'src')
  assert.deepEqual(JSON.parse(answer.content[0].text), ['src/a.ts', 'README.md'])
})

test('list_files: an empty result is an empty array, not the rendered words', async () => {
  const { handle } = bridgeFor({ glob: { isError: false, value: { root: '/work', paths: [] }, content: [{ type: 'text', text: 'No files found' }] } })
  const answer = await handle({ name: 'list_files', arguments: { path: '.' } }, ctx)
  assert.deepEqual(JSON.parse(answer.content[0].text), [])
})

test('search_files: Grep maps to grep with include, Glob maps to glob', async () => {
  const grepAnswers = { grep: { isError: false, value: { matches: [{ path: 'a.ts', lineNumber: 3, line: 'hit' }] } } }
  const first = bridgeFor(grepAnswers)
  const grepAnswer = await first.handle({ name: 'search_files', arguments: { claude_name: 'Grep', pattern: 'hit', path: 'src', glob: '*.ts' } }, ctx)
  assert.deepEqual(first.calls[0], { name: 'grep', args: { pattern: 'hit', path: 'src', include: '*.ts' }, callId: 'call-1' })
  assert.equal(grepAnswer.content[0].text, 'a.ts:3:hit')

  const second = bridgeFor({ glob: { isError: false, value: { root: '/work', paths: ['/work/a.ts'] } } })
  const globAnswer = await second.handle({ name: 'search_files', arguments: { claude_name: 'Glob', pattern: '*.ts', path: '.' } }, ctx)
  assert.equal(second.calls[0].name, 'glob')
  assert.deepEqual(JSON.parse(globAnswer.content[0].text), ['a.ts'])
})

test('search_files: the legacy shape still works', async () => {
  const { handle, calls } = bridgeFor({ grep: { isError: false, value: { matches: [] } } })
  const answer = await handle({ name: 'search_files', arguments: { path: 'src', regex: 'TODO', file_pattern: '*.md' } }, ctx)
  assert.deepEqual(calls[0].args, { pattern: 'TODO', path: 'src', include: '*.md' })
  assert.equal(answer.content[0].text, 'No matches found')
})

test('write_to_file: maps to write and answers the bare literal', async () => {
  const { handle, calls } = bridgeFor({ write: { isError: false, value: { path: 'a.md', operation: 'update', before: 'x', after: 'y' } } })
  const answer = await handle({ name: 'write_to_file', arguments: { path: 'a.md', content: 'hello' } }, ctx)
  assert.deepEqual(calls[0], { name: 'write', args: { file_path: 'a.md', content: 'hello' }, callId: 'call-1' })
  assert.equal(answer.content[0].text, 'success')
})

test('replace_in_file: each block becomes one edit with literal old/new strings', async () => {
  const diff = ['--- SEARCH', 'old-1', '===', 'new-1', '+++ REPLACE', '--- SEARCH', 'old-2', '===', 'new-2', '+++ REPLACE'].join('\n')
  const { handle, calls } = bridgeFor({ edit: { isError: false, value: { path: 'a.md' } } }, { documents: { 'a.md': 'old-1\nold-2\n' } })
  const answer = await handle({ name: 'replace_in_file', arguments: { path: 'a.md', diff } }, ctx)
  assert.deepEqual(calls.map((call) => call.args), [
    { file_path: 'a.md', old_string: 'old-1', new_string: 'new-1' },
    { file_path: 'a.md', old_string: 'old-2', new_string: 'new-2' },
  ])
  assert.equal(answer.content[0].text, 'success')
})

test('replace_in_file: whitespace tolerance is resolved at plan time, before any edit', async () => {
  const diff = ['--- SEARCH', 'tail', '===', 'done', '+++ REPLACE'].join('\n')
  const { handle, calls } = bridgeFor(
    { edit: { isError: false, value: { path: 'a.md' } } },
    { documents: { 'a.md': 'head\ntail   \n' } },
  )
  const answer = await handle({ name: 'replace_in_file', arguments: { path: 'a.md', diff } }, ctx)
  assert.deepEqual(calls.map((call) => call.args), [
    { file_path: 'a.md', old_string: 'tail   ', new_string: 'done' },
  ])
  assert.equal(answer.content[0].text, 'success')

  // A block that exists nowhere is refused with the vendor's guidance, and no
  // edit is attempted.
  const failing = bridgeFor({ edit: { isError: false, value: {} } }, { documents: { 'a.md': 'other\n' } })
  const failed = await failing.handle({ name: 'replace_in_file', arguments: { path: 'a.md', diff } }, ctx)
  assert.equal(failing.calls.length, 0)
  assert.match(failed.error.message, /SEARCH 内容必须与文件完全一致/)
})

test('use_mcp_tool: becomes the DSH mcp__server__tool name', async () => {
  const { handle, calls } = bridgeFor({ mcp__serial__list_ports: { isError: false, content: [{ type: 'text', text: 'COM41' }] } })
  const answer = await handle({ name: 'use_mcp_tool', arguments: { server_name: 'serial', tool_name: 'list_ports', arguments: {} } }, ctx)
  assert.equal(calls[0].name, 'mcp__serial__list_ports')
  assert.equal(answer.content[0].text, 'COM41')
})

test('get_environment_info: answered locally, without a DSH tool call', async () => {
  const { handle, calls } = bridgeFor({}, {
    localAnswer: async () => ({ content: [{ type: 'text', text: JSON.stringify({ cwd: '/work', os: 'linux', repoInfo: {} }) }] }),
  })
  const answer = await handle({ name: 'get_environment_info', arguments: {} }, ctx)
  assert.equal(calls.length, 0)
  const payload = JSON.parse(answer.content[0].text)
  assert.equal(payload.cwd, '/work')
  assert.equal(typeof payload.os, 'string')
  assert.equal(typeof payload.repoInfo, 'object')
})

test('run_code: a program requested by name is forwarded to DSH and its output returned', async () => {
  const { handle, calls } = bridgeFor({
    run_code: { isError: false, value: { logs: ['42'], result: 42 }, content: [{ type: 'text', text: '42' }] },
  })
  const answer = await handle({ name: 'run_code', arguments: { code: 'return 42', description: 'answer' } }, ctx)
  assert.deepEqual(calls[0], { name: 'run_code', args: { code: 'return 42', description: 'answer' }, callId: 'call-1' })
  assert.equal(answer.content[0].text, '42')

  const missing = await handle({ name: 'run_code', arguments: {} }, ctx)
  assert.match(missing.error.message, /缺少 code 参数/)

  const defaulted = bridgeFor({ run_code: { isError: false, value: {}, content: [{ type: 'text', text: 'x' }] } })
  await defaulted.handle({ name: 'run_code', arguments: { code: 'return 1' } }, ctx)
  assert.equal(defaulted.calls[0].args.description.length > 0, true, 'run_code requires a description')
})

test('a DSH tool name is passed straight through with its arguments untouched', async () => {
  // The injected system prompt declares `bash`/`read`/… , so the vendor's model
  // may use DSH's vocabulary instead of its own. Refusing those names is what
  // made a live session report that it had no way to run anything.
  const { handle, calls } = bridgeFor({ bash: { isError: false, value: { kind: 'foreground' }, content: [{ type: 'text', text: '/home/user/.dsh' }] } })
  const answer = await handle({ name: 'bash', arguments: { command: 'pwd', description: 'Show cwd' } }, ctx)
  assert.deepEqual(calls[0], { name: 'bash', args: { command: 'pwd', description: 'Show cwd' }, callId: 'call-1' })
  assert.equal(answer.content[0].text, '/home/user/.dsh')
})

test('an MCP tool name is passed straight through', async () => {
  const { handle, calls } = bridgeFor({ mcp__serial__list_ports: { isError: false, content: [{ type: 'text', text: 'COM41' }] } })
  const answer = await handle({ name: 'mcp__serial__list_ports', arguments: {} }, ctx)
  assert.equal(calls[0].name, 'mcp__serial__list_ports')
  assert.equal(answer.content[0].text, 'COM41')
})

test('a name in neither vocabulary is still refused, and says which it is', async () => {
  const { handle, calls } = bridgeFor({})
  const answer = await handle({ name: 'frobnicate', arguments: {} }, ctx)
  assert.equal(calls.length, 0)
  assert.match(answer.error.message, /frobnicate/)
  assert.match(answer.error.message, /既不是 厂商内置工具/)
})

test('the audit hook records every request, including refusals that never reach DSH', async () => {
  const records = []
  const { run } = recorder({
    bash: { isError: false, value: {}, content: [{ type: 'text', text: 'ok' }] },
    read: { isError: true, error: { message: 'ENOENT: no such file' } },
  })
  const handle = createToolBridge({ run, cwd: '/work', logger: {}, audit: (record) => records.push(record) })
  await handle({ name: 'bash', arguments: { command: 'pwd', description: 'd' } }, ctx)
  await handle({ name: 'frobnicate', arguments: { x: 1 } }, ctx)
  await handle({ name: 'read_files', arguments: { paths: ['missing'] } }, ctx)
  assert.equal(records.length, 3)
  assert.deepEqual(records[0].name, 'bash')
  assert.equal(records[0].ok, true)
  assert.equal(records[1].ok, false)
  assert.match(records[1].detail, /不可用/)
  assert.equal(records[2].ok, false, 'a tool failure is audited as a failure')
  assert.match(records[2].detail, /ENOENT/)
  // The panel needs more than a verdict: what ran, how long, and a summary.
  assert.equal(typeof records[0].durationMs, 'number')
  assert.equal(records[0].durationMs >= 0, true)
  assert.equal(records[0].dshTool, 'bash', 'the audit names the DSH tool that ran')
  assert.match(records[0].summary, /ok/, 'the successful answer is summarized')
  assert.equal(records[2].summary, undefined, 'failures carry detail instead of a summary')

  // The dispatcher fills route/dshTool through the per-call meta.
  const meta = {}
  const withMeta = createToolBridge({
    run: recorder({ bash: { isError: false, value: {}, content: [{ type: 'text', text: 'x' }] } }).run,
    cwd: '/work',
    logger: {},
    audit: (record) => records.push(record),
  })
  await withMeta({ name: 'bash', arguments: { command: 'pwd', description: 'd' } }, { ...ctx, meta })
  assert.equal(records.at(-1).dshTool, 'bash')
})

test('use_mcp_tool into the synthetic toolbox calls the DSH tool by name', async () => {
  const { handle, calls } = bridgeFor({ bash: { isError: false, value: { kind: 'foreground' }, content: [{ type: 'text', text: 'done' }] } })
  const answer = await handle({ name: 'use_mcp_tool', arguments: { server_name: 'dsh_toolbox', tool_name: 'bash', arguments: { command: 'pwd', description: 'd' } } }, ctx)
  assert.equal(calls[0].name, 'bash', 'no mcp__ prefix: the toolbox declares plain DSH names')
  assert.equal(answer.content[0].text, 'done')
})

test('use_mcp_tool into a real MCP server still maps to mcp__server__tool', async () => {
  const { handle, calls } = bridgeFor({ mcp__serial__list_ports: { isError: false, content: [{ type: 'text', text: 'COM41' }] } })
  await handle({ name: 'use_mcp_tool', arguments: { server_name: 'serial', tool_name: 'list_ports', arguments: {} } }, ctx)
  assert.equal(calls[0].name, 'mcp__serial__list_ports')
})

test('unknown tools and DSH failures both answer with a readable error', async () => {
  const { handle } = bridgeFor({})
  const unknown = await handle({ name: 'ask_followup_question' }, ctx)
  assert.match(unknown.error.message, /ask_followup_question/)

  const failing = bridgeFor({ write: { isError: true, error: { message: 'permission denied' } } })
  const failed = await failing.handle({ name: 'write_to_file', arguments: { path: 'a', content: 'b' } }, ctx)
  assert.match(failed.error.message, /permission denied/)
})

test('the skill loader and the web tools pass through to DSH', async () => {
  // A skill's instructions only reach the vendor through this path: DSH injects
  // the catalog, and the tool call is what loads one.
  const seen = []
  const bridge = createToolBridge({
    run: async (name, args) => { seen.push([name, args]); return { isError: false, value: { content: 'skill body' }, content: [{ type: 'text', text: 'skill body' }] } },
    cwd: '/work',
    logger: {},
  })
  for (const [name, args] of [['skill', { name: 'rosemary' }], ['web_fetch', { url: 'https://x/y.pdf' }], ['web_search', { queries: ['a'] }]]) {
    const answer = await bridge({ name, arguments: args })
    assert.equal(answer.error, undefined, `${name} was refused: ${JSON.stringify(answer.error)}`)
  }
  assert.deepEqual(seen.map(([name]) => name), ['skill', 'web_fetch', 'web_search'])
})

test('the preflight reports where the vendor memory really lives, and its content', async () => {
  const root = join(mkdtempSync(join(tmpdir(), 'lanagent-mem-')), 'memory')
  mkdirSync(join(root, 'abc123'), { recursive: true })
  writeFileSync(join(root, 'MEMORY.md'), '# Memory\npnpm only\n', 'utf8')
  writeFileSync(join(root, 'abc123', 'session_notes.md'), '# Notes\ndone\n', 'utf8')
  const info = await readMemoryInfo(root)
  assert.equal(info.path, root)
  assert.match(info.content, /pnpm only/)
  assert.match(info.notes, /done/)
  // An absent directory is an honestly empty memory, not an error.
  assert.deepEqual(await readMemoryInfo(join(root, 'nope')), { path: join(root, 'nope'), content: '', notes: '' })
  assert.deepEqual(await readMemoryInfo(''), { path: '', content: '', notes: '' })
})
