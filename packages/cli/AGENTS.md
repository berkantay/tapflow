# cli — AGENTS.md

- `program.ts` wires commands with `cac`. `cac` has no multi-word commands, so `flow run` is
  `flow <action>` dispatched on `action`.
- Commands return exit codes rather than calling `process.exit`, so they stay testable.
- `doctor` takes its dependencies (`platform`, `run`, `helpersDir`, `isExecutable`) as an argument.
