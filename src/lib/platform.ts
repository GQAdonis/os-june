export function isMacLikePlatform() {
  const platform =
    typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`;
  if (/Windows|Win32|Win64|Linux|Android/i.test(platform)) {
    return false;
  }
  return true;
}

export function isWindowsPlatform() {
  const platform =
    typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`;
  return /Windows|Win32|Win64/i.test(platform);
}

// Dictation (global shortcuts, capture, paste) ships on macOS and Windows.
// Other platforms (Linux) fall back to microphone note recording only.
export function isDictationSupportedPlatform() {
  return isMacLikePlatform() || isWindowsPlatform();
}

// Rewrites a stored shortcut label into the current platform's modifier
// names. Dictation shortcut defaults are stored with macOS modifier names
// ("Ctrl+Opt+D"); on Windows those read as "Ctrl+Alt+D".
export function displayShortcutLabel(label: string) {
  if (!isWindowsPlatform()) {
    return label;
  }
  return label
    .replace(/\bOpt\b/g, "Alt")
    .replace(/\bCmd\b/g, "Win")
    .replace(/⌘/g, "Win")
    .replace(/⌥/g, "Alt")
    .replace(/⌃/g, "Ctrl")
    .replace(/⇧/g, "Shift");
}

export function primaryShortcutLabel(key: string) {
  // No space after the ⌘ glyph (it reads tight), but keep one after the
  // "Ctrl" word so Windows labels don't run together as "CtrlN".
  return isMacLikePlatform() ? `⌘${key}` : `Ctrl ${key}`;
}

export function primaryShiftShortcutLabel(key: string) {
  return isMacLikePlatform() ? `⌘⇧${key}` : `Ctrl Shift ${key}`;
}

export function isPrimaryShortcut(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
) {
  if (event.altKey || event.shiftKey) return false;
  if (isMacLikePlatform()) {
    return event.metaKey && !event.ctrlKey;
  }
  return event.ctrlKey && !event.metaKey;
}
