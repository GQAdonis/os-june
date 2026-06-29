import {
  dictationHelperCommand,
  requestAccessibilityPermission,
} from "./tauri";

export async function requestDictationAccessibilityPermission() {
  // June has moved Accessibility-owned work between the app process and the
  // dictation helper; prompt both so the visible action is never a no-op.
  const appPrompt = requestAccessibilityPermission();
  const helperPrompt = dictationHelperCommand({
    type: "request_accessibility_permission",
  });
  const results = await Promise.allSettled([appPrompt, helperPrompt]);
  const firstRejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (
    firstRejected &&
    results.every((result) => result.status === "rejected")
  ) {
    throw firstRejected.reason;
  }
}
