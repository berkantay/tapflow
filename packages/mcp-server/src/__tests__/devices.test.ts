import { describe, it, expect, vi } from 'vitest'
import type { Device } from '@tapflowio/agent-core'
import type { Simulator } from '@tapflowio/ios-agent'
import { DeviceContext } from '../devices.js'

const dev = (id: string, status: Device['status'] = 'shutdown'): Device => ({ id, name: id, platform: 'ios', status })

function context(devices: Device[], defaultDevice?: string) {
  const create = vi.fn((udid: string) => ({ udid, close: vi.fn() }) as unknown as Simulator)
  const ctx = new DeviceContext({
    defaultDevice,
    list: async () => devices,
    find: async (q) => { const d = devices.find((x) => x.id === q); if (!d) throw new Error(`no ${q}`); return d },
    create,
  })
  return { ctx, create }
}

describe('DeviceContext', () => {
  it('uses the only booted simulator when nothing is named', async () => {
    const { ctx } = context([dev('A'), dev('B', 'booted')])
    expect((await ctx.resolve()).udid).toBe('B')
  })

  it('refuses to guess between several booted simulators', async () => {
    const { ctx } = context([dev('A', 'booted'), dev('B', 'booted')])
    await expect(ctx.resolve()).rejects.toThrow(/2 simulators are booted/)
  })

  it('prefers the configured default over the booted one', async () => {
    const { ctx } = context([dev('A'), dev('B', 'booted')], 'A')
    expect((await ctx.resolve()).udid).toBe('A')
  })

  it('remembers the device last named and reuses its instance', async () => {
    const { ctx, create } = context([dev('A', 'booted'), dev('B', 'booted')])
    const first = await ctx.resolve('A')
    expect(await ctx.resolve()).toBe(first)
    expect(create).toHaveBeenCalledTimes(1)
  })
})
