export interface ChatMessage {
  role: string;
  content: string;
}

export interface ChatResponse {
  message: {
    content: string;
  };
}

export interface ChatStreamChunk {
  message?: {
    content?: string;
  };
  done?: boolean;
}

export interface ModelInfo {
  model: string;
}

export interface ModelListResponse {
  models: ModelInfo[];
}

export interface OllamaClient {
  chat(
    input: { model: string; messages: ChatMessage[] },
  ): Promise<ChatResponse>;
  chatStream(
    input: { model: string; messages: ChatMessage[] },
  ): AsyncIterable<ChatStreamChunk>;
  list(): Promise<ModelListResponse>;
}

export class OllamaClientError extends Error {}

export class HttpOllamaClient implements OllamaClient {
  constructor(private readonly baseUrl: string) {}

  async chat(
    input: { model: string; messages: ChatMessage[] },
  ): Promise<ChatResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new OllamaClientError(await readErrorMessage(response));
    }

    const data = await response.json();
    return {
      message: {
        content: data.message?.content ?? '',
      },
    };
  }

  async *chatStream(
    input: { model: string; messages: ChatMessage[] },
  ): AsyncIterable<ChatStreamChunk> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new OllamaClientError(await readErrorMessage(response));
    }

    if (!response.body) {
      throw new OllamaClientError('Ollama stream body missing');
    }

    yield* readNdjsonStream(response.body);
  }

  async list(): Promise<ModelListResponse> {
    const response = await fetch(`${this.baseUrl}/api/tags`);

    if (!response.ok) {
      throw new OllamaClientError(await readErrorMessage(response));
    }

    const data = await response.json();
    const models = Array.isArray(data.models)
      ? data.models.map((model: { model?: string; name?: string }) => ({
        model: model.model ?? model.name ?? '',
      })).filter((model: ModelInfo) => model.model.length > 0)
      : [];

    return { models };
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const data = await response.json();
    if (typeof data?.error === 'string') {
      return data.error;
    }
  } catch {
    // Fall through to status text.
  }

  return response.statusText || `HTTP ${response.status}`;
}

async function* readNdjsonStream(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<ChatStreamChunk> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');

      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (line) {
          yield JSON.parse(line);
        }

        newlineIndex = buffer.indexOf('\n');
      }
    }

    buffer += decoder.decode();
    const trailingLine = buffer.trim();
    if (trailingLine) {
      yield JSON.parse(trailingLine);
    }
  } finally {
    reader.releaseLock();
  }
}
