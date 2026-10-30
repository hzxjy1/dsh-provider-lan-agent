/**
 * Contract fixtures: input-side integrity.
 *
 * These tests do not know the seam yet; they prove that the fixtures are real,
 * sanitized, internally coherent, and rich enough to drive the contract tests
 * that come with the seam. They are deliberately strict about the two outcome
 * variants: the same call must be representable with and without a structured
 * `value`, because that is the difference the seam must absorb.
 *
 * @module test/contract/fixtures.test
 */

import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { test } from 'node:test'

const FILE = new URL('./fixtures.json', import.meta.url)
const fixtures = JSON.parse(readFileSync(FILE, 'utf8'))
const cases = fixtures.cases ?? []
const byId = new Map(cases.map((entry) => [entry.id, entry]))

const DSH_TOOLS = new Set(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'run_code', 'ask_user_question'])
const VENDOR_TOOLS = new Set([
  'get_environment_info', 'execute_command', 'read_files', 'write_to_file',
  'replace_in_file', 'search_files', 'list_files', 'use_mcp_tool', 'run_code',
  'ask_followup_question', 'switch_mode', 'no_such_vendor_tool',
])
const KINDS = new Set(['dsh', 'local', 'refusal'])

/** Strip `value` from a call, leaving the text-only variant. */
function textOnly(call) {
  const { value: _value, ...rest } = call
  return rest
}

test('fixtures: version and provenance are present', () => {
  assert.equal(fixtures.version, 1)
  assert.equal(typeof fixtures.provenance?.note, 'string')
  assert.ok(fixtures.provenance.sessions > 0, 'fixtures must come from real sessions')
  assert.ok(fixtures.provenance.pairedSamples > 0)
})

test('fixtures: every case has a unique id and a known kind', () => {
  const ids = new Set()
  for (const entry of cases) {
    assert.equal(typeof entry.id, 'string')
    assert.ok(entry.id.includes('/'), `case id should be "<tool>/<scenario>": ${entry.id}`)
    assert.ok(!ids.has(entry.id), `duplicate case id: ${entry.id}`)
    ids.add(entry.id)
    assert.ok(KINDS.has(entry.kind), `unknown kind ${entry.kind} in ${entry.id}`)
    assert.ok(VENDOR_TOOLS.has(entry.vendor), `unknown vendor tool ${entry.vendor} in ${entry.id}`)
    assert.equal(entry.cwd, '/workspace', `${entry.id}: fixture cwd must be the sanitized workspace`)
  }
})

test('fixtures: dsh cases have calls, local/refusal cases do not', () => {
  for (const entry of cases) {
    if (entry.kind === 'dsh') assert.ok(entry.calls.length > 0, `${entry.id}: dsh case needs calls`)
    else assert.equal(entry.calls.length, 0, `${entry.id}: ${entry.kind} case must not call DSH`)
  }
})

test('fixtures: calls are complete and keys are unique within a case', () => {
  for (const entry of cases) {
    const keys = new Set()
    for (const call of entry.calls) {
      assert.equal(typeof call.key, 'string', `${entry.id}: call key`)
      assert.ok(!keys.has(call.key), `${entry.id}: duplicate call key ${call.key}`)
      keys.add(call.key)
      assert.ok(DSH_TOOLS.has(call.dshTool) || call.dshTool.startsWith('mcp__'), `${entry.id}: unexpected DSH tool ${call.dshTool}`)
      assert.equal(typeof call.isError, 'boolean')
      assert.equal(typeof call.text, 'string')
      assert.ok(call.text.length > 0, `${entry.id}/${call.key}: text is the outcome we must shape`)
      if ('value' in call) assert.equal(typeof call.value, 'object')
    }
  }
})

test('fixtures: with-value and text-only variants differ only by value', () => {
  for (const entry of cases) {
    for (const call of entry.calls) {
      const only = textOnly(call)
      assert.deepEqual(Object.keys(call).filter((key) => key !== 'value').sort(), Object.keys(only).sort())
      assert.equal(only.text, call.text)
      assert.equal('value' in only, false)
    }
  }
})

test('fixtures: value-bearing cases exist for both routes to compare', () => {
  const withValue = cases.filter((entry) => entry.calls.some((call) => 'value' in call))
  const textOnlySuccess = cases.filter((entry) => entry.calls.some((call) => !call.isError && !('value' in call)))
  assert.ok(withValue.length >= 6, `expected several value-bearing cases, got ${withValue.length}`)
  assert.ok(textOnlySuccess.length >= 1, 'at least one successful outcome must be text-only (the loop route)')
})

