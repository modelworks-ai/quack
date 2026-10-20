/**
 * OpenCode agent — injects SSE circuits as OpenAI-compatible providers
 * via `OPENCODE_CONFIG_CONTENT`, plus the global `modelworks` MCP server.
 *
 * @module
 */

import { spawn, spawnSync } from "node:child_process";

import { refreshToken } from "../auth.js";
import { readState } from "../project.js";
import { startProxy } from "../proxy.js";
import type {
  ProxyHandle,
  QuackState,
  CircuitStateEntry,
  OpenCodeConfig,
  OpenCodeMcpServer,
  OpenCodeProvider,
} from "../types.js";
import type { Agent, AgentContext, LaunchOptions, LaunchResult } from "./types.js";

/** `npm` package for OpenAI-compatible providers. */
const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

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

/** Build the OpenCode config from project state. */
export function buildOpenCodeConfig(state: QuackState, port: number): OpenCodeConfig {
  const proxyBase = `http://localhost:${port}`;

  const config: OpenCodeConfig = {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      servers: {
        "ModelWorks x.MCP": {
          type: "remote",
          url: `${proxyBase}/api/x.mcp`,
          oauth: false,
          protocol: "auto",
          // Dummy auth header — the proxy overrides it with the real
          // Bearer token. Without this, OpenCode sees no auth config and
          // prompts the user to authenticate ("MCP Authentication Required").
          headers: {
            Authorization: "Bearer quack",
          },
        },
      },
    },
    provider: {},
  };

  for (const entry of Object.values(state.circuits)) {
    if (!isInjectableSseCircuit(entry)) continue;

    const providerKey = `circuit-${entry.circuit_uid}`;
    const provider: OpenCodeProvider = {
      npm: OPENAI_COMPATIBLE_NPM,
      name: entry.circuit_name,
      options: {
        baseURL: `${proxyBase}/api/circuit-adaptors/${entry.sse_adaptor_uid}/query`,
        // Dummy apiKey — the proxy overrides the Authorization header.
        apiKey: "quack",
      },
      models: {
        [entry.circuit_uid]: { name: entry.circuit_name },
      },
    };
    config.provider![providerKey] = provider;
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
    const config = buildOpenCodeConfig(ctx.state, ctx.proxyPort);
    return {
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config, null, 2),
    };
  },

  async launch(ctx: AgentContext, opts: LaunchOptions): Promise<LaunchResult> {
    // Check the binary before doing anything else.
    if (!opts.print && !hasBinary("opencode")) {
      printInstallHint();
      return { exitCode: 1, proxyPort: 0 };
    }

    // Start the proxy.
    const proxy: ProxyHandle = await startProxy({
      apiBase: ctx.apiBase,
      getAccessToken: ctx.getAccessToken,
      refreshToken,
      onLog: opts.verbose
        ? (method, path, status) => {
            process.stderr.write(`[quack] ${method} ${path} → ${status}\n`);
          }
        : undefined,
    });

    if (opts.verbose) {
      process.stderr.write(
        `[quack] proxy listening on http://localhost:${proxy.port} → ${ctx.apiBase}\n`,
      );
    }

    // Build the config.
    const state = readState();
    const config = buildOpenCodeConfig(state, proxy.port);
    const configJson = JSON.stringify(config, null, 2);
    const summary = summarizeInjection(state);

    if (opts.print) {
      console.log(`Proxy: http://localhost:${proxy.port} → ${ctx.apiBase}`);
      console.log("");
      console.log("Injected OpenCode config (OPENCODE_CONFIG_CONTENT):");
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

    // Spawn opencode with the config injected via env.
    const child = spawn("opencode", opts.args, {
      stdio: "inherit",
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: configJson,
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

    proxy.close();
    return { exitCode, proxyPort: proxy.port };
  },
};
