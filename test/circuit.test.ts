/**
 * Tests for circuit.ts pure functions: URL parsing, adapter type mapping,
 * SSE compatibility check.
 *
 * @module
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseCircuitRef,
  isSseCompatible,
  toApiAdapterType,
  fromApiAdapterType,
} from "../src/circuit.js";

// ---------------------------------------------------------------------------
// parseCircuitRef
// ---------------------------------------------------------------------------

test("parseCircuitRef: full circuit URL", () => {
  const ref = parseCircuitRef("https://modelworks.ai/circuits/c-abc123");
  assert.equal(ref.circuit_uid, "c-abc123");
  assert.equal(ref.version_uid, null);
});

test("parseCircuitRef: circuit URL with version", () => {
  const ref = parseCircuitRef(
    "https://modelworks.ai/circuits/c-abc123/versions/cv-def456",
  );
  assert.equal(ref.circuit_uid, "c-abc123");
  assert.equal(ref.version_uid, "cv-def456");
});

test("parseCircuitRef: bare circuit UID", () => {
  const ref = parseCircuitRef("c-abc123");
  assert.equal(ref.circuit_uid, "c-abc123");
  assert.equal(ref.version_uid, null);
});

test("parseCircuitRef: bare version UID", () => {
  const ref = parseCircuitRef("cv-def456");
  assert.equal(ref.circuit_uid, "");
  assert.equal(ref.version_uid, "cv-def456");
});

test("parseCircuitRef: URL with trailing slash", () => {
  const ref = parseCircuitRef("https://modelworks.ai/circuits/c-abc123/");
  assert.equal(ref.circuit_uid, "c-abc123");
  assert.equal(ref.version_uid, null);
});

test("parseCircuitRef: URL with query params", () => {
  const ref = parseCircuitRef(
    "https://modelworks.ai/circuits/c-abc123?tab=overview",
  );
  assert.equal(ref.circuit_uid, "c-abc123");
});

test("parseCircuitRef: rejects invalid input", () => {
  assert.throws(() => parseCircuitRef("not-a-url-or-uid"), /Invalid circuit reference/);
});

// ---------------------------------------------------------------------------
// isSseCompatible
// ---------------------------------------------------------------------------

test("isSseCompatible: true when OPEN_AI_SSE present", () => {
  assert.equal(isSseCompatible(["OPEN_AI_SSE", "MCP"]), true);
});

test("isSseCompatible: false when OPEN_AI_SSE absent", () => {
  assert.equal(isSseCompatible(["MCP", "MODELWORKS_HTTP"]), false);
});

test("isSseCompatible: false for empty array", () => {
  assert.equal(isSseCompatible([]), false);
});

// ---------------------------------------------------------------------------
// Adapter type mapping
// ---------------------------------------------------------------------------

test("toApiAdapterType: OPEN_AI_SSE → OpenAiSse", () => {
  assert.equal(toApiAdapterType("OPEN_AI_SSE"), "OpenAiSse");
});

test("toApiAdapterType: MCP → MCP", () => {
  assert.equal(toApiAdapterType("MCP"), "MCP");
});

test("toApiAdapterType: MODELWORKS_HTTP → ModelworksHTTP", () => {
  assert.equal(toApiAdapterType("MODELWORKS_HTTP"), "ModelworksHTTP");
});

test("toApiAdapterType: unknown type passes through", () => {
  assert.equal(toApiAdapterType("UNKNOWN_TYPE"), "UNKNOWN_TYPE");
});

test("fromApiAdapterType: OpenAiSse → OPEN_AI_SSE", () => {
  assert.equal(fromApiAdapterType("OpenAiSse"), "OPEN_AI_SSE");
});

test("fromApiAdapterType: round-trip", () => {
  const types = ["OPEN_AI_SSE", "MCP", "MODELWORKS_HTTP", "XMCP"];
  for (const t of types) {
    assert.equal(fromApiAdapterType(toApiAdapterType(t)), t);
  }
});
