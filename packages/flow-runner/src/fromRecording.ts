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

function tapStep(a: Extract<RecordedAction, { kind: 'tap' }>): string | null {
  const sel = a.selector
  if (sel) {
    const extra = [sel.role !== undefined ? `role: ${str(sel.role)}` : null, sel.index !== undefined ? `index: ${sel.index}` : null].filter(Boolean)
    if (sel.id) return `tapOn: { ${[`id: ${str(sel.id)}`, ...extra].join(', ')} }`
    const label = sel.label ?? sel.text
    if (label && extra.length === 0) return sel.label ? `tapOn: { label: ${str(label)} }` : `tapOn: ${str(label)}`
    if (label) return `tapOn: { ${[`label: ${str(label)}`, ...extra].join(', ')} }`
  }
  return a.label ? `tapOn: ${str(a.label)}` : null
}

/**
 * Turn a recording's action log into a flow: explore once with an agent, replay it for free after.
 * Taps found by selector become `tapOn` steps; a coordinate tap, a hardware button or a note has no
 * flow step and is kept as a comment where it happened, so nothing is silently dropped. The result
 * is checked with the flow parser before it is returned.
 */
export function recordingToFlow(actions: RecordedAction[], options: RecordingToFlowOptions): RecordingToFlowResult {
  const appId = options.appId ?? actions.find((a): a is Extract<RecordedAction, { kind: 'launch' }> => a.kind === 'launch')?.bundleId
  const lines: string[] = [`name: ${str(options.name)}`]
  if (appId) lines.push(`appId: ${str(appId)}`)
  lines.push('steps:')
  let steps = 0
  let skipped = 0
  const step = (s: string) => { lines.push(`  - ${s}`); steps++ }
  const comment = (s: string) => { lines.push(`  # ${s.replace(/\n/g, ' ')}`); skipped++ }

  for (const a of actions) {
    switch (a.kind) {
      case 'launch':
        if (a.bundleId === appId) step('launchApp')
        else comment(`launched ${a.bundleId} (a flow launches only its appId)`)
        break
      case 'terminate':
        comment(`quit ${a.bundleId}`)
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
        lines.push(`  # MARK: ${a.text.replace(/\n/g, ' ')} (an assertVisible here would check it)`)
        break
      case 'step':
        break
    }
  }

  const yaml = lines.join('\n') + '\n'
  parseFlow(yaml, `${options.name}.yaml`)
  return { yaml, steps, skipped }
}
