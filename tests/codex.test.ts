import { expect, mock, test } from 'claude-code/testing'

import { formatDuration, readCall, readOutcome } from '../hooks/codex'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const RUN = [
  'node "C:/mods/subagents-workflow/bin/codex-task.mjs" --model gpt-6-sol --mode write --title "rename helpers" <<\'TASK\'',
  'Rename the helpers in src/a.ts.',
  'Report the names changed.',
  'TASK',
].join('\n')
const LIMITS = JSON.stringify({
  rateLimits: [
    { kind: 'five_hour', percentUsed: 85, resetsAt: new Date(NOW + 2 * 3_600_000).toISOString() },
    { kind: 'seven_day', percentUsed: 40, resetsAt: new Date(NOW - 1000).toISOString() },
  ],
  readAt: NOW - 30 * 60_000,
})
const OUTPUT = 'CODEX_TASK {"ok":true,"model":"gpt-6-sol","mode":"write","tokens":2040,"durationMs":900}\nRenamed 3 files.'

test('reads a launcher call off a Bash command, and nothing off any other', () => {
  expect(readCall('git status')).toBeUndefined()
  expect(readCall(RUN)).toEqual({
    kind: 'task',
    title: 'rename helpers',
    task: 'Rename the helpers in src/a.ts.\nReport the names changed.',
    model: 'gpt-6-sol',
    mode: 'write',
  })
  expect(readCall('node x/codex-task.mjs --model gpt-6.1-sol --mode full --dir "C:/p" --resume abc --title "t" <<EOF\ngo\nEOF')).toMatchObject({
    mode: 'full',
    title: 't',
    task: 'go',
  })
  expect(readCall('L="x/codex-task.mjs"; node "$L" verdict fixed "second case"')).toMatchObject({ verdict: 'fixed', reason: 'second case' })
  expect(readCall('node bin/codex-task.mjs verdict rejected "broke tests"')).toEqual({
    kind: 'verdict',
    verdict: 'rejected',
    reason: 'broke tests',
  })
})

test('reads what the launcher printed', () => {
  expect(readOutcome(OUTPUT)).toEqual({ isReported: true, report: 'Renamed 3 files.', tokens: 2040, error: undefined })
  expect(readOutcome('CODEX_TASK {"ok":false,"error":"model not supported"}\n')).toMatchObject({
    isReported: false,
    error: 'model not supported',
  })
  expect(readOutcome('bash: node: command not found')).toMatchObject({ isReported: false })
  expect(formatDuration(125_000)).toBe('2m 05s')
})

test('follows a task from assignment to verdict in the pane', async ($, on) => {
  mock.clock(on, { now: NOW })

  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.spawn', async function* (_, e) {
    const isLimits = e.argv.some(part => part.endsWith('codex-limits.mjs'))

    yield { stream: 'stdout' as const, text: isLimits ? LIMITS : 'Logged in' }

    return { value: { code: 0, signal: null } }
  })
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 200_000, percent: 12 }, rateLimits: [] },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', (_, e) => ({
    result: { stdout: '', stderr: '' },
    text: e.tool === 'Bash' && e.command.includes('verdict') ? 'CODEX_VERDICT {"ok":true}' : OUTPUT,
  }))

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({
    plugin: 'subagents-workflow',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'account-stats',
    props: { bodyColumns: 30 } as never,
  })
  const shown = async () => (await ui.find({ type: 'Box' }))?.text ?? ''

  expect(await shown()).toMatch(/EXTERNAL AGENTS.*CODEX.*AGENT TASKS/)
  expect(await shown()).toMatch(/no tasks yet/)
  // Codex's own windows: one near its limit, one already reset, the reading half an hour old.
  expect(await shown()).toMatch(/CODEX 85% · 0%/)
  expect((await ui.find({ type: 'Text', text: '85% · 0%' }))?.props.color).toBe('#ff003c')

  await ui.press({ key: 'part:limits' })

  expect(await shown()).toMatch(/codex linked/)
  expect(await shown()).toMatch(/SESSION 85%/)
  expect(await shown()).toMatch(/in 2h 00m/)
  expect(await shown()).toMatch(/WEEK 0%/)
  expect(await shown()).toMatch(/as of 30m ago/)
  expect((await ui.find({ type: 'Text', text: '85%' }))?.props.color).toBe('#ff003c')

  const ran = await $.tool.call({ tool: 'Bash', command: RUN })

  expect(ran.text).toBe(OUTPUT)

  await ui.redraw()

  expect(await shown()).toMatch(/#1 rename helpers/)
  expect(await shown()).toMatch(/codex · gpt-6-sol · write/)
  expect(await shown()).toMatch(/█+░+ *codex/)
  expect(await shown()).toMatch(/reported · awaiting review/)
  expect(await shown()).not.toMatch(/tok\b/)

  await $.tool.call({ tool: 'Bash', command: 'node bin/codex-task.mjs verdict rejected "broke tests"' })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await ui.redraw()

  expect(await shown()).toMatch(/█{21} *codex/)
  expect(await shown()).toMatch(/reported · rejected *broke tests/)
  expect(await shown()).toMatch(/AGENT TASKS 0\/1 kept/)

  await ui.press({ key: 'task:1' })

  expect(await shown()).toMatch(/REPORT\s*Renamed 3 files\./)

  await ui.press({ key: 'tasks:clear' })

  expect(await shown()).toMatch(/no tasks yet/)
  expect(await ui.find({ key: 'tasks:clear' })).toBeUndefined()

  await ui.press({ key: 'part:tasks' })

  expect(await shown()).not.toMatch(/no tasks yet/)
})

test('keeps a task running when its call ends first, and lets a wait collect it', async ($, on) => {
  mock.clock(on, { now: NOW })

  let answer = 'CODEX_TASK {"ok":null,"running":true,"id":"abc-1","model":"gpt-6.1-sol","mode":"read"}\nCodex is still working.'

  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: 'null' }

    return { value: { code: 0, signal: null } }
  })
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 200_000, percent: 12 }, rateLimits: [] },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '' }, text: answer }))

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({
    plugin: 'subagents-workflow',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'account-stats',
    props: { bodyColumns: 30 } as never,
  })
  const shown = async () => (await ui.find({ type: 'Box' }))?.text ?? ''

  await $.tool.call({ tool: 'Bash', command: RUN })
  await ui.redraw()

  expect(await shown()).toMatch(/AGENT TASKS codex working #1/)
  expect(await shown()).toMatch(/working · /)

  // Still not done on the first wait, done on the second.
  await $.tool.call({ tool: 'Bash', command: 'node "C:/mods/subagents-workflow/bin/codex-task.mjs" wait abc-1' })
  await ui.redraw()

  expect(await shown()).toMatch(/working · /)

  answer = OUTPUT

  await $.tool.call({ tool: 'Bash', command: 'node "C:/mods/subagents-workflow/bin/codex-task.mjs" wait abc-1' })
  await ui.redraw()

  expect(await shown()).toMatch(/reported · awaiting review/)
  expect(readCall('node x/codex-task.mjs wait abc-1')).toEqual({ kind: 'wait', ref: 'abc-1' })
  expect(readOutcome('Command did not complete within its 600s timeout and was moved to the background (ID: x).')).toMatchObject({
    isRunning: true,
  })
})
