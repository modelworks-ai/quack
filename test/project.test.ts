/**
 * Tests for project.ts: init, config/state read/write, circuit add/remove.
 *
 * @module
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  initProject,
  isQuackProject,
  readConfig,
  readState,
  writeConfig,
  writeState,
  addCircuitToConfig,
  removeCircuitFromConfig,
  upsertCircuitState,
  removeCircuitState,
  getCircuitState,
} from "../src/project.js";
import type { CircuitConfigEntry, CircuitStateEntry } from "../src/types.js";
import { withTempDir } from "./helpers.js";

// ---------------------------------------------------------------------------
// initProject
// ---------------------------------------------------------------------------

test("initProject: creates .quack/ with config, state, .gitignore", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    assert.ok(fs.existsSync(".quack/config.json"));
    assert.ok(fs.existsSync(".quack/state.json"));
    assert.ok(fs.existsSync(".quack/.gitignore"));
    assert.ok(fs.existsSync(".quack/runs"));
    assert.equal(fs.readFileSync(".quack/.gitignore", "utf8").trim(), "state.json\ndebug.log");
  } finally {
    cleanup();
  }
});

test("initProject: empty config has version 1 and empty circuits", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    const config = readConfig();
    assert.equal(config.version, 1);
    assert.deepEqual(config.circuits, []);
  } finally {
    cleanup();
  }
});

test("initProject: empty state has empty circuits map", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    const state = readState();
    assert.deepEqual(state.circuits, {});
  } finally {
    cleanup();
  }
});

test("initProject: throws if already a quack project", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    assert.throws(() => initProject(), /Already a quack project/);
  } finally {
    cleanup();
  }
});

test("initProject: force overwrites existing", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    fs.writeFileSync(".quack/config.json", '{"modified": true}');
    initProject(true);
    const config = readConfig();
    assert.equal(config.version, 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// isQuackProject
// ---------------------------------------------------------------------------

test("isQuackProject: false before init", () => {
  const { cleanup } = withTempDir();
  try {
    assert.equal(isQuackProject(), false);
  } finally {
    cleanup();
  }
});

test("isQuackProject: true after init", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    assert.equal(isQuackProject(), true);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// readState (missing file)
// ---------------------------------------------------------------------------

test("readState: returns empty state when state.json is missing", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    fs.unlinkSync(".quack/state.json");
    const state = readState();
    assert.deepEqual(state.circuits, {});
  } finally {
    cleanup();
  }
});

test("readState: returns empty state when not a quack project", () => {
  const { cleanup } = withTempDir();
  try {
    const state = readState();
    assert.deepEqual(state.circuits, {});
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Config CRUD
// ---------------------------------------------------------------------------

const sampleEntry: CircuitConfigEntry = {
  url: "https://modelworks.ai/circuits/c-test",
  circuit_uid: "c-test",
  name: "Test Circuit",
  added_at: "2026-01-01T00:00:00Z",
};

test("addCircuitToConfig: adds entry", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    const added = addCircuitToConfig(sampleEntry);
    assert.equal(added, true);
    const config = readConfig();
    assert.equal(config.circuits.length, 1);
    assert.equal(config.circuits[0].circuit_uid, "c-test");
  } finally {
    cleanup();
  }
});

test("addCircuitToConfig: no-op if already present", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    addCircuitToConfig(sampleEntry);
    const added = addCircuitToConfig(sampleEntry);
    assert.equal(added, false);
    assert.equal(readConfig().circuits.length, 1);
  } finally {
    cleanup();
  }
});

test("removeCircuitFromConfig: removes entry", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    addCircuitToConfig(sampleEntry);
    const removed = removeCircuitFromConfig("c-test");
    assert.equal(removed, true);
    assert.equal(readConfig().circuits.length, 0);
  } finally {
    cleanup();
  }
});

test("removeCircuitFromConfig: returns false if not present", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    const removed = removeCircuitFromConfig("c-nonexistent");
    assert.equal(removed, false);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// State CRUD
// ---------------------------------------------------------------------------

const sampleState: CircuitStateEntry = {
  circuit_uid: "c-test",
  version_uid: "cv-test",
  circuit_name: "Test Circuit",
        owner_username: "alice",
  adapters: ["OPEN_AI_SSE"],
  sse_adaptor_uid: "ca-test",
  adaptor_uids: { OPEN_AI_SSE: "ca-test" },
  resolved_at: "2026-01-01T00:00:00Z",
};

test("upsertCircuitState: creates new entry", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    upsertCircuitState(sampleState);
    const s = getCircuitState("c-test");
    assert.ok(s);
    assert.equal(s!.circuit_uid, "c-test");
    assert.equal(s!.sse_adaptor_uid, "ca-test");
  } finally {
    cleanup();
  }
});

test("upsertCircuitState: replaces existing entry", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    upsertCircuitState(sampleState);
    const updated: CircuitStateEntry = {
      ...sampleState,
      sse_adaptor_uid: "ca-different",
  adaptor_uids: { OPEN_AI_SSE: "ca-different" },
    };
    upsertCircuitState(updated);
    const s = getCircuitState("c-test");
    assert.equal(s!.sse_adaptor_uid, "ca-different");
  } finally {
    cleanup();
  }
});

test("removeCircuitState: removes entry", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    upsertCircuitState(sampleState);
    const removed = removeCircuitState("c-test");
    assert.equal(removed, true);
    assert.equal(getCircuitState("c-test"), null);
  } finally {
    cleanup();
  }
});

test("removeCircuitState: returns false if not present", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    assert.equal(removeCircuitState("c-nonexistent"), false);
  } finally {
    cleanup();
  }
});

test("getCircuitState: returns null if not present", () => {
  const { cleanup } = withTempDir();
  try {
    initProject();
    assert.equal(getCircuitState("c-nonexistent"), null);
  } finally {
    cleanup();
  }
});
