# mcp-server — AGENTS.md

- `devices.ts`: which simulator a tool acts on. One `Simulator` per UDID is kept for the life of the
  process, so its touch channel and foreground app survive between tool calls.
- `tools.ts`: every tool returns its failure as a tool error (`isError`) instead of throwing, so the
  agent reads the cause and can re-observe the screen.
- `server.ts`: stdio, or stateless streamable HTTP. Over HTTP each request gets its own protocol
  server while the device context is shared; the bearer token is compared in constant time.
