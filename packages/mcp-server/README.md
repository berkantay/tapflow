# @tapflowio/mcp-server

MCP server that lets an LLM agent drive iOS simulators.

```jsonc
// .mcp.json
{ "mcpServers": { "tapflow": { "command": "tapflow", "args": ["mcp", "--device", "iPhone 17 Pro"] } } }
```

Or over HTTP, for an agent on another machine: `TAPFLOW_MCP_TOKEN=… tapflow mcp --http 7070`
(binds 127.0.0.1 unless `--host` is given; every request needs `Authorization: Bearer <token>`).

Tools:

| Group | Tools |
|---|---|
| Devices | `list_devices`, `boot_device`, `shutdown_device` |
| Apps | `install_app`, `launch_app`, `terminate_app`, `open_url`, `write_defaults` |
| Look | `query_ui_tree`, `screenshot`, `wait_for` |
| Act | `tap_element`, `tap`, `swipe`, `type_text`, `press_key`, `press_button` |
| Evidence | `start_recording`, `mark_recording`, `stop_recording` |
| Flows | `export_flow`, `run_flow` |

- Coordinates are normalized 0-1, the space `query_ui_tree` reports frames in.
- `tap_element` taps by `id` (exact identifier), `label` (exact label) or `text` (identifier, exact
  label, then part of a label), and refuses an ambiguous match, naming the candidates.
- System alerts ("Open in …?", permission prompts) are drawn by SpringBoard, not the app.
  `query_ui_tree` reports one as `systemAlert` with its buttons, and while one is up `tap_element`
  taps only its buttons, naming them if the selector matches something else.
- Tools act on the device last booted or named; `--device` / `TAPFLOW_DEVICE` sets the default.
- `start_recording` … `stop_recording` records the screen and logs every action (and `run_flow` step)
  with its time in the video. `stop_recording` returns the full video, a small shareable export with
  tap markers, and a timeline; `mark_recording` adds a note such as "crash reproduced".
- `wait_for` polls for an element to appear (or, with `gone`, to disappear) instead of sleeping.
- `export_flow` turns a recording's actions into a flow: taps made with `tap_element` become `tapOn`
  steps, and what a flow cannot express stays as comments. Explore once, then `run_flow` for free.
- `open_url` replies with the URL redacted; with `urlFile` the link (a login token, say) is read from
  a file and never enters the conversation at all.
- `wait_for` successes are logged in a recording, so `export_flow` turns them into assertions.
