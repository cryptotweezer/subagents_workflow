# Subagents Workflow

A Claude Code mod (installed as `subagents-workflow`) that turns Claude into an orchestrator and shows you the
whole thing in a side pane.

Claude keeps the hard thinking for itself and hands the bulky, well bounded work to cheaper workers: an
external agent (OpenAI Codex, on your own account) or its own subagents running on cheaper Claude models.
The pane shows your usage limits, every delegated task as it runs, the session's goals, and gives you
one-click controls for the model, the effort level and common commands.

> Status: `0.1.0`, built and used daily on Windows. macOS and Linux are untested. See
> [Known limitations](#known-limitations).

## Contents

- [What you get](#what-you-get)
- [Why delegate](#why-delegate)
- [Requirements](#requirements)
- [Install](#install)
- [Using the pane](#using-the-pane)
- [How delegation works](#how-delegation-works)
- [The playbook: Claude learns which model fits which job](#the-playbook-claude-learns-which-model-fits-which-job)
- [Configuration](#configuration)
- [What the mod tells Claude](#what-the-mod-tells-claude)
- [Privacy](#privacy)
- [Known limitations](#known-limitations)
- [Development](#development)
- [Adding another agent](#adding-another-agent)
- [License](#license)

## What you get

Open or close the pane with `/panel`. It has five sections, each one foldable.

| Section | What it shows | What you can do |
| --- | --- | --- |
| **CLAUDE** | Session (5 h) and week (7 d) usage with reset times, context fill, prompt cache time left | Switch model and effort with a click, run common slash commands |
| **EXTERNAL AGENTS** | Whether Codex is installed and signed in, and its own 5 h and weekly limits | See at a glance if there is Codex quota left before a big task |
| **AGENT TASKS** | Every task Claude delegated, to Codex or to a Claude subagent: who has it, which model, how long, and the result | Click a task to read the instruction Claude gave and the report it got back |
| **SESSION GOALS** | The big goals of the session, kept by Claude; finished ones stay, struck through | Nothing: Claude maintains the list |
| **SESSION NAME** | The session's name and the command to resume it | Name the session, then come back later with `claude -r "<name>"` |

Below them, a **DICTATE** button turns speech into text in the prompt (Windows; experimental on macOS).

## Why delegate

Every token Claude reads costs you quota. A lot of work is reading much and returning little: exploring a
repository, reviewing many files, mechanical edits, writing tests for code that exists, web research.
Handing that to a cheaper worker means the cheap model reads the bulk and only its conclusion reaches
Claude. Claude's context stays small, which also makes every later turn cheaper.

This mod sets up two kinds of worker:

- **An external agent, Codex.** Its tokens come out of your OpenAI account instead of your Claude quota.
- **Claude's own subagents on cheaper models.** Claude can launch a subagent on Haiku or Sonnet for a
  search or a mechanical edit, instead of doing it on the model you have selected.

Claude stays the senior engineer in both cases: it decides what to delegate, reviews everything that comes
back, and alone decides what is kept.

**One measured data point, not a promise.** In a single A/B test (a bug hunt in a 147 file repository),
Claude alone cost $3.00 and took 4 minutes; delegating the exploration to Codex and only verifying cost
$1.03 on the Claude side and took 13 minutes. That is 66% less Claude spend, about 3 times slower, and it
used about 20% of the Codex 5 hour quota. Results will vary with the task. Small tasks do not save
anything: each delegation has a fixed start-up cost, so the mod tells Claude to do small work itself.

## Requirements

| Requirement | Needed for | Notes |
| --- | --- | --- |
| **Claude Code** with mod (hooks module) support | Everything | Built on `2.1.294`. Earlier versions may not load it. |
| **Node.js** on your `PATH` | Codex launcher, goals, Codex limits | Any current LTS. |
| **Codex CLI**, installed and signed in | The Codex part only | Tested with `codex-cli 0.160`. Needs an **active OpenAI account or plan** that includes Codex. Run `codex login` once. |
| **Windows 10 or 11**, or **macOS** (experimental) | The DICTATE button only | Uses Windows voice typing, or macOS Dictation. |

Codex is optional. Without it the pane shows `codex missing`, Claude is told nothing about it, and
everything else works, including delegation to Claude's own subagents.

**Other external agents.** Codex is the only external agent supported today. The task list and the pane
are built to hold more than one, so you can wire in your own (OpenCode and similar CLIs): see
[Adding another agent](#adding-another-agent). Whichever agent you use needs its own CLI installed and its
own active account.

## Install

From a terminal session of Claude Code, type at the prompt:

```
/plugin install subagents-workflow --marketplace cryptotweezer/subagents_workflow
```

Answer `y` to add the marketplace, then pick
a scope: **user** makes the mod load in every project. Then open the pane:

```
/panel
```

To try it without installing, clone the repository and load it for one session:

```
git clone https://github.com/cryptotweezer/subagents_workflow.git
claude --plugin-dir ./subagents_workflow
```

To update later, run `claude plugin update subagents-workflow` and then `/reload-plugins`.

## Using the pane

- **`/panel`** opens or closes the pane. The mod works whether the pane is open or not: the pane is only
  the view.
- **Sections fold.** Click a section's title. A folded section still shows its key figures in the header.
- **MODEL and EFFORT** switch through Claude Code's own `/model` and `/effort`.
- **COMMANDS** runs common slash commands with a click. `/compact` is highlighted once the context is 70%
  full.
- **AGENT TASKS** lists the last tasks, newest first. Click one to see the instruction (`TASK`) and the
  answer (`REPORT`). `clear tasks` removes the finished ones; a task still running, or a Codex report
  still waiting for Claude's verdict, stays.
- **DICTATE**: one click starts listening, the next click stops. See [Configuration](#configuration) for
  the language.

After `/clear` the mod stays loaded. The task list, the goals and the session name start empty, because
it is a new conversation, and the Codex connection is checked again by itself within a minute.

## How delegation works

### Codex

Claude runs Codex through a small launcher, `bin/codex-task.mjs`, as an ordinary Bash call. You do not
run it yourself; this is what Claude uses:

```
node bin/codex-task.mjs --model <model> --mode read|write|full --dir "<project root>" --title "few words" <<'TASK'
the full, self-contained instruction
TASK
```

| Mode | What Codex may do |
| --- | --- |
| `read` | Read and analyse. It cannot change files. |
| `write` | Edit files inside `--dir`, with network access. |
| `full` | **No sandbox at all.** Codex can act anywhere on the machine. Claude is told to use it only when a task truly needs it, and to tell you. |

A task goes through these steps, and you watch each one in the pane:

1. **Working.** Claude handed the task over.
2. **Reported.** Codex answered. Claude now reads the report and the diff.
3. **Judged.** Claude records a verdict: `accepted` (kept as delivered), `fixed` (kept after a
   correction) or `rejected` (discarded, and Claude does the work itself).

Codex never commits or pushes. A long task (more than nine minutes) keeps running on its own and Claude
collects it later, so nothing is lost when a call times out.

### Claude subagents

Claude launches these with its built-in Agent tool, choosing the model per task:

- **Haiku** for wide searches and bulk reading.
- **Sonnet** for mechanical, well bounded edits across named files.
- **Itself** for anything small, delicate, architectural, or that depends on the conversation.

They appear in AGENT TASKS with their type and model, go from `working` to `done` (or `failed`), and have
no verdict step: Claude reads the report in the same turn.

## The playbook: Claude learns which model fits which job

The mod keeps two files in `~/.claude/codex/`, outside the repository and shared by every project:

| File | What it is |
| --- | --- |
| `playbook.md` | Claude's own notes on working with Codex: which kinds of task it does well or badly, which model fits which job, which ways of asking worked. At most 40 lines, rewritten rather than appended. |
| `runs.json` | The record of the last 50 Codex tasks: date, title, model, mode, duration, and the verdict. |

Both are read at the start of every session and given to Claude, together with a per-model summary of how
many tasks were kept. When a task teaches Claude something durable, it edits the playbook. The effect is
that delegation gets better tuned to your account and your kind of work over time, instead of starting
from zero in each session.

On first use the mod creates `playbook.md` from `playbook.template.md`. It is a plain Markdown file: read
it, edit it, or add your own rules.

## Configuration

| Setting | Where | Effect |
| --- | --- | --- |
| Allowed Codex models | `~/.claude/codex/models.json` | A JSON list of model names, for example `["model-a", "model-b"]`. The launcher refuses any other model. Without the file, any model your account offers is accepted. Useful to keep Claude away from an expensive model. |
| Dictation language | Environment variable `SUBAGENTS_WORKFLOW_DICTATION_LANGUAGE` | A language tag such as `fr-FR`. See below. |
| Codex data folder | Environment variable `CODEX_HOME` | Where Codex keeps its sessions, if not `~/.codex`. Used to read its limits. |

### Dictation language

Dictation works in English out of the box on an English Windows: voice typing listens in the language of
the active keyboard, so if you dictate in the language you type in, there is nothing to configure.

To dictate in another language, add that language to Windows (Settings, Time and language, Language and
region), then set the variable in the `env` block of `~/.claude/settings.json` and restart Claude Code:

```json
{
  "env": {
    "SUBAGENTS_WORKFLOW_DICTATION_LANGUAGE": "fr-FR"
  }
}
```

The button then switches the keyboard to that language while it listens and back when you stop.

### Dictation on macOS (experimental)

On a Mac the button presses the front app's own **Edit, Start Dictation** menu item through `osascript`.
This path is written but **has not been tested by the author**: reports are welcome. It needs:

- Dictation turned on in System Settings, Keyboard. The language is the one chosen there; the
  `SUBAGENTS_WORKFLOW_DICTATION_LANGUAGE` variable has no effect on macOS.
- Accessibility permission for the terminal that runs Claude Code (System Settings, Privacy and Security,
  Accessibility). macOS asks the first time.

The menu item is found by its name, so it is met in English, Spanish, French and German; with macOS in
another language the button may find nothing and say so.

## What the mod tells Claude

A mod can add text to Claude's system prompt, and this one does. You should know what it says:

- **Goals.** Claude keeps the list of the session's big goals in the pane, without asking you to state
  them.
- **Subagents.** By installing the mod you give Claude standing permission to launch its own subagents on
  cheaper models when that saves tokens without lowering quality, and to decide when on its own.
- **Codex** (only when Codex is installed and signed in). How to run it, when to delegate, how to judge
  the result, plus your playbook and track record.

The exact wording is in `hooks/goals.ts`, `hooks/subagents.ts` and `hooks/codex.ts`. If you do not want
Claude to delegate on its own, do not install the mod, or edit those texts.

## Privacy

- The mod sends nothing anywhere by itself. It has no telemetry and no network calls of its own.
- A task delegated to Codex is sent to OpenAI by the Codex CLI, under your own account and its terms.
  That includes the instruction Claude wrote and whatever files Codex reads to do the work.
- `playbook.md`, `runs.json`, `models.json` and the task files live in `~/.claude/codex/` on your machine.
  They are not part of this repository.
- Codex's limits are read from the session files Codex itself writes on your machine.

## Known limitations

- **Windows is the only tested platform.** The pane and delegation are written to be portable, but macOS
  and Linux have not been run. Dictation works on Windows, is experimental on macOS, and is absent on Linux.
- **Codex is detected by reading Claude's Bash commands.** It works and is covered by tests, but it is
  the most fragile part of the mod.
- **Codex limits are not live.** They are the last reading Codex left on this machine, refreshed every
  five minutes; the pane says how old a reading is.
- **Prompt cache time assumes a one hour cache**, which is what subscription plans use. On a plan with a
  five minute cache the countdown is wrong.
- **The list of previous Claude models is written by hand** and will age.
- **The `/compact` hint at 70% context** is fixed.
- **Voice typing pauses by itself after a few seconds of silence.** Click DICTATE again to resume or
  finish.
- **Savings are not guaranteed.** They depend on the task; see [Why delegate](#why-delegate).

## Development

```
git clone https://github.com/cryptotweezer/subagents_workflow.git
claude --plugin-dir ./subagents_workflow      # load it for one session, reloading on every save
claude plugin validate ./subagents_workflow   # check the manifest and the hooks module
claude plugin test ./subagents_workflow       # run the tests
```

| Path | What it holds |
| --- | --- |
| `hooks/register.tsx` | The hooks module: the pane, the commands, and the tracking of delegated work |
| `hooks/codex.ts`, `hooks/subagents.ts`, `hooks/goals.ts` | Parsing of each kind of call, and the texts given to Claude |
| `hooks/format.ts` | Formatting of bars, times and text |
| `bin/codex-task.mjs` | The Codex launcher |
| `bin/codex-limits.mjs` | Reads Codex's rate limits from its session files |
| `bin/goals.mjs` | The goals script Claude calls |
| `bin/dictate.ps1` | Starts and stops Windows voice typing |
| `bin/dictate.applescript` | Starts and stops macOS Dictation (experimental) |
| `types/index.d.ts` | The type contract of the state the mod keeps |
| `tests/` | Tests, run with `claude plugin test` |

Bug reports and ideas are welcome as GitHub issues.

## Adding another agent

Codex is the only external agent wired in, but the task list and the pane already hold any agent. To add
another CLI (OpenCode or similar), fork the repository, load your copy with `claude --plugin-dir`, and ask
Claude to wire it in. Do not edit the installed copy: an update overwrites it.

It is a coding task, not a setting, and no other agent has been tested. Point Claude at this list, which is
every place Codex is specific:

| Piece | Where | What the new agent needs |
| --- | --- | --- |
| Launcher | `bin/codex-task.mjs` | A script that runs the CLI with the instruction, prints one summary line and then the report, and records a verdict. |
| Reading the call and its output | `hooks/codex.ts` (`readCall`, `readOutcome`) | The same two readers for the new launcher: what a Bash command asks of it, and what it printed. |
| Tracking | `hooks/register.tsx` (the `tool.call` hook on `Bash`) | A task enlisted when the launcher is called, ended when it answers. |
| The agent's name | `types/index.d.ts` (`ExternalTask.agent`) | Its name added to `'codex' | 'claude'`. |
| What Claude is told | `hooks/codex.ts` (`composeBrief`) | A text of its own in the system prompt: how to run it, when to delegate, how to judge it. |
| Link and limits (optional) | `hooks/register.tsx` (`link`), `bin/codex-limits.mjs` | A check that the CLI is installed and signed in, and its quota if it exposes one, shown under EXTERNAL AGENTS. |

Then add tests beside `tests/codex.test.ts` and run `claude plugin validate` and `claude plugin test`.
Before sending work to a new agent, read its privacy terms: the instruction and the files it reads leave
your machine under that agent's account.

## License

MIT. See [LICENSE](LICENSE).
