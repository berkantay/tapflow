import { readFileSync } from 'fs'
import { cac } from 'cac'
import { cmdBoot, cmdDevices, cmdInstall, cmdShutdown } from './commands/device.js'
import { cmdFlowRun } from './commands/flow-run.js'
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

  cli.command('flow <action> [...files]', 'flow run <files...>: replay flow files on a simulator')
    .option('--device <device>', 'Simulator name or UDID (default: the only booted one)')
    .option('--app <path>', 'Install this app before running')
    .option('--junit <file>', 'Write a JUnit XML report')
    .option('--artifacts <dir>', 'Where failure screenshots go (default .tapflow/artifacts)')
    .option('--timeout <seconds>', 'Default step timeout')
    .option('--lean', 'Boot in lean mode')
    .action(async (action: string, files: string[], opts) => {
      if (action !== 'run') throw new Error(`unknown flow action "${action}"; usage: tapflow flow run <files...>`)
      exitWith(await cmdFlowRun(files, opts))
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
