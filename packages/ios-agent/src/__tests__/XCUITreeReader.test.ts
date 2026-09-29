import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { XCUITreeReader, type RunnerNative } from '../XCUITreeReader'

// A fake child process with no real pid, so killHandle never touches a real OS
// process group (it falls back to proc.kill()).
function fakeProc() {
  const p = new EventEmitter() as EventEmitter & { pid?: number; exitCode: number | null; killed: boolean; kill: () => boolean }
  p.pid = undefined
  p.exitCode = null
  p.killed = false
  p.kill = vi.fn(() => { p.killed = true; return true })
  return p
}

const TREE = [
  "Attributes: Application, 0x1, pid: 1, label: 'App'",
  'Element subtree:',
  " →Application, 0x1, pid: 1, label: 'App'",
  '    Window (Main), 0x2, {{0.0, 0.0}, {100.0, 200.0}}',
  "      Button, 0x3, {{0.0, 0.0}, {50.0, 20.0}}, identifier: 'ok', label: 'OK'",
].join('\n')

let nextPort = 30000

function makeNative(overrides: Partial<RunnerNative> = {}): RunnerNative & {
  spawn: ReturnType<typeof vi.fn>
  terminateHost: ReturnType<typeof vi.fn>
  build: ReturnType<typeof vi.fn>
} {
  return {
    xctestrunReady: () => true, // skip the build
    build: vi.fn(async () => {}),
    spawn: vi.fn(() => fakeProc()),
    terminateHost: vi.fn(),
    terminateRunner: vi.fn(async () => {}),
    freePort: vi.fn(async () => nextPort++),
    ...overrides,
  } as RunnerNative & { spawn: ReturnType<typeof vi.fn>; terminateHost: ReturnType<typeof vi.fn>; build: ReturnType<typeof vi.fn> }
}

describe('XCUITreeReader', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) =>
      url.includes('/health')
        ? ({ ok: true } as Response)
        : ({ ok: true, text: async () => TREE } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('spawns the runner once and returns parsed elements', async () => {
    const native = makeNative()
    const reader = new XCUITreeReader(native)
    const els = await reader.read('udid-A', 'com.app')
    expect(native.spawn).toHaveBeenCalledTimes(1)
    expect(els.find((e) => e.identifier === 'ok')?.label).toBe('OK')
    reader.stop()
  })

  it('serializes concurrent reads into a single spawn (mutex)', async () => {
    const native = makeNative()
    const reader = new XCUITreeReader(native)
    const [a, b] = await Promise.all([reader.read('udid-A', 'com.app'), reader.read('udid-A', 'com.app')])
    expect(native.spawn).toHaveBeenCalledTimes(1)
    expect(a.length).toBe(b.length)
    reader.stop()
  })

  it('rejects a garbage body instead of returning an empty tree', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/health') ? ({ ok: true } as Response) : ({ ok: true, text: async () => '<html>error</html>' } as Response),
    )
    const reader = new XCUITreeReader(makeNative())
    await expect(reader.read('udid-A', 'com.app')).rejects.toThrow(/unexpected response/)
    reader.stop()
  })

  it('stopIfDevice stops only the matching device', async () => {
    const native = makeNative()
    const reader = new XCUITreeReader(native)
    await reader.read('udid-A', 'com.app')
    reader.stopIfDevice('udid-B') // different device → no-op
    expect(native.terminateHost).not.toHaveBeenCalled()
    reader.stopIfDevice('udid-A') // matches → stop
    expect(native.terminateHost).toHaveBeenCalledWith('udid-A')
  })

  it('throws without a bundleId', async () => {
    const reader = new XCUITreeReader(makeNative())
    await expect(reader.read('udid-A', '')).rejects.toThrow(/foreground app/)
  })

  it('clears a runner left on the device before starting its own', async () => {
    const native = makeNative()
    const reader = new XCUITreeReader(native)
    await reader.read('udid-A', 'com.app')
    expect(native.terminateRunner).toHaveBeenCalledWith('udid-A')
    reader.stop()
  })

  it('types text through the runner, percent-encoding it', async () => {
    const native = makeNative()
    const reader = new XCUITreeReader(native)
    await reader.type('udid-A', 'com.app', 'a&b ü')
    const url = fetchMock.mock.calls.map((c) => c[0] as string).find((u) => u.includes('/type'))
    expect(url).toContain('bundleId=com.app')
    expect(url).toContain(`text=${encodeURIComponent('a&b ü')}`)
    reader.stop()
  })

  it('reports the runner\'s error body when a command is refused', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/health')
        ? ({ ok: true } as Response)
        : ({ ok: false, status: 409, text: async () => 'no element has keyboard focus' } as Response),
    )
    const native = makeNative()
    const reader = new XCUITreeReader(native)
    await expect(reader.key('udid-A', 'com.app', 'return')).rejects.toThrow(/keyboard focus/)
    reader.stop()
  })

  it('runs one runner per device, each on its own port, at the same time', async () => {
    const native = makeNative()
    const reader = new XCUITreeReader(native)
    await Promise.all([reader.read('udid-A', 'com.app'), reader.read('udid-B', 'com.app')])
    expect(native.spawn).toHaveBeenCalledTimes(2)
    const ports = native.spawn.mock.calls.map((c) => c[1])
    expect(new Set(ports).size).toBe(2)
    const treeUrls = fetchMock.mock.calls.map((c) => c[0] as string).filter((u) => u.includes('/tree'))
    expect(treeUrls.some((u) => u.includes(`:${ports[0]}/`))).toBe(true)
    expect(treeUrls.some((u) => u.includes(`:${ports[1]}/`))).toBe(true)
    // A second read on either device reuses its runner.
    await reader.read('udid-A', 'com.app')
    expect(native.spawn).toHaveBeenCalledTimes(2)
    reader.stop()
  })

  it('stopping one device leaves the other device\'s runner running', async () => {
    const native = makeNative()
    const reader = new XCUITreeReader(native)
    await reader.read('udid-A', 'com.app')
    await reader.read('udid-B', 'com.app')
    reader.stopIfDevice('udid-A')
    await reader.read('udid-B', 'com.app')
    expect(native.spawn).toHaveBeenCalledTimes(2)
    await reader.read('udid-A', 'com.app')
    expect(native.spawn).toHaveBeenCalledTimes(3)
    reader.stop()
  })

  it('gives each run its own result bundle', async () => {
    const native = makeNative()
    const reader = new XCUITreeReader(native)
    await Promise.all([reader.read('udid-A', 'com.app'), reader.read('udid-B', 'com.app')])
    const bundles = native.spawn.mock.calls.map((c) => c[2] as string)
    expect(bundles[0]).not.toBe(bundles[1])
    reader.stop()
  })
})
