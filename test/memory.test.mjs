/**
 * Offline tests for the local memory responder (`src/memory.js`) and the
 * shell-command path rewriting it depends on (`src/paths.js`).
 *
 *   node --test test/memory.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { answerMemoryOp } from '../src/memory.js'
import { isMappedPath, mapCommandText, VENDOR_HOME_DIRNAME, VENDOR_MEMORY_ROOT } from '../src/paths.js'

const TREE = mkdtempSync(join(tmpdir(), 'lanagent-mem-'))
const MAPPINGS = [{ from: VENDOR_MEMORY_ROOT, to: TREE }]
const inTree = (name) => join(TREE, name)

const textOf = (answer) => (answer?.content ?? []).map((block) => block.text).join('')

/* ── isMappedPath ─────────────────────────────────────────────────────── */

test('isMappedPath: the tree, its children, and nothing else', () => {
  assert.equal(isMappedPath(TREE, MAPPINGS), true)
  assert.equal(isMappedPath(`${TREE}/projects/-/memory/MEMORY.md`, MAPPINGS), true)
  // A sibling that merely starts with the same characters must not match.
  assert.equal(isMappedPath(`${TREE}x/y`, MAPPINGS), false)
  assert.equal(isMappedPath('/etc/passwd', MAPPINGS), false)
  assert.equal(isMappedPath('', MAPPINGS), false)
  assert.equal(isMappedPath('/a/b', []), false)
  assert.equal(isMappedPath('/a/b', undefined), false)
})

/* ── mapCommandText ───────────────────────────────────────────────────── */

test('mapCommandText: every observed spelling of the memory root is rewritten', () => {
  const cases = [
    `ls -la ${VENDOR_MEMORY_ROOT}/projects/-/memory/`,
    `cat ${VENDOR_MEMORY_ROOT}/projects/-/memory/MEMORY.md || echo NO_INDEX_YET`,
    `ls -la "$HOME/${VENDOR_HOME_DIRNAME}/projects/"`,
    `ls -la ~/${VENDOR_HOME_DIRNAME}/`,
    `ls -la /home/user/${VENDOR_HOME_DIRNAME}/ 2>&1`,
    `ls -la /home/${VENDOR_HOME_DIRNAME}/projects/`,
    `rm -f "${VENDOR_MEMORY_ROOT}/projects/-/memory/x.md" && echo removed`,
  ]
  for (const command of cases) {
    const mapped = mapCommandText(command, MAPPINGS)
    assert.equal(mapped.includes(VENDOR_HOME_DIRNAME), false, command)
    assert.equal(mapped.includes(TREE), true, command)
  }
})

test('mapCommandText: boundaries, non-matches, and degenerate inputs', () => {
  // A longer name sharing the prefix is NOT the memory root.
  assert.equal(mapCommandText(`ls ${VENDOR_MEMORY_ROOT}-x`, MAPPINGS), `ls ${VENDOR_MEMORY_ROOT}-x`)
  assert.equal(mapCommandText(`ls ${VENDOR_MEMORY_ROOT}foo`, MAPPINGS), `ls ${VENDOR_MEMORY_ROOT}foo`)
  // Unrelated commands pass through byte-for-byte.
  assert.equal(mapCommandText('pwd && ls', MAPPINGS), 'pwd && ls')
  assert.equal(mapCommandText('pwd', []), 'pwd')
  assert.equal(mapCommandText('', MAPPINGS), '')
  assert.equal(mapCommandText(undefined, MAPPINGS), undefined)
  // Only the root is replaced; the rest of the path survives.
  assert.equal(mapCommandText(`cat ${VENDOR_MEMORY_ROOT}/a/b.md`, MAPPINGS), `cat ${TREE}/a/b.md`)
})

/* ── answerMemoryOp: read_files ────────────────────────────────────────── */

test('read_files of a missing memory file answers EMPTY content, not an error', async () => {
  const answer = await answerMemoryOp('read_files', { paths: [inTree('projects/-/memory/MEMORY.md')] }, MAPPINGS)
  assert.equal(answer.error, undefined)
  assert.deepEqual(JSON.parse(textOf(answer)), { [inTree('projects/-/memory/MEMORY.md')]: '' })
})

