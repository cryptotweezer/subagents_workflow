import type { ExternalTask } from '../types'

// The launcher Claude runs through Bash (`bin/codex-task.mjs`); a Bash call naming it is an external task.
const LAUNCHER = 'codex-task.mjs'
const TITLE_LENGTH = 60
const KEPT_LENGTH = 1500

export type CodexCall =
  | ({ kind: 'task' } & Pick<ExternalTask, 'title' | 'task' | 'model'> & { mode: NonNullable<ExternalTask['mode']> })
  | { kind: 'verdict'; verdict: NonNullable<ExternalTask['verdict']>; reason?: string }
  | { kind: 'wait'; ref: string }

// `isRunning`: the call ended before the task did, which runs on and is collected by a later `wait`.
export type CodexOutcome = { isReported: boolean; isRunning?: true; ref?: string; report: string; tokens?: number; error?: string }

export function cut(text: string, length = KEPT_LENGTH): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

// A command less its heredoc bodies: those are text handed to another program, and may name anything.
export function commandHead(command: string): string {
  return command.split(/<<-?\s*['"]?\w+/)[0] ?? command
}

// What a Bash command asks of the launcher, read off its text; `undefined` for any other command.
export function readCall(command: string): CodexCall | undefined {
  const head = commandHead(command)

  if (!head.includes(LAUNCHER)) {
    return undefined
  }

  // The launcher may be named through a shell variable, so the verdict is the first argument of any `node` run.
  const verdict = /node\s+(?:"[^"]*"|'[^']*'|\S+)\s+verdict\s+(accepted|fixed|rejected)(?:\s+["']([^"']*)["'])?/.exec(head)

  if (verdict !== null) {
    return { kind: 'verdict', verdict: verdict[1] as 'accepted' | 'fixed' | 'rejected', reason: verdict[2] || undefined }
  }

  const wait = /node\s+(?:"[^"]*"|'[^']*'|\S+)\s+wait\s+([\w-]+)/.exec(head)

  if (wait !== null) {
    return { kind: 'wait', ref: wait[1] ?? '' }
  }

  const model = /--model\s+(\S+)/.exec(head)?.[1]
  const mode = /--mode\s+(read|write|full)/.exec(head)?.[1]

  if (model === undefined || (mode !== 'read' && mode !== 'write' && mode !== 'full')) {
    return undefined
  }

  const task = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\1/.exec(command)?.[2]?.trim() ?? ''
  const title = /--title\s+["']([^"']*)["']/.exec(head)?.[1]?.trim() || task.split('\n')[0] || 'untitled'

  return { kind: 'task', title: cut(title, TITLE_LENGTH), task: cut(task), model, mode }
}

// What the launcher printed: its `CODEX_TASK {json}` line, then the report.
export function readOutcome(text: string): CodexOutcome {
  const lines = text.split('\n')
  const at = lines.findIndex(line => line.startsWith('CODEX_TASK '))

  if (at === -1) {
    // The shell gave up waiting and left the command running: the task is not over.
    return /moved to the background/.test(text)
      ? { isReported: false, isRunning: true, report: '' }
      : { isReported: false, report: '', error: cut(text.trim() || 'no output', 200) }
  }

  const report = cut(lines.slice(at + 1).join('\n').trim())

  try {
    const { ok, running, id, tokens, error } = JSON.parse((lines[at] ?? '').slice('CODEX_TASK '.length))
    const ref = typeof id === 'string' ? id : undefined

    if (running === true) {
      return { isReported: false, isRunning: true, ref, report: '' }
    }

    return { isReported: ok === true, ref, report, tokens: typeof tokens === 'number' ? tokens : undefined, error }
  } catch {
    return { isReported: false, report, error: 'unreadable result line' }
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))

  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

export function formatTokens(tokens: number): string {
  return tokens < 1000 ? `${tokens} tok` : `${(tokens / 1000).toFixed(1)}k tok`
}

// One finished task as the record across sessions keeps it.
export type CodexRunRecord = {
  date: string
  title: string
  model: string
  mode: string
  seconds: number
  outcome: 'accepted' | 'fixed' | 'rejected' | 'failed'
  reason?: string
}

export const KEPT_RUNS = 50
const SHOWN_MISSES = 3

export function toRecord(task: ExternalTask): CodexRunRecord {
  return {
    date: new Date(task.assignedAt).toISOString().slice(0, 10),
    title: task.title,
    model: task.model,
    mode: task.mode ?? '',
    seconds: Math.round(((task.endedAt ?? task.assignedAt) - task.assignedAt) / 1000),
    outcome: task.verdict ?? 'failed',
    reason: task.reason,
  }
}

export function readRuns(text: string): CodexRunRecord[] {
  try {
    const runs: unknown = JSON.parse(text)

    return Array.isArray(runs) ? runs : []
  } catch {
    return []
  }
}

// The record as a few lines: what each model kept of what it was given, and the latest misses.
export function summarize(runs: CodexRunRecord[]): string {
  if (runs.length === 0) {
    return 'No runs recorded yet.'
  }

  const models = [...new Set(runs.map(run => run.model))].map(model => {
    const own = runs.filter(run => run.model === model)
    const kept = own.filter(run => run.outcome === 'accepted' || run.outcome === 'fixed')

    return `- ${model}: ${kept.length}/${own.length} kept`
  })
  const misses = runs
    .filter(run => run.outcome === 'rejected' || run.outcome === 'failed')
    .slice(-SHOWN_MISSES)
    .map(run => `- ${run.outcome} (${run.model}): ${run.title}${run.reason === undefined ? '' : `, ${run.reason}`}`)

  return [...models, ...(misses.length === 0 ? [] : ['Latest misses:', ...misses])].join('\n')
}

// What Claude reads about the helper at the start of every session: how to run it, when, and how to judge it.
export function composeBrief(input: { launcher: string; folder: string; playbook: string; runs: CodexRunRecord[] }): string {
  const { launcher, folder, playbook, runs } = input

  return [
    '# Codex helper (external agent)',
    "Codex is an external coding agent on the user's own OpenAI account, and it is yours to direct. You are the",
    'senior engineer and the orchestrator: you decide what to hand it, you review what it delivers, and you alone',
    "decide what is kept. Its tokens are spent instead of yours, but the user's code quality comes before any",
    'saving: delegate to get the same result for less, never a worse one.',
    '',
    '## Running it',
    'Through Bash, in the foreground, with the Bash timeout raised (up to 600000 ms):',
    '',
    `node "${launcher}" --model <model> --mode read|write|full --dir "<project root>" --title "few words" <<'TASK'`,
    'the full, self-contained instruction',
    'TASK',
    '',
    '- `--mode read`: analysis, search, review; it cannot change files. `write`: edits inside `--dir`, with network',
    '  access. `full`: no sandbox at all; only when the task must act outside `--dir`, and say so to the user.',
    '- `--dir`: always the project root. Never hand it the home folder or a drive root to write in.',
    '- Live web search is always on: it can look things up for you and name its sources.',
    '- `--effort low|medium|high` sets how hard it thinks (its default when left out); raise it for hard work.',
    '- `--resume <thread>` sends a follow-up to a thread it already ran (the `thread` of an earlier result): it',
    '  keeps what it read, so a correction costs far less than a fresh task.',
    '',
    'It prints `CODEX_TASK {json}` (`ok`, `thread`, `commands`, `failedCommands`, `searches`), then its report, then',
    'for a writing task in a git repository the files it left changed. Codex never commits or pushes.',
    '',
    'A long task (a whole-codebase review can take 15 minutes) outlives the call: after nine minutes it prints',
    '`"running": true` with an `id`, and Codex works on. Collect it with the line below, as many times as it',
    'takes, and do other work meanwhile on files it was not given. Never start it again: that pays for it twice.',
    '',
    `node "${launcher}" wait <id>`,
    '',
    '## Deciding',
    'Hand over work that is well bounded and costs you many tokens: wide exploration of a codebase, mechanical',
    'edits across named files, writing tests for code that exists, a second opinion on a diff, research on the',
    'web. Keep what is ambiguous, delicate, architectural, or small enough that explaining it costs more than',
    'doing it (every task has a fixed cost on its side). One task at a time, and never give it files you are',
    'editing yourself. Write the task so it stands alone, since Codex sees none of this conversation: the goal,',
    'the files it may touch, what done means, how to check it, and what to report.',
    '',
    '## Judging',
    'Cheap signals first: `failedCommands`, whether the files changed are the ones you allowed, the size of the',
    'diff, and the tests run by you. Read the diff in full before keeping any of it. Then always record:',
    '',
    `node "${launcher}" verdict accepted|fixed|rejected "one line why"`,
    '',
    '`accepted` is kept as delivered, `fixed` kept after corrections (yours or one `--resume`), `rejected`',
    'discarded. At most one correction round; if it still falls short, reject it and do the work yourself. The',
    'user follows every task and verdict live in a side pane, so title tasks clearly and never skip the verdict.',
    '',
    '## Learning',
    `Your playbook is ${folder}/playbook.md (below) and the record of past runs ${folder}/runs.json. When a task`,
    'teaches you something durable about working with Codex (a kind of task it does well or badly, a way of asking',
    'that worked, a model that fits), edit the playbook: at most 40 lines, rewrite or merge a rule rather than',
    'append one. That file is how your next session starts out better at this than this one.',
    '',
    '## Playbook',
    playbook.trim() === '' ? '(empty)' : playbook.trim(),
    '',
    `## Track record (last ${runs.length} runs)`,
    summarize(runs),
  ].join('\n')
}
