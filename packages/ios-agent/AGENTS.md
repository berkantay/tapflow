# ios-agent — AGENTS.md

`Simulator` drives one iOS simulator directly: boot, apps, touch, typing, hardware buttons,
screenshots, and the accessibility tree. No WebDriverAgent, no relay.

## How input reaches the device

| What | Path | Why |
|---|---|---|
| Tap, swipe, hardware buttons | `touch-helper` (SimulatorKit HID) | Direct injection; no Simulator.app window needed |
| Typing and named keys | the XCUITest runner's `/type` and `/key` | Handles any Unicode, and never touches the pasteboard |
| UI tree | the XCUITest runner's `/tree` | Window-agnostic accessibility snapshot |

Measured on Xcode 27 / iOS 26.0 while building this, and worth keeping in mind:

- **HID keyboard input does not arrive** there, and `keyboard-helper hide` exits 0 without taking
  effect, so the upstream pasteboard + Cmd+V typing path pasted nothing. Typing moved to XCUITest's
  `typeText`. The simulator pasteboard also syncs with the host's, so pasting would read or clobber
  the developer's clipboard.
- **Home is HID consumer usage 12/64**, as the home-button device chromes list it. The legacy button
  path (code 0) did nothing on a device without a home button.
- **Button usages are fixed** (power 12/48, volume 12/233 and 12/234, action 11/45, mute 11/46):
  identical in every iPhone and iPad chrome Xcode ships, so they are not read per device.
- **A tree read right after an app returns to the foreground** answers with an empty query chain for
  a moment; `uiTree()` retries that specific response for up to 3s.
- **A launch issued during the home animation** is swallowed by SpringBoard; callers wait a moment.
- **A runner left behind by another process** still answers `/health` on the shared port, so a new
  runner's readiness check would pass against it and then lose it. `XCUITreeReader` terminates any
  runner on the device and waits for the port before starting its own.
- **One tree runner per simulator, each on its own free port**, so several simulators (in one
  process or several) can be driven at once. xcodebuild passes the test process only variables
  prefixed `TEST_RUNNER_`, with the prefix stripped; that is how `TAPFLOW_TREE_PORT` reaches it.
  Each run gets its own `-resultBundlePath`, so two runners started together do not collide.
- **Tree lines are `, key: value` fields then flags** (`identifier`, `label`, `placeholderValue`,
  `value`, then `Selected`, `Keyboard Focused`, `Disabled`). The parser scans them in order; a
  label used to swallow a following `placeholderValue`, and an identifier followed by a flag was lost.

- **System alerts live in SpringBoard's tree**, not the app's: "Open in …?" from a URL, permission
  prompts. `systemAlert()` reads `com.apple.springboard` and returns the `Alert` (or `Sheet`) with the
  buttons and text inside its frame. With an app in front SpringBoard's tree is only the status bar,
  the switcher card and any alert, so the read is cheap (~100-200ms). Alerts can stack: two `openurl`
  calls leave two "Open in …?" alerts, and one tap clears only the top one.

## Recording

- `ScreenRecorder` runs `simctl io <udid> recordVideo --codec=h264 --force`. It waits for "Recording
  started" on stderr (that moment is t=0 of the action log and of the video), and stops with SIGINT,
  which makes simctl write the file and exit 0.
- The raw file is full resolution and variable frame rate (a frame only when the screen changes),
  about 0.5-0.7 MB a second while things move. `exportVideo` re-encodes to 600px wide, constant 30fps,
  `+faststart`, which comes out 20-30x smaller.
- Markers are `drawbox` squares, not captions: the Homebrew ffmpeg build has no `drawtext` or
  `subtitles` filter, so text is not burned in. The step timeline is written as text instead.
- One recording per simulator at a time; `close()` aborts one in progress, `shutdown()` finishes it.

After changing `xctest-runner/TreeRunner/*.swift`, delete `xctest-runner/build/` so the runner is
rebuilt on first use; `XCUITreeReader` only checks that a build exists.

### touch-helper interface

```bash
touch-helper <udid|booted>
```

Injects HID events directly into the iOS Simulator via `SimDeviceLegacyHIDClient` + IndigoHID.

stdin protocol (variable-length frames). Note the payload is **not** one layout: two of the four
rows carry integers and two carry floats, so reading the whole table as "two floats" is how a frame
ends up carrying garbage:

