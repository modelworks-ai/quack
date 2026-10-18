/**
 * OAuth flow, PKCE, DCR, token storage, and refresh.
 *
 * Uses only Node 18+ built-ins (`crypto`, `node:fs`, `node:path`, `node:os`,
 * `node:http`, `node:child_process`, global `fetch`).
 *
 * @module
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { exec } from "node:child_process";

import type {
  ClientRegistration,
  Credentials,
} from "./types.js";

/** Default callback port. May change if the API requires an exact match. */
const CALLBACK_PORT = 8421;
/** Redirect URI registered via DCR. */
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;

/** Default ModelWorks API base (host root; all API routes are under `/api`). */
const DEFAULT_API_BASE = "https://modelworks.ai";

/**
 * Resolve the quack config directory.
 *
 * Honors `$XDG_CONFIG_HOME` when set; falls back to `~/.config/quack/`.
 */
export function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, "quack");
  return path.join(os.homedir(), ".config", "quack");
}

/** Path to `credentials.json`. */
export function credentialsPath(): string {
  return path.join(getConfigDir(), "credentials.json");
}

/** Path to `client.json` (DCR record). */
export function clientPath(): string {
  return path.join(getConfigDir(), "client.json");
}

/**
 * Resolve the effective API base.
 *
 * Order of precedence: `QUACK_API_BASE` env var > stored `credentials.api_base`
 * > {@link DEFAULT_API_BASE}.
 *
 * Pass the stored credentials to honor a previously-set override.
 */
export function getApiBase(stored?: Credentials | null): string {
  const fromEnv = process.env.QUACK_API_BASE;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (stored?.api_base) return stored.api_base.replace(/\/$/, "");
  return DEFAULT_API_BASE;
}

/** Write a JSON file with `0o600` permissions, creating parent dirs. */
function writeJsonSecure(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), {
    mode: 0o600,
  });
}

/** Read a JSON file, returning `null` if missing or unparseable. */
function readJson<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Credentials storage
// ---------------------------------------------------------------------------

/** Load stored credentials, or `null` if not logged in. */
export function loadCredentials(): Credentials | null {
  return readJson<Credentials>(credentialsPath());
}

/** Persist credentials to disk with `0600` permissions. */
export function saveCredentials(creds: Credentials): void {
  writeJsonSecure(credentialsPath(), creds);
}

