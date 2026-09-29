import { describe, it, expect, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Device, UIElement } from '@tapflowio/agent-core'
import type { Simulator } from '@tapflowio/ios-agent'
import { registerTools } from '../tools.js'
import { DeviceContext } from '../devices.js'

type ToolResult = { content: Array<{ type: string; text?: string; mimeType?: string }>; isError?: boolean }
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>

const el = (role: UIElement['role'], label: string, x = 0.1, identifier?: string): UIElement =>
  ({ role, label, identifier, enabled: true, frame: { x, y: 0.2, width: 0.2, height: 0.1 } })

function fakeSim(tree: UIElement[] = []) {
  return {
    udid: 'UDID-1',
    boot: vi.fn(async () => ({ id: 'UDID-1', name: 'iPhone', platform: 'ios', status: 'booted', osVersion: 'iOS 26.0' })),
    uiTree: vi.fn(async () => tree),
    tap: vi.fn(async () => {}),
    screenshot: vi.fn(async () => {
      const buf = Buffer.alloc(32)
      buf.writeUInt32BE(0x89504e47, 0); buf.writeUInt32BE(0x0d0a1a0a, 4)
      buf.writeUInt32BE(1206, 16); buf.writeUInt32BE(2622, 20)
      return buf
    }),
    close: vi.fn(),
    recording: false,
    startRecording: vi.fn(async function (this: { recording: boolean }) { this.recording = true }),
    stopRecording: vi.fn(async () => ({ path: '/tmp/r.mp4', actionsPath: '/tmp/r.mp4.actions.json', durationMs: 1200, bytes: 10, actions: [{ t: 300, kind: 'note', text: 'bug here' }] })),
    mark: vi.fn(),
    systemAlert: vi.fn(async (): Promise<{ title: string; elements: UIElement[] } | null> => null),
  }
}

function tools(sim: ReturnType<typeof fakeSim>) {
  const ctx = new DeviceContext({
    list: async () => [{ id: 'UDID-1', name: 'iPhone', platform: 'ios', status: 'booted' } as Device],
    find: async () => ({ id: 'UDID-1', name: 'iPhone', platform: 'ios', status: 'booted' }),
    create: () => sim as unknown as Simulator,
  })
  const handlers = new Map<string, Handler>()
  registerTools({ registerTool: (name: string, _c: unknown, h: Handler) => { handlers.set(name, h) } } as unknown as McpServer, ctx)
  return (name: string, args: Record<string, unknown> = {}) => handlers.get(name)!(args)
}

