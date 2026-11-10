// The monitor's drawing: one tree of Box and Text that every surface draws.
import type { AgentInfo, Elements, RenderChildren, SessionUsage } from 'claude-code'

import type { CtxView, Mon, Owner, Task } from '../types'
import {
  C, LANE, SPIN, STALL_MS, bar, fit, fmtCost, fmtDur, fmtRate, fmtTok, hhmmss, hitRate, modelColor,
  prettyModel, rates, sparkline, sumTok, vlen, zero, addTok,
} from './lib'

type Els = Pick<Elements['terminal'], 'Box' | 'Text'>
type Input = {
  m: Mon
  cx: CtxView | null
  usage: SessionUsage
  agents: AgentInfo[]
  now: number
  cwd: string
  home: string
  sid: string
  tick: number
  width: number
}
type AgentState = 'run' | 'stall' | 'wait' | 'done' | 'fail' | 'stop'
type Seg = [string, string?, ('b' | 'i' | 's' | 'd')?]
/** Something a person should look at: its text and its color (red = act now, gold = watch). */
type Alert = [string, string]

const IDLE_BG = '#4e4e4e'
const PILL: Record<string, [string, string]> = {
  run: ['RUN', C.green], stall: ['IDLE?', C.gold], wait: ['WAIT', C.blue], done: ['DONE', IDLE_BG],
  fail: ['FAIL', C.red], stop: ['STOP', C.orange],
}
const ERR_WINDOW = 300_000
const LIMIT_LABEL = (kind: string) => (kind === 'five_hour' ? '5h limit' : kind === 'seven_day' ? '7d limit' : kind.replace(/_/g, ' '))

/** Each subagent's state, from the engine's agent list and what the monitor recorded. */
function classify(m: Mon, agents: AgentInfo[], now: number): Map<string, AgentState> {
  const info = new Map(agents.map(a => [a.id, a.status]))
  const out = new Map<string, AgentState>()
  for (const id of m.order.slice(1)) {
    const o = m.owners[id]
    if (!o) continue
    const st = info.get(id)
    const busy = m.tasks.some(t => t.owner === id && t.state === 'run')
    out.set(id,
      st === 'completed' ? 'done'
      : st === 'failed' ? 'fail'
      : st === 'killed' ? 'stop'
      : st === 'waiting' || (st === 'idle' && busy) ? 'wait'
      : st === 'running' || st === 'pending' || (!st && !o.report && now - o.last < 20_000)
        ? (o.flights.length === 0 && now - o.last > STALL_MS ? 'stall' : 'run')
      : 'done')
  }
  return out
}

/** The engine's exact total, and the factor that scales the monitor's own estimate to it. */
function billOf(m: Mon, usage: SessionUsage) {
  const est = m.order.reduce((s, id) => s + (m.owners[id] ? sumTok(m.owners[id]!.usd) : 0), 0)
  const exact = usage.cost?.usd ?? est
  return { exact, k: est > 0 ? exact / est : 1 }
}

/** Dollars per hour over the last ten minutes. */
const burnOf = (m: Mon, now: number, k: number) => m.samples.filter(([ts]) => ts >= now - 600_000).reduce((s, [, v]) => s + v, 0) * 6 * k

