import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  AccountPanelCurrent,
  AccountPanelOpenMenu,
  AccountPanelView,
  CacheRenewedAt,
  ExternalLimits,
  ExternalLink,
  ExternalTask,
  SessionGoal,
} from '../types'
import { KEPT_RUNS, composeBrief, cut, formatDuration, readCall, readOutcome, readRuns, toRecord } from './codex'
import type { CodexCall, CodexOutcome } from './codex'
import { applyGoal, composeGoalsBrief, listGoals, readGoalCall } from './goals'
import { composeSubagentsBrief, readAgentAnswer, sumUsage } from './subagents'
import { formatBar, formatModelName, formatRemaining, toLines, toRows } from './format'
import type { Level, Row } from './format'

const PANE = 'account-stats'
const TITLE = 'Subagents Workflow'
const COMMAND = 'panel'
const TICK_MS = 60_000
// The prompt cache's lifetime on a subscription; the engine does not report it.
const CACHE_TTL_MS = 60 * 60_000
const MAX_BAR = 28
// The context fill from which /compact is pointed at.
const COMPACT_AT = 70
// Run at a click, in the order drawn; `fill` ones take arguments, so they are typed into the prompt instead.
const COMMANDS: { name: string; fill?: true }[] = [
  { name: 'clear' },
  { name: 'compact' },
  { name: 'resume' },
  { name: 'rewind' },
  { name: 'code-review' },
  { name: 'security-review' },
  { name: 'simplify' },
  { name: 'loop', fill: true },
  { name: 'schedule', fill: true },
  { name: 'export' },
]
// A choice's `value` is what /model and /effort take as their argument.
type Choice = { value: string; label: string }
type Group = { title?: string; items: Choice[] }

const MODEL_GROUPS: Group[] = [
  {
    // Aliases, not ids: each follows its family's newest model as the engine resolves it, with no edit here.
    title: 'LATEST',
    items: [
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'fable', label: 'Fable' },
      { value: 'haiku', label: 'Haiku' },
    ],
  },
  {
    title: 'PREVIOUS',
    items: [
      { value: 'claude-fable-5', label: 'Fable 5' },
      { value: 'claude-opus-5', label: 'Opus 5' },
      { value: 'claude-sonnet-5', label: 'Sonnet 5' },
      { value: 'claude-opus-4-8', label: 'Opus 4.8' },
      { value: 'claude-opus-4-7', label: 'Opus 4.7' },
      { value: 'claude-opus-4-6', label: 'Opus 4.6' },
      { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    ],
  },
]
const EFFORT_GROUPS: Group[] = [
  { items: ['low', 'medium', 'high', 'xhigh', 'max'].map(value => ({ value, label: value })) },
]

