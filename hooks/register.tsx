// Claude Monitor: records the session from engine events into $.state and
// draws it in a pane beside the chat on every surface (CLI, Desktop, VS Code).
import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type { CtxView, Mon, Owner, Task } from '../types'
import { addTok, zero, describeTool, firstLine, lineDelta, newOwner, price, sourcesOf, sumTok, summaryLine, taskNotes } from './lib'
import { drawBand, drawPane, type AgentsBox } from './view'

const PANE = 'session-monitor'
const TITLE = 'Monitor'
// Asks for the widest dock the terminal allows (45% of its columns).
const DOCK_COLUMNS = 400
const MAX_TS = 400
const MAX_STEPS = 40

const empty = (): Mon => ({ owners: { main: newOwner('main', 'main') }, order: ['main'], tasks: [], samples: [], working: false, closed: false, monitorClosed: false, agentsClosed: false })
const data = atom({ plugin: 'session-monitor', key: 'data' } as const, empty(), { shape: 'mon-3' })
const ctx = atom({ plugin: 'session-monitor', key: 'ctx' } as const, null, { shape: 'ctx-1' })

let tick = 0
// The subagents column scrolls on its own: its offset, its last offset, and where it was last drawn.
let agentsOff = 0
let agentsMax = 0
let agentsBox: AgentsBox | undefined

const ownerOf = (m: Mon, id: string | undefined): Owner => {
  const key = id ?? 'main'
  let o = m.owners[key]
  if (!o) {
    o = newOwner(key, 'agent ' + key.slice(0, 6))
    m.owners[key] = o
    m.order.push(key)
  }
  return o
}

/** Applies `fn` to a copy of the recorded session and writes it back. */
const edit = ($: EngineInterface, fn: (m: Mon) => void) =>
  update($, data, prev => {
    const m: Mon = JSON.parse(JSON.stringify(prev))
    fn(m)
    return m
  })

const push = <T,>(list: T[], item: T, cap: number) => {
  list.push(item)
  if (list.length > cap) list.splice(0, list.length - cap)
}

const seen = (o: Owner, ts: number) => {
  if (!o.first) o.first = ts
  o.last = Math.max(o.last, ts)
}

async function measureContext($: EngineInterface) {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  const view: CtxView = {
    window: b?.rawMaxTokens ?? usage.context.window,
    tokens: usage.context.tokens ?? b?.totalTokens ?? 0,
    rows: (b?.categories ?? []).map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
    memory: (b?.memoryFiles ?? []).map(f => ({ name: f.path.split('/').pop() ?? f.path, type: f.type, tokens: f.tokens })),
    mcpDeferred: (b?.mcpTools ?? []).filter(t => !t.isLoaded).length,
  }
  await update($, ctx, () => view)
}

async function openPane($: EngineInterface, columns = DOCK_COLUMNS) {
  // The terminal paints a docked pane in a fill of its own; draw on the terminal's background instead.
  const onTerminal = (await $.session.surfaces()).includes('terminal')
  return $.ui.open({ id: PANE, title: TITLE, columns, ...(onTerminal ? { backgroundColor: 'transparent' } : {}) })
}

const isShown = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)

async function closePane($: EngineInterface) {
  await $.ui.close({ id: PANE })
  await edit($, m => void (m.closed = true))
}

async function reopenPane($: EngineInterface, columns?: number) {
  await edit($, m => void (m.closed = false))
  await openPane($, columns ? Math.ceil(columns * 0.45) : DOCK_COLUMNS)
}

/** Closes the pane when a surface draws it, else opens it with the monitor showing; says which. */
async function toggle($: EngineInterface, columns?: number): Promise<'opened' | 'closed'> {
  if (await isShown($)) {
    await closePane($)
    return 'closed'
  }
  await edit($, m => void (m.monitorClosed = false))
  await reopenPane($, columns)
  return 'opened'
}

/**
 * Hides one half of the pane (the monitor or the subagents) when it shows, closing the pane when the other
 * half has nothing to show; else shows it, opening the pane if closed.
 */
async function toggleHalf($: EngineInterface, half: 'monitorClosed' | 'agentsClosed', columns?: number) {
  const shown = await isShown($)
  const m = await read($, data)
  if (shown && !m[half]) {
    const other = half === 'monitorClosed' ? !m.agentsClosed : !m.monitorClosed
    await edit($, n => void (n[half] = true))
    if (!other) await closePane($)
  } else {
    await edit($, n => void (n[half] = false))
    if (!shown) await reopenPane($, columns)
  }
  $.ui.invalidate('ui.render')
}

/** How a background agent's task ends by its agent's engine status; undefined while it still runs. */
const endOf = (a: AgentInfo | undefined): Task['state'] | undefined =>
  !a || a.status === 'completed' || (a.status === 'idle' && !a.teammateId) ? 'done'
  : a.status === 'failed' ? 'fail'
  : a.status === 'killed' ? 'stop'
  : undefined

