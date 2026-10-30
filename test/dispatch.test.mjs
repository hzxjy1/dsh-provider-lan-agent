/**
 * Offline tests for the dispatch layer (`src/dispatch.js`).
 *
 * The behaviour that matters is the `ptc` case: DSH refuses every direct call
 * except `run_code`, so the bridge has to notice the refusal and re-issue the
 * call as a program. These tests simulate both registries (direct and PTC) and
 * also execute the generated program for real, so "valid JavaScript that calls
 * the right tool with the right arguments" is proven rather than assumed.
 *
 *   node --test test/dispatch.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { DispatchMode, createToolDispatcher, isDirectDispatchRefusal, programFor } from '../src/dispatch.js'

const PTC_REFUSAL = (name) => ({
  isError: true,
  error: {
    message: `unknown tool "${name}": only \`run_code\` is callable directly — call \`${name}\` from inside a \`run_code\` program instead`,
    info: { name, code: 'UNKNOWN_TOOL' },
  },
  content: [{ type: 'text', text: `unknown tool "${name}"` }],
})

/**
 * Pull the one tool call out of a generated program.
 *
 * Brace-matched rather than regexed: the argument map is JSON and may itself
 * contain parentheses, quotes, and escaped characters.
 *
 * @param {string} program
 * @returns {{name: string, args: unknown}|null}
 */
function extractProgramCall(program) {
  const head = /tools\[("(?:[^"\\]|\\.)*")\]\(/.exec(program)
  if (head === null) return null
  const open = head.index + head[0].length - 1
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = open; i < program.length; i += 1) {
    const ch = program[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return { name: JSON.parse(head[1]), args: JSON.parse(program.slice(open + 1, i)) }
    }
  }
  return null
}

/**
 * A fake registry with the two presentations.
 *
 * @param {object} options
 * @param {'direct'|'ptc'} [options.mode]
 * @param {Record<string, unknown>} [options.values] canonical values per tool.
 * @param {boolean} [options.runCodeFails]
 * @param {string} [options.innerError] make the program's tool call reject.
 */
function createRegistry({ mode = 'direct', values = {}, runCodeFails = false, innerError } = {}) {
  const calls = []
  return {
    calls,
    async execute({ name, arguments: args }) {
      calls.push({ name, args })
      if (name === 'run_code') {
        if (runCodeFails) {
          return { isError: true, error: { message: 'CODE_RUN_FAILED: substrate died' }, content: [] }
        }
        const parsed = extractProgramCall(String(args?.code ?? ''))
        // A raw program (an explicit run_code request) has no generated tool
        // call to extract; it simply runs and returns whatever it returns.
        if (parsed === null) {
          return { isError: false, value: { logs: [], result: null }, content: [{ type: 'text', text: '(program ran)' }] }
        }
        const { name: innerName, args: innerArgs } = parsed
        calls.push({ name: innerName, args: innerArgs, nested: true })
        const result = innerError === undefined
          ? { ok: true, value: values[innerName] ?? { ran: innerName } }
          : { ok: false, message: innerError, toolName: innerName }
        return {
          isError: false,
          value: { logs: ['program output'], result },
          content: [{ type: 'text', text: 'program output' }],
        }
      }
      if (mode === 'ptc') return PTC_REFUSAL(name)
      return { isError: false, value: values[name] ?? { ran: name }, content: [{ type: 'text', text: 'ok' }] }
    },
  }
}

const context = { signal: new AbortController().signal, callId: 'call-1' }
const NAMES = (calls) => calls.map((call) => call.name)

test('the generated program is real JavaScript that calls the named tool with the given arguments', async () => {
  const program = programFor('read', { file_path: 'a"b\nc', offset: 1 })
  // eslint-disable-next-line no-new-func -- executing the generated program IS the assertion
  const run = new Function('tools', `return (async () => {\n${program}\n})()`)
  const seen = []
  const outcome = await run({ read: async (args) => { seen.push(args); return { lines: [] } } })
  assert.deepEqual(seen, [{ file_path: 'a"b\nc', offset: 1 }])
  assert.deepEqual(outcome, { ok: true, value: { lines: [] } })
})

