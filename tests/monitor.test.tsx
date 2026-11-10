import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'session-monitor',
  component: 'Pane',
  requestId: 'session-monitor',
  props: {
    title: 'Monitor',
    isFocused: false,
    bodyColumns: 90,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const USAGE = {
  startedAt: 1_700_000_000_000,
  context: { tokens: 52_000, window: 1_000_000, percent: 5 },
  rateLimits: [{ kind: 'five_hour', percentUsed: 42 }],
  cost: { usd: 1.5 },
}

/** Stands in for the engine beneath the mod. */
function engine(on: On, { usage = USAGE as object, agents = true as boolean | (() => object[]), panes = true } = {}) {
  const clock = mock.clock(on, { now: USAGE.startedAt + 60_000 })
  on('command.register', () => ({ value: { command: 'monitor' } }))
  if (panes) {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.panes', () => ({ value: [] }))
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: usage as typeof USAGE }))
  on('session.surfaces', () => ({ value: ['terminal'] as const }))
  on('session.cwd', () => ({ value: '/Users/me/shop' }))
  on('session.id', () => ({ value: 'abcdef1234567890' }))
  on('env.get', () => ({ value: '/Users/me' }))
  on('agent.list', () => ({ value: (typeof agents === 'function' ? agents() : agents ? [{ id: 'ag1', description: 'review code', type: 'Explore', status: 'running' }] : []) as never }))
  on('tool.call', () => ({ result: {} }))
  let spawned = 0
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'ag' + ++spawned }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId, index: e.index, answer: 'Looking at the cart code now', toolUses: [], stopReason: 'end_turn' as const,
      usage: { model: 'claude-opus-5-5', input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0 },
    }
  })
  return clock
}

test('the pane shows the bill, context, agents and log on every surface', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/Users/me/shop', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/Users/me/shop/cart.ts' })
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'review', description: 'review code', subagentType: 'Explore', provider: { plugin: 'engine' }, parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) void _

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^shop$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\$1\.50$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /read cart\.ts/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Looking at the cart code/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h limit/ })).toBeDefined()
    await ui.unmount()
  }
})

test('an empty session draws without data', async ($, on) => {
  engine(on, { usage: { ...USAGE, cost: undefined, rateLimits: [] }, agents: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 40 } })
  expect(await ui.find({ type: 'Text', text: /Idle/ })).toBeDefined()
  await ui.unmount()
})

test('the header pill follows the main state, not recent activity', async ($, on) => {
  engine(on, { agents: false })
  await $.session.start({ cwd: '/Users/me/shop', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/Users/me/shop/cart.ts' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Idle/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Working/ })).toBeUndefined()
  await ui.unmount()
})

test('what needs attention is highlighted in the pane, not in the band', async ($, on) => {
  engine(on, { usage: { ...USAGE, rateLimits: [{ kind: 'five_hour', percentUsed: 92 }] }, agents: false, panes: false })
  on('ui.panes', () => ({ value: [] }))
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /Needs attention/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /5h limit at 92%/ })).toBeDefined()
  await pane.unmount()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /⚠/ })).toBeUndefined()
  await band.unmount()
})

test('a calm session shows no attention box', async ($, on) => {
  engine(on, { agents: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Needs attention/ })).toBeUndefined()
  await ui.unmount()
})

test('the band shows the same context percent as the pane', async ($, on) => {
  engine(on, { usage: { ...USAGE, context: { ...USAGE.context, percent: 9 } }, agents: false })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /^5%$/ })).toBeDefined()
  await pane.unmount()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: / 5%$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: / 9%$/ })).toBeUndefined()
  await band.unmount()
})

