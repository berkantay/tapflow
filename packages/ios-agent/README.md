# @tapflowio/ios-agent

Drive an iOS simulator directly from Node: boot, install and launch apps, tap, swipe, type,
press hardware buttons, take screenshots, and read the accessibility tree.

```ts
import { Simulator } from '@tapflowio/ios-agent'

const device = await Simulator.find('iPhone 17 Pro')
const sim = new Simulator(device.id)
await sim.boot()
await sim.launch('com.apple.Preferences')

const tree = await sim.uiTree()
const general = tree.find((e) => e.identifier === 'com.apple.settings.general')!
const { x, y, width, height } = general.frame
await sim.tap(x + width / 2, y + height / 2)

await sim.typeText('héllo 👋')   // into the focused field
await sim.pressButton('home')
const png = await sim.screenshot()
sim.close()
```

Coordinates are normalized 0-1 against the screen, the same space the tree reports frames in.
The first `uiTree()`, `typeText()` or `pressKey()` builds a small XCUITest runner (about 30s, cached).

Requires macOS with Xcode 26 or later and an iOS simulator runtime. See `AGENTS.md` for how each
kind of input reaches the device.
