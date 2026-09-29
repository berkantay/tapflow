import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PlatformError, type Device } from '@tapflowio/agent-core'
import { Simulator } from '../Simulator'
import type { SimctlWrapper } from '../SimctlWrapper'
import type { TouchHelper } from '../TouchHelper'
import type { XCUITreeReader } from '../XCUITreeReader'
import type { LeanStore } from '../LeanStore'

const UDID = 'UDID-1'

function device(overrides: Partial<Device> = {}): Device {
  return { id: UDID, name: 'iPhone 17 Pro', platform: 'ios', status: 'shutdown', osVersion: 'iOS 26.0', ...overrides }
}

function mockSimctl(devices: Device[] = [device()]) {
  return {
    listDevices: vi.fn(async () => devices),
    boot: vi.fn(async () => {}),
    waitUntilBooted: vi.fn(async () => ({ ...devices[0], status: 'booted' })),
    shutdown: vi.fn(async () => {}),
    erase: vi.fn(async () => {}),
    installApp: vi.fn(async () => {}),
    uninstallApp: vi.fn(async () => {}),
    launchApp: vi.fn(async () => 123),
    clearAppData: vi.fn(async () => {}),
    openUrl: vi.fn(async () => {}),
    screenshot: vi.fn(async () => Buffer.from('png')),
    syncKeyboardsFromLanguages: vi.fn(async () => {}),
    rotate: vi.fn(async () => {}),
    showSoftwareKeyboard: vi.fn(async () => {}),
    hideSoftwareKeyboard: vi.fn(async () => {}),
    stopKeyboardDaemon: vi.fn(),
  }
}

function mockTouch(ready = true) {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    isReady: vi.fn(() => ready),
    inputState: vi.fn(() => (ready ? 'ready' : 'starting')),
    touchStart: vi.fn(() => true),
    touchMove: vi.fn(() => true),
    touchEnd: vi.fn(() => true),
    pressButton: vi.fn(() => true),
  }
}

function mockReader() {
  return {
    read: vi.fn(async () => [{ role: 'button', label: 'OK', frame: { x: 0, y: 0, width: 1, height: 1 }, enabled: true }]),
    type: vi.fn(async (_udid: string, _bundleId: string, _text: string) => {}),
    key: vi.fn(async (_udid: string, _bundleId: string, _name: string) => {}),
    stopIfDevice: vi.fn(),
  }
}

function mockLean(applied = false) {
  return { apply: vi.fn(), revert: vi.fn(() => true), isApplied: vi.fn(() => applied) }
}

function build(opts: { devices?: Device[]; ready?: boolean; lean?: boolean; leanApplied?: boolean } = {}) {
  const simctl = mockSimctl(opts.devices)
  const touch = mockTouch(opts.ready ?? true)
  const reader = mockReader()
  const leanStore = mockLean(opts.leanApplied)
  const sim = new Simulator(UDID, {
    simctl: simctl as unknown as SimctlWrapper,
    treeReader: reader as unknown as XCUITreeReader,
    leanStore: leanStore as unknown as LeanStore,
    touchHelper: () => touch as unknown as TouchHelper,
    lean: opts.lean,
  })
  return { sim, simctl, touch, reader, leanStore }
}

describe('Simulator.find', () => {
  const a = device({ id: 'A', name: 'iPhone', status: 'shutdown', osVersion: 'iOS 26.0' })
  const b = device({ id: 'B', name: 'iPhone', status: 'booted', osVersion: 'iOS 27.0' })
  const c = device({ id: 'C', name: 'iPad', status: 'shutdown' })

  it('finds by UDID first', async () => {
    const simctl = mockSimctl([a, b, c])
    expect((await Simulator.find('C', simctl as unknown as SimctlWrapper)).id).toBe('C')
  })

  it('prefers the booted device when a name is shared', async () => {
    const simctl = mockSimctl([a, b, c])
    expect((await Simulator.find('iPhone', simctl as unknown as SimctlWrapper)).id).toBe('B')
  })

  it('refuses an ambiguous name with no booted match, listing the UDIDs', async () => {
    const simctl = mockSimctl([a, { ...b, status: 'shutdown' }])
    await expect(Simulator.find('iPhone', simctl as unknown as SimctlWrapper)).rejects.toThrow(/matches 2 simulators.*A.*B/)
  })

  it('refuses an unknown name', async () => {
    const simctl = mockSimctl([a])
    await expect(Simulator.find('Pixel', simctl as unknown as SimctlWrapper)).rejects.toThrow(/No simulator/)
  })
})