/** What needs a person's attention now, most urgent first. */
export function attention(m: Mon, cx: CtxView | null, usage: SessionUsage, agents: AgentInfo[], now: number): Alert[] {
  const out: Alert[] = []
  const main = m.owners.main!
  const states = classify(m, agents, now)
  for (const [id, s] of states) {
    const o = m.owners[id]!
    if (s === 'fail') out.push([`${o.label} failed`, C.red])
    if (s === 'stall') out.push([`${o.label} silent for ${fmtDur(now - o.last)}`, C.gold])
  }
  for (const t of m.tasks) if (t.state === 'fail' && now - t.end < 1_800_000) out.push([`task “${fit(t.desc, 30)}” failed`, C.red])
  const window = cx?.window ?? usage.context.window
  const buffer = cx?.rows.find(r => r.kind === 'buffer')?.tokens ?? 0
  const usable = window - buffer
  const pct = usable > 0 ? ((usage.context.tokens ?? main.ctx) / usable) * 100 : 0
  if (pct >= 80) out.push([`context ${pct.toFixed(0)}% full, autocompact is near`, pct >= 90 ? C.red : C.gold])
  for (const l of usage.rateLimits) {
    if (l.percentUsed < 80) continue
    const reset = l.resetsAt ? `, resets ${hhmmss(Date.parse(l.resetsAt)).slice(0, 5)}` : ''
    out.push([`${LIMIT_LABEL(l.kind)} at ${l.percentUsed.toFixed(0)}%${reset}`, l.percentUsed >= 90 ? C.red : C.gold])
  }
  const burn = burnOf(m, now, billOf(m, usage).k)
  if (burn > 20) out.push([`burning ${fmtCost(burn)}/h`, C.red])
  const errs = m.order.reduce((n, id) => n + (m.owners[id]?.errs.filter(ts => now - ts < ERR_WINDOW).length ?? 0), 0)
  if (errs >= 3) out.push([`${errs} tool errors in the last 5m`, errs >= 6 ? C.red : C.gold])
  const fl = main.flights.at(-1)
  if (fl && now - fl.ts > STALL_MS) out.push([`main: ${fit(fl.desc, 30)} running ${fmtDur(now - fl.ts)}`, C.gold])
  return out.sort((a, b) => Number(b[1] === C.red) - Number(a[1] === C.red))
}

