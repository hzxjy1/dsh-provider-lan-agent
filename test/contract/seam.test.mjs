/**
 * Contract tests for the vendor-request seam (A).
 *
 * They run the real fixtures through `interpret` and `render` twice: once with
 * the bridge's structured `value`, once with the loop's text-only outcome. Both
 * must produce the same vendor answer. That equality is the contract; the
 * per-tool assertions below say what the answer must contain, not how it is
 * formatted internally.
 *
 * @module test/contract/seam.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { interpret, render } from '../../src/vendor/registry.js'
import { VENDOR_MEMORY_ROOT } from '../../src/paths.js'

const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'))
const cases = fixtures.cases

function context(entry) {
  return {
    cwd: entry.cwd,
    mappings: [],
    toolboxName: 'dsh_toolbox',
    resolveTool: (name) => (name === 'list_ports' ? 'mcp__serial__list_ports' : undefined),
    availableTools: ['mcp__serial__list_ports'],
    documents: entry.documents,
    localAnswers: new Map([['get_environment_info', { content: [{ type: 'text', text: 'LOCAL-PREFLIGHT' }] }]]),
  }
}

/** The same calls with and without the bridge's structured value. */
function outcomesFor(entry) {
  const withValue = new Map()
  const textOnly = new Map()
  for (const call of entry.calls) {
    withValue.set(call.key, { text: call.text, isError: call.isError, ...'value' in call ? { value: call.value } : {} })
    textOnly.set(call.key, { text: call.text, isError: call.isError })
  }
  return { withValue, textOnly }
}

const answerText = (answer) => {
  assert.equal(answer.error, undefined, `expected a content answer, got ${JSON.stringify(answer)}`)
  return answer.content.map((block) => block.text).join('\n')
}

const parseJson = (answer) => JSON.parse(answerText(answer))

for (const entry of cases) {
  test(`${entry.id}: plans and renders the same answer with and without value`, async () => {
    const ctx = context(entry)
    const plan = await interpret(entry.vendor, entry.arguments, ctx)

    if (entry.kind === 'local') {
      assert.equal(plan.kind, 'local')
      assert.equal(answerText(render(plan, new Map(), ctx)), 'LOCAL-PREFLIGHT')
      return
    }
    if (entry.kind === 'refusal') {
      assert.equal(plan.kind, 'refusal')
      const answer = render(plan, new Map(), ctx)
      assert.equal(typeof answer.error?.message, 'string')
      assert.ok(answer.error.message.length > 0)
      return
    }

    assert.equal(plan.kind, 'dsh')
    assert.equal(plan.calls.length, entry.calls.length, 'plan must produce one call per fixture call')
    assert.deepEqual(plan.calls.map((call) => call.key), entry.calls.map((call) => call.key))
    assert.deepEqual(plan.calls.map((call) => call.dshTool), entry.calls.map((call) => call.dshTool))
    if (entry.expectedPlan !== undefined) assert.deepEqual(plan.calls, entry.expectedPlan.calls)

    const { withValue, textOnly } = outcomesFor(entry)
    const fromValue = render(plan, withValue, ctx)
    const fromText = render(plan, textOnly, ctx)
    assert.deepEqual(fromText, fromValue, 'the text-only route must produce the same answer as the value route')
  })
}

test('execute_command: output is the vendor JSON envelope, value and text agree', async () => {
  const entry = cases.find((item) => item.id === 'execute_command/success')
  const ctx = context(entry)
  const plan = await interpret(entry.vendor, entry.arguments, ctx)
  const payload = parseJson(render(plan, outcomesFor(entry).withValue, ctx))
  assert.equal(payload.success, true)
  assert.ok(payload.output.includes('/usr/sbin/init'))
  assert.equal(payload.error, '')
})

test('execute_command: an executor error is the vendor error envelope', async () => {
  const entry = cases.find((item) => item.id === 'execute_command/timeout')
  const plan = await interpret(entry.vendor, entry.arguments, context(entry))
  const answer = render(plan, outcomesFor(entry).withValue, context(entry))
  assert.ok(answer.error.message.includes('timed out'))
})

test('read_files: success returns bare content under the mapped path', async () => {
  const entry = cases.find((item) => item.id === 'read_files/success')
  const plan = await interpret(entry.vendor, entry.arguments, context(entry))
  const payload = parseJson(render(plan, outcomesFor(entry).withValue, context(entry)))
  const content = payload[entry.arguments.paths[0]]
  assert.ok(content.includes('keep-me'))
  assert.ok(!content.includes('1: '), 'line-number prefixes must be stripped')
})

test('read_files: partial failure keeps both entries, with a per-path failure string', async () => {
  const entry = cases.find((item) => item.id === 'read_files/partial')
  const plan = await interpret(entry.vendor, entry.arguments, context(entry))
  const payload = parseJson(render(plan, outcomesFor(entry).withValue, context(entry)))
  assert.ok(payload[entry.arguments.paths[0]].includes('keep-me'))
  assert.ok(payload[entry.arguments.paths[1]].startsWith('[读取失败]'))
})

