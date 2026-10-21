/**
 * Plan-time file reads for SEARCH/REPLACE resolution.
 *
 * Reads are limited to the session workspace and the resolved mapping targets:
 * the resolver must not become a way to read a file the sandboxed `edit` would
 * refuse. Both runners use this, so the guard exists once.
 *
 * @module src/vendor/documents
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

/** Is `path` inside `root` (segment boundary, not string prefix)? */
function inside(path, root) {
  const base = String(root ?? '').replace(/\/+$/, '')
  return base.length > 0 && (path === base || path.startsWith(`${base}/`))
}

/**
 * @param {string} workspace the session workspace.
 * @param {readonly {from: string, to: string}[]} mappings resolved mappings.
 * @returns {(path: string) => Promise<string|undefined>}
 */
export function createDocumentReader(workspace, mappings) {
  const roots = [workspace, ...mappings.map((mapping) => mapping.to)]
    .filter((root) => typeof root === 'string' && root.length > 0)
  return async (path) => {
    const absolute = isAbsolute(path) ? path : resolve(workspace, path)
    if (!roots.some((root) => inside(absolute, isAbsolute(root) ? root : resolve(workspace, root)))) return undefined
    try {
      return await readFile(absolute, 'utf8')
    } catch {
      return undefined
    }
  }
}
