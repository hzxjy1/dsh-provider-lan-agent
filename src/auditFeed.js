/**
 * Audit feed for the settings panel.
 *
 * The panel is a browser surface, so it reads the same JSONL the Host writes
 * through one same-origin route rather than a typed Remote binding: the file is
 * already the single source of truth for "what did the vendor ask us to run",
 * and a route keeps the read side trivial (design notes §16, §19).
 *
 * The tail is what matters — the newest requests — so this reads the file and
 * takes the last `limit` parseable lines, newest first. A line that does not
 * parse is skipped rather than failing the whole feed: a half-written tail line
 * is normal for an append-only file read at the wrong moment.
 *
 * @module src/auditFeed
 */

import { readFileSync, statSync } from 'node:fs'

/** Largest file this module will read, matching the writer's own cap. */
const MAX_READ_BYTES = 1_048_576

/**
 * Read the newest audit records.
 *
 * @param {string} file absolute path of the JSONL audit file.
 * @param {object} [options]
 * @param {number} [options.limit] maximum records to return.
 * @returns {{ enabled: boolean, file: string, records: object[], size: number, error?: string }}
 */
export function readAuditTail(file, { limit = 200 } = {}) {
  if (typeof file !== 'string' || file.length === 0) {
    return { enabled: false, file: '', records: [], size: 0 }
  }
  let text
  let size = 0
  try {
    size = statSync(file).size
    if (size > MAX_READ_BYTES) {
      return { enabled: true, file, records: [], size, error: `audit file is ${size} bytes; refusing to read past ${MAX_READ_BYTES}` }
    }
    text = readFileSync(file, 'utf8')
  } catch (error) {
    // A missing file is the normal state before the first tool call.
    return { enabled: true, file, records: [], size: 0, ...error?.code === 'ENOENT' ? {} : { error: String(error?.message ?? error) } }
  }
  const lines = text.split('\n')
  const records = []
  for (let index = lines.length - 1; index >= 0 && records.length < limit; index -= 1) {
    const line = lines[index].trim()
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object') records.push(parsed)
    } catch {
      // A truncated final line, or a hand-edited file: skip it.
    }
  }
  return { enabled: true, file, records, size }
}