// The listed choice a model names: a previous one by its exact id (a date or `[1m]` after it allowed), else
// its family's alias, which is what any other id of the family runs as.
function findModel(id: string | undefined): Choice | undefined {
  if (id === undefined) {
    return undefined
  }

  const [latest, previous] = MODEL_GROUPS.map(group => group.items)
  const bare = id.replace(/(-\d{8}|\[).*$/, '')

  return (
    previous?.find(({ value }) => value === bare) ??
    latest?.find(({ value }) => bare === value || bare.includes(`-${value}-`))
  )
}

const PINK = '#ff2bd6'
const PURPLE = '#9d7dff'
const DIM_PURPLE = '#5a4fcf'
const LEVEL_COLORS: Record<Level, string> = { ok: '#00f0ff', warn: '#ff9f1c', hot: '#ff003c' }

// Kept in `$.state` so a reload does not forget when the last response arrived.
const noRenewal: CacheRenewedAt = null
const noView: AccountPanelView = null
const cacheRenewedAt = atom({ plugin: 'subagents-workflow', key: 'cacheRenewedAt' } as const, noRenewal)
const view = atom({ plugin: 'subagents-workflow', key: 'view' } as const, noView)
const noCurrent: AccountPanelCurrent = {}
const noMenu: AccountPanelOpenMenu = null
const current = atom({ plugin: 'subagents-workflow', key: 'current' } as const, noCurrent)
const openMenu = atom({ plugin: 'subagents-workflow', key: 'openMenu' } as const, noMenu)
// Folded by default to save the pane's height; the tasks stay open, being what is followed live.
const startParts: string[] = ['tasks', 'goals']
const openParts = atom({ plugin: 'subagents-workflow', key: 'openParts' } as const, startParts)
// The external agents' work this session, oldest first, the last KEPT_TASKS of it.
const KEPT_TASKS = 20
const LOST_AFTER_MS = 2 * 3_600_000
const SHOWN_TASKS = 6
const noTasks: ExternalTask[] = []
const noTask: number | null = null
const noLink: ExternalLink = 'unknown'
const tasks = atom({ plugin: 'subagents-workflow', key: 'tasks' } as const, noTasks)
const openTask = atom({ plugin: 'subagents-workflow', key: 'openTask' } as const, noTask)
const codexLink = atom({ plugin: 'subagents-workflow', key: 'codexLink' } as const, noLink)
const noLimits: ExternalLimits = null
const codexLimits = atom({ plugin: 'subagents-workflow', key: 'codexLimits' } as const, noLimits)
// Codex's limits move only when Codex runs, the person's own use included: asked again this often.
const LIMITS_TICK_MS = 5 * 60_000
// From this age on, a reading says how old it is.
const STALE_MS = 10 * 60_000
const noBrief: string | null = null
// Raised whenever what the brief says changes, so a resumed session composes it again (one cache miss).
const BRIEF_VERSION = 5
const briefVersion = atom({ plugin: 'subagents-workflow', key: 'briefVersion' } as const, 0)
const noGoals: SessionGoal[] = []
const goals = atom({ plugin: 'subagents-workflow', key: 'goals' } as const, noGoals)
const noName: string | null = null
const sessionName = atom({ plugin: 'subagents-workflow', key: 'sessionName' } as const, noName)
const brief = atom({ plugin: 'subagents-workflow', key: 'brief' } as const, noBrief)
const TASK_MARKS: Record<string, { mark: string; level: Level }> = {
  assigned: { mark: '◌', level: 'warn' },
  running: { mark: '◉', level: 'warn' },
  reported: { mark: '◆', level: 'warn' },
  failed: { mark: '✖', level: 'hot' },
  done: { mark: '✔', level: 'ok' },
  accepted: { mark: '✔', level: 'ok' },
  fixed: { mark: '✔', level: 'warn' },
  rejected: { mark: '✖', level: 'hot' },
}

async function renew($: EngineInterface) {
  const now = await $.clock.now()
  await update($, cacheRenewedAt, () => now)
}

async function refresh($: EngineInterface) {
  const { rateLimits, context } = await $.session.usage()
  const now = await $.clock.now()
  await update($, view, () => ({ rateLimits: [...rateLimits], contextPercent: context.percent, now }))
}

// Switches through the engine's own command, and shows the choice at once: the next request confirms it.
async function choose($: EngineInterface, field: 'model' | 'effort', value: string) {
  await update($, current, value_ => ({ ...value_, [field]: value }))
  await $.command.run({ command: field, args: value })
}

async function patch($: EngineInterface, id: number, change: Partial<ExternalTask>) {
  await update($, tasks, list => list.map(task => (task.id === id ? { ...task, ...change } : task)))
}

// Asks the CLI whether it is there and signed in, and retires the tasks that never reported.
async function link($: EngineInterface) {
  // A task runs apart from the session, so a reload does not end it; one unheard of for this long is lost.
  const now = await $.clock.now()

  await update($, tasks, list =>
    list.map(task =>
      (task.status === 'assigned' || task.status === 'running') && now - task.assignedAt > LOST_AFTER_MS
        ? { ...task, status: 'failed' as const, endedAt: now, reason: 'no report after 2 hours' }
        : task,
    ),
  )

  let isLinked = false

  // An npm install of Codex on Windows is a command shim, which only the command interpreter runs.
  for (const argv of [
    ['codex', 'login', 'status'],
    ['cmd', '/d', '/c', 'codex', 'login', 'status'],
  ]) {
    try {
      const child = $.process.spawn({ argv })
      let step = await child.next()

      while (!step.done) {
        step = await child.next()
      }

      isLinked = step.value.code === 0

      break
    } catch {
      // No CLI on the path this way: the next is tried, and with none left it is not linked.
    }
  }

  await update($, codexLink, () => (isLinked ? 'linked' : 'missing'))
}

// Switches the system's own dictation: it writes what it hears where the cursor is, the prompt, and a
// second press stops it. The engine gives a mod no microphone of its own.
//
// On Windows it is voice typing, as its Win+H shortcut: it hears in the keyboard's language, so with
// SUBAGENTS_WORKFLOW_DICTATION_LANGUAGE set (a tag, `fr-FR`) the script changes the keyboard to it while it
// listens. Anywhere else it is taken for macOS, whose Dictation is pressed in the front app's menu and
// hears in the language set in System Settings.
async function dictate($: EngineInterface) {
  const root = $.plugin.root.replaceAll('\\', '/')
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const language = ((await $.env.get('SUBAGENTS_WORKFLOW_DICTATION_LANGUAGE')) ?? '').trim()
  const child = $.process.spawn({
    argv: isWindows
      ? [
          'powershell',
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          `${root}/bin/dictate.ps1`,
          ...(language === '' ? [] : ['-Language', language]),
        ]
      : ['osascript', `${root}/bin/dictate.applescript`],
  })
  let step = await child.next()

  while (!step.done) {
    step = await child.next()
  }

  if (step.value.code !== 0) {
    $.ui.toast(
      !isWindows
        ? 'dictation needs macOS Dictation on, and Accessibility for this terminal'
        : step.value.code === 2
          ? 'dictation: that language is not among the Windows keyboards'
          : 'dictation needs Windows voice typing (Win+H)',
    )
  }
}

// A `/clear` starts a session with empty state and no `session.start`: Codex is asked about again.
async function relink($: EngineInterface) {
  if ((await read($, codexLink)) === 'unknown') {
    await Promise.all([link($), measure($)])
  }
}

// Where the playbook and the record live: beside the person's settings, shared by every session and project.
async function findFolder($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'

  return `${home.replaceAll('\\', '/')}/.claude/codex`
}

// A finished task joins the record across sessions, the last KEPT_RUNS of it.
async function record($: EngineInterface, task: ExternalTask) {
  const path = `${await findFolder($)}/runs.json`
  const runs = readRuns(await $.fs.read(path).catch(() => '[]'))

  await $.fs.write(path, JSON.stringify([...runs, toRecord(task)].slice(-KEPT_RUNS), null, 2))
}

// Composed once a session: a system prompt that changed between turns would lose the prompt cache.
async function prepare($: EngineInterface) {
  if ((await read($, brief)) !== null && (await read($, briefVersion)) === BRIEF_VERSION) {
    return
  }

  // After a `/clear` nothing has asked yet whether Codex is there.
  if ((await read($, codexLink)) === 'unknown') {
    await link($).catch(() => {})
  }

  const root = $.plugin.root.replaceAll('\\', '/')
  const bin = `${root}/bin`
  const parts = [composeGoalsBrief(`${bin}/goals.mjs`), composeSubagentsBrief()]

  // Claude is told about Codex only where it is installed and signed in.
  if ((await read($, codexLink)) === 'linked') {
    const folder = await findFolder($)
    const runs = readRuns(await $.fs.read(`${folder}/runs.json`).catch(() => '[]'))
    let playbook = await $.fs.read(`${folder}/playbook.md`).catch(() => '')

    // A first run starts from the mod's own neutral playbook.
    if (playbook.trim() === '') {
      playbook = await $.fs.read(`${root}/playbook.template.md`).catch(() => '')
      await $.fs.write(`${folder}/playbook.md`, playbook).catch(() => {})
    }

    parts.push(composeBrief({ launcher: `${bin}/codex-task.mjs`, folder, playbook, runs }))
  }

  const text = parts.join('\n\n')

  await update($, brief, () => text)
  await update($, briefVersion, () => BRIEF_VERSION)
}

// Asks the reader script for Codex's limits; a failure leaves the last reading standing.
async function measure($: EngineInterface) {
  const reader = `${$.plugin.root.replaceAll('\\', '/')}/bin/codex-limits.mjs`
  const child = $.process.spawn({ argv: ['node', reader] })
  let output = ''
  let step = await child.next()

  while (!step.done) {
    output += step.value.stream === 'stdout' ? step.value.text : ''
    step = await child.next()
  }

  const limits: ExternalLimits = JSON.parse(output)

  if (limits !== null && Array.isArray(limits.rateLimits)) {
    await update($, codexLimits, () => limits)
  }
}

// A task as it is handed over: the launcher starts with the call, so assigned and started are one moment.
async function assign($: EngineInterface, call: Extract<CodexCall, { kind: 'task' }>): Promise<number> {
  const assignedAt = await $.clock.now()
  const { kind: _, ...request } = call

  return enlist($, { ...request, agent: 'codex', status: 'running', assignedAt, startedAt: assignedAt })
}

// Adds a task under the next id, taken inside the update so that two calls at once never share one.
async function enlist($: EngineInterface, task: Omit<ExternalTask, 'id'>): Promise<number> {
  let id = 0

  await update($, tasks, list => {
    id = Math.max(0, ...list.map(held => held.id)) + 1

    return [...list, { ...task, id }].slice(-KEPT_TASKS)
  })

  return id
}

// A subagent of Claude's own, listed as it is launched; its model is the call's until the engine resolves it.
async function launch(
  $: EngineInterface,
  call: { description: string; prompt: string; subagent_type?: string; model?: string },
): Promise<number> {
  const assignedAt = await $.clock.now()

  return enlist($, {
    agent: 'claude',
    title: cut(call.description, 60),
    task: cut(call.prompt),
    model: call.model ?? 'default',
    type: call.subagent_type ?? 'general-purpose',
    status: 'running',
    assignedAt,
    startedAt: assignedAt,
  })
}

// The launcher's output, or its absence (a call refused or cut short), as the task's end.
async function finish($: EngineInterface, id: number, title: string, text: string | undefined, refusal?: string) {
  const outcome: CodexOutcome =
    text === undefined ? { isReported: false, report: '', error: refusal ?? 'no result' } : readOutcome(text)
  const { isReported, report, tokens, error, ref } = outcome

  // The call ended, the task did not: it stays as running until a `wait` brings its report.
  if (outcome.isRunning) {
    await patch($, id, ref === undefined ? {} : { ref })
    $.ui.toast(`codex still working: #${id} ${title}`)

    return
  }

  const reason = isReported ? undefined : cut(error ?? 'failed', 200)

  await patch($, id, { status: isReported ? 'reported' : 'failed', endedAt: await $.clock.now(), tokens, report, reason, ref })

  const failed = isReported ? undefined : (await read($, tasks)).find(task => task.id === id)

  if (failed !== undefined) {
    await record($, failed).catch(() => {})
  }

  $.ui.toast(`codex ${isReported ? 'reported' : 'failed'}: #${id} ${title}`)
  await measure($).catch(() => {})
}

// Claude's judgement lands on the latest report still waiting for one.
async function judge($: EngineInterface, { verdict, reason }: Extract<CodexCall, { kind: 'verdict' }>) {
  const waiting = (await read($, tasks)).findLast(task => task.status === 'reported' && task.verdict === undefined)

  if (waiting !== undefined) {
    await patch($, waiting.id, { verdict, reason })
    await record($, { ...waiting, verdict, reason }).catch(() => {})
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show or hide the Subagents Workflow pane' })
    // Awaited: the brief composed next says whether Codex is there.
    await link($).catch(() => {})
    void measure($).catch(() => {})
    $.clock.every(LIMITS_TICK_MS, () => void measure($).catch(() => {}))
    await prepare($).catch(() => {})
    await refresh($)
    // The countdowns move even while no response arrives.
    $.clock.every(TICK_MS, () => {
      void refresh($).catch(() => {})
      void relink($).catch(() => {})
    })

    return next(e)
  })

  // The engine names the session; the pane only remembers the name, to show it and how to come back by it.
  on('command.run', { command: 'rename' }, async ($, e, next) => {
    const ran = await next(e)
    const name = e.args.trim()

    if (name !== '') {
      await update($, sessionName, () => name).catch(() => {})
    }

    return ran
  })

  on('command.run', { command: 'panel' }, async $ => {
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)

    if (isOpen) {
      await $.ui.close({ id: PANE })

      return { text: 'Subagents Workflow pane closed.' }
    }

    await refresh($)

    void relink($).catch(() => {})

    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Subagents Workflow pane opened.' }
  })

  // Tells Claude it has the helper, with the playbook and the record, in every session the mod loads in.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    // Composed again after a `/clear`, which empties the state without a `session.start`.
    await prepare($).catch(() => {})

    const text = await read($, brief).catch(() => null)

    return text === null
      ? composed
      : { sections: [...composed.sections, { id: 'subagents-workflow:codex', text, scope: 'session' as const }] }
  })

  // Claude reaches Codex through the launcher, run as a Bash call: watched here, never changed.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const goalCall = readGoalCall(e.command)

    // The goals script only echoes its call: the list is kept here, and read back to Claude beside the result.
    if (goalCall !== undefined) {
      const ran = await next(e)

      if (ran.deny !== undefined || ran.isError === true) {
        return ran
      }

      const list = await update($, goals, held => applyGoal(held, goalCall))
        .then(() => read($, goals))
        .catch(() => undefined)

      return list === undefined ? ran : { ...ran, context: [...(ran.context ?? []), listGoals(list)] }
    }

    const call = readCall(e.command)

    if (call === undefined) {
      return next(e)
    }

    if (call.kind === 'verdict') {
      const ran = await next(e)

      if (ran.deny === undefined) {
        await judge($, call).catch(() => {})
      }

      return ran
    }

    // A `wait` collects a task already listed: the one it names, else the one still running.
    if (call.kind === 'wait') {
      const ran = await next(e)
      const running = (await read($, tasks).catch(() => noTasks)).filter(
        task => task.agent === 'codex' && task.status === 'running',
      )
      const waited = running.find(task => task.ref === call.ref) ?? running.at(-1)

      if (waited !== undefined) {
        await finish($, waited.id, waited.title, ran.text, ran.deny).catch(() => {})
      }

      return ran
    }

    const id = await assign($, call).catch(() => undefined)
    const ran = await next(e)

    if (id !== undefined) {
      await finish($, id, call.title, ran.text, ran.deny).catch(() => {})
    }

    return ran
  })

  // Claude's own subagents join the tasks: listed at the call, ended by its answer or, for one sent to the
  // background, by its own `turn.complete`.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const id = await launch($, e).catch(() => undefined)
    const ran = await next(e)

    if (id !== undefined) {
      const change = readAgentAnswer(ran, await $.clock.now())

      await patch($, id, change).catch(() => {})

      if (change.status !== undefined) {
        $.ui.toast(`claude agent ${change.status}: #${id} ${cut(e.description, 60)}`)
      }
    }

    return ran
  })

  // The engine names the model and the id as the subagent starts, long before a foreground one answers.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)

    if (spawned.deny === undefined) {
      const task = cut(e.prompt)
      const waiting = (await read($, tasks).catch(() => noTasks)).findLast(
        held => held.agent === 'claude' && held.status === 'running' && held.ref === undefined && held.task === task,
      )

      if (waiting !== undefined) {
        await patch($, waiting.id, { model: spawned.model, ref: spawned.agentId }).catch(() => {})
      }
    }

    return spawned
  })

  // A response renews the cache: the turn's end, and the context moving.
  on('turn.complete', async ($, e, next) => {
    await renew($)

    // A subagent's own turn: the end of the one sent to the background.
    if (e.agentId !== undefined) {
      const ended = (await read($, tasks).catch(() => noTasks)).find(
        task => task.agent === 'claude' && task.status === 'running' && task.ref === e.agentId,
      )

      if (ended !== undefined) {
        await patch($, ended.id, {
          status: e.isAborted ? 'failed' : 'done',
          endedAt: await $.clock.now(),
          tokens: e.usage === undefined ? undefined : sumUsage(e.usage),
          report: cut(e.answer),
          reason: e.isAborted ? 'interrupted' : undefined,
        }).catch(() => {})
        $.ui.toast(`claude agent ${e.isAborted ? 'failed' : 'done'}: #${ended.id} ${ended.title}`)
      }
    }

    return next(e)
  })

  // The main loop's requests say what the session runs on; passed through untouched.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const effort = e.effort === undefined ? undefined : String(e.effort)
      await update($, current, () => ({ model: e.model, effort })).catch(() => {})
    }

    return yield* next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      await renew($)
    }

    const now = await $.clock.now()
    await update($, view, () => ({ rateLimits: [...e.rateLimits], contextPercent: e.context.percent, now }))

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const stats = await read($, view)
    const renewedAt = await read($, cacheRenewedAt)
    const running = await read($, current)
    const open = await read($, openMenu)
    const toggle = (menu: AccountPanelOpenMenu) => update($, openMenu, value => (value === menu ? null : menu))
    // A Button's label takes a color only under the pointer, so the marker beside it carries the neon at rest.
    const header = (
      menu: 'model' | 'effort' | 'agents' | 'commands',
      value?: string,
      color = LEVEL_COLORS.ok,
      label = menu.toUpperCase(),
      indent = '',
    ) => (
      <Box key={`row:${menu}`}>
        <Text color={PINK} bold>
          {`${indent}${open === menu ? '▼' : '▶'} `}
        </Text>
        <Button
          key={`menu:${menu}`}
          plain
          label={label}
          hover={{ color: PINK, bold: true }}
          onPress={() => toggle(menu)}
        />
        {value === undefined ? null : (
          <Text color={color} bold>
            {' '}
            {value}
          </Text>
        )}
      </Box>
    )
    const parts = await read($, openParts)
    const named = await read($, sessionName)
    const aims = await read($, goals)
    // A section's own switch, apart from the accordion: its figures stay in the header while it is folded.
    const part = (id: 'goals' | 'session' | 'claude' | 'stats' | 'limits' | 'tasks', label: string, value?: string, color = LEVEL_COLORS.ok, indent = '') => (
      <Box key={`row:part:${id}`}>
        <Text color={PINK} bold>
          {`${indent}${parts.includes(id) ? '▼' : '▶'} `}
        </Text>
        <Button
          key={`part:${id}`}
          plain
          label={label}
          hover={{ color: PINK, bold: true }}
          onPress={() => update($, openParts, list => (list.includes(id) ? list.filter(other => other !== id) : [...list, id]))}
        />
        {value === undefined ? null : (
          <Text color={color} bold>
            {' '}
            {value}
          </Text>
        )}
      </Box>
    )
    // A folded section's header: its windows' figures, in the color of the one nearest its limit.
    const brief = (rows: Row[]) => {
      const windows = rows.filter(({ label }) => label === 'SESSION' || label === 'WEEK')
      const level = (['hot', 'warn', 'ok'] as const).find(candidate => windows.some(row => row.level === candidate)) ?? 'ok'

      const context = rows.find(({ label }) => label === 'CTX')
      const figures = [...windows.map(({ value }) => value), ...(context === undefined ? [] : [`ctx ${context.value}`])]

      return { value: figures.length === 0 ? undefined : figures.join(' · '), color: LEVEL_COLORS[level] }
    }
    const choices = (field: 'model' | 'effort', groups: Group[], active?: string) =>
      open === field &&
      groups.flatMap(({ title, items }) => [
        title === undefined ? null : <Text color={PURPLE}>{`    ${title}`}</Text>,
        ...items.map(({ value, label }) => (
          <Box key={`row:${field}:${value}`}>
            <Text color={value === active ? LEVEL_COLORS.ok : DIM_PURPLE}>{value === active ? '    ● ' : '    ▸ '}</Text>
            <Button
              key={`${field}:${value}`}
              plain
              label={label}
              hover={{ color: LEVEL_COLORS.ok, bold: true }}
              onPress={() => choose($, field, value)}
            />
          </Box>
        )),
      ])
    const model = findModel(running.model)
    const work = await read($, tasks)
    const shownTask = await read($, openTask)
    const linked = await read($, codexLink)
    const now = stats?.now ?? 0
    const judged = work.filter(task => task.agent === 'codex' && (task.verdict !== undefined || task.status === 'failed'))
    const kept = judged.filter(task => task.verdict === 'accepted' || task.verdict === 'fixed')
    const active = work.find(task => task.status === 'assigned' || task.status === 'running')
    const summary =
      active !== undefined ? `${active.agent} working #${active.id}` : judged.length === 0 ? undefined : `${kept.length}/${judged.length} kept`
    // How far a task has come, as its bar fills: handed over, reported back, judged.
    const progress = (task: ExternalTask) =>
      task.verdict !== undefined || task.status === 'failed' || task.status === 'done' ? 1 : task.status === 'reported' ? 2 / 3 : 1 / 3
    // The lines under a task's bar: who has it, then where it stands.
    const stages = (task: ExternalTask) => [
      `${task.agent} · ${task.model.startsWith('claude-') ? formatModelName(task.model) : task.model} · ${task.mode ?? task.type ?? ''}`,
      task.status === 'failed'
        ? `failed: ${task.reason ?? 'unknown'}`
        : task.endedAt === undefined
          ? `working · ${formatDuration(now - (task.startedAt ?? task.assignedAt))}`
          : task.status === 'done'
            ? `done · ${formatDuration(task.endedAt - (task.startedAt ?? task.assignedAt))}`
            : `reported · ${task.verdict ?? 'awaiting review'}`,
      task.verdict === undefined || task.reason === undefined ? null : task.reason,
    ]
    const limits = await read($, codexLimits)
    // Codex's own session and week, drawn as the account's are; a window already reset reads as spent 0.
    const codexRows =
      limits === null
        ? []
        : toRows(
            {
              rateLimits: limits.rateLimits.map(limit =>
                limit.resetsAt !== undefined && Date.parse(limit.resetsAt) <= now
                  ? { ...limit, percentUsed: 0, resetsAt: undefined }
                  : limit,
              ),
            },
            now,
            CACHE_TTL_MS,
          )
    const age = limits === null ? 0 : now - limits.readAt
    const quota = () => [
      limits === null ? <Text color={DIM_PURPLE}>{'    no reading yet'}</Text> : null,
      ...codexRows.flatMap(({ label, value, details, level, fill }) => [
        <Box>
          <Text color={PINK} bold>{`    ${label} `}</Text>
          <Text color={LEVEL_COLORS[level]} bold>
            {value}
          </Text>
        </Box>,
        fill === undefined ? null : <Text color={LEVEL_COLORS[level]}>{`    ${formatBar(fill, Math.max(6, width - 4))}`}</Text>,
        ...details.map(detail => <Text color={PURPLE}>{`    ${detail}`}</Text>),
      ]),
      age < STALE_MS ? null : <Text color={DIM_PURPLE}>{`    as of ${formatRemaining(age)} ago`}</Text>,
    ]
    // What was asked or answered, under its own heading: a line each, indented as one block so a wrapped
    // line stays inside it.
    const passage = (label: string, text: string, labelColor: string, textColor: string) => [
      <Text> </Text>,
      <Text color={labelColor} bold>{`      ▍${label}`}</Text>,
      <Box flexDirection="column" paddingLeft={6} paddingRight={1}>
        {toLines(text).map(line => (
          <Text color={textColor}>{line === '' ? ' ' : line}</Text>
        ))}
      </Box>,
    ]
    const taskList = () => [
      work.length === 0 ? <Text color={DIM_PURPLE}>{'    no tasks yet'}</Text> : null,
      ...work
        .slice(-SHOWN_TASKS)
        .reverse()
        .flatMap(task => {
          const { mark, level } = TASK_MARKS[task.verdict ?? task.status] ?? { mark: '▸', level: 'ok' as const }

          return [
            <Box key={`row:task:${task.id}`} paddingRight={1}>
              <Text color={LEVEL_COLORS[level]} bold>{`    ${mark} `}</Text>
              <Box flexShrink={1}>
                <Button
                  key={`task:${task.id}`}
                  plain
                  label={`#${task.id} ${task.title}`}
                  hover={{ color: LEVEL_COLORS.ok, bold: true }}
                  onPress={() => update($, openTask, value => (value === task.id ? null : task.id))}
                />
              </Box>
            </Box>,
            <Text color={LEVEL_COLORS[level]}>{`      ${formatBar(progress(task), Math.max(6, width - 7))}`}</Text>,
            // Indented as a block, so a line too long for the pane wraps under itself and off the edge.
            <Box flexDirection="column" paddingLeft={6} paddingRight={1}>
              {stages(task).map(stage => (stage === null ? null : <Text color={PURPLE}>{stage}</Text>))}
            </Box>,
            ...(shownTask !== task.id ? [] : passage('TASK', task.task, PINK, DIM_PURPLE)),
            ...(shownTask !== task.id || !task.report ? [] : passage('REPORT', task.report, LEVEL_COLORS.ok, PURPLE)),
          ]
        }),
      // A task still running stays, its end yet to be written to it, and so does a report yet to be judged.
      work.length === 0 ? null : (
        <Box key="row:clear">
          <Text color={DIM_PURPLE}>{'    ✕ '}</Text>
          <Button
            key="tasks:clear"
            plain
            label="clear tasks"
            hover={{ color: LEVEL_COLORS.hot, bold: true }}
            onPress={() =>
              update($, tasks, list =>
                list.filter(
                  task =>
                    (task.endedAt === undefined && task.status !== 'failed') ||
                    (task.status === 'reported' && task.verdict === undefined),
                ),
              )
            }
          />
        </Box>
      ),
    ]
    // Under the title, a fold per agent: its link and its limits.
    const agents = () => [
      part('limits', 'CODEX', brief(codexRows).value ?? (linked === 'linked' ? 'linked' : linked), brief(codexRows).color),
      ...(parts.includes('limits')
        ? [
            <Box>
              <Text color={linked === 'linked' ? LEVEL_COLORS.ok : LEVEL_COLORS.hot}>{'    ● '}</Text>
              <Text color={PURPLE}>{`codex ${linked === 'unknown' ? 'checking' : linked}`}</Text>
            </Box>,
            ...quota(),
          ]
        : []),
    ]
    const contextPercent = Math.round(stats?.contextPercent ?? 0)
    const isCompactDue = contextPercent >= COMPACT_AT

    if (stats === null) {
      return <Text color={PURPLE}>No reading yet.</Text>
    }

    const cacheExpiresAt = renewedAt === null ? undefined : renewedAt + CACHE_TTL_MS
    const rows = toRows({ ...stats, cacheExpiresAt }, stats.now, CACHE_TTL_MS)
    const width = Math.max(8, Math.min(MAX_BAR, (e.props.bodyColumns ?? 30) - 1))

    // The room's rows when docked beside the transcript; inline, the frame fits the tree and nothing is pushed.
    const roomRows = e.props.placement === 'dock' ? e.props.scroll?.bodyRows : undefined

    return (
      <Box flexDirection="column" minHeight={roomRows}>
        {part('claude', 'CLAUDE', brief(rows).value, brief(rows).color)}
        {parts.includes('claude') && part('stats', 'STATS', undefined, undefined, '  ')}
        {parts.includes('claude') &&
          parts.includes('stats') &&
          rows.flatMap(({ label, value, details, level, fill }) => [
            <Box>
              <Text color={PINK} bold>{`    ${label} `}</Text>
              <Text color={LEVEL_COLORS[level]} bold>
                {value}
              </Text>
            </Box>,
            fill === undefined ? null : <Text color={LEVEL_COLORS[level]}>{`    ${formatBar(fill, Math.max(6, width - 4))}`}</Text>,
            ...details.map(detail => <Text color={PURPLE}>{`    ${detail}`}</Text>),
          ])}
        {parts.includes('claude') &&
          header('model', running.model === undefined ? 'after next reply' : formatModelName(running.model), undefined, undefined, '  ')}
        {parts.includes('claude') && choices('model', MODEL_GROUPS, model?.value)}
        {parts.includes('claude') && header('effort', running.effort ?? 'after next reply', undefined, undefined, '  ')}
        {parts.includes('claude') && choices('effort', EFFORT_GROUPS, running.effort)}
        {parts.includes('claude') && header('commands', isCompactDue ? '/compact due' : undefined, LEVEL_COLORS.warn, undefined, '  ')}
        {parts.includes('claude') &&
          open === 'commands' &&
          COMMANDS.map(({ name, fill }) => (
            <Box key={`row:${name}`}>
              {isCompactDue && name === 'compact' ? (
                <Text color={LEVEL_COLORS.warn} bold>
                  {'    ● '}
                </Text>
              ) : (
                <Text color={DIM_PURPLE} hover={{ color: PINK }}>
                  {'    ▸ '}
                </Text>
              )}
              <Button
                key={`cmd:${name}`}
                plain
                label={`/${name}${fill ? ' ...' : ''}`}
                hover={{ color: LEVEL_COLORS.ok, bold: true }}
                onPress={() =>
                  fill ? $.prompt.fill({ text: `/${name} ` }) : $.command.run({ command: name })
                }
              />
              {isCompactDue && name === 'compact' ? (
                <Text color={LEVEL_COLORS.warn} bold>{` ◀ CTX ${contextPercent}%`}</Text>
              ) : null}
            </Box>
          ))}
        <Text> </Text>
        <Text color={PINK} bold>
          EXTERNAL AGENTS
        </Text>
        {agents()}
        <Text> </Text>
        {/* What every agent was handed, in a section of its own. */}
        {part('tasks', 'AGENT TASKS', summary, active === undefined ? LEVEL_COLORS.ok : LEVEL_COLORS.warn)}
        {parts.includes('tasks') && taskList()}
        <Text> </Text>
        {/* The session's large goals, kept by Claude: a finished one stays, struck through. */}
        {part('goals', 'SESSION GOALS', aims.length === 0 ? undefined : `${aims.filter(goal => goal.isDone).length}/${aims.length} done`)}
        {parts.includes('goals') && aims.length === 0 && <Text color={DIM_PURPLE}>{'  none yet'}</Text>}
        {parts.includes('goals') &&
          aims.map(goal => (
            <Box key={`row:goal:${goal.id}`}>
              <Text color={goal.isDone ? LEVEL_COLORS.ok : PINK}>{goal.isDone ? '  ✔ ' : '  ◻ '}</Text>
              <Text color={goal.isDone ? DIM_PURPLE : PURPLE} strikethrough={goal.isDone}>
                {goal.text}
              </Text>
            </Box>
          ))}
        <Box flexGrow={1} minHeight={1} />
        {part('session', 'SESSION NAME', named ?? 'unnamed', named === null ? DIM_PURPLE : LEVEL_COLORS.ok)}
        {parts.includes('session') && (
          <Box key="row:rename">
            <Text color={DIM_PURPLE}>{'  ✎ '}</Text>
            <Button
              key="session:rename"
              plain
              label={named === null ? 'name it' : 'rename'}
              hover={{ color: LEVEL_COLORS.ok, bold: true }}
              onPress={() => $.prompt.fill({ text: '/rename ' })}
            />
          </Box>
        )}
        {parts.includes('session') && (
          <Text color={PURPLE}>{named === null ? '  type a name, press Enter' : `  resume: claude -r "${named}"`}</Text>
        )}
        <Text> </Text>
        {/* Speech to text into the prompt: one click starts it, the next stops it. */}
        <Box key="row:dictate">
          <Text color={PINK} bold>
            {'● '}
          </Text>
          <Button
            key="dictate"
            plain
            label="DICTATE"
            hover={{ color: PINK, bold: true }}
            onPress={() => dictate($).catch(() => $.ui.toast('dictation needs Windows voice typing or macOS Dictation'))}
          />        </Box>
      </Box>
    )
  })
}
