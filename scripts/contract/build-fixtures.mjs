#!/usr/bin/env node
/**
 * Curate the committed contract fixtures from a harvested pool.
 *
 *   node scripts/contract/build-fixtures.mjs --pool /tmp/lanagent-pool.json --out test/contract/fixtures.json
 *
 * The pool is not committed (it holds user commands and file content). This
 * script picks a small, stable set of outcomes from it, composes the vendor
 * requests the seam will receive, and writes the input side of the contract.
 * Expected vendor answers are deliberately absent for now: they are added with
 * the seam, after the canonical shapes are implemented.
 *
 * @module scripts/contract/build-fixtures
 */

import { readFileSync, writeFileSync } from 'node:fs'

function parseArgs(argv) {
  const args = { pool: '', out: '' }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--pool') { args.pool = argv[index + 1]; index += 1 }
    else if (argv[index] === '--out') { args.out = argv[index + 1]; index += 1 }
  }
  return args
}

/** Pick the first sample that satisfies `predicate`; fail loudly when none does. */
function pick(pool, tool, predicate, label) {
  const found = (pool.samples?.[tool] ?? []).find(predicate)
  if (found === undefined) throw new Error(`fixtures: no ${tool} sample for ${label}`)
  return found
}

const isSuccess = (sample) => sample.isError !== true
const isError = (sample) => sample.isError === true
const hasValue = (sample) => sample.value !== undefined
const shorterThan = (limit) => (sample) => sample.text.length < limit

