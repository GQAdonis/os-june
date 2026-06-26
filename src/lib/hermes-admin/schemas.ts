/**
 * Defensive parsers for the Hermes dashboard admin REST shapes June consumes:
 * Skills, Toolsets, MCP servers, MCP catalog, background action status, env
 * writes, and gateway status. Same contract as `parseSessionUsage`: unknown in,
 * a normalized object out, every non-essential field optional and left
 * `undefined` when absent or malformed, NEVER throwing on junk. Unknown wire
 * fields are preserved under `raw` so a debug dump keeps anything we did not
 * model (the spec's "do not discard fields that may matter").
 *
 * These are permissive enough for upstream additions (new fields are ignored,
 * not rejected) but strict enough to catch a breaking change: a list endpoint
 * that stops returning an array, or an item that loses its name, degrades
 * visibly to empty rather than crashing a page. The contract fixtures in spec 24
 * lock these mappings.
 */

import {
  asRecord,
  finiteNumber,
  nonEmptyString,
  pickNumber,
  pickString,
} from "../hermes-control-plane/parse";
import type { ApplicationTiming } from "./application-timing";

/** A boolean read from an arbitrary wire value, or undefined when absent. Only
 * a real boolean counts: a string `"true"` is NOT coerced, so a malformed
 * enabled flag degrades to undefined instead of silently reading as enabled. */
function pickBool(
  containers: Array<Record<string, unknown> | undefined>,
  keys: string[],
): boolean | undefined {
  for (const container of containers) {
    if (!container) continue;
    for (const key of keys) {
      const value = container[key];
      if (typeof value === "boolean") return value;
    }
  }
  return undefined;
}

/** A string array (non-empty entries only), or undefined. */
function pickStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    const str = nonEmptyString(entry);
    if (str) out.push(str);
  }
  return out.length > 0 ? out : undefined;
}

// ----------------------------------------------------------------------------
// Skills (`GET /api/skills`, `PUT /api/skills/toggle`)
// ----------------------------------------------------------------------------

/** Where a skill came from. `bundled` ships with Hermes, `hub` was installed
 * from the Skills Hub, `external` loads from a `skills.external_dirs` path
 * (read-only in June), `unknown` when the wire did not say. */
export type HermesSkillSource = "bundled" | "hub" | "external" | "unknown";

export type HermesSkillInfo = {
  name: string;
  description?: string;
  enabled: boolean;
  source: HermesSkillSource;
  /** True when June cannot write this skill (loaded from an external dir). */
  readOnly?: boolean;
  /** The skill's version string, when reported. */
  version?: string;
  raw: unknown;
};

function parseSkillSource(value: unknown): HermesSkillSource {
  const str = nonEmptyString(value)?.toLowerCase();
  if (str === "bundled" || str === "builtin" || str === "official") {
    return "bundled";
  }
  if (str === "hub" || str === "installed") return "hub";
  if (str === "external" || str === "external_dir") return "external";
  return "unknown";
}

export function parseSkill(raw: unknown): HermesSkillInfo | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const name = pickString([record], ["name", "id", "skill", "slug"]);
  if (!name) return undefined;
  const source = parseSkillSource(
    record.source ?? record.origin ?? record.kind,
  );
  return {
    name,
    description: pickString([record], ["description", "summary", "desc"]),
    enabled: pickBool([record], ["enabled", "active", "is_enabled"]) ?? false,
    source,
    readOnly:
      pickBool([record], ["read_only", "readOnly", "readonly"]) ??
      (source === "external" ? true : undefined),
    version: pickString([record], ["version", "ver"]),
    raw,
  };
}

/** Hermes returns either a bare array or `{ skills: [...] }`; tolerate both. */
export function parseSkillList(raw: unknown): HermesSkillInfo[] {
  const items = listFrom(raw, ["skills", "items", "data"]);
  return items
    .map(parseSkill)
    .filter((skill): skill is HermesSkillInfo => skill !== undefined);
}

// ----------------------------------------------------------------------------
// Toolsets (`GET /api/tools/toolsets`)
// ----------------------------------------------------------------------------

export type HermesToolsetRequirement = {
  /** What the requirement is about, e.g. an env var name or a binary. */
  label: string;
  satisfied?: boolean;
};

/** Which June runtime mode a toolset is permitted in, as reported by Hermes.
 * June runs a sandboxed and an unrestricted (Full mode) runtime; a toolset that
 * shells out or touches the filesystem may be allowed in only one. `unknown` is
 * used when upstream says nothing — June never invents an allowance. */
export type HermesToolsetModeAllowance = {
  /** Allowed in the sandboxed runtime, or undefined when not reported. */
  sandboxed?: boolean;
  /** Allowed in the unrestricted (Full mode) runtime, or undefined. */
  unrestricted?: boolean;
};

