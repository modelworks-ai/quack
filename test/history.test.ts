import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  saveRunRecord,
  listRunRecords,
  getRunRecord,
  fetchRunFromApi,
  runsDir,
  runFilePath,
} from "../src/history.js";
import type { RunRecord, Credentials, CircuitStateEntry } from "../src/types.js";
import { initProject } from "../src/project.js";
import { withTempDir } from "./helpers.js";

function makeRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    run_uid: "cr-test123",
    circuit_uid: "c-test",
    circuit_name: "test-circuit",
    owner_username: "alice",
    caller_username: "alice",
    version_uid: "cv-test",
    status: "COMPLETED",
    created_at: "2026-10-21T06:08:11Z",
    completed_at: "2026-10-21T06:08:14Z",
    duration_ms: 3100,
    cost_credits: 0.05,
    input_tokens: 42,
    output_tokens: 128,
    ...overrides,
  };
}

const testCreds: Credentials = {
  access_token: "mw_test",
  refresh_token: "mw_refresh",
  expires_at: 9999999999,
  token_type: "Bearer",
  user_uid: "usr-test",
  api_base: "http://localhost:8080",
};

const testStateCircuits: Record<string, CircuitStateEntry> = {
  "c-test": {
    circuit_uid: "c-test",
    version_uid: "cv-test",
    circuit_name: "test-circuit",
    owner_username: "alice",
    adapters: ["OPEN_AI_SSE"],
    sse_adaptor_uid: "ca-sse",
    adaptor_uids: { OPEN_AI_SSE: "ca-sse" },
    resolved_at: "2026-10-21T00:00:00Z",
  },
};

// ---------------------------------------------------------------------------
// saveRunRecord / getRunRecord / listRunRecords
// ---------------------------------------------------------------------------

test("saveRunRecord: writes a JSON file to .quack/runs/", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    const record = makeRunRecord();
    saveRunRecord(record);
    const file = runFilePath("cr-test123");
    assert.ok(fs.existsSync(file));
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(saved.run_uid, "cr-test123");
    assert.equal(saved.circuit_name, "test-circuit");
    assert.equal(saved.cost_credits, 0.05);
  } finally {
    cleanup();
  }
});

test("getRunRecord: returns the record if it exists", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    const record = makeRunRecord();
    saveRunRecord(record);
    const fetched = getRunRecord("cr-test123");
    assert.deepEqual(fetched, record);
  } finally {
    cleanup();
  }
});

test("getRunRecord: returns null if not found", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    assert.equal(getRunRecord("cr-nonexistent"), null);
  } finally {
    cleanup();
  }
});

test("listRunRecords: returns all records sorted by created_at desc", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    saveRunRecord(makeRunRecord({ run_uid: "cr-1", created_at: "2026-10-20T00:00:00Z" }));
    saveRunRecord(makeRunRecord({ run_uid: "cr-2", created_at: "2026-10-21T00:00:00Z" }));
    saveRunRecord(makeRunRecord({ run_uid: "cr-3", created_at: "2026-10-19T00:00:00Z" }));

    const records = listRunRecords();
    assert.equal(records.length, 3);
    // Sorted by created_at descending.
    assert.equal(records[0].run_uid, "cr-2");
    assert.equal(records[1].run_uid, "cr-1");
    assert.equal(records[2].run_uid, "cr-3");
  } finally {
    cleanup();
  }
});

test("listRunRecords: returns empty array if runs/ doesn't exist", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    // Remove the runs/ directory.
    fs.rmSync(runsDir(), { recursive: true });
    assert.deepEqual(listRunRecords(), []);
  } finally {
    cleanup();
  }
});

test("saveRunRecord: creates runs/ directory if missing", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    fs.rmSync(runsDir(), { recursive: true });
    assert.ok(!fs.existsSync(runsDir()));
    saveRunRecord(makeRunRecord());
    assert.ok(fs.existsSync(runsDir()));
    assert.ok(fs.existsSync(runFilePath("cr-test123")));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// fetchRunFromApi
// ---------------------------------------------------------------------------

test("fetchRunFromApi: fetches and maps a completed run", async () => {
  const { cleanup } = withTempDir();
  try {
    initProject();

    const mockRun = {
      uid: "cr-abc",
      circuit_uid: "c-test",
      circuit_version_uid: "cv-test",
      user_uid: "usr-test",
      state: "COMPLETED",
      created_at: "2026-10-21T06:08:11Z",
      ended_at: "2026-10-21T06:08:14Z",
      result_blob: {
        billing_entries: [
          {
            cost: 0.05,
            total_input_tokens: 42,
            total_output_tokens: 128,
          },
        ],
        performance_reports: {
          chat_completion_response: {
            time_taken: 3100,
          },
        },
      },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      assert.equal(new URL(url).pathname, "/api/circuit-runs/cr-abc");
      return new Response(JSON.stringify({ payload: mockRun }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const record = await fetchRunFromApi(
        "cr-abc",
        testCreds,
        testStateCircuits,
        "alice",
      );
      assert.ok(record);
      assert.equal(record.run_uid, "cr-abc");
      assert.equal(record.circuit_name, "test-circuit");
      assert.equal(record.owner_username, "alice");
      assert.equal(record.caller_username, "alice");
      assert.equal(record.status, "COMPLETED");
      assert.equal(record.cost_credits, 0.05);
      assert.equal(record.input_tokens, 42);
      assert.equal(record.output_tokens, 128);
      assert.equal(record.duration_ms, 3100);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    cleanup();
  }
});

test("fetchRunFromApi: retries when run is not terminal", async () => {
  const { cleanup } = withTempDir();
  try {
    initProject();

    let callCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      callCount++;
      const state = callCount < 3 ? "PROVISIONED" : "COMPLETED";
      return new Response(
        JSON.stringify({
          payload: {
            uid: "cr-abc",
            circuit_uid: "c-test",
            circuit_version_uid: "cv-test",
            state,
            created_at: "2026-10-21T06:08:11Z",
            ended_at: "2026-10-21T06:08:14Z",
            result_blob: null,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const record = await fetchRunFromApi(
        "cr-abc",
        testCreds,
        testStateCircuits,
        "alice",
      );
      assert.ok(record);
      assert.equal(record.status, "COMPLETED");
      assert.ok(callCount >= 3, "should have retried at least 3 times");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    cleanup();
  }
});

test("fetchRunFromApi: returns null on API error", async () => {
  const { cleanup } = withTempDir();
  try {
    initProject();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;

    try {
      const record = await fetchRunFromApi(
        "cr-abc",
        testCreds,
        testStateCircuits,
        "alice",
      );
      assert.equal(record, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    cleanup();
  }
});
