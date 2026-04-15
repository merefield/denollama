import { createApp } from '../src/app.ts';
import {
  ChatMessage,
  ModelListResponse,
  OllamaClient,
  OllamaClientError,
} from '../src/ollama.ts';
import { assert, assertEquals, assertJson } from './helpers.ts';

class FakeOllamaClient implements OllamaClient {
  chatCalls: Array<{ model: string; messages: ChatMessage[] }> = [];
  listCalls = 0;
  chatResult = 'This is a test response';
  listResult: ModelListResponse = {
    models: [{ model: 'llama2' }, { model: 'mistral' }],
  };
  chatError: Error | null = null;
  listError: Error | null = null;

  async chat(input: { model: string; messages: ChatMessage[] }) {
    this.chatCalls.push(input);
    if (this.chatError) {
      throw this.chatError;
    }

    return {
      message: {
        content: this.chatResult,
      },
    };
  }

  async list() {
    this.listCalls += 1;
    if (this.listError) {
      throw this.listError;
    }

    return this.listResult;
  }
}

function createStaticDir() {
  const staticDir = new URL('../static/', import.meta.url);
  return staticDir;
}

async function makeRequest(
  app: ReturnType<typeof createApp>,
  path: string,
  init?: RequestInit,
) {
  return await app.fetch(new Request(`http://localhost${path}`, init));
}

Deno.test('GET / serves the main HTML page', async () => {
  const app = createApp({
    client: new FakeOllamaClient(),
    staticDir: createStaticDir(),
  });

  const response = await makeRequest(app, '/');
  const text = await response.text();

  assertEquals(response.status, 200);
  assert(
    response.headers.get('content-type')?.includes('text/html'),
    'Expected HTML content type',
  );
  assert(text.includes('<!DOCTYPE html>'), 'Expected HTML body');
});

Deno.test('GET /api/v1/auth-required reports false when no API key is configured', async () => {
  const app = createApp({ client: new FakeOllamaClient() });
  const response = await makeRequest(app, '/api/v1/auth-required');
  const body = await assertJson(response, 200);

  assertEquals(body, { auth_required: false });
});

Deno.test('GET /api/v1/auth-required reports true when API key is configured', async () => {
  const app = createApp({
    apiKey: 'secret-key',
    client: new FakeOllamaClient(),
  });
  const response = await makeRequest(app, '/api/v1/auth-required');
  const body = await assertJson(response, 200);

  assertEquals(body, { auth_required: true });
});

Deno.test('GET /api/v1/models returns available models', async () => {
  const client = new FakeOllamaClient();
  const app = createApp({ client });
  const response = await makeRequest(app, '/api/v1/models');
  const body = await assertJson(response, 200);

  assertEquals(body, {
    models: ['llama2', 'mistral'],
    count: 2,
  });
  assertEquals(client.listCalls, 1);
});

Deno.test('GET /api/v1/models enforces API key when configured', async () => {
  const client = new FakeOllamaClient();
  const app = createApp({
    apiKey: 'secret-key',
    client,
  });

  const response = await makeRequest(app, '/api/v1/models');
  const body = await assertJson(response, 401);

  assertEquals(body, { error: 'Invalid or missing API key' });
  assertEquals(client.listCalls, 0);
});

Deno.test('GET /api/v1/models accepts valid API key', async () => {
  const client = new FakeOllamaClient();
  const app = createApp({
    apiKey: 'secret-key',
    client,
  });

  const response = await makeRequest(app, '/api/v1/models', {
    headers: {
      'X-API-Key': 'secret-key',
    },
  });

  await assertJson(response, 200);
  assertEquals(client.listCalls, 1);
});

Deno.test('POST /api/v1/response validates prompt and model fields', async () => {
  const app = createApp({ client: new FakeOllamaClient() });

  const missingPrompt = await makeRequest(app, '/api/v1/response', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama2' }),
  });
  assertEquals(await assertJson(missingPrompt, 400), {
    error: "Missing 'prompt' field",
  });

  const missingModel = await makeRequest(app, '/api/v1/response', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Hello' }),
  });
  assertEquals(await assertJson(missingModel, 400), {
    error: "Missing 'model' field",
  });
});

Deno.test('POST /api/v1/response rejects invalid or empty JSON', async () => {
  const app = createApp({ client: new FakeOllamaClient() });

  const invalidJson = await makeRequest(app, '/api/v1/response', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not json',
  });
  assertEquals(await assertJson(invalidJson, 400), {
    error: 'Invalid JSON data provided',
  });

  const emptyJson = await makeRequest(app, '/api/v1/response', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assertEquals(await assertJson(emptyJson, 400), {
    error: 'No JSON data provided',
  });
});

Deno.test('POST /api/v1/response builds messages with context and defaults', async () => {
  const client = new FakeOllamaClient();
  client.chatResult = 'Contextual response';
  const app = createApp({ client });

  const response = await makeRequest(app, '/api/v1/response', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Tell me more',
      model: 'llama2',
      context: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user' },
        { content: 'Missing role' },
      ],
    }),
  });

  const body = await assertJson(response, 200);
  assertEquals(body, {
    response: 'Contextual response',
    model: 'llama2',
  });
  assertEquals(client.chatCalls.length, 1);
  assertEquals(client.chatCalls[0], {
    model: 'llama2',
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: '' },
      { role: 'user', content: 'Missing role' },
      { role: 'user', content: 'Tell me more' },
    ],
  });
});

Deno.test('POST /api/v1/response ignores non-list context', async () => {
  const client = new FakeOllamaClient();
  const app = createApp({ client });

  const response = await makeRequest(app, '/api/v1/response', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Test',
      model: 'llama2',
      context: 'not a list',
    }),
  });

  await assertJson(response, 200);
  assertEquals(client.chatCalls[0].messages, [
    { role: 'user', content: 'Test' },
  ]);
});

Deno.test('POST /api/v1/response enforces API key when configured', async () => {
  const client = new FakeOllamaClient();
  const app = createApp({
    apiKey: 'secret-key',
    client,
  });

  const response = await makeRequest(app, '/api/v1/response', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Hello',
      model: 'llama2',
    }),
  });

  assertEquals(await assertJson(response, 401), {
    error: 'Invalid or missing API key',
  });
  assertEquals(client.chatCalls.length, 0);
});

Deno.test('POST /api/v1/response surfaces Ollama errors', async () => {
  const client = new FakeOllamaClient();
  client.chatError = new OllamaClientError('model not found');
  const app = createApp({ client });

  const response = await makeRequest(app, '/api/v1/response', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Hello',
      model: 'llama2',
    }),
  });

  assertEquals(await assertJson(response, 500), {
    error: 'Ollama error: model not found',
  });
});

Deno.test('GET /api/v1/models surfaces Ollama errors', async () => {
  const client = new FakeOllamaClient();
  client.listError = new OllamaClientError('connection refused');
  const app = createApp({ client });

  const response = await makeRequest(app, '/api/v1/models');
  assertEquals(await assertJson(response, 500), {
    error: 'Ollama error: connection refused',
  });
});

Deno.test('unsupported methods return 405 for API routes', async () => {
  const app = createApp({ client: new FakeOllamaClient() });

  const modelsResponse = await makeRequest(app, '/api/v1/models', {
    method: 'POST',
  });
  assertEquals(modelsResponse.status, 405);

  const chatResponse = await makeRequest(app, '/api/v1/response', {
    method: 'GET',
  });
  assertEquals(chatResponse.status, 405);
});
