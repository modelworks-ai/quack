/**
 * Circuit URL parsing, version resolution, adaptor discovery, and SSE
 * adaptor lifecycle (find/create/delete).
 *
 * @module
 */

import {
  getValidAccessToken,
  refreshToken,
} from "./auth.js";
import {
  addCircuitToConfig,
  getCircuitState,
  readConfig,
  readState,
  removeCircuitFromConfig,
  removeCircuitState,
  upsertCircuitState,
} from "./project.js";
import type {
  CircuitAdaptorPublic,
  CircuitConfigEntry,
  CircuitPublic,
  CircuitStateEntry,
  CircuitVersionPublic,
  ParsedCircuitRef,
} from "./types.js";

/**
 * HTTP error with status code, thrown by `parseJson` on non-OK responses.
 * Lets callers distinguish 403 (access denied) from other failures.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, statusText: string, body: string) {
    super(`HTTP ${status} ${statusText}${body ? ` — ${body}` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

/** The adapter type string for OpenAI-compatible SSE adaptors. */
const OPEN_AI_SSE = "OPEN_AI_SSE";

/**
 * Map adapter type from circuit definition format (SCREAMING_SNAKE_CASE,
 * as found in `json_blob`'s `adapters` array) to API enum format
 * (PascalCase, as required by `POST /circuit-adaptors`).
 *
 * Example: `"OPEN_AI_SSE"` → `"OpenAiSse"`.
 */
const ADAPTER_TYPE_MAP: Record<string, string> = {
  OPEN_AI_SSE: "OpenAiSse",
  MODELWORKS_SSE: "ModelworksSse",
  MODELWORKS_HTTP: "ModelworksHTTP",
  MCP: "MCP",
  XMCP: "XMCP",
  NONE: "None",
};

/** Convert a circuit-definition adapter type to the API enum format. */
export function toApiAdapterType(defType: string): string {
  return ADAPTER_TYPE_MAP[defType] ?? defType;
}

/** Convert an API enum adapter type back to circuit-definition format. */
export function fromApiAdapterType(apiType: string): string {
  for (const [def, api] of Object.entries(ADAPTER_TYPE_MAP)) {
    if (api === apiType) return def;
  }
  return apiType;
}

// ---------------------------------------------------------------------------
// URL / UID parsing
// ---------------------------------------------------------------------------

/**
 * Parse a circuit reference: a full URL, a bare circuit UID (`c-xxx`),
 * or a bare version UID (`cv-xxx`).
 *
 * Accepts:
 * - `https://modelworks.ai/circuits/<circuit_uid>`
 * - `https://modelworks.ai/circuits/<circuit_uid>/versions/<version_uid>`
 * - `https://modelworks.ai/<username>/<circuitName>` (slug-based URL)
 * - `<circuit_uid>` or `c-xxx`
 * - `<version_uid>` or `cv-xxx`
 */
export function parseCircuitRef(input: string): ParsedCircuitRef {
  // Bare UIDs first.
  if (input.startsWith("cv-")) {
    return { circuit_uid: "", version_uid: input, slug: null };
  }
  if (input.startsWith("c-")) {
    return { circuit_uid: input, version_uid: null, slug: null };
  }

  // URLs.
  try {
    const url = new URL(input);
    const parts = url.pathname.split("/").filter(Boolean);
    // Expected: ["circuits", "<circuit_uid>"] or ["circuits", "<circuit_uid>", "versions", "<version_uid>"]
    const circuitsIdx = parts.indexOf("circuits");
    if (circuitsIdx !== -1 && circuitsIdx + 1 < parts.length) {
      const circuit_uid = parts[circuitsIdx + 1];
      let version_uid: string | null = null;
      const versionsIdx = parts.indexOf("versions", circuitsIdx);
      if (versionsIdx !== -1 && versionsIdx + 1 < parts.length) {
        version_uid = parts[versionsIdx + 1];
      }
      return { circuit_uid, version_uid, slug: null };
    }

    // Slug-based URL: ["<username>", "<circuitName>"]
    if (parts.length === 2) {
      const slug = `${parts[0]}/${parts[1]}`;
      return { circuit_uid: "", version_uid: null, slug };
    }

    throw new Error(`Could not find circuit UID in URL: ${input}`);
  } catch (err) {
    throw new Error(
      `Invalid circuit reference: ${input}. Use a circuit URL, c-xxx, or cv-xxx. (${
        (err as Error).message
      })`,
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** Authenticated fetch — injects Bearer token, refreshes on 401. */
async function authedFetch(
  apiBase: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const token = await getValidAccessToken();
  if (!token) {
    throw new Error("Not logged in. Run `quack login` first.");
  }

  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);

  const res = await fetch(`${apiBase}${path}`, { ...init, headers });

  // One refresh + retry on 401.
  if (res.status === 401) {
    const ok = await refreshToken();
    if (ok) {
      const newToken = await getValidAccessToken();
      if (newToken) {
        headers.set("authorization", `Bearer ${newToken}`);
        return fetch(`${apiBase}${path}`, { ...init, headers });
      }
    }
  }

  return res;
}

/** Parse a JSON API response, throwing a friendly error on non-OK. */
async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(res.status, res.statusText, text);
  }
  const body = (await res.json()) as T;
  return body;
}

