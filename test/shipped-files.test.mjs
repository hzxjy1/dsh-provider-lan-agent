/**
 * The package must not ship deployment identity.
 *
 * A "shipped file" is every path `package.json#files` would put in a tarball.
 * The source deliberately carries no vendor domain, account, host path, or
 * token location: those identify ONE deployment (see `src/deployment.js`), and
 * a tarball handed to someone else must not disclose them. A 10/8 origin is
 * exempt on purpose — it is not routable from outside and the route needs it.
 *
 * Runtime contract names are exempt on purpose: the delegation tool, the
 * provider route, the credential reference, and the CLI's HOME directory all
 * use the vendor's spelling and cannot change without breaking installed
 * deployments and stored credentials. This guard therefore targets
 * IDENTITIES, plus the capitalised product spelling in prose, which has no
 * runtime role.
 *
 * @module test/shipped-files.test
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * Expand `package.json#files` into the concrete files a tarball would contain.
 *
 * @returns {string[]} absolute paths.
 */
function shippedFiles() {
  const out = []
  for (const entry of pkg.files ?? []) {
    const full = join(ROOT, entry)
    if (statSync(full).isDirectory()) {
      for (const name of readdirSync(full, { recursive: true })) {
        const candidate = join(full, name)
        if (statSync(candidate).isFile()) out.push(candidate)
      }
    } else {
      out.push(full)
    }
  }
  return out
}

/** Identities that must never ship; assembled so this file is not itself a hit. */
const RULES = Object.freeze([
  { pattern: new RegExp('ai' + 'plus', 'i'), what: 'the vendor brand' },
  { pattern: new RegExp('desay' + 'sv', 'i'), what: 'the vendor domain' },
  { pattern: /\buids\d{4,}\b/, what: 'an employee account id' },
  { pattern: /\/mnt\/[a-z]\/(?:Users|home)\//, what: 'a Windows host path' },
  // The product spelling must never appear as a literal, in prose or in a
  // config value: runtime names are assembled (src/vendorName.js) or escaped
  // (cordis.patch.yml). This also covers the token path form.
  { pattern: new RegExp('code' + 'chat', 'i'), what: 'the vendor product spelling' },
])

test('shipped files: no deployment identity', () => {
  const files = shippedFiles()
  assert.ok(files.length > 0, 'package.json#files resolved to no files')
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const { pattern, what } of RULES) {
      assert.equal(pattern.test(text), false, `${relative(ROOT, file)} leaks ${what}`)
    }
  }
})
