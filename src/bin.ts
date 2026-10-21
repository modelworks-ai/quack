#!/usr/bin/env node
/**
 * quack — Launch AI coding agents with ModelWorks circuits.
 *
 * @module
 */

import { Command } from "commander";

import { getApiBase, loadCredentials, login, logout } from "./auth.js";
import { addCircuit, ensureState, refreshCircuits, removeCircuit } from "./circuit.js";
import {
  listAgents,
  getAgent,
  isAgentAvailable,
  listAvailableAgents,
  resolveAgent,
  isInteractive,
} from "./agents/registry.js";
import {
  initProject,
  isQuackProject,
  requireQuackProject,
  readConfig,
  readState,
  writeConfig,
  writeState,
} from "./project.js";
import { listRunRecords, getRunRecord } from "./history.js";

const VERSION = "0.2.0";
import buildInfo from "./build-info.json" with { type: "json" };
const BUILD_ID = `${VERSION}+${buildInfo.build} (${buildInfo.commit}${buildInfo.dirty ? "-dirty" : ""})`;

// ANSI colors for status indicators.
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Strip ANSI escape codes to measure the visible text length. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// Table printing helper — dynamic column widths based on terminal width
// ---------------------------------------------------------------------------

export interface TableColumn {
  /** Column header text. */
  header: string;
  /** Cell values, one per row. */
  values: string[];
  /**
   * Can this column be truncated with `…` when the terminal is too narrow?
   * Defaults to `false` — only columns marked `true` are shrunk.
   * Typically used for long UID columns.
   */
  truncatable?: boolean;
  /**
   * Minimum visible width when truncating (default 10).
   * Truncated values get `…` appended, so this includes the ellipsis.
   */
  minWidth?: number;
}

/**
 * Print a formatted table with dynamic column widths that fit the terminal.
 *
 * Natural widths are computed from header + values (measuring visible
 * text, ignoring ANSI codes). If the total fits in the terminal, natural
 * widths are used (no truncation). If it overflows, truncatable columns
 * are shrunk (with `…`) until it fits; non-truncatable columns keep their
 * natural width.
 *
 * When `process.stdout` is not a TTY (piped), defaults to 80 columns.
 */
export function printTable(columns: TableColumn[]): void {
  const termWidth = process.stdout.columns ?? 80;
  const gap = 2; // spaces between columns
  const numCols = columns.length;
  const totalGap = (numCols - 1) * gap;

  // Natural width per column: max(header, longest value), measured without ANSI.
  const naturalWidths = columns.map((col) => {
    const valMax = col.values.length > 0
      ? Math.max(...col.values.map((v) => stripAnsi(v).length))
      : 0;
    return Math.max(col.header.length, valMax);
  });

  const totalNatural = naturalWidths.reduce((a, b) => a + b, 0) + totalGap;

  let widths = [...naturalWidths];

  if (totalNatural > termWidth) {
    // Shrink truncatable columns first, starting from the last truncatable
    // column (rightmost — typically the less-important UIDs).
    let deficit = totalNatural - termWidth;
    const truncatableIndices = columns
      .map((c, i) => (c.truncatable ? i : -1))
      .filter((i) => i >= 0)
      .reverse(); // shrink rightmost truncatable first

    for (const idx of truncatableIndices) {
      if (deficit <= 0) break;
      const minW = columns[idx].minWidth ?? 10;
      const available = widths[idx] - minW;
      if (available > 0) {
        const shrink = Math.min(available, deficit);
        widths[idx] -= shrink;
        deficit -= shrink;
      }
    }
  }

  /** Truncate a string to `maxLen` visible chars, appending `…`. */
  const truncate = (s: string, maxLen: number): string => {
    const plain = stripAnsi(s);
    if (plain.length <= maxLen) return s;
    // Preserve ANSI if present — truncate the visible text only.
    const cut = maxLen - 1; // leave room for …
    // For simplicity: strip ANSI, truncate, don't re-apply (UIDs have no color).
    return plain.slice(0, cut) + "…";
  };

  // Build header row.
  const headerRow = columns
    .map((col, i) => {
      const w = widths[i];
      return stripAnsi(col.header).length > w
        ? truncate(col.header, w).padEnd(w)
        : col.header.padEnd(w);
    })
    .join("  ");

  const separator = widths.map((w) => "─".repeat(w)).join("  ");

  console.log(headerRow);
  console.log(separator);

  // Data rows.
  const numRows = Math.max(...columns.map((c) => c.values.length));
  for (let row = 0; row < numRows; row++) {
    const cells = columns.map((col, i) => {
      const w = widths[i];
      const val = col.values[row] ?? "";
      const plainLen = stripAnsi(val).length;
      if (plainLen > w) {
        return truncate(val, w).padEnd(w);
      }
      // Preserve ANSI — pad based on visible length.
      return val + " ".repeat(w - plainLen);
    });
    console.log(cells.join("  "));
  }
}