/** Delete stored credentials (used by `quack logout`). */
export function deleteCredentials(): void {
  try {
    fs.unlinkSync(credentialsPath());
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// ---------------------------------------------------------------------------
// DCR (Dynamic Client Registration)
// ---------------------------------------------------------------------------

/** Load the stored DCR client, or `null` if not yet registered. */
export function loadClient(): ClientRegistration | null {
  return readJson<ClientRegistration>(clientPath());
}

/** Persist the DCR client record. */
export function saveClient(client: ClientRegistration): void {
  writeJsonSecure(clientPath(), client);
}

/**
 * Ensure a DCR client exists. Registers one via `POST /oauth/register`
 * if `client.json` is missing. Returns the `client_id`.
 *
 * Re-registration on every login is wasteful and creates orphan rows;
 * we register once and reuse.
 */
export async function ensureClient(apiBase: string): Promise<string> {
  const existing = loadClient();
  if (existing?.client_id) return existing.client_id;

  const res = await fetch(`${apiBase}/api/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "quack",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DCR failed: HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
  }

  const body = (await res.json()) as { client_id: string };
  saveClient({ client_id: body.client_id });
  return body.client_id;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

/** Generate a random `code_verifier` (43+ chars, RFC 7636). */
export function generateVerifier(): string {
  // 32 random bytes → base64url (~43 chars)
  return crypto.randomBytes(32).toString("base64url");
}

/** Compute the S256 `code_challenge` for a given `code_verifier`. */
export async function computeChallenge(verifier: string): Promise<string> {
  const hash = crypto.createHash("sha256").update(verifier).digest();
  return hash.toString("base64url");
}

/** Generate a random `state` parameter. */
export function generateState(): string {
  return crypto.randomBytes(16).toString("hex");
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

/**
 * Refresh the access token using the stored refresh token.
 *
 * Updates `credentials.json` in place. Returns `true` on success.
 * If the server returns a new `refresh_token`, it replaces the old one
 * (rotation); otherwise the old refresh token is retained.
 */
export async function refreshToken(): Promise<boolean> {
  const creds = loadCredentials();
  if (!creds?.refresh_token) return false;

  const apiBase = getApiBase(creds);
  const client = loadClient();
  if (!client?.client_id) return false;

  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: creds.refresh_token,
    client_id: client.client_id,
  });

  const res = await fetch(`${apiBase}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  if (!res.ok) return false;

  const body = (await res.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token?: string;
  };

  const updated: Credentials = {
    ...creds,
    access_token: body.access_token,
    token_type: body.token_type,
    expires_at: Math.floor(Date.now() / 1000) + body.expires_in,
    refresh_token: body.refresh_token ?? creds.refresh_token,
  };
  saveCredentials(updated);
  return true;
}

/**
 * Return a valid access token, refreshing first if it's expired.
 *
 * Used by the proxy (on 401) and by any direct API call.
 */
export async function getValidAccessToken(): Promise<string | null> {
  const creds = loadCredentials();
  if (!creds) return null;

  // Refresh if expired (with a 60s safety margin).
  const now = Math.floor(Date.now() / 1000);
  if (creds.expires_at - 60 <= now) {
    const ok = await refreshToken();
    if (!ok) return null;
    return loadCredentials()?.access_token ?? null;
  }

  return creds.access_token;
}

// ---------------------------------------------------------------------------
// Browser open (cross-platform)
// ---------------------------------------------------------------------------

/** Open a URL in the user's default browser. Best-effort, never throws. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${cmd} "${url}"`, () => {
    // Ignore errors — the user can copy the URL manually.
  });
}

// ---------------------------------------------------------------------------
// `quack login` — full OAuth flow
// ---------------------------------------------------------------------------

/** Result of a successful login. */
export interface LoginResult {
  user_uid: string;
  role: string;
}

/**
 * Run the full OAuth Authorization Code + PKCE flow.
 *
 * 1. Ensure a DCR client exists.
 * 2. Generate PKCE verifier + challenge + state.
 * 3. Start a local callback server on port 8421.
 * 4. Open the browser to the authorize endpoint.
 * 5. Receive the authorization code at the callback.
 * 6. Exchange the code for tokens at the token endpoint.
 * 7. Persist credentials.
 */
export async function login(apiBaseOverride?: string): Promise<LoginResult> {
  // Determine API base (override > env > default).
  const storedCreds = loadCredentials();
  const apiBase =
    apiBaseOverride?.replace(/\/$/, "") ?? getApiBase(storedCreds);

  const clientId = await ensureClient(apiBase);

  const verifier = generateVerifier();
  const challenge = await computeChallenge(verifier);
  const state = generateState();

  // Start the local callback server. Returns a promise that resolves
  // when the OAuth redirect arrives — do NOT await before opening the
  // browser, or the browser will never open.
  const codePromise = waitForCallback(state);

  // Build the authorize URL and open it in the browser.
  const authorizeUrl = new URL(`${apiBase}/api/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("scope", "default");

  console.log(`Opening browser to:\n  ${authorizeUrl.toString()}`);
  openBrowser(authorizeUrl.toString());

  // Now wait for the callback to arrive.
  const { code } = await codePromise;

  // Exchange the authorization code for tokens.
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });

  const tokenRes = await fetch(`${apiBase}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => "");
    throw new Error(
      `Token exchange failed: HTTP ${tokenRes.status} ${tokenRes.statusText}${text ? ` — ${text}` : ""}`,
    );
  }

  const tokenBody = (await tokenRes.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token?: string;
    token_uid: string;
    role: string;
  };

  // Decode the user_uid from the JWT access token (sub claim) without verifying.
  // Falls back to `token_uid` if the JWT isn't decodable.
  const user_uid = decodeJwtSub(tokenBody.access_token) ?? tokenBody.token_uid;

  const creds: Credentials = {
    access_token: tokenBody.access_token,
    refresh_token: tokenBody.refresh_token ?? "",
    expires_at: Math.floor(Date.now() / 1000) + tokenBody.expires_in,
    token_type: tokenBody.token_type,
    user_uid,
    api_base: apiBase,
  };
  saveCredentials(creds);

  return { user_uid, role: tokenBody.role };
}

/**
 * Start a local callback server and resolve with the authorization `code`.
 *
 * Rejects if the `state` mismatched or if no callback arrives within 5 minutes.
 */
function waitForCallback(expectedState: string): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end(`<h1>Login failed</h1><p>${error}</p>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code || state !== expectedState) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end("<h1>Login failed</h1><p>Missing or mismatched state.</p>");
        server.close();
        reject(new Error("OAuth callback: missing code or state mismatch"));
        return;
      }

      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<h1>Logged in to quack</h1><p>You can close this tab and return to your terminal.</p>",
      );
      server.close();
      resolve({ code });
    });

    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      // Server is ready; the login() caller opens the browser next.
    });

    server.on("error", (err) => {
      reject(new Error(`Callback server failed: ${err.message}`));
    });

    // Timeout after 5 minutes.
    setTimeout(() => {
      server.close();
      reject(new Error("Login timed out after 5 minutes"));
    }, 5 * 60 * 1000);
  });
}

/** Decode the `sub` claim from a JWT without verifying the signature. */
function decodeJwtSub(jwt: string): string | null {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    const json = JSON.parse(payload) as { sub?: string };
    return json.sub ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// `quack logout`
// ---------------------------------------------------------------------------

/**
 * Revoke the access token and delete stored credentials.
 *
 * Gracefully handles already-revoked tokens (the revoke endpoint returns
 * success per RFC 7009 even for invalid tokens).
 */
export async function logout(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) {
    console.log("Not logged in.");
    return;
  }

  const apiBase = getApiBase(creds);
  try {
    await fetch(`${apiBase}/api/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: creds.access_token }),
    });
  } catch {
    // Best-effort — delete credentials regardless.
  }

  deleteCredentials();
}
