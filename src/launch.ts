/**
 * Launch opencode: start the proxy, build the config, spawn opencode,
 * and clean up on exit. Also detects the missing `opencode` binary and
 * prints install hints for detected package managers.
 *
 * @module
 */

import { spawn, spawnSync } from "node:child_process";

import { refreshToken } from "./auth.js";
import { buildOpenCodeConfig, summarizeInjection } from "./config.js";
import { readState } from "./project.js";
import { startProxy } from "./proxy.js";
import type { ProxyHandle } from "./types.js";

/** Detect whether a binary is on PATH (`which`/`where`). */
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

/** Print install hints when the `opencode` binary is missing. */
export function printInstallHint(): void {
  console.error("\n✗ opencode is not installed.\n");
  console.error("Install with one of:");
  for (const method of OPENCODE_INSTALL) {
    const detected = method.check() ? " (detected)" : "";
    console.error(`  ${method.label.padEnd(5)} ${method.cmd}${detected}`);
  }
  console.error("");
}

/** Options for {@link launchOpenCode}. */
export interface LaunchOptions {
  /** Upstream API base URL, e.g. `https://modelworks.ai`. */
  apiBase: string;
  /** Access token getter (returns the current token). */
  getAccessToken: () => string;
  /** Args to forward to opencode (e.g. a working directory). */
  args?: string[];
  /** If true, log proxy requests to stderr. */
  verbose?: boolean;
  /** If true, print the config + proxy info and exit without launching. */
  print?: boolean;
}

/** Result of a launch. `exitCode` is null if `--print` was used. */
export interface LaunchResult {
  exitCode: number | null;
  proxyPort: number;
}

/**
 * Start the proxy, build the opencode config, and spawn opencode.
 *
 * On `--print`: start the proxy, print the config + injection summary,
 * close the proxy, and return without spawning.
 *
 * On normal launch: spawn opencode with `OPENCODE_CONFIG_CONTENT` set
 * and `stdio: "inherit"`. When opencode exits, close the proxy and
 * return its exit code. Signals (SIGINT/SIGTERM) are forwarded.
 */
export async function launchOpenCode(opts: LaunchOptions): Promise<LaunchResult> {
  // Check the opencode binary before doing anything else.
  if (!opts.print && !hasBinary("opencode")) {
    printInstallHint();
    return { exitCode: 1, proxyPort: 0 };
  }

  // Start the proxy.
  const proxy: ProxyHandle = await startProxy({
    apiBase: opts.apiBase,
    getAccessToken: opts.getAccessToken,
    refreshToken,
    onLog: opts.verbose
      ? (method, path, status) => {
          process.stderr.write(`[quack] ${method} ${path} → ${status}\n`);
        }
      : undefined,
  });

  if (opts.verbose) {
    process.stderr.write(`[quack] proxy listening on http://localhost:${proxy.port} → ${opts.apiBase}\n`);
  }

  // Build the config.
  const state = readState();
  const config = buildOpenCodeConfig(state, proxy.port);
  const configJson = JSON.stringify(config, null, 2);
  const summary = summarizeInjection(state);

  if (opts.print) {
    console.log(`Proxy: http://localhost:${proxy.port} → ${opts.apiBase}`);
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
  const child = spawn("opencode", opts.args ?? [], {
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
}
