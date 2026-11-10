// The monitor's drawing: one tree of Box and Text that every surface draws.
import type { AgentInfo, Elements, RenderChildren, SessionUsage } from 'claude-code'

import type { CtxView, Mon, Owner, Task } from '../types'
import { drawFlow } from './flow'
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

export function drawMonitor({ Box, Text }: Els, I: Input & { rows?: number }) {
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
  const billBody = [
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
  ]
  const bill = section('Cost', [[fmtCost(exact), ACCENT, 'b']], billBody, side)

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
  const contextBody = [
    line(...stack(ctxParts, sideR, lim)),
    ...used.map((x, i) => dotRow(catCol(i), x.name, x.tokens)),
    buffer > 0 && dotRow(C.dark, 'Autocompact buffer', buffer),
    free && dotRow(C.track, 'Free space', free.tokens, C.gray),
    !cx && line(['measuring after the first turn…', C.dark]),
    ...deferred.map(x => dotRow(C.track, x.name, x.tokens, C.dark)),
  ]
  const context = section('Context', [[pct.toFixed(0) + '%', pctCol, 'b'], [` · ${fmtTok(ctxTok)} / ${fmtTok(lim)}`, C.dark]], contextBody, sideR)

  // ── Background tasks ───────────────────────────────────────────────────────
  const ownerName = (id: string) => (id === 'main' ? 'main' : m.owners[id]?.label ?? id.slice(0, 6))
  const ownerCol = (id: string) => (id === 'main' ? mcol : m.owners[id] ? colorOf(m.owners[id]!) : C.gray)
  const ownW = Math.max(8, Math.min(20, Math.floor(iw / 6)))
  const descW = Math.max(10, iw - 2 - 1 - ownW - 1 - 9 - 1 - 12)
  const icon = (t: Task): Seg => (t.state === 'run' ? [spin, ACCENT] : t.state === 'done' ? ['✓', C.green] : t.state === 'fail' ? ['✕', C.red] : ['■', C.gold])
  const result = (t: Task): Seg =>
    t.state === 'run' ? (t.kind === 'monitor' ? [`${t.events} events`, C.cyan] : ['running', ACCENT])
    : t.state === 'fail' ? ['failed', C.red] : t.state === 'stop' ? ['stopped', C.gold] : ['done', C.dark]
  const fails = m.tasks.filter(t => t.state === 'fail').length
  const taskLines = (t: Task) => 1 + Number(t.state === 'run' && !!t.note)
  /** The pane never scrolls: tasks shrink to the rows left under the fixed blocks. */
  const rowsOf = (body: unknown[]) => body.filter(Boolean).length
  // header, then each block under a one-row gap; the cost and context blocks sit side by side when wide
  const topRows = 1 + (side < iw ? Math.max(rowsOf(billBody), rowsOf(contextBody)) : rowsOf(billBody) + 1 + rowsOf(contextBody) + 1)
  const fixedRows = 2 + (doing ? 1 : 0) + (attentionBox ? 1 + alerts.length + 1 : 0) + 1 + topRows
  let taskN = Math.min(8, m.tasks.length)
  if (I.rows && I.rows > 0) {
    const spare = (n: number) => I.rows! - fixedRows - (n > 0 ? 2 + m.tasks.slice(0, n).reduce((s, t) => s + taskLines(t), 0) + Number(m.tasks.length > n) : 0)
    while (taskN > 0 && spare(taskN) < 0) taskN--
  }
  const shownTasks = m.tasks.slice(0, taskN)
  const tasksBox = taskN > 0 && section('Background tasks', [
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
        tasksBox,
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

/** Where the subagents column sits in the pane body: its first column and row, and its size. */
export type AgentsBox = { column: number; row: number; width: number; height: number }

/** Wide enough for the monitor and the subagents side by side (else the monitor sits on top). */
const SPLIT_COLUMNS = 100

/**
 * The monitor pane: the monitor alone, the subagents alone, or both in two equal halves: subagents left
 * and monitor right when wide, monitor on top when narrow, with a line between them. The monitor fits its half; the subagents scroll from `offset`.
 */
export function drawPane(els: Els, I: Input & { rows: number; offset: number; showMonitor: boolean; showAgents: boolean }): { el: RenderChildren; agents?: AgentsBox; max: number } {
  const { m } = I
  const subs = m.order.slice(1).map(id => m.owners[id]!).filter(Boolean)
  if (!I.showAgents || subs.length === 0) return { el: drawMonitor(els, I), max: 0 }
  const { Box, Text } = els
  const W = Math.max(30, I.width)
  const wide = W >= SPLIT_COLUMNS
  const half = wide ? Math.floor(W / 2) : Math.floor(I.rows / 2)
  const box: AgentsBox = !I.showMonitor ? { column: 0, row: 0, width: W, height: I.rows }
    : wide ? { column: 0, row: 0, width: half, height: I.rows }
    : { column: 0, row: half + 1, width: W, height: Math.max(1, I.rows - half - 1) }
  const monW = wide ? W - half - 1 : W
  const monRows = wide ? I.rows : half
  const states = classify(m, I.agents, I.now)
  const { k } = billOf(m, I.usage)
  const flow = drawFlow(els, {
    agents: subs, states, now: I.now, tick: I.tick, width: box.width - 2, height: box.height, offset: I.offset,
    colorOf: o => LANE[(subs.indexOf(o) + 1) % LANE.length]!, cost: o => sumTok(o.usd) * k,
    window: I.cx?.window ?? I.usage.context.window,
  })
  return {
    agents: box,
    max: flow.max,
    el: (
      <Box flexDirection={wide ? 'row-reverse' : 'column'} width={W}>
        {I.showMonitor && <Box width={monW} height={monRows} overflow="hidden">{drawMonitor(els, { ...I, width: monW, rows: monRows })}</Box>}
        {I.showMonitor && (wide
          ? <Box flexDirection="column" width={1} height={I.rows}>{Array.from({ length: I.rows }, () => <Text mono color={C.track}>│</Text>)}</Box>
          : <Text mono color={C.track}>{'─'.repeat(W)}</Text>)}
        <Box width={box.width} height={box.height} paddingX={1}>{flow.el}</Box>
      </Box>
    ),
  }
}
