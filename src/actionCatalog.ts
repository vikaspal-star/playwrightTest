// ============================================================
// ACTION CATALOG
// ------------------------------------------------------------
// Single source of truth for the UI editor: every action the
// ActionExecutor understands, which fields it needs, and how
// each field should be rendered. Keep in sync with the switch
// in ActionExecutor.ts when adding actions.
// ============================================================

export type FieldName =
  | "selector"
  | "locatorType"
  | "value"
  | "text"
  | "url"
  | "timeout"
  | "key"
  | "filePath"
  | "screenshot"
  | "state"
  | "x"
  | "y"
  | "message"
  | "promptText"
  | "pageName";

export type ActionGroup =
  | "Navigation"
  | "Interaction"
  | "Wait"
  | "Assertion"
  | "Page"
  | "Frames & Tabs"
  | "Dialogs";

export interface ActionSpec {
  action: string;
  aliases?: string[];
  group: ActionGroup;
  description: string;
  required: FieldName[];
  optional: FieldName[];
}

export interface FieldMeta {
  label: string;
  type: "text" | "number" | "select";
  options?: string[];
  placeholder?: string;
}

const LOC: FieldName[] = ["locatorType"];
const LOC_T: FieldName[] = ["locatorType", "timeout"];

export const ACTION_CATALOG: ActionSpec[] = [
  // Navigation
  { action: "navigate", aliases: ["goto", "open-url"], group: "Navigation", description: "Open a URL", required: ["url"], optional: [] },
  { action: "reload", group: "Navigation", description: "Reload the current page", required: [], optional: [] },
  { action: "back", group: "Navigation", description: "Go back in history", required: [], optional: [] },
  { action: "forward", group: "Navigation", description: "Go forward in history", required: [], optional: [] },

  // Interaction
  { action: "click", group: "Interaction", description: "Click an element", required: ["selector"], optional: LOC },
  { action: "double-click", group: "Interaction", description: "Double-click an element", required: ["selector"], optional: LOC },
  { action: "right-click", group: "Interaction", description: "Right-click an element", required: ["selector"], optional: LOC },
  { action: "hover", group: "Interaction", description: "Hover over an element", required: ["selector"], optional: LOC },
  { action: "focus", group: "Interaction", description: "Focus an element", required: ["selector"], optional: LOC },
  { action: "fill", group: "Interaction", description: "Clear and fill an input", required: ["selector", "value"], optional: LOC },
  { action: "type", group: "Interaction", description: "Type into an input key by key", required: ["selector", "value"], optional: LOC },
  { action: "clear", group: "Interaction", description: "Clear an input", required: ["selector"], optional: LOC },
  { action: "select", group: "Interaction", description: "Choose an option in a <select>", required: ["selector", "value"], optional: LOC },
  { action: "check", group: "Interaction", description: "Check a checkbox or radio", required: ["selector"], optional: LOC },
  { action: "uncheck", group: "Interaction", description: "Uncheck a checkbox", required: ["selector"], optional: LOC },
  { action: "press", group: "Interaction", description: "Press a key on an element", required: ["selector", "key"], optional: LOC },
  { action: "keyboard-press", group: "Interaction", description: "Press a key on the page", required: ["key"], optional: [] },
  { action: "upload", group: "Interaction", description: "Set a file on a file input", required: ["selector", "filePath"], optional: LOC },
  { action: "drag-and-drop", group: "Interaction", description: "Drag an element onto the target selector in value", required: ["selector", "value"], optional: LOC },
  { action: "scroll-into-view", group: "Interaction", description: "Scroll an element into view", required: ["selector"], optional: LOC },
  { action: "scroll", group: "Interaction", description: "Scroll the window to x / y", required: [], optional: ["x", "y"] },

  // Wait
  { action: "wait", group: "Wait", description: "Sleep for a fixed time (ms)", required: ["timeout"], optional: [] },
  { action: "wait-for-selector", group: "Wait", description: "Wait for an element state", required: ["selector"], optional: ["state", "locatorType", "timeout"] },
  { action: "wait-for-url", group: "Wait", description: "Wait for the URL to match", required: ["url"], optional: ["timeout"] },

  // Assertion
  { action: "browser-url-changed", aliases: ["url-validation"], group: "Assertion", description: "Assert the URL equals", required: ["url"], optional: ["timeout"] },
  { action: "url-not-match", group: "Assertion", description: "Assert the URL does not equal", required: ["url"], optional: ["timeout"] },
  { action: "url-contains", group: "Assertion", description: "Assert the URL contains", required: ["url"], optional: ["timeout"] },
  { action: "text-visible", group: "Assertion", description: "Assert text is visible on the page", required: ["text"], optional: ["timeout"] },
  { action: "text-not-visible", group: "Assertion", description: "Assert text is not visible", required: ["text"], optional: ["timeout"] },
  { action: "visible", group: "Assertion", description: "Assert element is visible", required: ["selector"], optional: LOC_T },
  { action: "hidden", group: "Assertion", description: "Assert element is hidden", required: ["selector"], optional: LOC_T },
  { action: "exists", group: "Assertion", description: "Assert element is in the DOM", required: ["selector"], optional: LOC_T },
  { action: "not-exists", group: "Assertion", description: "Assert element is not in the DOM", required: ["selector"], optional: LOC_T },
  { action: "enabled", group: "Assertion", description: "Assert element is enabled", required: ["selector"], optional: LOC_T },
  { action: "disabled", group: "Assertion", description: "Assert element is disabled", required: ["selector"], optional: LOC_T },
  { action: "verify-checked", group: "Assertion", description: "Assert checkbox is checked", required: ["selector"], optional: LOC_T },
  { action: "verify-not-checked", group: "Assertion", description: "Assert checkbox is not checked", required: ["selector"], optional: LOC_T },
  { action: "verify-value", group: "Assertion", description: "Assert input value equals", required: ["selector", "value"], optional: LOC_T },
  { action: "element-text", group: "Assertion", description: "Assert element text equals", required: ["selector", "text"], optional: LOC_T },
  { action: "element-text-contains", group: "Assertion", description: "Assert element text contains", required: ["selector", "text"], optional: LOC_T },
  { action: "verify-title", group: "Assertion", description: "Assert page title equals value", required: ["value"], optional: ["timeout"] },

  // Page
  { action: "screenshot", group: "Page", description: "Save a full-page screenshot", required: [], optional: ["screenshot"] },

  // Frames & Tabs
  { action: "switch-frame", group: "Frames & Tabs", description: "Scope following steps to an iframe", required: ["selector"], optional: LOC_T },
  { action: "switch-main-frame", aliases: ["switch-default-content"], group: "Frames & Tabs", description: "Back to the main frame", required: [], optional: [] },
  { action: "new-tab", group: "Frames & Tabs", description: "Open a new tab and switch to it", required: [], optional: ["pageName"] },
  { action: "switch-tab", aliases: ["switch-window"], group: "Frames & Tabs", description: "Switch to a named tab", required: ["pageName"], optional: [] },
  { action: "switch-page-by-url", group: "Frames & Tabs", description: "Switch to the tab whose URL contains", required: ["url"], optional: [] },
  { action: "click-and-switch-window", group: "Frames & Tabs", description: "Click and switch to the window it opens", required: ["selector"], optional: ["pageName", "locatorType", "timeout"] },
  { action: "close-tab", aliases: ["close-window"], group: "Frames & Tabs", description: "Close the current tab, back to main", required: [], optional: [] },

  // Dialogs
  { action: "accept-alert", group: "Dialogs", description: "Accept the next alert / confirm", required: [], optional: ["message"] },
  { action: "dismiss-alert", group: "Dialogs", description: "Dismiss the next alert / confirm", required: [], optional: ["message"] },
  { action: "handle-alert", group: "Dialogs", description: "Accept or dismiss (value) the next dialog", required: [], optional: ["value", "message"] },
  { action: "handle-prompt", group: "Dialogs", description: "Answer the next prompt with promptText", required: [], optional: ["promptText", "message"] }
];