test('the generated program reports a failing tool instead of failing the program', async () => {
  const run = new Function('tools', `return (async () => {\n${programFor('read', {})}\n})()`)
  const outcome = await run({
    read: async () => { throw Object.assign(new Error('ENOENT: no such file'), { toolName: 'read' }) },
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.toolName, 'read')
  assert.match(outcome.message, /ENOENT/)
})

test('refusal detection reads the registry code, not the message', () => {
  assert.equal(isDirectDispatchRefusal(PTC_REFUSAL('bash')), true)
  assert.equal(isDirectDispatchRefusal({ isError: true, error: { message: 'boom' } }), false)
  assert.equal(isDirectDispatchRefusal({ isError: true, error: { info: { code: 'TOOL_ERROR' } } }), false)
  assert.equal(isDirectDispatchRefusal({ isError: false, value: {} }), false)
})

test('a direct session dispatches directly and never builds a program', async () => {
  const registry = createRegistry({ mode: 'direct', values: { bash: { kind: 'foreground', exitCode: 0 } } })
  const dispatch = createToolDispatcher({ tools: registry, mode: DispatchMode.auto })
  const result = await dispatch('bash', { command: 'pwd', description: 'd' }, context)
  assert.deepEqual(NAMES(registry.calls), ['bash'])
  assert.deepEqual(result.value, { kind: 'foreground', exitCode: 0 })
})

test('a PTC session falls back to run_code, remembers the route, and returns the inner value', async () => {
  const registry = createRegistry({ mode: 'ptc', values: { bash: { kind: 'foreground', exitCode: 0, stdout: { text: '/work' } } } })
  const routes = new Map()
  const dispatch = createToolDispatcher({ tools: registry, mode: DispatchMode.auto, routes, sessionKey: 's1' })
  const result = await dispatch('bash', { command: 'pwd', description: 'd' }, context)
  assert.deepEqual(NAMES(registry.calls), ['bash', 'run_code', 'bash'], 'refused, then dispatched inside a program')
  assert.deepEqual(result.value, { kind: 'foreground', exitCode: 0, stdout: { text: '/work' } }, 'the inner canonical value survives')
  assert.equal(routes.get('s1'), DispatchMode.runCode)

  // The remembered route skips the doomed direct attempt.
  registry.calls.length = 0
  await dispatch('bash', { command: 'pwd', description: 'd' }, context)
  assert.deepEqual(NAMES(registry.calls), ['run_code', 'bash'])
})

test('the remembered route is per session', async () => {
  const registry = createRegistry({ mode: 'direct' })
  const routes = new Map([[ 'ptc-session', DispatchMode.runCode ]])
  const dispatch = createToolDispatcher({ tools: registry, mode: DispatchMode.auto, routes, sessionKey: 'direct-session' })
  await dispatch('glob', { pattern: '*' }, context)
  assert.deepEqual(NAMES(registry.calls), ['glob'])
})

test('pinning run_code goes through a program even in a direct session', async () => {
  const registry = createRegistry({ mode: 'direct', values: { grep: { matches: [] } } })
  const dispatch = createToolDispatcher({ tools: registry, mode: DispatchMode.runCode })
  const result = await dispatch('grep', { pattern: 'x' }, context)
  assert.deepEqual(NAMES(registry.calls), ['run_code', 'grep'])
  assert.deepEqual(result.value, { matches: [] })
})

test('pinning direct never falls back, even when the session refuses', async () => {
  const registry = createRegistry({ mode: 'ptc' })
  const dispatch = createToolDispatcher({ tools: registry, mode: DispatchMode.direct })
  const result = await dispatch('bash', { command: 'pwd', description: 'd' }, context)
  assert.deepEqual(NAMES(registry.calls), ['bash'])
  assert.equal(result.isError, true)
  assert.match(result.error.message, /only `run_code` is callable directly/)
})

test('a failing tool inside the program becomes a tool error, not a program error', async () => {
  const registry = createRegistry({ mode: 'ptc', innerError: 'ENOENT: no such file' })
  const dispatch = createToolDispatcher({ tools: registry, mode: DispatchMode.auto })
  const result = await dispatch('read', { file_path: 'missing' }, context)
  assert.equal(result.isError, true)
  assert.match(result.error.message, /ENOENT/)
  assert.equal(result.error.info.code, 'PTC_TOOL_CALL_FAILED')
})

test('a program-level failure passes through unchanged', async () => {
  const registry = createRegistry({ mode: 'ptc', runCodeFails: true })
  const dispatch = createToolDispatcher({ tools: registry, mode: DispatchMode.auto })
  const result = await dispatch('bash', { command: 'pwd', description: 'd' }, context)
  assert.equal(result.isError, true)
  assert.match(result.error.message, /CODE_RUN_FAILED/)
})

test('a program envelope carries the configured wall clock', async () => {
  // DSH defaults the program to 120s and the deadline covers the nested call:
  // without this, a bridged command that runs past two minutes is killed by the
  // transport while the vendor is still waiting for it.
  const registry = createRegistry({ mode: 'ptc' })
  const dispatch = createToolDispatcher({ tools: registry, mode: DispatchMode.auto, programTimeoutMs: 360_000 })
  await dispatch('bash', { command: 'sleep 200', description: 'd' }, context)
  assert.deepEqual(NAMES(registry.calls), ['bash', 'run_code', 'bash'])
  assert.equal(registry.calls[1].args.timeoutMs, 360_000)

  const bare = createRegistry({ mode: 'ptc' })
  const unbudgeted = createToolDispatcher({ tools: bare, mode: DispatchMode.auto })
  await unbudgeted('bash', { command: 'pwd', description: 'd' }, context)
  assert.equal('timeoutMs' in bare.calls[1].args, false, 'no configured budget: let DSH default it')
})

test('an explicit run_code request is never wrapped in another run_code program', async () => {
  const registry = createRegistry({ mode: 'ptc' })
  const dispatch = createToolDispatcher({ tools: registry, mode: DispatchMode.auto })
  await dispatch('run_code', { code: 'return 1', description: 'd' }, context)
  assert.deepEqual(NAMES(registry.calls), ['run_code'])
})

test('the dispatcher records the DSH tool and the chosen route into the per-call meta', async () => {
  // The audit panel renders these two fields; they are the dispatcher's answer
  // to "what actually ran, and by which route".
  const directRegistry = createRegistry({ mode: 'direct' })
  const directMeta = {}
  await createToolDispatcher({ tools: directRegistry, mode: DispatchMode.auto })('bash', { command: 'pwd', description: 'd' }, { ...context, meta: directMeta })
  assert.equal(directMeta.dshTool, 'bash')
  assert.equal(directMeta.route, DispatchMode.direct)

  const ptcRegistry = createRegistry({ mode: 'ptc' })
  const ptcMeta = {}
  await createToolDispatcher({ tools: ptcRegistry, mode: DispatchMode.auto, routes: new Map(), sessionKey: 's' })('bash', { command: 'pwd', description: 'd' }, { ...context, meta: ptcMeta })
  assert.equal(ptcMeta.dshTool, 'bash')
  assert.equal(ptcMeta.route, DispatchMode.runCode)
})

test('the dispatcher forwards the agent, so approvals and PTC logging have an owner', async () => {
  const seen = []
  const tools = {
    async execute(input) {
      seen.push(input)
      return { isError: false, value: {}, content: [] }
    },
  }
  const agent = { id: 'session-1' }
  const dispatch = createToolDispatcher({ tools, agent, mode: DispatchMode.direct })
  await dispatch('glob', { pattern: '*' }, context)
  assert.equal(seen[0].agent, agent)
  assert.equal(seen[0].callId, 'call-1')
  assert.equal(seen[0].name, 'glob')
})