test('read_files: all-fail is a top-level error envelope', async () => {
  const entry = cases.find((item) => item.id === 'read_files/all-fail')
  const plan = await interpret(entry.vendor, entry.arguments, context(entry))
  const answer = render(plan, outcomesFor(entry).withValue, context(entry))
  assert.ok(answer.error.message.includes('cannot read'))
})

test('list_files: paths are a JSON array, and empty is []', async () => {
  const success = cases.find((item) => item.id === 'list_files/success')
  const successPlan = await interpret(success.vendor, success.arguments, context(success))
  const paths = parseJson(render(successPlan, outcomesFor(success).withValue, context(success)))
  assert.ok(Array.isArray(paths))
  assert.ok(paths.includes('probe/audit-peek.mjs'))

  const empty = cases.find((item) => item.id === 'list_files/empty')
  const emptyPlan = await interpret(empty.vendor, empty.arguments, context(empty))
  assert.deepEqual(parseJson(render(emptyPlan, outcomesFor(empty).withValue, context(empty))), [])
})

test("search_files: Grep renders path:line:text, not DSH chrome", async () => {
  const entry = cases.find((item) => item.id === 'search_files/grep')
  const plan = await interpret(entry.vendor, entry.arguments, context(entry))
  const text = answerText(render(plan, outcomesFor(entry).withValue, context(entry)))
  assert.ok(text.includes(':1058:'), text)
  assert.ok(text.startsWith('local-plugins/dsh-provider-lan-agent/index.js:1058:'), text)
  assert.ok(!text.includes('Found 1 match'))
})

test('search_files: Glob returns a JSON array', async () => {
  const entry = cases.find((item) => item.id === 'search_files/glob')
  const plan = await interpret(entry.vendor, entry.arguments, context(entry))
  const paths = parseJson(render(plan, outcomesFor(entry).withValue, context(entry)))
  assert.ok(Array.isArray(paths))
  assert.ok(paths.includes('probe/audit-peek.mjs'))
})

test('write_to_file and replace_in_file answer with the bare "success" literal', async () => {
  for (const id of ['write_to_file/success', 'replace_in_file/exact', 'replace_in_file/fuzzy']) {
    const entry = cases.find((item) => item.id === id)
    const plan = await interpret(entry.vendor, entry.arguments, context(entry))
    assert.equal(answerText(render(plan, outcomesFor(entry).withValue, context(entry))), 'success', id)
  }
})

test('replace_in_file: fuzzy resolution plans a literal edit, and no file write', async () => {
  const entry = cases.find((item) => item.id === 'replace_in_file/fuzzy')
  const plan = await interpret(entry.vendor, entry.arguments, context(entry))
  assert.equal(plan.calls.length, 1)
  assert.equal(plan.calls[0].dshTool, 'edit')
  assert.equal(plan.calls[0].arguments.old_string, 'TARGET-LINE   ')
  assert.equal(plan.calls[0].arguments.new_string, 'FUZZY-DONE')
})

test('use_mcp_tool: toolbox names resolve to the DSH MCP name', async () => {
  const entry = cases.find((item) => item.id === 'use_mcp_tool/toolbox')
  const plan = await interpret(entry.vendor, entry.arguments, context(entry))
  assert.equal(plan.calls[0].dshTool, 'mcp__serial__list_ports')
  assert.ok(answerText(render(plan, outcomesFor(entry).withValue, context(entry))).includes('Found 4 serial ports'))
})

test('run_code: DSH vocabulary passes through unchanged', async () => {
  const entry = cases.find((item) => item.id === 'run_code/direct')
  const plan = await interpret(entry.vendor, entry.arguments, context(entry))
  assert.equal(plan.calls[0].dshTool, 'run_code')
  assert.equal(answerText(render(plan, outcomesFor(entry).withValue, context(entry))), entry.calls[0].text)
})

test('the caller can pin the request id that request/settled events share', async () => {
  const plan = await interpret('bash', { command: 'pwd', description: 'x' }, { requestId: 'trace-1' })
  assert.equal(plan.requestId, 'trace-1')
  const refusal = await interpret('does_not_exist', {}, { requestId: 'trace-2' })
  assert.equal(refusal.requestId, 'trace-2')
})

test('Bash is an alias for execute_command', async () => {
  const entry = cases.find((item) => item.id === 'execute_command/success')
  const canonical = await interpret('execute_command', entry.arguments, context(entry))
  const alias = await interpret('Bash', entry.arguments, context(entry))
  assert.deepEqual(alias.calls, canonical.calls)
})

test('DSH passthrough names keep their arguments and rendering', async () => {
  const plan = await interpret('bash', { command: 'pwd', description: 'x' }, { cwd: '/workspace' })
  assert.equal(plan.kind, 'dsh')
  assert.equal(plan.passthrough, true)
  assert.equal(plan.calls[0].dshTool, 'bash')
  const answer = render(plan, new Map([['passthrough', { text: '/workspace\n', isError: false }]]), {})
  assert.equal(answerText(answer), '/workspace')
})

