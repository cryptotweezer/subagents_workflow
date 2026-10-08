import { expect, mock, test } from 'claude-code/testing'

import { readCall } from '../hooks/codex'
import { applyGoal, composeGoalsBrief, listGoals, readGoalCall } from '../hooks/goals'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const SCRIPT = 'C:/mod/bin/goals.mjs'

test('reads a goals call off a Bash command, and nothing off any other', () => {
  expect(readGoalCall('git status')).toBeUndefined()
  expect(readGoalCall(`node "${SCRIPT}" add "Build the invoice export"`)).toEqual({ action: 'add', target: 'Build the invoice export' })
  expect(readGoalCall(`G="${SCRIPT}"; node "$G" done 2`)).toEqual({ action: 'done', target: '2' })
  expect(readGoalCall(`node "${SCRIPT}" list`)).toBeUndefined()
})

test('keeps a finished goal listed, and finds one by number or by its words', () => {
  let goals = applyGoal([], { action: 'add', target: 'Build the invoice export' })

  goals = applyGoal(goals, { action: 'add', target: 'Redesign the dashboard' })
  goals = applyGoal(goals, { action: 'done', target: 'invoice' })

  expect(goals).toEqual([
    { id: 1, text: 'Build the invoice export', isDone: true },
    { id: 2, text: 'Redesign the dashboard', isDone: false },
  ])
  expect(listGoals(goals)).toBe('Session goals now:\n1. [x] Build the invoice export\n2. [ ] Redesign the dashboard')
  expect(applyGoal(goals, { action: 'undo', target: '1' })[0]?.isDone).toBe(false)
  expect(applyGoal(goals, { action: 'remove', target: '2' })).toHaveLength(1)
  expect(applyGoal(goals, { action: 'done', target: 'nothing like it' })).toEqual(goals)
  expect(composeGoalsBrief(SCRIPT)).toContain(`node "${SCRIPT}" add "short goal"`)
})

test('draws the goals as Claude sets them, a finished one struck through', async ($, on) => {
  mock.clock(on, { now: NOW })

  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: 'null' }

    return { value: { code: 0, signal: null } }
  })
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 200_000, percent: 12 }, rateLimits: [] },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '' }, text: 'GOALS {"ok":true}' }))

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({
    plugin: 'subagents-workflow',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'account-stats',
    props: { bodyColumns: 30 } as never,
  })
  const shown = async () => (await ui.find({ type: 'Box' }))?.text ?? ''

  expect(await shown()).toMatch(/SESSION GOALS +none yet/)

  await $.tool.call({ tool: 'Bash', command: `node "${SCRIPT}" add "Build the invoice export"` })

  const ran = await $.tool.call({ tool: 'Bash', command: `node "${SCRIPT}" add "Redesign the dashboard"` })

  expect(ran.context?.at(-1)).toMatch(/2\. \[ \] Redesign the dashboard/)

  await $.tool.call({ tool: 'Bash', command: `node "${SCRIPT}" done 1` })
  await ui.redraw()

  expect(await shown()).toMatch(/GOALS 1\/2 done/)
  expect((await ui.find({ type: 'Text', text: 'Build the invoice export' }))?.props.strikethrough).toBe(true)
  expect((await ui.find({ type: 'Text', text: 'Redesign the dashboard' }))?.props.strikethrough).toBe(false)
})

test('reads the command alone, never the text handed to another program', () => {
  const review = [
    'node "C:/mod/bin/codex-task.mjs" --model gpt-6-sol --mode read --title "review" <<\'TASK\'',
    'It parses `node "C:/x/goals.mjs" add "Build the export"` and `verdict rejected "x"`.',
    'TASK',
  ].join('\n')

  // A task that only talks about the goals script is a Codex task, and adds no goal.
  expect(readGoalCall(review)).toBeUndefined()
  expect(readCall(review)).toMatchObject({ kind: 'task', title: 'review' })
  // A goal's own words are not an action.
  expect(readGoalCall(`node "${SCRIPT}" add "Please remove the export"`)).toEqual({ action: 'add', target: 'Please remove the export' })
  expect(readGoalCall(`node "${SCRIPT}" add "Fix \\"done\\" handling"`)).toEqual({ action: 'add', target: 'Fix "done" handling' })
})

test('takes a number for an id only, and never repeats an id', () => {
  const goals = [{ id: 1, text: 'Build version 2 export', isDone: false }]

  expect(applyGoal(goals, { action: 'remove', target: '2' })).toEqual(goals)
  expect(applyGoal([{ id: 2, text: 'A', isDone: false }, { id: 1, text: 'B', isDone: false }], { action: 'add', target: 'C' }).at(-1)?.id).toBe(3)
})