test('fixtures: read_files covers success, partial failure, and all-fail', () => {
  assert.ok(byId.has('read_files/success'))
  assert.ok(byId.has('read_files/partial'))
  assert.ok(byId.has('read_files/all-fail'))
  const partial = byId.get('read_files/partial')
  assert.equal(partial.calls.filter((call) => !call.isError).length, 1)
  assert.equal(partial.calls.filter((call) => call.isError).length, 1)
  assert.equal(partial.arguments.paths.length, 2, 'partial needs one path per call')
  const allFail = byId.get('read_files/all-fail')
  assert.ok(allFail.calls.every((call) => call.isError))
})

test('fixtures: replace_in_file has an exact and a fuzzy case with resolvable documents', () => {
  for (const id of ['replace_in_file/exact', 'replace_in_file/fuzzy']) {
    const entry = byId.get(id)
    assert.ok(entry !== undefined, `missing ${id}`)
    assert.equal(entry.calls.length, 1)
    assert.equal(entry.calls[0].dshTool, 'edit')
    assert.ok(entry.documents !== undefined, `${id}: plan-time resolution needs the file content`)
    assert.equal(entry.expectedPlan.calls.length, 1)
    const planned = entry.expectedPlan.calls[0]
    assert.equal(planned.dshTool, 'edit')
    const text = entry.documents[planned.arguments.file_path]
    assert.equal(typeof text, 'string', `${id}: document must be keyed by the planned path`)
    assert.ok(text.includes(planned.arguments.old_string), `${id}: planned old_string must exist verbatim in the document`)
    assert.ok(!planned.arguments.old_string.includes('\n'), `${id}: the resolved block should not depend on a trailing newline`)
  }
  const fuzzy = byId.get('replace_in_file/fuzzy')
  assert.ok(fuzzy.arguments.diff.includes('TARGET-LINE'), 'fuzzy request carries the vendor spelling without trailing spaces')
  assert.equal(fuzzy.expectedPlan.calls[0].arguments.old_string, 'TARGET-LINE   ', 'resolution must use the literal file line')
})

test('fixtures: local and refusal cases carry their decision evidence', () => {
  assert.equal(byId.get('get_environment_info/local').vendor, 'get_environment_info')
  // The vendor's interaction question is mapped, not refused: it must become a
  // real ask_user_question call. The tools that stay refused carry their name.
  assert.equal(byId.get('ask_followup_question/mapped').calls[0].dshTool, 'ask_user_question')
  assert.equal(byId.get('refusal/switch_mode').vendor, 'switch_mode')
  assert.ok(byId.get('refusal/switch_mode').observed.text.length > 0)
  assert.deepEqual(byId.get('refusal/missing-arguments').arguments.paths, [])
})

test('fixtures: coverage includes every vendor tool and every DSH target', () => {
  const vendors = new Set(cases.map((entry) => entry.vendor))
  for (const tool of ['execute_command', 'read_files', 'write_to_file', 'replace_in_file', 'search_files', 'list_files', 'use_mcp_tool', 'run_code', 'get_environment_info']) {
    assert.ok(vendors.has(tool), `no fixture for vendor tool ${tool}`)
  }
  const dsh = new Set(cases.flatMap((entry) => entry.calls.map((call) => call.dshTool)))
  for (const tool of ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'run_code']) {
    assert.ok(dsh.has(tool), `no fixture exercises DSH tool ${tool}`)
  }
})

test('fixtures: no machine-specific data survived sanitization', () => {
  const text = JSON.stringify(fixtures)
  const forbiddenTerms = ['ai' + 'plus', 'code' + 'chat', 'desay' + 'sv', 'hella' + 'gur', 'uids' + '0861', '/mnt/' + 'c/', '/mnt/' + 'd/']
  for (const forbidden of forbiddenTerms) {
    assert.equal(text.includes(forbidden), false, `fixture leaks ${forbidden}`)
  }
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(text), 'fixture leaks a raw UUID')
})

test('fixtures: the file stays small enough to review', () => {
  const size = statSync(FILE).size
  assert.ok(size < 256 * 1024, `fixtures.json is ${size} bytes; keep it reviewable`)
  assert.ok(cases.length >= 15, `expected a broad fixture set, got ${cases.length} cases`)
})