| types | size | payload |
|-------|------|---------|
| 1–3 | 9 bytes | `[type:u8][x:f32BE][y:f32BE]` |
| 4, 5, 10, 11 | 9 bytes | `[type:u8][a:u32BE][b:u32BE]` |
| 9 | 9 bytes | `[type:u8][modifiers:u8][pad:u8 ×3][usage:u32BE]` |
| 6–8 | 17 bytes | `[type:u8][x1:f32BE][y1:f32BE][x2:f32BE][y2:f32BE]` |

The **gesture role** column decides how a frame is treated when the helper process has been
replaced — see "Helper death and recovery" below. A frame that *continues* a gesture is delivered
only to the process that received the frame that opened it, and never revives a dead helper.

| type | action | gesture role |
|------|--------|--------------|
| 1 | touch start (x, y normalized 0–1) | opens |
| 2 | touch move (x, y) | continues — a move with no preceding down is not the gesture the tester made, and on the digitizer path the injected message is identical to a touch start's (`mask`/`contact` derive only from `isUp`), so a lone move lands as a fresh tap |
| 3 | touch end | continues — **injects `lastX/lastY`, ignoring the coordinates in the frame** |
| 4 | HID button (a=usagePage, b=usage) | self-contained — down→50ms→up completes inside the helper |
| 5 | legacy button (a=code) | self-contained — same |
| 6 | pinch start (x1,y1 = finger0, x2,y2 = finger1) | opens |
| 7 | pinch move | continues — as with type 2, a move with no preceding down is not the gesture the tester made, and that is the whole reason. Unlike type 2 the injected message *does* differ from a down (`injectTwoFinger` passes `direction` separately as well as deriving `eventType`), so the "reads as a fresh tap" argument does not apply here |
| 8 | pinch end | continues — **injects `pinchLast*`; `TouchHelper.pinchEnd()` sends all-zero coordinates precisely because the helper does not read them** |
| 9 | key press | self-contained — modifier down/up completes inside the frame |
| 10 | button down (a=usagePage, b=usage) | self-contained |
| 11 | button up (a=usagePage, b=usage) | self-contained — the helper keeps no record of which buttons are down, so a paired down is not a precondition |

When changing the Swift source, **always update both locations simultaneously**:
1. `src/touch-helper.swift` — stdin protocol changes
2. `src/TouchHelper.ts` — byte layout in the frame builders (`coordFrame` / `buttonFrame` / `twoFingerFrame`) and in `sendKey`, which builds its own

### Helper death and recovery

`touch-helper` can die on its own, and when it did the session accepted no further input for the
rest of its life while the screen kept updating — taps went nowhere and nothing said so (#482). `TouchHelper` now replaces the process **when it dies** rather than on
the next input — immediately, when the spawn budget below allows it — so the first tap after a death
does not pay the helper's start-up cost (`xcode-select -p`, two `dlopen`s, a `SimServiceContext`
device lookup).

Five things about it are easy to undo by accident:

- **Running is not usable, and the helper says which it is.** It announces itself on stderr once it
  holds its HID client and is about to read stdin (the `info: touch-helper ready` line it writes to
  stderr in `touch-helper.swift`). Measured on a real
  simulator: **186–247ms** after spawn (n=5), and a gesture written before that announcement lands
  **nothing** — the frames sit in the pipe and are drained in one go when it finally starts reading,
  collapsing a swipe into microseconds. So `isReady()` requires the announcement and `isRunning()`
  does not, and they answer different questions: writes are gated on the first, replacement
  decisions on the second. Gating replacement on readiness would spawn a second helper while the
  first was still starting.
  This window is not only reached after a death: a caller that taps right after `boot()` lands
  in it too, which is why `Simulator` waits for readiness before every input.
  A helper that never announces itself is replaced after `READY_DEADLINE_MS`. Without that,
  running-but-never-ready has no exit at all: nothing asks for a replacement because it is running,
  and every input is refused because it is not ready, so a wedge in the CoreSimulator device lookup
  would strand the session until the device was rebooted. The replacement goes through the same
  death path, so the rolling window bounds it.
