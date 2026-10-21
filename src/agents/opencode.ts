/**
 * OpenCode agent — injects SSE circuits as OpenAI-compatible providers
 * via `OPENCODE_CONFIG_CONTENT`, plus the global `modelworks` MCP server.
 *
 * @module
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { refreshToken } from "../auth.js";
import { readState, readConfig } from "../project.js";
import { startProxy } from "../proxy.js";
import type {
  ProxyHandle,
  QuackConfig,
  QuackState,
  CircuitStateEntry,
  OpenCodeConfig,
  OpenCodeMcpServer,
  OpenCodeProvider,
} from "../types.js";
import type { Agent, AgentContext, LaunchOptions, LaunchResult } from "./types.js";

/** Quack version (kept in sync with package.json). */
const AGENT_VERSION = "0.2.0";

/** `npm` package for OpenAI-compatible providers. */
const OPENAI_COMPATIBLE_PACKAGE = "@opencode/ai/providers/openai-compatible";

/** Detect whether a binary is on PATH. */
function hasBinary(bin: string): boolean {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(cmd, [bin], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Check if a file exists and is executable at a specific path. */
function hasBinaryAt(binPath: string): boolean {
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the opencode binary: prefer V2 (MCP 2.0 support), fall back to V1. */
function resolveOpencodeBinary(): { bin: string; isV2: boolean } | null {
  // V2: on PATH as "opencode2", or at ~/.opencode/bin/opencode2
  if (hasBinary("opencode2")) return { bin: "opencode2", isV2: true };
  const v2Path = path.join(os.homedir(), ".opencode", "bin", "opencode2");
  if (hasBinaryAt(v2Path)) return { bin: v2Path, isV2: true };
  // V1: on PATH as "opencode"
  if (hasBinary("opencode")) return { bin: "opencode", isV2: false };
  return null;
}

/** Install methods for opencode, in priority order. */
const OPENCODE_INSTALL = [
  { label: "curl", cmd: "curl -fsSL https://opencode.ai/install | bash", check: () => hasBinary("curl") },
  { label: "npm", cmd: "npm i -g @opencode/cli", check: () => hasBinary("npm") },
  { label: "bun", cmd: "bun install -g @opencode/cli", check: () => hasBinary("bun") },
  { label: "brew", cmd: "brew install opencode", check: () => hasBinary("brew") },
];

/** Should this circuit be injected as an OpenAI-compatible provider? */
function isInjectableSseCircuit(entry: CircuitStateEntry): boolean {
  return (
    entry.adapters.includes("OPEN_AI_SSE") && entry.sse_adaptor_uid !== null
  );
}

/**
 * Resolve which circuit to use as the default OpenCode model.
 *
 * Resolution order:
 * 1. `config.default_circuit` if it's SSE-compatible and injected
 * 2. First injectable SSE circuit in state (fallback, not persisted)
 * 3. `null` — no default model injected
 *
 * Prints a warning to stderr if `default_circuit` is stale (not in the
 * circuits array) or not SSE-compatible.
 *
 * @returns the OpenCode model ID (`circuit-<uid>/<uid>`) or `null`.
 */
export function resolveDefaultModel(
  config: QuackConfig,
  state: QuackState,
): string | null {
  const injectedCircuits = Object.values(state.circuits).filter(
    isInjectableSseCircuit,
  );
  if (injectedCircuits.length === 0) return null;

  const configured = config.default_circuit;
  if (configured) {
    // Check the circuit exists in the config's circuits array.
    const inConfig = config.circuits.some(
      (c) => c.circuit_uid === configured,
    );
    if (!inConfig) {
      console.error(
        `⚠ default_circuit '${configured}' not found in circuits — using ${injectedCircuits[0].circuit_name} as default`,
      );
    } else {
      const entry = state.circuits[configured];
      if (entry && isInjectableSseCircuit(entry)) {
        return `circuit-${configured}/${configured}`;
      }
      console.error(
        `⚠ default_circuit '${configured}' is not SSE-compatible — using ${injectedCircuits[0].circuit_name} as default`,
      );
    }
  }

  // Fallback: first injectable SSE circuit.
  const first = injectedCircuits[0];
  return `circuit-${first.circuit_uid}/${first.circuit_uid}`;
}

/** Build the OpenCode config from project state. */
export function buildOpenCodeConfig(
  state: QuackState,
  port: number,
  defaultModel?: string | null,
): OpenCodeConfig {
  const proxyBase = `http://localhost:${port}`;

  const config: OpenCodeConfig = {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      servers: {
        "ModelWorks x.MCP": {
          type: "remote",
          url: `${proxyBase}/api/x.mcp`,
          oauth: false,
          // x.mcp requires MCP 2.0 (server/discover) and rejects the
          // legacy initialize handshake. "auto" probes then falls back
          // to legacy, which gets rejected — so force 2026-07-28.
          protocol: "2026-07-28",
          // Dummy auth header — the proxy overrides it with the real
          // Bearer token. Without this, OpenCode sees no auth config and
          // prompts the user to authenticate ("MCP Authentication Required").
          headers: {
            Authorization: "Bearer quack",
          },
        },
      },
    },
    providers: {},
  };

  if (defaultModel) {
    config.model = defaultModel;
  }

  for (const entry of Object.values(state.circuits)) {
    if (!isInjectableSseCircuit(entry)) continue;

    const providerKey = `circuit-${entry.circuit_uid}`;
    const provider: OpenCodeProvider = {
      name: "ModelWorks",
      package: OPENAI_COMPATIBLE_PACKAGE,
      settings: {
        baseURL: `${proxyBase}/api/circuit-adaptors/${entry.sse_adaptor_uid}/query`,
        // Dummy apiKey — the proxy overrides the Authorization header with the real token.
        // No `env` field: V2 treats `env`-listed vars as a requirement for provider activation.
        // Without it, the literal apiKey activates the provider immediately.
        apiKey: "quack",
      },
      models: {
        [entry.circuit_uid]: { name: `${entry.owner_username}/${entry.circuit_name}` },
      },
    };
    config.providers![providerKey] = provider;
  }

  return config;
}

/** Describe the injection decision for `--print` output. */
export interface InjectionSummary {
  injected: Array<{ circuit_uid: string; name: string; sse_adaptor_uid: string }>;
  skipped: Array<{ circuit_uid: string; name: string; reason: string }>;
}

export function summarizeInjection(state: QuackState): InjectionSummary {
  const injected: InjectionSummary["injected"] = [];
  const skipped: InjectionSummary["skipped"] = [];

  for (const entry of Object.values(state.circuits)) {
    if (isInjectableSseCircuit(entry)) {
      injected.push({
        circuit_uid: entry.circuit_uid,
        name: entry.circuit_name,
        sse_adaptor_uid: entry.sse_adaptor_uid!,
      });
    } else if (!entry.adapters.includes("OPEN_AI_SSE")) {
      skipped.push({
        circuit_uid: entry.circuit_uid,
        name: entry.circuit_name,
        reason: "not SSE-compatible",
      });
    } else if (entry.sse_adaptor_uid === null) {
      skipped.push({
        circuit_uid: entry.circuit_uid,
        name: entry.circuit_name,
        reason: "no SSE adaptor",
      });
    }
  }

  return { injected, skipped };
}

/** Print install hints when the `opencode` binary is missing. */
function printInstallHint(): void {
  console.error("\n✗ opencode is not installed.\n");
  console.error("Install with one of:");
  for (const method of OPENCODE_INSTALL) {
    const detected = method.check() ? " (detected)" : "";
    console.error(`  ${method.label.padEnd(5)} ${method.cmd}${detected}`);
  }
  console.error("");
}

/** The OpenCode agent plugin. */
export const opencodeAgent: Agent = {
  name: "opencode",
  description: "Launch OpenCode with SSE circuits as model providers",
  binary: "opencode",
  installHints: OPENCODE_INSTALL.map((m) => `${m.label}: ${m.cmd}`),

  buildConfig(ctx: AgentContext): Record<string, string> {
    const defaultModel = resolveDefaultModel(ctx.config, ctx.state);
    const config = buildOpenCodeConfig(ctx.state, ctx.proxyPort, defaultModel);
    return {
      OPENCODE_CONFIG: JSON.stringify(config, null, 2),
    };
  },

  async launch(ctx: AgentContext, opts: LaunchOptions): Promise<LaunchResult> {
    // Resolve the opencode binary (prefer V2 for MCP 2.0 support).
    const resolved = resolveOpencodeBinary();
    if (opts.debug) {
      console.error(`[quack] resolved opencode binary: ${resolved ? resolved.bin + " (V" + (resolved.isV2 ? "2" : "1") + ")" : "null"}`);
    }
    if (!opts.print && !resolved) {
      printInstallHint();
      return { exitCode: 1, proxyPort: 0 };
    }

    // Open debug log file if --debug is set.
    let debugFd: number | undefined;
    let debugPath: string | undefined;
    if (opts.debug && !opts.print) {
      const path = await import("node:path");
      const fs = await import("node:fs");
      debugPath = path.join(process.cwd(), ".quack", "debug.log");
      // Truncate the file at start.
      try {
        fs.writeFileSync(debugPath, "");
        debugFd = fs.openSync(debugPath, "a");
      } catch {
        // If .quack/ doesn't exist, fall back to /tmp.
        debugPath = `/tmp/quack-debug-${Date.now()}.log`;
        fs.writeFileSync(debugPath, "");
        debugFd = fs.openSync(debugPath, "a");
      }
      process.stderr.write(`[quack] debug log: ${debugPath}\n`);
    }

    // Start the proxy.
    const proxy: ProxyHandle = await startProxy({
      apiBase: ctx.apiBase,
      getAccessToken: ctx.getAccessToken,
      refreshToken,
      onLog: (opts.verbose || opts.debug)
        ? (method, path, status) => {
            process.stderr.write(`[quack] ${method} ${path} → ${status}\n`);
          }
        : undefined,
      onDebug: opts.debug
        ? (entry: string) => {
            if (debugFd !== undefined) {
              fs.writeSync(debugFd, entry + "\n");
            }
          }
        : undefined,
    });

    if (opts.verbose || opts.debug) {
      process.stderr.write(
        `[quack] proxy listening on http://localhost:${proxy.port} → ${ctx.apiBase}\n`,
      );
    }

    // Build the config.
    const state = readState();
    const config = readConfig();
    const defaultModel = resolveDefaultModel(config, state);
    const openCodeConfig = buildOpenCodeConfig(state, proxy.port, defaultModel);
    const configJson = JSON.stringify(openCodeConfig, null, 2);
    const summary = summarizeInjection(state);

    if (opts.print) {
      console.log(`Proxy: http://localhost:${proxy.port} → ${ctx.apiBase}`);
      console.log("");
      console.log("Injected OpenCode config (OPENCODE_CONFIG):");
      console.log(configJson);
      console.log("");
      console.log(
        `Injected ${summary.injected.length} circuit(s) as OpenAI-compatible providers:`,
      );
      for (const c of summary.injected) {
        console.log(`  ✓ ${c.name} (${c.circuit_uid}) → ${c.sse_adaptor_uid}`);
      }
      if (summary.skipped.length > 0) {
        console.log(`Skipped ${summary.skipped.length} circuit(s):`);
        for (const c of summary.skipped) {
          console.log(`  ✗ ${c.name} (${c.circuit_uid}) — ${c.reason}`);
        }
      }
      proxy.close();
      return { exitCode: null, proxyPort: proxy.port };
    }

    // Write the config to a temp file and point OPENCODE_CONFIG at it.
    // V1's OPENCODE_CONFIG_CONTENT (inline JSON) works for simple top-level
    // overrides like `model`, but doesn't reliably deep-merge `mcp.servers`.
    // OPENCODE_CONFIG (file path, "custom-path" scope) is what the user's
    // own wrapper uses for full configs with MCP servers.
    //
    // The filename includes the quack version + timestamp to avoid any
    // config caching by file path.
    const configFile = path.join(
      os.tmpdir(),
      `quack-opencode-config-v${AGENT_VERSION}-${Date.now()}-${proxy.port}.json`,
    );
    fs.writeFileSync(configFile, configJson);

    // Spawn opencode with the config file path injected via env.
    // V2 uses a background service — pass --standalone so it runs a private
    // server that picks up OPENCODE_CONFIG fresh every launch.
    const spawnArgs = resolved?.isV2 ? ["--standalone", ...opts.args] : opts.args;
    const child = spawn(resolved!.bin, spawnArgs, {
      stdio: "inherit",
      env: {
        ...process.env,
        OPENCODE_CONFIG: configFile,
        QUACK_API_KEY: "quack",
      },
    });

    // Forward signals to opencode.
    const forwardSignal = (sig: NodeJS.Signals) => {
      if (!child.killed) child.kill(sig);
    };
    process.on("SIGINT", () => forwardSignal("SIGINT"));
    process.on("SIGTERM", () => forwardSignal("SIGTERM"));

    // Wait for opencode to exit, then close the proxy.
    const exitCode: number = await new Promise((resolve) => {
      child.on("exit", (code) => {
        resolve(code ?? 0);
      });
      child.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          printInstallHint();
        } else {
          console.error(`opencode failed to start: ${err.message}`);
        }
        resolve(1);
      });
    });

    // Clean up the temp config file.
    try {
      fs.unlinkSync(configFile);
    } catch {
      // Ignore cleanup errors.
    }

    proxy.close();

    // Close debug log file if open.
    if (debugFd !== undefined) {
      try {
        fs.closeSync(debugFd);
      } catch {
        // Ignore.
      }
    }

    return { exitCode, proxyPort: proxy.port };
  },
};
