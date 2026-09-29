import { spawn, execFile, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { readdirSync } from 'fs'
import { join } from 'path'
import type { UIElement } from '@tapflowio/agent-core'
import { createLogger, PlatformError } from '@tapflowio/agent-core'
import { parseTreeText } from './xcuiTree.js'

const logger = createLogger('ios-agent:xcui-tree')
const execFileAsync = promisify(execFile)

const RUNNER_DIR = join(import.meta.dirname, '..', 'xctest-runner')
const PROJECT = join(RUNNER_DIR, 'TapflowTreeRunner.xcodeproj')
const BUILD_DIR = join(RUNNER_DIR, 'build')
const PRODUCTS_DIR = join(BUILD_DIR, 'Build', 'Products')
const SCHEME = 'TreeRunner'
// The in-simulator host app the UI-test runner attaches to. Terminating it ends
// the test session so the HTTP port is released (killing the xcodebuild wrapper
// alone does not tear the in-simulator process down).
const RUNNER_HOST_BUNDLE = 'dev.tapflow.treerunner.host'
const RUNNER_TEST_BUNDLE = 'dev.tapflow.treerunner.uitests.xctrunner'
const STALE_RUNNER_GONE_MS = 10_000
// Fixed port: xcodebuild does not propagate host env to the in-simulator test
// runner, so a per-udid port can't be passed this way. A single resident runner
// (guarded below) means no collision; concurrent multi-device is deferred (Q8).
const PORT = 22087

interface RunnerHandle {
  proc: ChildProcess
  udid: string
  port: number
}

// Native-tooling boundary (xcodebuild/xcrun). Injectable so tests can mock the
// native calls without exercising the runner lifecycle / signal handling.
export interface RunnerNative {
  xctestrunReady(): boolean
  build(destination: string): Promise<void>
  spawn(destination: string, port: number): ChildProcess
  terminateHost(udid: string): void
  /** Terminate any runner already on the device, including one left behind by another process,
   *  and wait until `port` is free. */
  terminateRunner(udid: string, port: number): Promise<void>
}

const defaultNative: RunnerNative = {
  xctestrunReady() {
    // test-without-building needs the .xctestrun, not just the .app — gate on it.
    try {
      return readdirSync(PRODUCTS_DIR).some((f) => f.endsWith('.xctestrun'))
    } catch {
      return false
    }
  },
  async build(destination) {
    await execFileAsync(
      'xcodebuild',
      ['build-for-testing', '-project', PROJECT, '-scheme', SCHEME, '-destination', destination, '-derivedDataPath', BUILD_DIR, '-quiet'],
      { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
    )
  },
  spawn(destination, port) {
    return spawn(
      'xcodebuild',
      ['test-without-building', '-project', PROJECT, '-scheme', SCHEME, '-destination', destination, '-derivedDataPath', BUILD_DIR, '-quiet'],
      { env: { ...process.env, TAPFLOW_TREE_PORT: String(port) }, stdio: 'ignore', detached: true },
    )
  },
  terminateHost(udid) {
    execFile('xcrun', ['simctl', 'terminate', udid, RUNNER_HOST_BUNDLE], () => { /* best-effort */ })
  },
  async terminateRunner(udid, port) {
    for (const bundle of [RUNNER_TEST_BUNDLE, RUNNER_HOST_BUNDLE]) {
      await execFileAsync('xcrun', ['simctl', 'terminate', udid, bundle]).catch(() => { /* not running */ })
    }
    const deadline = Date.now() + STALE_RUNNER_GONE_MS
    while (Date.now() < deadline) {
      try {
        await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(500) })
      } catch {
        return
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new PlatformError(`port ${port} is still held by another UI-tree runner; is another tapflow process driving a simulator?`)
  },
}

// Drives the resident XCUITest tree runner: builds it once, launches it (staying
// resident), and queries GET /tree over the simulator-shared loopback. Replaces
// the AXUIElement path (UITreeReader), which required a Simulator.app window.
export class XCUITreeReader {
  private runner?: RunnerHandle
  private building?: Promise<void>
  private starting?: Promise<RunnerHandle>

  constructor(private readonly native: RunnerNative = defaultNative) {}

  private destination(udid: string): string {
    // No arch — xcodebuild resolves it (arm64 on Apple Silicon, x86_64 on Intel).
    return `platform=iOS Simulator,id=${udid}`
  }

  private async ensureBuilt(udid: string): Promise<void> {
    if (this.native.xctestrunReady()) return
    if (this.building) return this.building
    this.building = (async () => {
      logger.info('building tree runner (first run — cached afterwards)...')
      await this.native.build(this.destination(udid))
      logger.info('tree runner built')
    })()
    try {
      await this.building
    } catch (e) {
      throw new PlatformError(
        `failed to build the UI-tree runner — ensure Xcode and an iOS simulator runtime are installed (xcode-select -p): ${(e as Error).message.slice(0, 300)}`,
      )
    } finally {
      this.building = undefined
    }
  }

  private runnerAlive(h: RunnerHandle | undefined): h is RunnerHandle {
    return !!h && h.proc.exitCode === null && !h.proc.killed
  }

  private async ensureRunner(udid: string): Promise<RunnerHandle> {
    if (this.runnerAlive(this.runner) && this.runner.udid === udid) return this.runner
    // Serialize concurrent callers so we never double-spawn or hand back an
    // un-ready runner (a second caller must await waitReady, not just the object).
    if (this.starting) {
      const h = await this.starting.catch(() => undefined)
      if (h && this.runnerAlive(h) && h.udid === udid) return h
    }
    this.starting = this.launchRunner(udid)
    try {
      return await this.starting
    } finally {
      this.starting = undefined
    }
  }

  private async launchRunner(udid: string): Promise<RunnerHandle> {
    this.stop() // tear down any stale/other-udid runner first
    // A runner another process left behind still answers /health on the shared port, so the new
    // one's readiness poll would pass against it and then lose it when the new test session takes
    // the device over (measured: "fetch failed" on the first read). Clear it and wait for the port.
    await this.native.terminateRunner(udid, PORT)
    await this.ensureBuilt(udid)
    const proc = this.native.spawn(this.destination(udid), PORT)
    proc.on('error', (e) => logger.error('tree runner process error:', e.message))
    const handle: RunnerHandle = { proc, udid, port: PORT }
    this.runner = handle
    await this.waitReady(handle)
    return handle
  }

  private async waitReady(handle: RunnerHandle): Promise<void> {
    for (let i = 0; i < 90; i++) {
      if (!this.runnerAlive(handle)) {
        if (this.runner === handle) this.runner = undefined
        throw new PlatformError('tree runner exited before becoming ready — check Xcode/simulator state')
      }
      try {
        const r = await fetch(`http://localhost:${handle.port}/health`, { signal: AbortSignal.timeout(1000) })
        if (r.ok) return
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    this.stop()
    throw new PlatformError('tree runner did not become ready in time')
  }

  async read(udid: string, bundleId: string): Promise<UIElement[]> {
    if (!bundleId) throw new PlatformError('UI tree query needs a foreground app — launch an app first')
    const { port } = await this.ensureRunner(udid)
    let text: string
    try {
      const r = await fetch(`http://localhost:${port}/tree?bundleId=${encodeURIComponent(bundleId)}`, { signal: AbortSignal.timeout(10_000) })
      if (!r.ok) throw new PlatformError(`tree runner returned HTTP ${r.status} for ${bundleId}`)
      text = await r.text()
    } catch (e) {
      if (e instanceof PlatformError) throw e
      throw new PlatformError(`UI tree query failed: ${(e as Error).message}`)
    }
    // Guard against a garbage / wrong-bundleId body silently parsing to an empty
    // tree — consumers must see an error, never a false "screen has no elements".
    if (!text.includes('Element subtree:') && !text.includes('Application,')) {
      throw new PlatformError(`tree runner returned an unexpected response for ${bundleId} — is the app running in the foreground?`)
    }
    return parseTreeText(text)
  }

  /** Type into the app's focused element through XCUITest, which handles any Unicode text. */
  async type(udid: string, bundleId: string, text: string): Promise<void> {
    await this.command(udid, `/type?bundleId=${encodeURIComponent(bundleId)}&text=${encodeURIComponent(text)}`, 'type text')
  }

  /** Press a named key (return, delete, tab, escape, space) in the app's focused element. */
  async key(udid: string, bundleId: string, name: string): Promise<void> {
    await this.command(udid, `/key?bundleId=${encodeURIComponent(bundleId)}&name=${encodeURIComponent(name)}`, `key ${name}`)
  }

  private async command(udid: string, route: string, what: string): Promise<void> {
    const { port } = await this.ensureRunner(udid)
    let r: Response
    try {
      r = await fetch(`http://localhost:${port}${route}`, { signal: AbortSignal.timeout(60_000) })
    } catch (e) {
      throw new PlatformError(`${what} failed: ${(e as Error).message}`)
    }
    if (!r.ok) throw new PlatformError(`${what} failed: ${(await r.text()).trim() || `HTTP ${r.status}`}`)
  }

  // Stop the resident runner regardless of which device it serves.
  stop(): void {
    const handle = this.runner
    if (!handle) return
    this.runner = undefined
    this.killHandle(handle)
  }

  // Stop only if the runner currently serves this device — so shutting down one
  // booted device does not kill another device's runner.
  stopIfDevice(udid: string): void {
    if (this.runner?.udid === udid) this.stop()
  }

  private killHandle(handle: RunnerHandle): void {
    const { proc, udid } = handle
    const pid = proc.pid
    // detached spawn → the child leads its own group; kill the whole group.
    try {
      if (pid) process.kill(-pid, 'SIGTERM')
      else proc.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    // The in-simulator test host is not in that group — terminate it so the HTTP
    // port is released instead of lingering.
    this.native.terminateHost(udid)
    // SIGKILL fallback if SIGTERM did not take.
    const timer = setTimeout(() => {
      try {
        if (pid) process.kill(-pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }, 3000)
    timer.unref?.()
  }
}
