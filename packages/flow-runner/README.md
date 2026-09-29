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

Steps: `clearState`, `launchApp`, `tapOn`, `inputText`, `pressKey`, `swipe`, `scroll`, `openUrl`,
`assertVisible`, `assertNotVisible`. A selector is a string (identifier, then exact label, then
part of a label) or `{ id, label, role, index, timeout }`. A tap that matches several elements
fails and names them rather than guessing.

```ts
import { parseFlow, runFlow, SimulatorDriver } from '@tapflowio/flow-runner'
const flow = parseFlow(yamlText, 'open-general.yaml')
const result = await runFlow(flow, new SimulatorDriver(sim, flow.appId))
```

`result.failureKind` is `product` (a selector or assertion) or `environment` (the simulator, its
input channel, or the UI-tree runner), so CI can tell a broken build from a broken runner.
