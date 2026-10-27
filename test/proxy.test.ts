/**
 * Tests for proxy.ts: start a real proxy + mock upstream, verify forwarding,
 * auth injection, streaming, and 401 refresh.
 *
 * @module
 */

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { startProxy } from "../src/proxy.js";

/** Start a mock upstream server that records requests. */
function startUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        close: () => server.close(),
      });
    });
    server.on("error", reject);
  });
}

test("proxy: forwards GET request and injects Authorization header", async () => {
  let receivedAuth = "";
  const upstream = await startUpstream((req, res) => {
    receivedAuth = req.headers.authorization ?? "";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });

  try {
    const proxy = await startProxy({
      apiBase: `http://localhost:${upstream.port}`,
      getAccessToken: () => "test-token-123",
      refreshToken: async () => false,
    });

    try {
      const res = await fetch(`http://localhost:${proxy.port}/api/test`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body, { ok: true });
      assert.equal(receivedAuth, "Bearer test-token-123");
    } finally {
      proxy.close();
    }
  } finally {
    upstream.close();
  }
});

test("proxy: strips client Authorization header and uses its own", async () => {
  let receivedAuth = "";
  const upstream = await startUpstream((req, res) => {
    receivedAuth = req.headers.authorization ?? "";
    res.end("ok");
  });

  try {
    const proxy = await startProxy({
      apiBase: `http://localhost:${upstream.port}`,
      getAccessToken: () => "proxy-token",
      refreshToken: async () => false,
    });

    try {
      await fetch(`http://localhost:${proxy.port}/api/test`, {
        headers: { authorization: "Bearer client-token-should-be-stripped" },
      });
      assert.equal(receivedAuth, "Bearer proxy-token");
    } finally {
      proxy.close();
    }
  } finally {
    upstream.close();
  }
});

test("proxy: forwards POST body", async () => {
  let receivedBody = "";
  const upstream = await startUpstream((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      receivedBody = data;
      res.end("ok");
    });
  });

  try {
    const proxy = await startProxy({
      apiBase: `http://localhost:${upstream.port}`,
      getAccessToken: () => "tok",
      refreshToken: async () => false,
    });

    try {
      await fetch(`http://localhost:${proxy.port}/api/test`, {
        method: "POST",
        body: JSON.stringify({ message: "hello" }),
        headers: { "content-type": "application/json" },
      });
      assert.equal(receivedBody, '{"message":"hello"}');
    } finally {
      proxy.close();
    }
  } finally {
    upstream.close();
  }
});

test("proxy: strips max_tokens from circuit adaptor query requests", async () => {
  let receivedBody = "";
  const upstream = await startUpstream((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      receivedBody = data;
      res.end("ok");
    });
  });

  try {
    const proxy = await startProxy({
      apiBase: `http://localhost:${upstream.port}`,
      getAccessToken: () => "tok",
      refreshToken: async () => false,
    });

    try {
      await fetch(
        `http://localhost:${proxy.port}/api/circuit-adaptors/ca-test/query/chat/completions`,
        {
          method: "POST",
          body: JSON.stringify({
            model: "c-test",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
            max_tokens: 100,
          }),
          headers: { "content-type": "application/json" },
        },
      );
      const parsed = JSON.parse(receivedBody);
      assert.equal("max_tokens" in parsed, false, "max_tokens should be stripped");
      assert.equal(parsed.model, "c-test");
      assert.equal(parsed.stream, true);
    } finally {
      proxy.close();
    }
  } finally {
    upstream.close();
  }
});

test("proxy: does not strip max_tokens from non-adaptor requests", async () => {
  let receivedBody = "";
  const upstream = await startUpstream((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      receivedBody = data;
      res.end("ok");
    });
  });

  try {
    const proxy = await startProxy({
      apiBase: `http://localhost:${upstream.port}`,
      getAccessToken: () => "tok",
      refreshToken: async () => false,
    });

    try {
      await fetch(`http://localhost:${proxy.port}/api/test`, {
        method: "POST",
        body: JSON.stringify({ max_tokens: 100, message: "hi" }),
        headers: { "content-type": "application/json" },
      });
      const parsed = JSON.parse(receivedBody);
      assert.equal(parsed.max_tokens, 100, "max_tokens should NOT be stripped");
    } finally {
      proxy.close();
    }
  } finally {
    upstream.close();
  }
});

