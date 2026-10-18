/**
 * Tests for auth.ts pure functions: PKCE, path resolution, config dir.
 *
 * @module
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  generateVerifier,
  computeChallenge,
  generateState,
  getConfigDir,
  credentialsPath,
  clientPath,
  getApiBase,
} from "../src/auth.js";
import type { Credentials } from "../src/types.js";
import { withTempConfigHome } from "./helpers.js";

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

test("generateVerifier: returns base64url string of 43+ chars", () => {
  const v = generateVerifier();
  assert.equal(typeof v, "string");
  assert.ok(v.length >= 43, `verifier too short: ${v.length}`);
  // base64url charset only
  assert.match(v, /^[A-Za-z0-9_-]+$/);
});

test("generateVerifier: produces different values", () => {
  const a = generateVerifier();
  const b = generateVerifier();
  assert.notEqual(a, b);
});

test("computeChallenge: deterministic for same verifier", async () => {
  const verifier = "test-verifier-1234567890123456789012345678";
  const a = await computeChallenge(verifier);
  const b = await computeChallenge(verifier);
  assert.equal(a, b);
});

test("computeChallenge: different verifiers produce different challenges", async () => {
  const a = await computeChallenge("verifier-a-123456789012345678901234567");
  const b = await computeChallenge("verifier-b-123456789012345678901234567");
  assert.notEqual(a, b);
});

test("computeChallenge: S256 produces base64url", async () => {
  const challenge = await computeChallenge("test-verifier-1234567890123456789012345678");
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
});

test("generateState: returns hex string", () => {
  const s = generateState();
  assert.match(s, /^[0-9a-f]+$/);
  assert.ok(s.length >= 32);
});

test("generateState: produces different values", () => {
  assert.notEqual(generateState(), generateState());
});

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

test("getConfigDir: uses XDG_CONFIG_HOME when set", () => {
  const { dir, cleanup } = withTempConfigHome();
  try {
    assert.equal(getConfigDir(), `${dir}/quack`);
  } finally {
    cleanup();
  }
});

test("getConfigDir: falls back to ~/.config/quack", () => {
  const { cleanup } = withTempConfigHome();
  // with XDG unset, should use homedir
  delete process.env.XDG_CONFIG_HOME;
  try {
    const expected = `${process.env.HOME}/.config/quack`;
    assert.equal(getConfigDir(), expected);
  } finally {
    cleanup();
  }
});

test("credentialsPath: ends with credentials.json", () => {
  const { cleanup } = withTempConfigHome();
  try {
    assert.ok(credentialsPath().endsWith("credentials.json"));
  } finally {
    cleanup();
  }
});

test("clientPath: ends with client.json", () => {
  const { cleanup } = withTempConfigHome();
  try {
    assert.ok(clientPath().endsWith("client.json"));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// getApiBase
// ---------------------------------------------------------------------------

test("getApiBase: env var takes precedence", () => {
  const prev = process.env.QUACK_API_BASE;
  process.env.QUACK_API_BASE = "https://custom.example.com";
  try {
    assert.equal(getApiBase(), "https://custom.example.com");
  } finally {
    if (prev === undefined) delete process.env.QUACK_API_BASE;
    else process.env.QUACK_API_BASE = prev;
  }
});

test("getApiBase: strips trailing slash", () => {
  const prev = process.env.QUACK_API_BASE;
  process.env.QUACK_API_BASE = "https://custom.example.com/";
  try {
    assert.equal(getApiBase(), "https://custom.example.com");
  } finally {
    if (prev === undefined) delete process.env.QUACK_API_BASE;
    else process.env.QUACK_API_BASE = prev;
  }
});

test("getApiBase: falls back to stored credentials api_base", () => {
  const prev = process.env.QUACK_API_BASE;
  delete process.env.QUACK_API_BASE;
  try {
    const creds: Credentials = {
      access_token: "x",
      refresh_token: "y",
      expires_at: 0,
      token_type: "Bearer",
      user_uid: "usr-x",
      api_base: "https://stored.example.com",
    };
    assert.equal(getApiBase(creds), "https://stored.example.com");
  } finally {
    if (prev === undefined) delete process.env.QUACK_API_BASE;
    else process.env.QUACK_API_BASE = prev;
  }
});

test("getApiBase: defaults to modelworks.ai", () => {
  const prev = process.env.QUACK_API_BASE;
  delete process.env.QUACK_API_BASE;
  try {
    assert.equal(getApiBase(null), "https://modelworks.ai");
  } finally {
    if (prev === undefined) delete process.env.QUACK_API_BASE;
    else process.env.QUACK_API_BASE = prev;
  }
});
