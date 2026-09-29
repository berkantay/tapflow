import type { UIElement, UIElementRole } from '@tapflowio/agent-core'

// Parses the text emitted by XCUIApplication.debugDescription (served by the
// resident xctest-runner) into the unified UIElement schema. Kept as a pure
// function so it stays unit-testable against a fixed fixture (Open Q9: a format
// change in a future Xcode is caught by the snapshot regression test).
//
// A debugDescription element line looks like:
//   NavigationBar, 0x105808b10, {{0.0, 47.4}, {402.0, 47.4}}, identifier: 'The App'
//   Other, 0x105810800, {{0.0, 131.3}, {402.0, 66.4}}, identifier: 'Echo Box', label: 'Echo Box'
//   Other, 0x105811820, {{366.6, 94.7}, {32.2, 779.3}}, label: 'Vertical scroll bar', value: 0%
// Fields after the address appear in order: [pid], [frame], [identifier], [label], [value].

// XCUITest element type → unified vocabulary. XCUITest labels many custom/composed
// views as "Other" (they still carry identifier/label), so role is best-effort and
// identifier/label carry the selector weight.
function toRole(type: string): UIElementRole {
  switch (type) {
    case 'Button':
    case 'Key':
      return 'button'
    case 'TextField':
    case 'SecureTextField':
    case 'SearchField':
    case 'TextView':
      return 'input'
    case 'StaticText':
      return 'text'
    case 'Image':
    case 'Icon':
      return 'image'
    case 'Switch':
    case 'Toggle':
      return 'switch'
    case 'CheckBox':
      return 'checkbox'
    case 'Slider':
      return 'slider'
    case 'Table':
    case 'CollectionView':
    case 'ScrollView':
      return 'list'
    case 'Cell':
      return 'cell'
    case 'TabBar':
    case 'TabGroup':
      return 'tab'
    default:
      return 'other'
  }
}

const ACTIONABLE = new Set<UIElementRole>(['button', 'input', 'checkbox', 'switch', 'slider', 'tab', 'cell'])
const round4 = (n: number): number => Math.round(n * 10000) / 10000

interface RawNode {
  type: string
  frame?: { x: number; y: number; width: number; height: number }
  identifier?: string
  label?: string
  placeholder?: string
  value?: string
  flags: Set<string>
}

const FRAME_RE = /\{\{(-?[\d.]+), (-?[\d.]+)\}, \{(-?[\d.]+), (-?[\d.]+)\}\}/

// After the frame come `, key: value` fields in a fixed order (identifier, label, placeholderValue,
// value), then state flags such as `, Selected`, `, Keyboard Focused`, `, Disabled`. A field ends
// only where the next field or flag begins, so a quote or comma inside a label (label: 'Don't')
// does not end it early, and a following placeholderValue or flag is not swallowed into it.
const FIELD_KEYS = 'identifier|label|placeholderValue|title|value'
const BOUNDARY = `(?=, (?:${FIELD_KEYS}): |, [A-Z][A-Za-z ]*(?:,|$)|$)`
const QUOTED_FIELD_RE = new RegExp(`^, (${FIELD_KEYS}): '(.*?)'${BOUNDARY}`)
const BARE_FIELD_RE = new RegExp(`^, (${FIELD_KEYS}): (.*?)${BOUNDARY}`)
const FLAG_RE = /^, ([A-Z][A-Za-z ]*)(?=,|$)/

function parseLine(line: string): RawNode | null {
  // Strip indentation + the root arrow, then take the type up to ", 0x<addr>".
  const m = /^\s*→?\s*(.+?), 0x[0-9a-fA-F]+/.exec(line)
  if (!m) return null
  const node: RawNode = { type: m[1], flags: new Set() }

  let rest = line.slice(m[0].length)
  const fm = FRAME_RE.exec(rest)
  if (fm) {
    node.frame = { x: parseFloat(fm[1]), y: parseFloat(fm[2]), width: parseFloat(fm[3]), height: parseFloat(fm[4]) }
    rest = rest.slice(fm.index + fm[0].length)
  }
  // Anything between the address and the first field (a pid, say) is not a field.
  const first = rest.search(new RegExp(`, (?:${FIELD_KEYS}): |, [A-Z]`))
  rest = first >= 0 ? rest.slice(first) : ''
  while (rest.length > 0) {
    const field = QUOTED_FIELD_RE.exec(rest) ?? BARE_FIELD_RE.exec(rest)
    if (field) {
      const [whole, key, value] = field
      if (key === 'identifier') node.identifier = value
      else if (key === 'label') node.label = value
      else if (key === 'placeholderValue') node.placeholder = value
      else if (key === 'value') node.value = value
      rest = rest.slice(whole.length)
      continue
    }
    const flag = FLAG_RE.exec(rest)
    if (flag) {
      node.flags.add(flag[1])
      rest = rest.slice(flag[0].length)
      continue
    }
    break
  }
  return node
}

export function parseTreeText(text: string): UIElement[] {
  const lines = text.split('\n')
  const startIdx = lines.findIndex((l) => l.trim() === 'Element subtree:')
  const bodyLines = startIdx >= 0 ? lines.slice(startIdx + 1) : lines

  const raw: RawNode[] = []
  for (const line of bodyLines) {
    if (!line.trim()) continue
    // debugDescription ends with sections like "Path to element:" / "Query chain:".
    if (!/, 0x[0-9a-fA-F]+/.test(line)) break
    const node = parseLine(line)
    if (node) raw.push(node)
  }

  // Screen size = the first Window frame (normalization basis, same coordinate
  // space as the tap path). Fall back to the largest frame if no Window is found.
  const windowFrame = raw.find((n) => n.type.startsWith('Window') && n.frame)?.frame
  const basis = windowFrame ?? raw.reduce<RawNode['frame']>((max, n) => {
    if (!n.frame) return max
    const area = n.frame.width * n.frame.height
    return !max || area > max.width * max.height ? n.frame : max
  }, undefined)
  if (!basis || basis.width <= 0 || basis.height <= 0) return []

  const elements: UIElement[] = []
  for (const node of raw) {
    if (!node.frame || node.frame.width <= 0 || node.frame.height <= 0) continue
    const role = toRole(node.type)
    const label = node.label ?? ''
    // Skip pure structural containers with no label and no actionable role.
    if (!ACTIONABLE.has(role) && label === '' && !node.identifier) continue

    const element: UIElement = {
      role,
      label,
      frame: {
        x: round4((node.frame.x - basis.x) / basis.width),
        y: round4((node.frame.y - basis.y) / basis.height),
        width: round4(node.frame.width / basis.width),
        height: round4(node.frame.height / basis.height),
      },
      enabled: !node.flags.has('Disabled'),
    }
    if (node.identifier) element.identifier = node.identifier
    if (node.value !== undefined) element.value = node.value
    if (node.placeholder !== undefined) element.placeholder = node.placeholder
    if (node.flags.has('Keyboard Focused')) element.focused = true
    if (node.flags.has('Selected')) element.selected = true
    element.rawRole = node.type
    elements.push(element)
  }
  return elements
}
