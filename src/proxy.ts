/**
 * Local HTTP reverse proxy.
 *
 * Forwards every request to the same path on `apiBase`, injecting
 * `Authorization: Bearer <token>` and streaming the response body.
 * On 401, refreshes the access token and retries once.
 *
 * @module
 */

import http from "node:http";
import { Readable } from "node:stream";

import type { ProxyHandle, ProxyOptions } from "./types.js";

/**
 * Start a local HTTP reverse proxy on a random port (`127.0.0.1`).
 *
 * Resolves with a handle containing the assigned port and a `close()`
 * method. The proxy lives for as long as quack runs; `launch.ts` closes
 * it when the spawned opencode process exits.
 */
export function startProxy(opts: ProxyOptions): Promise<ProxyHandle> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const targetUrl = new URL(req.url ?? "/", opts.apiBase);

        // Read the full request body before forwarding (needed for 401 retry).
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = chunks.length > 0 ? Buffer.concat(chunks) : null;

        // Build forwarded headers — strip client auth + host, inject our own.
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          const lower = key.toLowerCase();
          if (lower === "authorization" || lower === "host") continue;
          headers[key] = Array.isArray(value) ? value.join(", ") : value ?? "";
        }
        headers.authorization = `Bearer ${opts.getAccessToken()}`;
        headers.host = targetUrl.host;

        // Forward request.
        let upstream = await fetch(targetUrl, {
          method: req.method,
          headers,
          body: body ?? undefined,
        });

        // Token refresh on 401 — retry once.
        if (upstream.status === 401) {
          const refreshed = await opts.refreshToken();
          if (refreshed) {
            headers.authorization = `Bearer ${opts.getAccessToken()}`;
            upstream = await fetch(targetUrl, {
              method: req.method,
              headers,
              body: body ?? undefined,
            });
          }
        }

        // Forward response status + headers.
        res.statusCode = upstream.status;
        for (const [key, value] of upstream.headers) {
          res.setHeader(key, value);
        }

        // Stream the response body (SSE, NDJSON, JSON).
        // Cast: `@types/node`'s `Readable.fromWeb` and the global
        // `ReadableStream` from `fetch` have structurally incompatible
        // `pipeThrough` types. Runtime is correct.
        if (upstream.body) {
          Readable.fromWeb(upstream.body as never).pipe(res);
        } else {
          res.end();
        }

        opts.onLog?.(req.method ?? "?", targetUrl.pathname, upstream.status);
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: "proxy_error",
              message: (err as Error).message,
            }),
          );
        }
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "object" && !("port" in addr)) {
        reject(new Error("Could not bind proxy port"));
        return;
      }
      const port = (addr as { port: number }).port;
      resolve({ port, close: () => server.close() });
    });

    server.on("error", reject);
  });
}
