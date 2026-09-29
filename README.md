# tapflow (slim)

A slim fork of [tapflow](https://github.com/jo-duchan/tapflow) for agents. It drives iOS
simulators through their accessibility tree and direct touch input, replays deterministic flows,
and (planned) records each run to video.

What was removed from upstream: Android support, the browser dashboard, the docs site, and the
repository tooling around them. The upstream history is kept; `upstream` points at the original.

## Requirements

- macOS 26 or 27 with Xcode 26 or 27 and an iOS Simulator runtime
- Node.js >= 22, pnpm 9

## Develop

```sh
pnpm install
pnpm build
pnpm test
```

## Packages

| Package | Role |
|---|---|
| `packages/ios-agent` | Simulator control: touch injection, UI tree, simctl |
| `packages/mcp-server` | MCP tools for LLM agents |
| `packages/flow-runner` | Deterministic YAML flow engine |
| `packages/cli` | `tapflow` command |
| `packages/relay` | WebSocket hub between the agent and clients |
| `packages/agent-core`, `packages/protocol` | Shared interfaces and message types |

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for third-party notices.
