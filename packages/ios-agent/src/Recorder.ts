import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import { PlatformError, ValidationError } from '@tapflowio/agent-core'

const START_TIMEOUT_MS = 10_000
const STOP_TIMEOUT_MS = 30_000
const STARTED_MARKER = 'Recording started'

/** Something that happened on the device while it was being recorded, `t` ms after the video's first frame. */
export type RecordedAction =
  | { t: number; kind: 'tap'; x: number; y: number; label?: string }
  | { t: number; kind: 'swipe'; from: [number, number]; to: [number, number]; durationMs: number }
  | { t: number; kind: 'type'; text: string }
  | { t: number; kind: 'key'; name: string }
  | { t: number; kind: 'button'; name: string }
  | { t: number; kind: 'launch'; bundleId: string }
  | { t: number; kind: 'openUrl'; url: string }
  | { t: number; kind: 'step'; name: string; status: 'started' | 'passed' | 'failed'; message?: string }
  | { t: number; kind: 'note'; text: string }

type Omit_t<T> = T extends unknown ? Omit<T, 't'> : never
export type ActionInput = Omit_t<RecordedAction>

export interface Recording {
  /** The H.264 .mp4 simctl wrote, at the device's full resolution. */
  path: string
  /** The action log beside it: `<path>.actions.json`. */
  actionsPath: string
  durationMs: number
  bytes: number
  actions: RecordedAction[]
}

// Query values that look like credentials are replaced before a URL reaches the action log, which is
// meant to be shared (a PR comment, a job log). Magic-link tokens are the common case.
const SENSITIVE_PARAM = /([?&#](?:[\w.-]*(?:token|secret|password|passwd|auth|session|code|key|sig)[\w.-]*|tk|otp|jwt)=)[^&#]*/gi

/** `url` with the values of credential-like query parameters replaced by `…`. */
export function redactUrl(url: string): string {
  return url.replace(SENSITIVE_PARAM, '$1…')
}

export type RecordProcessFactory = (udid: string, path: string) => ChildProcess

const defaultFactory: RecordProcessFactory = (udid, path) =>
  spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', path], { stdio: ['ignore', 'pipe', 'pipe'] })

/**
 * Records one simulator's screen with `simctl io recordVideo`, and keeps a timestamped log of the
 * actions taken meanwhile. Time zero is when simctl reports "Recording started", which is when the
 * video's first frame is taken, so log times line up with video times.
 */
export class ScreenRecorder {
  private proc: ChildProcess | null = null
  private path: string | null = null
  private startedAt = 0
  private actions: RecordedAction[] = []

  constructor(private readonly udid: string, private readonly factory: RecordProcessFactory = defaultFactory) {}

  get recording(): boolean {
    return this.proc !== null
  }

  async start(path: string): Promise<void> {
    if (this.proc) throw new ValidationError(`${this.udid} is already recording to ${this.path}`)
    if (!path.toLowerCase().endsWith('.mp4') && !path.toLowerCase().endsWith('.mov')) {
      throw new ValidationError('Recording path must end in .mp4 or .mov')
    }
    const proc = this.factory(this.udid, path)
    let stderr = ''
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new PlatformError(`Recording did not start within ${START_TIMEOUT_MS}ms: ${stderr.trim() || 'no output'}`)) }, START_TIMEOUT_MS)
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
        if (stderr.includes(STARTED_MARKER)) { clearTimeout(timer); resolve() }
      })
      proc.once('error', (e) => { clearTimeout(timer); reject(new PlatformError(`Could not start recording: ${e.message}`)) })
      proc.once('exit', (code) => { clearTimeout(timer); reject(new PlatformError(`Recording exited before it started (code ${code}): ${stderr.trim()}`)) })
    })
    this.proc = proc
    this.path = path
    this.startedAt = Date.now()
    this.actions = []
  }

  /** Add an action to the log. A no-op when nothing is being recorded. */
  mark(action: ActionInput): void {
    if (!this.proc) return
    this.actions.push({ ...action, t: Date.now() - this.startedAt } as RecordedAction)
  }

  /** Stop, wait for simctl to finish writing the file, and write the action log beside it. */
  async stop(): Promise<Recording> {
    const proc = this.proc
    const path = this.path
    if (!proc || !path) throw new ValidationError(`${this.udid} is not recording`)
    const durationMs = Date.now() - this.startedAt
    const actions = this.actions
    this.proc = null
    this.path = null
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new PlatformError('Recording did not finish writing in time')) }, STOP_TIMEOUT_MS)
      proc.once('exit', (code, signal) => {
        clearTimeout(timer)
        if (code === 0 || signal === 'SIGINT') resolve()
        else reject(new PlatformError(`Recording ended with code ${code ?? signal}`))
      })
      // SIGINT is how simctl is told to finish: it writes the file and exits 0.
      proc.kill('SIGINT')
    })
    const bytes = fs.statSync(path).size
    const actionsPath = `${path}.actions.json`
    fs.writeFileSync(actionsPath, JSON.stringify({ video: path, durationMs, actions }, null, 2))
    return { path, actionsPath, durationMs, bytes, actions }
  }

  /** Stop without waiting; the file may be incomplete. For teardown only. */
  abort(): void {
    this.proc?.kill('SIGINT')
    this.proc = null
    this.path = null
  }
}
