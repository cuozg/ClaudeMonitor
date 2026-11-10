// Agent flow: one compact card per subagent in a grid (1x1, 1x2, 2x2, 3x2, 3x3).
import type { Elements } from 'claude-code'

import type { Owner } from '../types'
import { C, SPIN, bar, fit, fmtCost, fmtTok, modelColor, prettyModel, vlen } from './lib'

type Els = Pick<Elements['terminal'], 'Box' | 'Text'>
type Seg = [string, string?, ('b' | 'd' | 'i')?]
export type FlowInput = {
  agents: Owner[]
  states: Map<string, string>
  colorOf: (o: Owner) => string
  cost: (o: Owner) => number
  window: number
  now: number
  tick: number
  width: number
  height: number
}

const ACCENT = '#d97757'
const MAX_CELLS = 9
const TAG: Record<string, string> = {
  read: C.blue, edit: C.orange, bash: C.green, search: C.purple, web: C.cyan, delegate: C.pink, skill: C.gold, mcp: C.cyan, plan: C.gray,
}
const DOT: Record<string, [string, string]> = {
  stall: ['◌', C.gold], wait: ['◷', C.blue], done: ['●', C.dark], fail: ['✕', C.red], stop: ['■', C.orange],
}

/** Columns and rows of the grid for `n` agents: 1x1, 1 col 2 rows, 2x2, 3x2, 3x3. */
export function gridOf(n: number): [number, number] {
  if (n <= 1) return [1, 1]
  if (n === 2) return [1, 2]
  if (n <= 4) return [2, 2]
  if (n <= 6) return [3, 2]
  return [3, 3]
}

/** At most nine agents, in spawn order; past nine the oldest finished ones leave first. */
export function pickAgents(subs: Owner[], states: Map<string, string>): Owner[] {
  const list = [...subs]
  while (list.length > MAX_CELLS) {
    const i = list.findIndex(o => ['done', 'fail', 'stop'].includes(states.get(o.id) ?? ''))
    list.splice(i < 0 ? 0 : i, 1)
  }
  return list
}

const mmss = (ms: number) => {
  const s = Math.trunc(Math.max(0, ms) / 1000)
  return String(Math.trunc(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
}
const textW = (segs: Seg[]) => segs.reduce((n, s) => n + vlen(s[0]), 0)

export function drawFlow({ Box, Text }: Els, I: FlowInput) {
  const { agents, states, now, tick } = I
  const [cols, rows] = gridOf(agents.length)
  const base = Math.max(12, Math.floor((I.width - (cols - 1)) / cols))
  const cellH = Math.max(4, Math.floor(I.height / rows))
  const spin = SPIN[tick % SPIN.length]!

  const line = (...segs: (Seg | false)[]) => (
    <Text mono wrap="truncate-end">
      {segs.filter((s): s is Seg => !!s).map(([t, c, st]) => (
        <Text color={c} bold={st === 'b'} dimColor={st === 'd'} italic={st === 'i'}>{t}</Text>
      ))}
    </Text>
  )
  const spread = (left: Seg[], right: Seg[], w: number) => line(...left, [' '.repeat(Math.max(1, w - textW(left) - textW(right)))], ...right)

  const cell = (o: Owner, w: number) => {
    const iw = w - 4
    const s = states.get(o.id) ?? 'run'
    const live = s === 'run' || s === 'stall'
    const [ic, icol] = live && s === 'run' ? [spin, ACCENT] : DOT[s] ?? DOT.done!
    const col = I.colorOf(o)
    const t0 = o.first || now
    const pct = I.window > 0 ? o.ctx / I.window : 0
    const pcol = pct > 0.75 ? C.red : pct > 0.5 ? C.gold : C.green
    const [on, off] = bar(pct, Math.max(4, iw - 9))
    const head = [
      spread([[ic + ' ', icol], [fit(o.label, Math.max(4, iw - 8)), col, 'b']], [[mmss((live ? now : o.last) - t0), C.dark]], iw),
      line([prettyModel(o.model), modelColor(o.model)], [' · ' + (o.type.replace('general-purpose', 'general') || 'agent') + (o.effort ? ' · ' + o.effort : ''), C.gray]),
      spread([[fmtTok(o.ctx) + ' ctx', C.gray]], [[fmtCost(I.cost(o)), C.light, 'b']], iw),
      line([on, pcol], [off, C.track], [(pct * 100).toFixed(0).padStart(4) + '%', pcol, 'b']),
    ].slice(0, Math.max(1, cellH - 2))
    let room = cellH - 2 - head.length
    const sep = room > 3 ? [line(['─'.repeat(iw), C.track])] : []
    room -= sep.length
    const closing = s === 'done' || s === 'fail' || s === 'stop'
    const take = Math.max(0, room - (closing ? 1 : 0))
    const steps = take > 0 ? o.steps.slice(-take) : []
    const stepRows = steps.map(st => {
      const running = st.end === 0 && o.flights.some(f => f.id === st.id)
      const tagCol = st.err ? C.red : running ? ACCENT : TAG[st.tag] ?? C.gray
      const right: Seg[] =
        running ? [[mmss(now - st.ts), C.dark]]
        : st.plus || st.minus ? [[st.plus ? '+' + st.plus : '', C.green], [st.minus ? ' -' + st.minus : '', C.red]]
        : []
      const lead: Seg[] = [[mmss(st.ts - t0) + ' ', C.dark], [(st.err ? '✕' : running ? spin : '●') + ' ', tagCol]]
      const tw = Math.max(3, iw - textW(lead) - textW(right) - 1)
      return spread([...lead, [fit(st.text, tw), st.err ? C.red : running ? undefined : C.gray]], right, iw)
    })
    const end = closing && take >= 0 && room > 0 && [
      line([mmss(o.last - t0) + ' ', C.dark], [s === 'done' ? '✓ ' : '✕ ', s === 'done' ? C.green : C.red], [fit(o.report || (s === 'done' ? 'Complete' : s), Math.max(3, iw - 8)), s === 'done' ? C.light : C.red]),
    ]
    return (
      <Box flexDirection="column" width={w} height={cellH} borderStyle="round" borderColor={live ? col : C.frame} paddingX={1} overflow="hidden">
        {head}
        {sep}
        {stepRows}
        {end || []}
      </Box>
    )
  }

  const grid = Array.from({ length: rows }, (_, r) => (
    <Box flexDirection="row" columnGap={1} width={I.width}>
      {Array.from({ length: cols }, (_, c) => {
        const o = agents[r * cols + c]
        const w = c === cols - 1 ? I.width - (cols - 1) * (base + 1) : base
        return o ? cell(o, w) : <Box width={w} height={cellH} />
      })}
    </Box>
  ))
  return <Box flexDirection="column" width={I.width} height={I.height}>{grid}</Box>
}
