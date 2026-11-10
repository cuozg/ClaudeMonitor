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
function engine(on: On, { usage = USAGE as object, agents = true, panes = true } = {}) {
  mock.clock(on, { now: USAGE.startedAt + 60_000 })
  on('command.register', () => ({ value: { command: 'monitor' } }))
  if (panes) {
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.panes', () => ({ value: [] }))
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: usage as typeof USAGE }))
  on('session.cwd', () => ({ value: '/Users/me/shop' }))
  on('session.id', () => ({ value: 'abcdef1234567890' }))
  on('env.get', () => ({ value: '/Users/me' }))
  on('agent.list', () => ({ value: agents ? [{ id: 'ag1', description: 'review code', type: 'Explore', status: 'running' as const }] : [] }))
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'ag1' }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId, index: e.index, answer: 'Looking at the cart code now', toolUses: [], stopReason: 'end_turn' as const,
      usage: { model: 'claude-opus-5-5', input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0 },
    }
  })
}

test('the pane shows the bill, context, agents and log on every surface', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/Users/me/shop', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/Users/me/shop/cart.ts' })
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'review', description: 'review code', subagentType: 'Explore', provider: { plugin: 'engine' }, parentModel: 'claude-opus-5-5', background: false, fork: false } as never)
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) void _

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /CLAUDE CODE MONITOR/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\$1\.50$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /read cart\.ts/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /review code/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Looking at the cart code/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h limit/ })).toBeDefined()
    await ui.unmount()
  }
})

test('an empty session draws without data', async ($, on) => {
  engine(on, { usage: { ...USAGE, cost: undefined, rateLimits: [] }, agents: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 40 } })
  expect(await ui.find({ type: 'Text', text: /no subagents spawned yet/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /IDLE/ })).toBeDefined()
  await ui.unmount()
})

const RUN = { command: 'monitor', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as never

test('/monitor toggles the pane', async ($, on) => {
  engine(on, { panes: false })
  let open = false
  on('ui.open', () => ((open = true), { value: { isPlaced: true } }))
  on('ui.close', () => ((open = false), { value: undefined }))
  on('ui.panes', () => ({ value: open ? [{ id: 'session-monitor', title: 'Monitor', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  await $.session.start({ cwd: '/Users/me/shop', surface: 'terminal', isInteractive: true })
  expect(open).toBe(true)
  const closed = await $.command.run(RUN)
  expect(closed.text).toBe('Monitor closed.')
  expect(open).toBe(false)
  const opened = await $.command.run(RUN)
  expect(opened.text).toBe('Monitor opened.')
  expect(open).toBe(true)
})
