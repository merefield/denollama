import {
  h,
  render,
} from './vendor/preact.module.js';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from './vendor/preact-hooks.module.js';
import htm from './vendor/htm.module.js';
import { marked } from './vendor/marked.esm.js';

const API_KEY_STORAGE_KEY = 'llm-api-key';
const CHAT_STORAGE_KEY = 'llm-chats';
const STREAMING_STORAGE_KEY = 'llm-streaming-enabled';
const SYSTEM_PROMPT_STORAGE_KEY = 'llm-system-prompt';
const html = htm.bind(h);
const MATH_PLACEHOLDER_PREFIX = '@@MATHJAX_PLACEHOLDER_';
const DISPLAY_MATH_PATTERN = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]/g;
const DISPLAY_ENV_NAMES =
  'align\\*?|aligned|array|bmatrix|Bmatrix|cases|matrix|pmatrix|smallmatrix|vmatrix|Vmatrix|gather\\*?|gathered|equation\\*?|multline\\*?';
const SELF_DISPLAY_ENV_NAMES =
  'align\\*?|gather\\*?|equation\\*?|multline\\*?';
const BARE_DISPLAY_ENV_PATTERN = new RegExp(
  String.raw`\\begin\{(${DISPLAY_ENV_NAMES})\}(?:\{[^{}]*\})?[\s\S]+?\\end\{\1\}`,
  'g',
);
const INLINE_MATH_PATTERN =
  /\\\([\s\S]+?\\\)|(?<!\\)\$(?!\$)(?:\\.|[^$\n\\])+(?<!\\)\$/g;
const DEFAULT_SYSTEM_PROMPT = `Be concise, technically accurate, and use clean Markdown.

For math:
- Use inline math only for short expressions inside sentences.
- Put full equations, derivations, systems of equations, and multi-line working in display math using \\[ ... \\] or $$ ... $$.
- Do not emit bare TeX environments like \\begin{aligned}...\\end{aligned} or \\begin{array}...\\end{array}; wrap them in display math.
- Put each display equation or derivation block on its own line.

When asked to solve something, show the working clearly step by step.`;
const COPY_BUTTON_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M9 9h9v11H9z"></path>
    <path d="M6 4h9v2H8v9H6z"></path>
  </svg>
