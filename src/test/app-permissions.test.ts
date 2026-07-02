import { describe, expect, it } from "vitest";
import { isAccessibilityBlocked } from "../app/App";

// Regression: the dictation helper reports Accessibility as "granted" |
// "missing" (AXIsProcessTrusted), not the microphone's denied/restricted
// vocabulary. A fresh install reports "missing", and that MUST count as
// blocked so the paste-permission banner shows — otherwise dictation
// silently fails to paste into other apps (Cmd+V needs the helper trusted).
describe("isAccessibilityBlocked", () => {
  it("treats a fresh-install 'missing' grant as blocked", () => {
    expect(isAccessibilityBlocked("missing")).toBe(true);
  });

  it("does not block once Accessibility is granted", () => {
    expect(isAccessibilityBlocked("granted")).toBe(false);
  });

  it("stays non-blocking before the helper's first report", () => {
    expect(isAccessibilityBlocked(undefined)).toBe(false);
  });

  it("treats any other non-granted status as blocked", () => {
    expect(isAccessibilityBlocked("denied")).toBe(true);
    expect(isAccessibilityBlocked("restricted")).toBe(true);
  });
});

// JUN-185: the helper now polls AXIsProcessTrusted() and re-emits
// permission_status on change, so a mid-session revoke/re-grant flows through
// the same accessibility-status state the banner is gated on. Each event just
// overwrites accessibilityStatus, so banner visibility is exactly
// isAccessibilityBlocked over that sequence — assert the whole revoke/re-grant
// path so a future refactor can't silently strand the banner as "on".
describe("accessibility banner across proactive status changes", () => {
  it("shows on revoke and clears on re-grant without a failed paste", () => {
    // Trusted at launch: no banner.
    expect(isAccessibilityBlocked("granted")).toBe(false);
    // Grant revoked in System Settings mid-session (helper timer/wake poll
    // re-emits): banner appears with no dictation attempt.
    expect(isAccessibilityBlocked("missing")).toBe(true);
    // Re-granted (next change event): banner clears.
    expect(isAccessibilityBlocked("granted")).toBe(false);
  });
});
