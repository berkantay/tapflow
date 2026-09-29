import type { Device } from '@tapflowio/agent-core'
import { Simulator } from '@tapflowio/ios-agent'

export async function cmdDevices(opts: { json?: boolean }): Promise<void> {
  const devices = await Simulator.list()
  if (opts.json) {
    console.log(JSON.stringify(devices, null, 2))
    return
  }
  if (devices.length === 0) {
    console.log('No simulators available. Create one in Xcode, or run `tapflow doctor`.')
    return
  }
  const rows = devices.map((d: Device) => [d.name, d.osVersion ?? '', d.status, d.id])
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i].length)))
  for (const r of rows) console.log(`${r[0].padEnd(widths[0])}  ${r[1].padEnd(widths[1])}  ${r[2].padEnd(widths[2])}  ${r[3]}`)
}

export async function cmdBoot(device: string, opts: { erase?: boolean; lean?: boolean }): Promise<void> {
  const target = await Simulator.find(device)
  const sim = new Simulator(target.id, { lean: opts.lean })
  const started = Date.now()
  try {
    const booted = await sim.boot({ erase: opts.erase })
    console.log(`Booted ${booted.name} (${booted.osVersion ?? '?'}, ${booted.id}) in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  } finally {
    sim.close()
  }
}

export async function cmdShutdown(device: string): Promise<void> {
  const target = await Simulator.find(device)
  const sim = new Simulator(target.id)
  await sim.shutdown()
  console.log(`Shut down ${target.name} (${target.id})`)
}

export async function cmdInstall(device: string, appPath: string): Promise<void> {
  const target = await Simulator.find(device)
  const sim = new Simulator(target.id)
  try {
    await sim.install(appPath)
    console.log(`Installed ${appPath} on ${target.name}`)
  } finally {
    sim.close()
  }
}
