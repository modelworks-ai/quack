#!/usr/bin/env node
/**
 * quack — git-like authenticated circuit launcher for ModelWorks.
 *
 * @module
 */

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
  readConfig,
  readState,
  writeState,
} from "./project.js";

const VERSION = "0.1.0";

/** Print usage. */
function printHelp(): void {
  console.log(`
quack ${VERSION} — git-like authenticated circuit launcher for ModelWorks

Usage:
  quack                                   Launch the default agent (see below)
  quack init                              Create .quack/ in current directory
  quack add <circuit-url>                 Add a circuit (resolve + create SSE adaptor)
  quack rm <circuit-uid|url>              Remove a circuit
  quack ls                                List configured circuits
  quack refresh [circuit-uid]             Re-resolve versions and rediscover adaptors
  quack opencode [args]                   Start proxy + launch opencode (SSE circuits only)
  quack opencode --print                  Show injected config, don't launch
  quack opencode --verbose                Launch with proxy request logging
  quack agents                            List available agents
  quack login                             OAuth flow → store credentials
  quack logout                            Revoke + delete credentials
  quack whoami                            Show current user
  quack --help | -h                       Show this help
  quack --version | -v                    Show version
`);
}

/** Resolve the effective API base from env or stored credentials. */
function effectiveApiBase(): string {
  return getApiBase(loadCredentials());
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function cmdInit(args: string[]): Promise<void> {
  const force = args.includes("--force");
  // Require login before init — a quack project is useless without
  // credentials (can't add circuits, can't launch).
  const creds = loadCredentials();
  if (!creds) {
    console.error("Not logged in. Run `quack login` first.");
    process.exit(1);
  }
  initProject(force);
}

async function cmdLogin(args: string[]): Promise<void> {
  const apiBaseArg = flagValue(args, "--api-base");
  const result = await login(apiBaseOverride(apiBaseArg));
  console.log(`Logged in as user ${result.user_uid} (role: ${result.role}).`);
}

async function cmdLogout(): Promise<void> {
  await logout();
  console.log("Logged out.");
}

async function cmdWhoami(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) {
    console.log("Not logged in. Run `quack login` first.");
    process.exit(1);
  }
  console.log(`User:  ${creds.user_uid}`);
  console.log(`API:   ${creds.api_base}`);
  const now = Math.floor(Date.now() / 1000);
  const remaining = creds.expires_at - now;
  const expiry = remaining > 0
    ? `${Math.floor(remaining / 60)}m remaining`
    : "expired (will refresh on next use)";
  console.log(`Token: ${expiry}`);
}

async function cmdAdd(args: string[]): Promise<void> {
  const url = args[0];
  if (!url) {
    console.error("Usage: quack add <circuit-url>");
    process.exit(1);
  }
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
}

async function cmdRm(args: string[]): Promise<void> {
  const ref = args[0];
  if (!ref) {
    console.error("Usage: quack rm <circuit-uid|url>");
    process.exit(1);
  }
  const keepAdaptors = args.includes("--keep-adaptors");
  const apiBase = effectiveApiBase();
  const result = await removeCircuit(ref, apiBase, keepAdaptors);
  console.log(`Removed circuit '${result.name}' (${result.circuit_uid}).`);
}

async function cmdLs(): Promise<void> {
  if (!isQuackProject()) {
    console.error("Not a quack project. Run `quack init` first.");
    process.exit(1);
  }
  const config = readConfig();
  const state = readState();

  if (config.circuits.length === 0) {
    console.log("No circuits. Run `quack add <circuit-url>` to add one.");
    return;
  }

  for (const entry of config.circuits) {
    const s = state.circuits[entry.circuit_uid];
    if (!s) {
      console.log(
        `${entry.circuit_uid}  ${entry.name.padEnd(28)}  —        ✗ not synced (run \`quack opencode\` or \`quack refresh\`)`,
      );
      continue;
    }
    const sse = s.adapters.includes("OPEN_AI_SSE") && s.sse_adaptor_uid;
    const sseMark = sse ? "✓ SSE" : "✗ no SSE";
    const adapters = `[${s.adapters.join(", ")}]`;
    const adaptorUid = s.sse_adaptor_uid ? `(${s.sse_adaptor_uid})` : "";
    console.log(
      `${s.circuit_uid}  ${s.circuit_name.padEnd(28)}  ${s.version_uid}   ${sseMark}  ${adapters}  ${adaptorUid}`,
    );
  }
}