/**
 * Unwrap the ModelWorks API envelope.
 *
 * The API wraps all responses in `{ status, status_code, payload }`.
 * This extracts the `payload` field (the actual data) and throws if
 * the envelope reports an error.
 */
function unwrap<T>(body: unknown): T {
  if (body && typeof body === "object" && "payload" in body) {
    const envelope = body as {
      status: string;
      status_code: number;
      payload: T;
    };
    if (envelope.status === "error") {
      throw new Error(`API error: ${JSON.stringify(envelope)}`);
    }
    return envelope.payload;
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Version resolution
// ---------------------------------------------------------------------------

/** Fetch a circuit by UID (`GET /circuits/<uid>`). */
export async function getCircuit(
  apiBase: string,
  circuitUid: string,
): Promise<CircuitPublic> {
  const res = await authedFetch(apiBase, `/api/circuits/${circuitUid}`);
  return unwrap<CircuitPublic>(await parseJson(res));
}

/** Fetch a user's username by UID (`GET /users/<uid>`). */
export async function getUsername(
  apiBase: string,
  userUid: string,
): Promise<string> {
  const res = await authedFetch(apiBase, `/api/users/${userUid}`);
  const payload = await parseJson<{ username?: string }>(res);
  return unwrap<{ username?: string }>(payload).username ?? "unknown";
}

/** Resolve a slug (`"username/circuitName"`) to a circuit UID via the API. */
async function resolveSlug(apiBase: string, slug: string): Promise<string> {
  const res = await authedFetch(apiBase, `/api/slug/${slug}`);
  const data = unwrap<{ entity_type: string; entity_uid: string }>(
    await parseJson(res),
  );
  if (data.entity_type !== "circuit") {
    throw new Error(
      `'${slug}' resolved to a ${data.entity_type}, not a circuit. ` +
        `Use a circuit URL, c-xxx, or cv-xxx.`,
    );
  }
  return data.entity_uid;
}

/**
 * Resolve a circuit reference to a RUNNING version.
 *
 * If `version_uid` is given, fetch that version directly (must be RUNNING
 * for non-owners; owners can also use STAGING). Otherwise list the circuit's
 * versions and pick the latest RUNNING one.
 */
export async function resolveRunningVersion(
  apiBase: string,
  ref: ParsedCircuitRef,
): Promise<{ circuit: CircuitPublic; version: CircuitVersionPublic }> {
  let circuitUid = ref.circuit_uid;

  // Slug-based URL (e.g. https://modelworks.ai/openscale/deepseek-v41-flash):
  // resolve the slug to a circuit UID via the API before proceeding.
  if (!circuitUid && ref.slug) {
    circuitUid = await resolveSlug(apiBase, ref.slug);
  }

  // If only a version UID was given, fetch the version first to discover
  // its parent circuit UID.
  if (!circuitUid && ref.version_uid) {
    const vRes = await authedFetch(apiBase, `/api/circuit-versions/${ref.version_uid}`);
    const version = unwrap<CircuitVersionPublic>(await parseJson(vRes));
    circuitUid = version.circuit_uid;
    const circuit = await getCircuit(apiBase, circuitUid);
    return { circuit, version };
  }

  if (!circuitUid) {
    throw new Error("Could not resolve circuit UID from the given reference.");
  }

  const circuit = await getCircuit(apiBase, circuitUid);

  if (ref.version_uid) {
    const vRes = await authedFetch(apiBase, `/api/circuit-versions/${ref.version_uid}`);
    const version = unwrap<CircuitVersionPublic>(await parseJson(vRes));
    return { circuit, version };
  }

  // No version specified — get the primary (RUNNING) version directly.
  const res = await authedFetch(apiBase, `/api/circuits/${circuitUid}/primary`);
  const version = unwrap<CircuitVersionPublic | null>(await parseJson(res));

  if (!version) {
    throw new Error(
      `Circuit ${circuitUid} has no primary (RUNNING) version. Publish or promote a version first.`,
    );
  }

  return { circuit, version };
}

// ---------------------------------------------------------------------------
// Adaptor discovery
// ---------------------------------------------------------------------------

/** List existing adaptors for a circuit version (`GET /circuit-adaptors/by-circuit-version/<uid>`). */
export async function listAdaptors(
  apiBase: string,
  versionUid: string,
): Promise<CircuitAdaptorPublic[]> {
  const res = await authedFetch(
    apiBase,
    `/api/circuit-adaptors/by-circuit-version/${versionUid}`,
  );
  return unwrap<CircuitAdaptorPublic[]>(await parseJson(res));
}

/**
 * Discover the adapter types a circuit version supports.
 *
 * Primary path: parse the `json_blob` of the circuit version and read
 * its `adapters` array (visible for public circuits and owners).
 *
 * Fallback (protected, non-owner — no `json_blob`): list existing
 * adaptors and read their `adapter_type` values.
 *
 * Returns `{ adapters, determined }` where `determined` is false when
 * neither source yielded adapter types (no `json_blob` and no existing
 * adaptors). In that case the caller should assume SSE-compatible and
 * let runtime validation be the safety net.
 */
export async function discoverAdapters(
  version: CircuitVersionPublic,
  apiBase: string,
): Promise<{ adapters: string[]; determined: boolean }> {
  // Primary: json_blob's `adapters` array.
  if (version.json_blob) {
    try {
      const def = JSON.parse(version.json_blob) as {
        adapters?: Array<{ type: string }>;
      };
      if (Array.isArray(def.adapters)) {
        return { adapters: def.adapters.map((a) => a.type), determined: true };
      }
    } catch {
      // Fall through to the list-based fallback.
    }
  }

  // Fallback: list existing adaptors (API returns PascalCase enum values;
  // normalize to circuit-definition format for consistency).
  const adaptors = await listAdaptors(apiBase, version.uid);
  const adapters = adaptors.map((a) => fromApiAdapterType(a.adapter_type));
  return { adapters, determined: adapters.length > 0 };
}

/** Is `OPEN_AI_SSE` in the list of supported adapters? */
export function isSseCompatible(adapters: string[]): boolean {
  return adapters.includes(OPEN_AI_SSE);
}

// ---------------------------------------------------------------------------
// SSE adaptor lifecycle
// ---------------------------------------------------------------------------

/**
 * Find the **public** (system-created) `OPEN_AI_SSE` adaptor for a circuit version.
 *
 * When a circuit version is uploaded, the system creates public adaptors from
 * the circuit file's `adapters` array. These have `user_uid: null` and require
 * Bearer auth (the proxy injects it). We use these instead of creating temporal
 * adaptors — no per-user adaptor lifecycle needed.
 *
 * Returns the adaptor UID (`ca-xxx`), or `null` if no public SSE adaptor exists.
 */
export async function findPublicSseAdaptor(
  apiBase: string,
  versionUid: string,
): Promise<string | null> {
  const existing = await listAdaptors(apiBase, versionUid);
  const found = existing.find(
    (a) => fromApiAdapterType(a.adapter_type) === OPEN_AI_SSE && a.user_uid === null,
  );
  return found?.uid ?? null;
}

// ---------------------------------------------------------------------------
// `quack add` / `quack rm` / `quack refresh` — high-level operations
// ---------------------------------------------------------------------------

/** Result of a `quack add` — used to print a summary. */
export interface AddResult {
  circuit_uid: string;
  version_uid: string;
  name: string;
  adapters: string[];
  sse_adaptor_uid: string | null;
  sse_compatible: boolean;
  added: boolean; // false if already in config
}

/**
 * `quack add <circuit-url>` — resolve, discover, create SSE adaptor, snapshot.
 *
 * Reads auth + api base from the stored credentials.
 */
export async function addCircuit(input: string, apiBase: string): Promise<AddResult> {
  const ref = parseCircuitRef(input);
  const { circuit, version } = await resolveRunningVersion(apiBase, ref);
  const { adapters, determined } = await discoverAdapters(version, apiBase);

  // List existing adaptors (public, system-created — user_uid: null).
  const existingAdaptors = await listAdaptors(apiBase, version.uid);
  const publicAdaptors = existingAdaptors.filter((a) => a.user_uid === null);

  // Build adaptor_uids map from public adaptors only.
  const adaptor_uids: Record<string, string> = {};
  for (const a of publicAdaptors) {
    adaptor_uids[fromApiAdapterType(a.adapter_type)] = a.uid;
  }

  // Find the public OPEN_AI_SSE adaptor (no temporal creation).
  const sse_adaptor_uid = await findPublicSseAdaptor(apiBase, version.uid);

  // If we found an SSE adaptor despite not being able to determine
  // adapters, mark SSE-compatible in state (unverified).
  const effectiveAdapters = determined
    ? adapters
    : (sse_adaptor_uid ? [OPEN_AI_SSE, ...adapters] : adapters);

  // Fetch the circuit owner's username for display (`<username>/<circuit_name>`).
  const owner_username = await getUsername(apiBase, circuit.user_uid);

  // Config entry (committable).
  const now = new Date().toISOString();
  const configEntry: CircuitConfigEntry = {
    url: input,
    circuit_uid: circuit.uid,
    name: circuit.name,
    added_at: now,
  };

  // State entry (gitignored).
  const stateEntry: CircuitStateEntry = {
    circuit_uid: circuit.uid,
    version_uid: version.uid,
    circuit_name: circuit.name,
    owner_username,
    adapters: effectiveAdapters,
    sse_adaptor_uid,
    adaptor_uids,
    resolved_at: now,
  };

  // Check if already in config.
  const existingConfig = readConfig();
  const already = existingConfig.circuits.some((c) => c.circuit_uid === circuit.uid);

  if (already) {
    // Still update state (the circuit may have a new version).
    upsertCircuitState(stateEntry);
  } else {
    // Add to config + state.
    addCircuitToConfig(configEntry);
    upsertCircuitState(stateEntry);
  }

  return {
    circuit_uid: circuit.uid,
    version_uid: version.uid,
    name: circuit.name,
    adapters: effectiveAdapters,
    sse_adaptor_uid,
    sse_compatible: sse_adaptor_uid !== null,
    added: !already,
  };
}

/**
 * `quack circuit remove <circuit-uid|url>` — remove from config + state.
 *
 * Public adaptors are NOT deleted — they belong to the circuit (system-created),
 * not to the quack user. Other users of the same circuit rely on them.
 */
export async function removeCircuit(
  input: string,
  apiBase: string,
): Promise<{ circuit_uid: string; name: string }> {
  const ref = parseCircuitRef(input);
  let circuitUid = ref.circuit_uid;

  const config = readConfig();

  // For slug-based URLs, try matching by the stored `url` first (no API call).
  // If that fails, resolve the slug via the API to get the circuit UID.
  if (ref.slug && !circuitUid) {
    const byUrl = config.circuits.find((c) => c.url === input);
    if (byUrl) {
      circuitUid = byUrl.circuit_uid;
    } else {
      circuitUid = await resolveSlug(apiBase, ref.slug);
    }
  }

  if (!circuitUid) {
    throw new Error("Could not resolve circuit UID from the given reference.");
  }

  // Find the circuit name from config.
  const entry = config.circuits.find((c) => c.circuit_uid === circuitUid);
  if (!entry) {
    throw new Error(`Circuit ${circuitUid} is not in this project.`);
  }

  removeCircuitFromConfig(circuitUid);
  removeCircuitState(circuitUid);

  return { circuit_uid: circuitUid, name: entry.name };
}

/** `quack refresh [circuit-uid]` — re-resolve all (or one) circuit. */
export async function refreshCircuits(
  apiBase: string,
  circuitUid?: string,
): Promise<AddResult[]> {
  const config = readConfig();
  const targets = circuitUid
    ? config.circuits.filter((c) => c.circuit_uid === circuitUid)
    : config.circuits;

  if (circuitUid && targets.length === 0) {
    throw new Error(`Circuit ${circuitUid} is not in this project.`);
  }

  const results: AddResult[] = [];
  for (const entry of targets) {
    try {
      // Re-add (re-resolve + re-discover + re-create). `addCircuit` upserts state.
      const result = await addCircuit(entry.url, apiBase);
      result.added = false; // It was already in config; we just refreshed.
      results.push(result);
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) {
        process.stderr.write(
          `⚠ skipping ${entry.circuit_uid} (no access — not authorized)\n`,
        );
        continue;
      }
      throw err;
    }
  }
  return results;
}

/**
 * Auto-sync: for circuits in config but missing from state (cloned repo
 * case), run the same resolve + discover + create flow as `quack add`,
 * writing to state only (not config).
 *
 * Called by `quack opencode` before building the injected config.
 */
export async function ensureState(apiBase: string): Promise<void> {
  const config = readConfig();
  const state = readState();

  const missing = config.circuits.filter(
    (c) => !(c.circuit_uid in state.circuits),
  );

  for (const entry of missing) {
    try {
      await addCircuit(entry.url, apiBase);
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) {
        process.stderr.write(
          `⚠ skipping ${entry.circuit_uid} (no access — not authorized)\n`,
        );
        continue;
      }
      throw err;
    }
  }
}
