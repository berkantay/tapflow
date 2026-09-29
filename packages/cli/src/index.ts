import { createCli } from './program.js'

process.on('unhandledRejection', (err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})

const cli = createCli()
cli.parse(process.argv, { run: false })
if (!cli.matchedCommand && !cli.options.help && !cli.options.version) {
  if (cli.args.length > 0) {
    console.error(`error: unknown command "${cli.args.join(' ')}"`)
    process.exitCode = 1
  }
  cli.outputHelp()
} else await Promise.resolve(cli.runMatchedCommand()).catch((e: unknown) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
})
