import { spawn, execFile, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { readdirSync, rmSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
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

// One runner per simulator, each on its own port. The simulator shares the host's network stack, so
// a port free on the host is free for the runner. xcodebuild hands the test process only variables
// prefixed `TEST_RUNNER_` (with the prefix stripped), which is how the port reaches it.
interface RunnerHandle {
  proc: ChildProcess
  udid: string
  port: number
  resultBundle: string
}

// Shared by every reader in the process: two simulators asking at once must not build twice into
// the same derived-data directory.
let sharedBuild: Promise<void> | undefined

// Native-tooling boundary (xcodebuild/xcrun). Injectable so tests can mock the
// native calls without exercising the runner lifecycle / signal handling.
export interface RunnerNative {
  xctestrunReady(): boolean
  build(destination: string): Promise<void>
  spawn(destination: string, port: number, resultBundle: string): ChildProcess
  terminateHost(udid: string): void
  /** Terminate any runner already on the device, including one left behind by another process. */
  terminateRunner(udid: string): Promise<void>
  /** A TCP port nothing on this host is listening on. */
  freePort(): Promise<number>
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
  spawn(destination, port, resultBundle) {
    // Its own result bundle per run: two runners started in the same second would otherwise collide
    // on the timestamped default under the shared derived-data directory.
    return spawn(
      'xcodebuild',
      ['test-without-building', '-project', PROJECT, '-scheme', SCHEME, '-destination', destination, '-derivedDataPath', BUILD_DIR, '-resultBundlePath', resultBundle, '-quiet'],
      { env: { ...process.env, TEST_RUNNER_TAPFLOW_TREE_PORT: String(port) }, stdio: 'ignore', detached: true },
    )
  },
  terminateHost(udid) {
    execFile('xcrun', ['simctl', 'terminate', udid, RUNNER_HOST_BUNDLE], () => { /* best-effort */ })
  },
  async terminateRunner(udid) {
    for (const bundle of [RUNNER_TEST_BUNDLE, RUNNER_HOST_BUNDLE]) {
      await execFileAsync('xcrun', ['simctl', 'terminate', udid, bundle]).catch(() => { /* not running */ })
    }
  },
  freePort() {
    return new Promise((resolve, reject) => {
      const srv = createServer()
      srv.once('error', reject)
      srv.listen(0, '127.0.0.1', () => {
        const address = srv.address()
        srv.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))))
      })
    })
  },
}

// Drives the resident XCUITest tree runner: builds it once, launches it (staying
// resident), and queries GET /tree over the simulator-shared loopback. Replaces
// the AXUIElement path (UITreeReader), which required a Simulator.app window.
export class XCUITreeReader {
  private readonly runners = new Map<string, RunnerHandle>()
  private readonly starting = new Map<string, Promise<RunnerHandle>>()

  constructor(private readonly native: RunnerNative = defaultNative) {}

  private destination(udid: string): string {
    // No arch — xcodebuild resolves it (arm64 on Apple Silicon, x86_64 on Intel).
    return `platform=iOS Simulator,id=${udid}`
  }

  private async ensureBuilt(udid: string): Promise<void> {
    if (this.native.xctestrunReady()) return
    sharedBuild ??= (async () => {
      logger.info('building tree runner (first run — cached afterwards)...')
      await this.native.build(this.destination(udid))
      logger.info('tree runner built')
    })().finally(() => { sharedBuild = undefined })
    try {
      await sharedBuild
    } catch (e) {
      throw new PlatformError(
        `failed to build the UI-tree runner — ensure Xcode and an iOS simulator runtime are installed (xcode-select -p): ${(e as Error).message.slice(0, 300)}`,
      )
    }
  }

  private runnerAlive(h: RunnerHandle | undefined): h is RunnerHandle {
    return !!h && h.proc.exitCode === null && !h.proc.killed
  }

  private async ensureRunner(udid: string): Promise<RunnerHandle> {
    const current = this.runners.get(udid)
    if (this.runnerAlive(current)) return current
    // Serialize concurrent callers for one device so it never gets two runners, and a second caller
    // waits for readiness rather than taking the handle early. Other devices are not held up.
    const pending = this.starting.get(udid)
    if (pending) {
      const h = await pending.catch(() => undefined)
      if (this.runnerAlive(h)) return h
    }
    const launch = this.launchRunner(udid)
    this.starting.set(udid, launch)
    try {
      return await launch
    } finally {
      if (this.starting.get(udid) === launch) this.starting.delete(udid)
    }
  }

  private async launchRunner(udid: string): Promise<RunnerHandle> {
    this.stopIfDevice(udid)
    // A runner another process left on this device would lose the device to the new test session
    // mid-request; clear it first. Its port is not ours, so it does not block the new one.
    await this.native.terminateRunner(udid)
    await this.ensureBuilt(udid)
    const port = await this.native.freePort()
    const resultBundle = join(tmpdir(), `tapflow-tree-${udid}-${Date.now()}.xcresult`)
    const proc = this.native.spawn(this.destination(udid), port, resultBundle)
    proc.on('error', (e) => logger.error('tree runner process error:', e.message))
    const handle: RunnerHandle = { proc, udid, port, resultBundle }
    this.runners.set(udid, handle)
    await this.waitReady(handle)
    return handle
  }

  private async waitReady(handle: RunnerHandle): Promise<void> {
    const { udid } = handle
    for (let i = 0; i < 90; i++) {
      if (!this.runnerAlive(handle)) {
        if (this.runners.get(udid) === handle) this.runners.delete(udid)
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
    this.stopIfDevice(handle.udid)
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

  /** Stop every runner this reader started. */
  stop(): void {
    for (const udid of [...this.runners.keys()]) this.stopIfDevice(udid)
  }

  /** Stop this device's runner only; other devices keep theirs. */
  stopIfDevice(udid: string): void {
    const handle = this.runners.get(udid)
    if (!handle) return
    this.runners.delete(udid)
    this.killHandle(handle)
  }

  private killHandle(handle: RunnerHandle): void {
    const { proc, udid, resultBundle } = handle
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
      rmSync(resultBundle, { recursive: true, force: true })
    }, 3000)
    timer.unref?.()
  }
}