export type HermesToolsetInfo = {
  name: string;
  /** A human label when the wire carries one separate from the id. */
  label?: string;
  description?: string;
  enabled: boolean;
  /** Whether the toolset's prerequisites are configured/satisfied, when the wire
   * reports it independently of `enabled`. Lets the UI tell "off" from "missing
   * setup". `undefined` when upstream does not say. */
  configured?: boolean;
  /** Tool names this toolset exposes, when listed. */
  tools?: string[];
  /** Unmet/met prerequisites (env vars, binaries) when reported. */
  requirements?: HermesToolsetRequirement[];
  /** Per-mode allowance (sandboxed / unrestricted), when reported. Each flag is
   * left undefined when upstream is silent, so the UI can mark it unknown rather
   * than guess. */
  modes?: HermesToolsetModeAllowance;
  raw: unknown;
};

function parseRequirement(raw: unknown): HermesToolsetRequirement | undefined {
  const str = nonEmptyString(raw);
  if (str) return { label: str };
  const record = asRecord(raw);
  if (!record) return undefined;
  const label = pickString([record], ["label", "name", "key", "env"]);
  if (!label) return undefined;
  return {
    label,
    satisfied: pickBool([record], ["satisfied", "met", "ok", "present"]),
  };
}

function parseRequirements(
  value: unknown,
): HermesToolsetRequirement[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: HermesToolsetRequirement[] = [];
  for (const entry of value) {
    const requirement = parseRequirement(entry);
    if (requirement) out.push(requirement);
  }
  return out.length > 0 ? out : undefined;
}

/** Reads the per-mode allowance from a toolset payload. Tolerates a nested
 * `modes`/`allowed_modes` object, an array of mode names, or top-level flags.
 * Each flag stays undefined unless upstream is explicit, so an absent allowance
 * reads as unknown rather than a guessed default. */
function parseModeAllowance(
  record: Record<string, unknown>,
): HermesToolsetModeAllowance | undefined {
  const nested = asRecord(record.modes ?? record.allowed_modes ?? record.allow);
  // Array form: ["sandboxed", "unrestricted"] / ["full"].
  const list = pickStringArray(
    record.modes ?? record.allowed_modes ?? record.sandbox_modes,
  );
  let sandboxed = pickBool(
    [nested, record],
    ["sandboxed", "sandbox", "allow_sandboxed", "sandbox_allowed"],
  );
  let unrestricted = pickBool(
    [nested, record],
    ["unrestricted", "full", "allow_unrestricted", "full_mode", "fullMode"],
  );
  if (list) {
    const lowered = list.map((mode) => mode.toLowerCase());
    if (sandboxed === undefined) {
      sandboxed = lowered.includes("sandboxed") || lowered.includes("sandbox");
    }
    if (unrestricted === undefined) {
      unrestricted =
        lowered.includes("unrestricted") || lowered.includes("full");
    }
  }
  if (sandboxed === undefined && unrestricted === undefined) return undefined;
  return { sandboxed, unrestricted };
}

export function parseToolset(raw: unknown): HermesToolsetInfo | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const name = pickString([record], ["name", "id", "toolset", "slug"]);
  if (!name) return undefined;
  return {
    name,
    label: pickString([record], ["label", "title", "display_name"]),
    description: pickString([record], ["description", "summary", "desc"]),
    enabled: pickBool([record], ["enabled", "active", "is_enabled"]) ?? false,
    configured: pickBool(
      [record],
      ["configured", "is_configured", "ready", "available", "satisfied"],
    ),
    tools: pickStringArray(record.tools ?? record.tool_names),
    requirements: parseRequirements(
      record.requirements ?? record.requires ?? record.prerequisites,
    ),
    modes: parseModeAllowance(record),
    raw,
  };
}

export function parseToolsetList(raw: unknown): HermesToolsetInfo[] {
  const items = listFrom(raw, ["toolsets", "items", "data"]);
  return items
    .map(parseToolset)
    .filter((toolset): toolset is HermesToolsetInfo => toolset !== undefined);
}

// ----------------------------------------------------------------------------
// MCP servers (`GET /api/mcp/servers`, add/test/enable/remove)
// ----------------------------------------------------------------------------

/** Transport of an MCP server. `stdio` spawns a local subprocess (sandbox/full
 * mode matters), `http` is a remote HTTP server, `http-oauth` an HTTP server
 * behind an OAuth login. */
export type HermesMcpTransport = "stdio" | "http" | "http-oauth" | "unknown";

/** OAuth/auth state of an MCP server, when it has one. */
export type HermesMcpAuthStatus =
  | "authenticated"
  | "unauthenticated"
  | "expired"
  | "not-required"
  | "unknown";

export type HermesMcpToolInfo = {
  name: string;
  description?: string;
  /** Whether this tool is currently exposed (after include/exclude filters). */
  enabled?: boolean;
};

