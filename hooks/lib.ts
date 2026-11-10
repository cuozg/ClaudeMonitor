// Pure helpers: pricing, formatting, tool labels, report summaries.
import type { Owner, Tok } from '../types'

// ── Colors (xterm-256 of v1, as hex) ─────────────────────────────────────────
export const C = {
  purple: '#af87ff', green: '#87d787', orange: '#ff875f', blue: '#5fafff', gold: '#ffd75f',
  pink: '#ff87d7', cyan: '#5fd7d7', red: '#ff5f5f', light: '#bcbcbc', gray: '#8a8a8a',
  dark: '#585858', track: '#3a3a3a', frame: '#444444',
} as const
export const LANE = [C.orange, C.blue, C.green, C.pink, C.cyan, C.gold]
const FAMILY: Record<string, string> = { opus: C.purple, sonnet: C.orange, haiku: C.blue, fable: C.gold, mythos: C.gold }

export const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
export const PIE = '◐◓◑◒'
const SPARK = '▁▂▃▄▅▆▇█'
export const STALL_MS = 180_000

// ── Pricing ($ / MTok): input, output, cache read (null = 10% of input) ──────
// Cache write is 1.25x input. Used to split the engine's exact total by kind and owner.
const PRICES: Record<string, [number, number, number | null]> = {
  'fable-5-1': [10, 50, 0.25], 'mythos-5-1': [10, 50, 0.25], 'fable-5': [10, 50, null],
  'opus-5-5': [4, 20, 0.2], 'opus-5': [5, 25, null], 'opus-4': [5, 25, null],
  'sonnet-5-5': [2, 10, 0.1], 'sonnet-5': [2, 10, null], 'sonnet-4': [3, 15, null],
  'haiku-5-5': [0.1, 0.5, null], 'haiku-4': [1, 5, null],
}
const MODEL_RE = /(opus|sonnet|haiku|fable|mythos)((?:-\d{1,2}(?!\d))*)/

export type Rates = { in: number; out: number; cr: number; cw: number }

export function rates(model: string): Rates {
  const m = MODEL_RE.exec(model || '')
  let key = m ? m[1]! + m[2]! : ''
  while (key && !(key in PRICES)) key = key.includes('-') ? key.slice(0, key.lastIndexOf('-')) : ''
  const [i, o, cr] = PRICES[key] ?? PRICES['opus-5-5']!
  return { in: i, out: o, cr: cr ?? i * 0.1, cw: i * 1.25 }
}

export function prettyModel(model: string): string {
  const m = MODEL_RE.exec(model || '')
  if (!m) return model || '—'
  const ver = m[2]!.split('-').filter(Boolean).join('.')
  return (m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1) + ' ' + ver).trim()
}

export function modelColor(model: string): string {
  const m = MODEL_RE.exec(model || '')
  return (m && FAMILY[m[1]!]) || C.cyan
}

export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

/** Prices one response: its tokens and dollars by kind, and what it would cost uncached. */
export function price(model: string, u: Usage): { tok: Tok; usd: Tok; nocache: number } {
  const r = rates(model)
  const tok = { in: u.input_tokens || 0, cw: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0, out: u.output_tokens || 0 }
  const usd = { in: (tok.in * r.in) / 1e6, cw: (tok.cw * r.cw) / 1e6, cr: (tok.cr * r.cr) / 1e6, out: (tok.out * r.out) / 1e6 }
  const nocache = ((tok.in + tok.cw + tok.cr) * r.in + tok.out * r.out) / 1e6
  return { tok, usd, nocache }
}

export const zero = (): Tok => ({ in: 0, cw: 0, cr: 0, out: 0 })
export const addTok = (a: Tok, b: Tok): Tok => ({ in: a.in + b.in, cw: a.cw + b.cw, cr: a.cr + b.cr, out: a.out + b.out })
export const sumTok = (t: Tok) => t.in + t.cw + t.cr + t.out
export const hitRate = (t: Tok) => {
  const side = t.in + t.cw + t.cr
  return side ? t.cr / side : 0
}

