// The monitor's drawing: one tree of Box and Text that every surface draws.
import type { AgentInfo, Elements, RenderChildren, SessionUsage } from 'claude-code'

import type { CtxView, Mon, Owner, Task } from '../types'
import { drawFlow, pickAgents } from './flow'
import {
  C, LANE, SPIN, STALL_MS, bar, fit, fmtCost, fmtDur, fmtTok, hhmmss, hitRate, modelColor,
  prettyModel, sumTok, vlen, zero, addTok,
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

const ACCENT = '#d97757' // Claude terracotta, the one accent
const ERR_WINDOW = 300_000
const LIMIT_LABEL = (kind: string) => (kind === 'five_hour' ? '5h limit' : kind === 'seven_day' ? '7d limit' : kind.replace(/_/g, ' '))

/** Each subagent's state, from the engine's agent list and what the monitor recorded. */
export function classify(m: Mon, agents: AgentInfo[], now: number): Map<string, AgentState> {
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
  const iw = W - 2 // inside the side padding
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
  const state = m.working || flight ? 'working' : running || runTasks ? 'waiting' : 'idle'
  const firsts = all.map(o => o.first).filter(Boolean)
  const t0 = firsts.length ? Math.min(...firsts) : usage.startedAt
  const t1 = active ? now : Math.max(t0, ...all.map(o => o.last))
  const window = cx?.window ?? usage.context.window
  const ctxTok = usage.context.tokens ?? main.ctx
  const buffer = cx?.rows.find(r => r.kind === 'buffer')?.tokens ?? 0
  const burn = burnOf(m, now, k)
  const mcol = modelColor(main.model)
  const colorOf = (o: Owner) => (o.id === 'main' ? mcol : LANE[(subs.indexOf(o) + 1) % LANE.length]!)
  const alerts = attention(m, cx, usage, I.agents, now)

  // ── Drawing helpers ────────────────────────────────────────────────────────
  const gap = <Text> </Text>
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
  const textW = (segs: Seg[]) => segs.reduce((n, s) => n + vlen(s[0]), 0)
  /** Left and right text on one row, padded with spaces so the right text ends exactly at `w`. */
  const spread = (left: (Seg | false)[], right: (Seg | false)[], w: number) => {
    const l = left.filter((s): s is Seg => !!s)
    const r = right.filter((s): s is Seg => !!s)
    return line(...l, [' '.repeat(Math.max(1, w - textW(l) - textW(r)))], ...r)
  }
  /** A quiet section: a bold title, a hairline, a figure at the right, then the body. */
  const section = (title: string, right: Seg[], body: RenderChildren[], w = iw, titleColor: string = C.light) => (
    <Box flexDirection="column" width={w}>
      {line([title, titleColor, 'b'], [' ' + '─'.repeat(Math.max(2, w - vlen(title) - textW(right) - 2)) + ' ', C.track], ...right)}
      {body}
    </Box>
  )
  /** A thin segmented bar: each part's share of `total`, the rest as track. */
  const stack = (parts: [number, string][], w: number, total: number): Seg[] => {
    const out: Seg[] = []
    let acc = 0
    for (const [v, c] of parts) {
      let n = Math.round((v / (total || 1)) * w)
      if (v > 0 && n === 0 && acc < w) n = 1
      n = Math.min(n, w - acc)
      if (n > 0) out.push(['━'.repeat(n), c])
      acc += Math.max(0, n)
    }
    out.push(['━'.repeat(Math.max(0, w - acc)), C.track])
    return out
  }

  // ── General: status, project, session time ────────────────────────────────
  const path = I.cwd.replace(I.home, '~')
  const cut = path.lastIndexOf('/')
  const project = path.slice(cut + 1) || '/'
  const stateSeg: Seg =
    state === 'working' ? [spin + ' Working', ACCENT, 'b']
    : state === 'waiting' ? ['◷ Waiting on agents', C.blue, 'b']
    : ['○ Idle', C.gray, 'b']
  const doing = flight && state === 'working' ? fit(flight.desc, Math.max(10, iw - 24)) + ' ' + fmtDur(now - flight.ts) : ''
  const header = (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
        {line(stateSeg, ['  ', undefined], [project, undefined, 'b'])}
        {line(['session ', C.dark], [fmtDur(t1 - t0), C.light])}
      </Box>
      {line(
        [fit(path, Math.max(8, iw - 40)), C.dark], [' · ', C.track], [I.sid.slice(0, 8), C.dark], [' · ', C.track],
        [prettyModel(main.model), C.gray], !!main.effort && [' · ' + main.effort, C.dark], [' · since ' + hhmmss(t0).slice(0, 5), C.dark],
      )}
      {!!doing && line(['» ', ACCENT], [doing, C.gray])}
    </Box>
  )

  // ── Needs attention ────────────────────────────────────────────────────────
  const hot = alerts.some(a => a[1] === C.red)
  const alertCol = hot ? C.red : C.gold
  const attentionBox = alerts.length > 0 && section(
    'Needs attention', [[String(alerts.length), alertCol, 'b']],
    alerts.map(([text, col]) => line(['● ', col], [fit(text, iw - 3), col])), iw, alertCol,
  )

  // ── Cost ───────────────────────────────────────────────────────────────────
  const side = iw >= 76 ? Math.floor((iw - 3) / 2) : iw
  const sideR = side < iw ? iw - 3 - side : iw // the right column takes the odd cell, so both columns end flush with the pane
  const totUsd = sumTok(usd) || 1
  const kinds = [['in', 'Input', C.orange], ['cw', 'Cache write', C.pink], ['cr', 'Cache read', C.blue], ['out', 'Output', C.gold]] as const
  const saved = nocache > 0 ? Math.max(0, 1 - exact / nocache) * 100 : 0
  const burnCol = burn > 20 ? C.red : burn > 5 ? C.gold : C.light
  const lbw = Math.max(4, side - 23)
  const limits = usage.rateLimits.map(l => {
    const col = l.percentUsed >= 90 ? C.red : l.percentUsed >= 70 ? C.gold : ACCENT
    const [on, off] = bar(l.percentUsed / 100, lbw)
    return line(
      [LIMIT_LABEL(l.kind).padEnd(9), C.gray], [on, col], [off, C.track],
      [(l.percentUsed.toFixed(0) + '%').padStart(5), col, 'b'], [l.resetsAt ? '  ↻ ' + hhmmss(Date.parse(l.resetsAt)).slice(0, 5) : '', C.dark],
    )
  })
  const bill = section('Cost', [[fmtCost(exact), ACCENT, 'b']], [
    line(...stack(kinds.map(([key, , col]): [number, string] => [usd[key], col]), side, totUsd)),
    ...kinds.map(([key, name, col]) => line(
      ['● ', col], [name.padEnd(13), C.light], [fmtTok(tok[key]).padStart(7), C.gray], [fmtCost(usd[key] * k).padStart(Math.max(9, side - 22)), C.light],
    )),
    subs.length > 0 && spread([['main ', C.gray], [fmtCost(cost(main)), C.light]], [[`agents · ${subs.length} `, C.gray], [fmtCost(subCost), C.light]], side),
    spread(
      [['cache hit ', C.gray], [(hitRate(tok) * 100).toFixed(0) + '%', C.light, 'b']],
      [['saved ', C.gray], [saved.toFixed(0) + '%', C.green, 'b'], [' of ', C.dark], [fmtCost(nocache), C.dark, 's']],
      side,
    ),
    line(['burn ', C.gray], [fmtCost(burn) + '/h', burnCol, 'b']),
    ...limits,
  ], side)

  // ── Context ────────────────────────────────────────────────────────────────
  const lim = window || 1
  const pct = (ctxTok / lim) * 100
  const pctCol = pct > 75 ? C.red : pct > 50 ? C.gold : C.light
  const used = (cx?.rows ?? []).filter(x => x.kind === 'used')
  const free = cx?.rows.find(x => x.kind === 'free')
  const deferred = (cx?.rows ?? []).filter(x => x.kind === 'deferred')
  const catCol = (i: number) => LANE[i % LANE.length]!
  const ctxParts: [number, string][] = [...used.map((x, i): [number, string] => [x.tokens, catCol(i)]), [buffer, C.dark]]
  const nw = Math.max(6, sideR - 16)
  const dotRow = (col: string, name: string, tokens: number, nameCol: string = C.light) => (
    <Text mono wrap="truncate-end">
      {seg(['● ', col])}
      {seg([fit(name, nw).padEnd(nw), nameCol])}
      {seg([fmtTok(tokens).padStart(7), C.gray])}
      {seg([((tokens / lim) * 100).toFixed(1).padStart(6) + '%', C.dark])}
    </Text>
  )
  const context = section('Context', [[pct.toFixed(0) + '%', pctCol, 'b'], [` · ${fmtTok(ctxTok)} / ${fmtTok(lim)}`, C.dark]], [
    line(...stack(ctxParts, sideR, lim)),
    ...used.map((x, i) => dotRow(catCol(i), x.name, x.tokens)),
    buffer > 0 && dotRow(C.dark, 'Autocompact buffer', buffer),
    free && dotRow(C.track, 'Free space', free.tokens, C.gray),
    !cx && line(['measuring after the first turn…', C.dark]),
    ...deferred.map(x => dotRow(C.track, x.name, x.tokens, C.dark)),
  ], sideR)

  // ── Subagents ──────────────────────────────────────────────────────────────
  const counts: Record<string, number> = {}
  for (const s of states.values()) counts[s] = (counts[s] ?? 0) + 1
  const agentRight = ([['run', 'running', ACCENT], ['stall', 'idle?', C.gold], ['wait', 'waiting', C.blue], ['fail', 'failed', C.red], ['done', 'done', C.gray]] as const)
    .filter(([key]) => counts[key])
    .map(([key, name, col], i): Seg => [`${i ? ' · ' : ''}${counts[key]} ${name}`, col])
  const DOT: Record<string, [string, string]> = {
    run: [spin, ACCENT], stall: ['◌', C.gold], wait: ['◷', C.blue], done: ['●', C.dark], fail: ['✕', C.red], stop: ['■', C.orange],
  }
  const compact = iw < 80
  const nameW = Math.max(10, Math.min(26, Math.floor(iw / 4)))
  const timeW = compact ? 0 : 9
  const costW = 8
  const nowW = Math.max(8, iw - 2 - nameW - 1 - timeW - costW)
  const SHOW = 12
  const agentRows = subs.slice(0, SHOW).flatMap(o => {
    const s = states.get(o.id)!
    const fl = o.flights.at(-1)
    const nowSeg: Seg =
      (s === 'run' || s === 'stall') && fl ? [fit(fl.desc, nowW - 7) + ' ' + fmtDur(now - fl.ts), C.gray]
      : s === 'stall' ? [`no activity ${fmtDur(now - o.last)} · last: ${o.action}`, C.gold]
      : s === 'run' ? [o.action || 'starting', C.gray]
      : s === 'wait' ? [`waiting on ${tasksOf(o.id).filter(t => t.state === 'run').length} bg task(s)`, C.blue]
      : [o.report || o.say || o.action || '—', s === 'done' ? C.dark : C.red]
    const row = line(
      [DOT[s]![0] + ' ', DOT[s]![1]],
      [fit(o.label, nameW).padEnd(nameW) + ' ', colorOf(o), s === 'run' ? 'b' : undefined],
      [fit(nowSeg[0], nowW).padEnd(nowW), nowSeg[1]],
      !compact && [(o.first ? fmtDur((s === 'run' || s === 'stall' ? now : o.last) - o.first) : '—').padStart(timeW), C.dark],
      [fmtCost(cost(o)).padStart(costW), C.light],
    )
    if (s === 'done') return [row]
    const own = tasksOf(o.id)
    const bits = [o.type.replace('general-purpose', 'general') || 'agent', prettyModel(o.model), ...(o.effort ? [o.effort] : []), ...(o.background ? ['bg'] : []), `${o.nTools} steps`, ...(o.errs.length ? [`${o.errs.length} errors`] : []), ...(own.length ? [`${own.length} bg task${own.length > 1 ? 's' : ''}`] : [])]
    const meta = bits.join(' · ')
    const say = o.say && o.sayTs >= (fl?.ts ?? 0) - 600_000 ? o.say : ''
    return [row, line(['  └ ', C.track], [fit(meta, Math.max(10, Math.floor((iw * 2) / 5))), C.dark], !!say && [' │ ', C.track], !!say && [fit('“' + say + '”', iw - 8 - vlen(meta)), C.gray, 'i'])]
  })
  const rest = subs.slice(SHOW)
  const agentsBox = subs.length > 0 && section('Subagents', agentRight.length ? agentRight : [[String(subs.length), C.gray]], [
    ...agentRows,
    rest.length > 0 && line([`  +${rest.length} more · ${fmtTok(rest.reduce((s, o) => s + sumTok(o.tok), 0))} · ${fmtCost(rest.reduce((s, o) => s + cost(o), 0))}`, C.dark]),
  ])

  // ── Background tasks ───────────────────────────────────────────────────────
  const ownerName = (id: string) => (id === 'main' ? 'main' : m.owners[id]?.label ?? id.slice(0, 6))
  const ownerCol = (id: string) => (id === 'main' ? mcol : m.owners[id] ? colorOf(m.owners[id]!) : C.gray)
  const ownW = Math.max(8, Math.min(20, Math.floor(iw / 6)))
  const descW = Math.max(10, iw - 2 - 1 - ownW - 1 - 9 - 1 - 12)
  const icon = (t: Task): Seg => (t.state === 'run' ? [spin, ACCENT] : t.state === 'done' ? ['✓', C.green] : t.state === 'fail' ? ['✕', C.red] : ['■', C.gold])
  const result = (t: Task): Seg =>
    t.state === 'run' ? (t.kind === 'monitor' ? [`${t.events} events`, C.cyan] : ['running', ACCENT])
    : t.state === 'fail' ? ['failed', C.red] : t.state === 'stop' ? ['stopped', C.gold] : ['done', C.dark]
  const shownTasks = m.tasks.slice(0, 8)
  const fails = m.tasks.filter(t => t.state === 'fail').length
  const tasksBox = m.tasks.length > 0 && section('Background tasks', [
    [`${runTasks} running`, runTasks ? ACCENT : C.gray], [` · ${m.tasks.length - runTasks} finished`, C.gray], [fails ? ` · ${fails} failed` : '', C.red],
  ], [
    ...shownTasks.flatMap(t => [
      line(
        icon(t), [' ' + fit((t.kind === 'monitor' ? '⌁ ' : '') + t.desc, descW).padEnd(descW) + ' ', t.state === 'fail' ? C.red : t.state === 'run' ? undefined : C.gray],
        [fit(ownerName(t.owner), ownW).padEnd(ownW), ownerCol(t.owner)], [fmtDur((t.end || now) - t.start).padStart(10), C.dark], [' ' + result(t)[0].padStart(12), result(t)[1]],
      ),
      t.state === 'run' && !!t.note && line(['  └ ', C.track], [fit(t.note, iw - 4), C.dark]),
    ]),
    m.tasks.length > shownTasks.length && line([`  +${m.tasks.length - shownTasks.length} older`, C.dark]),
  ])

  const nothingDelegated = subs.length === 0 && m.tasks.length === 0 &&
    line(['no subagents spawned yet · no background tasks', C.dark])

  // ── Timeline: only worth a section once there is more than one lane ───────
  const span = Math.max(1000, t1 - t0)
  const labelW = Math.max(11, Math.min(18, Math.floor(W / 8)))
  const tw = Math.max(10, iw - labelW)
  const col = (ts: number) => Math.trunc(((ts - t0) / span) * (tw - 1))
  const lanes = all.slice(0, 6).map(o => {
    const cells: [string, string][] = Array.from({ length: tw }, () => [' ', C.track])
    if (o.first) for (let x = Math.max(0, col(o.first)); x <= Math.min(tw - 1, col(o.last || o.first)); x++) cells[x] = ['·', C.track]
    for (const ts of o.act) if (ts >= t0) cells[Math.min(tw - 1, col(ts))] = ['━', colorOf(o)]
    for (const ts of o.errs) if (ts >= t0) cells[Math.min(tw - 1, col(ts))] = ['✕', C.red]
    const segs: Seg[] = [[fit(o.label, labelW - 1).padEnd(labelW), colorOf(o)]]
    for (const [ch, c] of cells) {
      const last = segs.at(-1)!
      if (segs.length > 1 && last[1] === c) last[0] += ch
      else segs.push([ch, c])
    }
    return line(...segs)
  })
  const timeline = subs.length > 0 && section('Timeline', [[fmtDur(span), C.gray]], [
    ...lanes,
    spread([[' '.repeat(labelW) + hhmmss(t0), C.dark]], [[active ? 'now' : hhmmss(t1), C.dark]], labelW + tw),
  ])

  // ── Activity ───────────────────────────────────────────────────────────────
  const whoW = Math.max(9, Math.min(16, Math.floor(iw / 7)))
  const whoCol = (who: string) => (who === 'you' ? C.green : who === 'main' ? mcol : subs.find(o => o.label === who) ? colorOf(subs.find(o => o.label === who)!) : C.gray)
  const log = section('Activity', [[`last ${Math.min(10, m.log.length)}`, C.dark]], m.log.length === 0
    ? [line(['nothing yet', C.dark])]
    : m.log.slice(-10).map(ev => line(
        [hhmmss(ev.ts) + '  ', C.dark], [fit(ev.who, whoW).padEnd(whoW) + ' ', whoCol(ev.who)],
        [fit(ev.text, iw - whoW - 11), ev.tag === 'fail' ? C.red : ev.tag === 'say' || ev.tag === 'prompt' ? undefined : C.gray, ev.tag === 'say' ? 'i' : undefined],
      )))

  return (
    <Box flexDirection="column" width={W} paddingX={1}>
      {[
        header,
        attentionBox,
        <Box flexDirection={side < iw ? 'row' : 'column'} columnGap={3} width={iw}>
          {bill}
          {side < iw ? null : gap}
          {context}
        </Box>,
        agentsBox,
        tasksBox,
        nothingDelegated,
        timeline,
        log,
      ].filter(Boolean).flatMap((block, i) => (i ? [gap, block] : [block]))}
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
  agentsShown: boolean
  tick: number
  width: number
  onToggle: () => void
  onToggleAgents: () => void
}

/** The one-line band above the prompt: the key figures and the toggles of the monitor and subagents panes. */
export function drawBand({ Box, Text, Button }: BandEls, B: BandInput) {
  const { m, usage } = B
  const main = m.owners.main!
  const subs = m.order.length - 1
  const running = B.agents.filter(a => a.status === 'running' || a.status === 'pending').length
  const tasks = m.tasks.filter(t => t.state === 'run').length
  const live = m.working || Object.values(m.owners).some(o => o.flights.length > 0)
  const window = (B.cx?.window ?? usage.context.window) || 1
  const tokens = usage.context.tokens ?? main.ctx
  const pct = Math.round((tokens / window) * 100)
  const cost = usage.cost?.usd ?? Object.values(m.owners).reduce((s, o) => s + sumTok(o.usd), 0)
  const seg = (text: string, color?: string, bold?: boolean) => <Text color={color} bold={bold}>{text}</Text>
  const dot = ' · '
  return (
    <Box flexDirection="row" justifyContent="space-between" columnGap={1} width={Math.max(20, B.width)}>
      <Text mono wrap="truncate-end">
        {seg('◆ Monitor', ACCENT, true)}
        {seg(dot, C.dark)}
        {live ? seg(SPIN[B.tick % SPIN.length]! + ' live', C.green) : seg('○ idle', C.gray)}
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
      <Box flexDirection="row" columnGap={1}>
        <Button key="agents" label={B.agentsShown ? 'Hide agents' : 'Show agents'} onPress={B.onToggleAgents} />
        <Button key="toggle" label={B.shown ? 'Hide monitor' : 'Show monitor'} onPress={B.onToggle} />
      </Box>
    </Box>
  )
}

/** The subagents pane: one section per subagent, each with its own step timeline. */
export function drawAgents(els: Els, I: Input & { rows: number }) {
  const { m } = I
  const subs = m.order.slice(1).map(id => m.owners[id]!).filter(Boolean)
  const { Box, Text } = els
  if (subs.length === 0) return <Box paddingX={1}><Text color={C.dark}>no subagents spawned yet</Text></Box>
  const states = classify(m, I.agents, I.now)
  const { k } = billOf(m, I.usage)
  const height = Math.max(10, I.rows)
  return drawFlow(els, {
    agents: pickAgents(subs, states, height), states, now: I.now, tick: I.tick, width: I.width, height,
    colorOf: o => LANE[(subs.indexOf(o) + 1) % LANE.length]!, cost: o => sumTok(o.usd) * k,
    window: I.cx?.window ?? I.usage.context.window,
  })
}