describe('Simulator.boot', () => {
  it('boots, waits until booted, and starts the touch channel', async () => {
    const { sim, simctl, touch } = build()
    const booted = await sim.boot()
    expect(simctl.boot).toHaveBeenCalledWith(UDID)
    expect(simctl.waitUntilBooted).toHaveBeenCalledWith(UDID)
    expect(booted.status).toBe('booted')
    expect(touch.start).toHaveBeenCalledTimes(1)
  })

  it('shuts a running device down before erasing it', async () => {
    const { sim, simctl } = build({ devices: [device({ status: 'booted' })] })
    await sim.boot({ erase: true })
    const order = [simctl.shutdown, simctl.erase, simctl.boot].map((f) => f.mock.invocationCallOrder[0])
    expect(order).toEqual([...order].sort((x, y) => x - y))
  })

  it('erases and retries once when the device data is missing on disk', async () => {
    const { sim, simctl } = build()
    simctl.boot.mockRejectedValueOnce(Object.assign(new Error('boot failed'), { stderr: 'data is no longer present' }))
    await sim.boot()
    expect(simctl.erase).toHaveBeenCalledTimes(1)
    expect(simctl.boot).toHaveBeenCalledTimes(2)
  })

  it('does not erase on an unrelated boot failure', async () => {
    const { sim, simctl } = build()
    simctl.boot.mockRejectedValueOnce(new Error('timed out'))
    await expect(sim.boot()).rejects.toThrow('timed out')
    expect(simctl.erase).not.toHaveBeenCalled()
  })

  it('applies lean mode to a shut-down device on a supported runtime', async () => {
    const { sim, leanStore } = build({ lean: true })
    await sim.boot()
    expect(leanStore.apply).toHaveBeenCalledWith(UDID, expect.any(Array))
  })

  it('does not apply lean mode below iOS 18.5', async () => {
    const { sim, leanStore } = build({ lean: true, devices: [device({ osVersion: 'iOS 18.4' })] })
    await sim.boot()
    expect(leanStore.apply).not.toHaveBeenCalled()
  })

  it('reverts lean mode left on a device when lean is off', async () => {
    const { sim, leanStore } = build({ leanApplied: true })
    await sim.boot()
    expect(leanStore.revert).toHaveBeenCalledWith(UDID)
  })
})

