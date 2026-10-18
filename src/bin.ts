#!/usr/bin/env node
/**
 * quack — git-like authenticated circuit launcher for ModelWorks.
 *
 * @module
 */

import { getApiBase, loadCredentials, login, logout } from "./auth.js";
import { addCircuit, ensureState, refreshCircuits, removeCircuit } from "./circuit.js";
import { launchOpenCode } from "./launch.js";
import {
  initProject,
  isQuackProject,
  readConfig,
  readState,
} from "./project.js";

const VERSION = "0.1.0";

/** Print usage. */
function printHelp(): void {
  console.log(`
quack ${VERSION} — git-like authenticated circuit launcher for ModelWorks

Usage:
  quack init                              Create .quack/ in current directory
  quack add <circuit-url>                 Add a circuit (resolve + create SSE adaptor)
  quack rm <circuit-uid|url>              Remove a circuit
  quack ls                                List configured circuits
  quack refresh [circuit-uid]             Re-resolve versions and rediscover adaptors
  quack opencode [args]                   Start proxy + launch opencode (SSE circuits only)
  quack opencode --print                  Show injected config, don't launch
  quack opencode --verbose                Launch with proxy request logging
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

async function cmdOpencode(args: string[]): Promise<void> {
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

  const result = await launchOpenCode({
    apiBase,
    getAccessToken,
    args: passThrough,
    verbose,
    print,
  });

  if (result.exitCode !== null) {
    process.exit(result.exitCode);
  }
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

  if (!cmd || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
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
      case "opencode":
        await cmdOpencode(rest);
        break;
      default:
        console.error(`Unknown command: ${cmd}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
