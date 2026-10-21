#!/usr/bin/env node
/**
 * Harvest real tool outcomes from lanagent session logs.
 *
 * WHY
 * ---
 * The contract tests need outcomes that DSH actually rendered, not shapes we
 * imagined. A loop-route call comes back as `content` text (sometimes with a
 * structured value embedded by the PTC sentinel); the bridge gets a structured
 * `value` directly. Harvesting pairs of "same call, text + value" is what makes
 * the two outcome variants comparable.
 *
 * This script is a maintainer tool, not part of the shipped package:
 *
 *   node scripts/contract/harvest.mjs --sessions ~/.dsh/sessions --out /tmp/lanagent-pool.json
 *
 * It reads only session logs, writes one JSON file, and never touches the
 * plugin's runtime state. Fixtures derived from the pool are curated by hand
 * (test/contract/fixtures.json); the pool itself is not committed because it
 * contains user commands and file content.
 *
 * @module scripts/contract/harvest
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SENTINEL_OPEN = '<<<LANAGENT-RESULT>>>'
const SENTINEL_CLOSE = '<<<LANAGENT-END>>>'
const MAX_TEXT = 1600
const MAX_PER_TOOL = 8

function parseArgs(argv) {
  const args = { sessions: '', out: '', max: MAX_PER_TOOL, provider: 'lanagent' }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--sessions') { args.sessions = value; index += 1 }
    else if (flag === '--out') { args.out = value; index += 1 }
    else if (flag === '--max') { args.max = Number(value); index += 1 }
    else if (flag === '--provider') { args.provider = String(value); index += 1 }
    else if (flag === '--help') { args.help = true }
  }
  return args
}

/** Every session log below one directory, in a stable order. */
function findSessionLogs(root) {
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const stats = statSync(path)
      if (stats.isDirectory()) walk(path)
      else if (name === 'session.v4.jsonl.zstd') files.push(path)
    }
  }
  walk(root)
  return files
}

/** Replace host-specific paths and names; fixtures must not carry them. */
export function sanitize(value) {
  if (typeof value === 'string') {
    return value
      .replace(/\/mnt\/[a-z]\/[^/\s"'`]+\/[^/\s"'`]+/g, '/workspace')
      .replace(/\/home\/user\b/g, '/home/user')
      .replace(/\buser\b/g, 'user')
      .replace(/\buids\d+\b/g, 'user')
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '10.0.0.1')
  }
  if (Array.isArray(value)) return value.map(sanitize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]))
  }
  return value
}

/** Keep a sample readable but small; fixtures are examples, not archives. */
function clip(text, limit = MAX_TEXT) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

function clipValue(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return value
  if (Array.isArray(value)) return value.slice(0, 8).map((entry) => clipValue(entry, depth + 1))
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.length > 500) out[key] = `${entry.slice(0, 500)}…`
    else out[key] = clipValue(entry, depth + 1)
  }
  return out
}

function textOf(content) {
  return (Array.isArray(content) ? content : [])
    .map((block) => (block !== null && typeof block === 'object' && block.type === 'text' ? String(block.text ?? '') : ''))
    .filter((part) => part.length > 0)
    .join('\n')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.sessions === '' || args.out === '') {
    console.error('usage: node scripts/contract/harvest.mjs --sessions <dir> --out <file> [--max N] [--provider <route>]')
    process.exit(args.help ? 0 : 2)
  }

  const byTool = new Map()
  const seen = new Set()
  let lanagentSessions = 0
  let paired = 0
  let textOnly = 0

  const keep = (tool, sample) => {
    const key = `${tool}\u0000${JSON.stringify(sample.arguments)}\u0000${sample.text.slice(0, 120)}`
    if (seen.has(key)) return
    seen.add(key)
    const list = byTool.get(tool) ?? []
    if (list.length >= args.max) return
    list.push(sample)
    byTool.set(tool, list)
  }

  for (const file of findSessionLogs(args.sessions)) {
    let text
    try {
      text = execFileSync('zstd', ['-dc', file], { maxBuffer: 128 * 1024 * 1024 }).toString()
    } catch {
      continue
    }
    const events = []
    let isLanAgent = false
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event.type === 'model/selection' && event.data?.provider === args.provider) isLanAgent = true
      events.push(event)
    }
    if (!isLanAgent) continue
    lanagentSessions += 1

    const dispatches = []
    const results = new Map()
    for (const event of events) {
      if (event.type === 'tool/ptc-dispatch') dispatches.push(event)
      else if (event.type === 'tool/call') dispatches.push({ type: 'call', seq: event.seq, data: event.data })
      else if (event.type === 'tool/result') results.set(String(event.data?.message?.toolCallId ?? ''), event)
    }

    for (const [callId, result] of results) {
      const content = textOf(result.data?.message?.content)
      const start = content.indexOf(SENTINEL_OPEN)
      const end = content.indexOf(SENTINEL_CLOSE)
      if (start === -1 || end === -1) continue
      let payload
      try { payload = JSON.parse(content.slice(start + SENTINEL_OPEN.length, end)) } catch { continue }
      if (!Array.isArray(payload)) continue
      const related = dispatches
        .filter((entry) => String(entry.data?.rootCallId ?? '') === callId)
        .sort((left, right) => left.seq - right.seq)
      related.forEach((entry, index) => {
        if (entry.type !== 'tool/ptc-dispatch') return
        const outcome = payload[index]
        if (outcome === undefined) return
        const tool = String(entry.data?.name ?? '')
        const argumentsValue = sanitize(entry.data?.arguments ?? {})
        const rendered = clip(sanitize(textOf(entry.data?.content)))
        paired += 1
        keep(tool, {
          provenance: { session: file.split('/').slice(-2)[0], seq: entry.seq, kind: 'ptc-dispatch' },
          dshTool: tool,
          arguments: argumentsValue,
          isError: entry.data?.isError === true || outcome.ok !== true,
          text: rendered,
          value: outcome.ok === true ? clipValue(sanitize(outcome.value)) : undefined,
        })
      })
    }

    for (const event of events) {
      if (event.type !== 'tool/call') continue
      const callId = String(event.data?.callId ?? '')
      const result = results.get(callId)
      if (result === undefined) continue
      const content = textOf(result.data?.message?.content)
      if (content.includes(SENTINEL_OPEN)) continue
      const argumentsValue = (() => {
        try { return sanitize(JSON.parse(event.data?.arguments ?? '{}')) } catch { return {} }
      })()
      textOnly += 1
      keep(String(event.data?.name ?? ''), {
        provenance: { session: file.split('/').slice(-2)[0], seq: event.seq, kind: 'tool/call' },
        dshTool: String(event.data?.name ?? ''),
        arguments: argumentsValue,
        isError: result.data?.message?.isError === true,
        text: clip(sanitize(content)),
        value: undefined,
      })
    }
  }

  const samples = Object.fromEntries([...byTool].sort(([left], [right]) => left.localeCompare(right)))
  const summary = Object.entries(samples).map(([tool, list]) => ({ tool, count: list.length }))
  writeFileSync(args.out, `${JSON.stringify({ generatedAt: new Date().toISOString(), lanagentSessions, paired, textOnly, summary, samples }, null, 2)}\n`)
  console.log(JSON.stringify({ out: args.out, lanagentSessions, paired, textOnly, summary }, null, 2))
}

if (import.meta.url === `file://${process.argv[1]}`) main()