export type HermesMcpServerInfo = {
  name: string;
  enabled: boolean;
  transport: HermesMcpTransport;
  /** stdio command, when transport is stdio. */
  command?: string;
  /** HTTP server URL, when transport is http(-oauth). */
  url?: string;
  auth: HermesMcpAuthStatus;
  /** Last connection/test result, when known. */
  status?: "connected" | "error" | "untested" | "unknown";
  /** Human-readable status/error detail. Already safe (no secrets). */
  statusMessage?: string;
  tools?: HermesMcpToolInfo[];
  /** Tool include/exclude filters as configured. */
  includeTools?: string[];
  excludeTools?: string[];
  raw: unknown;
};

function parseMcpTransport(
  record: Record<string, unknown>,
): HermesMcpTransport {
  const explicit = nonEmptyString(
    record.transport ?? record.type ?? record.kind,
  )?.toLowerCase();
  if (explicit === "stdio") return "stdio";
  if (explicit === "http-oauth" || explicit === "oauth") return "http-oauth";
  if (explicit === "http" || explicit === "sse" || explicit === "streamable") {
    return "http";
  }
  // Infer from shape when the wire did not label it.
  if (nonEmptyString(record.command)) return "stdio";
  if (nonEmptyString(record.url)) {
    return record.oauth || record.auth ? "http-oauth" : "http";
  }
  return "unknown";
}

function parseMcpAuth(record: Record<string, unknown>): HermesMcpAuthStatus {
  const status = nonEmptyString(
    record.auth_status ?? record.authStatus ?? record.oauth_status,
  )?.toLowerCase();
  if (status === "authenticated" || status === "authorized") {
    return "authenticated";
  }
  if (status === "expired") return "expired";
  if (
    status === "unauthenticated" ||
    status === "unauthorized" ||
    status === "missing"
  ) {
    return "unauthenticated";
  }
  const authed = pickBool([record], ["authenticated", "authorized"]);
  if (authed === true) return "authenticated";
  if (authed === false) return "unauthenticated";
  return "unknown";
}

function parseMcpStatus(
  record: Record<string, unknown>,
): HermesMcpServerInfo["status"] {
  const status = nonEmptyString(record.status ?? record.health)?.toLowerCase();
  if (status === "connected" || status === "ok" || status === "ready") {
    return "connected";
  }
  if (status === "error" || status === "failed" || status === "unhealthy") {
    return "error";
  }
  if (status === "untested" || status === "unknown" || status === "pending") {
    return status === "untested" ? "untested" : "unknown";
  }
  return undefined;
}

function parseMcpTool(raw: unknown): HermesMcpToolInfo | undefined {
  const str = nonEmptyString(raw);
  if (str) return { name: str };
  const record = asRecord(raw);
  if (!record) return undefined;
  const name = pickString([record], ["name", "id", "tool"]);
  if (!name) return undefined;
  return {
    name,
    description: pickString([record], ["description", "summary", "desc"]),
    enabled: pickBool([record], ["enabled", "active", "included"]),
  };
}

function parseMcpTools(value: unknown): HermesMcpToolInfo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: HermesMcpToolInfo[] = [];
  for (const entry of value) {
    const tool = parseMcpTool(entry);
    if (tool) out.push(tool);
  }
  return out.length > 0 ? out : undefined;
}

export function parseMcpServer(raw: unknown): HermesMcpServerInfo | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const name = pickString([record], ["name", "id", "server", "slug"]);
  if (!name) return undefined;
  const filters = asRecord(record.tool_filters ?? record.filters) ?? record;
  return {
    name,
    enabled: pickBool([record], ["enabled", "active", "is_enabled"]) ?? false,
    transport: parseMcpTransport(record),
    command: pickString([record], ["command", "cmd"]),
    url: pickString([record], ["url", "endpoint", "address"]),
    auth: parseMcpAuth(record),
    status: parseMcpStatus(record),
    statusMessage: pickString(
      [record],
      ["status_message", "statusMessage", "message", "detail", "error"],
    ),
    tools: parseMcpTools(record.tools),
    includeTools: pickStringArray(
      filters.include ?? filters.include_tools ?? record.include_tools,
    ),
    excludeTools: pickStringArray(
      filters.exclude ?? filters.exclude_tools ?? record.exclude_tools,
    ),
    raw,
  };
}

export function parseMcpServerList(raw: unknown): HermesMcpServerInfo[] {
  const items = listFrom(raw, ["servers", "mcp_servers", "items", "data"]);
  return items
    .map(parseMcpServer)
    .filter((server): server is HermesMcpServerInfo => server !== undefined);
}

/** Result of `POST /api/mcp/servers/{name}/test`. The detail is a safe message;
 * any tool list is the inventory the test discovered. */
export type HermesMcpTestResult = {
  name: string;
  ok: boolean;
  message?: string;
  tools?: HermesMcpToolInfo[];
  raw: unknown;
};

export function parseMcpTestResult(
  name: string,
  raw: unknown,
): HermesMcpTestResult {
  const record = asRecord(raw);
  const ok =
    pickBool([record], ["ok", "success", "connected", "healthy"]) ?? false;
  return {
    name,
    ok,
    message: pickString(
      [record],
      ["message", "detail", "error", "status_message"],
    ),
    tools: parseMcpTools(record?.tools),
    raw,
  };
}

