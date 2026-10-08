#!/usr/bin/env node
// Runs one Codex task and prints a short result for Claude; the subagents-workflow mod watches these calls.
//
//   node codex-task.mjs --model <model> --mode read|write|full --title "few words" \
//     [--dir <path>] [--effort low|medium|high] [--resume <thread>] [--wait <seconds>] <<'TASK'
//   the full, self-contained instruction
//   TASK
//
//   node codex-task.mjs wait <id> [--wait <seconds>]     collect a task that outlived its first call
//   node codex-task.mjs verdict accepted|fixed|rejected "one line why"
//
// The first output line is `CODEX_TASK {json}` (or `CODEX_VERDICT {json}`); the report follows it, then,
// for a task that could write inside a git repository, the files it left changed.
//
// Codex runs in a worker of its own, apart from this call: a task longer than the caller's patience (a Bash
// call is cut at ten minutes) keeps running, and `wait` collects it later.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const VERDICTS = ['accepted', 'fixed', 'rejected']
const EFFORTS = ['low', 'medium', 'high']
// What each mode lets Codex touch. Live web search is on in all three.
const SANDBOXES = { read: 'read-only', write: 'workspace-write', full: 'danger-full-access' }
// Where a task's instruction and its result wait for whoever collects them.
const FOLDER = join(homedir(), '.claude', 'codex')
const TASKS = join(FOLDER, 'tasks')
// The models the person allows, as a JSON list of names in `models.json`; any model where there is no list.
const MODELS = (() => {
  try {
    const listed = JSON.parse(readFileSync(join(FOLDER, 'models.json'), 'utf8'))

    return Array.isArray(listed) && listed.length > 0 ? listed : undefined
  } catch {
    return undefined
  }
})()
// Under the ten minutes a Bash call may take, with room to print.
const DEFAULT_WAIT_S = 540
const POLL_MS = 1000
const KEPT_MS = 7 * 24 * 3_600_000
const args = process.argv.slice(2)

