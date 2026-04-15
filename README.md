# denollm

Deno/TypeScript port of `ollama-webui-llm`.

Current state:

- Backend ported to TypeScript with `Deno.serve`
- Backend behavior covered by a Deno test suite
- Static frontend carried over unchanged as the initial baseline
- Ollama integration switched from the Python client to direct HTTP calls

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
