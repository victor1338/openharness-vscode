/**
 * OpenHarness Chat Webview Script
 *
 * Handles UI rendering, message display, tool execution blocks,
 * permission modals, and communication with the extension host.
 */

(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // ── State ──────────────────────────────────────────────────────────────

  let connected = false;
  let busy = false;
  let currentStreamEl = null;
  let thinkingEl = null;
  let toolBlocks = {};  // toolName -> DOM element for active tools

  // ── DOM refs ───────────────────────────────────────────────────────────

  const messagesEl = document.getElementById('chat-messages');
  const inputEl = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const statusIndicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  const modelLabel = document.getElementById('model-label');
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalMessage = document.getElementById('modal-message');
  const modalActions = document.getElementById('modal-actions');

  // ── Initialize ─────────────────────────────────────────────────────────

  showWelcome();

  // ── Input handling ─────────────────────────────────────────────────────

  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  inputEl.addEventListener('input', function () {
    // Auto-resize textarea
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 150) + 'px';
  });

  sendBtn.addEventListener('click', sendMessage);

  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) { return; }

    if (!connected) {
      vscode.postMessage({ type: 'startSession' });
      return;
    }

    vscode.postMessage({ type: 'submitMessage', text: text });
    inputEl.value = '';
    inputEl.style.height = 'auto';
    setBusy(true);
    showThinking();
  }

  // ── Message handling from extension ────────────────────────────────────

  window.addEventListener('message', function (event) {
    const msg = event.data;

    switch (msg.type) {
      case 'backendEvent':
        handleBackendEvent(msg.event);
        break;

      case 'sessionStarted':
        setStatus('connecting', 'Connecting...');
        showSessionLoading();
        break;

      case 'sessionEnded':
        connected = false;
        hideThinking();
        hideSessionLoading();
        setBusy(false);
        setStatus('disconnected', 'Session ended');
        break;

      case 'clearChat':
        messagesEl.innerHTML = '';
        break;

      case 'apiConfigured':
        addSystemMessage('API configured: ' + (msg.provider || 'ready') + '. Click Start Session to begin.');
        break;
    }
  });

  // ── Backend event router ───────────────────────────────────────────────

  function handleBackendEvent(event) {
    switch (event.type) {
      case 'ready':
        connected = true;
        setBusy(false);
        hideSessionLoading();
        hideThinking();
        messagesEl.innerHTML = '';
        setStatus('connected', 'Ready');
        if (event.state) {
          modelLabel.textContent = event.state.model || '';
        }
        addSystemMessage('Agent session started. Send a message to begin.');
        break;

      case 'state_snapshot':
        if (event.state) {
          modelLabel.textContent = event.state.model || '';
        }
        break;

      case 'transcript_item':
        if (event.item) {
          renderTranscriptItem(event.item);
        }
        break;

      case 'assistant_delta':
        hideThinking();
        appendStreamingText(event.message || '');
        break;

      case 'assistant_complete':
        hideThinking();
        finalizeStream();
        setBusy(false);
        break;

      case 'line_complete':
        hideThinking();
        finalizeStream();
        setBusy(false);
        break;

      case 'tool_started':
        hideThinking();
        renderToolStarted(event.tool_name, event.tool_input);
        break;

      case 'tool_completed':
        renderToolCompleted(event.tool_name, event.output, event.is_error);
        showThinking();
        break;

      case 'clear_transcript':
        messagesEl.innerHTML = '';
        break;

      case 'modal_request':
        showModal(event.modal);
        break;

      case 'error':
        hideThinking();
        addErrorMessage(event.message || 'Unknown error');
        setBusy(false);
        break;

      case 'shutdown':
        hideThinking();
        hideSessionLoading();
        connected = false;
        setBusy(false);
        setStatus('disconnected', 'Session ended');
        break;
    }
  }

  // ── Rendering helpers ──────────────────────────────────────────────────

  function renderTranscriptItem(item) {
    switch (item.role) {
      case 'user':
        addMessage('user', item.text);
        break;
      case 'assistant':
        // Handled via streaming delta + complete
        break;
      case 'system':
        addSystemMessage(item.text);
        break;
      case 'tool':
        // Handled by tool_started event
        break;
      case 'tool_result':
        // Handled by tool_completed event
        break;
    }
  }

  function addMessage(role, text) {
    const el = document.createElement('div');
    el.className = 'message message-' + role;
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function addSystemMessage(text) {
    const el = document.createElement('div');
    el.className = 'message message-system';
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function addErrorMessage(text) {
    const el = document.createElement('div');
    el.className = 'message message-error';
    el.textContent = '⚠ ' + text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function appendStreamingText(text) {
    if (!currentStreamEl) {
      currentStreamEl = document.createElement('div');
      currentStreamEl.className = 'message message-assistant streaming-cursor';
      messagesEl.appendChild(currentStreamEl);
    }
    currentStreamEl.textContent += text;
    scrollToBottom();
  }

  function finalizeStream() {
    if (currentStreamEl) {
      currentStreamEl.classList.remove('streaming-cursor');
      currentStreamEl = null;
    }
  }

  // ── Tool execution rendering ───────────────────────────────────────────

  function renderToolStarted(toolName, toolInput) {
    const block = document.createElement('div');
    block.className = 'tool-block';

    const header = document.createElement('div');
    header.className = 'tool-header';
    header.innerHTML =
      '<span class="tool-icon">⚙</span>' +
      '<span class="tool-name">' + escapeHtml(toolName || 'tool') + '</span>' +
      '<span class="tool-status tool-status-running">running...</span>';

    const body = document.createElement('div');
    body.className = 'tool-body collapsed';

    if (toolInput && Object.keys(toolInput).length > 0) {
      const inputDiv = document.createElement('div');
      inputDiv.className = 'tool-input';
      inputDiv.textContent = JSON.stringify(toolInput, null, 2);
      body.appendChild(inputDiv);
    }

    const outputDiv = document.createElement('div');
    outputDiv.className = 'tool-output';
    body.appendChild(outputDiv);

    header.addEventListener('click', function () {
      body.classList.toggle('collapsed');
    });

    block.appendChild(header);
    block.appendChild(body);
    messagesEl.appendChild(block);
    scrollToBottom();

    // Track for completion update
    toolBlocks[toolName] = { block: block, outputDiv: outputDiv, statusSpan: header.querySelector('.tool-status') };
  }

  function renderToolCompleted(toolName, output, isError) {
    const tracked = toolBlocks[toolName];
    if (tracked) {
      if (isError) {
        tracked.statusSpan.className = 'tool-status tool-status-error';
        tracked.statusSpan.textContent = 'error';
        tracked.outputDiv.className = 'tool-output error';
      } else {
        tracked.statusSpan.className = 'tool-status tool-status-done';
        tracked.statusSpan.textContent = 'done';
      }

      if (output) {
        // Truncate long outputs in UI
        const displayText = output.length > 2000
          ? output.substring(0, 2000) + '\n... (truncated)'
          : output;
        tracked.outputDiv.textContent = displayText;
      }

      delete toolBlocks[toolName];
    } else {
      // Tool completed without a matching start — add inline
      const el = document.createElement('div');
      el.className = 'message message-system';
      el.textContent = (isError ? '✗ ' : '✓ ') + (toolName || 'tool') + ' completed';
      messagesEl.appendChild(el);
    }
    scrollToBottom();
  }

  // ── Permission/Question modal ──────────────────────────────────────────

  function showModal(modal) {
    if (!modal) { return; }

    // Backend sends: kind, request_id, tool_name, reason/question
    var modalType = modal.kind || modal.type || 'permission';
    var modalId = modal.request_id || modal.id || '';

    modalTitle.textContent = modal.title || 'Permission Request';

    var msg = modal.reason || modal.message || modal.question || '';
    if (modal.tool_name) {
      msg = 'Tool: ' + modal.tool_name;
    }
    modalMessage.textContent = msg;

    // Show full tool_input as a formatted code block
    var existingPre = modalOverlay.querySelector('.modal-tool-input');
    if (existingPre) { existingPre.remove(); }
    if (modal.tool_input) {
      var pre = document.createElement('pre');
      pre.className = 'modal-tool-input';
      pre.style.cssText = 'margin:8px 0;padding:8px;border-radius:4px;overflow-x:auto;font-size:12px;' +
        'background:var(--vscode-textCodeBlock-background, rgba(0,0,0,0.15));color:var(--vscode-editor-foreground);' +
        'white-space:pre-wrap;word-break:break-all;max-height:200px;overflow-y:auto;';
      pre.textContent = JSON.stringify(modal.tool_input, null, 2);
      modalMessage.parentElement.insertBefore(pre, modalMessage.nextSibling);
    }

    modalActions.innerHTML = '';

    if (modalType === 'permission') {
      var allowBtn = createModalBtn('Allow', 'modal-btn modal-btn-primary', function () {
        vscode.postMessage({
          type: 'permissionResponse',
          requestId: modalId,
          allowed: true,
        });
        hideModal();
      });

      var denyBtn = createModalBtn('Deny', 'modal-btn modal-btn-secondary', function () {
        vscode.postMessage({
          type: 'permissionResponse',
          requestId: modalId,
          allowed: false,
        });
        hideModal();
      });

      modalActions.appendChild(denyBtn);
      modalActions.appendChild(allowBtn);
    } else if (modalType === 'question') {
      var answerInput = document.createElement('input');
      answerInput.type = 'text';
      answerInput.style.cssText = 'width:100%;margin-bottom:8px;padding:6px;' +
        'background:var(--oh-input-bg);color:var(--oh-input-fg);border:1px solid var(--oh-input-border);border-radius:4px;';
      modalActions.parentElement.insertBefore(answerInput, modalActions);

      var submitBtn = createModalBtn('Submit', 'modal-btn modal-btn-primary', function () {
        vscode.postMessage({
          type: 'questionResponse',
          requestId: modalId,
          answer: answerInput.value,
        });
        answerInput.remove();
        hideModal();
      });
      modalActions.appendChild(submitBtn);

      setTimeout(function () { answerInput.focus(); }, 50);
    }

    modalOverlay.classList.remove('hidden');
  }

  function hideModal() {
    modalOverlay.classList.add('hidden');
  }

  function createModalBtn(text, className, onClick) {
    const btn = document.createElement('button');
    btn.className = className;
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  // ── Welcome screen ─────────────────────────────────────────────────────

  function showWelcome() {
    const welcome = document.createElement('div');
    welcome.className = 'welcome';
    welcome.innerHTML =
      '<h2>OpenHarness Agent</h2>' +
      '<p>AI agent with 43+ tools — file editing, shell commands, code search, web access, and multi-agent coordination.</p>' +
      '<div class="welcome-actions">' +
      '<button class="welcome-btn welcome-btn-primary" id="welcome-start-btn">▶ Start Session</button>' +
      '<button class="welcome-btn welcome-btn-secondary" id="welcome-config-btn">⚙ Configure API</button>' +
      '</div>' +
      '<p class="welcome-hint">Set up your API key first if you haven\'t already.</p>';
    messagesEl.appendChild(welcome);

    document.getElementById('welcome-start-btn').addEventListener('click', function () {
      vscode.postMessage({ type: 'startSession' });
    });
    document.getElementById('welcome-config-btn').addEventListener('click', function () {
      vscode.postMessage({ type: 'configureAPI' });
    });
  }

  // ── Utility ────────────────────────────────────────────────────────────

  function setStatus(state, text) {
    statusIndicator.className = 'status-' + state;
    statusText.textContent = text;
  }

  function setBusy(isBusy) {
    busy = isBusy;
    sendBtn.disabled = isBusy;
    if (isBusy) {
      setStatus('busy', 'Agent working...');
    } else if (connected) {
      setStatus('connected', 'Ready');
    }
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showThinking() {
    hideThinking();
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'thinking-indicator';
    thinkingEl.innerHTML =
      '<div class="thinking-dots"><span></span><span></span><span></span></div>' +
      '<span>Thinking\u2026</span>';
    messagesEl.appendChild(thinkingEl);
    scrollToBottom();
  }

  function hideThinking() {
    if (thinkingEl) {
      thinkingEl.remove();
      thinkingEl = null;
    }
  }

  function showSessionLoading() {
    messagesEl.innerHTML = '';
    var loader = document.createElement('div');
    loader.className = 'session-loading';
    loader.id = 'session-loader';
    loader.innerHTML = '<div class="spinner"></div><span>Starting agent session\u2026</span>';
    messagesEl.appendChild(loader);
  }

  function hideSessionLoading() {
    var loader = document.getElementById('session-loader');
    if (loader) { loader.remove(); }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
})();
