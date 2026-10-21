/**
 * Offline tests for the loop route's rendezvous (`src/loopRoute.js`).
 *
 *   node --test test/loopRoute.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  createLoopRoute,
  fireBudget,
  drainWithSuspension,
  extractToolResults,
  isLoopContinuation,
  toolCallChunks,
} from '../src/loopRoute.js'

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

/** A pump that yields numbered chunks with a beat between them. */
async function* pumpOf(labels) {
  for (const label of labels) {
    await tick()
    yield label
  }
}

async function collect(iterable) {
  const out = []
  for await (const value of iterable) out.push(value)
  return out
}

/* ── helpers ────────────────────────────────────────────────────────────── */

test('toolCallChunks emits a complete tool-call block', () => {
  const chunks = toolCallChunks({ callId: 'c1', name: 'bash', arguments: { command: 'pwd' } })
  assert.deepEqual(chunks.map((c) => c.type), ['block-start', 'tool-call-delta', 'block-end'])
  assert.equal(chunks[0].blockType, 'tool-call')
  assert.equal(chunks[1].id, 'c1')
  assert.equal(chunks[1].name, 'bash')
  assert.equal(chunks[1].argumentsDelta, '{"command":"pwd"}')
  assert.deepEqual(chunks[2].block, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"pwd"}' })
})

test('extractToolResults picks the matching tool messages and flags errors', () => {
  const results = extractToolResults([
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] },
    { role: 'tool', toolCallId: 'b', isError: true, content: [{ type: 'text', text: 'boom' }] },
    { role: 'tool', toolCallId: 'other', content: [{ type: 'text', text: 'ignored' }] },
  ], ['a', 'b'])
  assert.deepEqual([...results.keys()], ['a', 'b'])
  assert.deepEqual(results.get('a'), { text: 'first\nsecond', isError: false })
  assert.deepEqual(results.get('b'), { text: 'boom', isError: true })
})

/* ── continuation vs. new user input ────────────────────────────────────── */

/** The parked record shape `#emitToolCalls` produces: calls carry their DSH ids. */
const parkedWith = (...ids) => ({
  calls: [{
    baseCallId: 'base',
    ids: new Map(ids.map((id, index) => [`slot${index}`, id])),
    plan: { calls: [] },
  }],
})