test('send_message is a bridge name, so a child can reach its parent', async () => {
  const plan = await interpret('send_message', { agent_id: 'session-abc', message: 'done' }, {})
  assert.equal(plan.kind, 'dsh')
  assert.equal(plan.passthrough, true)
  assert.equal(plan.calls[0].dshTool, 'send_message')
  assert.deepEqual(plan.calls[0].arguments, { agent_id: 'session-abc', message: 'done' })
  const answer = render(plan, new Map([['passthrough', { text: 'message delivered to agent session-abc', isError: false }]]), {})
  assert.equal(answerText(answer), 'message delivered to agent session-abc')
})

test('mapping happens during interpretation, before planning', async () => {
  const plan = await interpret('read_files', { paths: [`${VENDOR_MEMORY_ROOT}/projects/-/memory/MEMORY.md`] }, {
    cwd: '/workspace',
    mappings: [{ from: VENDOR_MEMORY_ROOT, to: '/workspace/.lan-agent-memory' }],
  })
  assert.equal(plan.calls[0].arguments.file_path, '/workspace/.lan-agent-memory/projects/-/memory/MEMORY.md')
})

test('unknown and interaction-only tools are refused with actionable text', async () => {
  const unknown = await interpret('does_not_exist', {}, {})
  assert.equal(unknown.kind, 'refusal')
  assert.ok(unknown.error.message.includes('可用工具'))

  // `ask_followup_question` is NOT refused any more (it maps to ask_user_question,
  // see the test below); the remaining interaction tools have no DSH counterpart.
  const interaction = await interpret('switch_mode', { mode: 'code' }, {})
  assert.equal(interaction.kind, 'refusal')
  assert.ok(interaction.error.message.includes('交互类'))
})

test('ask_followup_question maps onto the DSH question tool, and its answer renders', async () => {
  const plan = await interpret('ask_followup_question', { question: 'Continue?', options: ['Yes', 'No'] }, {})
  assert.equal(plan.kind, 'dsh')
  assert.equal(plan.calls.length, 1)
  assert.equal(plan.calls[0].dshTool, 'ask_user_question')
  const questions = plan.calls[0].arguments.questions
  assert.equal(questions.length, 1)
  assert.equal(questions[0].question, 'Continue?')
  assert.deepEqual(questions[0].options, [{ label: 'Yes' }, { label: 'No' }])

  const answered = { answers: [{ id: questions[0].id, selected: ['Yes'], custom: 'and then keep going' }] }
  const answer = { text: JSON.stringify(answered), isError: false }
  const fromValue = render(plan, new Map([['ask', { ...answer, value: answered }]]), {})
  const fromText = render(plan, new Map([['ask', answer]]), {})
  assert.deepEqual(fromText, fromValue, 'the text-only route must render the same answer')
  assert.match(fromValue.content[0].text, /Continue\?/)
  assert.match(fromValue.content[0].text, /Yes/)
  assert.match(fromValue.content[0].text, /and then keep going/)

  // A timed question that ran out of patience is PENDING, not answered: the vendor
  // model must not be told the user answered something.
  const pending = render(plan, new Map([['ask', { text: JSON.stringify({ pending: true }), isError: false }]]), {})
  assert.match(pending.content[0].text, /没有回答/)

  // A skipped question is still a submitted batch.
  const skipped = render(plan, new Map([['ask', { text: JSON.stringify({ answers: [{ id: questions[0].id, selected: [] }] }), isError: false }]]), {})
  assert.match(skipped.content[0].text, /跳过/)

  // A failure of the DSH tool is an error, never a pretend answer.
  const failed = render(plan, new Map([['ask', { text: 'the question UI is unavailable', isError: true }]]), {})
  assert.match(failed.error.message, /the question UI is unavailable/)

  // No question text means nothing to ask: refused before any DSH call.
  const empty = await interpret('ask_followup_question', { question: '   ' }, {})
  assert.equal(empty.kind, 'refusal')

  // The option-free shape the vendor also sends is accepted as-is.
  const plain = await interpret('ask_followup_question', { question: 'Which branch?' }, {})
  assert.deepEqual(plain.calls[0].arguments.questions, [{ id: 'vendor-followup', question: 'Which branch?' }])
})

test('a plan is a plain value: no functions, JSON-serializable, no responder', async () => {
  for (const entry of cases.filter((item) => item.kind === 'dsh')) {
    const plan = await interpret(entry.vendor, entry.arguments, context(entry))
    // Shared references are fine (the mapped arguments and a call can point at
    // the same object); only a true self-reference would break JSON round-tripping.
    const stack = new Set()
    const walk = (value, path) => {
      if (typeof value === 'function') assert.fail(`${entry.id}: plan holds a function at ${path}`)
      if (value === null || typeof value !== 'object') return
      if (stack.has(value)) assert.fail(`${entry.id}: plan is cyclic at ${path}`)
      stack.add(value)
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`)
      stack.delete(value)
    }
    walk(plan, entry.id)
    assert.doesNotThrow(() => JSON.stringify(plan), `${entry.id}: plan must survive a step boundary`)
  }
})
