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
  CreateCircuitAdaptorBody,
  ParsedCircuitRef,
} from "./types.js";

/** The adapter type string for OpenAI-compatible SSE adaptors. */
const OPEN_AI_SSE = "OPEN_AI_SSE";

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
 * - `<circuit_uid>` or `c-xxx`
 * - `<version_uid>` or `cv-xxx`
 */
export function parseCircuitRef(input: string): ParsedCircuitRef {
  // Bare UIDs first.
  if (input.startsWith("cv-")) {
    return { circuit_uid: "", version_uid: input };
  }
  if (input.startsWith("c-")) {
    return { circuit_uid: input, version_uid: null };
  }

  // URLs.
  try {
    const url = new URL(input);
    const parts = url.pathname.split("/").filter(Boolean);
    // Expected: ["circuits", "<circuit_uid>"] or ["circuits", "<circuit_uid>", "versions", "<version_uid>"]
    const circuitsIdx = parts.indexOf("circuits");
    if (circuitsIdx === -1 || circuitsIdx + 1 >= parts.length) {
      throw new Error(`Could not find circuit UID in URL: ${input}`);
    }
    const circuit_uid = parts[circuitsIdx + 1];
    let version_uid: string | null = null;
    const versionsIdx = parts.indexOf("versions", circuitsIdx);
    if (versionsIdx !== -1 && versionsIdx + 1 < parts.length) {
      version_uid = parts[versionsIdx + 1];
    }
    return { circuit_uid, version_uid };
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
    throw new Error(
      `HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
    );
  }
  return (await res.json()) as T;
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
  const body = await parseJson<{ data: CircuitPublic } | CircuitPublic>(res);
  // The API wraps single-resource responses in `{ data: ... }`.
  return "data" in body ? body.data : body;
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

  // If only a version UID was given, fetch the version first to discover
  // its parent circuit UID.
  if (!circuitUid && ref.version_uid) {
    const vRes = await authedFetch(apiBase, `/api/circuit-versions/${ref.version_uid}`);
    const vBody = await parseJson<{ data: CircuitVersionPublic } | CircuitVersionPublic>(vRes);
    const version = "data" in vBody ? vBody.data : vBody;
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
    const vBody = await parseJson<{ data: CircuitVersionPublic } | CircuitVersionPublic>(vRes);
    const version = "data" in vBody ? vBody.data : vBody;
    return { circuit, version };
  }

  // No version specified — list and pick the latest RUNNING.
  const versions = await listVersions(apiBase, circuitUid);
  const running = versions.filter((v) => v.state.toUpperCase() === "RUNNING");
  if (running.length === 0) {
    throw new Error(
      `Circuit ${circuitUid} has no RUNNING version. Publish or promote a version first.`,
    );
  }
  // Latest by `updated_at` (ISO string sorts lexicographically).
  running.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return { circuit, version: running[0] };
}

/**
 * List a circuit's versions (`GET /circuits/<uid>/versions`).
 *
 * **To verify during impl:** the exact REST path. This assumes
 * `/circuits/<uid>/versions`; if it differs, only this function changes.
 */
export async function listVersions(
  apiBase: string,
  circuitUid: string,
): Promise<CircuitVersionPublic[]> {
  const res = await authedFetch(apiBase, `/api/circuits/${circuitUid}/versions`);
  const body = await parseJson<{ data: CircuitVersionPublic[] } | CircuitVersionPublic[]>(res);
  return "data" in body ? body.data : body;
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
  const body = await parseJson<{ data: CircuitAdaptorPublic[] } | CircuitAdaptorPublic[]>(res);
  return "data" in body ? body.data : body;
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
 * Returns an empty array if neither source yields adapter types.
 */
export async function discoverAdapters(
  version: CircuitVersionPublic,
  apiBase: string,
): Promise<string[]> {
  // Primary: json_blob's `adapters` array.
  if (version.json_blob) {
    try {
      const def = JSON.parse(version.json_blob) as {
        adapters?: Array<{ type: string }>;
      };
      if (Array.isArray(def.adapters)) {
        return def.adapters.map((a) => a.type);
      }
    } catch {
      // Fall through to the list-based fallback.
    }
  }

  // Fallback: list existing adaptors.
  const adaptors = await listAdaptors(apiBase, version.uid);
  return adaptors.map((a) => a.adapter_type);
}

/** Is `OPEN_AI_SSE` in the list of supported adapters? */
export function isSseCompatible(adapters: string[]): boolean {
  return adapters.includes(OPEN_AI_SSE);
}

// ---------------------------------------------------------------------------
// SSE adaptor lifecycle
// ---------------------------------------------------------------------------

/**
 * Find an existing `OPEN_AI_SSE` adaptor owned by the caller, or create one.
 *
 * Returns the adaptor UID (`ca-xxx`), or `null` if the circuit isn't
 * SSE-compatible.
 */
export async function ensureSseAdaptor(
  apiBase: string,
  versionUid: string,
  adapters: string[],
): Promise<string | null> {
  if (!isSseCompatible(adapters)) return null;

  const existing = await listAdaptors(apiBase, versionUid);
  const found = existing.find(
    (a) => a.adapter_type === OPEN_AI_SSE,
  );
  if (found) return found.uid;

  // Create a new temporal SSE adaptor.
  const body: CreateCircuitAdaptorBody = {
    circuit_version_uid: versionUid,
    adapter_type: OPEN_AI_SSE,
  };
  const res = await authedFetch(apiBase, "/api/circuit-adaptors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const created = await parseJson<{ data: CircuitAdaptorPublic } | CircuitAdaptorPublic>(res);
  const adaptor = "data" in created ? created.data : created;
  return adaptor.uid;
}

/** Delete a circuit adaptor by UID (`DELETE /circuit-adaptors/<uid>`). */
export async function deleteAdaptor(
  apiBase: string,
  adaptorUid: string,
): Promise<void> {
  const res = await authedFetch(apiBase, `/api/circuit-adaptors/${adaptorUid}`, {
    method: "DELETE",
  });
  // 404 is fine — already deleted.
  if (!res.ok && res.status !== 404) {
    await parseJson<unknown>(res);
  }
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
  const adapters = await discoverAdapters(version, apiBase);
  const sse_adaptor_uid = await ensureSseAdaptor(apiBase, version.uid, adapters);

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
    adapters,
    sse_adaptor_uid,
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
    adapters,
    sse_adaptor_uid,
    sse_compatible: sse_adaptor_uid !== null,
    added: !already,
  };
}

/** `quack rm <circuit-uid|url>` — delete adaptor, remove from config + state. */
export async function removeCircuit(
  input: string,
  apiBase: string,
  keepAdaptors = false,
): Promise<{ circuit_uid: string; name: string }> {
  const ref = parseCircuitRef(input);
  const circuitUid = ref.circuit_uid;

  // Find the circuit name from config.
  const config = readConfig();
  const entry = config.circuits.find((c) => c.circuit_uid === circuitUid);
  if (!entry) {
    throw new Error(`Circuit ${circuitUid} is not in this project.`);
  }

  // Delete the SSE adaptor on the server.
  if (!keepAdaptors) {
    const state = getCircuitState(circuitUid);
    if (state?.sse_adaptor_uid) {
      await deleteAdaptor(apiBase, state.sse_adaptor_uid);
    }
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
    // Re-add (re-resolve + re-discover + re-create). `addCircuit` upserts state.
    const result = await addCircuit(entry.url, apiBase);
    result.added = false; // It was already in config; we just refreshed.
    results.push(result);
  }
  return results;
}
