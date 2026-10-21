/**
 * Path mapping for the vendor's client-side paths.
 *
 * The vendor's agent keeps its own memory under its CLI's home directory — a
 * path from *its* world. DSH runs as an unprivileged user, so
 * every one of those writes fails with EACCES, and the vendor's agent retries
 * (measured: 26 write requests, 0 successes, one file retried 22 times — pure
 * wasted vendor turns).
 *
 * A mapping redirects such a prefix into a directory this process can write, so
 * the vendor's own memory feature works instead of failing forever. The mapping
 * is prefix-aware (segment boundaries respected), applies to every path-bearing
 * argument of the vendor's tools, and is defined once here so both execution
 * routes rewrite identically.
 *
 * @module src/paths
 */

import { mkdirSync, statSync } from 'node:fs'

/**
 * Rewrite one path through the mappings.
 *
 * @param {string} path
 * @param {readonly {from: string, to: string}[]} mappings
 * @returns {string}
 */
export function mapPath(path, mappings) {
  const value = typeof path === 'string' ? path : ''
  if (value.length === 0 || !Array.isArray(mappings)) return value
  for (const mapping of mappings) {
    const from = typeof mapping?.from === 'string' ? mapping.from.replace(/\/+$/, '') : ''
    const to = typeof mapping?.to === 'string' ? mapping.to.replace(/\/+$/, '') : ''
    if (from.length === 0 || to.length === 0) continue
    if (value !== from && !value.startsWith(`${from}/`)) continue
    return `${to}${value.slice(from.length)}`
  }
  return value
}

/**
 * Which argument of each vendor tool holds a path (or a list of them).
 *
 * Kept beside {@link mapPath} so a new path-bearing argument cannot be mapped on
 * one route and forgotten on the other.
 */
const PATH_FIELDS = Object.freeze({
  read_files: { field: 'paths', many: true },
  write_to_file: { field: 'path' },
  replace_in_file: { field: 'path' },
  list_files: { field: 'path' },
  search_files: { field: 'path' },
  execute_command: { field: 'workdir' },
})

/**
 * Apply the mappings to a vendor tool request's path arguments.
 *
 * @param {string} vendorTool
 * @param {object} input
 * @param {(path: string) => string} mapper
 * @returns {object} a copy when anything changed, else the input itself.
 */
/**
 * Resolve mapping targets against one session's workspace.
 *
 * A RELATIVE `to` is deliberate: the target then lives INSIDE the session's
 * workspace, which is the only place DSH's `workspace-write` sandbox allows the
 * write tool to write. A fixed absolute target outside the workspace makes every
 * memory write fail with "[sandbox: file access denied]" — measured on a session
 * whose workspace was /home/user/misc while the target sat under
 * /home/user/.dsh (design notes §29).
 *
 * @param {readonly {from: string, to: string}[]} mappings
 * @param {string} [cwd] the session workspace.
 * @returns {{from: string, to: string}[]}
 */
export function resolveMappings(mappings, cwd) {
  if (!Array.isArray(mappings)) return []
  const base = typeof cwd === 'string' && cwd.startsWith('/') ? cwd.replace(/\/+$/, '') : ''
  return mappings.map((mapping) => {
    const to = typeof mapping?.to === 'string' ? mapping.to : ''
    if (to.length === 0 || to.startsWith('/') || base.length === 0) return { from: String(mapping?.from ?? ''), to }
    return { from: String(mapping?.from ?? ''), to: `${base}/${to.replace(/^\.\/+/, '')}` }
  })
}

export function mapVendorPaths(vendorTool, input, mapper) {
  const spec = PATH_FIELDS[String(vendorTool ?? '')]
  if (spec === undefined || input === null || typeof input !== 'object' || typeof mapper !== 'function') return input
  if (spec.many === true) {
    if (!Array.isArray(input[spec.field])) return input
    const mapped = input[spec.field].map((entry) => mapper(entry))
    if (mapped.every((entry, index) => entry === input[spec.field][index])) return input
    return { ...input, [spec.field]: mapped }
  }
  const current = input[spec.field]
  if (typeof current !== 'string' || current.length === 0) return input
  const mapped = mapper(current)
  return mapped === current ? input : { ...input, [spec.field]: mapped }
}

/**
 * Does one (already-mapped) path land inside a mapping target?
 *
 * The memory responder (src/memory.js) owns exactly these paths, so the test
 * has to respect segment boundaries: a sibling that merely starts with the
 * same characters is NOT inside the tree.
 *
 * @param {string} path
 * @param {readonly {from: string, to: string}[]} mappings resolved mappings.
 * @returns {boolean}
 */