`;
let mathTypesetQueue = Promise.resolve();
const pendingMathContainers = new Set();

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

function readStreamingPreference() {
  const stored = localStorage.getItem(STREAMING_STORAGE_KEY);
  return stored === null ? true : stored !== 'false';
}

function writeStreamingPreference(enabled) {
  localStorage.setItem(STREAMING_STORAGE_KEY, String(enabled));
}

function readSystemPrompt() {
  const stored = localStorage.getItem(SYSTEM_PROMPT_STORAGE_KEY);
  return stored && stored.trim() ? stored : DEFAULT_SYSTEM_PROMPT;
}

function writeSystemPrompt(prompt) {
  localStorage.setItem(SYSTEM_PROMPT_STORAGE_KEY, prompt);
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

function createMathPlaceholder(placeholders, expression, display) {
  const placeholder = `${MATH_PLACEHOLDER_PREFIX}${placeholders.length}@@`;
  placeholders.push({ placeholder, expression, display });
  return placeholder;
}

function isStandaloneInlineMathExpression(content) {
  if (!content) {
    return false;
  }

  const trimmed = content.trim();
  if (trimmed.startsWith('$$') || trimmed.startsWith('\\[')) {
    return false;
  }

  return (
    (trimmed.startsWith('$') && trimmed.endsWith('$')) ||
    (trimmed.startsWith('\\(') && trimmed.endsWith('\\)'))
  );
}

function isolateStandaloneMathLines(content) {
  return content.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!isStandaloneInlineMathExpression(trimmed)) {
      return line;
    }

    return `\n${trimmed}\n`;
  }).join('\n');
}

function stripMathDelimiters(expression) {
  const trimmed = expression.trim();

  if (trimmed.startsWith('$$') && trimmed.endsWith('$$')) {
    return trimmed.slice(2, -2).trim();
  }

  if (trimmed.startsWith('\\[') && trimmed.endsWith('\\]')) {
    return trimmed.slice(2, -2).trim();
  }

  if (trimmed.startsWith('\\(') && trimmed.endsWith('\\)')) {
    return trimmed.slice(2, -2).trim();
  }

  if (trimmed.startsWith('$') && trimmed.endsWith('$')) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function isSelfDisplayMathEnvironment(content) {
  return new RegExp(String.raw`\\begin\{(?:${SELF_DISPLAY_ENV_NAMES})\}`)
    .test(content);
}

function toDisplayMathExpression(expression) {
  const trimmed = expression.trim();
  if (
    (trimmed.startsWith('$$') && trimmed.endsWith('$$')) ||
    (trimmed.startsWith('\\[') && trimmed.endsWith('\\]'))
  ) {
    return trimmed;
  }

  const inner = stripMathDelimiters(expression);
  if (isSelfDisplayMathEnvironment(inner)) {
    return inner;
  }

  return `\\[${inner}\\]`;
}

function replaceParagraphPlaceholder(result, placeholder, replacement) {
  return result.replace(
    new RegExp(`<p>\\s*${placeholder}\\s*</p>`, 'g'),
    `<div class="math-display">${replacement}</div>`,
  );
}

function preserveMathExpressions(content) {
  const placeholders = [];
  const markdown = content.split(/(```[\s\S]*?```)/g).map((segment) => {
    if (segment.startsWith('```')) {
      return segment;
    }

    const normalizedSegment = isolateStandaloneMathLines(segment);

    return normalizedSegment.split(/(`[^`\n]*`)/g).map((inlineSegment) => {
      if (
        inlineSegment.startsWith('`') && inlineSegment.endsWith('`')
      ) {
        return inlineSegment;
      }

      const withDisplayMathIsolated = inlineSegment.replace(
        DISPLAY_MATH_PATTERN,
        (match) =>
          `\n\n${createMathPlaceholder(placeholders, match, true)}\n\n`,
      );

      const withBareDisplayEnvironmentsIsolated = withDisplayMathIsolated
        .replace(
          BARE_DISPLAY_ENV_PATTERN,
          (match) =>
            `\n\n${createMathPlaceholder(placeholders, match, true)}\n\n`,
        );

      return withBareDisplayEnvironmentsIsolated.replace(
        INLINE_MATH_PATTERN,
        (match) => createMathPlaceholder(placeholders, match, false),
      );
    }).join('');
  }).join('');

  return { markdown, placeholders };
}

function restoreMathExpressions(htmlContent, placeholders) {
  return placeholders.reduce((result, entry) => {
    if (entry.display) {
      const replacement = toDisplayMathExpression(entry.expression);
      return replaceParagraphPlaceholder(result, entry.placeholder, replacement)
        .split(entry.placeholder)
        .join(`<div class="math-display">${replacement}</div>`);
    }

    const displayReplacement = toDisplayMathExpression(entry.expression);
    return replaceParagraphPlaceholder(result, entry.placeholder, displayReplacement)
      .split(entry.placeholder)
      .join(entry.expression);
  }, htmlContent);
}

function markdownToHtml(content) {
  const { markdown, placeholders } = preserveMathExpressions(content);

  return {
    __html: restoreMathExpressions(marked.parse(markdown), placeholders),
  };
}

function containsRenderableMath(content) {
  return new RegExp(
    String.raw`(?:\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\\begin\{(?:${DISPLAY_ENV_NAMES})\}(?:\{[^{}]*\})?[\s\S]+?\\end\{(?:${DISPLAY_ENV_NAMES})\}|(?<!\\)\$(?!\$)(?:\\.|[^$\n\\])+(?<!\\)\$)`,
    'm',
  )
    .test(content);
}

function queueMathTypeset(containers) {
  const mathJax = globalThis.MathJax;
  if (!mathJax?.typesetPromise || containers.length === 0) {
    return;
  }

  mathTypesetQueue = mathTypesetQueue
    .catch(() => {})
    .then(() => {
      mathJax.typesetClear?.(containers);
      return mathJax.typesetPromise(containers);
    })
    .catch((error) => {
      console.error('MathJax typeset failed:', error);
    });
}

function flushPendingMathTypeset() {
  const containers = [...pendingMathContainers].filter((container) =>
    document.body.contains(container)
  );

  pendingMathContainers.clear();
  queueMathTypeset(containers);
}

globalThis.addEventListener('mathjax-ready', flushPendingMathTypeset);

function typesetMath(container, content) {
  if (!container || !containsRenderableMath(content)) {
    pendingMathContainers.delete(container);
    return;
  }

  if (!globalThis.MathJax?.typesetPromise) {
    pendingMathContainers.add(container);
    return;
  }

  pendingMathContainers.delete(container);
  queueMathTypeset([container]);
}

async function* readNdjsonEvents(stream) {
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

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.top = '-9999px';
  document.body.appendChild(textArea);
  textArea.select();

  try {
    document.execCommand('copy');
  } finally {
    textArea.remove();
  }
}

function enhanceCodeBlocks(container) {
  const codeBlocks = container.querySelectorAll('pre');

  codeBlocks.forEach((pre) => {
    if (pre.dataset.copyEnhanced === 'true') {
      return;
    }

    const code = pre.querySelector('code');
    if (!code || !pre.parentNode) {
      return;
    }

    pre.dataset.copyEnhanced = 'true';

    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-code-btn';
    button.innerHTML = COPY_BUTTON_ICON;
    button.setAttribute('aria-label', 'Copy code');
    button.title = 'Copy code';

    let resetTimerId = null;

    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();

      try {
        await copyTextToClipboard(code.textContent ?? '');
        button.classList.add('copied');
        button.setAttribute('aria-label', 'Copied');
        button.title = 'Copied';

        if (resetTimerId) {
          clearTimeout(resetTimerId);
        }

        resetTimerId = setTimeout(() => {
          button.classList.remove('copied');
          button.setAttribute('aria-label', 'Copy code');
          button.title = 'Copy code';
          resetTimerId = null;
        }, 2000);
      } catch (error) {
        console.error('Failed to copy code block:', error);
      }
    });

    wrapper.appendChild(button);
  });
}

function chatPreview(chat) {
  const lastMessage = chat.messages[chat.messages.length - 1];
  if (!lastMessage) {
    return 'Empty chat';
  }

  return lastMessage.content.substring(0, 60) + '...';
}

function slugifyFilenamePart(value, fallback = 'chat') {
  const normalized = (value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || fallback;
}

function buildExportFilename(chat, format) {
  const titlePart = slugifyFilenamePart(chat.title || deriveChatTitle(chat));
  const datePart = new Date().toISOString().slice(0, 10);
  const extension = format === 'json' ? 'json' : 'md';
  return `${titlePart}-${datePart}.${extension}`;
}

function buildMarkdownExport(chat) {
  const lines = [
    `# ${chat.title || deriveChatTitle(chat)}`,
    '',
    `- Model: ${chat.model || 'Unknown'}`,
    `- Timestamp: ${chat.timestamp || 'Unknown'}`,
    `- Messages: ${chat.messages.length}`,
    '',
    '---',
    '',
  ];

  chat.messages.forEach((message, index) => {
    const heading = message.role === 'user' ? 'User' : 'Assistant';
    lines.push(`## ${heading}`);
    lines.push('');
    lines.push(message.content || '');

    if (index < chat.messages.length - 1) {
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  });

  return `${lines.join('\n').trim()}\n`;
}

