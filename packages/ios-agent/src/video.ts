import { execFile } from 'child_process'
import fs from 'fs'
import { promisify } from 'util'
import { PlatformError } from '@tapflowio/agent-core'
import type { RecordedAction } from './Recorder.js'

const execFileAsync = promisify(execFile)

export interface ExportOptions {
  /** Output width in pixels; height follows the aspect ratio. Default 600. */
  width?: number
  /** x264 quality, 18 (best) to 35 (smallest). Default 30. */
  crf?: number
  /** Burn a marker in where each tap and swipe landed. Default true when actions are given. */
  markers?: boolean
  /**
   * How long the recording really ran. simctl writes a frame only when the screen changes, so a
   * still last screen is cut off; the export holds the last frame out to this length.
   */
  durationMs?: number
  ffmpeg?: string
  ffprobe?: string
}

async function probeDurationMs(input: string, ffprobe: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', input])
    const seconds = Number(stdout.trim())
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null
  } catch {
    return null
  }
}

const MARKER_MS = 600
const MARKER_COLOR = 'red@0.85'

function between(t0: number, t1: number): string {
  return `between(t\\,${(t0 / 1000).toFixed(3)}\\,${(t1 / 1000).toFixed(3)})`
}

// A square outline centred on a normalized point, sized to the output width.
function box(x: number, y: number, t0: number, t1: number, size: number): string {
  const half = Math.round(size / 2)
  return `drawbox=x=iw*${x.toFixed(4)}-${half}:y=ih*${y.toFixed(4)}-${half}:w=${size}:h=${size}:color=${MARKER_COLOR}:t=${Math.max(3, Math.round(size / 10))}:enable='${between(t0, t1)}'`
}

export function markerFilters(actions: RecordedAction[], width: number): string[] {
  const size = Math.round(width * 0.09)
  const filters: string[] = []
  for (const a of actions) {
    if (a.kind === 'tap') filters.push(box(a.x, a.y, a.t, a.t + MARKER_MS, size))
    if (a.kind === 'swipe') {
      filters.push(box(a.from[0], a.from[1], a.t, a.t + a.durationMs, size))
      filters.push(box(a.to[0], a.to[1], a.t + a.durationMs, a.t + a.durationMs + MARKER_MS, size))
    }
  }
  return filters
}

/**
 * Re-encode a recording for sharing: smaller, constant 30fps H.264 with `+faststart` so it plays in
 * a browser while downloading, optionally with tap and swipe markers burned in. Needs ffmpeg.
 */
export async function exportVideo(input: string, output: string, actions: RecordedAction[] = [], options: ExportOptions = {}): Promise<{ path: string; bytes: number }> {
  const width = options.width ?? 600
  const crf = options.crf ?? 30
  const withMarkers = options.markers ?? actions.length > 0
  const pad: string[] = []
  if (options.durationMs !== undefined) {
    const videoMs = await probeDurationMs(input, options.ffprobe ?? 'ffprobe')
    const missing = videoMs === null ? 0 : options.durationMs - videoMs
    if (missing > 100) pad.push(`tpad=stop_mode=clone:stop_duration=${(missing / 1000).toFixed(3)}`)
  }
  const filters = [...pad, `scale=${width}:-2`, 'fps=30', ...(withMarkers ? markerFilters(actions, width) : []), 'format=yuv420p']
  const args = ['-y', '-v', 'error', '-i', input, '-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-movflags', '+faststart', '-an', output]
  try {
    await execFileAsync(options.ffmpeg ?? 'ffmpeg', args, { maxBuffer: 16 * 1024 * 1024, timeout: 300_000 })
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string }
    if (err.code === 'ENOENT') throw new PlatformError('ffmpeg is not installed (brew install ffmpeg); the full-size recording is still available')
    throw new PlatformError(`ffmpeg failed: ${(err.stderr ?? err.message).trim().split('\n').slice(-3).join(' ')}`)
  }
  return { path: output, bytes: fs.statSync(output).size }
}

function clock(ms: number): string {
  const s = ms / 1000
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
}

function describe(a: RecordedAction): string | null {
  switch (a.kind) {
    case 'tap': return a.label ? `tap "${a.label}"` : `tap (${a.x.toFixed(2)}, ${a.y.toFixed(2)})`
    case 'swipe': return `swipe (${a.from.map((v) => v.toFixed(2)).join(', ')}) → (${a.to.map((v) => v.toFixed(2)).join(', ')})`
    case 'type': return `type ${JSON.stringify(a.text)}`
    case 'key': return `key ${a.name}`
    case 'button': return `button ${a.name}`
    case 'launch': return `launch ${a.bundleId}`
    case 'terminate': return `quit ${a.bundleId}`
    case 'openUrl': return `open ${a.url}`
    case 'note': return a.text
    case 'step':
      if (a.status === 'started') return null
      return `${a.status === 'passed' ? '✓' : '✗'} ${a.name}${a.message ? ` (${a.message})` : ''}`
  }
}

/**
 * The action log as plain lines (`0:03.2  ✓ tapOn General`), for a PR comment or a job log. With
 * `stepsOnly`, only flow step outcomes and notes are listed; otherwise every action is.
 */
export function timeline(actions: RecordedAction[], { stepsOnly = false } = {}): string {
  const hasSteps = actions.some((a) => a.kind === 'step')
  return actions
    .filter((a) => !stepsOnly || !hasSteps || a.kind === 'step' || a.kind === 'note')
    .map((a) => ({ at: a.kind === 'step' ? stepStart(actions, a) : a.t, text: describe(a) }))
    .filter((l): l is { at: number; text: string } => l.text !== null)
    .sort((a, b) => a.at - b.at)
    .map((l) => `${clock(l.at)}  ${l.text}`)
    .join('\n')
}

// A step's line is stamped when it started, which is where to seek in the video to watch it.
function stepStart(actions: RecordedAction[], end: Extract<RecordedAction, { kind: 'step' }>): number {
  const start = [...actions].reverse().find((a) => a.kind === 'step' && a.status === 'started' && a.name === end.name && a.t <= end.t)
  return start?.t ?? end.t
}