describe('tap_element', () => {
  it('taps the centre of the single match', async () => {
    const sim = fakeSim([el('button', 'Sign in', 0.4), el('text', 'Welcome')])
    const r = await tools(sim)('tap_element', { text: 'Sign in' })
    expect(r.isError).toBeUndefined()
    expect(sim.tap).toHaveBeenCalledWith(0.5, expect.closeTo(0.25), 'Sign in')
  })

  it('refuses an ambiguous match and names the candidates', async () => {
    const sim = fakeSim([el('button', 'Save', 0.1), el('cell', 'Save draft', 0.5)])
    const r = await tools(sim)('tap_element', { text: 'Sav' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/2 elements matched.*button "Save".*cell "Save draft"/)
    expect(sim.tap).not.toHaveBeenCalled()
  })

  it('picks by role and index when asked', async () => {
    const sim = fakeSim([el('button', 'Save', 0.1), el('cell', 'Save draft', 0.5)])
    await tools(sim)('tap_element', { text: 'Sav', role: 'cell' })
    expect(sim.tap).toHaveBeenCalledWith(0.6, expect.closeTo(0.25), 'Save draft')
  })

  it('reports no match without tapping', async () => {
    const sim = fakeSim([el('button', 'OK')])
    const r = await tools(sim)('tap_element', { id: 'missing' })
    expect(r.isError).toBe(true)
    expect(sim.tap).not.toHaveBeenCalled()
  })
})

describe('screenshot', () => {
  it('returns the image and its pixel size', async () => {
    const r = await tools(fakeSim())('screenshot')
    expect(r.content[0].mimeType).toBe('image/png')
    expect(r.content[1].text).toMatch(/1206x2622px/)
  })
})

describe('run_flow', () => {
  it('refuses a path outside the working directory', async () => {
    const r = await tools(fakeSim())('run_flow', { path: '/etc/passwd' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/must be inside/)
  })

  it('needs exactly one of flow or path', async () => {
    const r = await tools(fakeSim())('run_flow', {})
    expect(r.isError).toBe(true)
  })
})

describe('errors', () => {
  it('turns a simulator failure into a tool error', async () => {
    const sim = fakeSim()
    sim.tap.mockRejectedValueOnce(new Error('input channel unavailable'))
    const r = await tools(sim)('tap', { x: 0.5, y: 0.5 })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe('tap failed: input channel unavailable')
  })
})

describe('recording tools', () => {
  it('refuses a mark or stop while not recording', async () => {
    const run = tools(fakeSim())
    expect((await run('mark_recording', { text: 'x' })).isError).toBe(true)
    expect((await run('stop_recording')).isError).toBe(true)
  })

  it('records, marks, and returns the video with its timeline', async () => {
    const sim = fakeSim()
    const run = tools(sim)
    expect((await run('start_recording', { path: '/tmp/r.mp4' })).content[0].text).toBe('Recording to /tmp/r.mp4')
    await run('mark_recording', { text: 'bug here' })
    expect(sim.mark).toHaveBeenCalledWith({ kind: 'note', text: 'bug here' })
    const out = JSON.parse((await run('stop_recording', { export: false })).content[0].text!)
    expect(out).toMatchObject({ video: '/tmp/r.mp4', durationMs: 1200, timeline: '0:00.3  bug here' })
    expect(out.shareable).toBeUndefined()
  })

  it('passes the tapped element\'s label to the recording', async () => {
    const sim = fakeSim([el('button', 'Sign in', 0.4)])
    await tools(sim)('tap_element', { text: 'Sign in' })
    expect(sim.tap).toHaveBeenCalledWith(0.5, expect.closeTo(0.25), 'Sign in')
  })
})

describe('tap_element and system alerts', () => {
  const alert = {
    title: 'Open in “Example Dev”?',
    elements: [
      { ...el('button', 'Cancel', 0.15), system: true },
      { ...el('button', 'Open', 0.5), system: true },
    ],
  }

  it('taps a button of the alert covering the app', async () => {
    const sim = fakeSim([el('button', 'Get started')])
    sim.systemAlert.mockResolvedValueOnce(alert)
    const r = await tools(sim)('tap_element', { label: 'Open' })
    expect(r.content[0].text).toBe('Tapped system alert button "Open"')
    expect(sim.tap).toHaveBeenCalledWith(0.6, expect.closeTo(0.25), 'Open')
    expect(sim.uiTree).not.toHaveBeenCalled()
  })

  it('names the alert and its buttons instead of tapping underneath it', async () => {
    const sim = fakeSim([el('button', 'Get started')])
    sim.systemAlert.mockResolvedValueOnce(alert)
    const r = await tools(sim)('tap_element', { text: 'Get started' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/system alert is covering the app \("Open in “Example Dev”\?"\); its buttons are "Cancel", "Open"/)
    expect(sim.tap).not.toHaveBeenCalled()
  })

  it('treats label as exact: "Open" does not tap "Open React Native dev menu"', async () => {
    const sim = fakeSim([el('button', 'Open React Native dev menu')])
    const r = await tools(sim)('tap_element', { label: 'Open' })
    expect(r.isError).toBe(true)
    expect(sim.tap).not.toHaveBeenCalled()
  })

  it('reports the alert in query_ui_tree', async () => {
    const sim = fakeSim([el('button', 'Get started')])
    sim.systemAlert.mockResolvedValueOnce(alert)
    const out = JSON.parse((await tools(sim)('query_ui_tree')).content[0].text!)
    expect(out.systemAlert).toEqual({ title: 'Open in “Example Dev”?', buttons: ['Cancel', 'Open'] })
  })
})