function buildJsonExport(chat) {
  return JSON.stringify({
    title: chat.title || deriveChatTitle(chat),
    model: chat.model || null,
    timestamp: chat.timestamp || null,
    exported_at: new Date().toISOString(),
    messages: chat.messages,
  }, null, 2);
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Message({ message, shouldTypesetMath }) {
  if (message.role === 'assistant' && !message.content) {
    return null;
  }

  const contentRef = useRef(null);

  useEffect(() => {
    if (message.role === 'assistant' && contentRef.current) {
      enhanceCodeBlocks(contentRef.current);

      if (shouldTypesetMath && !message.streaming) {
        typesetMath(contentRef.current, message.content);
      }
    }
  }, [message.content, message.role, message.streaming, shouldTypesetMath]);

  return html`
    <div class="${`message ${message.role}`}">
      <div class="message-header">
        ${message.role === 'user' ? 'You' : 'Assistant'}
      </div>
      ${message.role === 'assistant'
        ? html`
          <div
            ref="${contentRef}"
            class="message-content"
            dangerouslySetInnerHTML="${markdownToHtml(message.content)}"
          />
        `
        : html`
          <div ref="${contentRef}" class="message-content">${message.content}</div>
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
    streamingEnabled,
    status,
    onSelectModel,
    onStreamingToggle,
    onOpenSystemPromptDialog,
    onNewChat,
    onLoadChat,
    onDeleteChat,
  },
) {
  const selectorDisabled = status.kind !== 'normal' ||
    availableModels.length === 0;

  return html`
    <aside class="sidebar">
      <div class="sidebar-header">
        <h2>Denollama</h2>
        <p class="sidebar-subtitle">Lightweight LLM Chat Interface</p>
      </div>

      <div class="model-selector">
        <h3 class="sidebar-section-title">Model</h3>
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
        <h3 class="sidebar-section-title">Previous Chats</h3>
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
                >
                  <button
                    type="button"
                    class="chat-item-main"
                    onClick="${() => onLoadChat(chat.id)}"
                  >
                    <div class="chat-item-title">${chat.title ||
                      'Untitled Chat'}</div>
                    <div class="chat-item-preview">${chatPreview(chat)}</div>
                  </button>
                  <button
                    type="button"
                    class="chat-delete-btn"
                    aria-label="${`Delete ${chat.title || 'chat'}`}"
                    title="Delete chat"
                    onClick="${(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onDeleteChat(chat);
                    }}"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M9 3h6l1 2h4v2H4V5h4z"></path>
                      <path d="M7 8h10l-.8 11.2A2 2 0 0 1 14.2 21H9.8a2 2 0 0 1-2-1.8z"></path>
                    </svg>
                  </button>
                </div>
              `
            )}
        </div>
      </div>

      <div class="sidebar-footer">
        <h3 class="sidebar-section-title">Settings</h3>
        <label class="sidebar-toggle">
          <input
            type="checkbox"
            checked="${streamingEnabled}"
            onChange="${(event) =>
              onStreamingToggle(event.currentTarget.checked)}"
          />
          <div class="sidebar-toggle-text">
            <span>Streaming</span>
            <small>Stream replies as they arrive</small>
          </div>
        </label>
        <button
          type="button"
          class="sidebar-secondary-btn"
          onClick="${onOpenSystemPromptDialog}"
        >
          System Prompt
        </button>
      </div>
    </aside>
  `;
}

function ConfirmDialog(
  { title, message, confirmLabel, cancelLabel, onConfirm, onCancel },
) {
  return html`
    <div class="dialog-backdrop" onClick="${onCancel}">
      <div
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onClick="${(event) => event.stopPropagation()}"
      >
        <h2 id="dialog-title">${title}</h2>
        <p class="dialog-message">${message}</p>
        <div class="dialog-actions">
          <button type="button" class="dialog-btn dialog-btn-secondary" onClick="${onCancel}">
            ${cancelLabel}
          </button>
          <button type="button" class="dialog-btn dialog-btn-danger" onClick="${onConfirm}">
            ${confirmLabel}
          </button>
        </div>
      </div>
    </div>
  `;
}

function ExportDialog(
  { format, onFormatChange, onConfirm, onCancel },
) {
  return html`
    <div class="dialog-backdrop" onClick="${onCancel}">
      <div
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        onClick="${(event) => event.stopPropagation()}"
      >
        <h2 id="export-dialog-title">Export chat</h2>
        <p class="dialog-message">
          Choose the format to save this conversation.
        </p>
        <label class="dialog-field" for="export-format">
          <span>Format</span>
          <select
            id="export-format"
            value="${format}"
            onChange="${(event) => onFormatChange(event.currentTarget.value)}"
          >
            <option value="markdown">Markdown (.md)</option>
            <option value="json">JSON (.json)</option>
          </select>
        </label>
        <div class="dialog-actions">
          <button type="button" class="dialog-btn dialog-btn-secondary" onClick="${onCancel}">
            Cancel
          </button>
          <button type="button" class="dialog-btn dialog-btn-primary" onClick="${onConfirm}">
            Export
          </button>
        </div>
      </div>
    </div>
  `;
}

function SystemPromptDialog(
  { value, onChange, onResetDefault, onConfirm, onCancel },
) {
  return html`
    <div class="dialog-backdrop" onClick="${onCancel}">
      <div
        class="dialog dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="system-prompt-dialog-title"
        onClick="${(event) => event.stopPropagation()}"
      >
        <h2 id="system-prompt-dialog-title">System prompt</h2>
        <p class="dialog-message">
          This prompt is prepended to chat requests before recent conversation context.
        </p>
        <label class="dialog-field" for="system-prompt-input">
          <span>Prompt</span>
          <textarea
            id="system-prompt-input"
            class="dialog-textarea"
            rows="14"
            value="${value}"
            onInput="${(event) => onChange(event.currentTarget.value)}"
          ></textarea>
        </label>
        <div class="dialog-actions dialog-actions-spread">
          <button type="button" class="dialog-btn dialog-btn-secondary" onClick="${onResetDefault}">
            Revert to default
          </button>
          <div class="dialog-actions-group">
            <button type="button" class="dialog-btn dialog-btn-secondary" onClick="${onCancel}">
              Cancel
            </button>
            <button type="button" class="dialog-btn dialog-btn-primary" onClick="${onConfirm}">
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
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
    onOpenExportDialog,
  },
) {
  const chatRef = useRef(null);
  const lastAssistantIndex = [...currentChat.messages].reduceRight(
    (foundIndex, message, index) =>
      foundIndex === -1 && message.role === 'assistant' ? index : foundIndex,
    -1,
  );

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
        <${Message}
          key="${message.role === 'assistant' && index === lastAssistantIndex
            ? `${index}-${message.role}-${message.streaming ? 'streaming' : 'final'}`
            : `${index}-${message.role}`}"
          message="${message}"
          shouldTypesetMath="${index === lastAssistantIndex}"
        />
      `
    );
  }

  return html`
    <main class="main-content">
      <div class="chat-toolbar">
        <button
          type="button"
          class="toolbar-btn"
          onClick="${onOpenExportDialog}"
          disabled="${currentChat.messages.length === 0}"
        >
          Export
        </button>
      </div>
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
  const [streamingEnabled, setStreamingEnabled] = useState(() =>
    readStreamingPreference()
  );
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState({ kind: 'normal', message: '' });
  const [retryPending, setRetryPending] = useState(false);
  const [chatPendingDelete, setChatPendingDelete] = useState(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState('markdown');
  const [systemPrompt, setSystemPrompt] = useState(() => readSystemPrompt());
  const [systemPromptDraft, setSystemPromptDraft] = useState('');
  const [systemPromptDialogOpen, setSystemPromptDialogOpen] = useState(false);

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

  async function sendNonStreamingMessage(
    draftChat,
    trimmedPrompt,
    contextMessages,
  ) {
    const { response, data } = await fetchJson('/api/v1/response', {
      method: 'POST',
      headers: getApiHeaders(apiKey, true),
      body: JSON.stringify({
        prompt: trimmedPrompt,
        model: selectedModel,
        context: contextMessages,
        system_prompt: systemPrompt,
        stream: false,
      }),
    });

    if (response.status === 401) {
      handleUnauthorized('Session expired. Please enter your API key again.');
      return null;
    }

    if (!response.ok) {
      throw new Error(data.error || 'Unknown error occurred');
    }

    return {
      ...draftChat,
      messages: [
        ...draftChat.messages,
        { role: 'assistant', content: data.response },
      ],
    };
  }

  async function sendStreamingMessage(
    draftChat,
    trimmedPrompt,
    contextMessages,
  ) {
    let streamedContent = '';
    let nextChat = {
      ...draftChat,
      messages: [
        ...draftChat.messages,
        { role: 'assistant', content: '', streaming: true },
      ],
    };

    setCurrentChat(nextChat);

    const response = await fetch('/api/v1/response', {
      method: 'POST',
      headers: getApiHeaders(apiKey, true),
      body: JSON.stringify({
        prompt: trimmedPrompt,
        model: selectedModel,
        context: contextMessages,
        system_prompt: systemPrompt,
        stream: true,
      }),
    });

    if (response.status === 401) {
      handleUnauthorized('Session expired. Please enter your API key again.');
      return null;
    }

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Unknown error occurred');
    }

    if (!response.body) {
      throw new Error('Stream unavailable');
    }

    for await (const event of readNdjsonEvents(response.body)) {
      if (event.error) {
        throw new Error(event.error);
      }

      if (typeof event.delta === 'string') {
        streamedContent += event.delta;
        nextChat = {
          ...draftChat,
          messages: [
            ...draftChat.messages,
            { role: 'assistant', content: streamedContent, streaming: true },
          ],
        };
        setCurrentChat(nextChat);
      }

      if (event.done && typeof event.response === 'string') {
        streamedContent = event.response;
      }
    }

    return {
      ...draftChat,
      messages: [
        ...draftChat.messages,
        { role: 'assistant', content: streamedContent, streaming: false },
      ],
    };
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
      let nextChat = streamingEnabled
        ? await sendStreamingMessage(draftChat, trimmedPrompt, contextMessages)
        : await sendNonStreamingMessage(
          draftChat,
          trimmedPrompt,
          contextMessages,
        );

      if (!nextChat) {
        return;
      }

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
          {
            role: 'assistant',
            content: `Error: ${error.message}`,
          },
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

  function handleRequestDeleteChat(chat) {
    setChatPendingDelete(chat);
  }

  function handleCancelDeleteChat() {
    setChatPendingDelete(null);
  }

  function handleConfirmDeleteChat() {
    if (!chatPendingDelete) {
      return;
    }

    const chatId = chatPendingDelete.id;
    setChats((currentChats) => {
      const nextChats = currentChats.filter((chat) => chat.id !== chatId);
      writeChatsToStorage(nextChats);
      return nextChats;
    });

    if (currentChat.id === chatId) {
      setCurrentChat(createEmptyChat({
        id: Date.now(),
        model: selectedModel,
        timestamp: new Date().toISOString(),
      }));
      setPrompt('');
    }

    setChatPendingDelete(null);
  }

  function handleOpenExportDialog() {
    if (currentChat.messages.length === 0) {
      return;
    }

    setExportFormat('markdown');
    setExportDialogOpen(true);
  }

  function handleCancelExport() {
    setExportDialogOpen(false);
  }

  function handleConfirmExport() {
    if (currentChat.messages.length === 0) {
      setExportDialogOpen(false);
      return;
    }

    const filename = buildExportFilename(currentChat, exportFormat);
    if (exportFormat === 'json') {
      downloadTextFile(
        filename,
        buildJsonExport(currentChat),
        'application/json;charset=utf-8',
      );
    } else {
      downloadTextFile(
        filename,
        buildMarkdownExport(currentChat),
        'text/markdown;charset=utf-8',
      );
    }

    setExportDialogOpen(false);
  }

  function handleOpenSystemPromptDialog() {
    setSystemPromptDraft(systemPrompt);
    setSystemPromptDialogOpen(true);
  }

  function handleCancelSystemPromptDialog() {
    setSystemPromptDialogOpen(false);
  }

  function handleResetSystemPromptDefault() {
    setSystemPromptDraft(DEFAULT_SYSTEM_PROMPT);
  }

  function handleSaveSystemPrompt() {
    const nextPrompt = systemPromptDraft.trim() || DEFAULT_SYSTEM_PROMPT;
    setSystemPrompt(nextPrompt);
    writeSystemPrompt(nextPrompt);
    setSystemPromptDialogOpen(false);
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
        streamingEnabled="${streamingEnabled}"
        status="${status}"
        onSelectModel="${setSelectedModel}"
        onStreamingToggle="${(enabled) => {
          setStreamingEnabled(enabled);
          writeStreamingPreference(enabled);
        }}"
        onOpenSystemPromptDialog="${handleOpenSystemPromptDialog}"
        onNewChat="${handleNewChat}"
        onLoadChat="${handleLoadChat}"
        onDeleteChat="${handleRequestDeleteChat}"
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
        onOpenExportDialog="${handleOpenExportDialog}"
      />
      ${chatPendingDelete
        ? html`
          <${ConfirmDialog}
            title="Delete chat?"
            message="${`Delete \"${
              chatPendingDelete.title || 'Untitled Chat'
            }\" from chat history? This cannot be undone.`}"
            confirmLabel="Delete"
            cancelLabel="Cancel"
            onConfirm="${handleConfirmDeleteChat}"
            onCancel="${handleCancelDeleteChat}"
          />
        `
        : null}
      ${exportDialogOpen
        ? html`
          <${ExportDialog}
            format="${exportFormat}"
            onFormatChange="${setExportFormat}"
            onConfirm="${handleConfirmExport}"
            onCancel="${handleCancelExport}"
          />
        `
        : null}
      ${systemPromptDialogOpen
        ? html`
          <${SystemPromptDialog}
            value="${systemPromptDraft}"
            onChange="${setSystemPromptDraft}"
            onResetDefault="${handleResetSystemPromptDefault}"
            onConfirm="${handleSaveSystemPrompt}"
            onCancel="${handleCancelSystemPromptDialog}"
          />
        `
        : null}
    </div>
  `;
}

render(
  html`
    <${App} />
  `,
  document.getElementById('app'),
);