test("proxy: refreshes token on 401 and retries", async () => {
  let requestCount = 0;
  let receivedAuth = "";
  const upstream = await startUpstream((req, res) => {
    requestCount++;
    receivedAuth = req.headers.authorization ?? "";
    if (requestCount === 1) {
      res.statusCode = 401;
      res.end("unauthorized");
    } else {
      res.end("ok");
    }
  });

  let token = "expired-token";
  let refreshCalled = false;

  try {
    const proxy = await startProxy({
      apiBase: `http://localhost:${upstream.port}`,
      getAccessToken: () => token,
      refreshToken: async () => {
        refreshCalled = true;
        token = "fresh-token";
        return true;
      },
    });

    try {
      const res = await fetch(`http://localhost:${proxy.port}/api/test`);
      assert.equal(res.status, 200);
      assert.equal(requestCount, 2, "should have retried");
      assert.equal(refreshCalled, true, "should have refreshed");
      assert.equal(receivedAuth, "Bearer fresh-token");
    } finally {
      proxy.close();
    }
  } finally {
    upstream.close();
  }
});

test("proxy: passes 401 through when refresh fails", async () => {
  const upstream = await startUpstream((_req, res) => {
    res.statusCode = 401;
    res.end("unauthorized");
  });

  try {
    const proxy = await startProxy({
      apiBase: `http://localhost:${upstream.port}`,
      getAccessToken: () => "expired-token",
      refreshToken: async () => false,
    });

    try {
      const res = await fetch(`http://localhost:${proxy.port}/api/test`);
      assert.equal(res.status, 401);
    } finally {
      proxy.close();
    }
  } finally {
    upstream.close();
  }
});

test("proxy: streams SSE response chunks", async () => {
  const upstream = await startUpstream((_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write("data: chunk1\n\n");
    res.write("data: chunk2\n\n");
    res.end();
  });

  try {
    const proxy = await startProxy({
      apiBase: `http://localhost:${upstream.port}`,
      getAccessToken: () => "tok",
      refreshToken: async () => false,
    });

    try {
      const res = await fetch(`http://localhost:${proxy.port}/api/stream`);
      const text = await res.text();
      assert.equal(res.headers.get("content-type"), "text/event-stream");
      assert.ok(text.includes("chunk1"));
      assert.ok(text.includes("chunk2"));
    } finally {
      proxy.close();
    }
  } finally {
    upstream.close();
  }
});

test("proxy: returns 502 when upstream is unreachable", async () => {
  const proxy = await startProxy({
    apiBase: "http://localhost:1", // port 1 should be unreachable
    getAccessToken: () => "tok",
    refreshToken: async () => false,
  });

  try {
    const res = await fetch(`http://localhost:${proxy.port}/api/test`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.ok(body.error, "should have error field");
  } finally {
    proxy.close();
  }
});

test("proxy: forwards response status and headers", async () => {
  const upstream = await startUpstream((_req, res) => {
    res.statusCode = 201;
    res.setHeader("x-custom-header", "custom-value");
    res.end("created");
  });

  try {
    const proxy = await startProxy({
      apiBase: `http://localhost:${upstream.port}`,
      getAccessToken: () => "tok",
      refreshToken: async () => false,
    });

    try {
      const res = await fetch(`http://localhost:${proxy.port}/api/test`);
      assert.equal(res.status, 201);
      assert.equal(res.headers.get("x-custom-header"), "custom-value");
    } finally {
      proxy.close();
    }
  } finally {
    upstream.close();
  }
});

test("proxy: onLog callback receives method, path, status", async () => {
  const upstream = await startUpstream((_req, res) => res.end("ok"));
  const logs: Array<{ method: string; path: string; status: number }> = [];

  try {
    const proxy = await startProxy({
      apiBase: `http://localhost:${upstream.port}`,
      getAccessToken: () => "tok",
      refreshToken: async () => false,
      onLog: (method, path, status) => logs.push({ method, path, status }),
    });

    try {
      await fetch(`http://localhost:${proxy.port}/api/test`);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].method, "GET");
      assert.equal(logs[0].path, "/api/test");
      assert.equal(logs[0].status, 200);
    } finally {
      proxy.close();
    }
  } finally {
    upstream.close();
  }
});
