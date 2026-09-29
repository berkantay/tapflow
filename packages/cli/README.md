# tapflow (CLI)

```sh
tapflow doctor                         # check Xcode, runtimes, helper binaries
tapflow devices                        # list simulators
tapflow boot "iPhone 17 Pro" [--erase] [--lean]
tapflow install "iPhone 17 Pro" ./build/App.app
tapflow flow run flows/*.yaml --device "iPhone 17 Pro" [--app ./App.app] [--junit report.xml]
tapflow mcp [--device <d>] [--http <port>]
```

`flow run` exits 0 when every flow passes, 1 when a flow fails on the product side, and 2 when the
run could not be carried out (no device, a simulator fault). Failure screenshots go to
`.tapflow/artifacts/` unless `--artifacts` says otherwise.
