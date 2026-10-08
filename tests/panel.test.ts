import { expect, mock, test } from 'claude-code/testing'

import { formatBar, formatModelName, formatRemaining, formatResetAt, toRows } from '../hooks/format'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const HOUR = 3_600_000

test('formats the time left', () => {
  expect(formatRemaining(0)).toBe('now')
  expect(formatRemaining(45 * 60_000)).toBe('45m')
  expect(formatRemaining(2 * HOUR + 5 * 60_000)).toBe('2h 05m')
  expect(formatRemaining(76 * HOUR)).toBe('3d 4h')
})

test('formats a reset in local 12-hour time, with the day when not today', () => {
  const today = new Date(2026, 9, 6, 9, 0).getTime()

  expect(formatResetAt(new Date(2026, 9, 6, 19, 0).getTime(), today)).toBe('7:00 PM')
  expect(formatResetAt(new Date(2026, 9, 7, 0, 30).getTime(), today)).toBe('Wed 12:30 AM')
})

test('lights the bar by its fill', () => {
  expect(formatBar(0, 4)).toBe('░░░░')
  expect(formatBar(0.5, 4)).toBe('██░░')
  expect(formatBar(2, 4)).toBe('████')
})

test('orders the rows and raises the level near a limit', () => {
  const rows = toRows(
    {
      rateLimits: [
        { kind: 'seven_day', percentUsed: 50 },
        { kind: 'five_hour', percentUsed: 85, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
      ],
      contextPercent: 10,
      cacheExpiresAt: NOW - 1,
    },
    NOW,
    HOUR,
  )

  expect(rows.map(row => `${row.label} ${row.value} ${row.level}`)).toEqual([
    'SESSION 85% hot',
    'WEEK 50% warn',
    'CTX 10% ok',
    'CACHE expired hot',
  ])
  expect(rows[0]?.details[1]).toBe('in 2h 00m')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`draws the pane on ${surface} and keeps it current`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })

    const ran: string[] = []
    const filled: string[] = []

    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('command.run', (_, e) => {
      ran.push(`${e.command} ${e.args ?? ''}`.trim())

      return { text: '' }
    })
    on('prompt.fill', (_, e) => {
      filled.push(e.text)

      return { isFilled: true, text: e.text, cursor: e.text.length }
    })
    on('session.usage', () => ({
      value: {
        startedAt: NOW,
        context: { window: 200_000, percent: 12 },
        rateLimits: [{ kind: 'five_hour', percentUsed: 10, resetsAt: new Date(NOW + 3 * HOUR).toISOString() }],
      },
    }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.measure', (_, e) => ({ changed: e.changed }))

    await $.session.start({ cwd: '/work', surface, isInteractive: true })

    const ui = await $.ui.mount({
      plugin: 'subagents-workflow',
      surface,
      component: 'Pane',
      requestId: 'account-stats',
      props: { bodyColumns: 30 } as never,
    })
    const shown = async () => (await ui.find({ type: 'Box' }))?.text ?? ''

    // Folded, the section says its figures in its header; unfolded, it draws them in full.
    expect(await shown()).toMatch(/SESSION NAME unnamed/)

    await ui.press({ key: 'part:session' })
    await ui.press({ key: 'session:rename' })
    await $.command.run({ command: 'rename', args: 'mod panel' } as never)
    await ui.redraw()

    expect(await shown()).toMatch(/SESSION NAME mod panel/)
    expect(await shown()).toMatch(/resume: claude -r "mod panel"/)
    expect(await shown()).toMatch(/CLAUDE 10% · ctx 12%/)
    expect(await shown()).not.toMatch(/SESSION [0-9]/)

    await ui.press({ key: 'part:claude' })

    expect(await shown()).toMatch(/STATS.*MODEL.*EFFORT/)
    expect(await shown()).not.toMatch(/SESSION [0-9]/)

    await ui.press({ key: 'part:stats' })

    expect(await shown()).toMatch(/SESSION 10%/)
    expect(await shown()).toMatch(/in 3h 00m/)
    expect(await shown()).toMatch(/CTX 12%/)

    await $.session.measure({
      context: { window: 200_000, percent: 12 },
      rateLimits: [{ kind: 'seven_day', percentUsed: 80 }],
      changed: ['context', 'rateLimits'],
    })
    await ui.redraw()

    expect(await shown()).toMatch(/WEEK 80%/)
    expect(await shown()).toMatch(/CACHE 1h 00m left/)
    expect((await ui.find({ type: 'Text', text: '80%' }))?.props.color).toBe('#ff003c')

    await clock.advance(61 * 60_000)
    await ui.redraw()

    expect(await shown()).toMatch(/CACHE expired/)
    expect(await ui.find({ key: 'cmd:compact' })).toBeUndefined()

    expect(await shown()).toMatch(/MODEL after next reply/)

    await ui.press({ key: 'menu:model' })
    expect(await shown()).toMatch(/LATEST.*Opus.*Haiku.*PREVIOUS.*Sonnet 4.6/)

    await ui.press({ key: 'model:sonnet' })
    await ui.press({ key: 'menu:effort' })

    expect(await ui.find({ key: 'model:sonnet' })).toBeUndefined()

    await ui.press({ key: 'effort:high' })

    expect(await shown()).toMatch(/MODEL Sonnet .latest./)
    expect(await shown()).toMatch(/EFFORT high/)

    await ui.press({ key: 'menu:commands' })

    expect(await ui.findAll({ type: 'Button' })).toHaveLength(21)

    await ui.press({ key: 'cmd:compact' })
    await ui.press({ key: 'cmd:loop' })

    expect(await shown()).not.toMatch(/compact due/)

    await $.session.measure({
      context: { window: 200_000, percent: 72 },
      rateLimits: [],
      changed: ['context'],
    })
    await ui.redraw()

    expect(await shown()).toMatch(/COMMANDS .compact due/)
    expect(await shown()).toMatch(/compact ◀ CTX 72%/)

    expect(filled[0]).toBe('/rename ')
    expect(ran).toEqual(['rename mod panel', 'model sonnet', 'effort high', 'compact'])
    expect(filled).toEqual(['/rename ', '/loop '])
  })
}

test('names a model by family and version, whatever the version', () => {
  expect(formatModelName('opus')).toBe('Opus (latest)')
  expect(formatModelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(formatModelName('claude-opus-6-20270101')).toBe('Opus 6')
  expect(formatModelName('claude-opus-5-5[1m]')).toBe('Opus 5.5')
})
