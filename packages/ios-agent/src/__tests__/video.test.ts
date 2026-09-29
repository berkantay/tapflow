import { describe, it, expect } from 'vitest'
import { markerFilters, timeline } from '../video'
import type { RecordedAction } from '../Recorder'

describe('markerFilters', () => {
  it('draws a box where a tap landed, for a moment after it', () => {
    const [f] = markerFilters([{ t: 1500, kind: 'tap', x: 0.25, y: 0.75 }], 600)
    expect(f).toMatch(/^drawbox=x=iw\*0\.2500-27:y=ih\*0\.7500-27:w=54:h=54/)
    expect(f).toContain("enable='between(t\\,1.500\\,2.100)'")
  })

  it('marks both ends of a swipe', () => {
    const filters = markerFilters([{ t: 0, kind: 'swipe', from: [0.5, 0.8], to: [0.5, 0.2], durationMs: 300 }], 600)
    expect(filters).toHaveLength(2)
    expect(filters[1]).toContain('ih*0.2000')
  })

  it('ignores actions with no position', () => {
    expect(markerFilters([{ t: 0, kind: 'type', text: 'x' }], 600)).toEqual([])
  })
})

describe('timeline', () => {
  const actions: RecordedAction[] = [
    { t: 0, kind: 'step', name: 'launchApp', status: 'started' },
    { t: 200, kind: 'launch', bundleId: 'com.example' },
    { t: 250, kind: 'step', name: 'launchApp', status: 'passed' },
    { t: 300, kind: 'step', name: 'tapOn("Sign in")', status: 'started' },
    { t: 3200, kind: 'tap', x: 0.5, y: 0.8, label: 'Sign in' },
    { t: 3300, kind: 'step', name: 'tapOn("Sign in")', status: 'failed', message: 'timed out' },
    { t: 65_000, kind: 'note', text: 'crash reproduced' },
  ]

  it('lists every action in time order, stamping steps when they started', () => {
    expect(timeline(actions).split('\n')).toEqual([
      '0:00.0  ✓ launchApp',
      '0:00.2  launch com.example',
      '0:00.3  ✗ tapOn("Sign in") (timed out)',
      '0:03.2  tap "Sign in"',
      '1:05.0  crash reproduced',
    ])
  })

  it('can list only step outcomes and notes', () => {
    expect(timeline(actions, { stepsOnly: true }).split('\n')).toEqual([
      '0:00.0  ✓ launchApp',
      '0:00.3  ✗ tapOn("Sign in") (timed out)',
      '1:05.0  crash reproduced',
    ])
  })
})
