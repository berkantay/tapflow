import http from 'http'
import { timingSafeEqual } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { DeviceContext } from './devices.js'
import { registerTools } from './tools.js'

const VERSION = '0.1.0'

export function createServer(ctx: DeviceContext): McpServer {
  const server = new McpServer({ name: 'tapflow', version: VERSION })
  registerTools(server, ctx)
  return server
}

export async function serveStdio(ctx: DeviceContext): Promise<void> {
  await createServer(ctx).connect(new StdioServerTransport())
}

function authorized(req: http.IncomingMessage, token: string): boolean {
  const given = Buffer.from(req.headers.authorization ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/**
 * Streamable HTTP, stateless: each request gets its own protocol server, while the device context
 * (and so each simulator's touch channel and foreground app) is shared across them. Every request
 * must carry `Authorization: Bearer <token>`.
 */
export function serveHttp(ctx: DeviceContext, opts: { host: string; port: number; token: string }): Promise<http.Server> {
  const httpServer = http.createServer((req, res) => {
    if (!req.url?.startsWith('/mcp')) { res.writeHead(404).end(); return }
    if (!authorized(req, opts.token)) { res.writeHead(401).end('unauthorized'); return }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      void (async () => {
        let body: unknown
        try {
          body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
        } catch {
          res.writeHead(400).end('invalid JSON')
          return
        }
        const server = createServer(ctx)
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        res.on('close', () => { void transport.close(); void server.close() })
        await server.connect(transport)
        await transport.handleRequest(req, res, body)
      })().catch((e: unknown) => {
        if (!res.headersSent) res.writeHead(500).end(e instanceof Error ? e.message : String(e))
      })
    })
  })
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(opts.port, opts.host, () => resolve(httpServer))
  })
}
