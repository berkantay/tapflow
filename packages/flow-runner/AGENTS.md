# flow-runner — AGENTS.md

- `engine.ts` is driver-agnostic (`FlowDriver`); `SimulatorDriver` adapts `ios-agent`'s `Simulator`.
- Classification lives in the driver: a tree read while the app is still coming to the foreground is
  a `TransientQueryError` (polled until the step deadline); simulator faults are marked environment;
  flow mistakes (unknown key, typing with nothing focused) stay product failures.
- `schema.ts` validates flows strictly: unknown keys are errors, never ignored.
