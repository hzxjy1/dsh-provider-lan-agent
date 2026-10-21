/**
 * A small, bounded audit log for vendor tool requests.
 *
 * Why this exists: when the bridge refuses a tool name, nothing reaches
 * `ctx.tools.execute()`, so DSH logs nothing, the session log shows nothing,
 * and the only trace is a warning on the host's stdout — which in a GUI session
 * nobody reads. Twice now that gap turned a one-line diagnosis into guesswork.
 * One appended line per vendor request closes it.
 *
 * Arguments are clipped before they are written: a `write_to_file` argument map
 * carries whole files, and an audit log is not a place to accumulate user
 * content. The file is capped and truncated in place when it outgrows the cap.
 *
 * @module src/audit
 */

import { appendFileSync, statSync, writeFileSync } from 'node:fs'

/** Default cap: enough for thousands of request lines, small enough to ignore. */
const DEFAULT_MAX_BYTES = 262_144

/** Default per-record clip for the serialized argument map. */
const DEFAULT_MAX_ARGS_CHARS = 600

/** Clip one JSON-serialized value, marking the cut. */
function clip(value, limit) {
  let text
  try {
    text = JSON.stringify(value ?? null)
  } catch {
    text = String(value)
  }
  if (typeof text !== 'string') text = String(text)
  return text.length <= limit ? text : `${text.slice(0, limit)}…[+${text.length - limit}]`
}

/**
 * Create the audit sink.
 *
 * @param {string} file absolute path of the JSONL audit file.
 * @param {object} [options]
 * @param {number} [options.maxBytes]
 * @param {number} [options.maxArgsChars]
 * @param {{debug?: Function, warn?: Function}} [options.logger]
 * @returns {(record: {name: string, args?: unknown, ok?: boolean, detail?: string}) => void}
 */
export function createAuditWriter(file, { maxBytes = DEFAULT_MAX_BYTES, maxArgsChars = DEFAULT_MAX_ARGS_CHARS, logger } = {}) {
  let failed = false
  return (record) => {
    if (failed) return
    try {
      let size = 0
      try {
        size = statSync(file).size
      } catch {
        size = 0
      }
      if (size > maxBytes) {
        // One truncation, not a rotation chain: this file exists to answer
        // "what did the vendor just ask for", and old lines have served that.
        writeFileSync(file, `${JSON.stringify({ time: Date.now(), truncated: true, note: `audit log exceeded ${maxBytes} bytes` })}\n`)
      }
      // `detail` is already a string and is stored as one; only the argument
      // map needs serializing (and clipping).
      const detail = record.detail === undefined ? undefined : String(record.detail).slice(0, 300)
      appendFileSync(file, `${JSON.stringify({
        time: Date.now(),
        name: record.name,
        ok: record.ok ?? null,
        ...record.durationMs === undefined ? {} : { durationMs: record.durationMs },
        // Which DSH tool actually ran, and by which route: filled by the
        // dispatcher, which is the only layer that knows (design notes §16).
        ...record.dshTool === undefined ? {} : { dshTool: record.dshTool },
        ...record.route === undefined ? {} : { route: record.route },
        ...detail === undefined ? {} : { detail: detail.length <= 300 ? detail : `${detail.slice(0, 300)}…` },
        ...detail !== undefined || record.summary === undefined ? {} : { summary: record.summary },
        args: clip(record.args, maxArgsChars),
      })}\n`)
    } catch (error) {
      // A diagnostic that breaks the turn it was meant to explain is worse than
      // no diagnostic: report once, then stay quiet.
      failed = true
      logger?.warn?.(`lanagent: tool audit log unavailable (${error instanceof Error ? error.message : String(error)}); continuing without it`)
    }
  }
}