async function cmdRefresh(args: string[]): Promise<void> {
  const circuitUid = args[0];
  const apiBase = effectiveApiBase();
  const results = await refreshCircuits(apiBase, circuitUid);
  for (const r of results) {
    const sse = r.sse_compatible ? "SSE" : "no SSE";
    console.log(
      `Refreshed '${r.name}' (${r.circuit_uid}) → ${r.version_uid} [${sse}]`,
    );
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

async function cmdQuack(): Promise<void> {
  if (!isQuackProject()) {
    console.error("Not a quack project. Run `quack init` first.");
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds) {
    console.error("Not logged in. Run `quack login` first.");
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
        "No default agent set and multiple are installed. Set \"default_agent\" in .quack/config.json.",
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
      throw new Error("Not logged in. Run `quack login` first.");
    }
    return c.access_token;
  };

  const freshState = readState();
  const ctx = {
    proxyPort: 0,
    apiBase,
    getAccessToken,
    state: freshState,
  };

  const launchResult = await agent.launch(ctx, {
    args: [],
    verbose: false,
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

async function cmdAgent(agentName: string, args: string[]): Promise<void> {
  const agent = getAgent(agentName);
  if (!agent) {
    console.error(`Unknown agent: ${agentName}`);
    console.error("Run `quack agents` to see available agents.");
    process.exit(1);
  }

  const print = args.includes("--print");
  const verbose = args.includes("--verbose");
  const passThrough = args.filter((a) => !a.startsWith("--"));
  const apiBase = effectiveApiBase();

  const creds = loadCredentials();
  if (!creds) {
    console.error("Not logged in. Run `quack login` first.");
    process.exit(1);
  }

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
      throw new Error("Not logged in. Run `quack login` first.");
    }
    return c.access_token;
  };

  const state = readState();

  // Proxy port is assigned by the agent at launch time (it starts the
  // proxy). For buildConfig (used in --print), we pass 0 as a placeholder;
  // the agent replaces it with the real port.
  const ctx = {
    proxyPort: 0,
    apiBase,
    getAccessToken,
    state,
  };

  const result = await agent.launch(ctx, {
    args: passThrough,
    verbose,
    print,
  });

  if (result.exitCode !== null) {
    process.exit(result.exitCode);
  }
}

async function cmdAgents(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "list") {
    const agents = listAgents();
    const config = isQuackProject() ? readConfig() : null;
    const defaultAgent = config?.default_agent;

    console.log("Available agents:\n");
    for (const agent of agents) {
      const installed = isAgentAvailable(agent) ? "✓ installed" : "✗ not installed";
      const isDefault = defaultAgent === agent.name ? "  default" : "";
      console.log(`  ${agent.name.padEnd(12)} ${installed.padEnd(18)}${isDefault}  ${agent.description}`);
    }
    console.log(
      "\nThese agents are built into quack. New agents appear automatically\nwhen you update quack.",
    );
    return;
  }

  console.error(`Unknown agents subcommand: ${sub}`);
  console.error("Usage: quack agents [list]");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

/** Extract the value of a `--flag value` option, or `null`. */
function flagValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

/** Convert a `--api-base` flag value into an override (or `undefined`). */
function apiBaseOverride(value: string | null): string | undefined {
  return value ?? undefined;
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Extract global flags (--api-base) before dispatching so command
  // handlers only see positional args and their own flags.
  const filtered: string[] = [];
  let apiBaseOverrideVal: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--api-base" && i + 1 < argv.length) {
      apiBaseOverrideVal = argv[++i];
      continue;
    }
    filtered.push(argv[i]);
  }
  if (apiBaseOverrideVal) {
    process.env.QUACK_API_BASE = apiBaseOverrideVal;
  }

  const [cmd, ...rest] = filtered;

  if (cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (!cmd) {
    // Bare `quack` — launch the default agent.
    await cmdQuack();
    return;
  }

  try {
    switch (cmd) {
      case "init":
        await cmdInit(rest);
        break;
      case "login":
        await cmdLogin(rest);
        break;
      case "logout":
        await cmdLogout();
        break;
      case "whoami":
        await cmdWhoami();
        break;
      case "add":
        await cmdAdd(rest);
        break;
      case "rm":
        await cmdRm(rest);
        break;
      case "ls":
        await cmdLs();
        break;
      case "refresh":
        await cmdRefresh(rest);
        break;
      case "agents":
        await cmdAgents(rest);
        break;
      case "opencode":
        await cmdAgent("opencode", rest);
        break;
      default: {
        // Check if it's a built-in agent name.
        if (getAgent(cmd)) {
          await cmdAgent(cmd, rest);
          break;
        }
        console.error(`Unknown command: ${cmd}`);
        printHelp();
        process.exit(1);
      }
    }
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
