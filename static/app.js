// State management
let currentChat = {
  id: null,
  messages: [],
  title: null,
};

let chats = [];
let availableModels = [];
let isLoading = false;
let apiKey = null;

// API Key storage key
const API_KEY_STORAGE_KEY = 'llm-api-key';

// DOM elements
const chatContainer = document.getElementById('chat-container');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const modelSelect = document.getElementById('model-select');
const newChatBtn = document.getElementById('new-chat-btn');
const previousChatsContainer = document.getElementById('previous-chats');
const loginContainer = document.getElementById('login-container');
const mainContainer = document.getElementById('main-container');
const loginForm = document.getElementById('login-form');
const apiKeyInput = document.getElementById('api-key-input');
const loginError = document.getElementById('login-error');
const loginSubmitBtn = document.getElementById('login-submit-btn');

// Check if server requires authentication
async function checkAuthRequirement() {
  try {
    const res = await fetch('/api/v1/auth-required');
    if (!res.ok) return true; // Fail safe: assume auth required if endpoint fails
    const data = await res.json();
    return !!data.auth_required;
  } catch (e) {
    console.error('Failed to determine auth requirement:', e);
    return true; // conservative default
  }
}

// Initialize the app
async function init() {
  const authRequired = await checkAuthRequirement();

  if (!authRequired) {
    // Auth not required: go straight to main interface
    showMainInterface();
    loadChatsFromStorage();
    // Populate sidebar with any previously saved chats immediately
    renderPreviousChats();
    await loadModels();
    setupEventListeners();
    return; // Skip login listeners
  }

  // Auth required path
  apiKey = localStorage.getItem(API_KEY_STORAGE_KEY);
  if (apiKey) {
    const isValid = await validateApiKey(apiKey);
    if (isValid) {
      showMainInterface();
      loadChatsFromStorage();
      // Populate sidebar with previous chats before loading models
      renderPreviousChats();
      await loadModels();
      setupEventListeners();
    } else {
      clearApiKey();
      showLoginForm();
    }
  } else {
    showLoginForm();
  }
  setupLoginListeners();
}

// Setup login form event listeners
function setupLoginListeners() {
  loginForm.addEventListener('submit', handleLogin);
}

// Show login form
function showLoginForm() {
  loginContainer.style.display = 'flex';
  mainContainer.style.display = 'none';
  apiKeyInput.focus();
}

// Show main interface
function showMainInterface() {
  loginContainer.style.display = 'none';
  mainContainer.style.display = 'flex';
}

// Handle login form submission
async function handleLogin(event) {
  event.preventDefault();

  const key = apiKeyInput.value.trim();
  if (!key) {
    showLoginError('Please enter an API key');
    return;
  }

  loginSubmitBtn.disabled = true;
  loginSubmitBtn.textContent = 'Connecting...';
  hideLoginError();

  const isValid = await validateApiKey(key);

  if (isValid) {
    apiKey = key;
    localStorage.setItem(API_KEY_STORAGE_KEY, key);
    showMainInterface();
    loadChatsFromStorage();
    // Show previous chats immediately upon successful login
    renderPreviousChats();
    await loadModels();
    setupEventListeners();
    renderPreviousChats();
  } else {
    showLoginError('Invalid API key. Please try again.');
    loginSubmitBtn.disabled = false;
    loginSubmitBtn.textContent = 'Connect';
  }
}

// Validate API key by making a test request
async function validateApiKey(key) {
  try {
    const response = await fetch('/api/v1/models', {
      method: 'GET',
      headers: {
        'X-API-Key': key,
      },
    });

    return response.status !== 401;
  } catch (error) {
    console.error('Error validating API key:', error);
    return false;
  }
}

// Clear API key
function clearApiKey() {
  apiKey = null;
  localStorage.removeItem(API_KEY_STORAGE_KEY);
}

// Show login error
function showLoginError(message) {
  loginError.textContent = message;
  loginError.style.display = 'block';
}

// Hide login error
function hideLoginError() {
  loginError.style.display = 'none';
}

// Get API headers for requests
function getApiHeaders() {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  return headers;
}