export function drawMonitor({ Box, Text }: Els, I: Input) {
  const { m, cx, usage, now, tick } = I
  const W = Math.max(30, I.width)
  const spin = SPIN[tick % SPIN.length]!

  // ── Figures ────────────────────────────────────────────────────────────────
  const main = m.owners.main!
  const subs = m.order.slice(1).map(id => m.owners[id]!).filter(Boolean)
  const all = [main, ...subs]
  const { exact, k } = billOf(m, usage)
  const cost = (o: Owner) => sumTok(o.usd) * k
  const tok = all.reduce((t, o) => addTok(t, o.tok), zero())
  const usd = all.reduce((t, o) => addTok(t, o.usd), zero())
  const nocache = all.reduce((s, o) => s + o.nocache, 0) * k
  const subCost = subs.reduce((s, o) => s + cost(o), 0)
  const tasksOf = (id: string) => m.tasks.filter(t => t.owner === id)
  const states = classify(m, I.agents, now)
  const running = subs.filter(o => ['run', 'stall'].includes(states.get(o.id)!)).length
  const runTasks = m.tasks.filter(t => t.state === 'run').length
  const flight = main.flights.at(-1)
  const active = m.working || !!flight || running > 0 || now - main.last < 15_000
  const state = m.working || flight ? 'working' : running || runTasks ? 'waiting on agents' : 'idle'
  const firsts = all.map(o => o.first).filter(Boolean)
  const t0 = firsts.length ? Math.min(...firsts) : usage.startedAt
  const t1 = active ? now : Math.max(t0, ...all.map(o => o.last))
  const window = cx?.window ?? usage.context.window
  const ctxTok = usage.context.tokens ?? main.ctx
  const buffer = cx?.rows.find(r => r.kind === 'buffer')?.tokens ?? 0
  const burn = burnOf(m, now, k)
  const buckets = Array<number>(30).fill(0)
  for (const [ts, v] of m.samples) {
    const age = Math.trunc((now - ts) / 60_000)
    if (age >= 0 && age < 30) buckets[29 - age]! += v
  }
  const r = rates(main.model)
  const mcol = modelColor(main.model)
  const colorOf = (o: Owner) => (o.id === 'main' ? mcol : LANE[(subs.indexOf(o) + 1) % LANE.length]!)
  const alerts = attention(m, cx, usage, I.agents, now)

  // ── Drawing helpers ────────────────────────────────────────────────────────
  const seg = ([text, color, style]: Seg) => (
    <Text color={color} bold={style === 'b'} italic={style === 'i'} strikethrough={style === 's'} dimColor={style === 'd'}>
      {text}
    </Text>
  )
  const line = (...segs: (Seg | false | undefined)[]) => (
    <Text mono wrap="truncate-end">
      {segs.filter((s): s is Seg => !!s).map(seg)}
    </Text>
  )
  const spread = (left: (Seg | false)[], right: (Seg | false)[]) => (
    <Box flexDirection="row" justifyContent="space-between">
      {line(...left)}
      {line(...right)}
    </Box>
  )
  const panel = (title: Seg[], color: string, body: RenderChildren[], right?: (Seg | false)[], width?: number) => (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} width={width} flexGrow={width ? 0 : 1}>
      {right ? spread(title, right) : line(...title)}
      {body}
    </Box>
  )
  const barSegs = (frac: number, w: number, color: string): Seg[] => {
    const [on, off] = bar(frac, w)
    return [[on, color], [off, C.track]]
  }
  const pill = (label: string, bg: string) => (
    <Text mono backgroundColor={bg} color={bg === IDLE_BG ? '#eeeeee' : '#000000'} bold>
      {` ${label} `.padEnd(7)}
    </Text>
  )

  // ── Header: state, where, when ─────────────────────────────────────────────
  const path = I.cwd.replace(I.home, '~')
  const cut = path.lastIndexOf('/')
  const parent = cut >= 0 ? path.slice(0, cut + 1) : ''
  const project = path.slice(cut + 1) || '/'
  const header = (
    <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
      <Box flexDirection="row" columnGap={1}>
        {active ? pill('● LIVE', C.green) : pill('IDLE', IDLE_BG)}
        {line([fit(parent, Math.max(0, W - project.length - 30)), C.gray], [project, C.orange, 'b'])}
      </Box>
      {line([I.sid.slice(0, 8) + '  ', C.dark], [hhmmss(now), C.gray])}
    </Box>
  )

  // ── Needs attention ────────────────────────────────────────────────────────
  const hot = alerts.some(a => a[1] === C.red)
  const attentionBox = alerts.length > 0 && panel(
    [['⚠ NEEDS ATTENTION', hot ? C.red : C.gold, 'b']], hot ? C.red : C.gold,
    alerts.map(([text, col]) => line(['● ', col], [fit(text, W - 6), col])),
    [[String(alerts.length), hot ? C.red : C.gold, 'b']],
  )

  // ── Main loop ──────────────────────────────────────────────────────────────
  const stateSeg: Seg = state === 'idle' ? ['○ idle', C.gray] : [spin + ' ' + state, C.green]
  const doing: Seg[] = flight && state === 'working'
    ? [['» ' + fit(flight.desc, W - 16), C.gold], [` ${fmtDur(now - flight.ts)}`, C.gray]]
    : [['» ' + fit(main.action || 'waiting for prompt', W - 8), state === 'idle' ? C.light : C.gold]]
  const mainBox = (
    <Box flexDirection="column" borderStyle="round" borderColor={state === 'idle' ? C.frame : mcol} paddingX={1}>
      {spread(
        [[prettyModel(main.model), mcol, 'b'], !!main.effort && [' · effort ', C.gray], !!main.effort && [main.effort, C.pink]],
        [stateSeg, [' · ' + fmtDur(t1 - t0), C.gray]],
      )}
      {line(...doing)}
    </Box>
  )

  // ── Cost ───────────────────────────────────────────────────────────────────
  const side = W >= 76 ? Math.floor((W - 1) / 2) : W
  const bi = side - 4
  const totUsd = sumTok(usd) || 1
  const kbw = Math.max(4, bi - 31)
  const kinds = [['in', 'input', C.orange], ['cw', 'cache write', C.pink], ['cr', 'cache read', C.blue], ['out', 'output', C.gold]] as const
  const saved = nocache > 0 ? Math.max(0, 1 - exact / nocache) * 100 : 0
  const burnCol = burn > 20 ? C.red : burn > 5 ? C.gold : C.green
  const sw = Math.max(6, Math.min(30, bi - 29))
  const spark = sparkline(buckets.slice(-sw))
  const lbw = Math.max(4, bi - 22)
  const limits = usage.rateLimits.map(l => {
    const col = l.percentUsed >= 90 ? C.red : l.percentUsed >= 70 ? C.gold : C.green
    return line(
      [LIMIT_LABEL(l.kind).padEnd(9), C.gray], ...barSegs(l.percentUsed / 100, lbw, col),
      [(l.percentUsed.toFixed(0) + '%').padStart(5), col, 'b'], [l.resetsAt ? ' ↻' + hhmmss(Date.parse(l.resetsAt)).slice(0, 5) : '', C.dark],
    )
  })
  const bill = panel([['COST', C.gold, 'b']], C.gold, [
    line([fit(`${prettyModel(main.model)} · ${fmtRate(r.in)} in · ${fmtRate(r.out)} out /MTok`, bi), C.gray]),
    ...kinds.map(([key, name, col]) => line(
      ['■ ', col], [name.padEnd(12), C.light], [fmtTok(tok[key]).padStart(7) + ' ', C.gray],
      ...barSegs(usd[key] / totUsd, kbw, col), [fmtCost(usd[key] * k).padStart(9), col],
    )),
    subs.length > 0 && spread([['main ', C.gray], [fmtCost(cost(main)), C.gold]], [[`agents (${subs.length}) `, C.gray], [fmtCost(subCost), C.gold]]),
    spread(
      [['cache hit ', C.gray], [(hitRate(tok) * 100).toFixed(0) + '%', C.blue, 'b']],
      [['saved ', C.gray], [saved.toFixed(0) + '%', C.green, 'b'], [' of ', C.dark], [fmtCost(nocache), C.gray, 's']],
    ),
    spread(
      [['burn ', C.gray], [fmtCost(burn) + '/h', burnCol, 'b']],
      [['-30m ', C.dark], ...spark.map((s): Seg => [s.ch, s.on ? C.gold : C.track]), [' now', C.dark]],
    ),
    ...limits,
  ], [[fmtCost(exact), C.gold, 'b']], side)

  // ── Context ────────────────────────────────────────────────────────────────
  const lim = window || 1
  const pct = (ctxTok / lim) * 100
  const pctCol = pct > 75 ? C.red : pct > 50 ? C.gold : C.light
  const used = (cx?.rows ?? []).filter(x => x.kind === 'used')
  const free = cx?.rows.find(x => x.kind === 'free')
  const deferred = (cx?.rows ?? []).filter(x => x.kind === 'deferred')
  const mcpN = cx?.mcpDeferred ?? 0
  const mcpRow = deferred.find(x => /mcp/i.test(x.name))
  const catCol = (i: number) => LANE[i % LANE.length]!
  const ctxBar: Seg[] = []
  let acc = 0
  for (const [i, row] of [...used.map((x, i) => [i, x] as const), [-1, { tokens: buffer }] as const]) {
    let n = Math.round((row.tokens / lim) * bi)
    if (row.tokens > 0 && n === 0 && acc < bi) n = 1
    n = Math.min(n, bi - acc)
    if (n > 0) ctxBar.push(['━'.repeat(n), i < 0 ? C.dark : catCol(i)])
    acc += Math.max(0, n)
  }
  ctxBar.push(['━'.repeat(Math.max(0, bi - acc)), C.track])
  const nw = Math.max(6, bi - 16)
  const ctxRow = (sq: Seg, name: string, tokens: number, nameCol?: string) => (
    <Box flexDirection="row">
      {line(sq, [' ' + fit(name, nw).padEnd(nw), nameCol ?? C.light])}
      {line([fmtTok(tokens).padStart(7)], [((tokens / lim) * 100).toFixed(1).padStart(6) + '%', C.gray])}
    </Box>
  )
  const memRows = (cx?.memory ?? []).map(f =>
    line(['  └ ', C.dark], [fit(f.name, nw - 2).padEnd(nw - 2), C.gray], [fmtTok(f.tokens).padStart(7), C.gray]),
  )
  const context = panel([['CONTEXT', undefined, 'b'], [' · ', C.dark], [pct.toFixed(0) + '%', pctCol, 'b']], C.frame, [
    line(...ctxBar),
    ...used.flatMap((x, i) => [ctxRow(['■', catCol(i)], x.name, x.tokens), ...(/memory/i.test(x.name) ? memRows : [])]),
    buffer > 0 && ctxRow(['■', C.dark], 'Autocompact buffer', buffer),
    free && ctxRow(['■', C.track], 'Free space', free.tokens, C.gray),
    !cx && line(['measuring after the first turn…', C.dark]),
    (deferred.length > 0 || mcpN > 0) && line(['deferred · not in context', C.dark]),
    ...deferred.map(x => spread([['□ ', C.dark], [fit(x.name, bi - 22), C.gray]], [[(x === mcpRow && mcpN ? `${mcpN} tools · ` : '') + fmtTok(x.tokens), C.gray]])),
    !mcpRow && mcpN > 0 && spread([['□ ', C.dark], ['MCP tools not loaded', C.gray]], [[`${mcpN} tools`, C.gray]]),
  ], [[`${fmtTok(ctxTok)} / ${fmtTok(lim)}`, C.gray]], side)

  // ── Agents ─────────────────────────────────────────────────────────────────
  const ai = W - 4
  const counts: Record<string, number> = {}
  for (const s of states.values()) counts[s] = (counts[s] ?? 0) + 1
  const agentRight = ([['run', 'running', C.green], ['stall', 'idle?', C.gold], ['wait', 'waiting', C.blue], ['fail', 'failed', C.red], ['done', 'done', C.gray]] as const)
    .filter(([key]) => counts[key])
    .flatMap(([key, name, col]): Seg[] => [[`${counts[key]} ${name}  `, col]])
  const compact = ai < 84
  const nameW = Math.max(10, Math.min(30, Math.floor(ai / 4)))
  const statsW = compact ? 14 : 31
  const nowW = Math.max(8, ai - 8 - nameW - 1 - statsW - 1)
  const SHOW = 12
  const agentRows = subs.slice(0, SHOW).flatMap(o => {
    const s = states.get(o.id)!
    const fl = o.flights.at(-1)
    const nowSeg: Seg =
      (s === 'run' || s === 'stall') && fl ? [spin + ' ' + fit(fl.desc, nowW - 2 - 6) + ' ' + fmtDur(now - fl.ts), C.green]
      : s === 'stall' ? [`no activity ${fmtDur(now - o.last)} · last: ${o.action}`, C.gold]
      : s === 'run' ? ['» ' + (o.action || 'starting'), C.green]
      : s === 'wait' ? [`◷ waiting on ${tasksOf(o.id).filter(t => t.state === 'run').length} bg task(s)`, C.blue]
      : [o.report || o.say || o.action || '—', s === 'done' ? C.light : C.red]
    const stats = (o.errs.length ? `✗${o.errs.length} ` : '') + String(o.nTools)
    const row = (
      <Box flexDirection="row" columnGap={1}>
        {pill(PILL[s]![0], PILL[s]![1])}
        {line([fit(o.label, nameW).padEnd(nameW), colorOf(o), s === 'run' ? 'b' : undefined], [' ' + fit(nowSeg[0], nowW).padEnd(nowW), nowSeg[1]])}
        {line(
          [stats.padStart(6), o.errs.length ? C.red : C.light],
          !compact && [(o.first ? fmtDur((s === 'run' || s === 'stall' ? now : o.last) - o.first) : '—').padStart(9), C.gray],
          !compact && [fmtTok(sumTok(o.tok)).padStart(8), C.light],
          [fmtCost(cost(o)).padStart(8), C.gold],
        )}
      </Box>
    )
    if (s === 'done') return [row]
    const own = tasksOf(o.id)
    const bits = [o.type.replace('general-purpose', 'general') || 'agent', prettyModel(o.model), ...(o.effort ? [o.effort] : []), ...(o.background ? ['bg'] : []), ...(own.length ? [`${own.length} bg task${own.length > 1 ? 's' : ''}`] : [])]
    const meta = bits.join(' · ')
    const say = o.say && o.sayTs >= (fl?.ts ?? 0) - 600_000 ? o.say : ''
    return [row, line(['        └ ', C.dark], [fit(meta, Math.max(10, Math.floor((ai * 2) / 5))), C.gray], !!say && [' │ ', C.dark], !!say && [fit('“' + say + '”', ai - 12 - vlen(meta)), C.light, 'i'])]
  })
  const rest = subs.slice(SHOW)
  const agentsBox = subs.length > 0 && panel([['AGENTS', undefined, 'b'], [` · ${subs.length}`, C.gray]], C.frame, [
    line([
      'STATE   ' + 'AGENT'.padEnd(nameW + 1) + ' ' + 'NOW'.padEnd(nowW + 1) + 'STEPS'.padStart(6) + (compact ? '' : 'TIME'.padStart(9) + 'TOKENS'.padStart(8)) + 'COST'.padStart(8),
      C.dark,
    ]),
    ...agentRows,
    rest.length > 0 && line([`  +${rest.length} more · ${fmtTok(rest.reduce((s, o) => s + sumTok(o.tok), 0))} · ${fmtCost(rest.reduce((s, o) => s + cost(o), 0))}`, C.dark]),
  ], agentRight)

  // ── Background tasks ───────────────────────────────────────────────────────
  const ownerName = (id: string) => (id === 'main' ? 'main' : m.owners[id]?.label ?? id.slice(0, 6))
  const ownerCol = (id: string) => (id === 'main' ? mcol : m.owners[id] ? colorOf(m.owners[id]!) : C.gray)
  const ownW = Math.max(8, Math.min(20, Math.floor(ai / 6)))
  const descW = Math.max(10, ai - 2 - 1 - ownW - 1 - 9 - 1 - 12)
  const icon = (t: Task): Seg => (t.state === 'run' ? [spin, C.green] : t.state === 'done' ? ['✓', C.green] : t.state === 'fail' ? ['✗', C.red] : ['■', C.gold])
  const result = (t: Task): Seg =>
    t.state === 'run' ? (t.kind === 'monitor' ? [`${t.events} events`, C.cyan] : ['running', C.green])
    : t.state === 'fail' ? ['failed', C.red] : t.state === 'stop' ? ['stopped', C.gold] : ['done', C.gray]
  const shownTasks = m.tasks.slice(0, 8)
  const fails = m.tasks.filter(t => t.state === 'fail').length
  const tasksBox = m.tasks.length > 0 && panel([['BACKGROUND TASKS', undefined, 'b']], C.frame, [
    ...shownTasks.flatMap(t => [
      line(
        icon(t), [' ' + fit((t.kind === 'monitor' ? '⌁ ' : '') + t.desc, descW).padEnd(descW) + ' ', t.state === 'fail' ? C.red : t.state === 'run' ? undefined : C.light],
        [fit(ownerName(t.owner), ownW).padEnd(ownW), ownerCol(t.owner)], [fmtDur((t.end || now) - t.start).padStart(10), C.gray], [' ' + result(t)[0].padStart(12), result(t)[1]],
      ),
      t.state === 'run' && !!t.note && line(['  └ ', C.dark], [fit(t.note, ai - 4), C.gray]),
    ]),
    m.tasks.length > shownTasks.length && line([`  +${m.tasks.length - shownTasks.length} older`, C.dark]),
  ], [[`${runTasks} running  `, runTasks ? C.green : C.gray], [`${m.tasks.length - runTasks} finished`, C.gray], [fails ? `  ${fails} failed` : '', C.red]])

  const nothingDelegated = subs.length === 0 && m.tasks.length === 0 &&
    line(['  no subagents spawned yet · no background tasks', C.dark])

  // ── Timeline: only worth a panel once there is more than one lane ─────────
  const span = Math.max(1000, t1 - t0)
  const labelW = Math.max(11, Math.min(18, Math.floor(W / 8)))
  const tw = Math.max(10, W - 4 - labelW)
  const col = (ts: number) => Math.trunc(((ts - t0) / span) * (tw - 1))
  const lanes = all.slice(0, 6).map(o => {
    const cells: [string, string][] = Array.from({ length: tw }, () => [' ', C.track])
    if (o.first) for (let x = Math.max(0, col(o.first)); x <= Math.min(tw - 1, col(o.last || o.first)); x++) cells[x] = ['·', C.track]
    for (const ts of o.act) if (ts >= t0) cells[Math.min(tw - 1, col(ts))] = ['━', colorOf(o)]
    for (const ts of o.errs) if (ts >= t0) cells[Math.min(tw - 1, col(ts))] = ['✗', C.red]
    const segs: Seg[] = [[fit(o.label, labelW - 1).padEnd(labelW), colorOf(o)]]
    for (const [ch, c] of cells) {
      const last = segs.at(-1)!
      if (segs.length > 1 && last[1] === c) last[0] += ch
      else segs.push([ch, c])
    }
    return line(...segs)
  })
  const timeline = subs.length > 0 && panel([['TIMELINE', undefined, 'b']], C.frame, [
    ...lanes,
    <Box flexDirection="row" justifyContent="space-between" width={labelW + tw}>
      {line([' '.repeat(labelW) + hhmmss(t0), C.dark])}
      {line([active ? 'now' : hhmmss(t1), C.dark])}
    </Box>,
  ], [[fmtDur(span), C.gray]])

  // ── Activity ───────────────────────────────────────────────────────────────
  const whoW = Math.max(9, Math.min(16, Math.floor(ai / 7)))
  const whoCol = (who: string) => (who === 'you' ? C.green : who === 'main' ? mcol : subs.find(o => o.label === who) ? colorOf(subs.find(o => o.label === who)!) : C.gray)
  const log = panel([['ACTIVITY', undefined, 'b']], C.frame, m.log.length === 0
    ? [line(['nothing yet', C.dark])]
    : m.log.slice(-10).map(ev => line(
        [hhmmss(ev.ts) + '  ', C.dark], [fit(ev.who, whoW).padEnd(whoW) + ' ', whoCol(ev.who)],
        [fit(ev.text, ai - whoW - 11), ev.tag === 'fail' ? C.red : ev.tag === 'say' || ev.tag === 'prompt' ? undefined : C.light, ev.tag === 'say' ? 'i' : undefined],
      )))

  return (
    <Box flexDirection="column" width={W} rowGap="sm">
      {header}
      {attentionBox}
      {mainBox}
      <Box flexDirection={side < W ? 'row' : 'column'} columnGap={1} rowGap="sm">
        {bill}
        {context}
      </Box>
      {agentsBox}
      {tasksBox}
      {nothingDelegated}
      {timeline}
      {log}
    </Box>
  )
}

