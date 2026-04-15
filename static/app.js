import {
  html,
  render,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'https://esm.sh/htm/preact/standalone';

const API_KEY_STORAGE_KEY = 'llm-api-key';
const CHAT_STORAGE_KEY = 'llm-chats';

function createEmptyChat(overrides = {}) {
  return {
    id: null,
    messages: [],
    title: null,
    model: null,
    timestamp: null,
    ...overrides,
  };
}

function getApiHeaders(apiKey, includeContentType = false) {
  const headers = {};

  if (includeContentType) {
    headers['Content-Type'] = 'application/json';
  }

  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  return headers;
}

async function checkAuthRequirement() {
  try {
    const response = await fetch('/api/v1/auth-required');
    if (!response.ok) {
      return true;
    }

    const data = await response.json();
    return Boolean(data.auth_required);
  } catch (error) {
    console.error('Failed to determine auth requirement:', error);
    return true;
  }
}

async function validateApiKey(apiKey) {
  try {
    const response = await fetch('/api/v1/models', {
      headers: getApiHeaders(apiKey),
    });

    return response.status !== 401;
  } catch (error) {
    console.error('Error validating API key:', error);
    return false;
  }
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function readChatsFromStorage() {
  try {
    const stored = localStorage.getItem(CHAT_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error('Error loading from localStorage:', error);
    return [];
  }
}

function writeChatsToStorage(chats) {
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chats));
  } catch (error) {
    console.error('Error saving to localStorage:', error);
  }
}

function clearStoredApiKey() {
  localStorage.removeItem(API_KEY_STORAGE_KEY);
}

function storeApiKey(apiKey) {
  localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
}

function getStoredApiKey() {
  return localStorage.getItem(API_KEY_STORAGE_KEY) ?? '';
}

function buildTitleFallback(prompt) {
  return prompt.substring(0, 50) + (prompt.length > 50 ? '...' : '');
}

function deriveChatTitle(chat) {
  const firstUserMessage = chat.messages.find((message) =>
    message.role === 'user'
  );
  return firstUserMessage
    ? buildTitleFallback(firstUserMessage.content)
    : 'Untitled Chat';
}

function materializeChat(chat, selectedModel) {
  if (chat.messages.length === 0) {
    return {
      ...chat,
      model: chat.model ?? selectedModel,
    };
  }

  const nextChat = {
    ...chat,
    id: chat.id ?? Date.now(),
    timestamp: chat.timestamp ?? new Date().toISOString(),
    model: chat.model ?? selectedModel,
  };

  if (!nextChat.title) {
    nextChat.title = deriveChatTitle(nextChat);
  }

  return nextChat;
}

function upsertChat(chats, chat) {
  if (chat.messages.length === 0) {
    return chats;
  }

  const existingIndex = chats.findIndex((entry) => entry.id === chat.id);
  if (existingIndex !== -1) {
    const nextChats = [...chats];
    nextChats[existingIndex] = chat;
    return nextChats;
  }

  return [chat, ...chats].slice(0, 50);
}

function markdownToHtml(content) {
  return {
    __html: globalThis.marked?.parse?.(content) ?? content,
  };
}

function chatPreview(chat) {
  const lastMessage = chat.messages[chat.messages.length - 1];
  if (!lastMessage) {
    return 'Empty chat';
  }

  return lastMessage.content.substring(0, 60) + '...';
}

function Message({ message }) {
  return html`
    <div class="${`message ${message.role}`}">
      <div class="message-header">
        ${message.role === 'user' ? 'You' : 'Assistant'}
      </div>
      ${message.role === 'assistant'
        ? html`
          <div
            class="message-content"
            dangerouslySetInnerHTML="${markdownToHtml(message.content)}"
          />
        `
        : html`
          <div class="message-content">${message.content}</div>
        `}
    </div>
  `;
}

function LoadingIndicator() {
  return html`
    <div class="loading-indicator">
      <div class="loading-dots">
        <span></span>
        <span></span>
        <span></span>
      </div>
      <span>Thinking...</span>
    </div>
  `;
}

