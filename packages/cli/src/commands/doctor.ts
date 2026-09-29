import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { GREEN, RED, YELLOW, R } from '../lib/print.js'

const execFileAsync = promisify(execFile)

export interface Check {
  label: string
  ok: boolean
  detail: string
  fix?: string
}

export interface DoctorDeps {
  platform: string
  run: (cmd: string, args: string[]) => Promise<string>
  helpersDir: string
  isExecutable: (file: string) => boolean
}

const MIN_XCODE_MAJOR = 26
const HELPERS = ['touch-helper', 'keyboard-helper', 'rotation-helper']

function defaultHelpersDir(): string {
  const pkg = fileURLToPath(import.meta.resolve('@tapflowio/ios-agent/package.json'))
  return path.join(path.dirname(pkg), 'bin')
}

const defaultDeps = (): DoctorDeps => ({
  platform: process.platform,
  run: async (cmd, args) => (await execFileAsync(cmd, args, { timeout: 30_000 })).stdout,
  helpersDir: defaultHelpersDir(),
  isExecutable: (file) => {
    try { fs.accessSync(file, fs.constants.X_OK); return true } catch { return false }
  },
})

export async function runChecks(deps: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = []
  if (deps.platform !== 'darwin') {
    return [{ label: 'macOS', ok: false, detail: `running on ${deps.platform}`, fix: 'iOS simulators run only on macOS' }]
  }
  checks.push({ label: 'macOS', ok: true, detail: 'ok' })

  try {
    checks.push({ label: 'Xcode developer dir', ok: true, detail: (await deps.run('xcode-select', ['-p'])).trim() })
  } catch {
    checks.push({ label: 'Xcode developer dir', ok: false, detail: 'not set', fix: 'install Xcode, then: sudo xcode-select -s /Applications/Xcode.app' })
    return checks
  }

  try {
    const out = await deps.run('xcodebuild', ['-version'])
    const major = Number(/Xcode (\d+)/.exec(out)?.[1])
    const version = out.split('\n')[0].trim()
    checks.push(major >= MIN_XCODE_MAJOR
      ? { label: 'Xcode', ok: true, detail: version }
      : { label: 'Xcode', ok: false, detail: version, fix: `Xcode ${MIN_XCODE_MAJOR} or later is required` })
  } catch (e) {
    checks.push({ label: 'Xcode', ok: false, detail: (e as Error).message.split('\n')[0], fix: 'open Xcode once to accept the license: sudo xcodebuild -license accept' })
  }

  try {
    const runtimes = JSON.parse(await deps.run('xcrun', ['simctl', 'list', 'runtimes', '--json'])) as { runtimes: { name: string; platform?: string; isAvailable: boolean }[] }
    const ios = runtimes.runtimes.filter((r) => r.isAvailable && (r.platform === 'iOS' || r.name.startsWith('iOS')))
    checks.push(ios.length > 0
      ? { label: 'iOS runtime', ok: true, detail: ios.map((r) => r.name).join(', ') }
      : { label: 'iOS runtime', ok: false, detail: 'none installed', fix: 'xcodebuild -downloadPlatform iOS' })
    const devices = JSON.parse(await deps.run('xcrun', ['simctl', 'list', 'devices', 'available', '--json'])) as { devices: Record<string, unknown[]> }
    const count = Object.entries(devices.devices).filter(([k]) => k.includes('iOS')).reduce((n, [, v]) => n + v.length, 0)
    checks.push(count > 0
      ? { label: 'iOS simulators', ok: true, detail: `${count} available` }
      : { label: 'iOS simulators', ok: false, detail: 'none', fix: 'create one in Xcode (Window → Devices and Simulators)' })
  } catch (e) {
    checks.push({ label: 'simctl', ok: false, detail: (e as Error).message.split('\n')[0], fix: 'check the Xcode installation' })
  }

  const missing = HELPERS.filter((h) => !deps.isExecutable(path.join(deps.helpersDir, h)))
  checks.push(missing.length === 0
    ? { label: 'helper binaries', ok: true, detail: HELPERS.join(', ') }
    : { label: 'helper binaries', ok: false, detail: `missing or not executable: ${missing.join(', ')}`, fix: `chmod +x ${deps.helpersDir}/*` })
  return checks
}

export async function cmdDoctor(deps: DoctorDeps = defaultDeps()): Promise<number> {
  const checks = await runChecks(deps)
  for (const c of checks) {
    console.log(`${c.ok ? `${GREEN}✓` : `${RED}✗`}${R} ${c.label}: ${c.detail}`)
    if (!c.ok && c.fix) console.log(`  ${YELLOW}→ ${c.fix}${R}`)
  }
  return checks.every((c) => c.ok) ? 0 : 1
}
