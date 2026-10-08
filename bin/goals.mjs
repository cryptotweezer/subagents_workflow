#!/usr/bin/env node
// Keeps the session's goals in the subagents-workflow pane. The mod watches these calls and holds the list; this
// script only checks the call and echoes it.
//
//   node goals.mjs add "Build the invoice export"
//   node goals.mjs done 2            (or part of the goal's text: done "invoice")
//   node goals.mjs undo 2
//   node goals.mjs remove 2
const ACTIONS = ['add', 'done', 'undo', 'remove']
const [action, ...rest] = process.argv.slice(2)
const target = rest.join(' ').trim()

if (!ACTIONS.includes(action) || target === '') {
  console.log(`GOALS ${JSON.stringify({ ok: false, error: `usage: goals.mjs ${ACTIONS.join('|')} "<text or number>"` })}`)
  process.exit(1)
}

console.log(`GOALS ${JSON.stringify({ ok: true, action, target })}`)
