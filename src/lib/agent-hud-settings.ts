export const AGENT_HUD_ENABLED_KEY = "june:agent-hud:enabled";
export const AGENT_HUD_VISIBILITY_CHANGED_EVENT = "june:agent-hud:visibility-changed";

/* The HUD replaced the desktop mascot; honor the preference users set
 * under the old key so disabling the pet keeps the overlay hidden. */
const LEGACY_ENABLED_KEY = "june:mascot:enabled";

export type AgentHudVisibilityChangedDetail = {
  enabled: boolean;
};

export function getAgentHudEnabled() {
  const value =
    localStorage.getItem(AGENT_HUD_ENABLED_KEY) ?? localStorage.getItem(LEGACY_ENABLED_KEY);
  return value !== "false";
}

export function setAgentHudEnabled(enabled: boolean) {
  localStorage.setItem(AGENT_HUD_ENABLED_KEY, enabled ? "true" : "false");
  const detail: AgentHudVisibilityChangedDetail = { enabled };
  window.dispatchEvent(
    new CustomEvent<AgentHudVisibilityChangedDetail>(AGENT_HUD_VISIBILITY_CHANGED_EVENT, {
      detail,
    }),
  );
  void import("@tauri-apps/api/event")
    .then((api) =>
      typeof api.emit === "function"
        ? api.emit(AGENT_HUD_VISIBILITY_CHANGED_EVENT, detail)
        : undefined,
    )
    .catch(() => {});
}

export const AGENT_HUD_PLACEMENT_KEY = "june:agent-hud:placement";
export const AGENT_HUD_PLACEMENT_CHANGED_EVENT = "june:agent-hud:placement-changed";

/** Where the HUD window parks: any of the four screen corners, or docked into
 * the camera housing (notch) of the built-in display. Notch placement floats a
 * top-center pill on displays without a housing. */
export type AgentHudPlacement = "notch" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type AgentHudPlacementChangedDetail = {
  placement: AgentHudPlacement;
};

const AGENT_HUD_PLACEMENTS: readonly AgentHudPlacement[] = [
  "notch",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

/** Coerces any stored/incoming value to a known placement. The five valid
 * values pass through; anything else (legacy keys, garbage, an older build's
 * value we later removed) falls back to the top-right default. Existing
 * "notch"/"top-right" stores keep working unchanged. */
export function parseAgentHudPlacement(value: string | null | undefined): AgentHudPlacement {
  return AGENT_HUD_PLACEMENTS.includes(value as AgentHudPlacement)
    ? (value as AgentHudPlacement)
    : "top-right";
}

export function getAgentHudPlacement(): AgentHudPlacement {
  return parseAgentHudPlacement(localStorage.getItem(AGENT_HUD_PLACEMENT_KEY));
}

export function setAgentHudPlacement(placement: AgentHudPlacement) {
  localStorage.setItem(AGENT_HUD_PLACEMENT_KEY, placement);
  const detail: AgentHudPlacementChangedDetail = { placement };
  window.dispatchEvent(
    new CustomEvent<AgentHudPlacementChangedDetail>(AGENT_HUD_PLACEMENT_CHANGED_EVENT, {
      detail,
    }),
  );
  void import("@tauri-apps/api/event")
    .then((api) =>
      typeof api.emit === "function"
        ? api.emit(AGENT_HUD_PLACEMENT_CHANGED_EVENT, detail)
        : undefined,
    )
    .catch(() => {});
}
