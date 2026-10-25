/**
 * Run history — save and list circuit run records locally.
 *
 * After each circuit request through the proxy, the run UID (from the
 * `X-Circuit-Run-Uid` response header) is used to fetch the full run
 * record from the API and save it as a JSON file under `.quack/runs/`.
 * These files are committed to the repo (team-shared).
 *
 * @module
 */

import fs from "node:fs";
import path from "node:path";

import type { Credentials, RunRecord, CircuitStateEntry } from "./types.js";
import { quackDir } from "./project.js";

/** Path to `.quack/runs/` directory. */
export function runsDir(): string {
  return path.join(quackDir(), "runs");
}

/** Path to a single run file. */
export function runFilePath(runUid: string): string {
  return path.join(runsDir(), `${runUid}.json`);
}

/**
 * Fetch a circuit run record from the API and map it to a `RunRecord`.
 *
 * Retries up to 3 times with a 500ms delay if the run hasn't reached a
 * terminal state (COMPLETED/EXCEPTION/FAILED) — the engine might not
 * have finalized the DB record the instant the stream ends.
 */
export async function fetchRunFromApi(
  runUid: string,
  credentials: Credentials,
  stateCircuits: Record<string, CircuitStateEntry>,
  callerUsername: string,
): Promise<RunRecord | null> {
  const base = credentials.api_base;
  const token = credentials.access_token;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${base}/api/circuit-runs/${runUid}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        if (attempt < 2) {
          await sleep(500);
          continue;
        }
        return null;
      }

      const body = (await res.json()) as { payload?: Record<string, unknown> };
      const run = body.payload;
      if (!run) return null;

      const state = (run.state as string) ?? "UNKNOWN";
      const terminal = ["COMPLETED", "Completed", "EXCEPTION", "FAILED"];
      if (!terminal.includes(state) && attempt < 2) {
        await sleep(500);
        continue;
      }

      const circuitUid = (run.circuit_uid as string) ?? "";
      const versionUid = (run.circuit_version_uid as string) ?? "";
      const createdAt = (run.created_at as string) ?? "";
      const endedAt = (run.ended_at as string) ?? "";

      // Parse result_blob for cost/tokens/duration.
      const resultBlob = run.result_blob as Record<string, unknown> | null;
      let costCredits: number | null = null;
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      let durationMs: number | null = null;

      if (resultBlob) {
        const billingEntries = resultBlob.billing_entries as Array<Record<string, unknown>> | undefined;
        if (billingEntries && billingEntries.length > 0) {
          costCredits = (billingEntries[0].cost as number) ?? null;
          inputTokens = (billingEntries[0].total_input_tokens as number) ?? null;
          outputTokens = (billingEntries[0].total_output_tokens as number) ?? null;
        }
        const perfReports = resultBlob.performance_reports as Record<string, Record<string, unknown>> | undefined;
        if (perfReports) {
          // Take the first performance report's time_taken.
          const firstKey = Object.keys(perfReports)[0];
          if (firstKey) {
            durationMs = (perfReports[firstKey].time_taken as number) ?? null;
          }
        }
      }

      // Resolve circuit_name and owner_username from state.
      const stateEntry = stateCircuits[circuitUid];
      const circuitName = stateEntry?.circuit_name ?? circuitUid;
      const ownerUsername = stateEntry?.owner_username ?? "";

      return {
        run_uid: runUid,
        circuit_uid: circuitUid,
        circuit_name: circuitName,
        owner_username: ownerUsername,
        caller_username: callerUsername,
        version_uid: versionUid,
        status: state,
        created_at: createdAt,
        completed_at: endedAt,
        duration_ms: durationMs,
        cost_credits: costCredits,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      };
    } catch {
      if (attempt < 2) {
        await sleep(500);
        continue;
      }
      return null;
    }
  }

  return null;
}

/** Save a run record to `.quack/runs/cr-xxx.json`. */
export function saveRunRecord(record: RunRecord): void {
  const dir = runsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    runFilePath(record.run_uid),
    JSON.stringify(record, null, 2) + "\n",
  );
}

/**
 * List all run records, sorted by `created_at` descending.
 *
 * Reads every `*.json` file in `.quack/runs/` and parses them.
 * Returns an empty array if the directory doesn't exist.
 */
export function listRunRecords(): RunRecord[] {
  const dir = runsDir();
  if (!fs.existsSync(dir)) return [];

  const records: RunRecord[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf8");
      records.push(JSON.parse(raw) as RunRecord);
    } catch {
      // Skip malformed files.
    }
  }

  records.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return records;
}

/** Get a single run record by UID, or `null` if not found. */
export function getRunRecord(runUid: string): RunRecord | null {
  const file = runFilePath(runUid);
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw) as RunRecord;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
