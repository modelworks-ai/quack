/**
 * Builds the OpenCode config injected via `OPENCODE_CONFIG_CONTENT`.
 *
 * Only SSE-compatible circuits become providers; all circuits are
 * reachable as tools via the global `modelworks` MCP server. All URLs
 * point to the local proxy — no secrets in the config.
 *
 * @module
 */

import type {
  CircuitStateEntry,
  OpenCodeConfig,
  QuackState,
} from "./types.js";

/** `npm` package for OpenAI-compatible providers. */
const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

/**
 * Build the OpenCode config from project state.
 *
 * @param state   The project's cached state.
 * @param port    The local proxy port.
 * @param apiBase The upstream API base (for constructing the `modelworks` MCP URL).
 * @returns The OpenCode config to inject via `OPENCODE_CONFIG_CONTENT`.
 */
export function buildOpenCodeConfig(
  state: QuackState,
  port: number,
): OpenCodeConfig {
  const proxyBase = `http://localhost:${port}`;

  const config: OpenCodeConfig = {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      servers: {
        modelworks: {
          type: "remote",
          url: `${proxyBase}/api/x.mcp`,
          oauth: false,
          protocol: "auto",
        },
      },
    },
    provider: {},
  };

  for (const entry of Object.values(state.circuits)) {
    if (!isInjectableSseCircuit(entry)) continue;

    const providerKey = `circuit-${entry.circuit_uid}`;
    config.provider![providerKey] = {
      npm: OPENAI_COMPATIBLE_NPM,
      name: entry.circuit_name,
      options: {
        baseURL: `${proxyBase}/api/circuit-adaptors/${entry.sse_adaptor_uid}/query`,
        // Dummy apiKey — the proxy overrides the Authorization header.
        // The SDK requires a non-empty apiKey to send the header at all.
        apiKey: "quack",
      },
      models: {
        [entry.circuit_uid]: { name: entry.circuit_name },
      },
    };
  }

  return config;
}

/** Should this circuit be injected as an OpenAI-compatible provider? */
function isInjectableSseCircuit(entry: CircuitStateEntry): boolean {
  return (
    entry.adapters.includes("OPEN_AI_SSE") && entry.sse_adaptor_uid !== null
  );
}

/** Describe the injection decision for `--print` output. */
export interface InjectionSummary {
  injected: Array<{ circuit_uid: string; name: string; sse_adaptor_uid: string }>;
  skipped: Array<{ circuit_uid: string; name: string; reason: string }>;
}

/** Summarize which circuits were injected vs skipped, for `--print`. */
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
