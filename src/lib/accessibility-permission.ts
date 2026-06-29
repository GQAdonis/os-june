import {
  dictationHelperCommand,
  requestAccessibilityPermission,
} from "./tauri";

export async function requestDictationAccessibilityPermission() {
  try {
    await dictationHelperCommand({
      type: "request_accessibility_permission",
    });
  } catch (error) {
    // The dictation helper owns the paste event, so helper failure cannot be
    // treated as success. Prompt the app process as a best-effort fallback, but
    // still surface the helper failure so callers can offer System Settings.
    try {
      await requestAccessibilityPermission();
    } catch {
      // Keep the helper error because it points at the required permission owner.
    }
    throw error;
  }
}
