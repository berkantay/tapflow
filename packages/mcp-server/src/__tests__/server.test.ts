import { describe, it, expect, afterEach } from 'vitest'
import type { AddressInfo } from 'net'
import type http from 'http'
import { DeviceContext } from '../devices.js'
import { serveHttp } from '../server.js'

let server: http.Server | undefined
afterEach(() => { server?.close(); server = undefined })

async function start() {
  const ctx = new DeviceContext({ list: async () => [], find: async () => { throw new Error('none') } })
  server = await serveHttp(ctx, { host: '127.0.0.1', port: 0, token: 'secret' })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
}

const initialize = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
}
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }

describe('HTTP transport', () => {
  it('rejects a request without the bearer token', async () => {
    const url = await start()
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(initialize) })
    expect(r.status).toBe(401)
  })

  it('rejects a wrong token', async () => {
    const url = await start()
    const r = await fetch(url, { method: 'POST', headers: { ...headers, authorization: 'Bearer nope' }, body: JSON.stringify(initialize) })
    expect(r.status).toBe(401)
  })

  it('initializes with the right token', async () => {
    const url = await start()
    const r = await fetch(url, { method: 'POST', headers: { ...headers, authorization: 'Bearer secret' }, body: JSON.stringify(initialize) })
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('"name":"tapflow"')
  })
})