// Load available models from the API
async function loadModels() {
  try {
    const response = await fetch('/api/v1/models', {
      headers: getApiHeaders(),
    });

    if (response.status === 401) {
      handleUnauthorized();
      return false;
    }

    const data = await response.json();

    if (data.error) {
      showOllamaError(data.error);
      modelSelect.innerHTML = '<option value="">Ollama not available</option>';
      disableChatInterface();
      return false;
    }

    if (data.models && data.models.length > 0) {
      availableModels = data.models;
      modelSelect.innerHTML = '';

      data.models.forEach((model) => {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        modelSelect.appendChild(option);
      });

      // Select first model by default
      if (!currentChat.id) {
        modelSelect.value = data.models[0];
      }
      enableChatInterface();
      return true;
    } else {
      modelSelect.innerHTML = '<option value="">No models available</option>';
      showNoModelsError();
      disableChatInterface();
      return false;
    }
  } catch (error) {
    console.error('Error loading models:', error);
    modelSelect.innerHTML = '<option value="">Error loading models</option>';
    showOllamaError('Failed to connect to server');
    disableChatInterface();
    return false;
  }
}

// Handle 401 unauthorized responses
function handleUnauthorized() {
  clearApiKey();
  showLoginForm();
  showLoginError('Session expired. Please enter your API key again.');
}

// Setup event listeners
function setupEventListeners() {
  sendBtn.addEventListener('click', sendMessage);
  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  newChatBtn.addEventListener('click', createNewChat);
}

// Send message to the API
async function sendMessage() {
  const prompt = userInput.value.trim();
  const selectedModel = modelSelect.value;

  if (!prompt || !selectedModel || isLoading) return;

  // Clear welcome message if it exists
  const welcomeMessage = chatContainer.querySelector('.welcome-message');
  if (welcomeMessage) {
    welcomeMessage.remove();
  }

  // Check if this is the first message in a new chat
  const isFirstMessage = currentChat.messages.length === 0;

  // Add user message to chat
  addMessage('user', prompt);
  userInput.value = '';
  isLoading = true;
  updateSendButton();

  // Show loading indicator
  const loadingId = showLoading();

  try {
    // Get last 3 messages for context (excluding the current prompt we just added)
    const contextMessages = currentChat.messages.slice(-4, -1); // Last 3 before current

    const response = await fetch('/api/v1/response', {
      method: 'POST',
      headers: getApiHeaders(),
      body: JSON.stringify({
        prompt: prompt,
        model: selectedModel,
        context: contextMessages,
      }),
    });

    if (response.status === 401) {
      handleUnauthorized();
      removeLoading(loadingId);
      isLoading = false;
      updateSendButton();
      return;
    }

    const data = await response.json();

    if (response.ok) {
      removeLoading(loadingId);
      addMessage('assistant', data.response);

      // If this was the first message, generate a title
      if (isFirstMessage) {
        await generateChatTitle(prompt, selectedModel);
      }

      saveCurrentChat();
    } else {
      removeLoading(loadingId);
      addMessage(
        'assistant',
        `Error: ${data.error || 'Unknown error occurred'}`,
      );
    }
  } catch (error) {
    removeLoading(loadingId);
    addMessage('assistant', `Error: ${error.message}`);
    console.error('Error sending message:', error);
  }

  isLoading = false;
  updateSendButton();
}

