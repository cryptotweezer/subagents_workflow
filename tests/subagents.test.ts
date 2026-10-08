import { expect, test } from 'claude-code/testing'

import { toLines } from '../hooks/format'
import { composeSubagentsBrief, readAgentAnswer, sumUsage } from '../hooks/subagents'

test('ends a foreground subagent with its model, tokens and report', () => {
  const result = {
    status: 'completed',
    agentId: 'a1',
    resolvedModel: 'claude-haiku-5-5',
    totalTokens: 1200,
    content: [{ text: 'found it' }],
  }

  expect(readAgentAnswer({ result }, 50)).toEqual({
    model: 'claude-haiku-5-5',
    status: 'done',
    endedAt: 50,
    ref: 'a1',
    tokens: 1200,
    report: 'found it',
  })
})

test('keeps a background subagent running under the id its turn will carry', () => {
  expect(readAgentAnswer({ result: { status: 'async_launched', agentId: 'a2' } }, 50)).toEqual({ ref: 'a2' })
})

test('fails a subagent that was refused or errored', () => {
  expect(readAgentAnswer({ deny: 'not allowed' }, 50)).toEqual({ status: 'failed', endedAt: 50, reason: 'not allowed' })
  expect(readAgentAnswer({ isError: true, text: 'boom' }, 50).reason).toBe('boom')
})

test('sums a turn usage and briefs Claude on when to delegate', () => {
  expect(sumUsage({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 })).toBe(10)
  expect(composeSubagentsBrief()).toContain('haiku')
})

test('lays a task out a sentence a line, paths cut to the file', () => {
  expect(toLines('Read only C:/Users/me/mod/hooks/a.ts. Do not edit.\n\n1. Line 45: bad.')).toEqual([
    'Read only a.ts.',
    'Do not edit.',
    '',
    '1. Line 45: bad.',
  ])
})
