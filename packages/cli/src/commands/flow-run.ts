import fs from 'fs'
import path from 'path'
import { parseFlow, runFlow, SimulatorDriver, toJUnitXml, type Flow, type FlowResult } from '@tapflowio/flow-runner'
import { Simulator } from '@tapflowio/ios-agent'

export interface FlowRunOptions {
  device?: string
  app?: string
  junit?: string
  artifacts?: string
  timeout?: number
  lean?: boolean
}

export const EXIT_FLOW_FAILED = 1
export const EXIT_ENV_ERROR = 2
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000

class FlowRunEnvironmentError extends Error {}

function envFail(message: string): never {
  throw new FlowRunEnvironmentError(message)
}

async function pickDevice(device: string | undefined): Promise<string> {
  if (device) return (await Simulator.find(device)).id
  const booted = (await Simulator.list()).filter((d) => d.status === 'booted')
  if (booted.length === 1) return booted[0].id
  envFail(booted.length === 0
    ? 'no simulator is booted; pass --device <name or UDID> to boot one'
    : `several simulators are booted (${booted.map((d) => d.name).join(', ')}); pick one with --device`)
}

/**
 * Replay flow files on one simulator. Exit code 1 means a flow failed on the product side (a
 * selector or an assertion); 2 means the run could not be carried out (no device, a simulator
 * fault), so a CI job can tell a broken build from a broken runner.
 */
export async function cmdFlowRun(files: string[], opts: FlowRunOptions): Promise<number> {
  let sim: Simulator | undefined
  try {
    if (files.length === 0) envFail('no flow files given; usage: tapflow flow run flows/*.yaml')
    if (opts.timeout !== undefined && !(Number.isFinite(opts.timeout) && opts.timeout > 0 && opts.timeout <= MAX_TIMEOUT_SECONDS)) {
      envFail(`--timeout must be a positive number of seconds no greater than ${MAX_TIMEOUT_SECONDS}`)
    }
    const flows: Flow[] = files.map((file) => {
      let text: string
      try {
        text = fs.readFileSync(file, 'utf-8')
      } catch (e) {
        envFail(`cannot read ${file}: ${(e as Error).message}`)
      }
      try {
        return parseFlow(text, file)
      } catch (e) {
        envFail((e as Error).message)
      }
    })

    sim = new Simulator(await pickDevice(opts.device), { lean: opts.lean })
    const device = await sim.boot()
    console.log(`device: ${device.name} (${device.osVersion ?? '?'})`)
    if (opts.app) {
      console.log(`installing ${opts.app}...`)
      await sim.install(opts.app)
    }

    const engineOpts = opts.timeout !== undefined ? { defaultTimeoutMs: Math.round(opts.timeout * 1000) } : {}
    const results: FlowResult[] = []
    for (const [i, flow] of flows.entries()) {
      process.stdout.write(`▶ ${flow.name} `)
      const result = await runFlow(flow, new SimulatorDriver(sim, flow.appId), engineOpts)
      results.push(result)
      console.log(result.status === 'passed' ? `✓ (${(result.durationMs / 1000).toFixed(1)}s)` : '✗')
      if (result.status === 'failed') {
        console.error(`  ${result.failureMessage}`)
        if (result.failureScreenshot) {
          const dir = opts.artifacts ?? path.join('.tapflow', 'artifacts')
          fs.mkdirSync(dir, { recursive: true })
          const shot = path.join(dir, `${String(i + 1).padStart(2, '0')}-${flow.name.replace(/[^\w.-]+/g, '_')}-failure.png`)
          fs.writeFileSync(shot, result.failureScreenshot)
          console.error(`  screenshot: ${shot}`)
        }
      }
    }

    if (opts.junit) {
      fs.mkdirSync(path.dirname(path.resolve(opts.junit)), { recursive: true })
      fs.writeFileSync(opts.junit, toJUnitXml(results))
      console.log(`JUnit report: ${opts.junit}`)
    }
    const failed = results.filter((r) => r.status === 'failed')
    console.log(`\n${results.length - failed.length}/${results.length} flows passed`)
    if (failed.length === 0) return 0
    return failed.every((r) => r.failureKind === 'environment') ? EXIT_ENV_ERROR : EXIT_FLOW_FAILED
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    return EXIT_ENV_ERROR
  } finally {
    sim?.close()
  }
}
