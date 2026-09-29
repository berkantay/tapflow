export type DeviceStatus = 'booted' | 'shutdown' | 'unknown'

export interface Device {
  id: string
  name: string
  platform: string
  status: DeviceStatus
  /** Device type identifier, e.g. `com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro`. */
  typeId?: string
  /** e.g. "iOS 26.0" */
  osVersion?: string
}

/** Closed role vocabulary. An unmappable native role becomes `'other'` and the native string is kept
 *  in `rawRole`, so a consumer can still branch on it. */
export type UIElementRole =
  | 'button'
  | 'text'
  | 'input'
  | 'image'
  | 'checkbox'
  | 'switch'
  | 'slider'
  | 'list'
  | 'cell'
  | 'tab'
  | 'other'

/** Normalized 0-1 in the same coordinate space touch input takes, so a frame centre can be tapped as-is. */
export interface UIElementFrame {
  x: number
  y: number
  width: number
  height: number
}

export interface UIElement {
  role: UIElementRole
  label: string
  identifier?: string
  frame: UIElementFrame
  enabled: boolean
  /** Current value: a text field's contents, a switch's state, a slider's position. */
  value?: string
  /** A text field's placeholder. */
  placeholder?: string
  /** Holds keyboard focus. */
  focused?: boolean
  selected?: boolean
  rawRole?: string
}

export interface Point {
  x: number
  y: number
}
