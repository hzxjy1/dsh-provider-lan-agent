/**
 * Offline tests for tolerant SEARCH/REPLACE matching (`src/fuzzy.js`).
 *
 *   node --test test/fuzzy.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { applyBlock, findBlock, nearest } from '../src/fuzzy.js'

const FILE = ['alpha', 'beta   ', 'gamma', 'delta', ''].join('\n')   // note: trailing spaces on beta

test('an exact block is reported as exact and replaced in place', () => {
  const hit = findBlock(FILE, 'gamma\n')
  assert.deepEqual({ found: hit.found, exact: hit.exact, start: hit.start, end: hit.end }, { found: true, exact: true, start: 2, end: 2 })
  const patched = applyBlock(FILE, 'gamma', 'GAMMA-2')
  assert.equal(patched.ok, true)
  assert.equal(patched.exact, true)
  assert.equal(patched.text, ['alpha', 'beta   ', 'GAMMA-2', 'delta', ''].join('\n'))
})

test('trailing whitespace and line endings are tolerated, and only matched lines change', () => {
  // The vendor writes "beta" without the file's trailing spaces and with CRLF.
  const patched = applyBlock(FILE, 'beta\r\n', 'BETA\r\n')
  assert.equal(patched.ok, true)
  assert.equal(patched.exact, false, 'tolerance was needed')
  // Only the matched line changed; the trailing spaces elsewhere survive.
  assert.equal(patched.text, ['alpha', 'BETA', 'gamma', 'delta', ''].join('\n'))
})

test('a block padded with blank lines still matches, and multi-line runs work', () => {
  const patched = applyBlock(FILE, '\n\nalpha\nbeta\n\n', 'ALPHA\n')
  assert.equal(patched.ok, true)
  assert.equal(patched.text, ['ALPHA', 'gamma', 'delta', ''].join('\n'))
})

test('an unfindable block fails with the nearest line as a hint', () => {
  const missing = applyBlock(FILE, 'gamma-typo', 'x')
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /找不到/)
  assert.match(String(missing.nearest), /gamma/)
})

test('a whitespace-only or absent block never matches everything', () => {
  assert.equal(findBlock(FILE, '   \n\n').found, false)
  assert.equal(findBlock(FILE, '').found, false)
  assert.equal(nearest(FILE, '   ').nearest, undefined)
})

test('a fuzzy match keeps the file byte-identical outside the replaced run', () => {
  const file = ['one', 'two\t\t', 'three', 'four'].join('\n')
  const patched = applyBlock(file, 'two\nthree', 'TWO\nTHREE\nEXTRA')
  assert.equal(patched.ok, true)
  assert.equal(patched.text, ['one', 'TWO', 'THREE', 'EXTRA', 'four'].join('\n'))
})

test('blank padding dropped from the SEARCH is dropped from the REPLACE too', () => {
  // Found live: the vendor's block was "TARGET-LINE\n\n" => "FUZZY-DONE\n\n"
  // against a file with no blank line there; keeping the REPLACE's blank line
  // inserted one into the file.
  const file = 'keep-me\nTARGET-LINE   \nneighbour\n'
  const patched = applyBlock(file, 'TARGET-LINE\n\n', 'FUZZY-DONE\n\n')
  assert.equal(patched.ok, true)
  assert.equal(patched.text, 'keep-me\nFUZZY-DONE\nneighbour\n')
})

test('an intentional blank line in a block without padding survives', () => {
  const file = 'a\nX\nb\n'
  const patched = applyBlock(file, 'X', 'Y\n\nZ')
  assert.equal(patched.text, 'a\nY\n\nZ\nb\n')
})
