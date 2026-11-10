// Agent flow: a single column, one section per subagent, a hairline between sections.
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
  /** The first row shown: the column scrolls on its own, clamped to its rows. */
  offset: number
}

const ACCENT = '#d97757'
const MAX_CELLS = 9
const STEPS = 8
const TAG: Record<string, string> = {
  read: C.blue, edit: C.orange, bash: C.green, search: C.purple, web: C.cyan, delegate: C.pink, skill: C.gold, mcp: C.cyan, plan: C.gray,
}
const DOT: Record<string, [string, string]> = {
  stall: ['◌', C.gold], wait: ['◷', C.blue], done: ['●', C.dark], fail: ['✕', C.red], stop: ['■', C.orange],
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

  // Timeline line: `mm:ss ● Tag  text            +n -n | 1.2s`, times relative to the agent's start.
  const stepLine = (o: Owner, st: Owner['steps'][number], live: boolean) => {
    const running = st.end === 0 && live
    const [ic, icol] = st.err ? ['✕', C.red] : running ? [spin, ACCENT] : ['●', TAG[st.tag] ?? C.gray]
    const tag = (st.tag.charAt(0).toUpperCase() + st.tag.slice(1)).slice(0, 7).padEnd(7)
    const right: Seg[] = st.plus || st.minus
      ? [['+' + st.plus, C.green], [' -' + st.minus, C.red]]
      : st.end ? [[(Math.max(0, st.end - st.ts) / 1000).toFixed(1) + 's', C.dark]] : []
    const head: Seg[] = [['  ' + mmss(st.ts - (o.first || st.ts)) + ' ', C.dark], [ic + ' ', icol], [tag + ' ', TAG[st.tag] ?? C.gray, 'b']]
    const tw = Math.max(4, I.width - textW(head) - textW(right) - 2)
    const segs: Seg[] = [...head, [fit(st.text, tw).padEnd(tw), st.err ? C.red : C.light], [' '], ...right]
    return (
      <Text mono wrap="truncate-end">
        {segs.map(([t, c, s]) => <Text color={c} bold={s === 'b'} dimColor={s === 'd'} italic={s === 'i'}>{t}</Text>)}
      </Text>
    )
  }

  // Each agent is a section: its header row, then the latest steps of its own workflow (and the report once finished).
  const section = (o: Owner) => {
    const s = states.get(o.id) ?? 'run'
    const live = s === 'run' || s === 'stall'
    const report = !live && o.report ? 1 : 0
    return [
      row(o),
      ...o.steps.slice(-(STEPS - report)).map(st => stepLine(o, st, live)),
      ...(report ? [
        <Text mono wrap="truncate-end">
          <Text color={C.dark}>{'  ' + mmss(o.last - (o.first || o.last)) + ' '}</Text>
          <Text color={C.green}>{'✓ '}</Text>
          <Text color={C.light}>{fit(o.report, Math.max(4, I.width - 11))}</Text>
        </Text>,
      ] : []),
    ]
  }

  // A hairline separates one subagent session from the next; the column shows a window of `height` rows from `offset`.
  const rule = <Text mono color={C.track}>{'─'.repeat(Math.max(1, I.width))}</Text>
  const rows = agents.flatMap((o, i) => (i ? [rule, ...section(o)] : section(o)))
  const max = Math.max(0, rows.length - I.height)
  const off = Math.min(Math.max(0, I.offset), max)
  return {
    max,
    el: (
      <Box flexDirection="column" width={I.width} height={I.height} overflow="hidden">
        {rows.slice(off, off + I.height)}
      </Box>
    ),
  }
}
