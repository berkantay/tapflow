import { readFileSync } from 'fs'
import { cac } from 'cac'
import { cmdBoot, cmdDevices, cmdInstall, cmdShutdown } from './commands/device.js'
import { cmdFlowRun } from './commands/flow-run.js'
import { cmdFlowExport } from './commands/flow-export.js'
import { cmdMcp } from './commands/mcp.js'
import { cmdDoctor } from './commands/doctor.js'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string }

function exitWith(code: number): void {
  process.exitCode = code
}

export function createCli() {
  const cli = cac('tapflow')

  cli.command('devices', 'List iOS simulators').option('--json', 'Print JSON').action(cmdDevices)

  cli.command('boot <device>', 'Boot a simulator (name or UDID) and wait until it is up')
    .option('--erase', 'Erase all content and settings first')
    .option('--lean', 'Disable background services the simulator does not need')
    .action(cmdBoot)

  cli.command('shutdown <device>', 'Shut a simulator down').action(cmdShutdown)

  cli.command('install <device> <path>', 'Install a simulator .app, or a .zip / .tar.gz containing one').action(cmdInstall)

  cli.command('flow <action> [...files]', 'flow run <files...>: replay flows; flow export <actions.json>: turn a recording into a flow')
    .option('--device <device>', 'Simulator name or UDID (default: the only booted one)')
    .option('--app <path>', 'Install this app before running')
    .option('--junit <file>', 'Write a JUnit XML report')
    .option('--artifacts <dir>', 'Where failure screenshots go (default .tapflow/artifacts)')
    .option('--timeout <seconds>', 'Default step timeout')
    .option('--lean', 'Boot in lean mode')
    .option('--record <dir>', 'Record each flow: full-size .mp4, a shareable .web.mp4 with tap markers, and a timeline')
    .option('--video-width <px>', 'Width of the shareable video (default 600)')
    .option('--name <name>', 'flow export: the flow name (default: the actions file name)')
    .option('--out <file>', 'flow export: where to write the .yaml (default: stdout)')
    .option('--app-id <bundleId>', 'flow export: the app under test (default: the first app launched)')
    .action(async (action: string, files: string[], opts) => {
      if (action === 'run') return exitWith(await cmdFlowRun(files, opts))
      if (action === 'export') return exitWith(cmdFlowExport(files, opts))
      throw new Error(`unknown flow action "${action}"; usage: tapflow flow run <files...> | tapflow flow export <actions.json>`)
    })

  cli.command('mcp', 'Run the MCP server (stdio, or HTTP with --http)')
    .option('--device <device>', 'Default simulator (also TAPFLOW_DEVICE)')
    .option('--http <port>', 'Serve streamable HTTP on this port; requires TAPFLOW_MCP_TOKEN')
    .option('--host <host>', 'HTTP bind address (default 127.0.0.1)')
    .option('--lean', 'Boot devices in lean mode')
    .action(cmdMcp)

  cli.command('doctor', 'Check that this Mac can run simulators').action(async () => exitWith(await cmdDoctor()))

  cli.help()
  cli.version(version)
  return cli
}
