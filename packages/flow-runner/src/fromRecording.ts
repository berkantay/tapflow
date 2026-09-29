import { redactUrl, type RecordedAction } from '@tapflowio/ios-agent'
import { parseFlow } from './schema.js'

export interface RecordingToFlowOptions {
  name: string
  /** The app under test. Defaults to the first app launched in the recording. */
  appId?: string
}

export interface RecordingToFlowResult {
  yaml: string
  /** Steps written, and actions a flow cannot express (kept as comments). */
  steps: number
  skipped: number
}

const str = (v: string) => JSON.stringify(v)
const point = (p: [number, number]) => `[${p.map((n) => Number(n.toFixed(4))).join(', ')}]`

type Sel = NonNullable<Extract<RecordedAction, { kind: 'tap' }>['selector']>

// A selector as flow YAML: the bare string form for a plain `text`, the object form otherwise.
function selectorYaml(sel: Sel, extra: string[] = []): string | null {
  const keys = [
    sel.role !== undefined ? `role: ${str(sel.role)}` : null,
    sel.index !== undefined ? `index: ${sel.index}` : null,
    sel.system ? 'system: true' : null,
    ...extra,
  ].filter((k): k is string => k !== null)
  if (sel.id) return `{ ${[`id: ${str(sel.id)}`, ...keys].join(', ')} }`
  if (sel.label) return `{ ${[`label: ${str(sel.label)}`, ...keys].join(', ')} }`
  // `text` keeps its meaning (identifier, exact label, then part of a label); a bare string when alone.
  if (sel.text) return keys.length === 0 ? str(sel.text) : `{ ${[`text: ${str(sel.text)}`, ...keys].join(', ')} }`
  return sel.role !== undefined ? `{ ${keys.join(', ')} }` : null
}

function tapStep(a: Extract<RecordedAction, { kind: 'tap' }>): string | null {
  // A system alert ("Open in …?", a permission prompt) shows once per install, so a replay taps it
  // only if it is there.
  const sel = a.selector ? selectorYaml(a.selector, a.selector.system ? ['optional: true'] : []) : null
  if (sel) return `tapOn: ${sel}`
  return a.label ? `tapOn: ${str(a.label)}` : null
}

/**
 * Turn a recording's action log into a flow: explore once with an agent, replay it for free after.
 * Taps found by selector become `tapOn` steps (optional and alert-only for system alerts), and what
 * the agent waited for becomes `assertVisible` / `assertNotVisible`. A coordinate tap, a hardware
 * button or a note has no flow step and is kept as a comment where it happened, so nothing is
 * silently dropped. The result is checked with the flow parser before it is returned.
 */
export function recordingToFlow(actions: RecordedAction[], options: RecordingToFlowOptions): RecordingToFlowResult {
  const appId = options.appId ?? actions.find((a): a is Extract<RecordedAction, { kind: 'launch' }> => a.kind === 'launch')?.bundleId
  const lines: string[] = [`name: ${str(options.name)}`]
  if (appId) lines.push(`appId: ${str(appId)}`)
  lines.push('steps:')
  let steps = 0
  let skipped = 0
  let lastStep: string | undefined
  const step = (s: string) => {
    // A retried wait_for leaves the same check twice in a row; once is enough.
    if (s === lastStep && s.startsWith('assert')) return
    lines.push(`  - ${s}`)
    steps++
    lastStep = s
  }
  const comment = (s: string) => { lines.push(`  # ${s.replace(/\n/g, ' ')}`); skipped++ }

  for (const a of actions) {
    switch (a.kind) {
      case 'launch':
        if (a.bundleId === appId) step('launchApp')
        else comment(`launched ${a.bundleId} (a flow launches only its appId)`)
        break
      case 'terminate':
        if (a.bundleId === appId) step('stopApp')
        else comment(`quit ${a.bundleId}`)
        break
      case 'openUrl': {
        // Redacted again here, not only when recorded: flows get committed, and a log written
        // before redaction existed (or by hand) can still hold a live token.
        const url = redactUrl(a.url)
        if (url.includes('…')) lines.push('  # Redacted: put a fresh link here before replaying.')
        step(`openUrl: ${str(url)}`)
        break
      }
      case 'tap': {
        const s = tapStep(a)
        if (s) step(s)
        else comment(`tap at (${a.x.toFixed(2)}, ${a.y.toFixed(2)}) had no selector; replace with a tapOn`)
        break
      }
      case 'wait': {
        // What the agent waited for is what it expected to see: the flow's checks.
        const sel = selectorYaml(a.selector)
        if (sel) step(`${a.gone ? 'assertNotVisible' : 'assertVisible'}: ${sel}`)
        break
      }
      case 'swipe':
        step(`swipe: { from: ${point(a.from)}, to: ${point(a.to)}, durationMs: ${a.durationMs} }`)
        break
      case 'type':
        step(`inputText: ${str(a.text)}`)
        break
      case 'key':
        step(`pressKey: ${str(a.name)}`)
        break
      case 'button':
        comment(`pressed the ${a.name} button (no flow step for hardware buttons)`)
        break
      case 'note':
        lines.push(`  # MARK: ${a.text.replace(/\n/g, ' ')}${lastStep?.startsWith('assert') ? ' (checked by the step above)' : ' (add an assertVisible here to check it)'}`)
        break
      case 'step':
        break
    }
  }

  const yaml = lines.join('\n') + '\n'
  parseFlow(yaml, `${options.name}.yaml`)
  return { yaml, steps, skipped }
}