export function newOwner(id: string, label: string): Owner {
  return {
    id, label, type: '', model: '', effort: '', background: false, tok: zero(), usd: zero(), nocache: 0, ctx: 0,
    nTools: 0, first: 0, last: 0, act: [], errs: [], flights: [], steps: [], action: '', say: '', sayTs: 0, report: '',
  }
}

// ── Formatting ───────────────────────────────────────────────────────────────
export function fmtTok(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return n >= 1e5 ? (n / 1e3).toFixed(0) + 'k' : (n / 1e3).toFixed(1) + 'k'
  return String(Math.trunc(n))
}
export const fmtCost = (x: number) => (x > 0 && x < 0.01 ? '<$0.01' : '$' + x.toFixed(2))
export function fmtRate(x: number): string {
  if (x === Math.trunc(x)) return '$' + x
  const s = x.toFixed(3).replace(/0+$/, '')
  return '$' + (s.split('.')[1]!.length < 2 ? s + '0' : s)
}
export function fmtDur(ms: number): string {
  let s = Math.trunc(Math.max(0, ms) / 1000)
  if (s < 60) return s + 's'
  let m = Math.trunc(s / 60)
  s %= 60
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`
  const h = Math.trunc(m / 60)
  m %= 60
  return `${h}h ${String(m).padStart(2, '0')}m`
}
export function hhmmss(ts: number): string {
  if (!ts) return '--:--:--'
  const d = new Date(ts)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}
export function fit(s: string, w: number): string {
  if (w <= 0) return ''
  const chars = Array.from(s)
  return chars.length <= w ? s : chars.slice(0, Math.max(0, w - 1)).join('') + '…'
}
export const vlen = (s: string) => Array.from(s).length

/** A bar `w` cells wide, filled to `frac`: the filled part and the rest. */
export function bar(frac: number, w: number): [string, string] {
  const f = Math.max(0, Math.min(1, frac))
  const eighths = Math.round(f * w * 8)
  const full = Math.trunc(eighths / 8)
  const rem = eighths % 8
  const s = '█'.repeat(full) + (rem ? '▏▎▍▌▋▊▉'[rem - 1]! : '')
  return [s, '█'.repeat(Math.max(0, w - vlen(s)))]
}

export function sparkline(values: number[]): { ch: string; on: boolean }[] {
  const top = Math.max(0, ...values)
  return values.map(v => (top > 0 && v > 0 ? { ch: SPARK[Math.min(7, Math.trunc((v / top) * 7.999))]!, on: true } : { ch: SPARK[0]!, on: false }))
}

// ── Text from the transcript ─────────────────────────────────────────────────
export function firstLine(text: unknown, limit = 200): string {
  for (const raw of String(text ?? '').split('\n')) {
    const ln = raw.trim().replace(/^[*#>`]+|[*#>`]+$/g, '').trim()
    if (ln) return ln.slice(0, limit)
  }
  return ''
}

