# AGENTS.md

A slim fork of [tapflow](https://github.com/jo-duchan/tapflow) for agents: drive iOS simulators
through their UI tree and touch input, replay deterministic flows, and record what happened.

## Scope

- **iOS Simulator only.** Android, the dashboard, the relay, streaming, audio and network control were removed.
- **Agent-first.** An LLM agent (via the MCP server) or a flow file (via the CLI) drives the device.
- **Recordings are an output.** A run should be able to leave a video behind for review.

## Packages

| Package | Role |
|---|---|
| `ios-agent` | `Simulator`: boot, apps, touch, typing, buttons, screenshots, UI tree |
| `flow-runner` | Deterministic YAML flow engine and `SimulatorDriver` |
| `mcp-server` | MCP tools for LLM agents, stdio or HTTP |
| `cli` | `tapflow` command |
| `agent-core` | Shared types, errors, logging |

There is no relay: the MCP server and the flow runner drive `Simulator` in-process. Package-level
notes live in each package's `AGENTS.md`.

## Rules

- TypeScript throughout, no `any`, Node.js >= 22.
- Verify a root cause with code, logs, or tests before fixing.
- Keep changes in scope and follow each file's existing conventions.
- Run tests with `pnpm --filter <pkg> test`, never `npx vitest` (npm rewrites the root
  `package.json` and lockfile on its way through).
- After test runs, check for leftover vitest processes: `pkill -f vitest`.
- Keep this repo generic: no references to any specific company, product, or internal system.
