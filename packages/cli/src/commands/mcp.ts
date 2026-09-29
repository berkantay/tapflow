import { DeviceContext, serveHttp, serveStdio } from '@tapflowio/mcp-server'

export async function cmdMcp(opts: { device?: string; http?: number; host?: string; lean?: boolean }): Promise<void> {
  const ctx = new DeviceContext({ defaultDevice: opts.device ?? process.env.TAPFLOW_DEVICE, lean: opts.lean })
  const shutdown = () => { ctx.closeAll(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  if (opts.http === undefined) {
    await serveStdio(ctx)
    return
  }
  const token = process.env.TAPFLOW_MCP_TOKEN
  if (!token) throw new Error('TAPFLOW_MCP_TOKEN is required with --http; clients send it as "Authorization: Bearer <token>"')
  const host = opts.host ?? '127.0.0.1'
  await serveHttp(ctx, { host, port: opts.http, token })
  process.stderr.write(`tapflow MCP listening on http://${host}:${opts.http}/mcp\n`)
}
