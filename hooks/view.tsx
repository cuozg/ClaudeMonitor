// The monitor's drawing: one tree of Box and Text that every surface draws.
import type { AgentInfo, Elements, RenderChildren, SessionUsage } from 'claude-code'

import type { CtxView, Mon, Owner, Task } from '../types'
import {
  C, LANE, PIE, SPIN, STALL_MS, bar, fit, fmtCost, fmtDur, fmtRate, fmtTok, hhmmss, hitRate, modelColor,
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

const PILL: Record<string, [string, string]> = {
  run: ['RUN', C.green], stall: ['IDLE?', C.gold], wait: ['WAIT', C.blue], done: ['DONE', '#4e4e4e'],
  fail: ['FAIL', C.red], stop: ['STOP', C.orange],
}

export function drawMonitor({ Box, Text }: Els, I: Input) {
  const { m, cx, usage, now, tick } = I
  const W = Math.max(30, I.width)
  const spin = SPIN[tick % SPIN.length]!

  // ── Figures ────────────────────────────────────────────────────────────────
  const main = m.owners.main!
  const subs = m.order.slice(1).map(id => m.owners[id]!).filter(Boolean)
  const all = [main, ...subs]
  const est = all.reduce((s, o) => s + sumTok(o.usd), 0)
  const exact = usage.cost?.usd ?? est
  const k = est > 0 ? exact / est : 1
  const cost = (o: Owner) => sumTok(o.usd) * k
  const tok = all.reduce((t, o) => addTok(t, o.tok), zero())
  const usd = all.reduce((t, o) => addTok(t, o.usd), zero())
  const nocache = all.reduce((s, o) => s + o.nocache, 0) * k
  const subCost = subs.reduce((s, o) => s + cost(o), 0)
  const info = new Map(I.agents.map(a => [a.id, a]))
  const tasksOf = (id: string) => m.tasks.filter(t => t.owner === id)
  const stateOf = (o: Owner): AgentState => {
    const st = info.get(o.id)?.status
    if (st === 'completed') return 'done'
    if (st === 'failed') return 'fail'
    if (st === 'killed') return 'stop'
    if (st === 'waiting' || (st === 'idle' && tasksOf(o.id).some(t => t.state === 'run'))) return 'wait'
    if (st === 'running' || st === 'pending' || (!st && !o.report && now - o.last < 20_000)) {
      return o.flights.length === 0 && now - o.last > STALL_MS ? 'stall' : 'run'
    }
    return 'done'
  }
  const states = new Map(subs.map(o => [o.id, stateOf(o)]))
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
  const burn = m.samples.filter(([ts]) => ts >= now - 600_000).reduce((s, [, v]) => s + v, 0) * 6 * k
  const buckets = Array<number>(30).fill(0)
  for (const [ts, v] of m.samples) {
    const age = Math.trunc((now - ts) / 60_000)
    if (age >= 0 && age < 30) buckets[29 - age]! += v
  }
  const r = rates(main.model)
  const mcol = modelColor(main.model)
  const colorOf = (o: Owner) => (o.id === 'main' ? mcol : LANE[(subs.indexOf(o) + 1) % LANE.length]!)

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
  const center = (...segs: (Seg | false | undefined)[]) => (
    <Box flexDirection="row" justifyContent="center">
      {line(...segs)}
    </Box>
  )
  const panel = (title: Seg[], color: string, body: RenderChildren[], right?: Seg[], width?: number) => (
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
    <Text mono backgroundColor={bg} color={bg === PILL.done![1] ? '#eeeeee' : '#000000'} bold>
      {` ${label} `.padEnd(7)}
    </Text>
  )

  // ── Header ─────────────────────────────────────────────────────────────────
  const project = (I.cwd.split('/').pop() || '/').toUpperCase()
  const alerts: Seg[] = []
  for (const o of subs) {
    const s = states.get(o.id)
    if (s === 'stall') alerts.push([`⚠ ${o.label} idle ${fmtDur(now - o.last)}`, C.gold])
    if (s === 'fail') alerts.push([`✗ ${o.label} failed`, C.red])
  }
  for (const t of m.tasks) if (t.state === 'fail' && now - t.end < 1_800_000) alerts.push([`✗ task ${fit(t.desc, 24)} failed`, C.red])
  const usable = window - buffer
  const pctUse = usable > 0 ? (ctxTok / usable) * 100 : 0
  if (pctUse >= 80) alerts.push([`⚠ context ${pctUse.toFixed(0)}% of usable`, pctUse >= 90 ? C.red : C.gold])
  const legendLong: Seg[] = [
    ['■ ', mcol], [prettyModel(main.model) + ' · main  '], ['■ ', C.orange], ['input ' + fmtRate(r.in) + '  '],
    ['■ ', C.pink], ['cache write ' + fmtRate(r.cw) + '  '], ['■ ', C.blue], ['cache read ' + fmtRate(r.cr) + '  '],
    ['■ ', C.gold], ['output ' + fmtRate(r.out) + '  '], ['per MTok', C.gray],
  ]
  const legendShort: Seg[] = [
    ['■ ', C.orange], ['in ' + fmtRate(r.in) + '  '], ['■ ', C.pink], ['cw ' + fmtRate(r.cw) + '  '],
    ['■ ', C.blue], ['cr ' + fmtRate(r.cr) + '  '], ['■ ', C.gold], ['out ' + fmtRate(r.out)],
  ]
  const header = (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="center" columnGap={1}>
        {active ? pill('● LIVE', C.green) : pill('IDLE', PILL.done![1])}
        {line(['✳ CLAUDE CODE MONITOR', undefined, 'b'], ['  ·  ', C.dark], [fit(project, Math.max(8, W - 50)), C.orange, 'b'], ['  ·  ', C.dark], [fmtCost(exact), C.gold, 'b'])}
      </Box>
      {center([fit(`${I.cwd.replace(I.home, '~')}  ·  session ${I.sid.slice(0, 8)}  ·  ${hhmmss(now)}`, W), C.gray])}
      {line(['═'.repeat(W), C.frame])}
      {center(...(legendLong.reduce((n, s) => n + vlen(s[0]), 0) <= W ? legendLong : legendShort))}
      {alerts.length > 0 && center(...alerts.flatMap((a, i): Seg[] => (i ? [['  ·  ', C.dark], a] : [a])))}
    </Box>
  )

  // ── Main loop, meters ──────────────────────────────────────────────────────
  const stateSeg: Seg = state === 'idle' ? ['○ idle', C.gray] : [spin + ' ' + state, C.green]
  const doing: Seg[] = flight && state === 'working'
    ? [['» ' + fit(flight.desc, W - 16), C.gold], [` (${fmtDur(now - flight.ts)})`, C.gray]]
    : [['» ' + fit(main.action || 'waiting for prompt', W - 8), C.gold]]
  const mainBox = (
    <Box flexDirection="column" borderStyle="round" borderColor={state === 'idle' ? C.dark : mcol} paddingX={1} alignItems="center">
      {line([prettyModel(main.model), mcol, 'b'], [' · ', C.dark], ['main session '], stateSeg)}
      {line(...doing)}
      {line(
        !!main.effort && ['effort ', C.gray], !!main.effort && [main.effort + ' · ', C.pink],
        ['context '], [ctxTok.toLocaleString('en-US'), undefined, 'b'], [' / ' + fmtTok(window), C.gray], [' · ', C.dark],
        ['cache '], [(hitRate(main.tok) * 100).toFixed(0) + '%', C.blue, 'b'], [' · ', C.dark], [fmtDur(t1 - t0), C.gray],
      )}
    </Box>
  )
  const team = center(
    [`delegate · ${subs.length} agents · `, C.gray], [`${running} live`, running ? C.green : C.gray], [' · ', C.gray],
    [`${runTasks} bg tasks`, runTasks ? C.cyan : C.gray], ['  ·  ', C.dark], [(hitRate(tok) * 100).toFixed(0) + '% cache hits', C.blue, 'b'],
  )
  const perRow = W >= 64 ? 4 : 2
  const cardW = Math.floor((W - (perRow - 1)) / perRow)
  const mi = Math.max(4, cardW - 4)
  const totUsd = sumTok(usd) || 1
  const meters = (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      {([['in', 'input', 'uncached', C.orange], ['cw', 'cache write', 'written', C.pink], ['cr', 'cache read', 'hits', C.blue], ['out', 'output', 'generated', C.gold]] as const).map(
        ([key, name, sub, col]) => (
          <Box flexDirection="column" borderStyle="round" borderColor={col} paddingX={1} width={cardW} alignItems="center">
            {line([fit(name, mi), undefined, 'b'])}
            {line([fit(`${sub} · ${fmtTok(tok[key])}`, mi), C.gray])}
            {line(...barSegs(usd[key] / totUsd, mi, col))}
            {line([fmtCost(usd[key] * k), col, 'b'])}
            {line(active ? [fit(PIE[tick % 4] + ' counting', mi), C.gold] : [fit('✓ final', mi), C.gray])}
          </Box>
        ),
      )}
    </Box>
  )

  // ── The bill ───────────────────────────────────────────────────────────────
  const side = W >= 76 ? Math.floor((W - 1) / 2) : W
  const bi = side - 4
  const saved = nocache > 0 ? Math.max(0, 1 - exact / nocache) * 100 : 0
  const burnCol = burn > 20 ? C.red : burn > 5 ? C.gold : C.green
  const spark = sparkline(buckets.slice(-bi))
  const limits = usage.rateLimits.map(l => {
    const label = l.kind === 'five_hour' ? '5h limit' : l.kind === 'seven_day' ? '7d limit' : l.kind.replace(/_/g, ' ')
    const col = l.percentUsed >= 90 ? C.red : l.percentUsed >= 70 ? C.gold : C.green
    const reset = l.resetsAt ? ' · ' + hhmmss(Date.parse(l.resetsAt)).slice(0, 5) : ''
    return spread([[label, C.gray]], [[l.percentUsed.toFixed(0) + '%', col, 'b'], [reset, C.gray]])
  })
  const bill = panel([['THE BILL', C.gold, 'b']], C.gold, [
    line([fit(`${prettyModel(main.model).toLowerCase()} · ${fmtRate(r.in)} in · ${fmtRate(r.out)} out /MTok`, bi), C.gray]),
    spread([['total', undefined, 'b']], [[fmtCost(exact), C.gold, 'b']]),
    spread([['main', C.gray]], [[fmtCost(cost(main)), C.gold]]),
    spread([[`agents (${subs.length})`, C.gray]], [[fmtCost(subCost), C.gold]]),
    line(['']),
    spread([['cache hits', C.gray]], [[(hitRate(tok) * 100).toFixed(0) + '%', C.blue, 'b']]),
    spread([['no cache', C.gray]], [[fmtCost(nocache), C.red, 's']]),
    spread([['saved', C.gray]], [[saved.toFixed(0) + '%', C.green, 'b']]),
    line(['']),
    spread([['burn (10m)', C.gray]], [[fmtCost(burn) + '/h', burnCol, 'b']]),
    line(...spark.map((s): Seg => [s.ch, s.on ? C.gold : C.track])),
    <Box width={Math.min(bi, 30)} flexDirection="row" justifyContent="space-between">{line(['-30m', C.dark])}{line(['now', C.dark])}</Box>,
    limits.length > 0 && line(['']),
    ...limits,
  ], undefined, side)

  // ── Context ────────────────────────────────────────────────────────────────
  const lim = window || 1
  const pct = (ctxTok / lim) * 100
  const pctCol = pct > 75 ? C.red : pct > 50 ? C.gold : undefined
  const used = (cx?.rows ?? []).filter(x => x.kind === 'used')
  const free = cx?.rows.find(x => x.kind === 'free')
  const deferred = (cx?.rows ?? []).filter(x => x.kind === 'deferred')
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
  const context = panel([['CONTEXT', undefined, 'b']], C.frame, [
    spread([[pct.toFixed(0) + '% used', pctCol, 'b']], [[`${fmtTok(ctxTok)} / ${fmtTok(lim)}`, C.gray]]),
    line(...ctxBar),
    ...used.map((x, i) => ctxRow(['■', catCol(i)], x.name, x.tokens)),
    buffer > 0 && ctxRow(['■', C.dark], 'Autocompact buffer', buffer),
    free && ctxRow(['■', C.track], 'Free space', free.tokens, C.gray),
    !cx && line(['measuring after the first turn…', C.dark]),
    (deferred.length > 0 || (cx?.mcpDeferred ?? 0) > 0) && line(['']),
    ...deferred.map(x => spread([['□ ', C.dark], [fit(x.name, bi - 12), C.gray]], [[fmtTok(x.tokens), C.gray]])),
    (cx?.mcpDeferred ?? 0) > 0 && spread([['□ ', C.dark], ['MCP tools not loaded', C.gray]], [[`${cx!.mcpDeferred} tools`, C.gray]]),
    (cx?.memory.length ?? 0) > 0 && spread([['▾ Memory files', C.gray]], [[String(cx!.memory.length), C.gray]]),
    ...(cx?.memory ?? []).map(f => spread([['  └ ', C.dark], [fit(f.name, bi - 14), C.light]], [[fmtTok(f.tokens)]])),
  ], undefined, side)

  // ── Who sees what ──────────────────────────────────────────────────────────
  const totalTok = sumTok(tok) || 1
  const ranked = [...subs].sort((a, b) => sumTok(b.tok) - sumTok(a.tok))
  const top = ranked.slice(0, 4)
  const shareRows: [string, number, string][] = [['main', sumTok(main.tok), mcol], ...top.map((o): [string, number, string] => [o.label, sumTok(o.tok), colorOf(o)])]
  if (ranked.length > top.length) shareRows.push([`+${ranked.length - top.length} others`, ranked.slice(top.length).reduce((s, o) => s + sumTok(o.tok), 0), C.gray])
  const lw = Math.max(8, Math.min(22, Math.floor((W - 4) / 3)))
  const bw = Math.max(4, W - 4 - lw - 1 - 12)
  const share = panel([['WHO SEES WHAT', undefined, 'b'], [' · tokens', C.gray]], C.frame, shareRows.map(([name, n, col]) =>
    line([fit(name, lw).padEnd(lw) + ' ', col], ...barSegs(n / totalTok, bw, col), [fmtTok(n).padStart(7) + (((n / totalTok) * 100).toFixed(0) + '%').padStart(5), C.gray]),
  ))

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
  const agentsBox = panel([['AGENTS', undefined, 'b'], [` · ${subs.length}`, C.gray]], C.frame, subs.length === 0
    ? [line(['no subagents spawned yet — delegate with the Agent tool and they show up here', C.dark])]
    : [
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
  const tasksBox = panel([['BACKGROUND TASKS', undefined, 'b']], C.frame, m.tasks.length === 0
    ? [line(['no background tasks (run_in_background / Monitor)', C.dark])]
    : [
        ...shownTasks.flatMap(t => [
          line(
            icon(t), [' ' + fit((t.kind === 'monitor' ? '⌁ ' : '') + t.desc, descW).padEnd(descW) + ' ', t.state === 'fail' ? C.red : t.state === 'run' ? undefined : C.light],
            [fit(ownerName(t.owner), ownW).padEnd(ownW), ownerCol(t.owner)], [fmtDur((t.end || now) - t.start).padStart(10), C.gray], [' ' + result(t)[0].padStart(12), result(t)[1]],
          ),
          t.state === 'run' && !!t.note && line(['  └ ', C.dark], [fit(t.note, ai - 4), C.gray]),
        ]),
        m.tasks.length > shownTasks.length && line([`  +${m.tasks.length - shownTasks.length} older`, C.dark]),
      ], [[`${runTasks} running  `, runTasks ? C.green : C.gray], [`${m.tasks.length - runTasks} finished`, C.gray], [fails ? `  ${fails} failed` : '', C.red]])

  // ── Timeline ───────────────────────────────────────────────────────────────
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
  const mid = hhmmss(t0 + span / 2)
  const left = hhmmss(t0)
  const axis = ' '.repeat(labelW) + left + ' '.repeat(Math.max(1, Math.floor(tw / 2) - left.length - Math.floor(mid.length / 2))) + mid
  const timeline = panel([['SESSION TIMELINE', undefined, 'b'], [' · ' + fmtDur(span), C.gray]], C.frame, [
    ...lanes,
    <Box flexDirection="row" justifyContent="space-between" width={labelW + tw}>{line([axis, C.gray])}{line([active ? 'now' : hhmmss(t1), C.gray])}</Box>,
  ])

  // ── Log tail ───────────────────────────────────────────────────────────────
  const whoW = Math.max(9, Math.min(16, Math.floor(ai / 7)))
  const whoCol = (who: string) => (who === 'you' ? C.green : who === 'main' ? mcol : subs.find(o => o.label === who) ? colorOf(subs.find(o => o.label === who)!) : C.gray)
  const log = panel([['TAIL -F SESSION.LOG', undefined, 'b']], C.frame, m.log.length === 0
    ? [line(['nothing yet', C.dark])]
    : m.log.slice(-12).map(ev =>
        spread(
          [[hhmmss(ev.ts) + '  ', C.dark], [fit(ev.who, whoW).padEnd(whoW) + ' ', whoCol(ev.who)], [fit(ev.text, ai - whoW - 14 - ev.tag.length), ev.tag === 'fail' ? C.red : ev.tag === 'say' ? undefined : C.light, ev.tag === 'say' ? 'i' : undefined]],
          [[`[${ev.tag}]`, ev.tag === 'fail' ? C.red : C.dark]],
        ),
      ))

  // ── Status ─────────────────────────────────────────────────────────────────
  const st = (key: string, value: string, c: string): Seg[] => [[key + ' ', C.gray], ['[' + value + ']  ', c]]
  const status = line(
    ['❯ ', C.green],
    ...st('model', prettyModel(main.model), mcol),
    ...st('effort', main.effort || '—', C.pink),
    ...st('ctx', `${fmtTok(ctxTok)} ${((ctxTok / lim) * 100).toFixed(0)}%`, C.light),
    ...st('bill', fmtCost(exact), C.gold),
    ...st('burn', fmtCost(burn) + '/h', C.gold),
    ...st('agents', `${running}/${subs.length}`, C.green),
    ...st('bg', String(runTasks), C.cyan),
  )

  return (
    <Box flexDirection="column" width={W}>
      {header}
      {mainBox}
      {team}
      {meters}
      <Box flexDirection={side < W ? 'row' : 'column'} columnGap={1}>
        {bill}
        {context}
      </Box>
      {share}
      {agentsBox}
      {tasksBox}
      {timeline}
      {log}
      {status}
    </Box>
  )
}
