import { describe, it, expect } from 'vitest'
import type { RecordedAction } from '@tapflowio/ios-agent'
import { recordingToFlow } from '../fromRecording'
import { parseFlow } from '../schema'

const actions: RecordedAction[] = [
  { t: 0, kind: 'launch', bundleId: 'com.example.app' },
  { t: 100, kind: 'openUrl', url: 'example://login?tk=secret123' },
  { t: 200, kind: 'tap', x: 0.5, y: 0.9, label: 'Get started', selector: { id: 'welcome-get-started' } },
  { t: 300, kind: 'tap', x: 0.3, y: 0.95, label: 'Tasks', selector: { label: 'Tasks', role: 'button' } },
  { t: 400, kind: 'tap', x: 0.6, y: 0.2, label: 'Completed', selector: { text: 'Complet' } },
  { t: 500, kind: 'tap', x: 0.1, y: 0.1 },
  { t: 600, kind: 'type', text: 'héllo "quoted"' },
  { t: 700, kind: 'key', name: 'return' },
  { t: 800, kind: 'swipe', from: [0.5, 0.7], to: [0.5, 0.3], durationMs: 300 },
  { t: 900, kind: 'button', name: 'home' },
  { t: 950, kind: 'note', text: 'list visible' },
  { t: 990, kind: 'step', name: 'launchApp', status: 'passed' },
]

describe('recordingToFlow', () => {
  it('writes a flow the parser accepts, with each action as the matching step', () => {
    const { yaml, steps, skipped } = recordingToFlow(actions, { name: 'tasks' })
    const flow = parseFlow(yaml, 'tasks.yaml')
    expect(flow.appId).toBe('com.example.app')
    expect(flow.steps).toEqual([
      { type: 'launchApp' },
      { type: 'openUrl', url: 'example://login?tk=…' },
      { type: 'tapOn', selector: { id: 'welcome-get-started' } },
      { type: 'tapOn', selector: { label: 'Tasks', role: 'button' } },
      { type: 'tapOn', selector: { text: 'Complet' } },
      { type: 'inputText', text: 'héllo "quoted"' },
      { type: 'pressKey', code: 'return' },
      { type: 'swipe', from: [0.5, 0.7], to: [0.5, 0.3], durationMs: 300 },
    ])
    expect(steps).toBe(8)
    expect(skipped).toBe(2)
  })

  it('keeps what a flow cannot express as comments where it happened', () => {
    const { yaml } = recordingToFlow(actions, { name: 'tasks' })
    expect(yaml).toContain('# tap at (0.10, 0.10) had no selector; replace with a tapOn')
    expect(yaml).toContain('# pressed the home button')
    expect(yaml).toContain('# MARK: list visible')
    expect(yaml).toContain('# Redacted: put a fresh link here before replaying.')
  })

  it('never writes a token, even from a log recorded before redaction', () => {
    expect(recordingToFlow(actions, { name: 'x' }).yaml).not.toContain('secret123')
  })

  it('uses the given appId and comments out launches of other apps', () => {
    const { yaml } = recordingToFlow(actions, { name: 'x', appId: 'com.other' })
    expect(yaml).toContain('appId: "com.other"')
    expect(yaml).toContain('# launched com.example.app')
  })
})

describe('recordingToFlow checks and alerts', () => {
  it('turns what the agent waited for into assertions', () => {
    const { yaml } = recordingToFlow([
      { t: 0, kind: 'launch', bundleId: 'com.x' },
      { t: 1, kind: 'wait', selector: { id: 'tabs-completed' }, gone: false },
      { t: 2, kind: 'wait', selector: { text: 'Loading' }, gone: true },
    ], { name: 'x' })
    expect(parseFlow(yaml, 'x.yaml').steps.slice(1)).toEqual([
      { type: 'assertVisible', selector: { id: 'tabs-completed' } },
      { type: 'assertNotVisible', selector: { text: 'Loading' } },
    ])
  })

  it('makes a system alert tap optional and alert-only', () => {
    const { yaml } = recordingToFlow([
      { t: 0, kind: 'launch', bundleId: 'com.x' },
      { t: 1, kind: 'tap', x: 0.6, y: 0.55, label: 'Allow', selector: { label: 'Allow', system: true } },
    ], { name: 'x' })
    expect(parseFlow(yaml, 'x.yaml').steps[1]).toEqual({ type: 'tapOn', selector: { label: 'Allow', system: true, optional: true } })
  })
})