// ----------------------------------------------------------------------------
// MCP catalog (`GET /api/mcp/catalog`, `POST /api/mcp/catalog/install`)
// ----------------------------------------------------------------------------

export type HermesMcpCatalogEntry = {
  id: string;
  name: string;
  description?: string;
  transport: HermesMcpTransport;
  /** True when this catalog entry is already installed as a server. */
  installed?: boolean;
  /** True when the entry requires an OAuth login after install. */
  requiresOauth?: boolean;
  /** Whether the entry runs a local subprocess (sandbox/full-mode relevant). */
  requiresSubprocess?: boolean;
  raw: unknown;
};

export function parseMcpCatalogEntry(
  raw: unknown,
): HermesMcpCatalogEntry | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const id = pickString([record], ["id", "slug", "name", "key"]);
  if (!id) return undefined;
  const transport = parseMcpTransport(record);
  return {
    id,
    name: pickString([record], ["name", "title", "label"]) ?? id,
    description: pickString([record], ["description", "summary", "desc"]),
    transport,
    installed: pickBool([record], ["installed", "is_installed", "present"]),
    requiresOauth:
      pickBool([record], ["requires_oauth", "requiresOauth", "oauth"]) ??
      (transport === "http-oauth" ? true : undefined),
    requiresSubprocess:
      pickBool(
        [record],
        ["requires_subprocess", "requiresSubprocess", "local"],
      ) ?? (transport === "stdio" ? true : undefined),
    raw,
  };
}

export function parseMcpCatalog(raw: unknown): HermesMcpCatalogEntry[] {
  const items = listFrom(raw, ["catalog", "entries", "items", "data"]);
  return items
    .map(parseMcpCatalogEntry)
    .filter((entry): entry is HermesMcpCatalogEntry => entry !== undefined);
}

// ----------------------------------------------------------------------------
// Skills Hub search (`GET /api/skills/hub/search`)
// ----------------------------------------------------------------------------

/** A trust signal Hermes attaches to a hub result, so June can warn before a
 * lower-trust install. `official` ships from Hermes, `verified` is a vetted tap,
 * `community` is unvetted, `unknown` when the wire did not say. Higher trust is
 * lower risk; the UI maps these to a friendly badge + advisory copy. */
export type HermesHubTrustLevel =
  | "official"
  | "verified"
  | "community"
  | "unknown";

export type HermesHubSkillResult = {
  /** Stable install identifier (the value to pass to hubInstall). */
  identifier: string;
  name: string;
  description?: string;
  /** Raw upstream source label (e.g. `skills.sh`, `github`, `url`); the UI maps
   * it to a friendly label and keeps this visible in the advanced/details area
   * so the exact install identifier/source stays debuggable. */
  source?: string;
  installed?: boolean;
  /** True when an installed copy has an update available, when reported. */
  updateAvailable?: boolean;
  /** Trust level reported by Hermes, when present. */
  trust: HermesHubTrustLevel;
  /** Category/group label, when reported. */
  category?: string;
  /** Searchable tags/keywords, when reported. */
  tags?: string[];
  /** The skill's version string, when reported. */
  version?: string;
  /** Upstream URLs (repo, homepage, the raw SKILL.md for a URL install), when
   * reported. Shown in the detail surface. */
  upstreamUrls?: string[];
  /** Author/publisher, when reported. */
  author?: string;
  raw: unknown;
};

/** Normalizes a trust string from a few shapes. `trusted`/`verified`/`tap`
 * collapse to `verified`; `official`/`builtin`/`bundled` to `official`;
 * `community`/`unverified`/`third_party`/`url` to `community`. */
function parseHubTrust(value: unknown): HermesHubTrustLevel {
  const str = nonEmptyString(value)?.toLowerCase();
  if (str === "official" || str === "builtin" || str === "bundled") {
    return "official";
  }
  if (str === "verified" || str === "trusted" || str === "tap") {
    return "verified";
  }
  if (
    str === "community" ||
    str === "unverified" ||
    str === "third_party" ||
    str === "third-party" ||
    str === "url"
  ) {
    return "community";
  }
  return "unknown";
}

export function parseHubSkillResult(
  raw: unknown,
): HermesHubSkillResult | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const identifier = pickString(
    [record],
    ["identifier", "id", "slug", "name", "ref"],
  );
  if (!identifier) return undefined;
  return {
    identifier,
    name: pickString([record], ["name", "title", "label"]) ?? identifier,
    description: pickString([record], ["description", "summary", "desc"]),
    source: pickString([record], ["source", "origin", "tap"]),
    installed: pickBool([record], ["installed", "is_installed"]),
    updateAvailable: pickBool(
      [record],
      ["update_available", "updateAvailable", "has_update", "outdated"],
    ),
    trust: parseHubTrust(
      record.trust ?? record.trust_level ?? record.trustLevel,
    ),
    category: pickString([record], ["category", "group", "collection"]),
    tags: pickStringArray(record.tags ?? record.keywords ?? record.labels),
    version: pickString([record], ["version", "ver"]),
    upstreamUrls:
      pickStringArray(
        record.urls ?? record.upstream_urls ?? record.upstreamUrls,
      ) ?? collectUrls(record),
    author: pickString(
      [record],
      ["author", "publisher", "owner", "maintainer"],
    ),
    raw,
  };
}