test('read_files returns what was written, and several paths at once', async () => {
  writeFileSync(inTree('a.md'), 'alpha', 'utf8')
  writeFileSync(inTree('b.md'), 'beta', 'utf8')
  const answer = await answerMemoryOp('read_files', { paths: [inTree('a.md'), inTree('b.md')] }, MAPPINGS)
  assert.deepEqual(JSON.parse(textOf(answer)), { [inTree('a.md')]: 'alpha', [inTree('b.md')]: 'beta' })
})

test('read_files: a mixed or outside request is not mine (undefined)', async () => {
  assert.equal(await answerMemoryOp('read_files', { paths: [inTree('a.md'), '/etc/passwd'] }, MAPPINGS), undefined)
  assert.equal(await answerMemoryOp('read_files', { paths: ['/etc/passwd'] }, MAPPINGS), undefined)
  assert.equal(await answerMemoryOp('read_files', { paths: [] }, MAPPINGS), undefined)
  assert.equal(await answerMemoryOp('read_files', {}, MAPPINGS), undefined)
})

test('read_files of a directory reports the vendor-shaped error', async () => {
  mkdirSync(inTree('adir'))
  const answer = await answerMemoryOp('read_files', { paths: [inTree('adir')] }, MAPPINGS)
  assert.match(answer.error.message, /是一个目录/)
})

/* ── answerMemoryOp: write_to_file ─────────────────────────────────────── */

test('write_to_file creates parents and lands the content; read-back sees it', async () => {
  const path = inTree('projects/-/memory/deep/note.md')
  const answer = await answerMemoryOp('write_to_file', { path, content: '记住：统一使用 pnpm' }, MAPPINGS)
  assert.equal(answer.error, undefined)
  assert.equal(textOf(answer), 'success')
  assert.equal(readFileSync(path, 'utf8'), '记住：统一使用 pnpm')
  const back = await answerMemoryOp('read_files', { paths: [path] }, MAPPINGS)
  assert.equal(JSON.parse(textOf(back))[path], '记住：统一使用 pnpm')
})

test('write_to_file outside the tree, or with bad arguments, is not mine', async () => {
  assert.equal(await answerMemoryOp('write_to_file', { path: '/tmp/x.md', content: 'y' }, MAPPINGS), undefined)
  assert.equal(await answerMemoryOp('write_to_file', { path: inTree('z.md') }, MAPPINGS), undefined)
  assert.equal(await answerMemoryOp('write_to_file', { content: 'y' }, MAPPINGS), undefined)
})

/* ── answerMemoryOp: replace_in_file ───────────────────────────────────── */

test('replace_in_file applies a SEARCH/REPLACE block locally', async () => {
  const path = inTree('rep.md')
  writeFileSync(path, 'one\ntwo\nthree\n', 'utf8')
  const diff = ['------- SEARCH', 'two', '=======', 'TWO', '+++++++ REPLACE'].join('\n')
  const answer = await answerMemoryOp('replace_in_file', { path, diff }, MAPPINGS)
  assert.equal(answer.error, undefined)
  assert.equal(readFileSync(path, 'utf8'), 'one\nTWO\nthree\n')
})

test('replace_in_file: a block that cannot apply returns the vendor guidance', async () => {
  const path = inTree('rep2.md')
  writeFileSync(path, 'alpha\nbeta\n', 'utf8')
  const diff = ['------- SEARCH', 'not-in-file', '=======', 'x', '+++++++ REPLACE'].join('\n')
  const answer = await answerMemoryOp('replace_in_file', { path, diff }, MAPPINGS)
  assert.match(answer.error.message, /SEARCH 块未能在文件中应用/)
  assert.equal(readFileSync(path, 'utf8'), 'alpha\nbeta\n')
})

test('replace_in_file outside the tree, or a malformed diff, is handled', async () => {
  assert.equal(await answerMemoryOp('replace_in_file', { path: '/tmp/q.md', diff: 'x' }, MAPPINGS), undefined)
  const answer = await answerMemoryOp('replace_in_file', { path: inTree('r.md'), diff: 'no blocks here' }, MAPPINGS)
  assert.match(answer.error.message, /没有找到 SEARCH\/REPLACE 块/)
})

test('unknown tools are not mine', async () => {
  assert.equal(await answerMemoryOp('execute_command', { command: 'ls' }, MAPPINGS), undefined)
  assert.equal(await answerMemoryOp('list_files', { path: inTree('.') }, MAPPINGS), undefined)
})