/** Resolve the effective API base from env or stored credentials. */
function effectiveApiBase(): string {
  return getApiBase(loadCredentials());
}

/** Force-login guard — exit if not authenticated. */
function requireAuth(): void {
  if (!loadCredentials()) {
    console.error("Not logged in. Run `quack auth login` first.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

async function cmdInit(opts: { force?: boolean }): Promise<void> {
  initProject(opts.force ?? false);
}

// ---------------------------------------------------------------------------
// circuit commands
// ---------------------------------------------------------------------------

async function cmdCircuitList(opts: { long?: boolean }): Promise<void> {
  if (!isQuackProject()) {
    console.error("Not a quack project. Run `quack init` first.");
    process.exit(1);
  }
  const long = opts.long ?? false;
  const config = readConfig();
  const state = readState();

  if (config.circuits.length === 0) {
    console.log("No circuits. Run `quack circuit add <circuit-url>` to add one.");
    return;
  }

  // Warn if default_circuit is stale (not in the circuits array).
  if (config.default_circuit) {
    const inConfig = config.circuits.some(
      (c) => c.circuit_uid === config.default_circuit,
    );
    if (!inConfig) {
      const firstCircuit = config.circuits[0];
      console.error(
        `⚠ default_circuit '${config.default_circuit}' not found in circuits — using ${firstCircuit.name} as default`,
      );
    }
  }

  // Build all rows: first row per circuit carries name/SSE/version/circuit UID;
  // adapter rows carry the adapter type + adaptor UID.
  interface Row {
    name: string;
    sse: string; // colored ✓ or ✗ or ~ or "" for adapter rows
    adapter: string; // "" for circuit row
    adaptorUid: string;
    versionUid: string;
    circuitUid: string;
  }

  const rows: Row[] = [];
  for (const entry of config.circuits) {
    const isDefault = config.default_circuit === entry.circuit_uid;
    const displayName = isDefault ? `${entry.name} *` : entry.name;
    const s = state.circuits[entry.circuit_uid];
    if (!s) {
      rows.push({
        name: displayName,
        sse: `${RED}✗${RESET}`,
        adapter: `${DIM}not synced (run \`quack refresh\`)${RESET}`,
        adaptorUid: "",
        versionUid: "",
        circuitUid: entry.circuit_uid,
      });
      continue;
    }

    const sseOk = s.adapters.includes("OPEN_AI_SSE") && s.sse_adaptor_uid;
    const sseMark = sseOk
      ? `${GREEN}✓${RESET}`
      : s.adapters.includes("OPEN_AI_SSE")
        ? `${YELLOW}~${RESET}`
        : `${RED}✗${RESET}`;

    // First row: circuit summary + first adapter (if any).
    const firstAdapter = s.adapters.length > 0 ? s.adapters[0] : "";
    const firstAdaptorUid = s.adapters.length > 0
      ? (s.adaptor_uids?.[s.adapters[0]] ?? "—")
      : "";
    rows.push({
      name: displayName,
      sse: sseMark,
      adapter: firstAdapter,
      adaptorUid: firstAdaptorUid,
      versionUid: s.version_uid,
      circuitUid: s.circuit_uid,
    });

    // Remaining adapter rows.
    for (let i = 1; i < s.adapters.length; i++) {
      const adapter = s.adapters[i];
      const uid = s.adaptor_uids?.[adapter] ?? "—";
      rows.push({
        name: "",
        sse: "",
        adapter,
        adaptorUid: uid,
        versionUid: "",
        circuitUid: "",
      });
    }
  }

  // Build columns for printTable.
  const columns: TableColumn[] = [
    { header: "NAME", values: rows.map((r) => r.name) },
    { header: "SSE", values: rows.map((r) => r.sse) },
    { header: "ADAPTER", values: rows.map((r) => r.adapter) },
    { header: "ADAPTOR UID", values: rows.map((r) => r.adaptorUid), truncatable: true },
    {
      header: "VERSION UID",
      values: rows.map((r) => r.versionUid ? `${DIM}${r.versionUid}${RESET}` : ""),
      truncatable: true,
    },
  ];
  if (long) {
    columns.push({
      header: "CIRCUIT UID",
      values: rows.map((r) => r.circuitUid ? `${DIM}${r.circuitUid}${RESET}` : ""),
      truncatable: true,
    });
  }

  printTable(columns);
}

async function cmdCircuitAdd(url: string): Promise<void> {
  const apiBase = effectiveApiBase();
  const result = await addCircuit(url, apiBase);
  const adapterList = result.adapters.join(", ") || "(none)";
  if (!result.added) {
    console.log(`Circuit already added — refreshed state.`);
  }
  if (result.sse_compatible) {
    console.log(
      `Added circuit '${result.name}' (SSE). Adapters: ${adapterList}.`,
    );
  } else {
    console.log(
      `Added circuit '${result.name}' (no SSE). Adapters: ${adapterList}. Will not be injected by \`quack opencode\`.`,
    );
  }

  // Auto-set default_circuit if this is SSE-compatible and no default is set.
  if (result.sse_compatible && result.added) {
    const config = readConfig();
    if (!config.default_circuit) {
      config.default_circuit = result.circuit_uid;
      writeConfig(config);
      console.log(`Set as default circuit (use \`quack circuit use <uid>\` to change).`);
    }
  }
}

async function cmdCircuitRemove(ref: string): Promise<void> {
  const result = await removeCircuit(ref);
  console.log(`Removed circuit '${result.name}' (${result.circuit_uid}).`);

  // Clear default_circuit if it pointed to the removed circuit.
  const config = readConfig();
  if (config.default_circuit === result.circuit_uid) {
    config.default_circuit = undefined;
    writeConfig(config);
    console.log(`Cleared default circuit.`);
  }
}

/** `quack circuit use <uid>` — set the default circuit. */
function cmdCircuitUse(uid: string): void {
  requireQuackProject();
  const config = readConfig();
  const entry = config.circuits.find((c) => c.circuit_uid === uid);
  if (!entry) {
    console.error(`Circuit ${uid} is not in this project.`);
    console.error("Run `quack circuit list` to see available circuits.");
    process.exit(1);
  }

  config.default_circuit = uid;
  writeConfig(config);

  // Check SSE compatibility from state.
  const state = readState();
  const s = state.circuits[uid];
  if (s && !s.adapters.includes("OPEN_AI_SSE")) {
    console.log(`Set default circuit to '${entry.name}'.`);
    console.log(`⚠ not SSE-compatible — won't appear as a model in OpenCode.`);
  } else {
    console.log(`Set default circuit to '${entry.name}'.`);
  }
}

async function cmdCircuitRefresh(uid?: string): Promise<void> {
  const apiBase = effectiveApiBase();
  const results = await refreshCircuits(apiBase, uid);
  for (const r of results) {
    const sse = r.sse_compatible ? "SSE" : "no SSE";
    console.log(
      `Refreshed '${r.name}' (${r.circuit_uid}) → ${r.version_uid} [${sse}]`,
    );
  }
}

async function cmdCircuitDescribe(uid: string): Promise<void> {
  if (!isQuackProject()) {
    console.error("Not a quack project. Run `quack init` first.");
    process.exit(1);
  }
  const config = readConfig();
  const state = readState();
  const entry = config.circuits.find((c) => c.circuit_uid === uid);
  if (!entry) {
    console.error(`Circuit ${uid} is not in this project.`);
    process.exit(1);
  }
  const s = state.circuits[uid];

  console.log(`Name:        ${entry.name}`);
  console.log(`Circuit UID: ${uid}`);
  console.log(`Default:     ${config.default_circuit === uid ? "yes" : "no"}`);
  if (s) {
    console.log(`Version UID: ${s.version_uid}`);
    const sseOk = s.adapters.includes("OPEN_AI_SSE") && s.sse_adaptor_uid;
    const sseStatus = sseOk
      ? `${GREEN}✓${RESET} compatible`
      : s.adapters.includes("OPEN_AI_SSE")
        ? `${YELLOW}~${RESET} adapter missing`
        : `${RED}✗${RESET} not compatible`;
    console.log(`SSE:         ${sseStatus}`);
    console.log();
    console.log(`Adapters:`);
    for (const adapter of s.adapters) {
      const adaptorUid = s.adaptor_uids?.[adapter] ?? "—";
      console.log(`  ${adapter.padEnd(18)} ${DIM}${adaptorUid}${RESET}`);
    }
    console.log();
    console.log(`Added:       ${entry.added_at}`);
    console.log(`Last sync:   ${s.resolved_at}`);
  } else {
    console.log(`SSE:         ${RED}✗${RESET} not synced`);
    console.log();
    console.log(`Run \`quack circuit refresh ${uid}\` to sync.`);
  }
}

// ---------------------------------------------------------------------------
// auth commands
// ---------------------------------------------------------------------------

async function cmdAuthLogin(apiBase?: string): Promise<void> {
  const result = await login(apiBase);
  console.log(`Logged in as user ${result.user_uid} (role: ${result.role}).`);
}

async function cmdAuthLogout(): Promise<void> {
  await logout();
  console.log("Logged out.");
}

async function cmdAuthStatus(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) {
    console.log("Not logged in. Run `quack auth login` first.");
    process.exit(1);
  }

  // Fetch the username from the API for a friendlier display.
  let username = creds.user_uid;
  try {
    const res = await fetch(`${creds.api_base}/api/users/token`, {
      headers: { Authorization: `Bearer ${creds.access_token}` },
    });
    if (res.ok) {
      const body = await res.json() as { payload?: { username?: string; name?: string } };
      username = body.payload?.username ?? username;
    }
  } catch {
    // Fall back to user_uid if the API is unreachable.
  }

  console.log(`User:  ${username}`);
  console.log(`UID:   ${creds.user_uid}`);
  console.log(`API:   ${creds.api_base}`);
  const now = Math.floor(Date.now() / 1000);
  const remaining = creds.expires_at - now;
  const expiry = remaining > 0
    ? `${Math.floor(remaining / 60)}m remaining`
    : "expired (will refresh on next use)";
  console.log(`Token: ${expiry}`);
}

// ---------------------------------------------------------------------------
// agent commands
// ---------------------------------------------------------------------------

async function cmdAgentList(): Promise<void> {
  const agents = listAgents();
  const config = isQuackProject() ? readConfig() : null;
  const defaultAgent = config?.default_agent;

  console.log("Available agents:\n");
  for (const agent of agents) {
    const installed = isAgentAvailable(agent) ? `${GREEN}✓ installed${RESET}` : `${RED}✗ not installed${RESET}`;
    const isDefault = defaultAgent === agent.name ? "  default" : "";
    const installedPlain = stripAnsi(installed);
    console.log(`  ${agent.name.padEnd(12)} ${installedPlain.padEnd(18)}${isDefault}  ${agent.description}`);
  }
  console.log(
    "\nThese agents are built into quack. New agents appear automatically\nwhen you update quack.",
  );
}

async function cmdAgentDescribe(name: string): Promise<void> {
  const agent = getAgent(name);
  if (!agent) {
    console.error(`Unknown agent: ${name}`);
    console.error("Run `quack agent list` to see available agents.");
    process.exit(1);
  }
  const config = isQuackProject() ? readConfig() : null;
  const isDefault = config?.default_agent === name;
  const installed = isAgentAvailable(agent);

  console.log(`Name:        ${agent.name}`);
  console.log(`Description: ${agent.description}`);
  console.log(`Binary:      ${agent.binary}`);
  console.log(`Status:      ${installed ? `${GREEN}✓${RESET} installed` : `${RED}✗${RESET} not installed`}`);
  if (isDefault) {
    console.log(`Default:     yes`);
  }
}

// ---------------------------------------------------------------------------
// Interactive picker
// ---------------------------------------------------------------------------

/** Prompt the user to pick from a list of agents. Returns the chosen agent. */
async function pickAgentInteractive(): Promise<string | null> {
  const available = listAvailableAgents();
  if (available.length === 0) return null;

  const readline = await import("node:readline/promises");
  const { stdin, stdout } = process;
  const rl = readline.createInterface({ input: stdin, output: stdout });

  console.log("\nNo default agent set. Pick one:\n");
  available.forEach((agent, i) => {
    console.log(`  ${i + 1}) ${agent.name} — ${agent.description}`);
  });
  console.log("");

  try {
    const answer = await rl.question(`Pick an agent [1-${available.length}]: `);
    const idx = parseInt(answer.trim(), 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= available.length) {
      console.error("Invalid selection.");
      return null;
    }
    return available[idx].name;
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Bare `quack` — launch the default agent
// ---------------------------------------------------------------------------

async function cmdQuack(opts: { verbose?: boolean; debug?: boolean }): Promise<void> {
  if (!isQuackProject()) {
    console.error("Not a quack project. Run `quack init` first.");
    process.exit(1);
  }

  const config = readConfig();
  const state = readState();

  // Resolve which agent to launch.
  let agentName: string | undefined;
  const result = resolveAgent(config.default_agent, state.last_agent);

  if (result.ok) {
    agentName = result.agent.name;
  } else if (result.message === "__PROMPT__") {
    // Interactive picker — multiple agents available, no default set.
    if (!isInteractive()) {
      console.error(
        'No default agent set and multiple are installed. Set "default_agent" in .quack/config.json.',
      );
      process.exit(1);
    }
    const picked = await pickAgentInteractive();
    if (!picked) {
      process.exit(1);
    }
    agentName = picked;
  } else {
    console.error(result.message);
    process.exit(1);
  }

  const agent = getAgent(agentName);
  if (!agent) {
    console.error(`Agent "${agentName}" not found.`);
    process.exit(1);
  }

  // Auto-sync circuits (cloned repo case).
  const apiBase = effectiveApiBase();
  await ensureState(apiBase);

  // Launch with no args.
  const getAccessToken = () => {
    const c = loadCredentials();
    if (!c) {
      throw new Error("Not logged in. Run `quack auth login` first.");
    }
    return c.access_token;
  };

  const freshState = readState();
  const freshConfig = readConfig();
  const ctx = {
    proxyPort: 0,
    apiBase,
    getAccessToken,
    state: freshState,
    config: freshConfig,
  };

  const launchResult = await agent.launch(ctx, {
    args: [],
    verbose: opts.verbose ?? false,
    debug: opts.debug ?? false,
    print: false,
  });

  // Save the last-used agent.
  if (launchResult.exitCode !== null) {
    const s = readState();
    s.last_agent = agentName;
    writeState(s);
    process.exit(launchResult.exitCode);
  }
}

// ---------------------------------------------------------------------------
// Agent launch (quack opencode / quack <agent>)
// ---------------------------------------------------------------------------

async function cmdAgentLaunch(agentName: string, args: string[], opts: { print?: boolean; verbose?: boolean; debug?: boolean }): Promise<void> {
  const agent = getAgent(agentName);
  if (!agent) {
    console.error(`Unknown agent: ${agentName}`);
    console.error("Run `quack agent list` to see available agents.");
    process.exit(1);
  }

  const passThrough = args.filter((a) => !a.startsWith("--"));
  const apiBase = effectiveApiBase();

  if (!isQuackProject()) {
    console.error("Not a quack project. Run `quack init` first.");
    process.exit(1);
  }

  // Auto-sync: create adaptors for circuits in config but missing from
  // state (cloned repo case — like `npm install` creating node_modules).
  await ensureState(apiBase);

  // `getAccessToken` must return the live (possibly-refreshed) token.
  // We read from disk on every call so the proxy always sees the latest.
  const getAccessToken = () => {
    const c = loadCredentials();
    if (!c) {
      throw new Error("Not logged in. Run `quack auth login` first.");
    }
    return c.access_token;
  };

  const state = readState();
  const config = readConfig();

  const ctx = {
    proxyPort: 0,
    apiBase,
    getAccessToken,
    state,
    config,
  };

  const result = await agent.launch(ctx, {
    args: passThrough,
    verbose: opts.verbose ?? false,
    debug: opts.debug ?? false,
    print: opts.print ?? false,
  });

  if (result.exitCode !== null) {
    process.exit(result.exitCode);
  }
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

async function cmdHistory(filter: string | undefined, opts: { user?: string; circuit?: string }): Promise<void> {
  if (!isQuackProject()) {
    console.error("Not a quack project. Run `quack init` first.");
    process.exit(1);
  }

  // If a specific run UID is given, show full details.
  if (filter && !filter.startsWith("-")) {
    const record = getRunRecord(filter);
    if (!record) {
      console.error(`Run ${filter} not found in local history.`);
      process.exit(1);
    }
    console.log(`Run UID:       ${record.run_uid}`);
    console.log(`Circuit:       ${record.circuit_name} (${record.circuit_uid})`);
    console.log(`Owner:         ${record.owner_username}`);
    console.log(`Caller:        ${record.caller_username}`);
    console.log(`Version UID:   ${record.version_uid}`);
    console.log(`Status:        ${record.status}`);
    console.log(`Created:       ${record.created_at}`);
    console.log(`Completed:     ${record.completed_at}`);
    if (record.duration_ms !== null) {
      console.log(`Duration:      ${(record.duration_ms / 1000).toFixed(1)}s`);
    }
    if (record.cost_credits !== null) {
      console.log(`Cost:          ${record.cost_credits} credits`);
    }
    if (record.input_tokens !== null) {
      console.log(`Input tokens:  ${record.input_tokens}`);
    }
    if (record.output_tokens !== null) {
      console.log(`Output tokens:  ${record.output_tokens}`);
    }
    return;
  }

  // List runs in table format.
  let records = listRunRecords();

  // Apply filters.
  if (opts.user) {
    records = records.filter((r) => r.caller_username === opts.user);
  }
  if (opts.circuit) {
    records = records.filter((r) => r.circuit_uid === opts.circuit);
  }

  if (records.length === 0) {
    console.log("No run history. Runs are saved automatically after each circuit request.");
    return;
  }

  // Table: RUN UID, CIRCUIT, CALLER, STATUS, COST, DURATION
  const rows = records.map((r) => {
    const isCompleted = r.status === "COMPLETED" || r.status === "Completed";
    const isFailed = r.status === "EXCEPTION" || r.status === "FAILED";
    const statusCol = isCompleted
      ? `${GREEN}${r.status}${RESET}`
      : isFailed
        ? `${RED}${r.status}${RESET}`
        : r.status;
    return {
      runUid: r.run_uid,
      circuit: `${r.owner_username}/${r.circuit_name}`,
      caller: r.caller_username,
      status: statusCol,
      cost: r.cost_credits !== null ? String(r.cost_credits) : "—",
      duration: r.duration_ms !== null ? (r.duration_ms / 1000).toFixed(1) + "s" : "—",
    };
  });

  printTable([
    { header: "RUN UID", values: rows.map((r) => `${DIM}${r.runUid}${RESET}`), truncatable: true },
    { header: "CIRCUIT", values: rows.map((r) => r.circuit) },
    { header: "CALLER", values: rows.map((r) => r.caller) },
    { header: "STATUS", values: rows.map((r) => r.status) },
    { header: "COST", values: rows.map((r) => r.cost) },
    { header: "DURATION", values: rows.map((r) => r.duration) },
  ]);
}

// ---------------------------------------------------------------------------
// Build the CLI
// ---------------------------------------------------------------------------

function buildCli(): Command {
  const program = new Command();

  program
    .name("quack")
    .description("Launch AI coding agents with ModelWorks circuits")
    .version(BUILD_ID, "-v, --version")
    .option("--api-base <url>", "Override API base URL")
    .option("--verbose", "Verbose output (proxy request logging)")
    .option("--debug", "Debug mode (full proxy request/response logging to .quack/debug.log)")
    .helpOption("-h, --help", "Show help");

  // init
  program
    .command("init")
    .description("Initialize a quack project (.quack/ directory)")
    .option("--force", "Overwrite existing .quack/ directory")
    .action(async (opts) => {
      requireAuth();
      await cmdInit(opts);
    });

  // circuit group
  const circuit = program
    .command("circuit")
    .description("Manage circuits in this project");

  circuit
    .command("list")
    .description("List circuits and their adapters")
    .option("-l, --long", "Show full UIDs (CIRCUIT UID column)")
    .action(async (opts) => {
      requireAuth();
      await cmdCircuitList(opts);
    });

  circuit
    .command("add <url>")
    .description("Add a circuit by URL or UID")
    .action(async (url) => {
      requireAuth();
      await cmdCircuitAdd(url);
    });

  circuit
    .command("remove <uid>")
    .description("Remove a circuit from this project")
    .action(async (uid) => {
      requireAuth();
      await cmdCircuitRemove(uid);
    });

  circuit
    .command("refresh [uid]")
    .description("Re-resolve circuit version and adapters")
    .action(async (uid) => {
      requireAuth();
      await cmdCircuitRefresh(uid);
    });

  circuit
    .command("describe <uid>")
    .description("Show detailed information about a circuit")
    .action(async (uid) => {
      requireAuth();
      await cmdCircuitDescribe(uid);
    });

  circuit
    .command("use <uid>")
    .description("Set the default circuit (used as the default model in OpenCode)")
    .action(async (uid: string) => {
      requireAuth();
      cmdCircuitUse(uid);
    });

  // agent group
  const agent = program
    .command("agent")
    .description("List and inspect available agents");

  agent
    .command("list")
    .description("List all available agents")
    .action(async () => {
      await cmdAgentList();
    });

  agent
    .command("describe <name>")
    .description("Show details about a specific agent")
    .action(async (name) => {
      await cmdAgentDescribe(name);
    });

  // auth group
  const auth = program
    .command("auth")
    .description("Authentication commands");

  auth
    .command("login")
    .description("Login via OAuth (opens browser)")
    .action(async () => {
      const opts = program.opts();
      await cmdAuthLogin(opts.apiBase);
    });

  auth
    .command("logout")
    .description("Logout and revoke credentials")
    .action(async () => {
      await cmdAuthLogout();
    });

  auth
    .command("status")
    .description("Show current user and token status")
    .action(async () => {
      await cmdAuthStatus();
    });

  // opencode — launch OpenCode (built-in agent)
  program
    .command("opencode [args...]")
    .description("Launch OpenCode with SSE circuits as model providers")
    .option("--print", "Show injected config, don't launch")
    .allowUnknownOption(true)
    .action(async (args, opts) => {
      requireAuth();
      await cmdAgentLaunch("opencode", args ?? [], opts);
    });

  // history — list and show circuit run history
  program
    .command("history [filter]")
    .description("Show circuit run history (list, or show a specific run by UID)")
    .option("--user <name>", "Filter by caller username")
    .option("--circuit <uid>", "Filter by circuit UID")
    .action(async (filter, opts) => {
      requireAuth();
      await cmdHistory(filter, opts);
    });

  // Bare `quack` — launch the default agent.
  // Commander calls the default action when no subcommand is given.
  program.action(async (opts) => {
    requireAuth();
    await cmdQuack(opts);
  });

  return program;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const program = buildCli();
  const argv = process.argv.slice(2);

  // Set QUACK_API_BASE from the global --api-base flag before any
  // command handler runs, so effectiveApiBase() picks it up.
  const apiBaseIdx = argv.indexOf("--api-base");
  if (apiBaseIdx !== -1 && apiBaseIdx + 1 < argv.length) {
    process.env.QUACK_API_BASE = argv[apiBaseIdx + 1];
  }

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
