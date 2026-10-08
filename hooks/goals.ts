import type { SessionGoal } from '../types'
import { commandHead } from './codex'

// The script Claude runs through Bash to keep the goals (`bin/goals.mjs`); a Bash call naming it changes the list.
const SCRIPT = 'goals.mjs'
const GOAL_LENGTH = 120
export const KEPT_GOALS = 30

export type GoalCall = { action: 'add' | 'done' | 'undo' | 'remove'; target: string }

// What a Bash command asks of the goals script, read off its text; `undefined` for any other command.
export function readGoalCall(command: string): GoalCall | undefined {
  const head = commandHead(command)

  if (!head.includes(SCRIPT)) {
    return undefined
  }

  // The script may be named through a shell variable, so the action is the first argument of any `node` run:
  // a goal's own words ("remove the export") are never read as one.
  const found = /node\s+(?:"[^"]*"|'[^']*'|\S+)\s+(add|done|undo|remove)\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s;&|<>]+(?:[ \t]+[^\s;&|<>]+)*))/.exec(head)
  const target = (found?.[2]?.replace(/\\(.)/g, '$1') ?? found?.[3] ?? found?.[4] ?? '').trim()

  return found === null || target === '' ? undefined : { action: found[1] as GoalCall['action'], target }
}

// The goal a target names: a number is its id and nothing else, words are the first goal whose text holds them.
function find(goals: SessionGoal[], target: string): SessionGoal | undefined {
  return /^\d+$/.test(target)
    ? goals.find(goal => goal.id === Number(target))
    : goals.find(goal => goal.text.toLowerCase().includes(target.toLowerCase()))
}

// The list after a call. A finished goal stays, struck through; only `remove` takes one out.
export function applyGoal(goals: SessionGoal[], { action, target }: GoalCall): SessionGoal[] {
  if (action === 'add') {
    const id = Math.max(0, ...goals.map(goal => goal.id)) + 1
    const text = target.length > GOAL_LENGTH ? `${target.slice(0, GOAL_LENGTH - 1)}…` : target

    return [...goals, { id, text, isDone: false }].slice(-KEPT_GOALS)
  }

  const goal = find(goals, target)

  if (goal === undefined) {
    return goals
  }

  return action === 'remove'
    ? goals.filter(other => other.id !== goal.id)
    : goals.map(other => (other.id === goal.id ? { ...other, isDone: action === 'done' } : other))
}

// The list as Claude reads it back after a change.
export function listGoals(goals: SessionGoal[]): string {
  return goals.length === 0
    ? 'Session goals: none.'
    : `Session goals now:\n${goals.map(goal => `${goal.id}. [${goal.isDone ? 'x' : ' '}] ${goal.text}`).join('\n')}`
}

// What Claude is told about the goals at the start of every session.
export function composeGoalsBrief(script: string): string {
  return [
    '# Session goals (side pane)',
    "The user follows this session's big goals in a side pane, and keeping that list is your job, not theirs:",
    'never ask them to state goals up front. When the conversation takes on a large piece of work (a feature, a',
    'refactor, a redesign, a migration: something worth an hour, not a single edit or a question), add it; when',
    'it is finished and verified, mark it done. Finished goals stay listed, struck through. Keep each one short,',
    "in the user's language, and do not narrate these calls in your reply.",
    '',
    `node "${script}" add "short goal"`,
    `node "${script}" done <number or words of the goal>`,
    `node "${script}" undo <number>   |   remove <number>   (a goal added by mistake)`,
    '',
    'Each call answers with the list as it stands.',
  ].join('\n')
}
