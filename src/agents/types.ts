/**
 * Agent plugin interface.
 *
 * An agent is a tool that quack can launch with ModelWorks circuits
 * wired in (e.g. OpenCode, Cursor, Claude Code). Agents are built into
 * quack — no external installation. New agents appear automatically
 * when quack is updated.
 *
 * @module
 */

import type { QuackConfig, QuackState } from "../types.js";

/** Options passed to {@link Agent.buildConfig} and {@link Agent.launch}. */
export interface AgentContext {
  /** The local proxy port (requests to the proxy get auth injected). */
  proxyPort: number;
  /** Upstream API base URL, e.g. `https://modelworks.ai`. */
  apiBase: string;
  /** Returns the current (possibly-refreshed) access token. */
  getAccessToken: () => string;
  /** The project's cached state (circuits, adaptors, versions). */
  state: QuackState;
  /** The project's committable config (default_agent, default_circuit, circuits). */
  config: QuackConfig;
}

/** Options for {@link Agent.launch}. */
export interface LaunchOptions {
  /** Args to forward to the agent binary. */
  args: string[];
  /** If true, log proxy requests to stderr. */
  verbose: boolean;
  /** If true, log full proxy request/response details to .quack/debug.log. */
  debug: boolean;
  /** If true, print the config and exit without launching. */
  print: boolean;
}

/** Result of a launch. `exitCode` is null if `--print` was used. */
export interface LaunchResult {
  exitCode: number | null;
  proxyPort: number;
}

/** A built-in agent plugin. */
export interface Agent {
  /** Short name used as the `quack <name>` command (e.g. `"opencode"`). */
  name: string;
  /** One-line description shown in `quack agents list`. */
  description: string;
  /** The binary name to look for on PATH (e.g. `"opencode"`). */
  binary: string;
  /** Install hint lines shown when the binary is missing. */
  installHints: string[];

  /**
   * Build the tool-specific config/env from the project state.
   * Returns env vars to inject when spawning the agent.
   */
  buildConfig(ctx: AgentContext): Record<string, string>;

  /**
   * Start the proxy (already started by the caller), build the config,
   * and spawn the agent. On `--print`, print the config and return
   * without spawning.
   */
  launch(ctx: AgentContext, opts: LaunchOptions): Promise<LaunchResult>;
}
