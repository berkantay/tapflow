# @tapflowio/flow-runner

Deterministic YAML flows for iOS simulators: author a flow once, replay it on every build with no
model in the loop.

```yaml
name: open-general
appId: com.apple.Preferences
steps:
  - launchApp
  - tapOn:
      id: com.apple.settings.general
  - assertVisible: About
```

Steps: `clearState`, `launchApp`, `stopApp`, `tapOn`, `inputText`, `pressKey`, `swipe`, `scroll`, `openUrl`,
`assertVisible`, `assertNotVisible`. A selector is a string (identifier, then exact label, then
part of a label; the partial match ignores case) or `{ text, id, label, role, index, timeout, system,
optional }`. `stopApp` then `launchApp` starts the app cold. A tap that matches
several elements fails and names them rather than guessing.

- `system: true` matches only a system alert's elements ("Open in …?", permission prompts), never
  the app's own: an illustration that says "Allow" is not the Allow button.
- `optional: true` (tapOn only) taps the element if it shows up within its timeout (3s by default)
  and otherwise passes with "not present": for one-time screens and alerts. It gives up sooner once
  the screen has stopped changing for a second. An ambiguous match or an
  environment failure still fails.

```ts
import { parseFlow, runFlow, SimulatorDriver } from '@tapflowio/flow-runner'
const flow = parseFlow(yamlText, 'open-general.yaml')
const result = await runFlow(flow, new SimulatorDriver(sim, flow.appId))
```

`result.failureKind` is `product` (a selector or assertion) or `environment` (the simulator, its
input channel, or the UI-tree runner), so CI can tell a broken build from a broken runner.

`recordingToFlow(actions, { name })` turns a recording's action log into flow YAML (validated with
the parser): taps found by selector become `tapOn` steps (system alert taps become optional and
alert-only), waits become `assertVisible` / `assertNotVisible`, and coordinate taps, hardware
buttons and marks are kept as comments to fill in. URLs are redacted again on the way out.
