import type { Device } from '@tapflowio/agent-core'
import { ValidationError } from '@tapflowio/agent-core'
import { Simulator } from '@tapflowio/ios-agent'

export interface DeviceContextOptions {
  /** Name or UDID to use when a tool names no device and none has been booted here. */
  defaultDevice?: string
  lean?: boolean
  list?: () => Promise<Device[]>
  find?: (nameOrUdid: string) => Promise<Device>
  create?: (udid: string) => Simulator
}

/**
 * Which simulator a tool acts on. A tool may name one; otherwise it is the device most recently
 * booted or used here, then the configured default, then the only booted simulator on the Mac.
 * One `Simulator` per UDID is kept so its touch channel and foreground app survive between calls.
 */
export class DeviceContext {
  private readonly sims = new Map<string, Simulator>()
  private active: string | null = null
  private readonly list: () => Promise<Device[]>
  private readonly find: (nameOrUdid: string) => Promise<Device>
  private readonly create: (udid: string) => Simulator

  constructor(private readonly options: DeviceContextOptions = {}) {
    this.list = options.list ?? (() => Simulator.list())
    this.find = options.find ?? ((q) => Simulator.find(q))
    this.create = options.create ?? ((udid) => new Simulator(udid, { lean: options.lean }))
  }

  devices(): Promise<Device[]> {
    return this.list()
  }

  async resolve(device?: string): Promise<Simulator> {
    const udid = await this.resolveUdid(device)
    this.active = udid
    let sim = this.sims.get(udid)
    if (!sim) {
      sim = this.create(udid)
      this.sims.set(udid, sim)
    }
    return sim
  }

  closeAll(): void {
    for (const sim of this.sims.values()) sim.close()
    this.sims.clear()
  }

  private async resolveUdid(device?: string): Promise<string> {
    if (device) return (await this.find(device)).id
    if (this.active) return this.active
    if (this.options.defaultDevice) return (await this.find(this.options.defaultDevice)).id
    const booted = (await this.list()).filter((d) => d.status === 'booted')
    if (booted.length === 1) return booted[0].id
    throw new ValidationError(
      booted.length === 0
        ? 'No simulator is booted: call boot_device with a device name or UDID from list_devices'
        : `${booted.length} simulators are booted; pass "device" (name or UDID) to choose one`,
    )
  }
}
