/**
 * Shared test helpers: temp directories, mock fetch, mock credentials.
 *
 * @module
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Create a unique temp dir and `chdir` into it. Returns a cleanup function. */
export function withTempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-test-"));
  const prev = process.cwd();
  process.chdir(dir);
  return {
    dir,
    cleanup: () => {
      process.chdir(prev);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Point `XDG_CONFIG_HOME` at a temp dir and return a cleanup function.
 * Used to isolate credential/client storage.
 */
export function withTempConfigHome(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-xdg-"));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  return {
    dir,
    cleanup: () => {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A single mocked fetch response. */
export interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
}

/**
 * Install a mock `global.fetch` that returns canned responses keyed by
 * `${method} ${path}`. Unmatched requests throw.
 *
 * Returns the mock (with a `.calls` log) and a cleanup function.
 */
export function mockFetch(
  routes: Record<string, MockResponse | ((req: Request) => MockResponse)>,
): {
  calls: Array<{ method: string; url: string; body?: string }>;
  cleanup: () => void;
} {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const key = `${req.method} ${new URL(req.url).pathname}`;
    const route = routes[key];
    if (!route) {
      throw new Error(`mock fetch: no route for ${key}`);
    }
    const res = typeof route === "function" ? route(req) : route;
    const bodyText =
      res.json !== undefined ? JSON.stringify(res.json) : (res.body ?? "");
    calls.push({
      method: req.method,
      url: req.url,
      body: init?.body?.toString(),
    });
    return new Response(bodyText, {
      status: res.status ?? 200,
      headers: res.headers ?? { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return {
    calls,
    cleanup: () => {
      globalThis.fetch = original;
    },
  };
}

/** Write a `.quack/` project with the given config + state. */
export function writeProject(
  config: unknown,
  state?: unknown,
): { dir: string; cleanup: () => void } {
  const { dir, cleanup } = withTempDir();
  fs.mkdirSync(".quack", { recursive: true });
  fs.writeFileSync(".quack/config.json", JSON.stringify(config, null, 2));
  if (state !== undefined) {
    fs.writeFileSync(".quack/state.json", JSON.stringify(state, null, 2));
  }
  return { dir, cleanup };
}
