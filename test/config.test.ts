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
} from "../src/agents/opencode.js";
import type { QuackState } from "../src/types.js";

const PORT = 54321;
const PROXY_BASE = `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// buildOpenCodeConfig
// ---------------------------------------------------------------------------

test("buildOpenCodeConfig: includes the global modelworks MCP server", () => {
  const state: QuackState = { circuits: {} };
  const config = buildOpenCodeConfig(state, PORT);
  assert.ok(config.mcp?.servers?.["ModelWorks x.MCP"], "ModelWorks x.MCP server missing");
  assert.equal(config.mcp!.servers!["ModelWorks x.MCP"].type, "remote");
  assert.equal(config.mcp!.servers!["ModelWorks x.MCP"].url, `${PROXY_BASE}/api/x.mcp`);
  assert.equal(config.mcp!.servers!["ModelWorks x.MCP"].oauth, false);
  assert.equal(config.mcp!.servers!["ModelWorks x.MCP"].protocol, "2026-07-28");
  // Dummy auth header — the proxy overrides it with the real token.
  assert.equal(
    config.mcp!.servers!["ModelWorks x.MCP"].headers?.Authorization,
    "Bearer quack",
    "MCP server must have a dummy Authorization header to avoid OpenCode's auth prompt",
  );
});

test("buildOpenCodeConfig: injects SSE-compatible circuit as provider", () => {
  const state: QuackState = {
    circuits: {
      "c-abc": {
        circuit_uid: "c-abc",
        version_uid: "cv-abc",
        circuit_name: "Test Circuit",
        owner_username: "alice",
        adapters: ["OPEN_AI_SSE"],
        sse_adaptor_uid: "ca-xxx",
        adaptor_uids: { OPEN_AI_SSE: "ca-xxx" },
        resolved_at: "2026-01-01T00:00:00Z",
      },
    },
  };
  const config = buildOpenCodeConfig(state, PORT);
  const provider = config.providers?.["circuit-c-abc"];
  assert.ok(provider, "provider missing");
  assert.equal(provider!.name, "ModelWorks");
  assert.equal(provider!.package, "@opencode/ai/providers/openai-compatible");
  assert.equal(
    provider!.settings.baseURL,
    `${PROXY_BASE}/api/circuit-adaptors/ca-xxx/query`,
  );
  assert.equal(provider!.settings.apiKey, "quack");
  assert.ok(provider!.models?.["c-abc"], "model entry missing");
  assert.equal(provider!.models!["c-abc"].name, "alice/Test Circuit");
});

test("buildOpenCodeConfig: skips non-SSE circuits", () => {
  const state: QuackState = {
    circuits: {
      "c-abc": {
        circuit_uid: "c-abc",
        version_uid: "cv-abc",
        circuit_name: "Non-SSE Circuit",
        owner_username: "alice",
        adapters: ["MCP"],
        sse_adaptor_uid: null,
        adaptor_uids: {},
        resolved_at: "2026-01-01T00:00:00Z",
      },
    },
  };
  const config = buildOpenCodeConfig(state, PORT);
  assert.equal(config.providers?.["circuit-c-abc"], undefined);
});

test("buildOpenCodeConfig: skips SSE circuit with null adaptor UID", () => {
  const state: QuackState = {
    circuits: {
      "c-abc": {
        circuit_uid: "c-abc",
        version_uid: "cv-abc",
        circuit_name: "SSE But No Adaptor",
        owner_username: "alice",
        adapters: ["OPEN_AI_SSE"],
        sse_adaptor_uid: null,
        adaptor_uids: {},
        resolved_at: "2026-01-01T00:00:00Z",
      },
    },
  };
  const config = buildOpenCodeConfig(state, PORT);
  assert.equal(config.providers?.["circuit-c-abc"], undefined);
});

test("buildOpenCodeConfig: injects multiple SSE circuits", () => {
  const state: QuackState = {
    circuits: {
      "c-aaa": {
        circuit_uid: "c-aaa",
        version_uid: "cv-aaa",
        circuit_name: "Circuit A",
        owner_username: "alice",
        adapters: ["OPEN_AI_SSE"],
        sse_adaptor_uid: "ca-aaa",
        adaptor_uids: { OPEN_AI_SSE: "ca-aaa" },
        resolved_at: "2026-01-01T00:00:00Z",
      },
      "c-bbb": {
        circuit_uid: "c-bbb",
        version_uid: "cv-bbb",
        circuit_name: "Circuit B",
        owner_username: "alice",
        adapters: ["OPEN_AI_SSE", "MCP"],
        sse_adaptor_uid: "ca-bbb",
        adaptor_uids: { OPEN_AI_SSE: "ca-bbb" },
        resolved_at: "2026-01-01T00:00:00Z",
      },
    },
  };
  const config = buildOpenCodeConfig(state, PORT);
  assert.ok(config.providers?.["circuit-c-aaa"]);
  assert.ok(config.providers?.["circuit-c-bbb"]);
});

test("buildOpenCodeConfig: empty state has MCP server but no providers", () => {
  const state: QuackState = { circuits: {} };
  const config = buildOpenCodeConfig(state, PORT);
  assert.ok(config.mcp?.servers?.["ModelWorks x.MCP"]);
  assert.deepEqual(config.providers, {});
});

test("buildOpenCodeConfig: no secrets in the output", () => {
  const state: QuackState = {
    circuits: {
      "c-abc": {
        circuit_uid: "c-abc",
        version_uid: "cv-abc",
        circuit_name: "Test",
        owner_username: "alice",
        adapters: ["OPEN_AI_SSE"],
        sse_adaptor_uid: "ca-xxx",
        adaptor_uids: { OPEN_AI_SSE: "ca-xxx" },
        resolved_at: "2026-01-01T00:00:00Z",
      },
    },
  };
  const json = JSON.stringify(buildOpenCodeConfig(state, PORT));
  // No real access tokens — only the dummy "Bearer quack" is allowed.
  assert.ok(
    !json.includes("mw_"),
    "found mw_ token in config",
  );
  // The only Bearer string allowed is the dummy "Bearer quack".
  const bearerMatches = json.match(/Bearer [^"]+/g) ?? [];
  for (const m of bearerMatches) {
    assert.equal(
      m,
      "Bearer quack",
      `unexpected Bearer value in config: ${m}`,
    );
  }
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
        owner_username: "alice",
        adapters: ["OPEN_AI_SSE"],
        sse_adaptor_uid: "ca-sse",
        adaptor_uids: { OPEN_AI_SSE: "ca-sse" },
        resolved_at: "2026-01-01T00:00:00Z",
      },
      "c-nosse": {
        circuit_uid: "c-nosse",
        version_uid: "cv-nosse",
        circuit_name: "No SSE Circuit",
        owner_username: "alice",
        adapters: ["MCP"],
        sse_adaptor_uid: null,
        adaptor_uids: {},
        resolved_at: "2026-01-01T00:00:00Z",
      },
      "c-sse-nouid": {
        circuit_uid: "c-sse-nouid",
        version_uid: "cv-sse-nouid",
        circuit_name: "SSE No Adaptor",
        owner_username: "alice",
        adapters: ["OPEN_AI_SSE"],
        sse_adaptor_uid: null,
        adaptor_uids: {},
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
