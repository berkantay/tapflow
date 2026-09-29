import { spawnSync } from 'child_process'
import fs from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import type { Device, UIElement } from '@tapflowio/agent-core'
import { createLogger, PlatformError, ValidationError } from '@tapflowio/agent-core'
import { SimctlWrapper, isDeviceMissingError } from './SimctlWrapper.js'
import { TouchHelper } from './TouchHelper.js'
import { XCUITreeReader } from './XCUITreeReader.js'
import { LeanStore } from './LeanStore.js'
import { LEAN_LABELS } from './leanLabels.js'
import { redactUrl, ScreenRecorder, type ActionInput, type Recording } from './Recorder.js'

const logger = createLogger('ios-agent:simulator')

const EXTRACT_MAXBUFFER = 256 * 1024 * 1024
const INPUT_READY_TIMEOUT_MS = 5_000
const INPUT_READY_POLL_MS = 20
const SWIPE_STEPS = 8
const TREE_SETTLE_MS = 3_000
const TREE_RETRY_MS = 250

export type Orientation = 'portrait' | 'landscapeLeft' | 'landscapeRight' | 'portraitUpsideDown'

/**
 * Hardware buttons by name. The HID usages are the same in every iPhone and iPad device chrome
 * Xcode ships (`/Library/Developer/DeviceKit/Chrome/*.devicechrome/.../chrome.json`), so they are
 * fixed here rather than read per device. Home is the consumer Menu usage from the home-button
 * chromes; it also works on devices without a home button, where the legacy button path does not
 * (measured on iOS 26.0).
 */
const BUTTONS: Record<string, { usagePage: number; usage: number }> = {
  home: { usagePage: 12, usage: 64 },
  lock: { usagePage: 12, usage: 48 },
  power: { usagePage: 12, usage: 48 },
  volume_up: { usagePage: 12, usage: 233 },
  volume_down: { usagePage: 12, usage: 234 },
  action: { usagePage: 11, usage: 45 },
  mute: { usagePage: 11, usage: 46 },
}

export const BUTTON_NAMES = Object.keys(BUTTONS)

// System alerts ("Open in …?", permission prompts) are drawn by SpringBoard, not the app, so they
// never appear in the app's tree.
const SPRINGBOARD = 'com.apple.springboard'
const ALERT_ROLES = new Set(['Alert', 'Sheet'])

/** A system alert covering the screen, with its buttons and text. */
export interface SystemAlert {
  title: string
  elements: UIElement[]
}

function within(inner: UIElement['frame'], outer: UIElement['frame']): boolean {
  const e = 0.002
  return inner.x >= outer.x - e && inner.y >= outer.y - e
    && inner.x + inner.width <= outer.x + outer.width + e
    && inner.y + inner.height <= outer.y + outer.height + e
}

/** Keys `pressKey` accepts. `KeyboardEvent.code` spellings are accepted as aliases. */
export const KEY_NAMES = ['return', 'enter', 'delete', 'backspace', 'tab', 'escape', 'space']
const KEY_ALIASES: Record<string, string> = { Enter: 'return', Backspace: 'delete', Tab: 'tab', Escape: 'escape', Space: 'space' }

/** Lean mode trims background services; it is only known to be safe from iOS 18.5. */
export function leanSupported(osVersion: string | undefined): boolean {
  const m = osVersion?.match(/^iOS (\d+)\.(\d+)/)
  if (!m) return false
  const [major, minor] = [Number(m[1]), Number(m[2])]
  return major > 18 || (major === 18 && minor >= 5)
}

export interface SimulatorOptions {
  /** Disable background services the simulator does not need, from the next cold boot. */
  lean?: boolean
  simctl?: SimctlWrapper
  treeReader?: XCUITreeReader
  leanStore?: LeanStore
  touchHelper?: (udid: string) => TouchHelper
  recorder?: ScreenRecorder
}

export interface BootOptions {
  /** Erase all content and settings before booting. */
  erase?: boolean
}

/**
 * One iOS simulator, driven directly: boot, apps, input, screenshots and the UI tree.
 *
 * Coordinates are normalized 0-1 against the device screen, the same space the UI tree reports
 * frames in, so an element's frame centre can be tapped as-is.
 */
export class Simulator {
  private readonly simctl: SimctlWrapper
  private readonly treeReader: XCUITreeReader
  private readonly leanStore: LeanStore
  private readonly makeTouchHelper: (udid: string) => TouchHelper
  private readonly lean: boolean
  private readonly recorder: ScreenRecorder
  private touch: TouchHelper | null = null
  private foregroundBundleId: string | null = null