describe('Simulator input', () => {
  it('taps with a touch start and end', async () => {
    const { sim, touch } = build()
    await sim.tap(0.25, 0.75)
    expect(touch.touchStart).toHaveBeenCalledWith(0.25, 0.75)
    expect(touch.touchEnd).toHaveBeenCalledTimes(1)
  })

  it('reports a refused tap instead of passing silently', async () => {
    const { sim, touch } = build()
    touch.touchEnd.mockReturnValueOnce(false)
    await expect(sim.tap(0.5, 0.5)).rejects.toThrow(/did not accept the tap/)
  })

  it('swipes through interpolated moves and ends at the target', async () => {
    const { sim, touch } = build()
    await sim.swipe([0.5, 0.8], [0.5, 0.2], 16)
    expect(touch.touchStart).toHaveBeenCalledWith(0.5, 0.8)
    expect(touch.touchMove).toHaveBeenLastCalledWith(0.5, 0.2)
    expect(touch.touchMove.mock.calls.length).toBeGreaterThan(2)
    expect(touch.touchEnd).toHaveBeenCalledTimes(1)
  })

  it('waits for the touch channel to become ready', async () => {
    const { sim, touch } = build({ ready: false })
    let calls = 0
    touch.isReady.mockImplementation(() => ++calls > 3)
    await sim.tap(0.5, 0.5)
    expect(touch.touchStart).toHaveBeenCalled()
  })

  it('gives up when the touch channel never becomes ready', async () => {
    vi.useFakeTimers()
    try {
      const { sim } = build({ ready: false })
      const tap = sim.tap(0.5, 0.5)
      const assertion = expect(tap).rejects.toThrow(/did not become ready/)
      await vi.advanceTimersByTimeAsync(6_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('maps hardware buttons to their HID usages', async () => {
    const { sim, touch } = build()
    await sim.pressButton('home')
    await sim.pressButton('lock')
    await sim.pressButton('volume_up')
    expect(touch.pressButton.mock.calls).toEqual([[12, 64], [12, 48], [12, 233]])
  })

  it('rejects an unknown button', async () => {
    const { sim } = build()
    await expect(sim.pressButton('crown')).rejects.toThrow(/Unknown button/)
  })
})

describe('Simulator apps and text', () => {
  let t: ReturnType<typeof build>
  beforeEach(() => { t = build() })

  it('reads the tree of the last launched app', async () => {
    await t.sim.launch('com.example.app')
    await t.sim.uiTree()
    expect(t.reader.read).toHaveBeenCalledWith(UDID, 'com.example.app')
  })

  it('needs an app before reading a tree', async () => {
    await expect(t.sim.uiTree()).rejects.toThrow(/launch one first/)
  })

  it('retries a tree read while the app is still coming to the foreground', async () => {
    await t.sim.launch('com.example.app')
    t.reader.read.mockRejectedValueOnce(new PlatformError('tree runner returned an unexpected response for com.example.app'))
    const tree = await t.sim.uiTree()
    expect(tree).toHaveLength(1)
    expect(t.reader.read).toHaveBeenCalledTimes(2)
  })

  it('does not retry other tree failures', async () => {
    await t.sim.launch('com.example.app')
    t.reader.read.mockRejectedValueOnce(new PlatformError('UI tree query failed: fetch failed'))
    await expect(t.sim.uiTree()).rejects.toThrow(/fetch failed/)
    expect(t.reader.read).toHaveBeenCalledTimes(1)
  })

  it('types through the tree runner for the foreground app', async () => {
    await t.sim.launch('com.example.app')
    await t.sim.typeText('héllo 👋')
    expect(t.reader.type).toHaveBeenCalledWith(UDID, 'com.example.app', 'héllo 👋')
  })

  it('accepts KeyboardEvent.code spellings for keys', async () => {
    await t.sim.launch('com.example.app')
    await t.sim.pressKey('Enter')
    await t.sim.pressKey('Backspace')
    expect(t.reader.key.mock.calls.map((c) => c[2])).toEqual(['return', 'delete'])
  })

  it('rejects an unknown key', async () => {
    await t.sim.launch('com.example.app')
    await expect(t.sim.pressKey('F13')).rejects.toThrow(/Unknown key/)
  })

  it('installs an .app directory directly', async () => {
    await t.sim.install('/builds/My.app')
    expect(t.simctl.installApp).toHaveBeenCalledWith(UDID, '/builds/My.app')
  })

  it('shuts down, releases helpers, and reverts lean mode', async () => {
    const lean = build({ leanApplied: true })
    await lean.sim.boot()
    await lean.sim.shutdown()
    expect(lean.touch.stop).toHaveBeenCalled()
    expect(lean.reader.stopIfDevice).toHaveBeenCalledWith(UDID)
    expect(lean.simctl.shutdown).toHaveBeenCalledWith(UDID)
    expect(lean.leanStore.revert).toHaveBeenCalled()
  })
})

describe('Simulator recording', () => {
  it('logs actions to the recorder with what was tapped', async () => {
    const recorder = { recording: true, start: vi.fn(async () => {}), stop: vi.fn(), mark: vi.fn(), abort: vi.fn() }
    const simctl = mockSimctl()
    const touch = mockTouch()
    const sim = new Simulator(UDID, {
      simctl: simctl as unknown as SimctlWrapper,
      treeReader: mockReader() as unknown as XCUITreeReader,
      leanStore: mockLean() as unknown as LeanStore,
      touchHelper: () => touch as unknown as TouchHelper,
      recorder: recorder as unknown as import('../Recorder').ScreenRecorder,
    })
    await sim.launch('com.example.app')
    await sim.tap(0.5, 0.5, 'Sign in')
    await sim.pressButton('home')
    expect(recorder.mark.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'launch', bundleId: 'com.example.app' },
      { kind: 'tap', x: 0.5, y: 0.5, label: 'Sign in' },
      { kind: 'button', name: 'home' },
    ])
    sim.close()
    expect(recorder.abort).toHaveBeenCalled()
  })
})
