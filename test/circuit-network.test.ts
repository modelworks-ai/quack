/**
 * Tests for circuit.ts network functions: addCircuit, removeCircuit,
 * resolveRunningVersion, discoverAdapters, ensureSseAdaptor.
 *
 * Uses mock fetch + temp project dir + temp config home (for credentials).
 *
 * @module
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { addCircuit, removeCircuit, ensureState } from "../src/circuit.js";
import type { Credentials } from "../src/types.js";
import { withTempDir, withTempConfigHome, mockFetch } from "./helpers.js";

/** Set up credentials in the temp config home so authedFetch can read them. */
function writeCredentials(apiBase: string): void {
  const creds: Credentials = {
    access_token: "test-token",
    refresh_token: "test-refresh",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "Bearer",
    user_uid: "usr-test",
    api_base: apiBase,
  };
  const configDir = path.join(process.env.XDG_CONFIG_HOME!, "quack");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "credentials.json"), JSON.stringify(creds));
}

/** Common API responses for a circuit with SSE support. */
const SSE_CIRCUIT_RESPONSES = {
  "GET /api/circuits/c-test": {
    json: {
      status: "success",
      payload: { uid: "c-test", name: "Test Circuit", user_uid: "usr-test" },
    },
  },
  "GET /api/circuits/c-test/primary": {
    json: {
      status: "success",
      payload: {
        uid: "cv-test",
        circuit_uid: "c-test",
        state: "RUNNING",
        json_blob: null, // stripped by to_public()
      },
    },
  },
};

/** Adaptor list (empty — first add). */
const EMPTY_ADAPTORS = {
  "GET /api/circuit-adaptors/by-circuit-version/cv-test": {
    json: { status: "success", payload: [] },
  },
};

/** Adaptor creation response. */
const CREATE_ADAPTOR = {
  "POST /api/circuit-adaptors": {
    json: {
      status: "success",
      payload: { uid: "ca-new", adapter_type: "OPEN_AI_SSE" },
    },
  },
};

const API_BASE = "http://localhost:8080";

// ---------------------------------------------------------------------------
// addCircuit
// ---------------------------------------------------------------------------

test("addCircuit: creates SSE adaptor when adapters undetermined", async () => {
  const { cleanup: cleanupDir } = withTempDir();
  const { cleanup: cleanupConfig } = withTempConfigHome();
  try {
    fs.mkdirSync(".quack", { recursive: true });
    fs.writeFileSync(".quack/config.json", JSON.stringify({ version: 1, circuits: [] }));
    fs.writeFileSync(".quack/state.json", JSON.stringify({ circuits: {} }));
    writeCredentials(API_BASE);

    const { cleanup: cleanupFetch } = mockFetch({
      ...SSE_CIRCUIT_RESPONSES,
      ...EMPTY_ADAPTORS,
      ...CREATE_ADAPTOR,
    });

    try {
      const result = await addCircuit("https://modelworks.ai/circuits/c-test", API_BASE);
      assert.equal(result.circuit_uid, "c-test");
      assert.equal(result.version_uid, "cv-test");
      assert.equal(result.name, "Test Circuit");
      assert.equal(result.sse_adaptor_uid, "ca-new");
      assert.equal(result.sse_compatible, true);
      assert.equal(result.added, true);
      assert.ok(result.adapters.includes("OPEN_AI_SSE"));
    } finally {
      cleanupFetch();
    }
  } finally {
    cleanupConfig();
    cleanupDir();
  }
});

test("addCircuit: reuses existing SSE adaptor", async () => {
  const { cleanup: cleanupDir } = withTempDir();
  const { cleanup: cleanupConfig } = withTempConfigHome();
  try {
    fs.mkdirSync(".quack", { recursive: true });
    fs.writeFileSync(".quack/config.json", JSON.stringify({ version: 1, circuits: [] }));
    fs.writeFileSync(".quack/state.json", JSON.stringify({ circuits: {} }));
    writeCredentials(API_BASE);

    const { cleanup: cleanupFetch } = mockFetch({
      ...SSE_CIRCUIT_RESPONSES,
      "GET /api/circuit-adaptors/by-circuit-version/cv-test": {
        json: {
          status: "success",
          payload: [
            { uid: "ca-existing", adapter_type: "OpenAiSse" },
          ],
        },
      },
    });

    try {
      const result = await addCircuit("https://modelworks.ai/circuits/c-test", API_BASE);
      assert.equal(result.sse_adaptor_uid, "ca-existing");
      assert.equal(result.sse_compatible, true);
    } finally {
      cleanupFetch();
    }
  } finally {
    cleanupConfig();
    cleanupDir();
  }
});

