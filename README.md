# @modelworks/quack

A git-like authenticated circuit launcher for [ModelWorks](https://modelworks.ai) that wires ModelWorks circuits into [OpenCode](https://opencode.ai) as OpenAI-compatible model providers — with a local proxy that keeps your access token out of config files.

## Why?

ModelWorks circuits can expose OpenAI-compatible SSE endpoints. quack makes it trivial to use those circuits as models in OpenCode:

- **`quack init`** — create a `.quack/` directory in your project (like `git init`)
- **`quack add <circuit-url>`** — add a circuit, discover its adaptors, create a temporal SSE adaptor
- **`quack opencode`** — start a local proxy + launch OpenCode with your SSE circuits injected as model providers

The proxy holds your access token in memory and injects `Authorization: Bearer <token>` on every request — so `--print` output is safe to share, and token refresh happens transparently without restarting OpenCode.

## Install

**Option 1 — curl (no npm required):**

```bash
curl -fsSL https://raw.githubusercontent.com/modelworks-ai/quack/main/install/install.sh | bash
```

Downloads quack to `~/.quack/`. If Node 18+ isn't on your system, the script
automatically downloads a bundled Node binary — so this works on a clean
machine with nothing but `curl` and `tar` installed.

```bash
curl -fsSL https://raw.githubusercontent.com/modelworks-ai/quack/main/install/install.sh | bash -s -- --version 0.1.0
```

**Option 2 — npm:**

```bash
npm i -g @modelworks/quack
```

Requires Node 18+.

## Quick start

```bash
# 1. Log in (opens browser for OAuth)
quack login

# 2. Initialize a quack project
mkdir my-project && cd my-project
quack init

# 3. Add a circuit
quack add https://modelworks.ai/circuits/c-xxx

# 4. Launch OpenCode with the circuit as a model provider
quack opencode
```

In OpenCode, run `/models` and select your circuit (e.g. `circuit-c-xxx/c-xxx`).

## Commands

```
quack init                              Create .quack/ in current directory
quack add <circuit-url>                 Add a circuit (resolve + create SSE adaptor)
quack rm <circuit-uid|url>              Remove a circuit (--keep-adaptors to skip deletion)
quack ls                                List configured circuits and their adaptors
quack refresh [circuit-uid]             Re-resolve versions and rediscover adaptors

quack opencode [args]                   Start proxy + launch opencode (SSE circuits only)
quack opencode --print                  Show injected config + proxy info, don't launch
quack opencode --verbose                Launch with proxy request logging

quack login                             OAuth flow → store credentials
quack logout                            Revoke + delete credentials
quack whoami                            Show current user

quack --help | -h
quack --version | -v
```

## How it works

### Project structure

```
.quack/
├── config.json      # committable — list of circuits (share with your team)
├── state.json       # gitignored — per-user cached state (adaptor UIDs, version UIDs)
└── .gitignore       # ignores state.json
```

`config.json` is safe to commit — it only contains circuit URLs and names. `state.json` is per-user (each teammate creates their own temporal adaptors).

### The proxy

When you run `quack opencode`, quack:

1. Starts a local HTTP proxy on a random port (`127.0.0.1`)
2. Builds an OpenCode config where all ModelWorks URLs point to the proxy
3. Launches OpenCode with that config via `OPENCODE_CONFIG_CONTENT`

The proxy:
- **Injects auth** — adds `Authorization: Bearer <token>` to every forwarded request
- **Streams** — passes SSE/NDJSON/JSON responses through without buffering
- **Refreshes on 401** — automatically refreshes the access token and retries
- **Shuts down** when OpenCode exits

The config injected by quack contains **no secrets** — only `localhost` URLs. This means `quack opencode --print` output is safe to share.

### What gets injected

Only circuits with `OPEN_AI_SSE` in their `adapters` array are injected as model providers. All circuits (SSE or not) are accessible as tools via the global `modelworks` MCP server (`/api/x.mcp`).

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "modelworks": {
        "type": "remote",
        "url": "http://localhost:<port>/api/x.mcp",
        "oauth": false,
        "protocol": "auto"
      }
    }
  },
  "provider": {
    "circuit-c-xxx": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "My Circuit",
      "options": {
        "baseURL": "http://localhost:<port>/api/circuit-adaptors/<adaptor-uid>/query",
        "apiKey": "quack"
      },
      "models": {
        "c-xxx": { "name": "My Circuit" }
      }
    }
  }
}
```

OpenCode's built-in config merge preserves your existing `opencode.json` — quack only adds its blocks on top.

## Configuration

### API host

Default: `https://modelworks.ai`. Override with:

```bash
QUACK_API_BASE=http://localhost:8080 quack login
# or
quack login --api-base http://localhost:8080
```

### Credentials

Stored at `~/.config/quack/`:

```
~/.config/quack/
├── client.json          # OAuth client (DCR) — created once
└── credentials.json     # access_token, refresh_token, expires_at — chmod 0600
```

## Development

```bash
npm install
npm run build      # tsc → dist/
npm run dev        # tsc --watch
node dist/bin.js --help
```

Zero runtime dependencies. TypeScript strict mode. Node 18+ built-ins only.

## License

MIT
