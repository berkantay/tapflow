# tapflow (slim)

A slim fork of [tapflow](https://github.com/jo-duchan/tapflow) for agents. It drives iOS
simulators through their accessibility tree and direct touch input, replays deterministic flows,
and (planned) records each run to video.

What was removed from upstream: Android support, the browser dashboard, the relay server and its
accounts, streaming, audio, network control, the docs site, and the repository tooling around them. The upstream history is kept; `upstream` points at the original.

## Requirements

- macOS 26 or 27 with Xcode 26 or 27 and an iOS Simulator runtime
- Node.js >= 22, pnpm 9

## Use

```sh
pnpm install && pnpm build
node packages/cli/bin/tapflow.js doctor
node packages/cli/bin/tapflow.js flow run flows/*.yaml --device "iPhone 17 Pro"
node packages/cli/bin/tapflow.js mcp --device "iPhone 17 Pro"     # MCP over stdio
```

## Develop

```sh
pnpm install
pnpm build
pnpm test
```

## Packages

| Package | Role |
|---|---|
| `packages/ios-agent` | `Simulator`: boot, apps, touch, typing, buttons, screenshots, UI tree |
| `packages/flow-runner` | Deterministic YAML flows and the simulator driver |
| `packages/mcp-server` | MCP tools for LLM agents (stdio or HTTP) |
| `packages/cli` | `tapflow` command |
| `packages/agent-core` | Shared types, errors, logging |

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for third-party notices.