/** The most telling line of a report: a STATUS line, else the first substantial one. */
export function summaryLine(text: unknown, limit = 200): string {
  const body = String(text ?? '').split('The report follows:').pop() ?? ''
  const keys: Record<string, string> = {}
  for (const m of body.matchAll(/^\s{0,4}([A-Za-z_]{3,20}):[ \t]*(.*)$/gm)) keys[m[1]!.toUpperCase()] = m[2]!.trim().replace(/^"|"$/g, '')
  if (keys.STATUS && Object.keys(keys).length >= 3) {
    const bits = [keys.STATUS]
    const files = keys.FILES_CHANGED ?? ''
    if (files.startsWith('[')) {
      const n = files.replace(/[[\]]/g, '').split(',').filter(x => x.trim()).length
      bits.push(`${n} file${n === 1 ? '' : 's'}`)
    }
    if (keys.ATTEMPTS) bits.push('attempts ' + keys.ATTEMPTS)
    for (const k of ['SUMMARY', 'RESULT', 'ROOT_CAUSE', 'VERDICT', 'NOTE', 'BLOCKER', 'REASON']) {
      if (keys[k]) {
        bits.push(k.toLowerCase().replace('_', ' ') + ': ' + keys[k])
        break
      }
    }
    return bits.join(' · ').slice(0, limit)
  }
  const lines = body
    .split('\n')
    .filter(ln => !ln.trim().startsWith('```'))
    .map(ln => ln.replace(/\*\*/g, '').trim().replace(/^[*#>`\- ]+|[*#>`\- ]+$/g, '').trim())
    .filter(Boolean)
  for (let i = 0; i < lines.length; i++) {
    if (/^\W*status\b/i.test(lines[i]!)) {
      const more = lines.slice(i + 1).find(x => x.length >= 25)
      return (lines[i] + (more ? ' · ' + more : '')).slice(0, limit)
    }
  }
  return (lines.find(ln => ln.length >= 25) ?? lines.at(-1) ?? '').slice(0, limit)
}

const base = (p: unknown) => (p ? String(p).split('/').pop() || 'file' : 'file')

/** A short label for a tool call and its log tag. */
export function describeTool(name: string, inp: Record<string, unknown>): [string, string] {
  const file = () => base(inp.file_path ?? inp.path ?? inp.notebook_path)
  switch (name) {
    case 'Read': return ['read ' + file(), 'read']
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return ['edit ' + file(), 'edit']
    case 'Write': return ['write ' + file(), 'edit']
    case 'Bash': return ['$ ' + firstLine(inp.description ?? inp.command ?? ''), 'bash']
    case 'Grep': case 'Glob': return [name.toLowerCase() + ' ' + String(inp.pattern ?? ''), 'search']
    case 'Skill': return ['skill ' + String(inp.skill ?? inp.name ?? ''), 'skill']
    case 'Agent': case 'Task': return ['delegate → ' + String(inp.description ?? inp.subagent_type ?? 'agent'), 'delegate']
    case 'Monitor': return ['monitor ' + String(inp.description ?? ''), 'monitor']
    case 'TaskStop': return ['stop task ' + String(inp.task_id ?? inp.shell_id ?? ''), 'stop']
    case 'WebFetch': return ['fetch ' + String(inp.url ?? '').replace(/^https?:\/\//, '').split('/')[0], 'web']
    case 'WebSearch': return ['search ' + String(inp.query ?? ''), 'web']
    case 'TodoWrite': return ['update todos', 'plan']
  }
  if (name.startsWith('mcp__')) return ['mcp ' + name.split('__').slice(1, 3).join('·'), 'mcp']
  return [name, 'tool']
}

/** Lines added and removed by an edit-like tool call. */
export function lineDelta(name: string, inp: Record<string, unknown>): [number, number] {
  const n = (v: unknown) => (typeof v === 'string' && v ? v.split('\n').length : 0)
  if (name === 'Edit') return [n(inp.new_string), n(inp.old_string)]
  if (name === 'Write') return [n(inp.content), 0]
  if (name === 'MultiEdit' && Array.isArray(inp.edits)) {
    return (inp.edits as Record<string, unknown>[]).reduce<[number, number]>((a, e) => [a[0] + n(e.new_string), a[1] + n(e.old_string)], [0, 0])
  }
  return [0, 0]
}

/** Each `<task-notification>` block of a delivered message. */
export function taskNotes(text: string): { id: string; status: string; summary: string; event: string }[] {
  const tag = (b: string, t: string) => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(b)?.[1]?.trim() ?? ''
  return [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)]
    .map(m => m[1]!)
    .map(b => ({ id: tag(b, 'task-id'), status: tag(b, 'status'), summary: tag(b, 'summary'), event: tag(b, 'event') }))
    .filter(n => n.id)
}

/** The skill, plugin and MCP server a tool call belongs to, if any. */
export function sourcesOf(tool: string, inp: Record<string, unknown>): { skill?: string; plugin?: string; mcp?: string } {
  if (tool === 'Skill' && inp.skill) {
    const skill = String(inp.skill).replace(/^\//, '')
    return { skill, plugin: skill.includes(':') ? skill.split(':')[0] : undefined }
  }
  if (tool.startsWith('mcp__')) {
    const server = tool.split('__')[1] ?? ''
    const plug = /^plugin_(.+?)_/.exec(server)?.[1]
    return { mcp: plug ? server.replace(/^plugin_.+?_/, '') || server : server, plugin: plug }
  }
  return {}
}
