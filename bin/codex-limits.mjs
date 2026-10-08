#!/usr/bin/env node
// Prints the Codex account's rate limits as JSON, read off the newest session file Codex wrote: every run of
// it, the launcher's or the person's own, records them there. Prints `null` when none is found.
//
//   {"rateLimits":[{"kind":"five_hour","percentUsed":1,"resetsAt":"2026-10-07T..."}, ...],"readAt":1791...}
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SESSIONS = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')
// How many of the newest files are tried: a run cut short may have written none.
const TRIED_FILES = 5
// How many day folders back a resumed session is looked for.
const SCANNED_DAYS = 14
const KINDS = { 300: 'five_hour', 10080: 'seven_day' }

const newestFirst = directory => {
  try {
    return readdirSync(directory).sort().reverse()
  } catch {
    return []
  }
}

// When a file was last written, or 0 for one that vanished while being looked at.
const writtenAt = file => {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

// Session files live under year/month/day, named for when they began: a session resumed days later is
// written again in its old folder, so the newest folders are gathered and ordered by when they were written.
function sessionFiles() {
  const files = []
  let days = 0

  for (const year of newestFirst(SESSIONS)) {
    for (const month of newestFirst(join(SESSIONS, year))) {
      for (const day of newestFirst(join(SESSIONS, year, month))) {
        if ((days += 1) > SCANNED_DAYS) {
          return files
        }

        for (const name of newestFirst(join(SESSIONS, year, month, day)).filter(entry => entry.endsWith('.jsonl'))) {
          files.push(join(SESSIONS, year, month, day, name))
        }
      }
    }
  }

  return files
}

// The `rate_limits` object wherever an event carries it.
function find(value) {
  if (value === null || typeof value !== 'object') {
    return undefined
  }

  if (value.rate_limits?.primary != null || value.rate_limits?.secondary != null) {
    return value.rate_limits
  }

  for (const inner of Object.values(value)) {
    const found = find(inner)

    if (found !== undefined) {
      return found
    }
  }

  return undefined
}

function read(file) {
  let lines

  try {
    lines = readFileSync(file, 'utf8').split('\n')
  } catch {
    // Removed or locked since it was listed: the next file will do.
    return undefined
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].includes('"rate_limits"')) {
      continue
    }

    try {
      const limits = find(JSON.parse(lines[index]))

      if (limits !== undefined) {
        return limits
      }
    } catch {
      // A line cut short while Codex was writing it: the one before it will do.
    }
  }

  return undefined
}

const newest = sessionFiles()
  .map(file => ({ file, at: writtenAt(file) }))
  .sort((a, b) => b.at - a.at)
  .slice(0, TRIED_FILES)

for (const { file, at } of newest) {
  const limits = read(file)

  if (limits === undefined) {
    continue
  }

  const rateLimits = [limits.primary, limits.secondary]
    .filter(window => window !== undefined && window !== null)
    .map(window => ({
      kind: KINDS[window.window_minutes] ?? `${window.window_minutes}m`,
      percentUsed: window.used_percent,
      resetsAt: window.resets_at === undefined ? undefined : new Date(window.resets_at * 1000).toISOString(),
    }))

  console.log(JSON.stringify({ rateLimits, readAt: Math.round(at) }))
  process.exit(0)
}

console.log('null')
