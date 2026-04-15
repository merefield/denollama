import { HttpOllamaClient, OllamaClient, OllamaClientError } from './ollama.ts';

const DEFAULT_STATIC_DIR = new URL('../static/', import.meta.url);
const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
};

export interface AppOptions {
  apiKey?: string;
  client?: OllamaClient;
  staticDir?: URL;
}

export function createApp(options: AppOptions = {}) {
  const apiKey = options.apiKey ?? '';
  const client = options.client ?? new HttpOllamaClient(DEFAULT_OLLAMA_HOST);
  const staticDir = options.staticDir ?? DEFAULT_STATIC_DIR;

  return {
    fetch(request: Request): Response | Promise<Response> {
      return handleRequest(request, { apiKey, client, staticDir });
    },
  };
}

interface AppDeps {
  apiKey: string;
  client: OllamaClient;
  staticDir: URL;
}

function handleRequest(
  request: Request,
  deps: AppDeps,
): Response | Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/') {
    return serveStaticFile(deps.staticDir, 'index.html');
  }

  if (url.pathname.startsWith('/static/')) {
    const relativePath = url.pathname.slice('/static/'.length);
    return serveStaticFile(deps.staticDir, relativePath);
  }

  if (url.pathname === '/api/v1/auth-required' && request.method === 'GET') {
    return jsonResponse({ auth_required: Boolean(deps.apiKey) });
  }

  if (url.pathname === '/api/v1/models') {
    return handleModelsRequest(request, deps);
  }

  if (url.pathname === '/api/v1/response') {
    return handleResponseRequest(request, deps);
  }

  return new Response('Not Found', { status: 404 });
}

async function handleModelsRequest(
  request: Request,
  deps: AppDeps,
): Promise<Response> {
  if (request.method !== 'GET') {
    return methodNotAllowed(['GET']);
  }

  const unauthorized = requireApiKey(request, deps.apiKey);
  if (unauthorized) {
    return unauthorized;
  }

  try {
    const modelsResponse = await deps.client.list();
    const models = Array.isArray(modelsResponse.models)
      ? modelsResponse.models.map((model) => model.model)
      : [];

    return jsonResponse({
      models,
      count: models.length,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

async function handleResponseRequest(
  request: Request,
  deps: AppDeps,
): Promise<Response> {
  if (request.method !== 'POST') {
    return methodNotAllowed(['POST']);
  }

  const unauthorized = requireApiKey(request, deps.apiKey);
  if (unauthorized) {
    return unauthorized;
  }

  let data: Record<string, unknown>;

  try {
    data = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON data provided' }, 400);
  }

  if (!data || Object.keys(data).length === 0) {
    return jsonResponse({ error: 'No JSON data provided' }, 400);
  }

  const prompt = typeof data.prompt === 'string' ? data.prompt : undefined;
  const model = typeof data.model === 'string' ? data.model : undefined;
  const context = Array.isArray(data.context) ? data.context : [];

  if (!prompt) {
    return jsonResponse({ error: "Missing 'prompt' field" }, 400);
  }

  if (!model) {
    return jsonResponse({ error: "Missing 'model' field" }, 400);
  }

  const messages = context.map((message) => {
    const safeMessage = isRecord(message) ? message : {};
    return {
      role: typeof safeMessage.role === 'string' ? safeMessage.role : 'user',
      content: typeof safeMessage.content === 'string'
        ? safeMessage.content
        : '',
    };
  });

  messages.push({
    role: 'user',
    content: prompt,
  });

  try {
    const response = await deps.client.chat({ model, messages });
    return jsonResponse({
      response: response.message.content,
      model,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

function requireApiKey(request: Request, apiKey: string): Response | null {
  if (!apiKey) {
    return null;
  }

  const requestKey = request.headers.get('X-API-Key');
  if (!requestKey || requestKey !== apiKey) {
    return jsonResponse({ error: 'Invalid or missing API key' }, 401);
  }

  return null;
}

async function serveStaticFile(
  baseDir: URL,
  relativePath: string,
): Promise<Response> {
  const sanitizedPath = relativePath.replace(/^\/+/, '');
  const fileUrl = new URL(sanitizedPath, baseDir);
  const basePath = fromFileUrl(baseDir);
  const filePath = fromFileUrl(fileUrl);

  if (!filePath.startsWith(basePath)) {
    return new Response('Not Found', { status: 404 });
  }

  try {
    const data = await Deno.readFile(fileUrl);
    const contentType = getContentType(sanitizedPath);
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': contentType,
      },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response('Not Found', { status: 404 });
    }
    throw error;
  }
}

function getContentType(path: string): string {
  const extension = path.slice(path.lastIndexOf('.'));
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

function methodNotAllowed(methods: string[]): Response {
  return new Response(null, {
    status: 405,
    headers: {
      Allow: methods.join(', '),
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function handleApiError(error: unknown): Response {
  if (error instanceof OllamaClientError) {
    return jsonResponse({ error: `Ollama error: ${error.message}` }, 500);
  }

  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse({ error: `Server error: ${message}` }, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function fromFileUrl(url: URL): string {
  return decodeURIComponent(url.pathname);
}