  constructor(readonly udid: string, options: SimulatorOptions = {}) {
    this.simctl = options.simctl ?? new SimctlWrapper()
    this.treeReader = options.treeReader ?? new XCUITreeReader()
    this.leanStore = options.leanStore ?? new LeanStore()
    this.makeTouchHelper = options.touchHelper ?? ((udid) => new TouchHelper(udid))
    this.lean = options.lean ?? false
    this.recorder = options.recorder ?? new ScreenRecorder(udid)
  }

  /** Available simulators on this Mac. */
  static list(simctl = new SimctlWrapper()): Promise<Device[]> {
    return simctl.listDevices()
  }

  /**
   * Find a simulator by UDID or by name. A name must match exactly one available device; when
   * several share it (one per runtime is common), a booted one wins, otherwise it is ambiguous.
   */
  static async find(nameOrUdid: string, simctl = new SimctlWrapper()): Promise<Device> {
    const devices = await simctl.listDevices()
    const byId = devices.find((d) => d.id === nameOrUdid)
    if (byId) return byId
    const byName = devices.filter((d) => d.name === nameOrUdid)
    if (byName.length === 1) return byName[0]
    const booted = byName.filter((d) => d.status === 'booted')
    if (booted.length === 1) return booted[0]
    if (byName.length === 0) throw new ValidationError(`No simulator named or with UDID "${nameOrUdid}"`)
    throw new ValidationError(
      `"${nameOrUdid}" matches ${byName.length} simulators; pass a UDID instead: ${byName.map((d) => `${d.id} (${d.osVersion ?? '?'})`).join(', ')}`,
    )
  }

  async device(): Promise<Device> {
    const device = (await this.simctl.listDevices()).find((d) => d.id === this.udid)
    if (!device) throw new PlatformError(`Simulator ${this.udid} is not available`)
    return device
  }

  /**
   * Boot the simulator and wait until it reports `Booted`. `simctl boot` returns when the boot is
   * accepted, seconds before the device is up, so this waits rather than trusting it. Booting a
   * device that is already up is fine and returns quickly.
   */
  async boot(options: BootOptions = {}): Promise<Device> {
    this.stopTouch()
    const device = await this.device()
    if (options.erase) {
      // `simctl erase` refuses anything that is not shut down.
      if (device.status !== 'shutdown') await this.simctl.shutdown(this.udid)
      this.prepareLean(device)
      await this.simctl.erase(this.udid)
      await this.simctl.boot(this.udid)
    } else {
      if (device.status === 'shutdown') this.prepareLean(device)
      await this.bootWithZombieRecovery()
    }
    const booted = await this.simctl.waitUntilBooted(this.udid)
    this.simctl.syncKeyboardsFromLanguages(this.udid).catch((e) => logger.warn('keyboard sync failed:', (e as Error).message))
    this.ensureTouch()
    return booted
  }

  /** Shut the simulator down and release everything this instance started. */
  async shutdown(): Promise<void> {
    if (this.recorder.recording) await this.recorder.stop().catch((e) => logger.warn('stopping the recording failed:', (e as Error).message))
    this.close()
    await this.simctl.shutdown(this.udid)
    this.revertLean()
  }

  /** Release helper processes without shutting the simulator down. */
  close(): void {
    this.recorder.abort()
    this.stopTouch()
    this.treeReader.stopIfDevice(this.udid)
    this.simctl.stopKeyboardDaemon()
  }

