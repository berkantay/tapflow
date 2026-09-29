import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ChildProcess } from 'child_process'
import { ScreenRecorder } from '../Recorder'

function fakeProc(opts: { start?: boolean; writes?: string } = {}) {
  const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: ReturnType<typeof vi.fn> }
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn((signal: string) => {
    if (signal === 'SIGINT') {
      if (opts.writes) fs.writeFileSync(opts.writes, 'video')
      setImmediate(() => proc.emit('exit', 0, null))
    }
    return true
  })
  if (opts.start !== false) setImmediate(() => proc.stderr.emit('data', Buffer.from('Note: No display specified.\nRecording started\n')))
  return proc as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> }
}

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')), 'out.mp4')

describe('ScreenRecorder', () => {
  it('starts on simctl\'s "Recording started", logs actions, and writes the log on stop', async () => {
    const file = tmp()
    const proc = fakeProc({ writes: file })
    const rec = new ScreenRecorder('U', () => proc)
    await rec.start(file)
    expect(rec.recording).toBe(true)
    rec.mark({ kind: 'tap', x: 0.5, y: 0.5, label: 'OK' })
    const out = await rec.stop()
    expect(proc.kill).toHaveBeenCalledWith('SIGINT')
    expect(out.bytes).toBe(5)
    expect(out.actions).toEqual([expect.objectContaining({ kind: 'tap', label: 'OK', t: expect.any(Number) })])
    expect(JSON.parse(fs.readFileSync(out.actionsPath, 'utf8')).actions).toHaveLength(1)
    expect(rec.recording).toBe(false)
  })

  it('ignores marks while not recording', async () => {
    const file = tmp()
    const rec = new ScreenRecorder('U', () => fakeProc({ writes: file }))
    rec.mark({ kind: 'note', text: 'before' })
    await rec.start(file)
    const out = await rec.stop()
    expect(out.actions).toEqual([])
  })

  it('refuses a second recording on the same device', async () => {
    const file = tmp()
    const rec = new ScreenRecorder('U', () => fakeProc({ writes: file }))
    await rec.start(file)
    await expect(rec.start(file)).rejects.toThrow(/already recording/)
    await rec.stop()
  })

  it('reports simctl exiting before it started', async () => {
    const proc = fakeProc({ start: false })
    setImmediate(() => { proc.stderr?.emit('data', Buffer.from('Invalid device')); proc.emit('exit', 1, null) })
    await expect(new ScreenRecorder('U', () => proc).start(tmp())).rejects.toThrow(/exited before it started.*Invalid device/)
  })

  it('needs an .mp4 or .mov path', async () => {
    await expect(new ScreenRecorder('U', () => fakeProc()).start('/tmp/out.gif')).rejects.toThrow(/\.mp4 or \.mov/)
  })

  it('stopping when not recording is an error', async () => {
    await expect(new ScreenRecorder('U', () => fakeProc()).stop()).rejects.toThrow(/not recording/)
  })
})
