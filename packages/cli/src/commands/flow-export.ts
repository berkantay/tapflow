import fs from 'fs'
import path from 'path'
import { recordingToFlow } from '@tapflowio/flow-runner'
import type { RecordedAction } from '@tapflowio/ios-agent'

/** Turn a recording's `.actions.json` into a flow `.yaml`. */
export function cmdFlowExport(files: string[], opts: { name?: string; out?: string; appId?: string }): number {
  if (files.length !== 1) {
    console.error('usage: tapflow flow export <recording.mp4.actions.json> [--name <name>] [--out flow.yaml]')
    return 2
  }
  const file = files[0]
  const log = JSON.parse(fs.readFileSync(file, 'utf-8')) as { actions?: RecordedAction[] }
  if (!Array.isArray(log.actions)) {
    console.error(`${file} is not a recording's actions file`)
    return 2
  }
  const name = opts.name ?? path.basename(file).replace(/(\.mp4|\.mov)?\.actions\.json$/, '')
  const flow = recordingToFlow(log.actions, { name, appId: opts.appId })
  if (!opts.out) {
    process.stdout.write(flow.yaml)
  } else {
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true })
    fs.writeFileSync(opts.out, flow.yaml)
    console.error(`wrote ${opts.out}: ${flow.steps} steps, ${flow.skipped} actions kept as comments`)
  }
  return 0
}
