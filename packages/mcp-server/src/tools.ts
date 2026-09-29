import * as z from 'zod'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { matchSelector, parseFlow, recordSteps, runFlow, SimulatorDriver } from '@tapflowio/flow-runner'
import { BUTTON_NAMES, KEY_NAMES, exportVideo, timeline } from '@tapflowio/ios-agent'
import type { DeviceContext } from './devices.js'

type ToolResult = { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>; isError?: boolean }

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function pngSize(buf: Buffer): { width: number; height: number } | null {
  const isPng = buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a
  return isPng ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null
}

// Every tool reports its own failure as a tool error rather than throwing, so the agent reads the
// cause and can re-observe the screen.
async function attempt(name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn()
  } catch (e) {
    return err(`${name} failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const device = z.string().optional().describe('Simulator name or UDID. Defaults to the device last used here.')
const point = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])

export function registerTools(server: McpServer, ctx: DeviceContext): void {
  server.registerTool(
    'list_devices',
    { description: 'List the iOS simulators available on this Mac, with UDID, runtime and whether each is booted.' },
    () => attempt('list_devices', async () => ok(JSON.stringify(await ctx.devices(), null, 2))),
  )

  server.registerTool(
    'boot_device',
    {
      description: 'Boot a simulator (or attach to one already running) and make it the device later tools act on. Waits until it has finished booting.',
      inputSchema: {
        device: z.string().describe('Simulator name or UDID from list_devices'),
        erase: z.boolean().optional().describe('Erase all content and settings first (default false)'),
      },
    },
    ({ device: name, erase }) => attempt('boot_device', async () => {
      const sim = await ctx.resolve(name)
      const booted = await sim.boot({ erase })
      return ok(`Booted ${booted.name} (${booted.osVersion ?? 'unknown runtime'}, ${booted.id})`)
    }),
  )

  server.registerTool(
    'shutdown_device',
    { description: 'Shut a simulator down.', inputSchema: { device } },
    ({ device: name }) => attempt('shutdown_device', async () => {
      const sim = await ctx.resolve(name)
      await sim.shutdown()
      return ok(`Shut down ${sim.udid}`)
    }),
  )

  server.registerTool(
    'install_app',
    {
      description: 'Install an app from a path on this Mac: a simulator .app directory, or a .zip / .tar.gz containing one.',
      inputSchema: { path: z.string().describe('Absolute path to the .app, .zip or .tar.gz'), device },
    },
    ({ path: appPath, device: name }) => attempt('install_app', async () => {
      await (await ctx.resolve(name)).install(appPath)
      return ok(`Installed ${path.basename(appPath)}`)
    }),
  )

  server.registerTool(
    'launch_app',
    {
      description: 'Launch an installed app by bundle id. It becomes the app that query_ui_tree, type_text and press_key act on.',
      inputSchema: { bundleId: z.string().describe('e.g. com.example.app'), device },
    },
    ({ bundleId, device: name }) => attempt('launch_app', async () => {
      await (await ctx.resolve(name)).launch(bundleId)
      return ok(`Launched ${bundleId}`)
    }),
  )

  server.registerTool(
    'open_url',
    { description: 'Open a URL or deep link on the device.', inputSchema: { url: z.string(), device } },
    ({ url, device: name }) => attempt('open_url', async () => {
      await (await ctx.resolve(name)).openUrl(url)
      return ok(`Opened ${url}`)
    }),
  )

  server.registerTool(
    'query_ui_tree',
    {
      description:
        'Read the accessibility tree of the foreground app: elements as { role, label, identifier, frame, enabled, value }. ' +
        'Frames are normalized 0-1, the same space tap and swipe take, so an element is tapped at ' +
        '(frame.x + frame.width / 2, frame.y + frame.height / 2). Prefer this, or tap_element, over reading coordinates off a screenshot. ' +
        'A system alert covering the app ("Open in …?", a permission prompt) is reported as systemAlert with its buttons; tap_element can tap them.',
      inputSchema: { bundleId: z.string().optional().describe('App to read. Defaults to the last launched app.'), device },
    },
    ({ bundleId, device: name }) => attempt('query_ui_tree', async () => {
      const sim = await ctx.resolve(name)
      const [elements, alert] = await Promise.all([sim.uiTree(bundleId), sim.systemAlert()])
      return ok(JSON.stringify({
        count: elements.length,
        ...(alert ? { systemAlert: { title: alert.title, buttons: alert.elements.filter((e) => e.role === 'button').map((e) => e.label) } } : {}),
        elements,
      }, null, 2))
    }),
  )

  server.registerTool(
    'screenshot',
    { description: 'Capture the screen. Returns the image and saves it to a temp file.', inputSchema: { device } },
    ({ device: name }) => attempt('screenshot', async () => {
      const sim = await ctx.resolve(name)
      const buf = await sim.screenshot('png')
      const file = path.join(os.tmpdir(), `tapflow-${sim.udid.slice(0, 8)}-${Date.now()}.png`)
      fs.writeFileSync(file, buf)
      const size = pngSize(buf)
      return {
        content: [
          { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' },
          { type: 'text', text: `Saved ${file}${size ? ` (${size.width}x${size.height}px; divide pixel coordinates by these to tap)` : ''}` },
        ],
      }
    }),
  )

  server.registerTool(
    'tap',
    {
      description: 'Tap at a normalized point: x and y from 0 to 1, top-left origin. From a screenshot, divide the pixel position by its width and height.',
      inputSchema: { x: z.number().min(0).max(1), y: z.number().min(0).max(1), device },
    },
    ({ x, y, device: name }) => attempt('tap', async () => {
      await (await ctx.resolve(name)).tap(x, y)
      return ok(`Tapped (${x}, ${y})`)
    }),
  )

  server.registerTool(
    'tap_element',
    {
      description:
        'Tap an element found in the accessibility tree. "id" is an exact identifier (a testID) and "label" an exact label; ' +
        '"text" matches an exact identifier, then an exact label, then part of a label. Narrow with role and index when several match. ' +
        'When a system alert covers the app, only its buttons can be tapped, and the error names them.',
      inputSchema: {
        text: z.string().optional().describe('Identifier, exact label, or part of a label'),
        id: z.string().optional().describe('Exact accessibility identifier'),
        label: z.string().optional().describe('Exact label'),
        role: z.string().optional().describe('button, cell, input, text, switch, …'),
        index: z.number().int().min(0).optional().describe('Which match to tap when several remain (0-based)'),
        device,
      },
    },
    ({ text, id, label, role, index, device: name }) => attempt('tap_element', async () => {
      if (text === undefined && id === undefined && label === undefined) return err('tap_element needs one of text, id or label')
      const sim = await ctx.resolve(name)
      const alert = await sim.systemAlert()
      const pool = alert ? alert.elements : await sim.uiTree()
      let matches = matchSelector(pool, { text, id, role })
      // `label` is exact here; matchSelector's label falls back to a partial match, which is what `text` is for.
      if (label !== undefined) matches = matches.filter((e) => e.label === label)
      if (matches.length === 0) {
        if (alert) {
          const buttons = alert.elements.filter((e) => e.role === 'button').map((e) => `"${e.label}"`).join(', ')
          return err(`tap_element: a system alert is covering the app ("${alert.title}"); its buttons are ${buttons}`)
        }
        return err('tap_element: no element matched; call query_ui_tree to see what is on screen')
      }
      const target = matches[index ?? 0]
      if (!target) return err(`tap_element: index ${index} is out of range (${matches.length} matches)`)
      if (index === undefined && matches.length > 1) {
        return err(`tap_element: ${matches.length} elements matched (${matches.slice(0, 5).map((m) => `${m.role} "${m.label}"`).join(', ')}); pass role or index`)
      }
      const { x, y, width, height } = target.frame
      await sim.tap(x + width / 2, y + height / 2, target.label || target.identifier)
      return ok(`Tapped ${target.system ? 'system alert ' : ''}${target.role} "${target.label}"`)
    }),
  )

  server.registerTool(
    'swipe',
    {
      description: 'Swipe between two normalized points. To scroll content down, swipe up: from [0.5, 0.7] to [0.5, 0.3].',
      inputSchema: {
        from: point.describe('[x, y] start, 0-1'),
        to: point.describe('[x, y] end, 0-1'),
        durationMs: z.number().int().min(16).max(10_000).optional().describe('Default 300'),
        device,
      },
    },
    ({ from, to, durationMs, device: name }) => attempt('swipe', async () => {
      await (await ctx.resolve(name)).swipe(from, to, durationMs)
      return ok(`Swiped from (${from.join(', ')}) to (${to.join(', ')})`)
    }),
  )

  server.registerTool(
    'type_text',
    {
      description: 'Type text into the focused field of the foreground app (tap the field first). Any Unicode text works.',
      inputSchema: { text: z.string(), device },
    },
    ({ text, device: name }) => attempt('type_text', async () => {
      await (await ctx.resolve(name)).typeText(text)
      return ok(`Typed ${JSON.stringify(text)}`)
    }),
  )

  server.registerTool(
    'press_key',
    {
      description: `Press a key in the focused field: ${KEY_NAMES.join(', ')}.`,
      inputSchema: { key: z.string(), device },
    },
    ({ key, device: name }) => attempt('press_key', async () => {
      await (await ctx.resolve(name)).pressKey(key)
      return ok(`Pressed ${key}`)
    }),
  )

  server.registerTool(
    'press_button',
    {
      description: `Press a hardware button: ${BUTTON_NAMES.join(', ')}.`,
      inputSchema: { button: z.string(), device },
    },
    ({ button, device: name }) => attempt('press_button', async () => {
      await (await ctx.resolve(name)).pressButton(button)
      return ok(`Pressed ${button}`)
    }),
  )

  server.registerTool(
    'start_recording',
    {
      description:
        'Start recording the device screen. Every action taken until stop_recording is logged with its time in the video. ' +
        'Use this to leave evidence of what was done: a reproduced bug, a verified fix.',
      inputSchema: {
        path: z.string().optional().describe('Where to write the .mp4 (default: a temp file)'),
        device,
      },
    },
    ({ path: videoPath, device: name }) => attempt('start_recording', async () => {
      const sim = await ctx.resolve(name)
      const target = videoPath ?? path.join(os.tmpdir(), `tapflow-recording-${sim.udid.slice(0, 8)}-${Date.now()}.mp4`)
      await sim.startRecording(target)
      return ok(`Recording to ${target}`)
    }),
  )

  server.registerTool(
    'mark_recording',
    {
      description: 'Add a note to the current recording\'s timeline at this moment, e.g. "crash reproduced" or "fix verified".',
      inputSchema: { text: z.string(), device },
    },
    ({ text, device: name }) => attempt('mark_recording', async () => {
      const sim = await ctx.resolve(name)
      if (!sim.recording) return err('mark_recording: nothing is being recorded; call start_recording first')
      sim.mark({ kind: 'note', text })
      return ok(`Marked "${text}"`)
    }),
  )

  server.registerTool(
    'stop_recording',
    {
      description:
        'Stop recording. Returns the full-size video, a small shareable export with tap markers (suitable for a pull request), ' +
        'the action log, and a timeline of what happened when.',
      inputSchema: {
        export: z.boolean().optional().describe('Also write the shareable .web.mp4 (default true; needs ffmpeg)'),
        width: z.number().int().min(240).max(1600).optional().describe('Width of the shareable video (default 600)'),
        device,
      },
    },
    ({ export: doExport, width, device: name }) => attempt('stop_recording', async () => {
      const sim = await ctx.resolve(name)
      if (!sim.recording) return err('stop_recording: nothing is being recorded')
      const rec = await sim.stopRecording()
      const result: Record<string, unknown> = {
        video: rec.path,
        bytes: rec.bytes,
        durationMs: rec.durationMs,
        actions: rec.actionsPath,
        timeline: timeline(rec.actions),
      }
      if (doExport !== false) {
        try {
          const web = await exportVideo(rec.path, rec.path.replace(/\.(mp4|mov)$/i, '.web.mp4'), rec.actions, { width })
          result.shareable = web.path
          result.shareableBytes = web.bytes
        } catch (e) {
          result.exportError = (e as Error).message
        }
      }
      return ok(JSON.stringify(result, null, 2))
    }),
  )

  server.registerTool(
    'run_flow',
    {
      description:
        'Replay a flow (YAML) deterministically, with no model in the loop: author it once, replay it on every build. ' +
        'Pass the YAML inline as "flow", or a file under the server working directory as "path". Steps: clearState, launchApp, tapOn, ' +
        'inputText, pressKey, swipe, scroll, openUrl, assertVisible, assertNotVisible. The flow\'s "appId" names the app under test. ' +
        'Returns per-step results; on failure a screenshot is saved to a temp file.',
      inputSchema: {
        flow: z.string().optional().describe('Flow YAML (inline)'),
        path: z.string().optional().describe('Path to a flow YAML file, inside the server working directory'),
        device,
      },
    },
    ({ flow, path: flowPath, device: name }) => attempt('run_flow', async () => {
      if ((flow === undefined) === (flowPath === undefined)) return err('run_flow needs exactly one of "flow" or "path"')
      let yamlText = flow
      if (flowPath !== undefined) {
        // Only flow files under the working directory; anything else goes inline.
        const resolved = path.resolve(flowPath)
        if (!resolved.startsWith(process.cwd() + path.sep)) {
          return err(`run_flow "path" must be inside ${process.cwd()}; pass the YAML inline as "flow" instead`)
        }
        yamlText = fs.readFileSync(resolved, 'utf-8')
      }
      const parsed = parseFlow(yamlText!, flowPath ?? 'inline-flow.yaml')
      const sim = await ctx.resolve(name)
      // Steps land in the recording's timeline when start_recording is running.
      const result = await runFlow(parsed, new SimulatorDriver(sim, parsed.appId), { onStep: recordSteps(sim) })
      let screenshotPath: string | undefined
      if (result.failureScreenshot) {
        screenshotPath = path.join(os.tmpdir(), `tapflow-flow-failure-${Date.now()}.png`)
        fs.writeFileSync(screenshotPath, result.failureScreenshot)
      }
      return ok(JSON.stringify({
        name: result.name,
        status: result.status,
        durationMs: result.durationMs,
        steps: result.steps,
        ...(result.failureMessage ? { failureMessage: result.failureMessage } : {}),
        ...(result.failureKind ? { failureKind: result.failureKind } : {}),
        ...(screenshotPath ? { failureScreenshotPath: screenshotPath } : {}),
      }, null, 2))
    }),
  )
}
