import type { ExternalTask } from '../types'
import { cut } from './codex'

// An Agent call's answer, as far as it is read here: the tool's record varies with how the subagent ran.
export type AgentAnswer = { deny?: string; isError?: boolean; text?: string; result?: unknown }

type AgentRecord = {
  status?: string
  agentId?: string
  taskId?: string
  resolvedModel?: string
  totalTokens?: number
  content?: { text?: string }[]
  sessionUrl?: string
}

// Every token a turn was answered over and generated, the cached ones included.
export function sumUsage(usage: {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}): number {
  return usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
}

// What the answer changes in the subagent's task: its end, or for one sent to the background the id its
// own `turn.complete` will carry.
export function readAgentAnswer(ran: AgentAnswer, now: number): Partial<ExternalTask> {
  if (ran.deny !== undefined || ran.isError === true) {
    return { status: 'failed', endedAt: now, reason: cut(ran.deny ?? ran.text ?? 'failed', 200) }
  }

  const record = (ran.result ?? {}) as AgentRecord
  const model = record.resolvedModel === undefined ? {} : { model: record.resolvedModel }
  // Left out when unknown, so what the spawn already wrote stands.
  const ref = record.agentId === undefined ? {} : { ref: record.agentId }

  if (record.status === 'completed') {
    const report = cut((record.content ?? []).map(block => block.text ?? '').join('\n').trim())

    return { ...model, status: 'done', endedAt: now, ...ref, tokens: record.totalTokens, report }
  }

  // A cloud session runs no loop here, so nothing later says it ended.
  if (record.status === 'remote_launched') {
    return { status: 'done', endedAt: now, ref: record.taskId, report: `runs in the cloud: ${record.sessionUrl ?? ''}` }
  }

  return { ...model, ...ref }
}

// What Claude reads about its own subagents at the start of every session: the person's standing leave.
export function composeSubagentsBrief(): string {
  return [
    '# Claude subagents',
    'By installing this mod the user gave standing leave to launch your own subagents through the Agent tool, on',
    'a cheaper Claude model where one fits, and you decide when and how without asking. The one aim is to spend',
    'fewer tokens at the same quality: when a subagent would not save tokens, or would lower quality, do the',
    'work yourself.',
    '',
    '- `haiku`: wide searches and bulk reading, where much is read and little comes back.',
    '- `sonnet`: mechanical, well bounded edits across named files.',
    '- Yourself: anything small, delicate, architectural, or that leans on this conversation (a subagent starts',
    '  cold, so a short task costs more to explain than to do).',
    '- Any other model: only where you know it costs less for the same result.',
    '',
    'The user follows every subagent live in the side pane, with its type and model: give each a clear',
    '`description`.',
  ].join('\n')
}
