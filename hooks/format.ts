import type { SessionRateLimit } from 'claude-code'

export type Stats = {
  rateLimits: readonly SessionRateLimit[]
  contextPercent?: number
  // When the prompt cache of the last response lapses, in `$.clock.now()`'s ms.
  cacheExpiresAt?: number
}

export type Level = 'ok' | 'warn' | 'hot'

// `fill` is how much of the row's bar is lit, 0 to 1; absent, the row has no bar.
export type Row = { label: string; value: string; details: string[]; level: Level; fill?: number }

const LABELS: Record<string, string> = {
  five_hour: 'SESSION',
  seven_day: 'WEEK',
  spend_limit: 'SPEND',
}
const ORDER = ['five_hour', 'seven_day', 'spend_limit']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const CACHE_WARN_MS = 10 * 60_000

const pad = (n: number) => String(n).padStart(2, '0')

const rank = (kind: string) => {
  const index = ORDER.indexOf(kind)

  return index === -1 ? ORDER.length : index
}

const levelOf = (percent: number): Level => (percent >= 80 ? 'hot' : percent >= 50 ? 'warn' : 'ok')

const clamp = (n: number) => Math.min(1, Math.max(0, n))

export const formatRemaining = (ms: number) => {
  if (ms <= 0) {
    return 'now'
  }

  const minutes = Math.ceil(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)

  if (days > 0) {
    return `${days}d ${hours}h`
  }

  return hours > 0 ? `${hours}h ${pad(minutes % 60)}m` : `${minutes}m`
}

export const formatResetAt = (resetsAt: number, now: number) => {
  const at = new Date(resetsAt)
  const hours = at.getHours()
  const time = `${hours % 12 === 0 ? 12 : hours % 12}:${pad(at.getMinutes())} ${hours < 12 ? 'AM' : 'PM'}`
  const isToday = at.toDateString() === new Date(now).toDateString()

  return isToday ? time : `${DAYS[at.getDay()]} ${time}`
}

export const formatBar = (fill: number, width: number) => {
  const lit = Math.round(clamp(fill) * width)

  return '█'.repeat(lit) + '░'.repeat(width - lit)
}

const windowRow = (limit: SessionRateLimit, now: number): Row => {
  const resetsAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)

  return {
    label: LABELS[limit.kind] ?? limit.kind.toUpperCase(),
    value: `${limit.percentUsed}%`,
    details: Number.isNaN(resetsAt)
      ? []
      : [`resets ${formatResetAt(resetsAt, now)}`, `in ${formatRemaining(resetsAt - now)}`],
    level: levelOf(limit.percentUsed),
    fill: clamp(limit.percentUsed / 100),
  }
}

export const toRows = ({ rateLimits, contextPercent, cacheExpiresAt }: Stats, now: number, cacheTtlMs: number) => {
  const rows = [...rateLimits].sort((a, b) => rank(a.kind) - rank(b.kind)).map(limit => windowRow(limit, now))

  if (rows.length === 0) {
    rows.push({ label: 'LIMITS', value: 'no reading yet', details: [], level: 'ok' })
  }

  if (contextPercent !== undefined) {
    rows.push({
      label: 'CTX',
      value: `${contextPercent}%`,
      details: [],
      level: levelOf(contextPercent),
      fill: clamp(contextPercent / 100),
    })
  }

  if (cacheExpiresAt !== undefined) {
    const left = cacheExpiresAt - now

    rows.push(
      left > 0
        ? {
            label: 'CACHE',
            value: `${formatRemaining(left)} left`,
            details: ['next prompt is cheap'],
            level: left < CACHE_WARN_MS ? 'warn' : 'ok',
            fill: clamp(left / cacheTtlMs),
          }
        : { label: 'CACHE', value: 'expired', details: ['next prompt rereads all'], level: 'hot', fill: 0 },
    )
  }

  return rows
}

// A model as a person reads it: `claude-opus-5-5-20260101` is `Opus 5.5`, and an alias (`opus`), which names
// no version until a request resolves it, is `Opus (latest)`.
export function formatModelName(id: string): string {
  const [family = id, ...version] = id
    .replace(/^claude-/, '')
    .replace(/(-\d{8}|\[).*$/, '')
    .split('-')
  const name = family.charAt(0).toUpperCase() + family.slice(1)

  return version.length === 0 ? `${name} (latest)` : `${name} ${version.join('.')}`
}

// A task or a report as the pane's lines: a sentence each where it came as one paragraph, a blank line
// between paragraphs, and a long path cut to its file's name.
export function toLines(text: string): string[] {
  return text
    .replace(/(?:[A-Za-z]:[\/]|\/)(?:[^\s\/:*?"<>|]+[\/])+([^\s\/:*?"<>|]+)/g, '$1')
    .split(/\n\s*\n/)
    .flatMap((paragraph, index) => [
      ...(index === 0 ? [] : ['']),
      ...paragraph.split('\n').flatMap(line => line.trim().split(/(?<=[^\d\s][.?!])\s+(?=[A-Z"`])/)),
    ])
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
}
