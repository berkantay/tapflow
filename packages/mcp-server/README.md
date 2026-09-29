# @tapflowio/mcp-server

MCP server that lets an LLM agent drive iOS simulators.

```jsonc
// .mcp.json
{ "mcpServers": { "tapflow": { "command": "tapflow", "args": ["mcp", "--device", "iPhone 17 Pro"] } } }
```

Or over HTTP, for an agent on another machine: `TAPFLOW_MCP_TOKEN=… tapflow mcp --http 7070`
(binds 127.0.0.1 unless `--host` is given; every request needs `Authorization: Bearer <token>`).

Tools: `list_devices`, `boot_device`, `shutdown_device`, `install_app`, `launch_app`, `open_url`,
`query_ui_tree`, `screenshot`, `tap`, `tap_element`, `swipe`, `type_text`, `press_key`,
`press_button`, `run_flow`, `start_recording`, `mark_recording`, `stop_recording`.

- Coordinates are normalized 0-1, the space `query_ui_tree` reports frames in.
- `tap_element` taps by identifier or label and refuses an ambiguous match, naming the candidates.
- Tools act on the device last booted or named; `--device` / `TAPFLOW_DEVICE` sets the default.
- `start_recording` … `stop_recording` records the screen and logs every action (and `run_flow` step)
  with its time in the video. `stop_recording` returns the full video, a small shareable export with
  tap markers, and a timeline; `mark_recording` adds a note such as "crash reproduced".