/** Collects single-URL fields into a list, for results that report `url`/
 * `repo`/`homepage` rather than a `urls` array. Returns undefined when none. */
function collectUrls(record: Record<string, unknown>): string[] | undefined {
  const out: string[] = [];
  for (const key of ["url", "repo", "repository", "homepage", "source_url"]) {
    const value = nonEmptyString(record[key]);
    if (value && !out.includes(value)) out.push(value);
  }
  return out.length > 0 ? out : undefined;
}

export function parseHubSearch(raw: unknown): HermesHubSkillResult[] {
  const items = listFrom(raw, ["results", "skills", "items", "data"]);
  return items
    .map(parseHubSkillResult)
    .filter((result): result is HermesHubSkillResult => result !== undefined);
}

// ----------------------------------------------------------------------------
// Background actions (`POST` endpoints that return an action name/id;
// `GET /api/actions/{name}/status`)
// ----------------------------------------------------------------------------

/** Lifecycle state of a backgrounded admin action (hub install, gateway
 * restart, ...). `unknown` when the wire state is unrecognized — callers keep
 * polling rather than assuming success. */
export type HermesActionState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "unknown";

export type HermesActionStatus = {
  /** The action name/id to poll on `/api/actions/{name}/status`. */
  action: string;
  state: HermesActionState;
  /** True once the action reached a terminal state (succeeded or failed). */
  done: boolean;
  /** 0-100 progress, when reported. */
  progress?: number;
  /** Safe human message; redacted of any secret-shaped content upstream. */
  message?: string;
  /** Safe error message when `state === "failed"`. */
  error?: string;
  raw: unknown;
};

function parseActionState(value: unknown): HermesActionState {
  const str = nonEmptyString(value)?.toLowerCase();
  if (str === "queued" || str === "pending" || str === "scheduled") {
    return "queued";
  }
  if (str === "running" || str === "in_progress" || str === "active") {
    return "running";
  }
  if (
    str === "succeeded" ||
    str === "success" ||
    str === "completed" ||
    str === "done"
  ) {
    return "succeeded";
  }
  if (
    str === "failed" ||
    str === "error" ||
    str === "cancelled" ||
    str === "canceled"
  ) {
    return "failed";
  }
  return "unknown";
}

/** Reads the action NAME/ID a mutating endpoint returns so the caller can poll
 * it. Returns undefined when the response carries no action handle (a
 * synchronous mutation). */
export function parseActionHandle(raw: unknown): string | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  return pickString(
    [record, asRecord(record.action)],
    ["action", "action_name", "actionName", "action_id", "id", "name"],
  );
}

export function parseActionStatus(
  action: string,
  raw: unknown,
): HermesActionStatus {
  const record = asRecord(raw);
  // A bare `{ done: true }` or `{ status: "..." }` are both tolerated.
  const explicitDone = pickBool([record], ["done", "finished", "complete"]);
  const state = parseActionState(
    record?.state ?? record?.status ?? (explicitDone ? "succeeded" : undefined),
  );
  const done = explicitDone ?? (state === "succeeded" || state === "failed");
  return {
    action,
    state,
    done,
    progress: clampProgress(
      pickNumber([record], ["progress", "percent", "pct"]),
    ),
    message: pickString([record], ["message", "detail", "status_message"]),
    error:
      state === "failed"
        ? pickString([record], ["error", "error_message", "message", "detail"])
        : pickString([record], ["error", "error_message"]),
    raw,
  };
}

function clampProgress(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.max(0, Math.min(100, value));
}

// ----------------------------------------------------------------------------
// Gateway status (`GET /api/status` / `POST /api/gateway/restart`)
// ----------------------------------------------------------------------------

export type HermesGatewayStatus = {
  /** Whether the messaging gateway (cron/Slack/etc.) is currently running. */
  gatewayRunning?: boolean;
  /** Hermes version string the runtime reports, when present. */
  version?: string;
  /** An action handle when a lifecycle call backgrounded the work. */
  action?: string;
  raw: unknown;
};

export function parseGatewayStatus(raw: unknown): HermesGatewayStatus {
  const record = asRecord(raw);
  return {
    gatewayRunning: pickBool(
      [record],
      ["gateway_running", "gatewayRunning", "running"],
    ),
    version: pickString([record], ["version", "hermes_version"]),
    action: parseActionHandle(raw),
    raw,
  };
}