type BandEls = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
type BandInput = {
  m: Mon
  cx: CtxView | null
  usage: SessionUsage
  agents: AgentInfo[]
  now: number
  shown: boolean
  tick: number
  width: number
  onToggle: () => void
}

/** The one-line band above the prompt: the key figures, what needs attention, and the pane's toggle. */
export function drawBand({ Box, Text, Button }: BandEls, B: BandInput) {
  const { m, usage } = B
  const main = m.owners.main!
  const subs = m.order.length - 1
  const running = B.agents.filter(a => a.status === 'running' || a.status === 'pending').length
  const tasks = m.tasks.filter(t => t.state === 'run').length
  const live = m.working || Object.values(m.owners).some(o => o.flights.length > 0)
  const window = usage.context.window || 1
  const tokens = usage.context.tokens ?? main.ctx
  const pct = usage.context.percent ?? Math.round((tokens / window) * 100)
  const cost = usage.cost?.usd ?? Object.values(m.owners).reduce((s, o) => s + sumTok(o.usd), 0)
  const alerts = attention(m, B.cx, usage, B.agents, B.now)
  const hot = alerts.some(a => a[1] === C.red)
  const seg = (text: string, color?: string, bold?: boolean) => <Text color={color} bold={bold}>{text}</Text>
  const dot = ' · '
  return (
    <Box flexDirection="row" justifyContent="space-between" columnGap={1} width={Math.max(20, B.width)}>
      <Text mono wrap="truncate-end">
        {seg('◧ MONITOR', undefined, true)}
        {seg(dot, C.dark)}
        {live ? seg(SPIN[B.tick % SPIN.length]! + ' live', C.green) : seg('○ idle', C.gray)}
        {alerts.length > 0 ? [seg(dot, C.dark), seg(`⚠ ${alerts.length === 1 ? alerts[0]![0] : alerts.length + ' alerts'}`, hot ? C.red : C.gold, true)] : []}
        {seg(dot, C.dark)}
        {seg(fmtCost(cost), C.gold, true)}
        {seg(dot, C.dark)}
        {seg('ctx ', C.gray)}
        {seg(`${fmtTok(tokens)} ${pct}%`, pct >= 80 ? C.red : pct >= 50 ? C.gold : undefined)}
        {seg(dot, C.dark)}
        {seg('agents ', C.gray)}
        {seg(`${running}/${subs}`, running ? C.green : C.gray)}
        {seg(dot, C.dark)}
        {seg('bg ', C.gray)}
        {seg(String(tasks), tasks ? C.cyan : C.gray)}
      </Text>
      <Button key="toggle" label={B.shown ? 'Hide monitor' : 'Show monitor'} onPress={B.onToggle} />
    </Box>
  )
}