// Generate chat title from first message
async function generateChatTitle(firstPrompt, model) {
  try {
    const response = await fetch('/api/v1/response', {
      method: 'POST',
      headers: getApiHeaders(),
      body: JSON.stringify({
        prompt:
          `Generate a short, concise title (maximum 6 words) for a conversation that starts with this user question: "${firstPrompt}". Only respond with the title, nothing else.`,
        model: model,
        context: [],
      }),
    });

    if (response.status === 401) {
      handleUnauthorized();
      return;
    }

    const data = await response.json();

    if (response.ok) {
      // Clean up the title (remove quotes, trim, limit length)
      let title = data.response.trim().replace(/^["']|["']$/g, '');
      if (title.length > 50) {
        title = title.substring(0, 50) + '...';
      }
      currentChat.title = title;
      saveCurrentChat();
      renderPreviousChats();
      console.log('Chat title generated:', title);
    }
  } catch (error) {
    console.error('Error generating chat title:', error);
    // Fallback to using first prompt as title
    currentChat.title = firstPrompt.substring(0, 50) +
      (firstPrompt.length > 50 ? '...' : '');
  }
}

// Add message to the chat
function addMessage(role, content) {
  const message = { role, content };
  currentChat.messages.push(message);

  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${role}`;

  const header = document.createElement('div');
  header.className = 'message-header';
  header.textContent = role === 'user' ? 'You' : 'Assistant';

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';

  if (role === 'assistant') {
    // Render markdown for assistant messages
    contentDiv.innerHTML = marked.parse(content);
  } else {
    contentDiv.textContent = content;
  }

  messageDiv.appendChild(header);
  messageDiv.appendChild(contentDiv);
  chatContainer.appendChild(messageDiv);

  scrollToBottom();
}

// Show loading indicator
function showLoading() {
  const loadingId = 'loading-' + Date.now();
  const loadingDiv = document.createElement('div');
  loadingDiv.id = loadingId;
  loadingDiv.className = 'loading-indicator';
  loadingDiv.innerHTML = `
        <div class="loading-dots">
            <span></span>
            <span></span>
            <span></span>
        </div>
        <span>Thinking...</span>
    `;
  chatContainer.appendChild(loadingDiv);
  scrollToBottom();
  return loadingId;
}

// Remove loading indicator
function removeLoading(loadingId) {
  const loadingDiv = document.getElementById(loadingId);
  if (loadingDiv) {
    loadingDiv.remove();
  }
}

// Update send button state
function updateSendButton() {
  sendBtn.disabled = isLoading;
  sendBtn.textContent = isLoading ? 'Sending...' : 'Send';
}

// Scroll chat to bottom
function scrollToBottom() {
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Create new chat
function createNewChat() {
  if (currentChat.messages.length > 0) {
    saveCurrentChat();
  }

  currentChat = {
    id: Date.now(),
    messages: [],
    title: null,
    model: modelSelect.value,
    timestamp: new Date().toISOString(),
  };

  chatContainer.innerHTML = `
        <div class="welcome-message">
            <h1>New Chat</h1>
            <p>Start a conversation!</p>
        </div>
    `;

  renderPreviousChats();
}

// Save current chat
function saveCurrentChat() {
  if (!currentChat.id) {
    currentChat.id = Date.now();
    currentChat.timestamp = new Date().toISOString();
    currentChat.model = modelSelect.value;
  }

  if (currentChat.messages.length === 0) return;

  // Generate title from first user message
  if (!currentChat.title) {
    const firstUserMessage = currentChat.messages.find((m) =>
      m.role === 'user'
    );
    currentChat.title = firstUserMessage
      ? firstUserMessage.content.substring(0, 50) +
        (firstUserMessage.content.length > 50 ? '...' : '')
      : 'Untitled Chat';
  }

  // Update or add chat to the list
  const existingIndex = chats.findIndex((c) => c.id === currentChat.id);
  if (existingIndex !== -1) {
    chats[existingIndex] = { ...currentChat };
  } else {
    chats.unshift({ ...currentChat });
  }

  // Keep only last 50 chats
  if (chats.length > 50) {
    chats = chats.slice(0, 50);
  }

  saveChatsToStorage();
  renderPreviousChats();
}

// Load chat from history
function loadChat(chatId) {
  if (currentChat.messages.length > 0 && currentChat.id !== chatId) {
    saveCurrentChat();
  }

  const chat = chats.find((c) => c.id === chatId);
  if (!chat) return;

  currentChat = { ...chat };

  // Clear chat container
  chatContainer.innerHTML = '';

  // Render all messages
  currentChat.messages.forEach((msg) => {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${msg.role}`;

    const header = document.createElement('div');
    header.className = 'message-header';
    header.textContent = msg.role === 'user' ? 'You' : 'Assistant';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    if (msg.role === 'assistant') {
      contentDiv.innerHTML = marked.parse(msg.content);
    } else {
      contentDiv.textContent = msg.content;
    }

    messageDiv.appendChild(header);
    messageDiv.appendChild(contentDiv);
    chatContainer.appendChild(messageDiv);
  });

  // Set model if available
  if (chat.model && availableModels.includes(chat.model)) {
    modelSelect.value = chat.model;
  }

  scrollToBottom();
  renderPreviousChats();
}

// Delete chat
function deleteChat(chatId, event) {
  event.stopPropagation();

  if (confirm('Are you sure you want to delete this chat?')) {
    chats = chats.filter((c) => c.id !== chatId);
    saveChatsToStorage();

    if (currentChat.id === chatId) {
      createNewChat();
    } else {
      renderPreviousChats();
    }
  }
}

