/**
 * Tolerant matching for the vendor's SEARCH / REPLACE blocks.
 *
 * The vendor's own client accepts a SEARCH block that differs from the file in
 * whitespace and line endings; DSH's `edit` tool matches exactly. So an edit the
 * vendor believes is exact can fail here, and its model then has to guess why.
 *
 * This module closes that gap without touching anything it did not match: the
 * file is compared line by line in *normalized* form (line endings unified,
 * trailing whitespace ignored), the matching run of lines is located in the
 * ORIGINAL array, and only that run is replaced. The rest of the file is written
 * back byte-for-byte, so a fuzzy match never reformats unrelated lines.
 *
 * @module src/fuzzy
 */

/** One line, normalized for comparison: no line ending, no trailing whitespace. */
function normalizeLine(line) {
  return String(line ?? '').replace(/\r$/, '').replace(/[ \t]+$/, '')
}

/**
 * Split into lines, remembering whether the text ended with a newline.
 *
 * The flag matters: writing a file back without its final newline silently
 * changes it (measured by a test that compared byte-for-byte).
 */
function splitText(text) {
  const value = String(text ?? '').replace(/\r\n?/g, '\n')
  const lines = value.split('\n')
  let trailing = false
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    trailing = true
    lines.pop()
  }
  return { lines, trailing }
}

/** `splitText` for callers that only need the lines. */
function splitLines(text) {
  return splitText(text).lines
}

/** Join lines back, restoring the trailing newline the text had. */
function joinLines(lines, trailing) {
  return `${lines.join('\n')}${trailing ? '\n' : ''}`
}

/**
 * Locate a SEARCH block in a file, tolerating whitespace differences.
 *
 * @param {string} fileText the file's current content.
 * @param {string} search the vendor's SEARCH block.
 * @returns {{ found: boolean, start: number, end: number, exact: boolean }}
 *   `start`/`end` are inclusive line indices in the original file; `exact` says
 *   whether the original lines matched verbatim (no tolerance was needed).
 */
export function findBlock(fileText, search) {
  const file = splitLines(fileText)
  const want = splitLines(search).map(normalizeLine)
  // A SEARCH block that is only whitespace would match everywhere; refuse it.
  if (want.length === 0 || want.every((line) => line.length === 0)) return { found: false, start: -1, end: -1, exact: false }
  const have = file.map(normalizeLine)
  // Drop leading/trailing blank lines of the block: the vendor often pads them.
  let first = 0
  let last = want.length - 1
  while (first <= last && want[first].length === 0) first += 1
  while (last >= first && want[last].length === 0) last -= 1
  const needle = want.slice(first, last + 1)
  if (needle.length === 0) return { found: false, start: -1, end: -1, exact: false }
  const padding = { leading: first, trailing: want.length - 1 - last }

  for (let start = 0; start + needle.length <= have.length; start += 1) {
    let matches = true
    for (let index = 0; index < needle.length; index += 1) {
      if (have[start + index] !== needle[index]) { matches = false; break }
    }
    if (!matches) continue
    const exact = file.slice(start, start + needle.length).join('\n') === needle.join('\n')
    return { found: true, start, end: start + needle.length - 1, exact, padding }
  }
  return { found: false, start: -1, end: -1, exact: false }
}

/**
 * Resolve one SEARCH / REPLACE pair to the exact strings an `edit` call needs.
 *
 * This is the same tolerant match as {@link applyBlock}, stopped one step
 * earlier: instead of writing the file itself, it returns the literal run of
 * lines that exists in the file (`oldString`) and the replacement lines
 * (`newString`). The plan-time resolver uses it so both execution routes can
 * send a plain, exact `edit`; `applyBlock` uses it so there is only one
 * definition of "what this block means".
 *
 * @param {string} fileText
 * @param {string} search
 * @param {string} replace
 * @returns {{ ok: true, exact: boolean, oldString: string, newString: string }
 *   | { ok: false, reason: string, nearest?: string }}
 */
export function resolveBlock(fileText, search, replace) {
  const hit = findBlock(fileText, search)
  if (!hit.found) {
    return { ok: false, reason: 'SEARCH 块在文件中找不到（含空白容错后仍找不到）', ...nearest(fileText, search) }
  }
  const file = splitLines(fileText)
  // Symmetric tolerance: blank padding the SEARCH block carried but the file did
  // not have is dropped from the REPLACE too. Without this, a block whose SEARCH
  // ended in a spurious blank line inserted one into the file (found live).
  const rawReplacement = splitLines(replace)
  const { leading, trailing: tailPad } = hit.padding ?? { leading: 0, trailing: 0 }
  // Only blank edge lines are trimmed, and never more than the SEARCH lost — a
  // REPLACE that legitimately starts or ends with blank lines keeps them.
  let from = 0
  while (from < leading && from < rawReplacement.length && normalizeLine(rawReplacement[from]).length === 0) from += 1
  let to = rawReplacement.length
  while (rawReplacement.length - to < tailPad && to > from && normalizeLine(rawReplacement[to - 1]).length === 0) to -= 1
  const replacement = rawReplacement.slice(from, to)
  return {
    ok: true,
    exact: hit.exact,
    oldString: file.slice(hit.start, hit.end + 1).join('\n'),
    newString: replacement.join('\n'),
    // Internal to this module: applyBlock needs the original array and position.
    lines: file,
    start: hit.start,
    end: hit.end,
    trailing: splitText(fileText).trailing,
    newLines: replacement,
  }
}

/**
 * Apply one SEARCH / REPLACE pair, falling back to a tolerant match.
 *
 * @param {string} fileText
 * @param {string} search
 * @param {string} replace
 * @returns {{ ok: true, text: string, exact: boolean } | { ok: false, reason: string, nearest?: string }}
 */
export function applyBlock(fileText, search, replace) {
  const resolved = resolveBlock(fileText, search, replace)
  if (resolved.ok !== true) {
    return { ok: false, reason: resolved.reason, ...resolved.nearest === undefined ? {} : { nearest: resolved.nearest } }
  }
  const text = joinLines([
    ...resolved.lines.slice(0, resolved.start),
    ...resolved.newLines,
    ...resolved.lines.slice(resolved.end + 1),
  ], resolved.trailing)
  return { ok: true, text, exact: resolved.exact }
}

/**
 * The closest run of lines, for an error the vendor's model can act on.
 *
 * @param {string} fileText
 * @param {string} search
 * @returns {{ nearest?: string }}
 */
export function nearest(fileText, search) {
  const file = splitLines(fileText)
  const want = splitLines(search).map(normalizeLine).filter((line) => line.length > 0)
  if (want.length === 0 || file.length === 0) return {}
  const probe = want[0]
  let best
  for (let index = 0; index < file.length; index += 1) {
    const line = normalizeLine(file[index])
    if (line.length === 0) continue
    let score = 0
    if (line === probe) score = 3
    else if (line.includes(probe) || probe.includes(line)) score = 2
    else if (probe.length > 3 && line.startsWith(probe.slice(0, Math.min(12, probe.length)))) score = 1
    if (score === 0) continue
    const same = want.filter((candidate, offset) => normalizeLine(file[index + offset]) === candidate).length
    const total = score + same
    if (best === undefined || total > best.total) best = { total, index, line }
  }
  if (best === undefined) return {}
  return { nearest: `最接近的是第 ${best.index + 1} 行：${JSON.stringify(best.line)}` }
}