function ErrorPanel(
  {
    icon,
    title,
    message,
    steps,
    buttonLabel,
    buttonBusyLabel,
    onRetry,
    retryPending,
  },
) {
  return html`
    <div class="error-page">
      <div class="error-icon">${icon}</div>
      <h1>${title}</h1>
      <p class="error-message">${message}</p>
      <div class="error-instructions">
        <h3>To fix this:</h3>
        <ol>
          ${steps.map((step) =>
            html`
              <li>${step}</li>
            `
          )}
        </ol>
      </div>
      <button class="retry-btn" onClick="${onRetry}" disabled="${retryPending}">
        ${retryPending ? buttonBusyLabel : buttonLabel}
      </button>
    </div>
  `;
}

function Sidebar(
  {
    chats,
    currentChatId,
    availableModels,
    selectedModel,
    status,
    onSelectModel,
    onNewChat,
    onLoadChat,
  },
) {
  const selectorDisabled = status.kind !== 'normal' ||
    availableModels.length === 0;

  return html`
    <aside class="sidebar">
      <div class="sidebar-header">
        <h2>LLM Chat</h2>
      </div>

      <div class="model-selector">
        <label for="model-select">Model:</label>
        <select
          id="model-select"
          value="${selectedModel}"
          onChange="${(event) => onSelectModel(event.currentTarget.value)}"
          disabled="${selectorDisabled}"
        >
          ${status.kind === 'ollama-error'
            ? html`
              <option value="">Ollama not available</option>
            `
            : status.kind === 'no-models'
            ? html`
              <option value="">No models available</option>
            `
            : availableModels.length === 0
            ? html`
              <option value="">Loading...</option>
            `
            : availableModels.map((model) =>
              html`
                <option value="${model}">${model}</option>
              `
            )}
        </select>
      </div>

      <button id="new-chat-btn" class="new-chat-btn" onClick="${onNewChat}">
        + New Chat
      </button>

      <div class="chat-history">
        <h3>Previous Chats</h3>
        <div id="previous-chats">
          ${chats.length === 0
            ? html`
              <p class="sidebar-empty">No previous chats</p>
            `
            : chats.map((chat) =>
              html`
                <div
                  class="${`chat-item ${
                    chat.id === currentChatId ? 'active' : ''
                  }`}"
                  onClick="${() => onLoadChat(chat.id)}"
                >
                  <div class="chat-item-title">${chat.title ||
                    'Untitled Chat'}</div>
                  <div class="chat-item-preview">${chatPreview(chat)}</div>
                </div>
              `
            )}
        </div>
      </div>
    </aside>
  `;
}

function LoginScreen(
  { loginValue, loginError, loginPending, onChange, onSubmit },
) {
  return html`
    <div class="login-container">
      <div class="login-form">
        <h1>API Key Required</h1>
        <p class="login-description">
          Please enter your API key to access the chat interface.
        </p>
        <form onSubmit="${onSubmit}">
          <input
            type="password"
            id="api-key-input"
            value="${loginValue}"
            placeholder="Enter API key"
            required
            autocomplete="off"
            autoFocus
            onInput="${(event) => onChange(event.currentTarget.value)}"
          />
          ${loginError
            ? html`
              <div class="login-error">${loginError}</div>
            `
            : null}
          <button type="submit" class="login-submit-btn" disabled="${loginPending}">
            ${loginPending ? 'Connecting...' : 'Connect'}
          </button>
        </form>
      </div>
    </div>
  `;
}

function ChatArea(
  {
    currentChat,
    isLoading,
    prompt,
    inputDisabled,
    status,
    retryPending,
    onRetry,
    onPromptChange,
    onPromptKeyDown,
    onSendMessage,
  },
) {
  const chatRef = useRef(null);

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [currentChat.messages.length, isLoading, status.kind]);

  let content = null;

  if (status.kind === 'ollama-error') {
    content = html`
      <${ErrorPanel}
        icon="⚠️"
        title="Ollama Not Available"
        message="${status.message || 'Failed to connect to Ollama'}"
        steps="${[
          html`
            Make sure Ollama is installed. If not, download it from <a
              href="https://ollama.com/download"
              target="_blank"
            >ollama.com/download</a>
          `,
          html`
            Start Ollama by running: <code>ollama serve</code>
          `,
          'Or if using the desktop app, make sure it is running',
          'Click the retry button below once Ollama is running',
        ]}"
        buttonLabel="🔄 Retry Connection"
        buttonBusyLabel="Connecting..."
        retryPending="${retryPending}"
        onRetry="${onRetry}"
      />
    `;
  } else if (status.kind === 'no-models') {
    content = html`
      <${ErrorPanel}
        icon="📦"
        title="No Models Available"
        message="Ollama is running, but no models are installed."
        steps="${[
          'Open a terminal',
          html`
            Run: <code>ollama pull llama2</code>
          `,
          html`
            Or choose another model from <a
              href="https://ollama.com/library"
              target="_blank"
            >ollama.com/library</a>
          `,
          'Click the retry button below once a model is installed',
        ]}"
        buttonLabel="🔄 Retry Connection"
        buttonBusyLabel="Checking..."
        retryPending="${retryPending}"
        onRetry="${onRetry}"
      />
    `;
  } else if (currentChat.messages.length === 0) {
    content = html`
      <div class="welcome-message">
        <h1>${currentChat.id ? 'New Chat' : 'Welcome to LLM Chat'}</h1>
        <p>${currentChat.id
          ? 'Start a conversation!'
          : 'Select a model and start chatting!'}</p>
      </div>
    `;
  } else {
    content = currentChat.messages.map((message, index) =>
      html`
        <${Message} key="${`${index}-${message.role}`}" message="${message}" />
      `
    );
  }

  return html`
    <main class="main-content">
      <div id="chat-container" class="chat-container" ref="${chatRef}">
        ${content} ${status.kind === 'normal' && isLoading
          ? html`
            <${LoadingIndicator} />
          `
          : null}
      </div>

      <div class="input-area">
        <textarea
          id="user-input"
          placeholder="${status.kind === 'normal'
            ? 'Type your message here...'
            : 'Chat unavailable - Ollama not connected'}"
          rows="3"
          value="${prompt}"
          onInput="${(event) => onPromptChange(event.currentTarget.value)}"
          onKeyDown="${onPromptKeyDown}"
          disabled="${inputDisabled}"
        ></textarea>
        <button
          id="send-btn"
          class="send-btn"
          onClick="${onSendMessage}"
          disabled="${inputDisabled}"
        >
          ${isLoading ? 'Sending...' : 'Send'}
        </button>
      </div>
    </main>
  `;
}

function App() {
  const [screen, setScreen] = useState('boot');
  const [apiKey, setApiKey] = useState('');
  const [loginValue, setLoginValue] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginPending, setLoginPending] = useState(false);
  const [chats, setChats] = useState([]);
  const [currentChat, setCurrentChat] = useState(createEmptyChat());
  const [availableModels, setAvailableModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState({ kind: 'normal', message: '' });
  const [retryPending, setRetryPending] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      const storedChats = readChatsFromStorage();
      if (!cancelled) {
        setChats(storedChats);
      }

      const authRequired = await checkAuthRequirement();
      if (cancelled) {
        return;
      }

      if (!authRequired) {
        setScreen('main');
        await loadModels('', { preserveSelection: false });
        return;
      }

      const storedApiKey = getStoredApiKey();
      setLoginValue(storedApiKey);

      if (storedApiKey && await validateApiKey(storedApiKey)) {
        setApiKey(storedApiKey);
        setScreen('main');
        await loadModels(storedApiKey, { preserveSelection: false });
        return;
      }

      if (storedApiKey) {
        clearStoredApiKey();
      }

      setScreen('login');
    }

    initialize();

    return () => {
      cancelled = true;
    };
  }, []);

  const inputDisabled = useMemo(() => {
    return isLoading || status.kind !== 'normal' ||
      availableModels.length === 0;
  }, [availableModels.length, isLoading, status.kind]);

  async function loadModels(
    activeApiKey,
    { preserveSelection } = { preserveSelection: true },
  ) {
    try {
      const { response, data } = await fetchJson('/api/v1/models', {
        headers: getApiHeaders(activeApiKey),
      });

      if (response.status === 401) {
        handleUnauthorized('Session expired. Please enter your API key again.');
        return false;
      }

      if (data.error) {
        setAvailableModels([]);
        setStatus({ kind: 'ollama-error', message: data.error });
        if (!preserveSelection) {
          setSelectedModel('');
        }
        return false;
      }

      const models = Array.isArray(data.models) ? data.models : [];
      if (models.length === 0) {
        setAvailableModels([]);
        setStatus({ kind: 'no-models', message: '' });
        if (!preserveSelection) {
          setSelectedModel('');
        }
        return false;
      }

      setAvailableModels(models);
      setStatus({ kind: 'normal', message: '' });
      setSelectedModel((currentSelection) => {
        if (
          preserveSelection && currentSelection &&
          models.includes(currentSelection)
        ) {
          return currentSelection;
        }

        if (currentChat.model && models.includes(currentChat.model)) {
          return currentChat.model;
        }

        return models[0];
      });
      return true;
    } catch (error) {
      console.error('Error loading models:', error);
      setAvailableModels([]);
      setStatus({
        kind: 'ollama-error',
        message: 'Failed to connect to server',
      });
      return false;
    }
  }

  function persistCurrentChat(chat) {
    const savedChat = materializeChat(chat, selectedModel);
    if (savedChat.messages.length === 0) {
      return savedChat;
    }

    setChats((currentChats) => {
      const nextChats = upsertChat(currentChats, savedChat);
      writeChatsToStorage(nextChats);
      return nextChats;
    });
    return savedChat;
  }

  function handleUnauthorized(message) {
    clearStoredApiKey();
    setApiKey('');
    setLoginValue('');
    setLoginError(message);
    setLoginPending(false);
    setIsLoading(false);
    setScreen('login');
  }

  async function handleLoginSubmit(event) {
    event.preventDefault();

    const nextApiKey = loginValue.trim();
    if (!nextApiKey) {
      setLoginError('Please enter an API key');
      return;
    }

    setLoginPending(true);
    setLoginError('');

    const valid = await validateApiKey(nextApiKey);
    if (!valid) {
      setLoginPending(false);
      setLoginError('Invalid API key. Please try again.');
      return;
    }

    storeApiKey(nextApiKey);
    setApiKey(nextApiKey);
    setScreen('main');
    setLoginPending(false);
    await loadModels(nextApiKey, { preserveSelection: false });
  }

  async function generateChatTitle(firstPrompt, model) {
    try {
      const { response, data } = await fetchJson('/api/v1/response', {
        method: 'POST',
        headers: getApiHeaders(apiKey, true),
        body: JSON.stringify({
          prompt:
            `Generate a short, concise title (maximum 6 words) for a conversation that starts with this user question: "${firstPrompt}". Only respond with the title, nothing else.`,
          model,
          context: [],
        }),
      });

      if (response.status === 401) {
        handleUnauthorized('Session expired. Please enter your API key again.');
        return null;
      }

      if (!response.ok || !data.response) {
        return null;
      }

      let title = data.response.trim().replace(/^["']|["']$/g, '');
      if (title.length > 50) {
        title = title.substring(0, 50) + '...';
      }
      return title;
    } catch (error) {
      console.error('Error generating chat title:', error);
      return null;
    }
  }

  async function handleSendMessage() {
    const trimmedPrompt = prompt.trim();
    if (
      !trimmedPrompt || !selectedModel || isLoading || status.kind !== 'normal'
    ) {
      return;
    }

    const isFirstMessage = currentChat.messages.length === 0;
    const draftChat = {
      ...currentChat,
      messages: [...currentChat.messages, {
        role: 'user',
        content: trimmedPrompt,
      }],
    };

    setCurrentChat(draftChat);
    setPrompt('');
    setIsLoading(true);

    try {
      const contextMessages = draftChat.messages.slice(-4, -1);
      const { response, data } = await fetchJson('/api/v1/response', {
        method: 'POST',
        headers: getApiHeaders(apiKey, true),
        body: JSON.stringify({
          prompt: trimmedPrompt,
          model: selectedModel,
          context: contextMessages,
        }),
      });

      if (response.status === 401) {
        handleUnauthorized('Session expired. Please enter your API key again.');
        return;
      }

      if (!response.ok) {
        setCurrentChat({
          ...draftChat,
          messages: [
            ...draftChat.messages,
            {
              role: 'assistant',
              content: `Error: ${data.error || 'Unknown error occurred'}`,
            },
          ],
        });
        return;
      }

      let nextChat = {
        ...draftChat,
        messages: [
          ...draftChat.messages,
          { role: 'assistant', content: data.response },
        ],
      };

      if (isFirstMessage) {
        nextChat.title =
          await generateChatTitle(trimmedPrompt, selectedModel) ||
          buildTitleFallback(trimmedPrompt);
      }

      nextChat = persistCurrentChat(nextChat);
      setCurrentChat(nextChat);
    } catch (error) {
      console.error('Error sending message:', error);
      setCurrentChat({
        ...draftChat,
        messages: [
          ...draftChat.messages,
          { role: 'assistant', content: `Error: ${error.message}` },
        ],
      });
    } finally {
      setIsLoading(false);
    }
  }

  function handleNewChat() {
    if (currentChat.messages.length > 0) {
      persistCurrentChat(currentChat);
    }

    setCurrentChat(createEmptyChat({
      id: Date.now(),
      model: selectedModel,
      timestamp: new Date().toISOString(),
    }));
    setPrompt('');
  }

  function handleLoadChat(chatId) {
    if (currentChat.messages.length > 0 && currentChat.id !== chatId) {
      persistCurrentChat(currentChat);
    }

    const chat = chats.find((entry) => entry.id === chatId);
    if (!chat) {
      return;
    }

    setCurrentChat(chat);
    if (chat.model && availableModels.includes(chat.model)) {
      setSelectedModel(chat.model);
    }
  }

  async function handleRetry() {
    setRetryPending(true);
    await loadModels(apiKey);
    setRetryPending(false);
  }

  function handlePromptKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSendMessage();
    }
  }

  if (screen === 'boot') {
    return html`
      <div class="login-container">
        <div class="login-form">
          <h1>Connecting...</h1>
          <p class="login-description">
            Checking configuration and available models.
          </p>
        </div>
      </div>
    `;
  }

  if (screen === 'login') {
    return html`
      <${LoginScreen}
        loginValue="${loginValue}"
        loginError="${loginError}"
        loginPending="${loginPending}"
        onChange="${(value) => {
          setLoginValue(value);
          if (loginError) {
            setLoginError('');
          }
        }}"
        onSubmit="${handleLoginSubmit}"
      />
    `;
  }

  return html`
    <div class="container">
      <${Sidebar}
        chats="${chats}"
        currentChatId="${currentChat.id}"
        availableModels="${availableModels}"
        selectedModel="${selectedModel}"
        status="${status}"
        onSelectModel="${setSelectedModel}"
        onNewChat="${handleNewChat}"
        onLoadChat="${handleLoadChat}"
      />
      <${ChatArea}
        currentChat="${currentChat}"
        isLoading="${isLoading}"
        prompt="${prompt}"
        inputDisabled="${inputDisabled}"
        status="${status}"
        retryPending="${retryPending}"
        onRetry="${handleRetry}"
        onPromptChange="${setPrompt}"
        onPromptKeyDown="${handlePromptKeyDown}"
        onSendMessage="${handleSendMessage}"
      />
    </div>
  `;
}

render(
  html`
    <${App} />
  `,
  document.getElementById('app'),
);
