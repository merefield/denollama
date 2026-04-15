# denollm

Deno/TypeScript port of `ollama-webui-llm`.

Current state:

- Backend ported to TypeScript with `Deno.serve`
- Backend behavior covered by a Deno test suite
- Static frontend rewritten with Preact
- Ollama integration switched from the Python client to direct HTTP calls
- Preact 10.29.1, htm 3.1.1, and Marked 18.0.0 are vendored under `static/vendor/` so the app does not depend on a CDN at runtime

## Run

```bash
deno task dev
```

Optional environment variables:

```bash
PORT=5000
API_KEY=your-secret-key
```

## Test

```bash
deno task test
```
