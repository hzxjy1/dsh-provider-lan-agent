/**
 * Offline tests for the vendor→DSH path mapping (`src/paths.js`).
 *
 *   node --test test/paths.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ensureMappedRoots, mapPath, mapVendorPaths, VENDOR_HOME_DIRNAME, VENDOR_MEMORY_ROOT } from '../src/paths.js'

const TARGET = '/work/.lan-agent-memory'
const MAPPINGS = [{ from: VENDOR_MEMORY_ROOT, to: TARGET }]

test('a mapped prefix is rewritten, respecting segment boundaries', () => {
  assert.equal(mapPath(`${VENDOR_MEMORY_ROOT}/projects/-/memory/MEMORY.md`, MAPPINGS), `${TARGET}/projects/-/memory/MEMORY.md`)
  assert.equal(mapPath(VENDOR_MEMORY_ROOT, MAPPINGS), TARGET)
  // A longer name that merely starts with the same characters must not match.
  assert.equal(mapPath(`${VENDOR_MEMORY_ROOT}X/y`, MAPPINGS), `${VENDOR_MEMORY_ROOT}X/y`)
  assert.equal(mapPath('/etc/passwd', MAPPINGS), '/etc/passwd')
  assert.equal(mapPath(`${VENDOR_MEMORY_ROOT}/`, MAPPINGS), `${TARGET}/`)
})

test('trailing slashes on either side are tolerated, and unrelated input is untouched', () => {
  assert.equal(mapPath(`${VENDOR_MEMORY_ROOT}/a`, [{ from: `${VENDOR_MEMORY_ROOT}/`, to: '/tmp/x/' }]), '/tmp/x/a')
  assert.equal(mapPath('', MAPPINGS), '')
  assert.equal(mapPath('/a/b', []), '/a/b')
  assert.equal(mapPath('/a/b', undefined), '/a/b')
})

test('only the path-bearing arguments of a vendor request are rewritten', () => {
  assert.deepEqual(mapVendorPaths('read_files', { paths: [`${VENDOR_MEMORY_ROOT}/a`, '/tmp/b'] }, (p) => mapPath(p, MAPPINGS)), {
    paths: [`${TARGET}/a`, '/tmp/b'],
  })
  assert.deepEqual(mapVendorPaths('write_to_file', { path: `${VENDOR_MEMORY_ROOT}/x.md`, content: 'body' }, (p) => mapPath(p, MAPPINGS)), {
    path: `${TARGET}/x.md`,
    content: 'body',
  })
  assert.equal(mapVendorPaths('replace_in_file', { path: `${VENDOR_MEMORY_ROOT}/x.md`, diff: 'd' }, (p) => mapPath(p, MAPPINGS)).path, `${TARGET}/x.md`)
  assert.equal(mapVendorPaths('search_files', { path: VENDOR_MEMORY_ROOT, pattern: 'x' }, (p) => mapPath(p, MAPPINGS)).path, TARGET)
  assert.equal(mapVendorPaths('list_files', { path: VENDOR_MEMORY_ROOT, recursive: 'true' }, (p) => mapPath(p, MAPPINGS)).path, TARGET)
})

test('an unmapped or pathless request keeps its identity, so callers can skip the copy', () => {
  const input = { paths: ['/tmp/a'] }
  assert.equal(mapVendorPaths('read_files', input, (p) => mapPath(p, MAPPINGS)), input)
  assert.equal(mapVendorPaths('execute_command', { command: 'pwd' }, (p) => mapPath(p, MAPPINGS)).workdir, undefined)
  const payload = { command: 'pwd', workdir: `${VENDOR_MEMORY_ROOT}/sub` }
  assert.equal(mapVendorPaths('execute_command', payload, (p) => mapPath(p, MAPPINGS)).workdir, `${TARGET}/sub`)
  assert.equal(mapVendorPaths('unknown_tool', { path: `${VENDOR_MEMORY_ROOT}/a` }, (p) => mapPath(p, MAPPINGS)).path, `${VENDOR_MEMORY_ROOT}/a`)
})

test('the mapping target is created so the first vendor write cannot fail on it', () => {
  const target = join(mkdtempSync(join(tmpdir(), 'lanagent-map-')), 'nested', 'memory')
  assert.equal(VENDOR_HOME_DIRNAME.startsWith('.'), true)
  ensureMappedRoots([{ from: VENDOR_MEMORY_ROOT, to: target }])
  assert.equal(statSync(target).isDirectory(), true)
  // A hopeless target warns instead of throwing.
  const warnings = []
  ensureMappedRoots([{ from: '/x', to: '/proc/definitely/not/writable' }], { warn: (message) => warnings.push(message) })
  assert.equal(warnings.length, 1)
})