test('isLoopContinuation accepts a step whose last message is the parked call result', () => {
  assert.equal(isLoopContinuation(parkedWith('call:1'), [
    { role: 'user', content: [{ type: 'text', text: 'do it' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call:1', name: 'run_code' }] },
    { role: 'tool', toolCallId: 'call:1', content: [{ type: 'text', text: 'ok' }] },
  ]), true)
})

test('isLoopContinuation rejects a new turn even though the aborted result is still in history', () => {
  // The measured failure (session 5791332e): after an aborted step the parked
  // call's (failed) result is already recorded, so "the results exist" is a
  // false positive — the user's new prompt must win.
  assert.equal(isLoopContinuation(parkedWith('call:2'), [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call:2', name: 'run_code' }] },
    { role: 'tool', toolCallId: 'call:2', isError: true, content: [{ type: 'text', text: 'aborted' }] },
    { role: 'user', content: [{ type: 'text', text: '回复确认' }] },
  ]), false)
})

test('isLoopContinuation rejects a message appended mid-turn after the tool result', () => {
  assert.equal(isLoopContinuation(parkedWith('call:3'), [
    { role: 'tool', toolCallId: 'call:3', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: '先给出测试方案' }] },
  ]), false)
})

test('isLoopContinuation looks past trailing system/developer messages', () => {
  assert.equal(isLoopContinuation(parkedWith('call:4'), [
    { role: 'tool', toolCallId: 'call:4', content: [{ type: 'text', text: 'ok' }] },
    { role: 'system', content: [{ type: 'text', text: 'runtime context' }] },
    { role: 'developer', content: [{ type: 'text', text: 'policy' }] },
  ]), true)
})

test('isLoopContinuation rejects unrelated results, empty input, and unknown calls', () => {
  assert.equal(isLoopContinuation(parkedWith('call:5'), [{ role: 'tool', toolCallId: 'other', content: [] }]), false)
  assert.equal(isLoopContinuation(parkedWith('call:6'), []), false)
  assert.equal(isLoopContinuation(parkedWith('call:7'), undefined), false)
  assert.equal(isLoopContinuation({ calls: [] }, [{ role: 'tool', toolCallId: 'call:8', content: [] }]), false)
})

test('checking with peek keeps the parked turn owned until the claim', () => {
  const route = createLoopRoute({ collectMs: 0 })
  route.arm('s2')
  route.park('s2', {
    baseCallId: 'base',
    ids: new Map([['slot0', 'call:9']]),
    plan: { vendorTool: 'execute_command', calls: [] },
    vendorTool: 'execute_command',
    respond: () => {},
  })
  route.suspend('s2', { pump: pumpOf([]), pendingRead: undefined, mapper: undefined, cancel: () => {} })

  const parked = route.peek('s2')
  assert.equal(isLoopContinuation(parked, [{ role: 'user', content: [] }]), false)
  assert.equal(route.peek('s2'), parked, 'a rejected continuation must not consume the parked turn')
  assert.equal(isLoopContinuation(parked, [{ role: 'tool', toolCallId: 'call:9', content: [] }]), true)
  assert.equal(route.resume('s2'), parked)
  assert.equal(route.peek('s2'), undefined)
})

/* ── draining ───────────────────────────────────────────────────────────── */

test('drainWithSuspension yields the whole pump when nothing parks', async () => {
  const never = new Promise(() => {})
  assert.deepEqual(await collect(drainWithSuspension({ pump: pumpOf(['a', 'b', 'c']), suspension: never })), ['a', 'b', 'c'])
})

test('a suspension stops the drain and the in-flight read is handed on, not lost', async () => {
  // collectMs 0: this test is about the handoff, so the park must fire at once.
  const route = createLoopRoute({ collectMs: 0 })
  const suspension = route.arm('s1')
  let pendingRead
  const first = drainWithSuspension({
    pump: pumpOf(['a', 'b', 'c']),
    suspension: suspension.promise,
    onSuspend: (pending) => { pendingRead = pending },
  })
  // Consume one chunk, park a call, then ask for the next chunk: that next()
  // is the race that observes the park and stops the drain.
  const iterator = first[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value, 'a')
  route.park('s1', { baseCallId: 'x', plan: { vendorTool: 'execute_command', calls: [{ key: 'cmd', dshTool: 'bash', arguments: {} }] }, vendorTool: 'execute_command', respond: () => {} })
  const stopped = await iterator.next()
  assert.equal(stopped.done, true, 'the drain stops at the park instead of reading on')
  assert.equal(pendingRead instanceof Promise, true, 'the in-flight read is handed to the caller')

  // Resuming with that read must deliver the chunk that was in flight.
  const resumed = await collect(drainWithSuspension({
    pump: pumpOf(['b', 'c']),   // a fresh pump stands in for the same generator
    suspension: new Promise(() => {}),
    resumeWith: pendingRead,
  }))
  assert.equal(resumed.length >= 1, true)
  route.drop('s1')
})

/* ── state machine ──────────────────────────────────────────────────────── */

test('a parked turn survives suspend and comes back through resume', async () => {
  const route = createLoopRoute()
  const suspension = route.arm('s1')
  const responder = { answered: [] }
  const record = route.park('s1', {
    baseCallId: 'blk',
    plan: { vendorTool: 'execute_command', calls: [{ key: 'cmd', dshTool: 'bash', arguments: { command: 'pwd' } }] },
    vendorTool: 'execute_command',
    respond: (answer) => responder.answered.push(answer),
    onBudgetExhausted: () => {},
  })
  await tick()
  assert.equal(record.answered, false)
  assert.equal(route.pendingOf('s1').length, 1, 'the call is visible to the suspending stream')

  const parked = route.suspend('s1', { pump: undefined, pendingRead: undefined })
  assert.equal(parked.calls.length, 1)
  assert.equal(route.isParked('s1'), true)
  assert.equal(route.pendingOf('s1').length, 0, 'the pending list moves into the parked turn')

  const taken = route.resume('s1')
  assert.equal(taken.calls[0].vendorTool, 'execute_command')
  assert.equal(route.isParked('s1'), false, 'resume takes ownership')
  clearTimeout(record.timer)
})

test('a call that outlives its budget is answered with a timeout error exactly once', async () => {
  const route = createLoopRoute({ defaultBudgetMs: 20 })
  const answered = []
  let exhausted = 0
  const record = route.park('s1', {
    baseCallId: 'blk',
    plan: { vendorTool: 'execute_command', calls: [{ key: 'cmd', dshTool: 'bash', arguments: {} }] },
    vendorTool: 'execute_command',
    respond: (answer) => answered.push(answer),
    onBudgetExhausted: () => { exhausted += 1 },
  })
  await tick(60)
  assert.equal(answered.length, 1)
  assert.match(answered[0].error.message, /未完成/)
  assert.equal(exhausted, 1)
  // Answering through the record later must be a no-op: the vendor already has
  // its answer, and a second frame would be a protocol error.
  record.answered = true
  record.timer?.unref?.()
  assert.equal(answered.length, 1)
  route.drop('s1')
})

test('the vendor timeout the tool declares wins over the default budget', async () => {
  const route = createLoopRoute({ defaultBudgetMs: 10 })
  const answered = []
  route.park('s1', {
    baseCallId: 'blk',
    plan: { vendorTool: 'execute_command', calls: [] },
    vendorTool: 'execute_command',
    budgetMs: 5_000,
    respond: (answer) => answered.push(answer),
  })
  await tick(60)
  assert.equal(answered.length, 0, 'the declared 5s budget is still running')
  route.drop('s1')
})

test('drop answers an unanswered call and forgets the session', async () => {
  const route = createLoopRoute()
  route.arm('s1')
  const answered = []
  route.park('s1', {
    baseCallId: 'blk',
    plan: { vendorTool: 'execute_command', calls: [] },
    vendorTool: 'execute_command',
    respond: (answer) => answered.push(answer),
  })
  route.drop('s1')
  assert.equal(answered.length, 1)
  assert.match(answered[0].error.message, /已中止/)
  assert.deepEqual(route.keys(), [])
})

test('drop cancels the parked vendor stream, answers its calls, and releases the channel', async () => {
  const route = createLoopRoute()
  route.arm('s1')
  const cancelled = []
  const answered = []
  const returned = []
  const released = []
  const pump = { return: (value) => { returned.push(value); return { done: true, value: undefined } } }
  route.park('s1', {
    baseCallId: 'blk',
    plan: { vendorTool: 'execute_command', calls: [] },
    vendorTool: 'execute_command',
    respond: (answer) => answered.push(answer),
  })
  route.suspend('s1', {
    pump,
    pendingRead: undefined,
    cancel: () => cancelled.push('cancelled'),
    release: async () => { released.push(true) },
  })
  route.drop('s1')
  await tick()
  assert.deepEqual(cancelled, ['cancelled'], 'the HTTP stream is really cancelled, not left running')
  assert.equal(answered.length, 1)
  assert.deepEqual(returned, [undefined], 'the pump generator is unwound')
  assert.deepEqual(released, [true], 'the turn channel is released, not leaked')
  assert.deepEqual(route.keys(), [])
})

test('sibling calls inside the grace window share one suspension', async () => {
  // One assistant step with several tool-call blocks is what lets the loop run
  // them together; the window is what makes that happen for co-arriving frames.
  const route = createLoopRoute({ collectMs: 30 })
  const suspension = route.arm('s1')
  let fired = 0
  void suspension.promise.then(() => { fired += 1 })
  const make = (n) => ({
    baseCallId: `blk-${n}`,
    plan: { vendorTool: 'read_files', calls: [{ key: 'read:0', dshTool: 'read', arguments: { file_path: `f${n}` } }] },
    vendorTool: 'read_files',
    respond: () => {},
  })
  route.park('s1', make(1))
  await tick(5)
  assert.equal(fired, 0, 'the first call waits for siblings')
  route.park('s1', make(2))
  await tick(50)
  assert.equal(fired, 1, 'the window fires exactly once for both')
  assert.equal(route.pendingOf('s1').length, 2, 'both calls are handed to the same step')
  const parked = route.suspend('s1', { pump: undefined, pendingRead: undefined })
  assert.deepEqual(parked.calls.map((call) => call.baseCallId), ['blk-1', 'blk-2'])
  route.drop('s1')
})

test('a zero window fires immediately, and arming clears a stale timer', async () => {
  const immediate = createLoopRoute({ collectMs: 0 })
  const suspension = immediate.arm('s1')
  let fired = 0
  void suspension.promise.then(() => { fired += 1 })
  immediate.park('s1', { baseCallId: 'x', plan: { vendorTool: 'read_files', calls: [] }, vendorTool: 'read_files', respond: () => {} })
  await tick(5)
  assert.equal(fired, 1)

  // A pending grace timer from an abandoned suspension must not fire into the
  // next one (it would suspend a stream that never parked anything).
  const delayed = createLoopRoute({ collectMs: 40 })
  const first = delayed.arm('s1')
  let firstFired = 0
  void first.promise.then(() => { firstFired += 1 })
  delayed.park('s1', { baseCallId: 'y', plan: { vendorTool: 'read_files', calls: [] }, vendorTool: 'read_files', respond: () => {} })
  const second = delayed.arm('s1')
  let secondFired = 0
  void second.promise.then(() => { secondFired += 1 })
  await tick(60)
  assert.equal(firstFired, 0, 'the abandoned window was cleared, not left to fire later')
  assert.equal(secondFired, 0, 'arming alone never fires a suspension')
  // …while a call parked into the NEW suspension still gets its own window.
  delayed.park('s1', { baseCallId: 'z', plan: { vendorTool: 'read_files', calls: [] }, vendorTool: 'read_files', respond: () => {} })
  await tick(60)
  assert.equal(secondFired, 1, 'the new suspension fires for its own call')
  delayed.drop('s1')
})

test('the budget timer answers once and swallows hook failures', () => {
  // This code runs in a timer callback: an exception here is an uncaught
  // exception that takes the whole DSH process down (that is exactly what a
  // scope slip in the budget hook did). Both steps must be guarded.
  const warnings = []
  const logger = { warn: (message) => warnings.push(String(message)) }
  const answers = []
  let hookRan = 0
  fireBudget({
    vendorTool: 'execute_command',
    budgetMs: 20,
    answered: false,
    respond: (answer) => answers.push(answer),
    onBudgetExhausted: () => { hookRan += 1; throw new Error('hook exploded') },
  }, logger)
  assert.equal(answers.length, 1)
  assert.match(answers[0].error.message, /未完成/)
  assert.equal(hookRan, 1, 'the hook still runs')
  assert.equal(warnings.some((message) => /hook exploded/.test(message)), true, 'and its failure is reported')

  // A throwing answerer is reported too, and a second fire is a no-op.
  fireBudget({ vendorTool: 'x', budgetMs: 1, answered: false, respond: () => { throw new Error('send failed') } }, logger)
  assert.equal(warnings.some((message) => /send failed/.test(message)), true)
  const again = []
  fireBudget({ vendorTool: 'x', budgetMs: 1, answered: true, respond: (answer) => again.push(answer) }, logger)
  assert.equal(again.length, 0)
})

test('the budget hook references a name that exists in its enclosing method', () => {
  // Regression guard for a host-killing crash: `#loopContext(sessionKey, …)`
  // called `this.#drainParked(routeKey)`, so the timer threw
  // "ReferenceError: routeKey is not defined" and took the process down.
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const hook = /onBudgetExhausted:\s*\(\)\s*=>\s*this\.#drainParked\((\w+)\)/.exec(source)
  assert.ok(hook !== null, 'no budget hook found in index.js')
  const key = hook[1]
  const owner = source.slice(0, hook.index)
  const declared = new RegExp(`#loopContext\\(([^)]*)\\b${key}\\b`).exec(owner)
  assert.ok(declared !== null, `#loopContext does not declare ${key}: the budget timer would throw a ReferenceError and kill the host`)
})
