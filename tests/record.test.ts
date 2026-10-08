import { expect, test } from 'claude-code/testing'

import { composeBrief, readRuns, summarize, toRecord } from '../hooks/codex'
import type { CodexRunRecord } from '../hooks/codex'

const RUNS: CodexRunRecord[] = [
  { date: '2026-10-06', title: 'rename helpers', model: 'gpt-6.1-sol', mode: 'write', seconds: 90, outcome: 'accepted' },
  { date: '2026-10-06', title: 'add retry tests', model: 'gpt-6.1-sol', mode: 'write', seconds: 240, outcome: 'rejected', reason: 'tests fail' },
  { date: '2026-10-06', title: 'search docs', model: 'gpt-6-luna', mode: 'read', seconds: 30, outcome: 'fixed' },
]

test('keeps a finished task as one line of the record', () => {
  const assignedAt = Date.parse('2026-10-06T12:00:00Z')

  expect(
    toRecord({
      id: 1,
      agent: 'codex',
      title: 'rename helpers',
      task: 'x',
      model: 'gpt-6-sol',
      mode: 'write',
      status: 'reported',
      assignedAt,
      endedAt: assignedAt + 90_000,
      verdict: 'accepted',
    }),
  ).toEqual({
    date: '2026-10-06',
    title: 'rename helpers',
    model: 'gpt-6-sol',
    mode: 'write',
    seconds: 90,
    outcome: 'accepted',
    reason: undefined,
  })
  expect(readRuns('not json')).toEqual([])
})

test('sums the record per model and names the latest misses', () => {
  expect(summarize([])).toBe('No runs recorded yet.')
  expect(summarize(RUNS)).toBe(
    ['- gpt-6.1-sol: 1/2 kept', '- gpt-6-luna: 1/1 kept', 'Latest misses:', '- rejected (gpt-6.1-sol): add retry tests, tests fail'].join('\n'),
  )
})

test('briefs Claude with the launcher, the playbook and the record', () => {
  const brief = composeBrief({ launcher: 'C:/mod/bin/codex-task.mjs', folder: 'C:/home/.claude/codex', playbook: '- rule one\n', runs: RUNS })

  expect(brief).toContain('node "C:/mod/bin/codex-task.mjs" --model <model>')
  expect(brief).toContain('C:/home/.claude/codex/playbook.md')
  expect(brief).toContain('## Playbook\n- rule one\n')
  expect(brief).toContain('gpt-6.1-sol: 1/2 kept')
  expect(brief).toContain('--resume <thread>')
  expect(brief).toContain('verdict accepted|fixed|rejected')
})