/** Ends the background agent tasks whose agent has ended: SubagentStop and task notifications do not always arrive. */
async function settleAgents($: EngineInterface) {
  const { tasks } = await read($, data)
  if (!tasks.some(t => t.kind === 'agent' && t.state === 'run')) return
  const [agents, now] = await Promise.all([$.agent.list(), $.clock.now()])
  const byId = new Map(agents.map(a => [a.id, a]))
  const ended = (t: Task) => (t.kind === 'agent' && t.state === 'run' ? endOf(byId.get(t.id)) : undefined)
  if (!tasks.some(ended)) return
  await edit($, m => {
    for (const t of m.tasks) {
      const st = ended(t)
      if (!st) continue
      t.state = st
      t.end = now
      t.note = m.owners[t.id]?.report ?? t.note
    }
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'monitor', description: 'Open or close the session monitor pane', immediate: true })
    $.clock.every(1000, () => {
      tick++
      void settleAgents($).catch(() => undefined)
      $.ui.invalidate('ui.render')
    })
    const m = await read($, data)
    if (!m.closed) void openPane($)
    void measureContext($).catch(() => undefined)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, data, () => empty())
      await update($, ctx, () => null)
    }
    return next(e)
  })

  on('command.run', { command: 'monitor' }, async ($, e) => {
    const done = await toggle($, e.presentation.columns)
    return { text: done === 'closed' ? 'Monitor closed.' : 'Monitor opened.', isTextDisplayOnly: true }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await edit($, m => void (m.closed = true))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    const notes = taskNotes(e.text)
    if (notes.length) {
      await edit($, m => {
        for (const n of notes) {
          const t = m.tasks.find(x => x.id === n.id)
          if (!t) continue
          if (n.event) t.events++
          if (n.summary || n.event) t.note = firstLine(n.event || n.summary)
          const s = n.status.toLowerCase()
          if (/completed|success/.test(s) || /stream ended/.test(n.summary)) t.state = 'done'
          else if (/fail|error/.test(s)) t.state = 'fail'
          else if (/kill|stop|cancel|time/.test(s)) t.state = 'stop'
          if (t.state !== 'run' && !t.end) t.end = now
        }
      })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await edit($, m => void (m.working = true))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await edit($, m => void (m.working = false))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    void measureContext($).catch(() => undefined)
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      const id = r.agentId
      const now = await $.clock.now()
      await edit($, m => {
        const o = ownerOf(m, id)
        o.label = e.name || e.description || e.subagentType || o.label
        o.type = e.subagentType
        o.model = r.model || o.model
        o.background = e.background
        seen(o, now)
        if (e.background) {
          m.tasks.unshift({ id, kind: 'agent', desc: e.description || e.subagentType, owner: e.parentAgentId ?? 'main', start: now, end: 0, state: 'run', note: '', events: 0 })
        }
      })
    }
    return r
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    const report = summaryLine(e.last_assistant_message ?? '')
    const now = await $.clock.now()
    await edit($, m => {
      const o = m.owners[e.agent_id]
      if (o && report) o.report = report
      const t = m.tasks.find(x => x.id === e.agent_id && x.state === 'run')
      if (t) {
        t.state = 'done'
        t.end = now
        t.note = report
      }
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  // A turn's end lists the background work still in flight: any task the monitor thinks runs but is not listed has ended.
  on('classic.Stop', async ($, e, next) => {
    const live = new Set((e.background_tasks ?? []).map(t => t.id))
    const now = await $.clock.now()
    await edit($, m => {
      for (const t of m.tasks) {
        if (t.state !== 'run' || t.kind === 'agent' || live.has(t.id)) continue
        t.state = 'done'
        t.end = now
      }
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (r.usage) {
      const u = r.usage
      const now = await $.clock.now()
      const p = price(u.model, u)
      const say = summaryLine(r.answer)
      await edit($, m => {
        const o = ownerOf(m, e.agentId)
        o.model = u.model || o.model
        if (e.effort !== undefined) o.effort = String(e.effort)
        o.tok = addTok(o.tok, p.tok)
        o.usd = addTok(o.usd, p.usd)
        o.nocache += p.nocache
        const md = ((m.models ??= {})[u.model || 'unknown'] ??= { tok: zero(), usd: zero() })
        md.tok = addTok(md.tok, p.tok)
        md.usd = addTok(md.usd, p.usd)
        if (!e.agentId && o.ctx > 0 && p.tok.cw >= 20_000 && p.tok.cw > p.tok.cr) {
          m.recache = { ts: now, tok: p.tok.cw, n: (m.recache?.n ?? 0) + 1 }
        }
        o.ctx = p.tok.in + p.tok.cr + p.tok.cw
        const pend = m.pend?.[o.id]
        for (const kind of ['skill', 'plugin', 'mcp'] as const) {
          const keys = pend?.[kind] ?? []
          if (keys.length === 0) continue
          const uses = ((m.uses ??= { skill: {}, plugin: {}, mcp: {} })[kind] ??= {})
          for (const key of keys) {
            const u = (uses[key] ??= { tok: 0, usd: 0 })
            u.tok += sumTok(p.tok) / keys.length
            u.usd += sumTok(p.usd) / keys.length
          }
          pend![kind] = []
        }
        seen(o, now)
        push(o.act, now, MAX_TS)
        push(m.samples, [now, p.usd.in + p.usd.cw + p.usd.cr + p.usd.out], 2000)
        if (say) {
          o.say = o.action = say
          o.sayTs = now
        }
      })
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    const inp = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    const [desc, tag] = describeTool(tool, inp)
    const id = e.tool_use_id
    const agentId = e.agentId
    const start = await $.clock.now()
    await edit($, m => {
      const o = ownerOf(m, agentId)
      const used = sourcesOf(tool, inp)
      for (const kind of ['skill', 'plugin', 'mcp'] as const) {
        const key = used[kind]
        if (!key) continue
        const list = (((m.pend ??= {})[o.id] ??= { skill: [], plugin: [], mcp: [] })[kind] ??= [])
        if (!list.includes(key)) list.push(key)
      }
      o.nTools++
      o.action = desc
      o.flights.push({ id, desc, ts: start })
      if (agentId) {
        const [plus, minus] = lineDelta(tool, inp)
        push(o.steps, { id, ts: start, end: 0, tag, text: desc, err: false, plus, minus }, MAX_STEPS)
      }
      seen(o, start)
      push(o.act, start, MAX_TS)
    })
    const ran = await next(e)
    const end = await $.clock.now()
    const res = (ran.result ?? {}) as Record<string, unknown>
    const bgId =
      tool === 'Monitor' ? (res.taskId as string | undefined)
      : tool === 'Bash' && inp.run_in_background ? (res.backgroundTaskId as string | undefined)
      : undefined
    await edit($, m => {
      const o = ownerOf(m, agentId)
      o.flights = o.flights.filter(f => f.id !== id)
      const step = o.steps.find(x => x.id === id)
      if (step) {
        step.end = end
        step.err = !!(ran.isError || ran.deny)
      }
      seen(o, end)
      if (ran.isError || ran.deny) push(o.errs, end, MAX_TS)
      if (bgId) {
        const t: Task = {
          id: bgId, kind: tool === 'Monitor' ? 'monitor' : 'shell', desc: firstLine(inp.description ?? inp.command ?? desc),
          owner: agentId ?? 'main', start, end: 0, state: 'run', note: firstLine(inp.command ?? ''), events: 0,
        }
        m.tasks.unshift(t)
      }
    })
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const [m, cx, usage, agents, now, cwd, sid] = await Promise.all([
      read($, data),
      read($, ctx),
      $.session.usage(),
      $.agent.list(),
      $.clock.now(),
      $.session.cwd(),
      $.session.id(),
    ])
    const home = (await $.env.get('HOME')) ?? ''
    const flag = (v: string | undefined) => /^(1|true|yes)$/i.test(v ?? '')
    const baseUrl = (await $.env.get('ANTHROPIC_BASE_URL')) ?? ''
    const provider =
      flag(await $.env.get('CLAUDE_CODE_USE_BEDROCK')) ? 'AWS Bedrock'
      : flag(await $.env.get('CLAUDE_CODE_USE_VERTEX')) ? 'Google Vertex'
      : flag(await $.env.get('CLAUDE_CODE_USE_FOUNDRY')) ? 'Azure Foundry'
      : baseUrl ? 'Gateway · ' + (baseUrl.replace(/^\w+:\/\//, '').split('/')[0] ?? baseUrl)
      : 'Anthropic API'
    const pane = drawPane(els, {
      m, cx, usage, agents, now, cwd, home, provider, sid, tick, width: e.props.bodyColumns, rows: e.props.scroll.bodyRows, offset: agentsOff, showMonitor: !m.monitorClosed, showAgents: !m.agentsClosed,
      onToggleAgent: id => void edit($, n => {
        const l = n.expanded ?? []
        n.expanded = l.includes(id) ? l.filter(x => x !== id) : [...l, id]
      }).then(() => $.ui.invalidate('ui.render')),
    })
    agentsBox = pane.agents
    agentsMax = pane.max
    agentsOff = Math.min(agentsOff, agentsMax)
    return pane.el
  })

  // The pane's halves scroll apart: the wheel over the subagents (or the scroll keys) moves only them; the monitor fits its half.
  on('ui.scroll', { requestId: PANE }, ($, e, next) => {
    const box = agentsBox
    if (!box) return next(e)
    const p = e.pointer
    const over = !p || (p.column >= box.column && p.column < box.column + box.width && p.row >= box.row && p.row < box.row + box.height)
    if (over) {
      agentsOff = Math.max(0, Math.min(agentsMax, agentsOff + e.by))
      $.ui.invalidate('ui.render')
    }
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const els = $.ui.resolve(e)
    const [m, cx, usage, agents, now, shown] = await Promise.all([read($, data), read($, ctx), $.session.usage(), $.agent.list(), $.clock.now(), isShown($)])
    const columns = e.viewport?.columns
    return drawBand(els, {
      m, cx, usage, agents, now, shown: shown && !m.monitorClosed, agentsShown: shown && !m.agentsClosed, tick, width: e.props.bodyColumns,
      onToggle: () => void toggleHalf($, 'monitorClosed', columns), onToggleAgents: () => void toggleHalf($, 'agentsClosed', columns),
    })
  })
}
