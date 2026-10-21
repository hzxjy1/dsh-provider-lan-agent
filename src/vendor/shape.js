/**
 * Vendor-facing result shapes: one place that turns a DSH outcome into the
 * payload the vendor's model was trained to read.
 *
 * The seam receives an outcome whose fidelity depends on the execution route:
 * the bridge has `value` (the tool's structured output), the loop has only the
 * rendered `text` from `ToolResultMessage`. This module branches on the data,
 * never on the route, so both routes converge here.
 *
 * The text-only paths are not an afterthought: they parse the exact renderings
 * DSH produces, and the contract fixtures pin those renderings.
 *
 * @module src/vendor/shape
 */

import {
  contentText,
  formatExecuteCommand,
  formatGrepValue,
  formatReadValue,
  toWorkspaceRelative,
} from '../tools.js'
import { parseGlobText, stripReadRendering } from '../loopPlan.js'

/** A `{content}` answer carrying one text block. */
export function textAnswer(text) {
  return { content: [{ type: 'text', text }] }
}

/** The vendor's error envelope. */
export function errorAnswer(message) {
  return { error: { code: -10001, message: String(message) } }
}

/** Did this call fail, by DSH's flag or by the rendered text? */
export function failed(call) {
  return call?.isError === true || /^Error[:：]/.test(String(call?.text ?? '').trim())
}

/** JSON text, exactly how the vendor client sends structured payloads. */
export function jsonAnswer(value) {
  return textAnswer(JSON.stringify(value))
}

/**
 * `execute_command` output.
 *
 * A non-zero exit is still `success: true`: the vendor's client puts the failure
 * in `output`, and its model reads the exit code there instead of losing it.
 */
export function commandOutput(call) {
  if (call?.value !== undefined && call?.value !== null) return formatExecuteCommand(call.value)
  return JSON.stringify({ success: true, output: String(call?.text ?? '').trimEnd(), error: '' })
}

/** Bare file content, from `value.lines` when present, else from the rendering. */
export function readContent(call) {
  if (Array.isArray(call?.value?.lines)) return formatReadValue(call.value)
  return stripReadRendering(String(call?.text ?? ''))
}

/** Workspace-relative paths, from `value.paths` or from the rendered list. */
export function globPaths(call, cwd) {
  if (Array.isArray(call?.value?.paths)) {
    return call.value.paths.map((entry) => toWorkspaceRelative(String(entry), cwd))
  }
  return parseGlobText(String(call?.text ?? ''), cwd)
}

/** `grep`'s vendor text: `path:line:text`, one per match. */
export function grepText(call) {
  if (Array.isArray(call?.value?.matches)) return formatGrepValue(call.value)
  return parseGrepRendering(String(call?.text ?? ''))
}

/** An MCP call's content: rendered text when available, else the value JSON. */
export function mcpText(call) {
  if (call?.value !== undefined && call?.value !== null) {
    const text = contentText({ content: call.value.content })
    if (text.length > 0) return text
  }
  const rendered = String(call?.text ?? '')
  if (rendered.length > 0) return rendered
  return call?.value === undefined ? '' : JSON.stringify(call.value)
}

/**
 * Parse DSH's `grep` rendering into the vendor's `path:line:text` lines.
 *
 * The rendering is:
 *
 *   Found 2 matches
 *
 *   path/one.js
 *   Line 12: const x = 1
 *   ...
 *
 * A line that already looks like `path:line:text` is kept as is, so a future
 * renderer change does not silently produce garbage.
 *
 * @param {string} text
 * @returns {string}
 */
export function parseGrepRendering(text) {
  const source = String(text ?? '')
  if (/^No matches found\b/.test(source.trim())) return 'No matches found'
  const out = []
  let currentPath = ''
  for (const raw of source.split('\n')) {
    const line = raw.trimEnd()
    if (line.length === 0) continue
    if (/^Found \d+ match/.test(line)) continue
    const inline = /^(.+?):(\d+):(.*)$/.exec(line)
    if (inline !== null) {
      out.push(`${inline[1]}:${inline[2]}:${inline[3]}`)
      continue
    }
    const match = /^Line (\d+): ?(.*)$/.exec(line)
    if (match !== null && currentPath.length > 0) {
      out.push(`${currentPath}:${match[1]}:${match[2]}`)
      continue
    }
    currentPath = line
  }
  return out.length === 0 ? 'No matches found' : out.join('\n')
}