// ----------------------------------------------------------------------------
// Env (`GET /api/env`, `PUT /api/env`, `DELETE /api/env`, `POST /api/env/reveal`)
// ----------------------------------------------------------------------------

/** One configured env var as listed by `GET /api/env`. The dashboard does NOT
 * return the value in the listing (only presence/metadata); the real value is
 * fetched on demand via reveal. `hasValue` records whether a value is set. */
export type HermesEnvVar = {
  key: string;
  /** True when a value is configured for this key (the listing reports presence,
   * not the value itself). */
  hasValue?: boolean;
  /** A non-secret masked preview the dashboard may include (e.g. `sk-...abcd`).
   * Never the full value. */
  preview?: string;
  raw: unknown;
};

/** Result of `GET /api/env`: the configured env vars for a profile, plus the
 * untouched payload. The dashboard returns an opaque/untyped object, so this is
 * parsed permissively from whatever shape it carries (an array, a `vars`/`env`
 * map, or a plain key->value/meta map). */
export type HermesEnvListing = {
  vars: HermesEnvVar[];
  raw: unknown;
};

function parseEnvVar(key: string, value: unknown): HermesEnvVar {
  // The entry may be a bare value, or a metadata object.
  const record = asRecord(value);
  if (!record) {
    return {
      key,
      hasValue: value !== null && value !== undefined && value !== "",
      raw: value,
    };
  }
  return {
    key: pickString([record], ["key", "name"]) ?? key,
    hasValue:
      pickBool([record], ["has_value", "hasValue", "set", "present"]) ??
      // A masked preview implies a value is set.
      (nonEmptyString(record.preview ?? record.masked) ? true : undefined),
    preview: pickString([record], ["preview", "masked", "hint"]),
    raw: value,
  };
}

/** Parses `GET /api/env` defensively. Tolerates a bare array of entries, an
 * object wrapping the list under `vars`/`env`/`variables`, or a plain
 * key->value/meta map (the common FastAPI dict shape). Never returns a value. */
export function parseEnvListing(raw: unknown): HermesEnvListing {
  // Array form: [{ key, ... }, ...].
  if (Array.isArray(raw)) {
    const vars = raw
      .map((entry) => {
        const record = asRecord(entry);
        const key = record && pickString([record], ["key", "name"]);
        return key ? parseEnvVar(key, entry) : undefined;
      })
      .filter((v): v is HermesEnvVar => v !== undefined);
    return { vars, raw };
  }
  const record = asRecord(raw);
  if (!record) return { vars: [], raw };
  // Wrapped form: { vars: {...} | [...] } / { env: ... } / { variables: ... }.
  const inner =
    record.vars ?? record.env ?? record.variables ?? record.values ?? record;
  if (Array.isArray(inner)) {
    return parseEnvListing(inner);
  }
  const innerRecord = asRecord(inner) ?? record;
  const vars = Object.entries(innerRecord).map(([key, value]) =>
    parseEnvVar(key, value),
  );
  return { vars, raw };
}

/** Result of `POST /api/env/reveal`: the plaintext value for a key. This DOES
 * carry the secret (that is the point of reveal); the caller renders it into a
 * one-time field and the transport never logs the call. */
export type HermesEnvRevealResult = {
  key: string;
  /** The revealed plaintext value, or undefined when the key is unset. SECRET. */
  value?: string;
  raw: unknown;
};

/** Parses `POST /api/env/reveal`. The dashboard returns an opaque object; read
 * the value from common field names, tolerating a bare string body. */
export function parseEnvRevealResult(
  key: string,
  raw: unknown,
): HermesEnvRevealResult {
  if (typeof raw === "string") {
    return { key, value: raw.length > 0 ? raw : undefined, raw };
  }
  const record = asRecord(raw);
  return {
    key: pickString([record], ["key", "name"]) ?? key,
    value: pickString([record], ["value", "val", "plaintext", "secret"]),
    raw,
  };
}

/** Result of an env mutation. NOTE: this NEVER carries the value back — only
 * whether the write landed and whether a gateway restart is needed to apply it.
 * The value is write-only from June's side and must not round-trip into state. */
export type HermesEnvWriteResult = {
  key: string;
  ok: boolean;
  /** When the write applies, per Hermes (defaults to gateway-restart for env). */
  appliesAt: ApplicationTiming;
  /** Safe message, no value echoed. */
  message?: string;
  raw: unknown;
};

export function parseEnvWriteResult(
  key: string,
  raw: unknown,
): HermesEnvWriteResult {
  const record = asRecord(raw);
  const ok =
    pickBool([record], ["ok", "success", "saved", "updated"]) ??
    // A 2xx with an empty/opaque body still means the write landed.
    true;
  const timing = nonEmptyString(
    record?.applies_at ?? record?.appliesAt ?? record?.timing,
  )?.toLowerCase();
  const appliesAt: ApplicationTiming =
    timing === "immediate"
      ? "immediate"
      : timing === "next-session" || timing === "next_session"
        ? "next-session"
        : "gateway-restart";
  return {
    key,
    ok,
    appliesAt,
    message: pickString([record], ["message", "detail", "status_message"]),
    raw,
  };
}

