import { describe, it, expect, vi } from 'vitest'
import { PlatformError, ValidationError } from '@tapflowio/agent-core'
import type { Simulator } from '@tapflowio/ios-agent'
import { SimulatorDriver } from '../SimulatorDriver'
import { TransientQueryError, isEnvironmentStepFailure } from '../errors'

function sim(overrides: Partial<Record<keyof Simulator, unknown>> = {}) {
  return {
    uiTree: vi.fn(async () => []),
    tap: vi.fn(async () => {}),
    swipe: vi.fn(async () => {}),
    typeText: vi.fn(async () => {}),
    pressKey: vi.fn(async () => {}),
    openUrl: vi.fn(async () => {}),
    launch: vi.fn(async () => {}),
    clearAppData: vi.fn(async () => {}),
    screenshot: vi.fn(async () => Buffer.alloc(0)),
    ...overrides,
  } as unknown as Simulator & Record<string, ReturnType<typeof vi.fn>>
}

describe('SimulatorDriver', () => {
  it('reads the tree and types for the flow app', async () => {
    const s = sim()
    const d = new SimulatorDriver(s, 'com.example.app')
    await d.queryUITree()
    await d.inputText('hi')
    await d.launchApp()
    expect(s.uiTree).toHaveBeenCalledWith('com.example.app')
    expect(s.typeText).toHaveBeenCalledWith('hi', 'com.example.app')
    expect(s.launch).toHaveBeenCalledWith('com.example.app')
  })

  it('turns an app not yet in the foreground into a transient query failure', async () => {
    const s = sim({ uiTree: vi.fn(async () => { throw new PlatformError('tree runner returned an unexpected response for x') }) })
    await expect(new SimulatorDriver(s, 'x').queryUITree()).rejects.toBeInstanceOf(TransientQueryError)
  })

  it('marks simulator faults as environment failures', async () => {
    const s = sim({ tap: vi.fn(async () => { throw new PlatformError('Input channel to U did not become ready') }) })
    const err = await new SimulatorDriver(s, 'x').tap(0.5, 0.5).catch((e) => e)
    expect(isEnvironmentStepFailure(err)).toBe(true)
  })

  it('keeps flow mistakes as product failures', async () => {
    const focus = sim({ typeText: vi.fn(async () => { throw new PlatformError('type text failed: no element has keyboard focus') }) })
    const key = sim({ pressKey: vi.fn(async () => { throw new ValidationError('Unknown key: F13') }) })
    expect(isEnvironmentStepFailure(await new SimulatorDriver(focus, 'x').inputText('a').catch((e) => e))).toBe(false)
    expect(isEnvironmentStepFailure(await new SimulatorDriver(key, 'x').pressKey('F13').catch((e) => e))).toBe(false)
  })

  it('needs an appId to launch or read', async () => {
    const err = await new SimulatorDriver(sim()).launchApp().catch((e) => e)
    expect(err.message).toMatch(/appId/)
    expect(isEnvironmentStepFailure(err)).toBe(true)
  })
})