// Render previous chats list
function renderPreviousChats() {
  previousChatsContainer.innerHTML = '';

  if (chats.length === 0) {
    previousChatsContainer.innerHTML =
      '<p style="color: #666; font-size: 13px; padding: 10px;">No previous chats</p>';
    return;
  }

  chats.forEach((chat) => {
    const chatItem = document.createElement('div');
    chatItem.className = 'chat-item';
    if (chat.id === currentChat.id) {
      chatItem.classList.add('active');
    }

    const title = document.createElement('div');
    title.className = 'chat-item-title';
    title.textContent = chat.title || 'Untitled Chat';

    const preview = document.createElement('div');
    preview.className = 'chat-item-preview';
    const lastMessage = chat.messages[chat.messages.length - 1];
    preview.textContent = lastMessage
      ? lastMessage.content.substring(0, 60) + '...'
      : 'Empty chat';

    chatItem.appendChild(title);
    chatItem.appendChild(preview);

    chatItem.addEventListener('click', () => loadChat(chat.id));

    previousChatsContainer.appendChild(chatItem);
  });
}

// Local storage functions
function saveChatsToStorage() {
  try {
    localStorage.setItem('llm-chats', JSON.stringify(chats));
  } catch (error) {
    console.error('Error saving to localStorage:', error);
  }
}

function loadChatsFromStorage() {
  try {
    const stored = localStorage.getItem('llm-chats');
    if (stored) {
      chats = JSON.parse(stored);
    }
  } catch (error) {
    console.error('Error loading from localStorage:', error);
    chats = [];
  }
}

// Show Ollama error page
function showOllamaError(errorMessage) {
  chatContainer.innerHTML = `
        <div class="error-page">
            <div class="error-icon">⚠️</div>
            <h1>Ollama Not Available</h1>
            <p class="error-message">${
    errorMessage || 'Failed to connect to Ollama'
  }</p>
            <div class="error-instructions">
                <h3>To fix this:</h3>
                <ol>
                    <li>Make sure Ollama is installed. If not, download it from <a href="https://ollama.com/download" target="_blank">ollama.com/download</a></li>
                    <li>Start Ollama by running: <code>ollama serve</code></li>
                    <li>Or if using the desktop app, make sure it's running</li>
                    <li>Click the retry button below once Ollama is running</li>
                </ol>
            </div>
            <button id="retry-connection-btn" class="retry-btn">🔄 Retry Connection</button>
        </div>
    `;

  const retryBtn = document.getElementById('retry-connection-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
      retryBtn.textContent = 'Connecting...';
      retryBtn.disabled = true;
      const success = await loadModels();
      if (success) {
        chatContainer.innerHTML = `
                    <div class="welcome-message">
                        <h1>Welcome to LLM Chat</h1>
                        <p>Select a model and start chatting!</p>
                    </div>
                `;
      } else {
        retryBtn.textContent = '🔄 Retry Connection';
        retryBtn.disabled = false;
      }
    });
  }
}

// Show no models error
function showNoModelsError() {
  chatContainer.innerHTML = `
        <div class="error-page">
            <div class="error-icon">📦</div>
            <h1>No Models Available</h1>
            <p class="error-message">Ollama is running, but no models are installed.</p>
            <div class="error-instructions">
                <h3>To install a model:</h3>
                <ol>
                    <li>Open a terminal</li>
                    <li>Run: <code>ollama pull llama2</code></li>
                    <li>Or choose another model from <a href="https://ollama.com/library" target="_blank">ollama.com/library</a></li>
                    <li>Click the retry button below once a model is installed</li>
                </ol>
            </div>
            <button id="retry-connection-btn" class="retry-btn">🔄 Retry Connection</button>
        </div>
    `;

  const retryBtn = document.getElementById('retry-connection-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
      retryBtn.textContent = 'Checking...';
      retryBtn.disabled = true;
      const success = await loadModels();
      if (success) {
        chatContainer.innerHTML = `
                    <div class="welcome-message">
                        <h1>Welcome to LLM Chat</h1>
                        <p>Select a model and start chatting!</p>
                    </div>
                `;
      } else {
        retryBtn.textContent = '🔄 Retry Connection';
        retryBtn.disabled = false;
      }
    });
  }
}

// Disable chat interface
function disableChatInterface() {
  userInput.disabled = true;
  sendBtn.disabled = true;
  userInput.placeholder = 'Chat unavailable - Ollama not connected';
}

// Enable chat interface
function enableChatInterface() {
  userInput.disabled = false;
  sendBtn.disabled = false;
  userInput.placeholder = 'Type your message here...';
}

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