const flag = name => {
  const index = args.indexOf(`--${name}`)

  return index === -1 ? undefined : args[index + 1]
}
const resultFile = id => join(TASKS, `${id}.json`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function fail(error) {
  console.log(`CODEX_TASK ${JSON.stringify({ ok: false, error })}`)
  process.exit(1)
}

// Waits for a task's result and prints it; a task still running when the wait runs out says how to collect it.
async function collect(id, known = {}) {
  const waitS = Number(flag('wait') ?? DEFAULT_WAIT_S)
  const until = Date.now() + (Number.isFinite(waitS) ? waitS : DEFAULT_WAIT_S) * 1000

  while (!existsSync(resultFile(id))) {
    if (Date.now() >= until) {
      console.log(`CODEX_TASK ${JSON.stringify({ ok: null, running: true, id, ...known })}`)
      console.log(`Codex is still working. Collect the result with:\nnode "${process.argv[1].replaceAll('\\', '/')}" wait ${id}`)
      process.exit(0)
    }

    await sleep(POLL_MS)
  }

  // The worker writes the file whole, then renames nothing: a read too early gets half of it, so it is retried.
  let result

  for (let attempt = 0; attempt < 5 && result === undefined; attempt += 1) {
    try {
      result = JSON.parse(readFileSync(resultFile(id), 'utf8'))
    } catch {
      await sleep(200)
    }
  }

  if (result === undefined) {
    fail(`the result of task ${id} could not be read`)
  }

  const { report, changed, ...summary } = result

  console.log(`CODEX_TASK ${JSON.stringify(summary)}`)
  console.log(report)

  if (changed.length > 0) {
    console.log(`\nFILES CHANGED (git status, new since the task began):\n${changed.join('\n')}`)
  }

  process.exit(summary.ok ? 0 : 1)
}

if (args[0] === 'verdict') {
  const [, verdict, ...reason] = args

  if (!VERDICTS.includes(verdict)) {
    console.log(`CODEX_VERDICT ${JSON.stringify({ ok: false, error: `verdict must be one of ${VERDICTS.join(', ')}` })}`)
    process.exit(1)
  }

  console.log(`CODEX_VERDICT ${JSON.stringify({ ok: true, verdict, reason: reason.join(' ') })}`)
  process.exit(0)
}

if (args[0] === 'wait') {
  const id = args[1]

  if (id === undefined || !/^[\w-]+$/.test(id) || !existsSync(join(TASKS, `${id}.task.txt`))) {
    fail(`no task ${id ?? ''} is known here`)
  }

  await collect(id)
}

const model = flag('model')
const mode = flag('mode')
const effort = flag('effort')
const resume = flag('resume')
const cwd = flag('dir') ?? process.cwd()

// The worker: runs Codex to its end and leaves the result where `collect` looks for it.
if (args[0] === '__worker') {
  const id = args[1]
  const task = readFileSync(join(TASKS, `${id}.task.txt`), 'utf8')

  // The working tree as git sees it, one path per line; empty outside a repository.
  const snapshot = () => {
    try {
      return execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n')
        .filter(line => line.trim() !== '')
    } catch {
      return []
    }
  }
  const before = mode === 'read' ? [] : snapshot()
  const startedAt = Date.now()
  const settings = [
    '--model',
    model,
    '-c',
    `sandbox_mode="${SANDBOXES[mode]}"`,
    // A writing task may fetch what it needs (packages, a test's fixtures).
    '-c',
    'sandbox_workspace_write.network_access=true',
    ...(effort === undefined ? [] : ['-c', `model_reasoning_effort="${effort}"`]),
    '--skip-git-repo-check',
    '--json',
  ]
  let pending = ''
  let report = ''
  let thread = resume
  let tokens = 0
  let commands = 0
  let failedCommands = 0
  let searches = 0
  const errors = []

  // One event of `codex exec --json`: the last agent message is the report, a turn's usage its cost.
  const read = line => {
    let event

    try {
      event = JSON.parse(line)
    } catch {
      return
    }

    const item = event.type === 'item.completed' ? event.item : undefined

    if (event.type === 'thread.started' && event.thread_id !== undefined) {
      thread = event.thread_id
    } else if (item?.type === 'agent_message' && item.text !== undefined) {
      report = item.text
    } else if (item?.type === 'command_execution') {
      commands += 1
      failedCommands += item.exit_code === 0 ? 0 : 1
    } else if (item?.type === 'web_search') {
      searches += 1
    } else if (event.type === 'turn.completed' && event.usage !== undefined) {
      tokens += (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0)
    } else if (event.type === 'error' || event.type === 'turn.failed') {
      errors.push(event.message ?? event.error?.message ?? line)
    }
  }
  const finish = (code, startError) => {
    if (pending.trim() !== '') {
      read(pending)
    }

    const ok = startError === undefined && code === 0 && report !== ''
    const error = ok ? undefined : (startError ?? errors.at(-1) ?? `codex exited with ${code}`).slice(0, 300)
    const changed = mode === 'read' ? [] : snapshot().filter(line => !before.includes(line))
    const durationMs = Date.now() - startedAt

    writeFileSync(
      resultFile(id),
      JSON.stringify({ ok, id, model, mode, thread, tokens, durationMs, commands, failedCommands, searches, error, report, changed }),
    )
    process.exit(0)
  }
  // The instruction goes in on standard input (`-`): no quoting of it on any platform. A resumed thread keeps
  // what Codex already read, so a correction costs a fraction of a fresh task.
  const run = isShim => {
    let isRetried = false
    const child = spawn('codex', ['--search', 'exec', ...(resume === undefined ? [] : ['resume', resume]), ...settings, '-'], {
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      shell: isShim,
    })

    child.stdout.setEncoding('utf8').on('data', text => {
      const lines = (pending + text).split('\n')

      pending = lines.pop() ?? ''
      lines.filter(line => line.trim() !== '').forEach(read)
    })
    // An npm install of Codex on Windows is a command shim (`codex.cmd`), which only a shell runs.
    child.on('error', error =>
      !isShim && process.platform === 'win32' && error.code === 'ENOENT'
        ? ((isRetried = true), run(true))
        : finish(null, `codex did not start: ${error.message}`),
    )
    child.on('close', code => (isRetried ? undefined : finish(code)))
    child.stdin.on('error', () => {})
    child.stdin.end(task)
  }

  run(false)
} else {
  if (model === undefined || model.startsWith('--')) {
    fail('--model is required: a model your Codex account offers')
  }

  if (MODELS !== undefined && !MODELS.includes(model)) {
    fail(`--model must be one of ${MODELS.join(', ')} (the list in ${join(FOLDER, 'models.json')})`)
  }

  if (!(mode in SANDBOXES)) {
    fail(`--mode must be one of ${Object.keys(SANDBOXES).join(', ')}`)
  }

  if (effort !== undefined && !EFFORTS.includes(effort)) {
    fail(`--effort must be one of ${EFFORTS.join(', ')}`)
  }

  let task = ''

  for await (const chunk of process.stdin.setEncoding('utf8')) {
    task += chunk
  }

  if (task.trim() === '') {
    fail('the task is read from standard input and was empty')
  }

  mkdirSync(TASKS, { recursive: true })

  // Old instructions and results are of no use to anyone.
  for (const name of readdirSync(TASKS)) {
    try {
      if (Date.now() - statSync(join(TASKS, name)).mtimeMs > KEPT_MS) {
        rmSync(join(TASKS, name))
      }
    } catch {
      // Another task's file, gone or in use: left alone.
    }
  }

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

  writeFileSync(join(TASKS, `${id}.task.txt`), task)

  // Detached, so the task outlives this call when the caller stops waiting for it.
  const forwarded = ['model', 'mode', 'effort', 'resume'].flatMap(name => (flag(name) === undefined ? [] : [`--${name}`, flag(name)]))

  spawn(process.execPath, [process.argv[1], '__worker', id, ...forwarded, '--dir', cwd], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref()

  await collect(id, { model, mode })
}