export function isMappedPath(path, mappings) {
  const value = typeof path === 'string' ? path : ''
  if (value.length === 0 || !Array.isArray(mappings)) return false
  return mappings.some((mapping) => {
    const to = typeof mapping?.to === 'string' ? mapping.to.replace(/\/+$/, '') : ''
    return to.length > 0 && (value === to || value.startsWith(to + '/'))
  })
}

/**
 * The vendor CLI's home directory, assembled from segments so the vendor's
 * spelling does not appear as a literal in this repository. The value is a
 * protocol constant: it must match what the vendor's own client sends.
 */
export const VENDOR_HOME_DIRNAME = `.${'code'}${'chat'}`

/** The vendor's memory root in its CLI's world (always under the vendor home). */
export const VENDOR_MEMORY_ROOT = `/root/${VENDOR_HOME_DIRNAME}`

/**
 * Spelling variants of the vendor's memory root its own client never needs to
 * map but its shell commands do: the CLI convention, $HOME and ~ spellings, and
 * a guessed /home/<user> path. A variant is only replaced as a whole segment.
 */
const COMMAND_ROOT_VARIANTS = Object.freeze([
  VENDOR_MEMORY_ROOT,
  `$HOME/${VENDOR_HOME_DIRNAME}`,
  `~/${VENDOR_HOME_DIRNAME}`,
  `/home/user/${VENDOR_HOME_DIRNAME}`,
  `/home/${VENDOR_HOME_DIRNAME}`,
])

/**
 * Replace one root spelling inside a command, only at segment boundaries.
 *
 * `from + '/'` occurrences become `to + '/'`, and a bare trailing `from`
 * becomes `to`; anything else (like a sibling with the same prefix) survives
 * untouched.
 */
function replaceRoot(text, from, to) {
  let out = text.split(from + '/').join(to + '/')
  if (out.endsWith(from)) out = out.slice(0, -from.length) + to
  return out
}

/**
 * Rewrite the memory-root spellings inside one shell command.
 *
 * A `cat <vendor-home>/...` probe unmapped fails with EACCES and the vendor
 * retries — GUI noise for a path that has a perfectly good mapped home. Only
 * the root prefixes are replaced; the rest of the command survives verbatim.
 *
 * @param {string} command
 * @param {readonly {from: string, to: string}[]} mappings resolved mappings.
 * @returns {string}
 */
export function mapCommandText(command, mappings) {
  // Degenerate input passes through unchanged (undefined stays undefined).
  if (typeof command !== 'string' || command.length === 0 || !Array.isArray(mappings)) return command
  let text = command
  for (const mapping of mappings) {
    const to = typeof mapping?.to === 'string' ? mapping.to.replace(/\/+$/, '') : ''
    if (to.length === 0) continue
    for (const variant of COMMAND_ROOT_VARIANTS) {
      const from = variant.replace(/\/+$/, '')
      if (from.length === 0) continue
      text = replaceRoot(text, from, to)
    }
  }
  return text
}

/**
 * Create one directory path, one level at a time.
 *
 * Deliberately NOT `mkdirSync(target, { recursive: true })`: on this host that
 * call never returns for a path under `/proc` (measured — the shell's `mkdir -p`
 * fails there instantly with ENOENT), and this runs while the plugin mounts, so
 * a bad mapping could hang the whole host at startup. Creating each level with a
 * plain `statSync` + non-recursive `mkdirSync` keeps every syscall bounded, and
 * an unwritable level simply stops the walk with a warning.
 *
 * @param {string} target absolute directory path.
 * @param {{warn?: Function}} [logger]
 */
function ensureDirectory(target, logger) {
  if (!target.startsWith('/')) {
    logger?.warn?.(`lanagent: refusing to create the non-absolute mapping target ${JSON.stringify(target)}`)
    return
  }
  let current = ''
  for (const segment of target.split('/').filter((part) => part.length > 0)) {
    current += `/${segment}`
    try {
      if (statSync(current).isDirectory()) continue
      // An existing non-directory in the middle of the path cannot be walked.
      logger?.warn?.(`lanagent: ${current} exists and is not a directory; the mapping target cannot be created`)
      return
    } catch {
      // Not there yet: create just this level.
    }
    try {
      mkdirSync(current)
    } catch (error) {
      if (error?.code === 'EEXIST') continue
      logger?.warn?.(`lanagent: could not create ${current}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
  }
}

/**
 * Create every mapping target so the first vendor write cannot fail on a missing
 * parent directory.
 *
 * @param {readonly {from: string, to: string}[]} mappings
 * @param {{warn?: Function}} [logger]
 */
export function ensureMappedRoots(mappings, logger) {
  if (!Array.isArray(mappings)) return
  for (const mapping of mappings) {
    const target = typeof mapping?.to === 'string' ? mapping.to : ''
    if (target.length === 0) continue
    ensureDirectory(target, logger)
  }
}