// ----------------------------------------------------------------------------
// Skill setup requirements (parsed from a skill's metadata)
// ----------------------------------------------------------------------------

/**
 * One required environment variable a skill declares for secure setup, read from
 * `required_environment_variables` in the skill's metadata (or `SKILL.md`
 * frontmatter Hermes forwards). The VALUE is never modeled here: a secret is
 * write-only from June, so this carries only the name and the human-facing
 * prompt/help, never the secret itself.
 */
export type HermesSkillEnvRequirement = {
  /** The env var name, e.g. `OPENAI_API_KEY`. */
  name: string;
  /** A short label/prompt for the field, when declared. */
  prompt?: string;
  /** Longer help text, when declared. */
  help?: string;
  /** What the variable is needed for, when declared. */
  requiredFor?: string;
  /** Whether the skill marks this as required (vs optional). Defaults to true:
   * a declared env var is treated as required unless metadata says otherwise. */
  required: boolean;
};

/**
 * One non-secret config setting a skill declares under `metadata.hermes.config`,
 * stored under `skills.config` in `config.yaml`. Unlike a secret, the current
 * value IS shown (it is not sensitive), so the panel can render current vs
 * default.
 */
export type HermesSkillConfigRequirement = {
  /** The config key, e.g. `output_dir`. */
  key: string;
  /** A short label/prompt for the field, when declared. */
  prompt?: string;
  /** A longer description, when declared. */
  description?: string;
  /** The declared default, rendered as a hint and used to detect "still
   * default". A string for display; non-string defaults are stringified. */
  default?: string;
  /** Whether this config setting is marked required. Defaults to false: config
   * is optional unless the skill says full functionality requires it. */
  required: boolean;
};

/** A skill's parsed setup requirements: the env-style secrets and the
 * non-secret config settings it declares. Both lists are empty when the skill
 * declares nothing, so "no setup needed" is distinguishable from "not parsed". */
export type HermesSkillSetupRequirements = {
  env: HermesSkillEnvRequirement[];
  config: HermesSkillConfigRequirement[];
};

/** A truthy-but-not-explicitly-false read of a `required` flag, defaulting to
 * `fallback` when the field is absent or malformed. */
function readRequiredFlag(
  record: Record<string, unknown>,
  fallback: boolean,
): boolean {
  const explicit =
    pickBool([record], ["required", "is_required"]) ??
    // `optional: true` inverts to `required: false`.
    (pickBool([record], ["optional"]) === true ? false : undefined);
  return explicit ?? fallback;
}

/** Stringifies a default value for display. Objects/arrays are JSON-encoded so a
 * structured default still renders something honest rather than `[object
 * Object]`; null/undefined become undefined (no default shown). */
function stringifyDefault(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function parseEnvRequirement(
  raw: unknown,
): HermesSkillEnvRequirement | undefined {
  // A bare string is just the name (required by default).
  const bare = nonEmptyString(raw);
  if (bare) return { name: bare, required: true };
  const record = asRecord(raw);
  if (!record) return undefined;
  const name = pickString([record], ["name", "key", "env", "variable", "var"]);
  if (!name) return undefined;
  return {
    name,
    prompt: pickString([record], ["prompt", "label", "title"]),
    help: pickString([record], ["help", "description", "desc", "hint"]),
    requiredFor: pickString(
      [record],
      ["required_for", "requiredFor", "for", "purpose"],
    ),
    required: readRequiredFlag(record, true),
  };
}

function parseConfigRequirement(
  key: string | undefined,
  raw: unknown,
): HermesSkillConfigRequirement | undefined {
  const record = asRecord(raw);
  if (!record) {
    // A plain `key: default` entry: the value is the default, key from the map.
    if (!key) return undefined;
    return {
      key,
      default: stringifyDefault(raw),
      required: false,
    };
  }
  const resolvedKey =
    pickString([record], ["key", "name"]) ?? (key && key.length > 0 ? key : "");
  if (!resolvedKey) return undefined;
  return {
    key: resolvedKey,
    prompt: pickString([record], ["prompt", "label", "title"]),
    description: pickString([record], ["description", "desc", "help", "hint"]),
    default: stringifyDefault(
      record.default ?? record.fallback ?? record.value,
    ),
    required: readRequiredFlag(record, false),
  };
}

/** Reads the config requirement list from either an array of entries or a
 * `key -> default|meta` map (the common YAML shape `metadata.hermes.config`
 * uses). */
function parseConfigRequirements(
  value: unknown,
): HermesSkillConfigRequirement[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => parseConfigRequirement(undefined, entry))
      .filter((c): c is HermesSkillConfigRequirement => c !== undefined);
  }
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record)
    .map(([key, entry]) => parseConfigRequirement(key, entry))
    .filter((c): c is HermesSkillConfigRequirement => c !== undefined);
}