const RUN = { command: 'monitor', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as never

test('/monitor toggles the pane', async ($, on) => {
  engine(on, { panes: false })
  let open = false
  on('ui.close', () => ((open = false), { value: undefined }))
  on('ui.panes', () => ({ value: open ? [{ id: 'session-monitor', title: 'Monitor', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  let fill: string | undefined
  on('ui.open', (_, e) => ((open = true), (fill = e.backgroundColor), { value: { isPlaced: true } }))
  await $.session.start({ cwd: '/Users/me/shop', surface: 'terminal', isInteractive: true })
  expect(open).toBe(true)
  expect(fill).toBe('transparent')
  const closed = await $.command.run(RUN)
  expect(closed.text).toBe('Monitor closed.')
  expect(open).toBe(false)
  const opened = await $.command.run(RUN)
  expect(opened.text).toBe('Monitor opened.')
  expect(open).toBe(true)
})

const BAND = {
  plugin: 'session-monitor',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('the band above the prompt shows figures and toggles the pane', async ($, on) => {
  engine(on, { panes: false })
  let open = true
  on('ui.open', () => ((open = true), { value: { isPlaced: true } }))
  on('ui.close', () => ((open = false), { value: undefined }))
  on('ui.panes', () => ({ value: open ? [{ id: 'session-monitor', title: 'Monitor', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  for (const surface of ['terminal', 'desktop'] as const) {
    open = true
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /\$1\.50/ })).toBeDefined()
    expect((await ui.find({ key: 'toggle' }))?.text).toMatch(/Hide monitor/)
    await ui.press({ key: 'toggle' })
    expect(open).toBe(false)
    await ui.press({ key: 'toggle' })
    expect(open).toBe(true)
    await ui.unmount()
  }
})

test('each subagent gets one flow row in a single column', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/Users/me/shop', surface: 'terminal', isInteractive: true })
  const spawn = (i: number) =>
    $.agent.spawn({ tool_use_id: 'tu' + i, prompt: 'p', description: 'task ' + i, subagentType: 'Explore', provider: { plugin: 'engine' }, parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
  for (let i = 1; i <= 12; i++) {
    await spawn(i)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 200 } })
    for (let j = 1; j <= i; j++) expect(await ui.find({ type: 'Text', text: new RegExp('task ' + j + '\\b') })).toBeDefined()
    await ui.unmount()
  }
})

test('each subagent section lists the steps of its own workflow', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/Users/me/shop', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'p', description: 'worker', subagentType: 'Explore', provider: { plugin: 'engine' }, parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
  await $.tool.call({ tool: 'Read', file_path: '/Users/me/shop/cart.ts', agentId: 'ag1' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/Users/me/shop/pay.ts', old_string: 'a', new_string: 'b\nc', agentId: 'ag1' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 200 } })
  expect(await ui.find({ type: 'Text', text: /cart\.ts/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /pay\.ts/ })).toBeDefined()
  await ui.unmount()
})

test('a hairline separates two subagent sessions, and the band toggles the agents half of the pane', async ($, on) => {
  engine(on, { panes: false })
  let open = false
  on('ui.open', () => ((open = true), { value: { isPlaced: true } }))
  on('ui.close', () => ((open = false), { value: undefined }))
  on('ui.panes', () => ({ value: open ? [{ id: 'session-monitor', title: 'Monitor', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  await $.session.start({ cwd: '/Users/me/shop', surface: 'terminal', isInteractive: true })
  for (const i of [1, 2]) {
    await $.agent.spawn({ tool_use_id: 'tu' + i, prompt: 'p', description: 'job ' + i, subagentType: 'Explore', provider: { plugin: 'engine' }, parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
  }
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 80 } })
  expect(await ui.find({ type: 'Text', text: /^─+$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^shop$/ })).toBeDefined()
  await ui.unmount()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ key: 'agents' }))?.text).toMatch(/Hide agents/)
  await band.press({ key: 'agents' })
  expect(open).toBe(true)
  ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 80 } })
  expect(await ui.find({ type: 'Text', text: /job 1/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^shop$/ })).toBeDefined()
  await ui.unmount()
  await band.unmount()
})

test('the monitor and the subagents share the pane in equal halves', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/Users/me/shop', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'p', description: 'worker', subagentType: 'Explore', provider: { plugin: 'engine' }, parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
  const widths = async (bodyColumns: number) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns } })
    const tree = JSON.stringify(await ui.drawn())
    await ui.unmount()
    return tree
  }
  const wide = await widths(120)
  expect(wide).toContain('"flexDirection":"row-reverse"')
  expect(wide).toContain('"width":60,"height":60')
  const narrow = await widths(80)
  expect(narrow).toContain('"width":80,"height":30')
})