/** One DSH call, with provenance, stripped of the session id. */
function call(key, sample, extra = {}) {
  return {
    key,
    dshTool: sample.dshTool,
    isError: sample.isError === true,
    text: sample.text,
    ...sample.value === undefined ? {} : { value: sample.value },
    ...extra,
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.pool === '' || args.out === '') {
    console.error('usage: node test/contract/build-fixtures.mjs --pool <pool.json> --out <fixtures.json>')
    process.exit(2)
  }
  const pool = JSON.parse(readFileSync(args.pool, 'utf8'))

  const bashOk = pick(pool, 'bash', (s) => isSuccess(s) && hasValue(s) && shorterThan(400)(s), 'success')
  const readOk = pick(pool, 'read', (s) => isSuccess(s) && hasValue(s) && shorterThan(400)(s), 'success')
  const readErr = pick(pool, 'read', (s) => isError(s) && !hasValue(s) && shorterThan(200)(s), 'error')
  const readErr2 = (pool.samples.read ?? []).filter((s) => isError(s) && !hasValue(s) && shorterThan(200)(s) && s.text !== readErr.text)[0] ?? readErr
  const globOk = pick(pool, 'glob', (s) => isSuccess(s) && hasValue(s) && shorterThan(200)(s), 'success')
  const globEmpty = pick(pool, 'glob', (s) => isSuccess(s) && hasValue(s) && s.text === 'No files found', 'empty')
  const grepOk = pick(pool, 'grep', (s) => isSuccess(s) && hasValue(s) && shorterThan(400)(s), 'success')
  const editOk = pick(pool, 'edit', (s) => isSuccess(s) && hasValue(s), 'success')
  const writeOk = pick(pool, 'write', (s) => isSuccess(s) && hasValue(s), 'success')
  const runCodeOk = pick(pool, 'run_code', (s) => isSuccess(s) && !hasValue(s) && shorterThan(120)(s), 'success')
  const toolboxOk = pick(pool, 'mcp__serial__list_ports', (s) => isSuccess(s) && hasValue(s), 'success')
  const mcpOk = pick(pool, 'mcp__claw__claw_grep', (s) => isSuccess(s) && hasValue(s) && shorterThan(100)(s), 'success')

  const readPath = readOk.arguments.file_path
  const readFailPath = readErr.arguments.file_path ?? '/workspace/missing.md'
  const globPath = globOk.arguments.path ?? '/workspace/probe'
  const grepArgs = grepOk.arguments
  const editPath = editOk.arguments.path ?? editOk.arguments.file_path ?? '/workspace/edited.md'
  const writePath = writeOk.arguments.file_path
  const writeContent = writeOk.arguments.content
  const bashCommand = bashOk.arguments.command
  const toolboxText = toolboxOk.text
  const mcpServer = 'claw'
  const mcpTool = 'claw_grep'

  const cases = [
    {
      id: 'execute_command/success',
      kind: 'dsh',
      vendor: 'execute_command',
      cwd: '/workspace',
      arguments: { command: bashCommand, workdir: '.', timeout: 300000 },
      calls: [call('cmd', bashOk)],
      note: 'A foreground command: text is raw stdout, value carries exit code and sandbox mode.',
    },
    {
      id: 'execute_command/timeout',
      kind: 'dsh',
      vendor: 'execute_command',
      cwd: '/workspace',
      arguments: { command: 'sleep 300', workdir: '.', timeout: 300000 },
      calls: [{
        key: 'cmd',
        dshTool: 'bash',
        isError: true,
        text: 'Error: command timed out after 300000ms',
      }],
      note: 'Synthetic: the harvested lanagent sessions had no failing bash. Shape is the executor refusal envelope.',
    },
    {
      id: 'read_files/success',
      kind: 'dsh',
      vendor: 'read_files',
      cwd: '/workspace',
      arguments: { paths: [readPath] },
      calls: [call('read:0', readOk)],
      note: 'Text has line numbers and a footer; value.lines is the same content without prefixes.',
    },
    {
      id: 'read_files/partial',
      kind: 'dsh',
      vendor: 'read_files',
      cwd: '/workspace',
      arguments: { paths: [readPath, readFailPath] },
      calls: [call('read:0', readOk), call('read:1', readErr)],
      note: 'One success, one failure: the canonical answer keeps both, with a per-path failure string.',
    },
    {
      id: 'read_files/all-fail',
      kind: 'dsh',
      vendor: 'read_files',
      cwd: '/workspace',
      arguments: { paths: [readFailPath, readErr2.arguments.file_path ?? '/workspace/other-missing.md'] },
      calls: [call('read:0', readErr), call('read:1', readErr2)],
      note: 'Every path failed: the canonical answer is a top-level error envelope.',
    },
    {
      id: 'list_files/success',
      kind: 'dsh',
      vendor: 'list_files',
      cwd: '/workspace',
      arguments: { path: globPath, recursive: false },
      calls: [call('glob', globOk)],
      note: 'Glob publishes paths in value; the rendered text is one path per line.',
    },
    {
      id: 'list_files/empty',
      kind: 'dsh',
      vendor: 'list_files',
      cwd: '/workspace',
      arguments: { path: '/workspace/empty', recursive: false },
      calls: [call('glob', globEmpty)],
      note: 'Empty glob: vendor expects an empty JSON array, not "No files found".',
    },
    {
      id: 'search_files/grep',
      kind: 'dsh',
      vendor: 'search_files',
      cwd: '/workspace',
      arguments: { claude_name: 'Grep', pattern: grepArgs.pattern, path: grepArgs.path },
      calls: [call('grep', grepOk)],
      note: 'DSH renders "Found N matches / path / Line N: text"; value.matches carries the same data.',
    },
    {
      id: 'search_files/glob',
      kind: 'dsh',
      vendor: 'search_files',
      cwd: '/workspace',
      arguments: { claude_name: 'Glob', pattern: globOk.arguments.pattern, path: globOk.arguments.path },
      calls: [call('glob', globOk)],
      note: 'Glob mode returns a JSON array of workspace-relative paths.',
    },
    {
      id: 'write_to_file/success',
      kind: 'dsh',
      vendor: 'write_to_file',
      cwd: '/workspace',
      arguments: { path: writePath, content: writeContent },
      calls: [call('write', writeOk)],
      note: 'The vendor client answers with the bare literal "success"; the rendered text is not sent.',
    },
    {
      id: 'replace_in_file/exact',
      kind: 'dsh',
      vendor: 'replace_in_file',
      cwd: '/workspace',
      arguments: { path: '/workspace/exact.txt', diff: '------- SEARCH\nTARGET-LINE\n=======\nEXACT-DONE\n+++++++ REPLACE' },
      documents: { '/workspace/exact.txt': 'keep-me\nTARGET-LINE\nneighbour\n' },
      calls: [{
        key: 'edit:0',
        dshTool: 'edit',
        isError: false,
        text: 'The file /workspace/exact.txt has been updated successfully.',
        value: { path: '/workspace/exact.txt', before: 'keep-me\nTARGET-LINE\nneighbour\n', after: 'keep-me\nEXACT-DONE\nneighbour\n' },
      }],
      expectedPlan: {
        calls: [{
          key: 'edit:0',
          dshTool: 'edit',
          arguments: { file_path: '/workspace/exact.txt', old_string: 'TARGET-LINE', new_string: 'EXACT-DONE' },
        }],
      },
      note: 'Synthetic exact case; the fuzzy case below is harvested. Both must plan the same kind of edit.',
    },
    {
      id: 'replace_in_file/fuzzy',
      kind: 'dsh',
      vendor: 'replace_in_file',
      cwd: '/workspace',
      arguments: { path: '/workspace/fuzzy.txt', diff: '------- SEARCH\nTARGET-LINE\n=======\nFUZZY-DONE\n+++++++ REPLACE' },
      documents: { '/workspace/fuzzy.txt': 'keep-me\nTARGET-LINE   \nneighbour\n' },
      calls: [{
        key: 'edit:0',
        dshTool: 'edit',
        isError: false,
        text: 'The file /workspace/fuzzy.txt has been updated successfully.',
        value: { path: '/workspace/fuzzy.txt', before: 'keep-me\nTARGET-LINE   \nneighbour\n', after: 'keep-me\nFUZZY-DONE\nneighbour\n' },
      }],
      expectedPlan: {
        calls: [{
          key: 'edit:0',
          dshTool: 'edit',
          arguments: {
            file_path: '/workspace/fuzzy.txt',
            old_string: 'TARGET-LINE   ',
            new_string: 'FUZZY-DONE',
          },
        }],
      },
      note: 'The file has trailing spaces the vendor did not send; plan-time resolution must use the literal line.',
    },
    {
      id: 'use_mcp_tool/toolbox',
      kind: 'dsh',
      vendor: 'use_mcp_tool',
      cwd: '/workspace',
      arguments: { server_name: 'dsh_toolbox', tool_name: 'list_ports', arguments: {} },
      calls: [call('mcp', toolboxOk)],
      note: 'A bare toolbox name resolves to mcp__serial__list_ports; the answer is the rendered content.',
    },
    {
      id: 'use_mcp_tool/external',
      kind: 'dsh',
      vendor: 'use_mcp_tool',
      cwd: '/workspace',
      arguments: { server_name: mcpServer, tool_name: mcpTool, arguments: { host: 'local', pattern: 'needle', path: '/workspace' } },
      calls: [call('mcp', mcpOk)],
      note: 'A real MCP server name keeps its mcp__<server>__<tool> prefix.',
    },
    {
      id: 'run_code/direct',
      kind: 'dsh',
      vendor: 'run_code',
      cwd: '/workspace',
      arguments: runCodeOk.arguments,
      calls: [call('run_code', runCodeOk)],
      note: 'DSH vocabulary passed through; text is the program rendering.',
    },
    {
      id: 'get_environment_info/local',
      kind: 'local',
      vendor: 'get_environment_info',
      cwd: '/workspace',
      arguments: {},
      calls: [],
      note: 'The preflight is answered locally: no DSH call, no approval, no card.',
    },
    {
      // Constructed, not harvested: the fleet has no ask_user_question dispatch in
      // the pool yet, and this case exists to pin the interaction mapping. The
      // answer is dsh-tool-ask-user's documented shape.
      id: 'ask_followup_question/mapped',
      kind: 'dsh',
      vendor: 'ask_followup_question',
      cwd: '/workspace',
      arguments: { question: 'Continue with the migration?', options: ['Yes', 'No'] },
      calls: [{
        key: 'ask',
        dshTool: 'ask_user_question',
        isError: false,
        text: JSON.stringify({ answers: [{ id: 'vendor-followup', selected: ['Yes'], custom: '' }] }),
        value: { answers: [{ id: 'vendor-followup', selected: ['Yes'], custom: '' }] },
      }],
      expectedPlan: {
        calls: [{
          key: 'ask',
          dshTool: 'ask_user_question',
          arguments: { questions: [{ id: 'vendor-followup', question: 'Continue with the migration?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
        }],
      },
      note: "The vendor client's own interaction question mapped onto DSH ask_user_question (the fix for \"asked a question and stopped\").",
    },
    {
      id: 'refusal/switch_mode',
      kind: 'refusal',
      vendor: 'switch_mode',
      cwd: '/workspace',
      arguments: { mode: 'code' },
      calls: [],
      note: 'Interaction-only tools with no DSH counterpart stay refused; ask_followup_question is mapped instead.',
      observed: { isError: true, text: 'unsupported tool name' },
    },
    {
      id: 'refusal/missing-arguments',
      kind: 'refusal',
      vendor: 'read_files',
      cwd: '/workspace',
      arguments: { paths: [] },
      calls: [],
      note: 'Empty paths: a plan-time refusal, before any DSH call.',
    },
    {
      id: 'refusal/unknown-tool',
      kind: 'refusal',
      vendor: 'no_such_vendor_tool',
      cwd: '/workspace',
      arguments: { anything: true },
      calls: [],
      note: 'Unknown names are refused with the list of names the vendor may use.',
    },
  ]

  const fixtures = {
    version: 1,
    provenance: {
      harvestedAt: pool.generatedAt,
      sessions: pool.lanagentSessions,
      pairedSamples: pool.paired,
      textOnlySamples: pool.textOnly,
      note: 'Curated from lanagent session logs; paths and account names sanitized. Expected answers are added with the seam.',
    },
    cases,
  }
  writeFileSync(args.out, `${JSON.stringify(fixtures, null, 2)}\n`)
  console.log(`fixtures: ${cases.length} cases -> ${args.out}`)
  for (const entry of cases) console.log(`  ${entry.id} (${entry.kind}, ${entry.calls.length} call(s))`)
}

main()
