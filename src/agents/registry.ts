/**
 * Agent registry — lists all built-in agents.
 *
 * Adding a new agent: create `src/agents/<name>.ts` exporting an
 * `AgentPlugin`, then add it to the `BUILTIN_AGENTS` array below.
 * It will automatically appear in `quack agents list` and become
 * available as `quack <name>`.
 *
 * @module
 */

import type { Agent } from "./types.js";
import { opencodeAgent } from "./opencode.js";

/** All agents built into this version of quack. */
export const BUILTIN_AGENTS: Agent[] = [
  opencodeAgent,
];

/** Look up an agent by name. Returns `undefined` if not found. */
export function getAgent(name: string): Agent | undefined {
  return BUILTIN_AGENTS.find((a) => a.name === name);
}

/** List all built-in agents. */
export function listAgents(): Agent[] {
  return BUILTIN_AGENTS;
}
