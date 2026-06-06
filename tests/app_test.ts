import { createApp } from '../src/app.ts';
import {
  ChatMessage,
  ChatStreamChunk,
  ModelListResponse,
  OllamaClient,
  OllamaClientError,
} from '../src/ollama.ts';
import { assert, assertEquals, assertJson } from './helpers.ts';

class FakeOllamaClient implements OllamaClient {
  chatCalls: Array<{ model: string; messages: ChatMessage[] }> = [];
  chatStreamCalls: Array<{ model: string; messages: ChatMessage[] }> = [];
  transcribeCalls: Array<{ model: string; audio: string; format: string }> = [];
  showCalls: Array<{ model: string }> = [];
  listCalls = 0;
  chatResult = 'This is a test response';
  transcribeResult = 'spoken words';
  streamChunks: ChatStreamChunk[] = [
    { message: { content: 'This ' } },
    { message: { content: 'streams' } },
    { done: true },
  ];
  listResult: ModelListResponse = {
    models: [{ model: 'llama2' }, { model: 'gemma4:latest' }],
  };
  showResults: Record<string, { model: string; capabilities: string[] }> = {
    llama2: { model: 'llama2', capabilities: ['completion'] },
    'gemma4:latest': {
      model: 'gemma4:latest',
      capabilities: ['completion', 'audio'],
    },
  };
  chatError: Error | null = null;
  chatStreamError: Error | null = null;
  transcribeError: Error | null = null;
  showError: Error | null = null;
  listError: Error | null = null;

  chat(input: { model: string; messages: ChatMessage[] }) {
    this.chatCalls.push(input);
    if (this.chatError) {
      return Promise.reject(this.chatError);
    }

    return Promise.resolve({
      message: {
        content: this.chatResult,
      },
    });
  }

  async *chatStream(input: { model: string; messages: ChatMessage[] }) {
    this.chatStreamCalls.push(input);
    if (this.chatStreamError) {
      throw this.chatStreamError;
    }

    for (const chunk of this.streamChunks) {
      yield chunk;
    }
  }

  list() {
    this.listCalls += 1;
    if (this.listError) {
      return Promise.reject(this.listError);
    }

    return Promise.resolve(this.listResult);
  }

  show(input: { model: string }) {
    this.showCalls.push(input);
    if (this.showError) {
      return Promise.reject(this.showError);
    }

    return Promise.resolve(
      this.showResults[input.model] ?? {
        model: input.model,
        capabilities: [],
      },
    );
  }

  transcribe(input: { model: string; audio: string; format: string }) {
    this.transcribeCalls.push(input);
    if (this.transcribeError) {
      return Promise.reject(this.transcribeError);
    }

    return Promise.resolve(this.transcribeResult);
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

Deno.test('GET vendored JS modules serves JavaScript module content type', async () => {
  const app = createApp({
    client: new FakeOllamaClient(),
    staticDir: createStaticDir(),
  });

  const response = await makeRequest(
    app,
    '/static/vendor/preact.module.js',
  );

  assertEquals(response.status, 200);
  assert(
    response.headers.get('content-type')?.includes('application/javascript'),
    'Expected JavaScript module content type',
  );
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
    models: ['llama2', 'gemma4:latest'],
    model_details: [
      { model: 'llama2', capabilities: ['completion'] },
      {
        model: 'gemma4:latest',
        capabilities: ['completion', 'audio'],
      },
    ],
    transcription_models: ['gemma4:latest'],
    count: 2,
  });
  assertEquals(client.listCalls, 1);
  assertEquals(client.showCalls, [
    { model: 'llama2' },
    { model: 'gemma4:latest' },
  ]);
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

Deno.test('POST /api/v1/response prepends system prompt when provided', async () => {
  const client = new FakeOllamaClient();
  const app = createApp({ client });

  const response = await makeRequest(app, '/api/v1/response', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Solve this',
      model: 'llama2',
      system_prompt: 'Use display math for derivations.',
      context: [
        { role: 'assistant', content: 'Ready.' },
      ],
    }),
  });

  await assertJson(response, 200);
  assertEquals(client.chatCalls[0].messages, [
    { role: 'system', content: 'Use display math for derivations.' },
    { role: 'assistant', content: 'Ready.' },
    { role: 'user', content: 'Solve this' },
  ]);
});

Deno.test('POST /api/v1/response streams NDJSON when requested', async () => {
  const client = new FakeOllamaClient();
  const app = createApp({ client });

  const response = await makeRequest(app, '/api/v1/response', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Stream this',
      model: 'llama2',
      stream: true,
    }),
  });

  assertEquals(response.status, 200);
  assert(
    response.headers.get('content-type')?.includes('application/x-ndjson'),
    'Expected NDJSON content type',
  );
  const body = await response.text();
  const events = body.trim().split('\n').map((line) => JSON.parse(line));

  assertEquals(events, [
    { delta: 'This ' },
    { delta: 'streams' },
    { done: true, response: 'This streams', model: 'llama2' },
  ]);
  assertEquals(client.chatCalls.length, 0);
  assertEquals(client.chatStreamCalls.length, 1);
});

Deno.test('POST /api/v1/response streams error payloads when streaming fails', async () => {
  const client = new FakeOllamaClient();
  client.chatStreamError = new OllamaClientError('stream failed');
  const app = createApp({ client });

  const response = await makeRequest(app, '/api/v1/response', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Stream this',
      model: 'llama2',
      stream: true,
    }),
  });

  assertEquals(response.status, 200);
  const body = await response.text();
  const events = body.trim().split('\n').map((line) => JSON.parse(line));

  assertEquals(events, [{ error: 'Ollama error: stream failed' }]);
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

Deno.test('POST /api/v1/transcribe validates model and audio fields', async () => {
  const app = createApp({ client: new FakeOllamaClient() });

  const missingModel = await makeRequest(app, '/api/v1/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: 'base64-audio' }),
  });
  assertEquals(await assertJson(missingModel, 400), {
    error: "Missing 'model' field",
  });

  const missingAudio = await makeRequest(app, '/api/v1/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gemma4:e4b' }),
  });
  assertEquals(await assertJson(missingAudio, 400), {
    error: "Missing 'audio' field",
  });
});

Deno.test('POST /api/v1/transcribe returns transcription text', async () => {
  const client = new FakeOllamaClient();
  client.transcribeResult = ' hello world ';
  const app = createApp({ client });

  const response = await makeRequest(app, '/api/v1/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemma4:e4b',
      audio: 'base64-audio',
      format: 'wav',
    }),
  });

  assertEquals(await assertJson(response, 200), {
    transcription: 'hello world',
    model: 'gemma4:e4b',
  });
  assertEquals(client.transcribeCalls, [{
    model: 'gemma4:e4b',
    audio: 'base64-audio',
    format: 'wav',
  }]);
});

Deno.test('POST /api/v1/transcribe enforces API key when configured', async () => {
  const client = new FakeOllamaClient();
  const app = createApp({
    apiKey: 'secret-key',
    client,
  });

  const response = await makeRequest(app, '/api/v1/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemma4:e4b',
      audio: 'base64-audio',
    }),
  });

  assertEquals(await assertJson(response, 401), {
    error: 'Invalid or missing API key',
  });
  assertEquals(client.transcribeCalls.length, 0);
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

  const transcribeResponse = await makeRequest(app, '/api/v1/transcribe', {
    method: 'GET',
  });
  assertEquals(transcribeResponse.status, 405);
});