  /**
   * Install an app. Accepts a simulator `.app` directory, or a `.zip` / `.tar.gz` / `.tgz` archive
   * containing one.
   */
  async install(appPath: string): Promise<void> {
    const lower = appPath.toLowerCase()
    const isTar = lower.endsWith('.tar.gz') || lower.endsWith('.tgz')
    const isZip = lower.endsWith('.zip')
    if (!isTar && !isZip) return this.simctl.installApp(this.udid, appPath)

    const outDir = path.join(tmpdir(), `tapflow-install-${randomUUID()}`)
    fs.mkdirSync(outDir, { recursive: true })
    try {
      const result = isTar
        ? spawnSync('tar', ['-xzf', appPath, '-C', outDir], { maxBuffer: EXTRACT_MAXBUFFER })
        : spawnSync('unzip', ['-q', '-o', appPath, '-d', outDir], { maxBuffer: EXTRACT_MAXBUFFER })
      if (result.error) throw new PlatformError(`Could not run ${isTar ? 'tar' : 'unzip'}: ${result.error.message}`)
      if (result.status !== 0) {
        const detail = (result.stderr?.toString() ?? '').trim().split('\n')[0]?.slice(0, 300)
        throw new ValidationError(`Could not extract ${path.basename(appPath)}${detail ? `: ${detail}` : ''}`)
      }
      const appDir = fs.readdirSync(outDir).find((e) => e.endsWith('.app') && fs.statSync(path.join(outDir, e)).isDirectory())
      if (!appDir) throw new ValidationError(`No .app directory at the top of ${path.basename(appPath)}; build for iphonesimulator and archive the .app`)
      await this.simctl.installApp(this.udid, path.join(outDir, appDir))
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  }

  uninstall(bundleId: string): Promise<void> {
    return this.simctl.uninstallApp(this.udid, bundleId)
  }

  /** Launch an app. It becomes the app `uiTree()` reads when no bundle id is given. */
  async launch(bundleId: string): Promise<void> {
    await this.simctl.launchApp(this.udid, bundleId)
    this.foregroundBundleId = bundleId
    this.recorder.mark({ kind: 'launch', bundleId })
  }

  /** Wipe an app's data container without uninstalling it. */
  clearAppData(bundleId: string): Promise<void> {
    return this.simctl.clearAppData(this.udid, bundleId)
  }

  async openUrl(url: string): Promise<void> {
    await this.simctl.openUrl(this.udid, url)
    this.recorder.mark({ kind: 'openUrl', url: redactUrl(url) })
  }

  screenshot(format: 'png' | 'jpeg' = 'png'): Promise<Buffer> {
    return this.simctl.screenshot(this.udid, format)
  }

  /** The accessibility tree of an app, with frames normalized 0-1. Defaults to the last launched app. */
  async uiTree(bundleId: string | undefined = this.foregroundBundleId ?? undefined): Promise<UIElement[]> {
    bundleId = this.requireBundle(bundleId)
    // An app coming back to the foreground answers with an empty query chain for a moment (measured
    // right after a home press and a relaunch), so an unexpected response is retried briefly.
    const deadline = Date.now() + TREE_SETTLE_MS
    for (;;) {
      try {
        return await this.treeReader.read(this.udid, bundleId)
      } catch (e) {
        if (!(e instanceof PlatformError) || !/unexpected response/.test(e.message) || Date.now() >= deadline) throw e
        await delay(TREE_RETRY_MS)
      }
    }
  }

  /**
   * The system alert on screen, if any: SpringBoard's alert with its buttons and text, marked
   * `system: true`. Null when there is none, or when SpringBoard's tree cannot be read.
   */
  async systemAlert(): Promise<SystemAlert | null> {
    let tree: UIElement[]
    try {
      tree = await this.treeReader.read(this.udid, SPRINGBOARD)
    } catch {
      return null
    }
    const alert = tree.find((e) => ALERT_ROLES.has(e.rawRole ?? ''))
    if (!alert) return null
    const seen = new Set<string>()
    const elements = tree
      .filter((e) => e !== alert && (e.role === 'button' || e.role === 'text' || e.role === 'input') && within(e.frame, alert.frame))
      .filter((e) => { const k = `${e.role}|${e.label}|${e.frame.x}|${e.frame.y}`; if (seen.has(k)) return false; seen.add(k); return true })
      .map((e) => ({ ...e, system: true }))
    return { title: alert.label, elements }
  }

  /** Tap a normalized point. `label` names what was tapped in a recording's action log. */
  async tap(x: number, y: number, label?: string): Promise<void> {
    const touch = await this.input()
    if (!touch.touchStart(x, y) || !touch.touchEnd()) throw this.inputRefused('tap', touch)
    this.recorder.mark({ kind: 'tap', x, y, ...(label ? { label } : {}) })
  }

  async swipe(from: [number, number], to: [number, number], durationMs = 300): Promise<void> {
    const touch = await this.input()
    if (!touch.touchStart(from[0], from[1])) throw this.inputRefused('swipe', touch)
    this.recorder.mark({ kind: 'swipe', from, to, durationMs })
    const interval = durationMs / SWIPE_STEPS
    for (let i = 1; i < SWIPE_STEPS; i++) {
      await delay(interval)
      const t = i / SWIPE_STEPS
      if (!touch.touchMove(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t)) throw this.inputRefused('swipe', touch)
    }
    await delay(interval)
    if (!touch.touchMove(to[0], to[1]) || !touch.touchEnd()) throw this.inputRefused('swipe', touch)
  }

  /**
   * Type into the focused element of an app (default: the last launched one). Goes through the
   * XCUITest runner, which handles any Unicode text and does not touch the pasteboard (the
   * simulator's pasteboard syncs with the host's, so pasting would leak or clobber it).
   */
  async typeText(text: string, bundleId: string | undefined = this.foregroundBundleId ?? undefined): Promise<void> {
    if (!text) return
    await this.treeReader.type(this.udid, this.requireBundle(bundleId), text)
    this.recorder.mark({ kind: 'type', text })
  }

  /** Press a key in the focused element: `return`/`enter`, `delete`/`backspace`, `tab`, `escape`, `space`. */
  async pressKey(name: string, bundleId: string | undefined = this.foregroundBundleId ?? undefined): Promise<void> {
    const key = KEY_ALIASES[name] ?? name.toLowerCase()
    if (!KEY_NAMES.includes(key)) throw new ValidationError(`Unknown key: ${name} (expected one of ${KEY_NAMES.join(', ')})`)
    await this.treeReader.key(this.udid, this.requireBundle(bundleId), key)
    this.recorder.mark({ kind: 'key', name: key })
  }

  /** Press a hardware button: one of `BUTTON_NAMES`. */
  async pressButton(name: string): Promise<void> {
    const button = BUTTONS[name]
    if (!button) throw new ValidationError(`Unknown button: ${name} (expected one of ${BUTTON_NAMES.join(', ')})`)
    const touch = await this.input()
    if (!touch.pressButton(button.usagePage, button.usage)) throw this.inputRefused(`button ${name}`, touch)
    this.recorder.mark({ kind: 'button', name })
  }

  /**
   * Start recording the screen to an .mp4. Every action taken through this instance until
   * `stopRecording()` is logged with its time in the video.
   */
  startRecording(path: string): Promise<void> {
    return this.recorder.start(path)
  }

  /** Stop recording; resolves once the video is written, with the action log beside it. */
  stopRecording(): Promise<Recording> {
    return this.recorder.stop()
  }

  get recording(): boolean {
    return this.recorder.recording
  }

  /** Add an entry to the current recording's action log (a flow step, a note). No-op when not recording. */
  mark(action: ActionInput): void {
    this.recorder.mark(action)
  }

  rotate(orientation: Orientation): Promise<void> {
    return this.simctl.rotate(this.udid, orientation)
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async bootWithZombieRecovery(): Promise<void> {
    try {
      await this.simctl.boot(this.udid)
    } catch (e) {
      // A device whose data dir vanished (an Xcode update can prune it) is still listed but cannot
      // boot. Erasing regenerates the data; the match is text-only so a healthy device is never erased.
      if (!isDeviceMissingError(e)) throw e
      logger.warn(`${this.udid}: data missing on disk, erasing to recover and retrying the boot once`)
      await this.simctl.erase(this.udid)
      await this.simctl.boot(this.udid)
    }
  }

  private requireBundle(bundleId: string | undefined): string {
    if (!bundleId) throw new ValidationError('No app to act on: launch one first or pass its bundle id')
    return bundleId
  }

  private ensureTouch(): TouchHelper {
    if (!this.touch) {
      this.touch = this.makeTouchHelper(this.udid)
      this.touch.start()
    }
    return this.touch
  }

  private stopTouch(): void {
    this.touch?.stop()
    this.touch = null
  }

  /**
   * The touch channel, once it can inject. The helper takes about 200ms after spawning before it
   * holds its HID client, and a write in that window is dropped, so input waits for readiness.
   */
  private async input(): Promise<TouchHelper> {
    const touch = this.ensureTouch()
    const deadline = Date.now() + INPUT_READY_TIMEOUT_MS
    while (!touch.isReady()) {
      if (Date.now() >= deadline) throw new PlatformError(`Input channel to ${this.udid} did not become ready (${touch.inputState()}); is the simulator booted?`)
      await delay(INPUT_READY_POLL_MS)
    }
    return touch
  }

  private inputRefused(what: string, touch: TouchHelper): PlatformError {
    return new PlatformError(`The device did not accept the ${what} (input channel ${touch.inputState()})`)
  }

  /** Show or hide the software keyboard (hiding connects the simulated hardware keyboard). */
  async setSoftwareKeyboard(visible: boolean): Promise<void> {
    if (visible) await this.simctl.showSoftwareKeyboard(this.udid)
    else await this.simctl.hideSoftwareKeyboard(this.udid)
  }

  // launchd_sim reads the lean store when it starts, so it is only written while the device is off.
  private prepareLean(device: Device): void {
    try {
      if (!this.lean) this.revertLean()
      else if (!leanSupported(device.osVersion)) logger.info(`Lean mode: not applied to ${device.name} (${device.osVersion ?? 'unknown runtime'}); iOS 18.5 or later only`)
      else this.leanStore.apply(this.udid, LEAN_LABELS)
    } catch (e) {
      logger.warn(`Lean mode: could not update ${device.name}, booting it as it is:`, (e as Error).message)
    }
  }

  private revertLean(): void {
    try {
      if (this.leanStore.isApplied(this.udid)) this.leanStore.revert(this.udid)
    } catch (e) {
      logger.warn(`Lean mode: could not restore ${this.udid}:`, (e as Error).message)
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
