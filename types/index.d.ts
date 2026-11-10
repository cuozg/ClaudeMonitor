/** Token or dollar figures split by kind: uncached input, cache write, cache read, output. */
export type Tok = { in: number; cw: number; cr: number; out: number }

/** A tool call in flight. */
export type Flight = { id: string; desc: string; ts: number }

/** One tool call of an agent: what it did, when, and the lines it changed. */
export type Step = { id: string; ts: number; end: number; tag: string; text: string; err: boolean; plus: number; minus: number }

/** The main loop or one subagent: what it spent and what it is doing. */
export type Owner = {
  id: string
  label: string
  type: string
  model: string
  effort: string
  background: boolean
  tok: Tok
  usd: Tok
  nocache: number
  ctx: number
  nTools: number
  first: number
  last: number
  act: number[]
  errs: number[]
  flights: Flight[]
  steps: Step[]
  action: string
  say: string
  sayTs: number
  report: string
}

/** One row of the log tail. */
export type LogEvent = { ts: number; who: string; text: string; tag: string }

/** A background shell, monitor or agent. */
export type Task = {
  id: string
  kind: 'shell' | 'monitor' | 'agent'
  desc: string
  owner: string
  start: number
  end: number
  state: 'run' | 'done' | 'fail' | 'stop'
  note: string
  events: number
}

/** Everything the monitor has recorded this session. */
export type Mon = {
  owners: Record<string, Owner>
  order: string[]
  log: LogEvent[]
  tasks: Task[]
  samples: [number, number][]
  working: boolean
  closed: boolean
  agentsClosed: boolean
}

/** The context window broken down as /context does. */
export type CtxRow = { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }
export type CtxView = {
  window: number
  tokens: number
  rows: CtxRow[]
  memory: { name: string; type: string; tokens: number }[]
  mcpDeferred: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-monitor': { data: Shaped<Mon>; ctx: Shaped<CtxView | null> }
  }
}