test("addCircuit: reports already-added when in config", async () => {
  const { cleanup: cleanupDir } = withTempDir();
  const { cleanup: cleanupConfig } = withTempConfigHome();
  try {
    fs.mkdirSync(".quack", { recursive: true });
    fs.writeFileSync(
      ".quack/config.json",
      JSON.stringify({
        version: 1,
        circuits: [
          {
            url: "https://modelworks.ai/circuits/c-test",
            circuit_uid: "c-test",
            name: "Test Circuit",
            added_at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    fs.writeFileSync(".quack/state.json", JSON.stringify({ circuits: {} }));
    writeCredentials(API_BASE);

    const { cleanup: cleanupFetch } = mockFetch({
      ...SSE_CIRCUIT_RESPONSES,
      ...EMPTY_ADAPTORS,
      ...CREATE_ADAPTOR,
    });

    try {
      const result = await addCircuit("https://modelworks.ai/circuits/c-test", API_BASE);
      assert.equal(result.added, false);
    } finally {
      cleanupFetch();
    }
  } finally {
    cleanupConfig();
    cleanupDir();
  }
});

// ---------------------------------------------------------------------------
// removeCircuit
// ---------------------------------------------------------------------------

test("removeCircuit: deletes adaptor and removes from config/state", async () => {
  const { cleanup: cleanupDir } = withTempDir();
  const { cleanup: cleanupConfig } = withTempConfigHome();
  try {
    fs.mkdirSync(".quack", { recursive: true });
    fs.writeFileSync(
      ".quack/config.json",
      JSON.stringify({
        version: 1,
        circuits: [
          {
            url: "https://modelworks.ai/circuits/c-test",
            circuit_uid: "c-test",
            name: "Test Circuit",
            added_at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    fs.writeFileSync(
      ".quack/state.json",
      JSON.stringify({
        circuits: {
          "c-test": {
            circuit_uid: "c-test",
            version_uid: "cv-test",
            circuit_name: "Test Circuit",
            adapters: ["OPEN_AI_SSE"],
            sse_adaptor_uid: "ca-test",
            resolved_at: "2026-01-01T00:00:00Z",
          },
        },
      }),
    );
    writeCredentials(API_BASE);

    const { cleanup: cleanupFetch, calls } = mockFetch({
      "DELETE /api/circuit-adaptors/ca-test": { status: 200, body: "" },
    });

    try {
      const result = await removeCircuit("c-test", API_BASE);
      assert.equal(result.circuit_uid, "c-test");
      assert.equal(result.name, "Test Circuit");
      // Verify DELETE was called
      const deleteCall = calls.find((c) => c.method === "DELETE");
      assert.ok(deleteCall, "DELETE should have been called");
      // Verify config + state cleaned up
      const config = JSON.parse(fs.readFileSync(".quack/config.json", "utf8"));
      assert.equal(config.circuits.length, 0);
      const state = JSON.parse(fs.readFileSync(".quack/state.json", "utf8"));
      assert.ok(!("c-test" in state.circuits));
    } finally {
      cleanupFetch();
    }
  } finally {
    cleanupConfig();
    cleanupDir();
  }
});

test("removeCircuit: --keep-adaptors skips server-side deletion", async () => {
  const { cleanup: cleanupDir } = withTempDir();
  const { cleanup: cleanupConfig } = withTempConfigHome();
  try {
    fs.mkdirSync(".quack", { recursive: true });
    fs.writeFileSync(
      ".quack/config.json",
      JSON.stringify({
        version: 1,
        circuits: [
          {
            url: "https://modelworks.ai/circuits/c-test",
            circuit_uid: "c-test",
            name: "Test Circuit",
            added_at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    fs.writeFileSync(
      ".quack/state.json",
      JSON.stringify({
        circuits: {
          "c-test": {
            circuit_uid: "c-test",
            version_uid: "cv-test",
            circuit_name: "Test Circuit",
            adapters: ["OPEN_AI_SSE"],
            sse_adaptor_uid: "ca-test",
            resolved_at: "2026-01-01T00:00:00Z",
          },
        },
      }),
    );
    writeCredentials(API_BASE);

    // No DELETE route registered — would throw if called
    const { cleanup: cleanupFetch, calls } = mockFetch({});

    try {
      const result = await removeCircuit("c-test", API_BASE, true);
      assert.equal(result.circuit_uid, "c-test");
      assert.equal(calls.length, 0, "no API calls should have been made");
    } finally {
      cleanupFetch();
    }
  } finally {
    cleanupConfig();
    cleanupDir();
  }
});

test("removeCircuit: throws if circuit not in config", async () => {
  const { cleanup: cleanupDir } = withTempDir();
  const { cleanup: cleanupConfig } = withTempConfigHome();
  try {
    fs.mkdirSync(".quack", { recursive: true });
    fs.writeFileSync(".quack/config.json", JSON.stringify({ version: 1, circuits: [] }));
    fs.writeFileSync(".quack/state.json", JSON.stringify({ circuits: {} }));
    writeCredentials(API_BASE);

    await assert.rejects(
      removeCircuit("c-nonexistent", API_BASE),
      /not in this project/,
    );
  } finally {
    cleanupConfig();
    cleanupDir();
  }
});

// ---------------------------------------------------------------------------
// ensureState (auto-sync)
// ---------------------------------------------------------------------------

test("ensureState: syncs circuits missing from state", async () => {
  const { cleanup: cleanupDir } = withTempDir();
  const { cleanup: cleanupConfig } = withTempConfigHome();
  try {
    fs.mkdirSync(".quack", { recursive: true });
    fs.writeFileSync(
      ".quack/config.json",
      JSON.stringify({
        version: 1,
        circuits: [
          {
            url: "https://modelworks.ai/circuits/c-test",
            circuit_uid: "c-test",
            name: "Test Circuit",
            added_at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    // NO state.json — simulates cloned repo
    writeCredentials(API_BASE);

    const { cleanup: cleanupFetch } = mockFetch({
      ...SSE_CIRCUIT_RESPONSES,
      ...EMPTY_ADAPTORS,
      ...CREATE_ADAPTOR,
    });

    try {
      await ensureState(API_BASE);
      // State should now be created with the circuit
      const state = JSON.parse(fs.readFileSync(".quack/state.json", "utf8"));
      assert.ok("c-test" in state.circuits);
      assert.equal(state.circuits["c-test"].sse_adaptor_uid, "ca-new");
    } finally {
      cleanupFetch();
    }
  } finally {
    cleanupConfig();
    cleanupDir();
  }
});

test("ensureState: no-op when state is already synced", async () => {
  const { cleanup: cleanupDir } = withTempDir();
  const { cleanup: cleanupConfig } = withTempConfigHome();
  try {
    fs.mkdirSync(".quack", { recursive: true });
    fs.writeFileSync(
      ".quack/config.json",
      JSON.stringify({
        version: 1,
        circuits: [
          {
            url: "https://modelworks.ai/circuits/c-test",
            circuit_uid: "c-test",
            name: "Test Circuit",
            added_at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    fs.writeFileSync(
      ".quack/state.json",
      JSON.stringify({
        circuits: {
          "c-test": {
            circuit_uid: "c-test",
            version_uid: "cv-test",
            circuit_name: "Test Circuit",
            adapters: ["OPEN_AI_SSE"],
            sse_adaptor_uid: "ca-existing",
            resolved_at: "2026-01-01T00:00:00Z",
          },
        },
      }),
    );
    writeCredentials(API_BASE);

    // No routes — would throw if any fetch was made
    const { cleanup: cleanupFetch, calls } = mockFetch({});

    try {
      await ensureState(API_BASE);
      assert.equal(calls.length, 0, "no API calls should have been made");
    } finally {
      cleanupFetch();
    }
  } finally {
    cleanupConfig();
    cleanupDir();
  }
});

test("ensureState: skips circuits that return 403 (no access)", async () => {
  const { cleanup: cleanupDir } = withTempDir();
  const { cleanup: cleanupConfig } = withTempConfigHome();
  try {
    fs.mkdirSync(".quack", { recursive: true });
    fs.writeFileSync(
      ".quack/config.json",
      JSON.stringify({
        version: 1,
        circuits: [
          {
            url: "https://modelworks.ai/circuits/c-private",
            circuit_uid: "c-private",
            name: "Private Circuit",
            added_at: "2026-01-01T00:00:00Z",
          },
          {
            url: "https://modelworks.ai/circuits/c-public",
            circuit_uid: "c-public",
            name: "Public Circuit",
            added_at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    // NO state.json — simulates cloned repo
    writeCredentials(API_BASE);

    const { cleanup: cleanupFetch } = mockFetch({
      // Private circuit → 403
      "GET /api/circuits/c-private": {
        status: 403,
        body: JSON.stringify({ status: "error", status_code: 403 }),
      },
      // Public circuit resolves normally
      "GET /api/circuits/c-public": {
        json: {
          status: "success",
          payload: { uid: "c-public", name: "Public Circuit", user_uid: "usr-other" },
        },
      },
      "GET /api/circuits/c-public/primary": {
        json: {
          status: "success",
          payload: {
            uid: "cv-public",
            circuit_uid: "c-public",
            state: "RUNNING",
            json_blob: null,
          },
        },
      },
      "GET /api/circuit-adaptors/by-circuit-version/cv-public": {
        json: { status: "success", payload: [] },
      },
      "POST /api/circuit-adaptors": {
        json: {
          status: "success",
          payload: { uid: "ca-public", adapter_type: "OPEN_AI_SSE" },
        },
      },
    });

    try {
      await ensureState(API_BASE);
      // The private circuit should have been skipped (not in state),
      // the public one should be synced.
      const state = JSON.parse(fs.readFileSync(".quack/state.json", "utf8"));
      assert.ok(!("c-private" in state.circuits), "private circuit should be skipped");
      assert.ok("c-public" in state.circuits, "public circuit should be synced");
    } finally {
      cleanupFetch();
    }
  } finally {
    cleanupConfig();
    cleanupDir();
  }
});
