export type CacheRenewedAt = number | null

export type AccountPanelView = {
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  contextPercent?: number
  // When the figures were read, in `$.clock.now()`'s ms: what the countdowns count from.
  now: number
} | null

// What the main loop last ran on, or was last switched to from the pane; a field is absent until seen.
export type AccountPanelCurrent = { model?: string; effort?: string }

// The one menu drawn expanded, as an accordion.
export type AccountPanelOpenMenu = 'model' | 'effort' | 'agents' | 'commands' | null

// One piece of work Claude handed to another agent, through its whole life. Codex's: assigned, running, then
// reported (or failed), and at last judged by Claude. A subagent of Claude's own: running, then done (or failed).
export type ExternalTask = {
  id: number
  agent: 'codex' | 'claude'
  title: string
  // The instruction as given and the agent's last message, each cut to what the pane shows.
  task: string
  report?: string
  model: string
  // Codex's: what it may touch, nothing, the working directory, or anything (no sandbox).
  mode?: 'read' | 'write' | 'full'
  // A subagent's: the type it was launched as.
  type?: string
  status: 'assigned' | 'running' | 'reported' | 'failed' | 'done'
  // The agent's own id for the task, known once it answers: what a later `wait` collects Codex's by, and
  // what a subagent's `turn.complete` carries.
  ref?: string
  // In `$.clock.now()`'s ms.
  assignedAt: number
  startedAt?: number
  endedAt?: number
  // The tokens the agent spent: Codex's on its own account, a subagent's on Claude's.
  tokens?: number
  verdict?: 'accepted' | 'fixed' | 'rejected'
  reason?: string
}

// One large piece of work of the session, kept by Claude; a finished one stays listed.
export type SessionGoal = { id: number; text: string; isDone: boolean }

// The agent's own account limits, as its last run recorded them; `readAt` is when, in `$.clock.now()`'s ms.
export type ExternalLimits = {
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  readAt: number
} | null

// Whether the agent's CLI answers and is signed in; `unknown` until asked.
export type ExternalLink = 'unknown' | 'linked' | 'missing'

declare module 'claude-code' {
  interface PluginState {
    'subagents-workflow': {
      cacheRenewedAt: CacheRenewedAt
      view: AccountPanelView
      current: AccountPanelCurrent
      openMenu: AccountPanelOpenMenu
      // The sections drawn expanded, each on its own switch: `claude` and its `stats`, the agents' `limits` and `tasks`.
      openParts: string[]
      tasks: ExternalTask[]
      openTask: number | null
      codexLink: ExternalLink
      codexLimits: ExternalLimits
      // What Claude is told about the helper, composed once so the system prompt holds still all session.
      brief: string | null
      // Which wording of the brief is held: a session resumed under a newer mod composes it again.
      briefVersion: number
      goals: SessionGoal[]
      // The name the person gave the session with /rename, as last seen here; null until then.
      sessionName: string | null
    }
  }
}
