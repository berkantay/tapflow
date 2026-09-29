# tapflow (CLI)

```sh
tapflow doctor                         # check Xcode, runtimes, helper binaries
tapflow devices                        # list simulators
tapflow boot "iPhone 17 Pro" [--erase] [--lean]
tapflow install "iPhone 17 Pro" ./build/App.app
tapflow flow run flows/*.yaml --device "iPhone 17 Pro" [--app ./App.app] [--junit report.xml] [--record out/]
tapflow flow export out/01-login.mp4.actions.json --name login --out flows/login.yaml
tapflow mcp [--device <d>] [--http <port>]
```

`flow run` exits 0 when every flow passes, 1 when a flow fails on the product side, and 2 when the
run could not be carried out (no device, a simulator fault). Failure screenshots go to
`.tapflow/artifacts/` unless `--artifacts` says otherwise.

`--record <dir>` records each flow and writes, per flow:

| File | What |
|---|---|
| `NN-name.mp4` | Full-resolution H.264 recording |
| `NN-name.web.mp4` | Shareable export (600px wide by default, `--video-width`) with tap and swipe markers; a few hundred KB, well under GitHub's attachment limit |
| `NN-name.mp4.actions.json` | Every action and step with its time in the video |
| `NN-name.timeline.txt` | Step outcomes as lines like `0:03.2  ✓ tapOn("General")`, ready to paste into a PR comment |

The shareable export needs `ffmpeg` (`brew install ffmpeg`); without it the full-size video is still written.
