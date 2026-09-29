import { describe, it, expect } from 'vitest'
import { runChecks, type DoctorDeps } from '../../commands/doctor'

const outputs: Record<string, string> = {
  'xcode-select -p': '/Applications/Xcode.app/Contents/Developer\n',
  'xcodebuild -version': 'Xcode 27.0\nBuild version 27A266a\n',
  'xcrun simctl list runtimes --json': JSON.stringify({ runtimes: [{ name: 'iOS 26.0', platform: 'iOS', isAvailable: true }] }),
  'xcrun simctl list devices available --json': JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{}, {}] } }),
}

function deps(overrides: Partial<DoctorDeps> = {}, out = outputs): DoctorDeps {
  return {
    platform: 'darwin',
    run: async (cmd, args) => {
      const key = [cmd, ...args].join(' ')
      if (!(key in out)) throw new Error(`command failed: ${key}`)
      return out[key]
    },
    helpersDir: '/pkg/bin',
    isExecutable: () => true,
    ...overrides,
  }
}

describe('doctor', () => {
  it('passes on a ready Mac', async () => {
    const checks = await runChecks(deps())
    expect(checks.every((c) => c.ok)).toBe(true)
    expect(checks.find((c) => c.label === 'iOS simulators')?.detail).toBe('2 available')
  })

  it('stops early off macOS', async () => {
    const checks = await runChecks(deps({ platform: 'linux' }))
    expect(checks).toHaveLength(1)
    expect(checks[0].ok).toBe(false)
  })

  it('flags an Xcode that is too old', async () => {
    const checks = await runChecks(deps({}, { ...outputs, 'xcodebuild -version': 'Xcode 25.4\n' }))
    expect(checks.find((c) => c.label === 'Xcode')?.ok).toBe(false)
  })

  it('suggests downloading a runtime when none is installed', async () => {
    const checks = await runChecks(deps({}, { ...outputs, 'xcrun simctl list runtimes --json': JSON.stringify({ runtimes: [] }) }))
    expect(checks.find((c) => c.label === 'iOS runtime')?.fix).toMatch(/downloadPlatform/)
  })

  it('names helper binaries that are not executable', async () => {
    const checks = await runChecks(deps({ isExecutable: (f) => !f.endsWith('touch-helper') }))
    expect(checks.find((c) => c.label === 'helper binaries')?.detail).toMatch(/touch-helper/)
  })
})