export const FIELD_META: Record<FieldName, FieldMeta> = {
  selector: { label: "Selector", type: "text", placeholder: "#id, .class, //xpath, text" },
  locatorType: { label: "Locator type", type: "select", options: ["", "css", "xpath", "text", "label", "placeholder", "testid", "role"] },
  value: { label: "Value", type: "text" },
  text: { label: "Text", type: "text" },
  url: { label: "URL", type: "text", placeholder: "https://" },
  timeout: { label: "Timeout (ms)", type: "number", placeholder: "30000" },
  key: { label: "Key", type: "text", placeholder: "Enter, Tab, Escape" },
  filePath: { label: "File path", type: "text" },
  screenshot: { label: "Screenshot path", type: "text", placeholder: "screenshots/name.png" },
  state: { label: "State", type: "select", options: ["", "visible", "hidden", "attached", "detached"] },
  x: { label: "X", type: "number" },
  y: { label: "Y", type: "number" },
  message: { label: "Expected message", type: "text" },
  promptText: { label: "Prompt answer", type: "text" },
  pageName: { label: "Tab name", type: "text" }
};

/** Resolve an action name (or alias) to its spec, case-insensitively. */
export function findAction(name: string): ActionSpec | undefined {
  const key = name.toLowerCase();
  return ACTION_CATALOG.find(
    spec => spec.action === key || spec.aliases?.includes(key)
  );
}
