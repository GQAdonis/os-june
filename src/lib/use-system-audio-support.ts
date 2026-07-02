import { useState } from "react";
import type { RecordingSourceReadinessDto } from "./tauri";

export type SystemAudioSupport = "unknown" | "supported" | "unsupported";

/**
 * Whether the host has a working system-audio backend, remembered across
 * readiness checks that do not cover the system source.
 *
 * Readiness DTOs only include a system entry when the check was made for
 * sourceMode microphonePlusSystem; a microphoneOnly preflight (stored after
 * the user turns system audio off) carries no system source at all. Backend
 * capability is a property of the host, not of the last-checked mode, so this
 * hook keeps the answer from the most recent readiness result that did include
 * the system source instead of letting a mic-only check erase it:
 *
 * - "unknown" until any readiness result has covered the system source
 * - "supported" / "unsupported" from the most recent result that covered it
 */
export function useSystemAudioSupport(
  sourceReadiness: RecordingSourceReadinessDto | undefined,
): SystemAudioSupport {
  const systemSource = sourceReadiness?.sources.find((source) => source.source === "system");
  const latest: SystemAudioSupport | null =
    systemSource == null
      ? null
      : systemSource.permissionState === "unsupported"
        ? "unsupported"
        : "supported";
  const [remembered, setRemembered] = useState<SystemAudioSupport | null>(null);
  if (latest != null && latest !== remembered) {
    // React's "adjust state during render" pattern: the update re-renders
    // before commit, so consumers never paint a frame with the stale answer.
    setRemembered(latest);
  }
  return latest ?? remembered ?? "unknown";
}
