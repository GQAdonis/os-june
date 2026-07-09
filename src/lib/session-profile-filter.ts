import type { HermesSessionInfo, SessionProfileDto } from "./tauri";
import { isScheduledRunSession } from "./hermes-adapter";

export type SessionProfileMap = Record<string, string>;

export function sessionProfileMap(assignments: readonly SessionProfileDto[]): SessionProfileMap {
  const next: SessionProfileMap = {};
  for (const assignment of assignments) {
    next[assignment.sessionId] = assignment.profile;
  }
  return next;
}

function normalizedHermesProfileName(profile: string | undefined): string {
  const trimmed = profile?.trim();
  return trimmed || "default";
}

export function filterAgentSessionsForProfile(
  sessions: readonly HermesSessionInfo[],
  profiles: SessionProfileMap,
  activeProfile: string,
): HermesSessionInfo[] {
  const targetProfile = normalizedHermesProfileName(activeProfile);
  return sessions
    .filter((session) => !isScheduledRunSession(session))
    .filter((session) => {
      const sessionProfile = normalizedHermesProfileName(profiles[session.id]);
      return sessionProfile === targetProfile;
    });
}
