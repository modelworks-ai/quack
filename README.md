# @modelworks/quack

Launch AI coding agents with [ModelWorks](https://modelworks.ai) circuits as model providers — with OAuth login, a local auth-injecting proxy, run history, and git-like project config.

## What it does

quack connects [ModelWorks](https://modelworks.ai) circuits to AI coding agents like [OpenCode](https://opencode.ai). It:

- **Authenticates** via OAuth (browser-based login to your ModelWorks account)
- **Discovers** circuits and their SSE-compatible adaptors automatically
- **Proxies** all requests through a local HTTP server that injects your auth token — so it never appears in config files or `--print` output
- **Injects** SSE circuits as OpenAI-compatible model providers + the global ModelWorks MCP server (13 tools)
- **Records** every circuit run to `.quack/runs/` — status, cost, tokens, timing — safe to commit
- **Shares** project config via `config.json` (committed) while keeping per-user state in `state.json` (gitignored)

## Install

**npm:**

```bash
npm i -g @modelworks/quack
```

Requires Node 18+.

**curl (no npm required):**

```bash
curl -fsSL https://raw.githubusercontent.com/modelworks-ai/quack/main/install/install.sh | bash
```

Downloads quack to `~/.quack/`. If Node 18+ isn't installed, the script
automatically downloads a bundled Node binary — works on a clean machine
with only `curl` and `tar`.

## Quick start

```bash
# 1. Log in (opens browser for OAuth)
quack auth login

# 2. Initialize a quack project
mkdir my-project && cd my-project
quack init

# 3. Add a circuit
quack circuit add https://modelworks.ai/circuits/c-xxx

# 4. Launch OpenCode with the circuit as a model provider
quack
```

In OpenCode, run `/models` and select your circuit (e.g. `alice/my-circuit` under the ModelWorks provider). Type a message and it streams through the circuit via the quack proxy.

## Commands

```
quack                                    Launch the default agent (opencode)
quack init                               Create .quack/ in current directory
quack circuit add <url>                  Add a circuit and discover adaptors
quack circuit remove <uid>              Remove a circuit from the project
quack circuit list [--long]             List circuits, adaptors, and SSE status
quack circuit refresh [uid]             Re-resolve versions and rediscover adaptors
quack circuit describe <uid>             Show full circuit details
quack circuit use <uid>                 Set the default circuit for agent launch

quack history [run-uid]                 Show run history (table, or details for one run)
quack history --user <name>             Filter by caller username
quack history --circuit <uid>           Filter by circuit UID

quack opencode [args]                   Start proxy + launch OpenCode
quack opencode --print                  Show injected config + proxy info, don't launch

quack agent list                        List available agents and install status
quack agent describe <name>             Show agent details

quack auth login                         OAuth flow → store credentials
quack auth logout                        Revoke + delete credentials
quack auth status                        Show current user

quack --help | -h
quack --version | -v
quack --debug                            Verbose proxy logging to .quack/debug.log
quack --verbose                          Proxy request logging to stderr
```

## How it works

### Project structure

```
.quack/
├── config.json      # committable — circuits, default_agent, default_circuit
├── state.json       # gitignored — per-user adaptor UIDs, last_agent
├── runs/            # committable — circuit run records (metadata only)
└── .gitignore       # ignores state.json and debug.log
```

`config.json` is safe to commit — it contains circuit UIDs, names, and defaults.
Share it with your team (like `package.json`). When a teammate clones the repo
and runs `quack`, it auto-syncs: creates the per-user state and adaptors
automatically (like `npm install` creating `node_modules`).

`runs/` contains one JSON file per circuit run — metadata only (run UID,
circuit, caller, status, cost, tokens, timing). No request or response
bodies. Safe to commit and share.

### The proxy

When you run `quack` (or `quack opencode`), quack:

1. Starts a local HTTP proxy on a random port (`127.0.0.1` only)
2. Builds an OpenCode config where all ModelWorks URLs point to the proxy
3. Writes the config to a temp file and launches OpenCode via `OPENCODE_CONFIG`

The proxy:
- **Injects auth** — adds `Authorization: Bearer <token>` to every forwarded request, overriding any client-sent auth header
- **Streams** — passes SSE/NDJSON/JSON responses through without buffering
- **Refreshes on 401** — automatically refreshes the access token and retries
- **Saves run history** — captures the `X-Circuit-Run-Uid` response header and fetches the run record after the stream completes
- **Shuts down** when OpenCode exits

The injected config contains **no secrets** — only `localhost` URLs with
ephemeral ports. `quack opencode --print` output is safe to share.

### What gets injected

Only circuits with `OPEN_AI_SSE` in their adapters are injected as
OpenAI-compatible model providers. All circuits (SSE or not) are accessible
as tools via the global **ModelWorks x.MCP** server (`/api/x.mcp`, 13 tools:
circuit search, query, pricing, adaptors, blobs, etc.).

The OpenCode config (V2 format):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "ModelWorks x.MCP": {
        "type": "remote",
        "url": "http://localhost:<port>/api/x.mcp",
        "oauth": false,
        "protocol": "2026-07-28",
        "headers": { "Authorization": "Bearer quack" }
      }
    }
  },
  "providers": {
    "circuit-c-xxx": {
      "name": "ModelWorks",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://localhost:<port>/api/circuit-adaptors/<adaptor-uid>/query",
        "apiKey": "quack"
      },
      "models": {
        "c-xxx": { "name": "alice/my-circuit" }
      }
    }
  }
}
```

The `Bearer quack` and `apiKey: "quack"` are dummies — the proxy overrides
them with the real token on every request. OpenCode's deep-merge preserves
your existing config at the per-key level.

### Run history

After each circuit request through the proxy, quack:

1. Captures the `X-Circuit-Run-Uid` response header
2. Fetches the full run record from `GET /api/circuit-runs/{uid}`
3. Saves it to `.quack/runs/cr-xxx.json`

```json
{
  "run_uid": "cr-xxx",
  "circuit_uid": "c-xxx",
  "circuit_name": "my-circuit",
  "owner_username": "alice",
  "caller_username": "alice",
  "version_uid": "cv-xxx",
  "status": "COMPLETED",
  "created_at": "2026-10-21T06:08:11Z",
  "completed_at": "2026-10-21T06:08:14Z",
  "duration_ms": 3100,
  "cost_credits": 0.05,
  "input_tokens": 42,
  "output_tokens": 128
}
```

No request or response bodies — just metadata. View with `quack history`.

## Configuration

### API host

Default: `https://modelworks.ai`. Override with:

```bash
QUACK_API_BASE=http://localhost:8080 quack auth login
# or
quack auth login --api-base http://localhost:8080
```

### Credentials

Stored globally at `~/.config/quack/` (not per-project):

```
~/.config/quack/
├── client.json          # OAuth client (DCR) — created once
└── credentials.json     # access_token, refresh_token, expires_at — chmod 0600
```

### Agents

quack supports multiple agents via a plugin system. Currently built-in:

- **opencode** — [OpenCode](https://opencode.ai) (V2 with MCP 2.0 support)

Bare `quack` launches the default agent (set in `config.json` or picked
interactively). Adding a new agent is a single file in `src/agents/`.

## Development

```bash
npm install
npm run build      # tsc → dist/
npm run dev        # tsc --watch
npm test           # 83 tests (node:test + node:assert, zero deps)
node dist/bin.js --help
```

Zero runtime dependencies (Node 18+ built-ins only, except `commander` for
CLI parsing). TypeScript strict mode. ESM.

## License

MIT
