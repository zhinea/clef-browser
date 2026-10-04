# jev-browser-clef

`jev_navigate` MCP server (stdio) powered by **Cloudflare Workers AI `clef`** (`@cf/cloudflare/clef`) for page judgments — the same browser engine as [@jkudish/jev-browser](https://github.com/jkudish/jev-browser), but decisions come from clef's 27B decision model instead of the built-in Jev providers.

Browser logic is **not** reimplemented: `src/server.mjs` calls `navigate()` from `@jkudish/jev-browser` with an injected clef `JevTransport`.

## Install

```bash
cd ~/workspace/jev-browser-clef
npm install          # installs @jkudish/jev-browser (+ its Chromium), MCP SDK, zod
npm test             # offline transport tests — no API calls
```

Requires Node ≥ 22.

## Environment

| Var | Required | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | yes* | Cloudflare API token with Workers AI read |
| `JEV_CLOUDFLARE_API_TOKEN` | no | Same as above; **takes precedence** when both are set (separate credential) |
| `CLOUDFLARE_ACCOUNT_ID` | yes | Cloudflare account ID |
| `JEV_BROWSER_MODEL` | no | Reported as the requested model; judgments still run on clef |
| `JEV_BROWSER_HEADED` | no | Set to `1` to watch the browser |
| `JEV_BROWSER_PASSWORD_ORIGIN` | no | Exact origin for password fill, e.g. `https://acme.com` |
| `JEV_BROWSER_HANDOFF_DIR` | no | Password/cookie handoff dir (default `~/.jev-browser/handoff`, mode 0700) |

\* one of the two token vars must be set.

The server fails fast at startup with a clear message when the token/account ID are missing — before any MCP handshake or browser launch.

## Use as an MCP server

```json
{
  "mcpServers": {
    "jev-browser-clef": {
      "command": "node",
      "args": ["/home/hatch/workspace/jev-browser-clef/src/server.mjs"],
      "env": {
        "CLOUDFLARE_API_TOKEN": "...",
        "CLOUDFLARE_ACCOUNT_ID": "..."
      },
      "includeTools": ["jev_navigate"]
    }
  }
}
```

Or via the skill in `skills/jev-browser-clef/SKILL.md`.

## Tool: `jev_navigate`

Same parameters as upstream `jev-browser`: `task`, `start_url`, `max_steps` (1–100, default 24), `max_seconds` (10–600, default 180), `allow_typing`, `format` (`text`/`markdown`/`html`/`aria`), `max_chars`, `screenshot` (`final`/`none`), plus `password_file`/`password_env` and `cookie_file`/`cookie_env` for reference-based credential delivery (values never enter arguments; same rules as upstream).

Returns the final page payload, full step trace with confidences, console/page/network errors, token usage with estimated cost, and a final screenshot. The result reports `jev_provider: "clef"`.

## How the transport works

`src/clef-transport.mjs` implements `JevTransport`:

- `POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/cloudflare/clef`
- Body `{ model: "clef", state, questions }` — state/questions top-level, per the [clef docs](https://developers.cloudflare.com/workers-ai/models/clef/)
- Reads `answers` from the Workers AI envelope `{ result: { answers, ... }, success: true }`; usage from `result.usage` (0 fallback)
- Normalizes answers to Jev shapes: `noul` accepts a bare probability number (what clef returns) or `{noul}`; `choice`/`score` require `{choice|score, probabilities}` (+ optional `confidence`)
- Malformed answers throw before a browser step is spent; HTTP errors carry numeric `status` so the library classifies 429/5xx like built-in transports

`test-transport.mjs` verifies all of this offline (request shape, envelope parsing, normalization, rejections, credential resolution) with zero network calls.

## Layout

```
~/workspace/jev-browser-clef/
├── src/
│   ├── clef-transport.mjs   # JevTransport -> Cloudflare Workers AI clef
│   └── server.mjs           # MCP stdio server (one tool: jev_navigate)
├── skills/jev-browser-clef/SKILL.md
├── test-transport.mjs       # offline tests (node test-transport.mjs)
├── package.json
└── README.md
```

## Typing provider (also on Cloudflare Workers AI)

`jev_navigate` needs a small model to generate text for `type_`/`search_`
actions. Any OpenAI-compatible endpoint works via the upstream
`compatible-endpoint` branch — no code changes needed:

```bash
export JEV_BROWSER_TYPE_BASE_URL="https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1"
export JEV_BROWSER_TYPE_API_KEY="<cloudflare api token>"   # or JEV_CLOUDFLARE_API_TOKEN value
export JEV_BROWSER_TYPE_MODEL="@cf/google/gemma-4-26b-a4b-it"
export JEV_BROWSER_TYPE_MAX_TOKENS="300"
```

`JEV_BROWSER_TYPE_MODEL` accepts any Workers AI model id, e.g.
`@cf/meta/llama-3.1-8b-instruct` for a cheaper/faster non-reasoning option.

### Why `JEV_BROWSER_TYPE_MAX_TOKENS` exists

Upstream hardcodes `maxOutputTokens: 48` for custom typing endpoints.
Reasoning models (like `gemma-4-26b-a4b-it`) spend those 48 tokens on
chain-of-thought and return an empty `content`, so every typing action fails.
`scripts/patch-typing-cap.mjs` (run automatically on `postinstall`) makes the
cap configurable: 48 stays the floor, `JEV_BROWSER_TYPE_MAX_TOKENS` raises it.
