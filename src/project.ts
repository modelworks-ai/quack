/**
 * Project-level `.quack/` directory management: init, config/state read/write.
 *
 * @module
 */

import fs from "node:fs";
import path from "node:path";

import type {
  CircuitConfigEntry,
  CircuitStateEntry,
  QuackConfig,
  QuackState,
} from "./types.js";

/** The `.quack/` directory name, placed at the project root. */
export const QUACK_DIR = ".quack";

/** Path to the `.quack/` directory in the current working directory. */
export function quackDir(): string {
  return path.join(process.cwd(), QUACK_DIR);
}

/** Path to `.quack/config.json`. */
export function configPath(): string {
  return path.join(quackDir(), "config.json");
}

/** Path to `.quack/state.json`. */
export function statePath(): string {
  return path.join(quackDir(), "state.json");
}

/** Does a `.quack/` directory exist in the current project? */
export function isQuackProject(): boolean {
  return fs.existsSync(quackDir()) && fs.existsSync(configPath());
}

/** Assert the current directory is a quack project; throw a friendly error if not. */
export function requireQuackProject(): void {
  if (!isQuackProject()) {
    throw new Error("Not a quack project. Run `quack init` first.");
  }
}

/** Empty config template. `default_agent` defaults to `opencode`. */
function emptyConfig(): QuackConfig {
  return { version: 1, default_agent: "opencode", circuits: [] };
}

/** Empty state template. */
function emptyState(): QuackState {
  return { circuits: {} };
}

/** `.gitignore` contents for `.quack/` — ignores `state.json` (runs/ is committed). */
const GITIGNORE_CONTENTS = "state.json\ndebug.log\n";

/**
 * `quack init` — create the `.quack/` directory with empty config,
 * state, and `.gitignore`.
 *
 * Errors if `.quack/` already exists, unless `force` is `true`.
 */
export function initProject(force = false): void {
  const dir = quackDir();
  if (fs.existsSync(dir)) {
    if (!force) {
      throw new Error("Already a quack project. Use `--force` to overwrite.");
    }
    fs.rmSync(dir, { recursive: true });
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(emptyConfig(), null, 2) + "\n");
  fs.writeFileSync(statePath(), JSON.stringify(emptyState(), null, 2) + "\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), GITIGNORE_CONTENTS);

  console.log(`Initialized quack project in ${dir}`);
}

// ---------------------------------------------------------------------------
// Config read/write (`.quack/config.json` — committable)
// ---------------------------------------------------------------------------

/** Read the project config. Throws if `.quack/` doesn't exist. */
export function readConfig(): QuackConfig {
  requireQuackProject();
  const raw = fs.readFileSync(configPath(), "utf8");
  return JSON.parse(raw) as QuackConfig;
}

/** Write the project config (atomic-ish: write then sync). */
export function writeConfig(config: QuackConfig): void {
  requireQuackProject();
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// State read/write (`.quack/state.json` — gitignored, per-user)
// ---------------------------------------------------------------------------

/**
 * Read the project state.
 *
 * Returns an empty state if `.quack/` doesn't exist or `state.json`
 * is missing (e.g. a freshly cloned repo where only `config.json`
 * was committed). The caller is responsible for auto-syncing state
 * from config when needed.
 */
export function readState(): QuackState {
  if (!isQuackProject()) {
    return emptyState();
  }
  try {
    const raw = fs.readFileSync(statePath(), "utf8");
    return JSON.parse(raw) as QuackState;
  } catch {
    return emptyState();
  }
}

/** Write the project state. */
export function writeState(state: QuackState): void {
  requireQuackProject();
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Convenience operations
// ---------------------------------------------------------------------------

/** Add a circuit entry to the config (no-op if already present). Returns `true` if added. */
export function addCircuitToConfig(entry: CircuitConfigEntry): boolean {
  const config = readConfig();
  if (config.circuits.some((c) => c.circuit_uid === entry.circuit_uid)) {
    return false;
  }
  config.circuits.push(entry);
  writeConfig(config);
  return true;
}

/** Remove a circuit from config by `circuit_uid`. Returns `true` if removed. */
export function removeCircuitFromConfig(circuitUid: string): boolean {
  const config = readConfig();
  const before = config.circuits.length;
  config.circuits = config.circuits.filter((c) => c.circuit_uid !== circuitUid);
  if (config.circuits.length === before) return false;
  writeConfig(config);
  return true;
}

/** Upsert a circuit's state entry (keyed by `circuit_uid`). */
export function upsertCircuitState(entry: CircuitStateEntry): void {
  const state = readState();
  state.circuits[entry.circuit_uid] = entry;
  writeState(state);
}

/** Remove a circuit's state entry. Returns `true` if removed. */
export function removeCircuitState(circuitUid: string): boolean {
  const state = readState();
  if (!(circuitUid in state.circuits)) return false;
  delete state.circuits[circuitUid];
  writeState(state);
  return true;
}

/** Get a circuit's state entry, or `null` if not present. */
export function getCircuitState(circuitUid: string): CircuitStateEntry | null {
  const state = readState();
  return state.circuits[circuitUid] ?? null;
}
