// Agent flow: a single column, one row per subagent.
import type { Elements } from 'claude-code'

import type { Owner } from '../types'
import { C, SPIN, fit, fmtCost, fmtTok, modelColor, prettyModel, vlen } from './lib'

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

/** At most `max` agents, in spawn order; past that the oldest finished ones leave first. */
export function pickAgents(subs: Owner[], states: Map<string, string>, max: number): Owner[] {
  const list = [...subs]
  while (list.length > Math.max(1, max)) {
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
  const spin = SPIN[tick % SPIN.length]!

  const row = (o: Owner) => {
    const s = states.get(o.id) ?? 'run'
    const live = s === 'run' || s === 'stall'
    const [ic, icol] = s === 'run' ? [spin, ACCENT] : DOT[s] ?? DOT.done!
    const pct = I.window > 0 ? o.ctx / I.window : 0
    const pcol = pct > 0.75 ? C.red : pct > 0.5 ? C.gold : C.green
    const right: Seg[] = [
      [prettyModel(o.model).padEnd(7), modelColor(o.model)],
      [' ' + (o.type.replace('general-purpose', 'general') || 'agent').slice(0, 9).padEnd(9), C.gray],
      [' ' + fmtTok(o.ctx).padStart(6), C.gray],
      [(pct * 100).toFixed(0).padStart(4) + '%', pcol, 'b'],
      [fmtCost(I.cost(o)).padStart(8), C.light, 'b'],
      [' ' + mmss((live ? now : o.last) - (o.first || now)), C.dark],
    ]
    const lw = Math.max(4, I.width - 2 - textW(right) - 1)
    const segs: Seg[] = [[ic + ' ', icol], [fit(o.label, lw).padEnd(lw), I.colorOf(o), 'b'], [' '], ...right]
    return (
      <Text mono wrap="truncate-end">
        {segs.map(([t, c, st]) => <Text color={c} bold={st === 'b'} dimColor={st === 'd'} italic={st === 'i'}>{t}</Text>)}
      </Text>
    )
  }

  return <Box flexDirection="column" width={I.width} height={I.height} overflow="hidden">{agents.map(row)}</Box>
}
