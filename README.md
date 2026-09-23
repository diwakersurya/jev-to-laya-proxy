# jev-proxy

Single-file [Bun](https://bun.sh) proxy that speaks the [TypeSafe Jev API](https://docs.typesafe.ai/api) (`POST /v1/systemone`) and forwards to any Jev-like backend. It points at a local [Laya](https://github.com/wdobry/laya-playground) server by default.

## Requirements

- Bun 1.x
- A running backend. For Laya, the default is `http://127.0.0.1:8770`. To check it's up, run `curl http://127.0.0.1:8770/api/health`.

## Run

```sh
bun start            # or: bun proxy.ts
bun run dev          # watch mode + LOG=1
# jev-proxy :8787 → laya (http://127.0.0.1:8770/api/predict)
```

Environment overrides:

| Var       | Effect                                           |
| --------- | ------------------------------------------------ |
| `CONFIG`  | Path to config file (default `./config.json`)    |
| `BACKEND` | Backend name from `config.json` → `backends`     |
| `PORT`    | Listen port (default `8787`)                     |
| `LOG=1`   | Same as `--log`: log every hop with full, untruncated bodies |

```sh
bun proxy.ts --log          # or ./dist/jev-proxy --log
LOG=1 PORT=9000 bun proxy.ts
BACKEND=typesafe TYPESAFE_API_KEY=sk-... bun proxy.ts   # forward to real Jev
```

With logging on, each request prints four lines. You can see the proxy receiving the call, then forwarding it:

```
... client→proxy POST /v1/systemone from ::1 {"state":...,"model":"jev-latest",...}
... proxy→backend POST http://127.0.0.1:8770/api/predict {"state":...,"model":null,...}
... backend→proxy 200 {"model":"laya-rl-agent","answers":{...},"routing":{...},...}
... proxy→client 200 381ms {"model":"laya-rl-agent","answers":{...},"usage":{...}}
```

Every response also carries an `x-served-by: jev-proxy (<backend>)` header. Check it with `curl -i`.

## Use

```sh
curl localhost:8787/v1/systemone \
  -H 'Authorization: Bearer anything' \
  -H 'Content-Type: application/json' \
  -d '{
    "state": "Help! My payouts have been failing for 3 days.",
    "model": "jev-latest",
    "questions": {
      "is_urgent": { "type": "noul", "instructions": "Does this convey urgency?" },
      "department": {
        "type": "choice",
        "instructions": "Which team should handle this?",
        "criteria": { "billing": "Payments, refunds", "technical": "Bugs, outages", "sales": "Pricing" }
      },
      "frustration": {
        "type": "score",
        "instructions": "How frustrated is the customer?",
        "criteria": ["Calm", "Frustrated", "Very angry"]
      }
    }
  }'
```

TypeSafe SDKs: set the client base URL to `http://localhost:8787`. Any API key works unless you set `apiKey` in the config.

### Routes

| Route               | Purpose                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `POST /v1/systemone` | Validates the request, maps `model`, forwards it, returns strict Jev shape `{model, answers, usage}` |
| `GET /v1/models`     | Lists the `modelMap` names                                        |
| `GET /health`        | Passes through the backend health check                           |

Errors: `422` means the request is invalid or the backend rejected it. `401` means a bad key, and only happens when `apiKey` is set. `529` means the backend is down or returned a 5xx, so SDKs retry.

## Config

`config.json`:

- `port`: the port the proxy listens on.
- `apiKey`: `null` accepts any Bearer token. A string requires exactly that token.
- `backend`: the active entry in `backends`.
- `backends.<name>` takes these fields:
  - `url`, `predictPath`, `healthPath`: where requests are forwarded.
  - `headers`: sent to the backend. Use `"${ENV_VAR}"` placeholders to keep secrets out of the file.
  - `extraBody`: fields merged into every forwarded body, such as `{ "lang": "en" }` for Laya.
  - `modelMap`: maps a Jev model name to a backend model name. `null` lets Laya auto-route.
  - `defaultModel`: used when the request's `model` isn't in `modelMap`.

Default Laya mapping:

| Request `model`          | Laya model        |
| ------------------------ | ----------------- |
| `jev-latest`, `jev-preview`, unknown | auto-route |
| `laya-english`           | `english`         |
| `laya-multilingual`      | `multilingual`    |
| `laya-typed`             | `typed-decisions` |

### Swapping the backend

Add an entry under `backends`, then set `"backend"` or `BACKEND=`. The new backend must accept a Jev-like body (`state`, `questions`, `model`). Responses are always trimmed to the Jev shape, so extra fields are fine.

## Build a standalone executable

```sh
bun run build        # dist/jev-proxy for the current platform
./dist/jev-proxy
bun run build:all    # linux x64/arm64, darwin x64/arm64, windows x64 → dist/
```

Individual targets: `build:linux-x64`, `build:linux-arm64`, `build:darwin-x64`, `build:darwin-arm64`, `build:windows-x64`.

Each binary bundles the Bun runtime (60–80 MB), so recipients don't need Bun installed. `config.json` is embedded at build time. At runtime the binary loads `CONFIG=path` if set, otherwise `./config.json` in the working directory if one exists, otherwise the embedded copy. Env overrides work as above.

On macOS, a downloaded binary may be quarantined. Clear the flag with `xattr -d com.apple.quarantine jev-proxy`.

### Releases

Pushing a `v*` tag runs `.github/workflows/release.yml`. The workflow tests the code, builds every platform binary and publishes a GitHub release with the archives and `SHA256SUMS`.

```sh
git tag v0.2.0 && git push origin v0.2.0
```

## Test

```sh
bun run test
```
