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
/** Plain-language label per step kind, and the verb prefix `describeTool` put in front of the detail. */
const LABEL: Record<string, string> = {
  read: 'Reading', edit: 'Editing', bash: 'Running', search: 'Searching', web: 'Web', delegate: 'Delegating',
  skill: 'Skill', mcp: 'MCP', plan: 'Planning', monitor: 'Watching', stop: 'Stopping',
}
const PREFIX = /^(read |edit |write |\$ |grep |glob |search |fetch |delegate → |skill |monitor |mcp |stop task )/
/** A raw shell command as a short phrase a person can read at a glance. */
const plainCmd = (c: string) =>
  /\b(pytest|jest|vitest|npm (run )?test|cargo test|go test|dotnet test|tsc\b)/.test(c) ? 'run tests / type-check'
  : /^(npm|pnpm|yarn|bun) (i|install|add)\b|^pip3? install\b/.test(c) ? 'install dependencies'
  : /\b(build|compile|xcodebuild|gradle)\b/.test(c) ? 'build the project'
  : /^git (\w+)/.test(c) ? 'git ' + /^git (\w+)/.exec(c)![1]
  : /^(ls|cat|head|tail|sed|rg|grep|find)\b/.test(c) ? 'inspect files'
  : /^sleep \d+/.test(c) ? 'wait'
  : c
const DOT: Record<string, [string, string]> = {
  stall: ['◌', C.gold], wait: ['◷', C.blue], done: ['●', C.dark], fail: ['✕', C.red], stop: ['■', C.orange],
}

const mmss = (ms: number) => {
  const s = Math.trunc(Math.max(0, ms) / 1000)
  return String(Math.trunc(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
}
const textW = (segs: Seg[]) => segs.reduce((n, s) => n + vlen(s[0]), 0)

/** Narrowest a subagent column may be before the rest are folded into "+n more". */
const MIN_COL = 20
const RECENT = 3

/** A step's detail cut down to a few words: a path becomes its file name, a shell command a plain phrase. */
const brief = (st: Owner['steps'][number]) => {
  const raw = st.tag === 'tool' ? st.text : st.text.replace(PREFIX, '')
  if (st.tag === 'bash') return plainCmd(raw.replace(/^cd\s+\S+\s*(&&|;)\s*/, ''))
  if (st.tag === 'read' || st.tag === 'edit') return raw.split('/').pop() ?? raw
  return raw
}

/** One row of a column: coloured segments cut to the column's width. */
const line = ({ Text }: Els, segs: Seg[]) => (
  <Text mono wrap="truncate-end">
    {segs.map(([t, c, s]) => <Text color={c} bold={s === 'b'} dimColor={s === 'd'} italic={s === 'i'}>{t}</Text>)}
  </Text>
)

/**
 * The live subagents side by side, one column each, split with a vertical line; a finished agent's column closes.
 * A column is short on purpose: who, its model, context and cost, what it is doing now, and its last few steps.
 */
export function drawFlow(els: Els, I: FlowInput) {
  const { Box, Text } = els
  const { states, now, tick } = I
  const spin = SPIN[tick % SPIN.length]!
  const live = I.agents.filter(o => { const s = states.get(o.id) ?? 'run'; return s === 'run' || s === 'stall' || s === 'wait' })
  if (live.length === 0) {
    return { max: 0, el: <Box width={I.width} height={I.height}>{line(els, [['No subagents running', C.dark, 'i']])}</Box> }
  }
  const fit_n = Math.max(1, Math.floor((I.width + 1) / (MIN_COL + 1)))
  const shown = live.slice(0, fit_n)
  const more = live.length - shown.length
  const cw = Math.floor((I.width - (shown.length - 1)) / shown.length)

  const column = (o: Owner) => {
    const s = states.get(o.id) ?? 'run'
    const [ic, icol] = s === 'run' ? [spin, ACCENT] : DOT[s] ?? DOT.done!
    const pct = I.window > 0 ? o.ctx / I.window : 0
    const pcol = pct > 0.75 ? C.red : pct > 0.5 ? C.gold : C.green
    const cur = o.steps.at(-1)
    const rows = [
      line(els, [[ic + ' ', icol], [fit(o.label, Math.max(4, cw - 2)), I.colorOf(o), 'b']]),
      line(els, [
        [prettyModel(o.model), modelColor(o.model)],
        [' ' + (o.type.replace('general-purpose', 'general') || 'agent'), C.gray],
        [' ' + (pct * 100).toFixed(0) + '%', pcol, 'b'],
        [' ' + fmtCost(I.cost(o)), C.light],
        [' ' + mmss(now - (o.first || now)), C.dark],
      ]),
      line(els, [[cur ? `${LABEL[cur.tag] ?? 'Working'}: ${brief(cur)}` : 'Starting…', C.light, 'b']]),
      ...o.steps.slice(-1 - RECENT, -1).map(st => line(els, [
        [st.err ? '✕ ' : '● ', st.err ? C.red : TAG[st.tag] ?? C.gray],
        [brief(st), st.err ? C.red : C.gray],
      ])),
    ]
    return <Box flexDirection="column" width={cw} height={I.height} overflow="hidden">{rows}</Box>
  }

  const bar = (
    <Box flexDirection="column" width={1} height={I.height}>
      {Array.from({ length: I.height }, () => <Text mono color={C.track}>│</Text>)}
    </Box>
  )
  const cols = shown.flatMap((o, i) => (i ? [bar, column(o)] : [column(o)]))
  return {
    max: 0,
    el: (
      <Box flexDirection="column" width={I.width} height={I.height} overflow="hidden">
        <Box flexDirection="row" width={I.width} height={more ? I.height - 1 : I.height}>{cols}</Box>
        {more > 0 && line(els, [[`+${more} more running`, C.gray, 'i']])}
      </Box>
    ),
  }
}
