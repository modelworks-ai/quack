/**
 * Agent registry — lists all built-in agents and resolves which one
 * to launch when the user runs bare `quack` (no args).
 *
 * Adding a new agent: create `src/agents/<name>.ts` exporting an
 * `Agent`, then add it to the `BUILTIN_AGENTS` array below. It will
 * automatically appear in `quack agents list` and become available
 * as `quack <name>`.
 *
 * @module
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";

import type { Agent } from "./types.js";
import { opencodeAgent } from "./opencode.js";

/** All agents built into this version of quack. */
export const BUILTIN_AGENTS: Agent[] = [
  opencodeAgent,
];

/** Detect whether a binary is on PATH. */
export function hasBinary(bin: string): boolean {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(cmd, [bin], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Check if a file exists and is executable at a specific path. */
export function hasBinaryAt(binPath: string): boolean {
  try {
    accessSync(binPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Is this agent's binary installed (on PATH or at a known location)? */
export function isAgentAvailable(agent: Agent): boolean {
  // opencode: check both V2 (opencode2) and V1 (opencode)
  if (agent.name === "opencode") {
    if (hasBinary("opencode2")) return true;
    const home = process.env.HOME ?? "";
    if (home && hasBinaryAt(`${home}/.opencode/bin/opencode2`)) return true;
    if (hasBinary("opencode")) return true;
    return false;
  }
  return hasBinary(agent.binary);
}

/** List all built-in agents. */
export function listAgents(): Agent[] {
  return BUILTIN_AGENTS;
}

/** Look up an agent by name. Returns `undefined` if not found. */
export function getAgent(name: string): Agent | undefined {
  return BUILTIN_AGENTS.find((a) => a.name === name);
}

/** List agents whose binary is installed on PATH. */
export function listAvailableAgents(): Agent[] {
  return BUILTIN_AGENTS.filter(isAgentAvailable);
}

/** Whether stdin is an interactive TTY (for the picker prompt). */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true;
}

/**
 * Result of resolving which agent to launch for bare `quack`.
 *
 * - `agent` — the resolved agent (binary is installed).
 * - `error` — resolution failed; `message` explains what to do.
 */
export type ResolveResult =
  | { ok: true; agent: Agent }
  | { ok: false; message: string };

/**
 * Resolve which agent to launch for bare `quack`.
 *
 * Resolution order:
 *  1. `default_agent` from config.json — validate + availability check
 *  2. `last_agent` from state.json — validate + availability check
 *  3. Interactive picker (if TTY) — shows installed agents to pick from
 *  4. Non-interactive — error with guidance
 *
 * `available`/`last` are caller-provided to keep this function pure
 * (no file I/O). The caller reads config/state and passes the values.
 */
export function resolveAgent(
  defaultAgent: string | undefined,
  lastAgent: string | undefined,
): ResolveResult {
  // 1. config.json default_agent
  if (defaultAgent) {
    const agent = getAgent(defaultAgent);
    if (!agent) {
      return {
        ok: false,
        message: `Default agent "${defaultAgent}" is not a known agent. Supported: ${BUILTIN_AGENTS.map((a) => a.name).join(", ")}. Fix .quack/config.json.`,
      };
    }
    if (!isAgentAvailable(agent)) {
      return {
        ok: false,
        message: `Default agent "${defaultAgent}" is not installed. Install it, or change "default_agent" in .quack/config.json to an installed agent.\n\nSupported agents: ${BUILTIN_AGENTS.map((a) => `  ${a.name} (${a.binary})`).join("\n")}`,
      };
    }
    return { ok: true, agent };
  }

  // 2. state.json last_agent
  if (lastAgent) {
    const agent = getAgent(lastAgent);
    if (agent && isAgentAvailable(agent)) {
      return { ok: true, agent };
    }
    // Fall through to picker if last_agent is gone/uninstalled.
  }

  // 3. Interactive picker — only if TTY
  const available = listAvailableAgents();
  if (available.length === 0) {
    return {
      ok: false,
      message: `No supported agent is installed. Install one of:\n${BUILTIN_AGENTS.map((a) => `  ${a.name} (${a.binary})`).join("\n")}`,
    };
  }

  if (!isInteractive()) {
    // Non-interactive: if exactly one agent is available, use it.
    if (available.length === 1) {
      return { ok: true, agent: available[0] };
    }
    return {
      ok: false,
      message: `No default agent set and multiple are installed. Set "default_agent" in .quack/config.json to one of: ${available.map((a) => a.name).join(", ")}.`,
    };
  }

  // Interactive with one available agent — just use it (no pointless prompt).
  if (available.length === 1) {
    return { ok: true, agent: available[0] };
  }

  // Interactive with multiple — will be handled by the caller's prompt.
  // Signal that a prompt is needed.
  return { ok: false, message: "__PROMPT__" };
}
