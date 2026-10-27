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
import fs from "node:fs";
import path from "node:path";
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
      const startTime = Date.now();
      // Flush debug lines immediately so we see them even if the request hangs.
      const debug = (line: string) => {
        if (opts.onDebug) opts.onDebug(line);
      };

      // TCP-level connection log — fires for EVERY request, even before
      // HTTP parsing. This tells us if the request reached the proxy at all.
      const tcpLine = `[tcp] ${new Date().toISOString()} ${req.method} ${req.url} from ${req.socket.remoteAddress}:${req.socket.remotePort}`;
      if (opts.onDebug) {
        opts.onDebug(tcpLine);
      }
      // Always log to a file so we can diagnose even without --debug.
      try {
        fs.appendFileSync(
          path.join(process.cwd(), ".quack", "proxy.log"),
          tcpLine + "\n",
        );
      } catch { /* cwd may not have .quack */ }

      try {
        const targetUrl = new URL(req.url ?? "/", opts.apiBase);

        // Debug: log incoming request immediately (before body reading).
        debug(`=== ${new Date().toISOString()} ===`);
        debug(`${req.method} ${req.url}`);
        debug(`→ forwarded to ${targetUrl.href}`);
        debug(`content-length: ${req.headers["content-length"] ?? "(none)"}`);
        debug(`transfer-encoding: ${req.headers["transfer-encoding"] ?? "(none)"}`);

        // Read the full request body before forwarding (needed for 401 retry).
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let body = chunks.length > 0 ? Buffer.concat(chunks) : null;
        debug(`body read: ${body ? body.length + " bytes" : "(empty)"}`);

        // Strip output token limits from circuit adaptor query requests.
        //
        // OpenCode's openai-compatible provider sends a low default output
        // token limit (~100-128). Reasoning models like DeepSeek V4.1 Flash
        // spend this budget on reasoning before producing content, resulting
        // in empty responses. The circuit's own max_tokens input defaults to
        // null (model maximum), so removing the field lets the upstream API
        // use its own sensible default.
        //
        // Different SDKs use different field names for the same concept:
        // - OpenAI Chat Completions API: max_tokens / max_completion_tokens
        // - AI SDK: maxOutputTokens
        // We strip all known variants.
        const isAdaptorQuery =
          req.method === "POST" &&
          /\/api\/circuit-adaptors\/[^/]+\/query/.test(req.url ?? "");
        if (isAdaptorQuery && body) {
          try {
            const parsed = JSON.parse(body.toString("utf8"));
            let stripped = false;
            for (const key of [
              "max_tokens",
              "max_completion_tokens",
              "max_output_tokens",
              "maxOutputTokens",
            ]) {
              if (key in parsed) {
                delete parsed[key];
                stripped = true;
              }
            }
            if (stripped) {
              body = Buffer.from(JSON.stringify(parsed), "utf8");
              debug(`stripped output token limit from request body`);
            }
          } catch {
            // Not JSON or malformed — forward as-is.
          }
        }

        // Build forwarded headers — strip client auth + host, inject our own.
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          const lower = key.toLowerCase();
          if (lower === "authorization" || lower === "host") continue;
          headers[key] = Array.isArray(value) ? value.join(", ") : value ?? "";
        }
        headers.authorization = `Bearer ${opts.getAccessToken()}`;
        headers.host = targetUrl.host;
        // Update content-length if we modified the body.
        if (body !== null) headers["content-length"] = String(body.length);

        if (opts.onDebug) {
          debug(`--- request headers (incoming) ---`);
          for (const [k, v] of Object.entries(req.headers)) {
            const val = Array.isArray(v) ? v.join(", ") : v ?? "";
            // Mask the real token in the debug log.
            const masked = k.toLowerCase() === "authorization"
              ? `Bearer ${val.slice(7, 12)}...`
              : val;
            debug(`  ${k}: ${masked}`);
          }
          debug(`--- request body ---`);
          debug(body ? body.toString("utf8").slice(0, 2000) : "(empty)");
        }

        // Forward request.
        let upstream = await fetch(targetUrl, {
          method: req.method,
          headers,
          body: body ?? undefined,
        });

        // Token refresh on 401 — retry once.
        if (upstream.status === 401) {
          debug(`--- 401 received, refreshing token and retrying ---`);
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
          // Rewrite content-type for circuit adaptor SSE responses.
          // The API returns `application/stream+json` but OpenCode's
          // openai-compatible provider expects `text/event-stream` to
          // parse SSE chunks. Without this, the provider doesn't
          // recognize the stream and the response appears empty.
          if (
            key.toLowerCase() === "content-type" &&
            isAdaptorQuery &&
            value.includes("application/stream+json")
          ) {
            res.setHeader(key, "text/event-stream; charset=utf-8");
            continue;
          }
          res.setHeader(key, value);
        }

        // Capture the circuit run UID for history saving.
        const runUid = upstream.headers.get("x-circuit-run-uid");
        const onRunComplete = opts.onRunComplete;

        // Always log response status + content-type for diagnosis.
        const respContentType = upstream.headers.get("content-type") ?? "(none)";
        try {
          fs.appendFileSync(
            path.join(process.cwd(), ".quack", "proxy.log"),
            `[resp] ${upstream.status} ${respContentType} (${Date.now() - startTime}ms) run=${runUid ?? "none"}\n`,
          );
        } catch { /* ignore */ }

        if (opts.onDebug) {
          const elapsed = Date.now() - startTime;
          debug(`--- response ${upstream.status} (${elapsed}ms) ---`);
          debug(`--- response headers ---`);
          for (const [k, v] of upstream.headers) {
            debug(`  ${k}: ${v}`);
          }
        }

        // Stream the response body (SSE, NDJSON, JSON).
        // Cast: `@types/node`'s `Readable.fromWeb` and the global
        // `ReadableStream` from `fetch` have structurally incompatible
        // `pipeThrough` types. Runtime is correct.
        if (upstream.body) {
          if (opts.onDebug) {
            // Capture streamed body for debug logging.
            let bodyBytes = 0;
            const decoder = new TextDecoder();
            let debugBody = "";
            const reader = upstream.body.getReader();
            const pump = async () => {
              try {
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  bodyBytes += value.length;
                  if (debugBody.length < 2000) {
                    debugBody += decoder.decode(value, { stream: true });
                  }
                  res.write(value);
                }
                res.end();
              } catch (err) {
                debug(`--- stream error: ${(err as Error).message} ---`);
                if (!res.writableEnded) res.end();
              }
              debug(`--- response body (${bodyBytes} bytes) ---`);
              debug(debugBody.slice(0, 2000) + (bodyBytes > 2000 ? "..." : ""));
              const totalMs = Date.now() - startTime;
              debug(`=== END ${req.method} ${req.url} ${upstream.status} (${totalMs}ms) ===\n`);
              // Fire-and-forget: save run history after stream completes.
              if (runUid && onRunComplete) onRunComplete(runUid);
            };
            pump();
          } else {
            const reader = upstream.body.getReader();
            const pumpPlain = async () => {
              try {
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  res.write(value);
                }
                res.end();
              } catch {
                if (!res.writableEnded) res.end();
              }
              // Fire-and-forget: save run history after stream completes.
              if (runUid && onRunComplete) onRunComplete(runUid);
            };
            pumpPlain();
          }
        } else {
          res.end();
          if (opts.onDebug) {
            debug(`--- response body (empty) ---`);
            const totalMs = Date.now() - startTime;
            debug(`=== END ${req.method} ${req.url} ${upstream.status} (${totalMs}ms) ===\n`);
          }
          // Fire-and-forget: save run history even for empty-body responses.
          if (runUid && onRunComplete) onRunComplete(runUid);
        }

        opts.onLog?.(req.method ?? "?", targetUrl.pathname, upstream.status);
      } catch (err) {
        debug(`--- proxy error: ${(err as Error).message} ---`);
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
