/**
 * Shared types for @modelworks/quack.
 *
 * @module
 */

/**
 * Stored OAuth credentials for the authenticated user.
 *
 * Persisted at `~/.config/quack/credentials.json` (chmod 0600).
 * The `api_base` field is stored here so token refresh hits the
 * right server (supports `QUACK_API_BASE` / `--api-base` overrides).
 */
export interface Credentials {
  access_token: string;
  refresh_token: string;
  /** Unix timestamp (seconds) when the access token expires. */
  expires_at: number;
  token_type: string;
  user_uid: string;
  /** Base URL of the ModelWorks API, e.g. `https://modelworks.ai`. */
  api_base: string;
}

/**
 * Dynamic Client Registration record.
 *
 * Persisted at `~/.config/quack/client.json`. Created once on first
 * `quack login`, reused on subsequent logins.
 */
export interface ClientRegistration {
  client_id: string;
}

/**
 * One entry in `.quack/config.json`'s `circuits` array.
 *
 * Committable and shareable across a team — contains only public
 * metadata, no user-specific state.
 */
export interface CircuitConfigEntry {
  url: string;
  circuit_uid: string;
  name: string;
  /** ISO 8601 timestamp when the circuit was added. */
  added_at: string;
}

/**
 * One entry in `.quack/state.json`'s `circuits` map, keyed by `circuit_uid`.
 *
 * Gitignored, per-user — a snapshot from `quack add` / `quack refresh`
 * / `quack opencode` auto-sync. Holds everything `quack opencode`
 * needs to build the opencode config without re-fetching.
 */
export interface CircuitStateEntry {
  circuit_uid: string;
  /** The RUNNING version resolved at add/refresh time. */
  version_uid: string;
  circuit_name: string;
  /** Owner's username (e.g. `alice`), for display as `<username>/<circuit_name>`. */
  owner_username: string;
  /**
   * Adapter types the circuit supports, e.g.
   * `["OPEN_AI_SSE", "MODELWORKS_HTTP", "MCP"]`.
   *
   * Discovered from the circuit version's `json_blob` `adapters`
   * array when visible (public/owner), or from listing existing
   * adaptors when `json_blob` is hidden (protected, non-owner).
   */
  adapters: string[];
  /**
   * UID (`ca-xxx`) of the temporal OpenAI SSE adaptor quack created
   * for this circuit, or `null` if the circuit isn't SSE-compatible.
   */
  sse_adaptor_uid: string | null;
  /**
   * Map of adapter type → adaptor UID (`ca-xxx`) for each temporal
   * adaptor quack created. Currently only `OPEN_AI_SSE` is created
   * by quack, but existing adaptors discovered via the list endpoint
   * are also stored here.
   */
  adaptor_uids: Record<string, string>;
  /** ISO 8601 timestamp of the last resolution. */
  resolved_at: string;
}

/**
 * `.quack/config.json` — the project-level, committable config.
 */
export interface QuackConfig {
  version: number;
  /**
   * Agent to launch when the user runs bare `quack` (no args).
   * Optional — if absent, the fallback chain (last_agent →
   * interactive pick → error) resolves the agent.
   */
  default_agent?: string;
  /**
   * Circuit UID (`c-xxx`) to use as the default model in OpenCode.
   * Team-shared — committed to `config.json`. Set via `quack circuit use`
   * or auto-set to the first SSE-compatible circuit on `quack circuit add`.
   * At launch, resolved to an OpenCode model ID and injected as `model`.
   */
  default_circuit?: string;
  circuits: CircuitConfigEntry[];
}

/**
 * `.quack/state.json` — the per-user, gitignored cached state.
 */
export interface QuackState {
  circuits: Record<string, CircuitStateEntry>;
  /**
   * The last agent successfully launched by bare `quack`.
   * Per-user convenience — used as a fallback when
   * `default_agent` is not set in config.json.
   */
  last_agent?: string;
}

/**
 * Parsed circuit URL or bare UID.
 */
export interface ParsedCircuitRef {
  circuit_uid: string;
  version_uid: string | null;
}

/**
 * A circuit version record as returned by the ModelWorks API
 * (`GET /circuits/<uid>/versions` or `GET /circuit-versions/<uid>`).
 *
 * Only the fields quack reads are typed here. `json_blob` is optional
 * because it's hidden for protected circuits when the caller is not
 * the owner (see `circuit_version.rs` visibility rules).
 */
export interface CircuitVersionPublic {
  uid: string;
  circuit_uid: string;
  state: string;
  json_blob: string | null;
  updated_at: string;
}

/**
 * A circuit record as returned by `GET /circuits/<uid>`.
 */
export interface CircuitPublic {
  uid: string;
  name: string;
  user_uid: string;
  is_private: boolean;
  is_protected: boolean;
}

/**
 * A circuit adaptor record as returned by
 * `GET /circuit-adaptors/by-circuit-version/<version_uid>`.
 */
export interface CircuitAdaptorPublic {
  uid: string;
  circuit_version_uid: string;
  adapter_type: string;
  user_uid: string | null;
  user_token_uid: string | null;
}

/**
 * Handle to a running local proxy.
 */
export interface ProxyHandle {
  port: number;
  close: () => void;
}

/**
 * Options for {@link startProxy}.
 */
export interface ProxyOptions {
  /** Upstream API base URL, e.g. `https://modelworks.ai`. */
  apiBase: string;
  /** Returns the current access token (refreshed if needed before calling). */
  getAccessToken: () => string;
  /** Refreshes the access token. Returns `true` on success. */
  refreshToken: () => Promise<boolean>;
  /** Optional request logger for `--verbose`. */
  onLog?: (method: string, path: string, status: number) => void;
}

/**
 * The OpenCode config that quack injects via `OPENCODE_CONFIG_CONTENT`.
 *
 * Only the two top-level keys quack touches are typed here.
 */
export interface OpenCodeConfig {
  $schema?: string;
  /** Default model ID, e.g. `circuit-wandb-glm-52/wandb-glm-52`. */
  model?: string;
  mcp?: {
    servers: Record<string, OpenCodeMcpServer>;
  };
  provider?: Record<string, OpenCodeProvider>;
}

export interface OpenCodeMcpServer {
  type: "remote";
  url: string;
  oauth: false;
  protocol: "auto" | "2026-07-28" | "legacy";
  headers?: Record<string, string>;
}

export interface OpenCodeProvider {
  npm: string;
  name: string;
  options: {
    baseURL: string;
    apiKey?: string;
  };
  models: Record<string, { name: string }>;
}
