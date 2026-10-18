/**
 * Tests for config.ts: buildOpenCodeConfig, isInjectableSseCircuit,
 * summarizeInjection.
 *
 * @module
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildOpenCodeConfig,
  summarizeInjection,
} from "../src/config.js";
import type { QuackState } from "../src/types.js";

const PORT = 54321;
const PROXY_BASE = `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// buildOpenCodeConfig
// ---------------------------------------------------------------------------

test("buildOpenCodeConfig: includes the global modelworks MCP server", () => {
  const state: QuackState = { circuits: {} };
  const config = buildOpenCodeConfig(state, PORT);
  assert.ok(config.mcp?.servers?.modelworks, "modelworks MCP server missing");
  assert.equal(config.mcp!.servers!.modelworks.type, "remote");
  assert.equal(config.mcp!.servers!.modelworks.url, `${PROXY_BASE}/api/x.mcp`);
  assert.equal(config.mcp!.servers!.modelworks.oauth, false);
  assert.equal(config.mcp!.servers!.modelworks.protocol, "auto");
});

test("buildOpenCodeConfig: injects SSE-compatible circuit as provider", () => {
  const state: QuackState = {
    circuits: {
      "c-abc": {
        circuit_uid: "c-abc",
        version_uid: "cv-abc",
        circuit_name: "Test Circuit",
        adapters: ["OPEN_AI_SSE"],
        sse_adaptor_uid: "ca-xxx",
        resolved_at: "2026-01-01T00:00:00Z",
      },
    },
  };
  const config = buildOpenCodeConfig(state, PORT);
  const provider = config.provider?.["circuit-c-abc"];
  assert.ok(provider, "provider missing");
  assert.equal(provider!.name, "Test Circuit");
  assert.equal(provider!.npm, "@ai-sdk/openai-compatible");
  assert.equal(
    provider!.options.baseURL,
    `${PROXY_BASE}/api/circuit-adaptors/ca-xxx/query`,
  );
  assert.equal(provider!.options.apiKey, "quack");
  assert.ok(provider!.models?.["c-abc"], "model entry missing");
  assert.equal(provider!.models!["c-abc"].name, "Test Circuit");
});

test("buildOpenCodeConfig: skips non-SSE circuits", () => {
  const state: QuackState = {
    circuits: {
      "c-abc": {
        circuit_uid: "c-abc",
        version_uid: "cv-abc",
        circuit_name: "Non-SSE Circuit",
        adapters: ["MCP"],
        sse_adaptor_uid: null,
        resolved_at: "2026-01-01T00:00:00Z",
      },
    },
  };
  const config = buildOpenCodeConfig(state, PORT);
  assert.equal(config.provider?.["circuit-c-abc"], undefined);
});

test("buildOpenCodeConfig: skips SSE circuit with null adaptor UID", () => {
  const state: QuackState = {
    circuits: {
      "c-abc": {
        circuit_uid: "c-abc",
        version_uid: "cv-abc",
        circuit_name: "SSE But No Adaptor",
        adapters: ["OPEN_AI_SSE"],
        sse_adaptor_uid: null,
        resolved_at: "2026-01-01T00:00:00Z",
      },
    },
  };
  const config = buildOpenCodeConfig(state, PORT);
  assert.equal(config.provider?.["circuit-c-abc"], undefined);
});

test("buildOpenCodeConfig: injects multiple SSE circuits", () => {
  const state: QuackState = {
    circuits: {
      "c-aaa": {
        circuit_uid: "c-aaa",
        version_uid: "cv-aaa",
        circuit_name: "Circuit A",
        adapters: ["OPEN_AI_SSE"],
        sse_adaptor_uid: "ca-aaa",
        resolved_at: "2026-01-01T00:00:00Z",
      },
      "c-bbb": {
        circuit_uid: "c-bbb",
        version_uid: "cv-bbb",
        circuit_name: "Circuit B",
        adapters: ["OPEN_AI_SSE", "MCP"],
        sse_adaptor_uid: "ca-bbb",
        resolved_at: "2026-01-01T00:00:00Z",
      },
    },
  };
  const config = buildOpenCodeConfig(state, PORT);
  assert.ok(config.provider?.["circuit-c-aaa"]);
  assert.ok(config.provider?.["circuit-c-bbb"]);
});

test("buildOpenCodeConfig: empty state has MCP server but no providers", () => {
  const state: QuackState = { circuits: {} };
  const config = buildOpenCodeConfig(state, PORT);
  assert.ok(config.mcp?.servers?.modelworks);
  assert.deepEqual(config.provider, {});
});

test("buildOpenCodeConfig: no secrets in the output", () => {
  const state: QuackState = {
    circuits: {
      "c-abc": {
        circuit_uid: "c-abc",
        version_uid: "cv-abc",
        circuit_name: "Test",
        adapters: ["OPEN_AI_SSE"],
        sse_adaptor_uid: "ca-xxx",
        resolved_at: "2026-01-01T00:00:00Z",
      },
    },
  };
  const json = JSON.stringify(buildOpenCodeConfig(state, PORT));
  // No access tokens or Bearer strings
  assert.ok(!json.includes("Bearer"), "found Bearer in config");
  assert.ok(!json.includes("mw_"), "found mw_ token in config");
});

// ---------------------------------------------------------------------------
// summarizeInjection
// ---------------------------------------------------------------------------

test("summarizeInjection: injected vs skipped", () => {
  const state: QuackState = {
    circuits: {
      "c-sse": {
        circuit_uid: "c-sse",
        version_uid: "cv-sse",
        circuit_name: "SSE Circuit",
        adapters: ["OPEN_AI_SSE"],
        sse_adaptor_uid: "ca-sse",
        resolved_at: "2026-01-01T00:00:00Z",
      },
      "c-nosse": {
        circuit_uid: "c-nosse",
        version_uid: "cv-nosse",
        circuit_name: "No SSE Circuit",
        adapters: ["MCP"],
        sse_adaptor_uid: null,
        resolved_at: "2026-01-01T00:00:00Z",
      },
      "c-sse-nouid": {
        circuit_uid: "c-sse-nouid",
        version_uid: "cv-sse-nouid",
        circuit_name: "SSE No Adaptor",
        adapters: ["OPEN_AI_SSE"],
        sse_adaptor_uid: null,
        resolved_at: "2026-01-01T00:00:00Z",
      },
    },
  };
  const summary = summarizeInjection(state);
  assert.equal(summary.injected.length, 1);
  assert.equal(summary.injected[0].circuit_uid, "c-sse");
  assert.equal(summary.skipped.length, 2);
  const reasons = summary.skipped.map((s) => s.reason).sort();
  assert.deepEqual(reasons, ["no SSE adaptor", "not SSE-compatible"]);
});