- **A pid is what says the exec succeeded.** When the binary is missing, non-executable, or the
  wrong architecture (#464), libuv still returns an open stdin pipe and reports the failure a tick
  later. Measured: `stdin.writable` is `true` on a process that does not exist, and
  `stdin.write()` returning `false` is indistinguishable from ordinary backpressure. `spawnHelper`
  checks `proc.pid` and is the only gate — a process without one never becomes the active helper,
  and recovery from an exec failure is therefore lazy — the next self-contained frame retries.
  Not because node stays silent (it does emit `'error'`, which is why that branch attaches its own
  logger) but because the branch returns before wiring `handleDeath`, so nothing eagerly replaces
  a process that never lived.
- **A gesture belongs to the process that *received* its opening frame.** Because replacement is
  eager, a mid-gesture death normally leaves a healthy process standing by — so checking liveness
  is not enough. `TouchHelper` records the process that took the opening frame and refuses the rest
  of the gesture if it is no longer the current one. Writing a touch end to a fresh process would
  release the touch at (0,0), because that process's latches are zero, **and report it as
  delivered**.
  The ownership is recorded **only when the opening frame was actually delivered**, and that
  condition is load-bearing rather than defensive. Recording it unconditionally looks equivalent —
  "if the open failed there is nothing live to record" — and stops being equivalent the moment
  readiness exists: during the start-up window the open is refused while the process is alive and
  about to become ready, so identity would then pass and the continuation would reach a process
  that never saw the down. This was removed once as untestable and put back after a review found
  the case.
- **Replacing is bounded by a rolling window** — at most 3 spawns in any 30s. Deliberately not a
  count of consecutive fast failures: the helper's start-up is expensive, so "died too fast" cannot
  be separated from "died slowly" without guessing how long start-up takes, and a helper that
  reliably dies just past that guess would reset such a counter every time and churn a process
  every few seconds for the life of the agent, with no input and no user involved. The window
  bounds it whatever the lifetime, and it self-clears, so a session that briefly could not start a
  helper is not left without input until the device is rebooted.
- **A helper must never outlive the reference to it.** `Simulator` stops the outgoing helper before
  replacing it, and `close()`/`shutdown()` stop it; a self-reviving orphan would respawn for the life
  of the process with nothing left to stop it.

Every write reports whether it reached a helper that is ready to inject — not whether the device
acted on it, which HID is fire-and-forget about — and `Simulator` reports a refused write as an
error. The wrapper object outlives its process, so its existence says nothing about whether input
can land; that is what made the original failure silent.

Verified on a real simulator (iPhone 17 Pro, iOS 26.5), with an idle screenshot pair byte-identical
as the control: killing the helper while idle and swiping again opens Spotlight, so input recovers
without a reconnect; a gesture attempted inside the start-up window reports failure on every frame
and indeed changes nothing; and killing it mid-gesture leaves `isReady()` true — the replacement is
genuinely up — while the terminal frame is still refused, after which a fresh gesture works, so no
touch is left held.

Compile (output to `bin/`):
```bash
cd packages/ios-agent && swiftc src/touch-helper.swift -o bin/touch-helper
```

### XCUITest tree runner (UI tree backend)

The iOS UI tree comes from a resident **XCUITest runner** that runs *inside* the simulator and serves the accessibility tree over HTTP. It is window-agnostic — no Simulator.app window is required — which matches tapflow's headless simulator operation (`simctl boot` does not auto-open a window in current Xcode). This replaced the macOS AXUIElement helper, which needed a Simulator.app window and so failed on the headless path (the AX bridge only exists while the window is on screen). Still no WebDriverAgent — this is a self-hosted XCTest target.

- Source: `xctest-runner/` — xcodegen `project.yml` → **committed `.xcodeproj`** (no xcodegen at runtime).
  - `TreeHost` — minimal host app the UI-test target attaches to.
  - `TreeRunner` — the UI-test target: `TreeServer.swift` opens an `NWListener` HTTP server; `TreeServerTest.swift` starts it and blocks so the process stays resident.
- Protocol: `GET /health` → `ok` (readiness); `GET /tree?bundleId=<id>` → the app's `XCUIApplication.debugDescription` (text); `GET /type?bundleId=<id>&text=<t>` and `GET /key?bundleId=<id>&name=<k>` type into the focused element (409 when nothing has focus). Port via `TAPFLOW_TREE_PORT` (passed as `TEST_RUNNER_TAPFLOW_TREE_PORT`; a free port per simulator). The simulator shares `localhost` with the host (WDA pattern), so the host reaches the in-simulator server directly.
- `XCUITreeReader.ts` builds the runner once (`build-for-testing`, cached under `xctest-runner/build/`, gitignored), launches it (`test-without-building`, resident), polls `/health`, then fetches `/tree`. `xcuiTree.ts` parses the debugDescription text into the unified schema — kept a **pure function** so it stays unit-testable against the `xcuiTree.test.ts` fixture (Open Q9: a future Xcode format change fails there).
- Queries by bundleId: the reader needs the foreground app's bundleId, tracked as `DeviceState.currentBundleId` on `app:launch`. `readUITree` throws an actionable `PlatformError` if no app has been launched — never a silent empty tree.
- Frames: debugDescription frames are points; the parser normalizes them 0-1 against the `Window` frame (same coordinate space as the touch path).
- Lifecycle: **lazy** — the runner starts on the first UI-tree query (so a caller that never reads a tree never pays the build/launch cost) and is killed on device shutdown / `close()`.
- `enabled`: debugDescription does not expose it, so elements default to `enabled: true`. If fidelity needs it, switch to the private snapshot API (plan Open Q9).

When changing the tree output shape, **update both locations simultaneously**:
1. `xctest-runner/TreeRunner/TreeServer.swift` — server / debugDescription source
2. `src/xcuiTree.ts` — the parser + refresh the `xcuiTree.test.ts` fixture

After editing runner sources, regenerate the committed project (the runner binary itself is built on first use by `XCUITreeReader`):
```bash
cd packages/ios-agent/xctest-runner && xcodegen generate
```

### keyboard-helper interface

```bash
keyboard-helper <show|hide> <udid|booted>
```

Loads `CoreSimulator.framework` directly and calls `SimDevice.setHardwareKeyboardEnabled(_:keyboardType:error:)`.
No macOS Accessibility permission required.

- `show`: `setHardwareKeyboardEnabled(false)` — disconnects the hardware keyboard → software keyboard appears on text field focus
- `hide`: `setHardwareKeyboardEnabled(true)` — connects the hardware keyboard → software keyboard hides immediately

Compile (output to `bin/`):
```bash
swiftc packages/ios-agent/src/keyboard-helper.swift \
  -o packages/ios-agent/bin/keyboard-helper \
  -sdk "$(xcrun --show-sdk-path --sdk macosx)"
```

### rotation-helper interface

```bash
rotation-helper <portrait|landscapeLeft|landscapeRight|portraitUpsideDown> <udid|booted>
```

Acquires the `PurpleWorkspacePort` mach port via `SimDevice.lookup:error:` and sends a `GSEventTypeDeviceOrientationChanged` event directly.
**No Simulator.app required. No Accessibility permission required.**

UIDeviceOrientation rawValues: `portrait=1`, `portraitUpsideDown=2`, `landscapeRight=3`, `landscapeLeft=4`

Unlike the legacy `osascript` approach (bringing Simulator.app to the foreground and pressing Cmd+Arrow), this sets the absolute orientation directly, so it works regardless of the current state.

Compile (output to `bin/`):
```bash
swiftc packages/ios-agent/src/rotation-helper.swift \
  -o packages/ios-agent/bin/rotation-helper \
  -sdk "$(xcrun --show-sdk-path --sdk macosx)"
```

### Zombie simulator auto-recovery

A simulator's data dir can vanish from disk (an Xcode/macOS update prunes its runtime)
while `simctl list` still reports it `isAvailable: true` — the loss only surfaces when
`boot` runs, failing with "cannot be located on disk" / "data is no longer present".

`Simulator.boot` recovers in place via `bootWithZombieRecovery`: when
`isDeviceMissingError(e)` matches that signature it `erase`s the device (regenerating the
data dir) and retries `boot` once. Bounded — a second failure surfaces as
the boot's error, never a loop.

**Why the guard matters**: `erase` wipes a device, so it runs *only* on the missing-data
signature — an unrelated boot failure (timeout, etc.) never erases a healthy device,
locked down by a negative test. Keep the match text-only and conservative; widen the
signature only with evidence.