test('the wheel over the subagents scrolls them alone; over the monitor it moves nothing', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/Users/me/shop', surface: 'terminal', isInteractive: true })
  for (let i = 1; i <= 30; i++) {
    await $.agent.spawn({ tool_use_id: 'tu' + i, prompt: 'p', description: 'task ' + i, subagentType: 'Explore', provider: { plugin: 'engine' }, parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
  }
  const props = { ...PANE.props, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 } }
  const draw = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props })
    const top = !!(await ui.find({ type: 'Text', text: /task 1\b/ }))
    const shop = !!(await ui.find({ type: 'Text', text: /^shop$/ }))
    await ui.unmount()
    return { top, shop }
  }
  expect(await draw()).toEqual({ top: true, shop: true })
  const wheel = (column: number, by: number) =>
    $.ui.scroll({ component: 'Pane', requestId: 'session-monitor', offset: 0, by, bodyRows: 20, contentRows: 20, origin: { kind: 'person' }, pointer: { column, row: 3 } } as never)
  await wheel(90, 5)
  expect(await draw()).toEqual({ top: true, shop: true })
  await wheel(10, 5)
  expect(await draw()).toEqual({ top: false, shop: true })
  await wheel(10, -5)
  expect(await draw()).toEqual({ top: true, shop: true })
})

test('a background agent task ends when the engine lists its agent as ended, without a SubagentStop', async ($, on) => {
  let status = 'running'
  const clock = engine(on, { agents: () => [{ id: 'ag1', description: 'audit', type: 'Explore', status }] })
  await $.session.start({ cwd: '/Users/me/shop', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'p', description: 'audit', subagentType: 'Explore', provider: { plugin: 'engine' }, parentModel: 'claude-opus-5-5', background: true, fork: false } as never)
  const tasks = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 80 } })
    const t = (await ui.find({ type: 'Text', text: /^\d+ running$/ }))?.text
    await ui.unmount()
    return t
  }
  expect(await tasks()).toBe('1 running')
  status = 'completed'
  await clock.advance(1000)
  expect(await tasks()).toBe('0 running')
})

test('the band hides the monitor half alone, leaving the subagents in the pane', async ($, on) => {
  engine(on, { panes: false })
  let open = false
  on('ui.open', () => ((open = true), { value: { isPlaced: true } }))
  on('ui.close', () => ((open = false), { value: undefined }))
  on('ui.panes', () => ({ value: open ? [{ id: 'session-monitor', title: 'Monitor', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  await $.session.start({ cwd: '/Users/me/shop', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'p', description: 'job 1', subagentType: 'Explore', provider: { plugin: 'engine' }, parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
  const pane = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 120 } })
    const r = { job: !!(await ui.find({ type: 'Text', text: /job 1/ })), shop: !!(await ui.find({ type: 'Text', text: /^shop$/ })) }
    await ui.unmount()
    return r
  }
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'toggle' })
  expect(open).toBe(true)
  expect(await pane()).toEqual({ job: true, shop: false })
  expect((await band.find({ key: 'toggle' }))?.text).toMatch(/Show monitor/)
  expect((await band.find({ key: 'agents' }))?.text).toMatch(/Hide agents/)
  await band.press({ key: 'toggle' })
  expect(await pane()).toEqual({ job: true, shop: true })
  await band.press({ key: 'toggle' })
  await band.press({ key: 'agents' })
  expect(open).toBe(false)
  await band.press({ key: 'agents' })
  expect(open).toBe(true)
  expect(await pane()).toEqual({ job: true, shop: false })
  await band.unmount()
})