/**
 * Parses a skill's setup requirements from its raw metadata. Tolerates the
 * documented shapes: `required_environment_variables` (array of names or
 * `{ name, prompt, help, required_for }`) at the top level or under
 * `metadata`/`hermes`, and `metadata.hermes.config` (array or key->meta map).
 * Returns empty lists when nothing is declared. Never throws; never reads a
 * value.
 */
export function parseSkillSetupRequirements(
  raw: unknown,
): HermesSkillSetupRequirements {
  const record = asRecord(raw);
  if (!record) return { env: [], config: [] };
  const metadata = asRecord(record.metadata);
  const hermes =
    asRecord(metadata?.hermes) ?? asRecord(record.hermes) ?? undefined;

  // Env requirements may sit at the top level, under metadata, or under
  // metadata.hermes — check each in priority order, first hit wins.
  const envRaw =
    record.required_environment_variables ??
    record.requiredEnvironmentVariables ??
    metadata?.required_environment_variables ??
    hermes?.required_environment_variables ??
    hermes?.env ??
    metadata?.env;
  const env = Array.isArray(envRaw)
    ? envRaw
        .map(parseEnvRequirement)
        .filter((e): e is HermesSkillEnvRequirement => e !== undefined)
    : [];

  const configRaw =
    hermes?.config ?? metadata?.config ?? record.config ?? undefined;
  const config = parseConfigRequirements(configRaw);

  return { env, config };
}

// ----------------------------------------------------------------------------
// Config (`GET /api/config`, `PUT /api/config`) — non-secret skill config under
// `skills.config` in config.yaml.
// ----------------------------------------------------------------------------

/** Result of `GET /api/config`: the raw config tree (so a caller can read a
 * dotted path out of it). June reads `skills.config.<skill>.<key>` from this;
 * the tree may carry other keys we leave untouched. */
export type HermesConfigResult = {
  config: Record<string, unknown>;
  raw: unknown;
};

/** Parses `GET /api/config`. Tolerates the config under `config`/`data` or at
 * the top level. Never throws. */
export function parseConfigResult(raw: unknown): HermesConfigResult {
  const record = asRecord(raw);
  if (!record) return { config: {}, raw };
  const inner = asRecord(record.config) ?? asRecord(record.data) ?? record;
  return { config: inner, raw };
}

/** Result of a `PUT /api/config` write. Never carries a value back beyond an
 * ack; the key path is echoed for the notification label. */
export type HermesConfigWriteResult = {
  path: string;
  ok: boolean;
  /** When the write applies, per Hermes (defaults to next-session for skill
   * config, which the runtime reads when a session starts). */
  appliesAt: ApplicationTiming;
  message?: string;
  raw: unknown;
};

export function parseConfigWriteResult(
  path: string,
  raw: unknown,
): HermesConfigWriteResult {
  const record = asRecord(raw);
  const ok = pickBool([record], ["ok", "success", "saved", "updated"]) ?? true;
  const timing = nonEmptyString(
    record?.applies_at ?? record?.appliesAt ?? record?.timing,
  )?.toLowerCase();
  const appliesAt: ApplicationTiming =
    timing === "immediate"
      ? "immediate"
      : timing === "gateway-restart" || timing === "gateway_restart"
        ? "gateway-restart"
        : "next-session";
  return {
    path,
    ok,
    appliesAt,
    message: pickString([record], ["message", "detail", "status_message"]),
    raw,
  };
}

/** Reads a single dotted path (`a.b.c`) out of a parsed config tree, returning
 * the value as a display string or undefined when absent. Used to read a skill's
 * current `skills.config.<skill>.<key>` value. Non-string leaves are stringified
 * so a numeric/boolean config still renders. */
export function readConfigPath(
  config: Record<string, unknown>,
  path: readonly string[],
): string | undefined {
  let cursor: unknown = config;
  for (const segment of path) {
    const record = asRecord(cursor);
    if (!record) return undefined;
    cursor = record[segment];
  }
  return stringifyDefault(cursor);
}

// ----------------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------------

/** Extracts an array from a response that is either a bare array or an object
 * wrapping the array under one of `keys`. Anything else yields `[]` so a list
 * parser never throws and a broken/empty response renders as no items. */
function listFrom(raw: unknown, keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  const record = asRecord(raw);
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** Reads a simple `{ ok, name, enabled }` mutation ack, the shape the existing
 * skill/toolset toggle Tauri commands resolve to. Tolerant of a bare 2xx. */
export type HermesToggleResult = {
  ok: boolean;
  name: string;
  enabled: boolean;
};

export function parseToggleResult(
  name: string,
  enabled: boolean,
  raw: unknown,
): HermesToggleResult {
  const record = asRecord(raw);
  return {
    ok: pickBool([record], ["ok", "success"]) ?? true,
    name: pickString([record], ["name", "id"]) ?? name,
    enabled: pickBool([record], ["enabled", "active"]) ?? enabled,
  };
}
