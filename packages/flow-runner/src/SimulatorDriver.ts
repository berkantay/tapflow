import { PlatformError, ValidationError } from '@tapflowio/agent-core'
import type { Simulator } from '@tapflowio/ios-agent'
import type { FlowDriver } from './engine.js'
import { EnvironmentStepError, markEnvironmentFailure, TransientQueryError } from './errors.js'

// Failures that belong to the flow rather than the simulator: a key the flow names wrongly, or text
// typed with nothing focused. Everything else a driver call throws is the environment.
function isProductFailure(e: unknown): boolean {
  return e instanceof ValidationError || (e instanceof PlatformError && /keyboard focus/.test(e.message))
}

/** Drives a flow on one simulator, for the app named by the flow's `appId`. */
export class SimulatorDriver implements FlowDriver {
  constructor(
    private readonly sim: Simulator,
    private readonly appId?: string,
  ) {}

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof Error && !isProductFailure(e)) throw markEnvironmentFailure(e)
      throw e
    }
  }

  private app(): string {
    if (!this.appId) throw new EnvironmentStepError('This flow needs an app: set "appId" in the flow')
    return this.appId
  }

  async queryUITree() {
    try {
      return await this.sim.uiTree(this.app())
    } catch (e) {
      // The app is not in the foreground yet (right after a launch, say): poll again until the step deadline.
      if (e instanceof PlatformError && /unexpected response/.test(e.message)) throw new TransientQueryError(e.message, { cause: e })
      if (e instanceof Error) throw markEnvironmentFailure(e)
      throw e
    }
  }

  tap(x: number, y: number) { return this.guard(() => this.sim.tap(x, y)) }
  swipe(from: [number, number], to: [number, number], durationMs: number) { return this.guard(() => this.sim.swipe(from, to, durationMs)) }
  inputText(text: string) { return this.guard(() => this.sim.typeText(text, this.app())) }
  pressKey(code: string) { return this.guard(() => this.sim.pressKey(code, this.app())) }
  openUrl(url: string) { return this.guard(() => this.sim.openUrl(url)) }
  launchApp() { return this.guard(() => this.sim.launch(this.app())) }
  clearState(appId: string) { return this.guard(() => this.sim.clearAppData(appId)) }
  screenshot() { return this.guard(() => this.sim.screenshot()) }
}
