/**
 * Generate build info (version, build number, git commit, timestamp).
 *
 * Writes `src/build-info.json` which is imported by `bin.ts` and
 * `agents/opencode.ts` at runtime. Run automatically by the `build`
 * and `prebuild` npm scripts.
 *
 * @module
 */

import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function gitCommit() {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function gitCommitLong() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function gitDirty() {
  try {
    return execSync("git status --porcelain", { encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
}

const now = new Date();
const buildNumber = now.toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDHHmmss
const commit = gitCommit();
const commitLong = gitCommitLong();
const dirty = gitDirty();

const info = {
  version: "0.2.0",
  build: buildNumber,
  commit,
  commitLong,
  dirty,
  builtAt: now.toISOString(),
};

const outPath = resolve(__dirname, "..", "src", "build-info.json");
writeFileSync(outPath, JSON.stringify(info, null, 2) + "\n");
console.log(`build-info: v${info.version}+${info.build} (${info.commit}${info.dirty ? "-dirty" : ""})`);
