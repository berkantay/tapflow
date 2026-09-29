#!/usr/bin/env node
import { parseArgs } from 'util'
import { DeviceContext } from './devices.js'
import { serveHttp, serveStdio } from './server.js'

const { values } = parseArgs({
  options: {
    device: { type: 'string' },
    http: { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' },
    lean: { type: 'boolean', default: false },
  },
})

const ctx = new DeviceContext({ defaultDevice: values.device ?? process.env['TAPFLOW_DEVICE'], lean: values.lean })
const shutdown = () => { ctx.closeAll(); process.exit(0) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

if (values.http) {
  const token = process.env['TAPFLOW_MCP_TOKEN']
  if (!token) {
    process.stderr.write('TAPFLOW_MCP_TOKEN is required with --http; clients send it as "Authorization: Bearer <token>"\n')
    process.exit(1)
  }
  const port = Number(values.http)
  await serveHttp(ctx, { host: values.host!, port, token })
  process.stderr.write(`tapflow MCP listening on http://${values.host}:${port}/mcp\n`)
} else {
  await serveStdio(ctx)
}
