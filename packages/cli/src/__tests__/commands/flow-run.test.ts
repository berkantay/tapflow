import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const sim = vi.hoisted(() => ({
  boot: vi.fn(async () => ({ id: 'U', name: 'iPhone', platform: 'ios', status: 'booted', osVersion: 'iOS 26.0' })),
  install: vi.fn(async () => {}),
  close: vi.fn(),
}))
const runFlow = vi.hoisted(() => vi.fn())

vi.mock('@tapflowio/ios-agent', () => ({
  Simulator: Object.assign(vi.fn(function () { return sim }), {
    list: vi.fn(async () => [{ id: 'U', name: 'iPhone', platform: 'ios', status: 'booted' }]),
    find: vi.fn(async () => ({ id: 'U', name: 'iPhone', platform: 'ios', status: 'booted' })),
  }),
}))
vi.mock('@tapflowio/flow-runner', async (orig) => ({ ...(await orig<typeof import('@tapflowio/flow-runner')>()), runFlow }))

const { cmdFlowRun, EXIT_ENV_ERROR, EXIT_FLOW_FAILED } = await import('../../commands/flow-run')

function flowFile(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-')), 'login.yaml')
  fs.writeFileSync(file, 'name: login\nappId: com.example.app\nsteps:\n  - launchApp\n')
  return file
}

describe('flow run', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(process.stdout, 'write').mockImplementation(() => true) })

  it('exits 2 when no files are given', async () => {
    expect(await cmdFlowRun([], {})).toBe(EXIT_ENV_ERROR)
  })

  it('exits 0 when every flow passes', async () => {
    runFlow.mockResolvedValueOnce({ name: 'login', status: 'passed', steps: [], durationMs: 5 })
    expect(await cmdFlowRun([flowFile()], {})).toBe(0)
    expect(sim.boot).toHaveBeenCalled()
    expect(sim.close).toHaveBeenCalled()
  })

  it('exits 1 on a product failure', async () => {
    runFlow.mockResolvedValueOnce({ name: 'login', status: 'failed', steps: [], durationMs: 5, failureKind: 'product', failureMessage: 'not found' })
    expect(await cmdFlowRun([flowFile()], {})).toBe(EXIT_FLOW_FAILED)
  })

  it('exits 2 when every failure is environmental', async () => {
    runFlow.mockResolvedValueOnce({ name: 'login', status: 'failed', steps: [], durationMs: 5, failureKind: 'environment', failureMessage: 'input channel' })
    expect(await cmdFlowRun([flowFile()], {})).toBe(EXIT_ENV_ERROR)
  })

  it('installs the app before running when asked', async () => {
    runFlow.mockResolvedValueOnce({ name: 'login', status: 'passed', steps: [], durationMs: 5 })
    await cmdFlowRun([flowFile()], { app: '/builds/App.app' })
    expect(sim.install).toHaveBeenCalledWith('/builds/App.app')
  })
})
