/**
 * OpenHarness Chat Webview Script
 *
 * Handles UI rendering, message display, tool execution blocks,
 * permission modals, and communication with the extension host.
 *
 * Each session gets its own isolated "worker" (container + state)
 * so backend streams never leak into other session views.
 */

(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // ── Global state ────────────────────────────────────────────────────────

  // Per-session connection/busy state tracked on each worker object.
  // Global `resumingAfterStop` only applies to the focused session.
  let resumingAfterStop = false;

  // Slash command list received from the backend (array of {name, description})
  var slashCommands = [];

  // ── Session worker system ──────────────────────────────────────────────
  // Each worker owns: a container div, streaming state, tool tracking.
  // Only the "live" worker receives backend events.
  // The "visible" worker is whichever one is currently shown.

  var workers = {};       // id -> worker object
  var liveWorkerId = null; // current backend session worker id
  var visibleWorkerId = null; // which worker is currently displayed

  function createWorker(id) {
    var container = document.createElement('div');
    container.className = 'session-container';
    container.style.display = 'none';
    messagesWrapperInner.appendChild(container);

    var w = {
      id: id,
      container: container,
      currentStreamEl: null,
      currentThinkingBlockEl: null,
      thinkingEl: null,
      toolBlocks: {},
      busy: false,
      connected: false,   // per-session connection state
      isReadOnly: false,   // true for past sessions
    };
    workers[id] = w;
    return w;
  }

  function getWorker(id) {
    return workers[id] || null;
  }

  function getLiveWorker() {
    return liveWorkerId ? workers[liveWorkerId] : null;
  }

  function getVisibleWorker() {
    return visibleWorkerId ? workers[visibleWorkerId] : null;
  }

  /** Show only one worker's container, hide all others. */
  function showWorker(id) {
    var prev = visibleWorkerId;
    visibleWorkerId = id;
    for (var wid in workers) {
      workers[wid].container.style.display = (wid === id) ? '' : 'none';
    }
    // Sync global UI state to the newly visible worker
    var w = getVisibleWorker();
    if (w) {
      setBusy(w.busy);
      if (w.connected) {
        setStatus('connected', 'Ready');
      } else if (w.busy) {
        setStatus('busy', 'Agent working...');
      } else if (!w.isReadOnly) {
        setStatus('disconnected', 'Not connected');
      }
    }
  }

  /** Remove a worker by id (cleanup). */
  function destroyWorker(id) {
    var w = workers[id];
    if (!w) { return; }
    w.container.remove();
    delete workers[id];
    if (visibleWorkerId === id) { visibleWorkerId = null; }
  }

  /** Switch view to the live session. */
  function switchToLive() {
    if (liveWorkerId) {
      showWorker(liveWorkerId);
      scrollToBottom();
    }
  }

  // ── DOM refs ───────────────────────────────────────────────────────────

  const messagesWrapperInner = document.getElementById('chat-messages');
  const inputEl = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const statusIndicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  const modelLabel = document.getElementById('model-label');
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalMessage = document.getElementById('modal-message');
  const modalActions = document.getElementById('modal-actions');
  const historyBtn = document.getElementById('history-btn');
  const newChatBtn = document.getElementById('new-chat-btn');
  const historyPanel = document.getElementById('history-panel');
  const historyList = document.getElementById('history-list');
  const historyCloseBtn = document.getElementById('history-close-btn');
  const backToLiveBtn = document.getElementById('back-to-live-btn');

  // ── Initialize ─────────────────────────────────────────────────────────

  // Input starts disabled until a session is connected
  inputEl.disabled = true;
  sendBtn.disabled = true;
  inputEl.placeholder = 'Connecting to agent...';

  // Ask extension to restore last session (will show welcome if none)
  vscode.postMessage({ type: 'webviewReady' });

  // Click model label to switch API provider
  modelLabel.addEventListener('click', function () {
    vscode.postMessage({ type: 'switchAPI' });
  });

  // History button
  historyBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'listSessions' });
    historyPanel.classList.toggle('hidden');
  });

  // New chat button
  newChatBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'newChat' });
    historyPanel.classList.add('hidden');
  });

  // Close history panel
  historyCloseBtn.addEventListener('click', function () {
    historyPanel.classList.add('hidden');
  });

  // Back to live session button
  if (backToLiveBtn) {
    backToLiveBtn.addEventListener('click', function () {
      switchToLive();
      backToLiveBtn.classList.add('hidden');
      // Notify extension that we're focusing back on the live session
      if (liveWorkerId) {
        vscode.postMessage({ type: 'focusSession', sessionId: liveWorkerId });
      }
    });
  }

  // ── Input handling ─────────────────────────────────────────────────────

  // ── Slash command autocomplete ────────────────────────────────────────

  var cmdPopup = document.createElement('div');
  cmdPopup.id = 'cmd-autocomplete';
  cmdPopup.className = 'cmd-autocomplete hidden';
  document.getElementById('input-area').insertBefore(cmdPopup, document.getElementById('input-wrapper'));
  var cmdSelectedIdx = -1;

  function showCmdPopup(filter) {
    var query = filter.toLowerCase();
    var matches = slashCommands.filter(function (c) {
      return c.name.toLowerCase().indexOf(query) >= 0 ||
        c.description.toLowerCase().indexOf(query) >= 0;
    });
    if (matches.length === 0) { hideCmdPopup(); return; }
    // Cap visible results
    if (matches.length > 15) { matches = matches.slice(0, 15); }

    cmdPopup.innerHTML = '';
    matches.forEach(function (cmd, idx) {
      var row = document.createElement('div');
      row.className = 'cmd-row' + (idx === 0 ? ' cmd-row-active' : '');
      row.dataset.value = cmd.name;
      var nameSpan = document.createElement('span');
      nameSpan.className = 'cmd-name';
      nameSpan.textContent = cmd.name;
      var descSpan = document.createElement('span');
      descSpan.className = 'cmd-desc';
      descSpan.textContent = cmd.description;
      row.appendChild(nameSpan);
      row.appendChild(descSpan);
      row.addEventListener('mousedown', function (e) {
        e.preventDefault(); // keep focus on input
        applyCmdSelection(cmd.name);
      });
      cmdPopup.appendChild(row);
    });
    cmdSelectedIdx = 0;
    cmdPopup.classList.remove('hidden');
  }

  function hideCmdPopup() {
    cmdPopup.classList.add('hidden');
    cmdPopup.innerHTML = '';
    cmdSelectedIdx = -1;
  }

  function applyCmdSelection(name) {
    inputEl.value = name + ' ';
    inputEl.focus();
    // Trigger resize
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
    hideCmdPopup();
  }

  function moveCmdSelection(delta) {
    var rows = cmdPopup.querySelectorAll('.cmd-row');
    if (rows.length === 0) { return; }
    if (cmdSelectedIdx >= 0 && cmdSelectedIdx < rows.length) {
      rows[cmdSelectedIdx].classList.remove('cmd-row-active');
    }
    cmdSelectedIdx = Math.max(0, Math.min(rows.length - 1, cmdSelectedIdx + delta));
    rows[cmdSelectedIdx].classList.add('cmd-row-active');
    rows[cmdSelectedIdx].scrollIntoView({ block: 'nearest' });
  }

  inputEl.addEventListener('keydown', function (e) {
    // Handle autocomplete navigation
    if (!cmdPopup.classList.contains('hidden')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveCmdSelection(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveCmdSelection(-1); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        var rows = cmdPopup.querySelectorAll('.cmd-row');
        if (cmdSelectedIdx >= 0 && cmdSelectedIdx < rows.length) {
          e.preventDefault();
          applyCmdSelection(rows[cmdSelectedIdx].dataset.value);
          return;
        }
      }
      if (e.key === 'Escape') { e.preventDefault(); hideCmdPopup(); return; }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  inputEl.addEventListener('input', function () {
    // Auto-resize textarea
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 150) + 'px';

    // Slash command autocomplete
    var val = this.value;
    if (val.startsWith('/') && val.indexOf('\n') === -1) {
      showCmdPopup(val);
    } else {
      hideCmdPopup();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  stopBtn.addEventListener('click', function () {
    // Interrupt whichever live session is currently visible/focused
    var targetId = visibleWorkerId || liveWorkerId;
    var w = getWorker(targetId);
    if (!w || !w.busy) { return; }
    vscode.postMessage({ type: 'interruptAgent', sessionId: w.id });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      // Dismiss autocomplete first
      if (!cmdPopup.classList.contains('hidden')) {
        hideCmdPopup();
        return;
      }
      var targetId = visibleWorkerId || liveWorkerId;
      var w = getWorker(targetId);
      if (w && w.busy) {
        e.preventDefault();
        stopBtn.click();
      }
    }
  });

  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) { return; }

    // Switch to the live worker before sending
    if (visibleWorkerId !== liveWorkerId) {
      switchToLive();
      if (backToLiveBtn) { backToLiveBtn.classList.add('hidden'); }
    }

    // Ensure we have a live worker
    if (!liveWorkerId) {
      var id = 'live-' + Date.now();
      createWorker(id);
      liveWorkerId = id;
      showWorker(id);
    }

    var w = getLiveWorker();
    if (!w) { return; }

    vscode.postMessage({ type: 'submitMessage', text: text, sessionId: w.id });
    inputEl.value = '';
    inputEl.style.height = 'auto';

    // Add user message to the live worker optimistically
    w.busy = true;
    if (visibleWorkerId === w.id) { setBusy(true); }
    wAddMessage(w, 'user', text);
    wShowThinking(w);
  }

  // ── Message handling from extension ────────────────────────────────────

  window.addEventListener('message', function (event) {
    const msg = event.data;

    switch (msg.type) {
      case 'backendEvent':
        handleBackendEvent(msg.event, msg.sessionId);
        break;

      case 'sessionStarted': {
        var sid = msg.sessionId;
        if (sid) {
          var sw = getWorker(sid);
          if (!sw) {
            sw = createWorker(sid);
            liveWorkerId = sid;
            showWorker(sid);
          }
          if (!resumingAfterStop) {
            // Only update global UI status for the focused session
            if (sid === liveWorkerId && visibleWorkerId === sid) {
              setStatus('connecting', 'Connecting...');
            }
            // Only show loading if no user message is already displayed
            if (!sw.container.querySelector('.message-user')) {
              wShowSessionLoading(sw);
            }
            // Disable input while connecting
            setInputDisabled(true);
          }
        }
        break;
      }

      case 'sessionEnded': {
        var sid2 = msg.sessionId;
        var ew = sid2 ? getWorker(sid2) : getLiveWorker();
        if (ew) {
          wHideThinking(ew);
          wHideSessionLoading(ew);
          ew.busy = false;
          ew.connected = false;
          wAddSystemMessage(ew, 'Session ended.');
        }
        // Only update global UI if this was the focused session
        if (sid2 && sid2 === visibleWorkerId) {
          setBusy(false);
          setStatus('disconnected', 'Session ended');
        }
        setInputDisabled(true, 'Session ended');
        break;
      }

      case 'sessionInterrupted':
      case 'sessionStopped': {
        var sid3 = msg.sessionId;
        var iw = sid3 ? getWorker(sid3) : getLiveWorker();
        if (iw) {
          wHideThinking(iw);
          wHideSessionLoading(iw);
          wFinalizeThinkingBlock(iw);
          wFinalizeStream(iw);
          iw.busy = false;
          wAddSystemMessage(iw, 'Agent stopped.');
        }
        // Only update global UI if this was the focused session
        if (sid3 && sid3 === visibleWorkerId) {
          setBusy(false);
          resumingAfterStop = true;
        }
        setInputDisabled(true, 'Reconnecting...');
        break;
      }

      case 'clearChat': {
        var cw = getLiveWorker();
        if (cw) { cw.container.innerHTML = ''; }
        break;
      }

      case 'apiConfigured': {
        var aw = getLiveWorker();
        if (aw) { wAddSystemMessage(aw, 'API configured: ' + (msg.provider || 'ready') + '. Send a message to start.'); }
        break;
      }

      case 'apiSwitched':
        modelLabel.textContent = (msg.model || msg.apiFormat || 'unknown') + ' ▾';
        var asw = getLiveWorker();
        if (asw) { wAddSystemMessage(asw, 'Switched to: ' + (msg.profile || 'new provider')); }
        break;

      case 'apiProfilesChanged':
        break;

      case 'sessionList':
        renderSessionList(msg.sessions || [], msg.currentSessionId || '');
        break;

      case 'sessionLoaded':
        renderLoadedSession(msg.session);
        historyPanel.classList.add('hidden');
        break;

      case 'restoreSession':
        restoreLastSession(msg.session);
        break;

      case 'triggerNewChat':
        vscode.postMessage({ type: 'newChat' });
        historyPanel.classList.add('hidden');
        break;

      case 'liveSessionCreated': {
        // Extension tells us a new live session has started
        var newId = msg.sessionId || ('s' + Date.now());
        // Clean up old read-only viewers
        for (var wid in workers) {
          if (workers[wid].isReadOnly) { destroyWorker(wid); }
        }
        var nw = createWorker(newId);
        liveWorkerId = newId;
        showWorker(newId);
        if (backToLiveBtn) { backToLiveBtn.classList.add('hidden'); }
        break;
      }
    }
  });

  // ── Backend event router (routes to worker by sessionId) ────────────────

  function handleBackendEvent(event, sessionId) {
    // Find or create the worker for this session
    var targetId = sessionId || liveWorkerId;
    var w = targetId ? getWorker(targetId) : null;

    if (!w) {
      // No worker yet — create one
      var id = targetId || ('live-' + Date.now());
      w = createWorker(id);
      if (!liveWorkerId) {
        liveWorkerId = id;
      }
      if (!visibleWorkerId) { showWorker(id); }
    }

    switch (event.type) {
      case 'ready':
        w.connected = true;
        w.busy = false;
        wHideSessionLoading(w);
        wHideThinking(w);
        if (resumingAfterStop && w.id === liveWorkerId) {
          resumingAfterStop = false;
        }
        // Re-enable input now that session is connected
        setInputDisabled(false);
        // Only update global UI for the focused/visible session
        if (visibleWorkerId === w.id) {
          setStatus('connected', 'Ready');
          setBusy(false);
        }
        if (event.state) {
          // Only update model label for the focused session
          if (w.id === liveWorkerId) {
            modelLabel.textContent = (event.state.model || '') + ' \u25BE';
          }
        }
        // Store command list for autocomplete
        if (event.commands && event.commands.length) {
          slashCommands = event.commands;
        }
        // Only show welcome if container has no user messages (auto-start case)
        var hasUserMsg = w.container.querySelector('.message-user');
        if (!hasUserMsg) {
          w.container.innerHTML = '';
          wAddSystemMessage(w, 'Agent session started. Send a message to begin.');
        }
        break;

      case 'state_snapshot':
        if (event.state) {
          modelLabel.textContent = (event.state.model || '') + ' ▾';
        }
        break;

      case 'transcript_item':
        if (event.item) {
          wRenderTranscriptItem(w, event.item);
        }
        break;

      case 'thinking_delta':
        wHideThinking(w);
        wAppendThinkingText(w, event.message || '');
        break;

      case 'assistant_delta':
        wHideThinking(w);
        wFinalizeThinkingBlock(w);
        wAppendStreamingText(w, event.message || '');
        break;

      case 'assistant_complete':
        wHideThinking(w);
        if (w.currentThinkingBlockEl && !w.currentStreamEl) {
          wPromoteThinkingToAssistant(w);
        }
        wFinalizeThinkingBlock(w);
        wFinalizeStream(w);
        break;

      case 'line_complete':
        wHideThinking(w);
        if (w.currentThinkingBlockEl && !w.currentStreamEl) {
          wPromoteThinkingToAssistant(w);
        }
        wFinalizeThinkingBlock(w);
        wFinalizeStream(w);
        w.busy = false;
        // Only update global UI for the visible session
        if (visibleWorkerId === w.id) { setBusy(false); }
        break;

      case 'tool_started':
        wHideThinking(w);
        wFinalizeThinkingBlock(w);
        wRenderToolStarted(w, event.tool_name, event.tool_input);
        break;

      case 'tool_completed':
        wRenderToolCompleted(w, event.tool_name, event.output, event.is_error);
        wShowThinking(w);
        break;

      case 'clear_transcript':
        w.container.innerHTML = '';
        break;

      case 'modal_request':
        wShowInlinePermission(w, event.modal);
        break;

      case 'select_request':
        wShowSelectModal(w, event.modal, event.select_options || []);
        break;

      case 'turn_cancelled':
        wHideThinking(w);
        wFinalizeThinkingBlock(w);
        wFinalizeStream(w);
        w.busy = false;
        // Only update global UI for the visible session
        if (visibleWorkerId === w.id) { setBusy(false); }
        break;

      case 'error':
        wHideThinking(w);
        wAddErrorMessage(w, event.message || 'Unknown error');
        w.busy = false;
        // Only update global UI for the visible session
        if (visibleWorkerId === w.id) { setBusy(false); }
        break;

      case 'shutdown':
        wHideThinking(w);
        wHideSessionLoading(w);
        w.connected = false;
        w.busy = false;
        // Only update global UI for the visible session
        if (visibleWorkerId === w.id) {
          setBusy(false);
          setStatus('disconnected', 'Session ended');
        }
        break;
    }
  }

  // ── Worker-scoped rendering helpers ─────────────────────────────────────

  function wRenderTranscriptItem(w, item) {
    switch (item.role) {
      case 'user':
        // Skip — user messages are already added optimistically by sendMessage()
        break;
      case 'system':
        wAddSystemMessage(w, item.text);
        break;
    }
  }

  function wAddMessage(w, role, text) {
    var el = document.createElement('div');
    el.className = 'message message-' + role;
    el.textContent = text;
    w.container.appendChild(el);
    if (visibleWorkerId === w.id) { scrollToBottom(); }
  }

  function wAddSystemMessage(w, text) {
    var el = document.createElement('div');
    el.className = 'message message-system';
    el.textContent = text;
    w.container.appendChild(el);

    // Detect "/continue" command suggestions and add Continue + Stop buttons
    var continueMatch = text.match(/\/continue(?:\s+\[?(\w+)\]?)?/);
    if (continueMatch) {
      var btnRow = document.createElement('div');
      btnRow.className = 'continue-btn-row';

      var continueBtn = document.createElement('button');
      continueBtn.className = 'continue-btn';
      continueBtn.textContent = '▶ Continue';

      var stopBtn2 = document.createElement('button');
      stopBtn2.className = 'continue-btn continue-btn-stop';
      stopBtn2.textContent = '■ Stop';

      continueBtn.addEventListener('click', function () {
        if (w.isReadOnly) { return; }
        continueBtn.disabled = true;
        stopBtn2.disabled = true;
        continueBtn.textContent = '▶ Continuing…';
        vscode.postMessage({ type: 'submitMessage', text: '/continue', sessionId: w.id });
        w.busy = true;
        if (visibleWorkerId === w.id) { setBusy(true); }
        wAddMessage(w, 'user', '/continue');
        wShowThinking(w);
      });

      stopBtn2.addEventListener('click', function () {
        if (w.isReadOnly) { return; }
        continueBtn.disabled = true;
        stopBtn2.disabled = true;
        stopBtn2.textContent = '■ Stopped';
        vscode.postMessage({ type: 'interruptAgent', sessionId: w.id });
      });

      btnRow.appendChild(continueBtn);
      btnRow.appendChild(stopBtn2);
      w.container.appendChild(btnRow);
    }

    if (visibleWorkerId === w.id) { scrollToBottom(); }
  }

  function wAddErrorMessage(w, text) {
    var el = document.createElement('div');
    el.className = 'message message-error';
    el.textContent = '⚠ ' + text;
    w.container.appendChild(el);
    if (visibleWorkerId === w.id) { scrollToBottom(); }
  }

  function wAppendStreamingText(w, text) {
    if (!w.currentStreamEl) {
      w.currentStreamEl = document.createElement('div');
      w.currentStreamEl.className = 'message message-assistant streaming-cursor';
      w.container.appendChild(w.currentStreamEl);
    }
    w.currentStreamEl.textContent += text;
    if (visibleWorkerId === w.id) { scrollToBottom(); }
  }

  function wFinalizeStream(w) {
    if (w.currentStreamEl) {
      w.currentStreamEl.classList.remove('streaming-cursor');
      var raw = w.currentStreamEl.textContent || '';
      w.currentStreamEl.innerHTML = renderMarkdown(raw);
      w.currentStreamEl.style.whiteSpace = 'normal';
      w.currentStreamEl = null;
      if (visibleWorkerId === w.id) { scrollToBottom(); }
    }
  }

  function wAppendThinkingText(w, text) {
    if (!w.currentThinkingBlockEl) {
      w.currentThinkingBlockEl = document.createElement('div');
      w.currentThinkingBlockEl.className = 'thinking-block';
      var label = document.createElement('div');
      label.className = 'thinking-block-label';
      label.textContent = '\u{1F4AD} Thinking';
      w.currentThinkingBlockEl.appendChild(label);
      var content = document.createElement('div');
      content.className = 'thinking-block-content streaming-cursor';
      w.currentThinkingBlockEl.appendChild(content);
      w.container.appendChild(w.currentThinkingBlockEl);
    }
    var contentEl = w.currentThinkingBlockEl.querySelector('.thinking-block-content');
    if (contentEl) {
      contentEl.textContent += text;
      w.currentThinkingBlockEl.scrollTop = w.currentThinkingBlockEl.scrollHeight;
    }
    if (visibleWorkerId === w.id) { scrollToBottom(); }
  }

  function wFinalizeThinkingBlock(w) {
    if (w.currentThinkingBlockEl) {
      var contentEl = w.currentThinkingBlockEl.querySelector('.thinking-block-content');
      if (contentEl) {
        contentEl.classList.remove('streaming-cursor');
      }
      w.currentThinkingBlockEl.classList.add('finalized');
      w.currentThinkingBlockEl.addEventListener('click', function () {
        this.classList.toggle('finalized');
      });
      w.currentThinkingBlockEl = null;
    }
  }

  function wPromoteThinkingToAssistant(w) {
    if (!w.currentThinkingBlockEl) { return; }
    var contentEl = w.currentThinkingBlockEl.querySelector('.thinking-block-content');
    if (!contentEl) { return; }
    var fullText = contentEl.textContent || '';
    if (!fullText.trim()) { return; }
    var el = document.createElement('div');
    el.className = 'message message-assistant';
    el.innerHTML = renderMarkdown(fullText);
    el.style.whiteSpace = 'normal';
    w.container.appendChild(el);
    if (visibleWorkerId === w.id) { scrollToBottom(); }
  }

  function wRenderToolStarted(w, toolName, toolInput) {
    var block = document.createElement('div');
    block.className = 'tool-block';
    var header = document.createElement('div');
    header.className = 'tool-header';
    header.innerHTML =
      '<span class="tool-icon">⚙</span>' +
      '<span class="tool-name">' + escapeHtml(toolName || 'tool') + '</span>' +
      '<span class="tool-status tool-status-running">running...</span>';
    var body = document.createElement('div');
    body.className = 'tool-body collapsed';
    if (toolInput && Object.keys(toolInput).length > 0) {
      var inputDiv = document.createElement('div');
      inputDiv.className = 'tool-input';
      inputDiv.textContent = JSON.stringify(toolInput, null, 2);
      body.appendChild(inputDiv);
    }
    var outputDiv = document.createElement('div');
    outputDiv.className = 'tool-output';
    body.appendChild(outputDiv);
    header.addEventListener('click', function () {
      body.classList.toggle('collapsed');
    });
    block.appendChild(header);
    block.appendChild(body);
    w.container.appendChild(block);
    if (visibleWorkerId === w.id) { scrollToBottom(); }
    w.toolBlocks[toolName] = { block: block, outputDiv: outputDiv, statusSpan: header.querySelector('.tool-status') };
  }

  function wRenderToolCompleted(w, toolName, output, isError) {
    var tracked = w.toolBlocks[toolName];
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
        var displayText = output.length > 2000
          ? output.substring(0, 2000) + '\n... (truncated)'
          : output;
        tracked.outputDiv.textContent = displayText;
      }
      delete w.toolBlocks[toolName];
    } else {
      var el = document.createElement('div');
      el.className = 'message message-system';
      el.textContent = (isError ? '✗ ' : '✓ ') + (toolName || 'tool') + ' completed';
      w.container.appendChild(el);
    }
    if (visibleWorkerId === w.id) { scrollToBottom(); }
  }

  function wShowThinking(w) {
    wHideThinking(w);
    w.thinkingEl = document.createElement('div');
    w.thinkingEl.className = 'thinking-indicator';
    w.thinkingEl.innerHTML =
      '<div class="thinking-dots"><span></span><span></span><span></span></div>' +
      '<span>Thinking\u2026</span>';
    w.container.appendChild(w.thinkingEl);
    if (visibleWorkerId === w.id) { scrollToBottom(); }
  }

  function wHideThinking(w) {
    if (w.thinkingEl) {
      w.thinkingEl.remove();
      w.thinkingEl = null;
    }
  }

  function wShowSessionLoading(w) {
    w.container.innerHTML = '';
    var loader = document.createElement('div');
    loader.className = 'session-loading';
    loader.innerHTML = '<div class="spinner"></div><span>Starting agent session\u2026</span>';
    w.container.appendChild(loader);
  }

  function wHideSessionLoading(w) {
    var loader = w.container.querySelector('.session-loading');
    if (loader) { loader.remove(); }
  }

  // ── Inline permission / question blocks ─────────────────────────────────

  function wShowInlinePermission(w, modal) {
    if (!modal) { return; }

    var modalType = modal.kind || modal.type || 'permission';
    var modalId = modal.request_id || modal.id || '';
    var sessionId = w.id;

    // Hide thinking indicator while waiting for permission
    wHideThinking(w);

    var block = document.createElement('div');
    block.className = 'permission-block';

    var header = document.createElement('div');
    header.className = 'permission-header';

    if (modalType === 'permission') {
      header.innerHTML = '<span class="permission-icon">\uD83D\uDD12</span>' +
        '<span class="permission-title">Permission Request</span>';
    } else {
      header.innerHTML = '<span class="permission-icon">\u2753</span>' +
        '<span class="permission-title">Question</span>';
    }
    block.appendChild(header);

    // Tool name / reason
    var msg = modal.reason || modal.message || modal.question || '';
    if (modal.tool_name) {
      var toolLine = document.createElement('div');
      toolLine.className = 'permission-tool';
      toolLine.textContent = 'Tool: ' + modal.tool_name;
      block.appendChild(toolLine);
    }
    if (msg && msg !== modal.tool_name) {
      var msgLine = document.createElement('div');
      msgLine.className = 'permission-reason';
      msgLine.textContent = msg;
      block.appendChild(msgLine);
    }

    // Tool input as code block
    if (modal.tool_input) {
      var pre = document.createElement('pre');
      pre.className = 'permission-input';
      pre.textContent = JSON.stringify(modal.tool_input, null, 2);
      block.appendChild(pre);
    }

    // Actions
    var actions = document.createElement('div');
    actions.className = 'permission-actions';

    if (modalType === 'permission') {
      var denyBtn = document.createElement('button');
      denyBtn.className = 'permission-btn permission-btn-deny';
      denyBtn.textContent = 'Deny';
      denyBtn.addEventListener('click', function () {
        vscode.postMessage({
          type: 'permissionResponse',
          requestId: modalId,
          allowed: false,
          sessionId: sessionId,
        });
        block.className = 'permission-block permission-resolved permission-denied';
        actions.innerHTML = '<span class="permission-result">\u2718 Denied</span>';
      });

      var allowBtn = document.createElement('button');
      allowBtn.className = 'permission-btn permission-btn-allow';
      allowBtn.textContent = 'Allow';
      allowBtn.addEventListener('click', function () {
        vscode.postMessage({
          type: 'permissionResponse',
          requestId: modalId,
          allowed: true,
          sessionId: sessionId,
        });
        block.className = 'permission-block permission-resolved permission-allowed';
        actions.innerHTML = '<span class="permission-result">\u2714 Allowed</span>';
      });

      actions.appendChild(denyBtn);
      actions.appendChild(allowBtn);
    } else if (modalType === 'question') {
      var answerInput = document.createElement('input');
      answerInput.type = 'text';
      answerInput.className = 'permission-answer-input';
      answerInput.placeholder = 'Type your answer...';
      block.appendChild(answerInput);

      var submitBtn = document.createElement('button');
      submitBtn.className = 'permission-btn permission-btn-allow';
      submitBtn.textContent = 'Submit';
      submitBtn.addEventListener('click', function () {
        vscode.postMessage({
          type: 'questionResponse',
          requestId: modalId,
          answer: answerInput.value,
          sessionId: sessionId,
        });
        block.className = 'permission-block permission-resolved permission-allowed';
        answerInput.disabled = true;
        actions.innerHTML = '<span class="permission-result">\u2714 Answered</span>';
      });

      answerInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitBtn.click(); }
      });

      actions.appendChild(submitBtn);
      setTimeout(function () { answerInput.focus(); }, 50);
    }

    block.appendChild(actions);
    w.container.appendChild(block);
    if (visibleWorkerId === w.id) { scrollToBottom(); }
  }

  // ── Select modal (for commands like /model, /provider, /effort) ──────

  function wShowSelectModal(w, modal, options) {
    if (!modal || !options.length) { return; }

    var command = modal.command || '';
    var title = modal.title || command;
    var sessionId = w.id;

    var block = document.createElement('div');
    block.className = 'select-block';

    var header = document.createElement('div');
    header.className = 'select-header';
    header.innerHTML = '<span class="select-icon">\u2630</span>' +
      '<span class="select-title">' + escapeHtml(title) + '</span>';
    block.appendChild(header);

    var list = document.createElement('div');
    list.className = 'select-list';

    options.forEach(function (opt) {
      var row = document.createElement('div');
      row.className = 'select-option' + (opt.active ? ' select-option-active' : '');

      var label = document.createElement('span');
      label.className = 'select-option-label';
      label.textContent = opt.label || opt.value;
      row.appendChild(label);

      if (opt.description) {
        var desc = document.createElement('span');
        desc.className = 'select-option-desc';
        desc.textContent = opt.description;
        row.appendChild(desc);
      }

      if (opt.active) {
        var check = document.createElement('span');
        check.className = 'select-option-check';
        check.textContent = '\u2714';
        row.appendChild(check);
      }

      row.addEventListener('click', function () {
        vscode.postMessage({
          type: 'applySelectCommand',
          command: command,
          value: opt.value,
          sessionId: sessionId,
        });
        // Mark as resolved
        block.className = 'select-block select-resolved';
        list.innerHTML = '';
        var result = document.createElement('div');
        result.className = 'select-result';
        result.textContent = title + ': ' + (opt.label || opt.value);
        list.appendChild(result);
        w.busy = true;
        if (visibleWorkerId === w.id) { setBusy(true); }
      });

      list.appendChild(row);
    });

    block.appendChild(list);
    w.container.appendChild(block);
    if (visibleWorkerId === w.id) { scrollToBottom(); }
  }

  function escapeHtml(text) {
    var el = document.createElement('span');
    el.textContent = text;
    return el.innerHTML;
  }

  // ── Session history rendering ────────────────────────────────────────

  function renderSessionList(sessions, currentSessionId) {
    if (!historyList) { return; }

    if (!sessions || sessions.length === 0) {
      historyList.innerHTML = '<div class="history-empty">No sessions for this project.</div>';
      return;
    }

    historyList.innerHTML = '';

    // Separate running and past sessions
    var runningSessions = sessions.filter(function (s) { return s.running; });
    var pastSessions = sessions.filter(function (s) { return !s.running; });

    // ── Running sessions section ──
    if (runningSessions.length > 0) {
      var runningHeader = document.createElement('div');
      runningHeader.className = 'history-date-group';
      runningHeader.innerHTML = '<span class="breathing-dot"></span> Running';
      historyList.appendChild(runningHeader);

      runningSessions.forEach(function (s) {
        var item = document.createElement('div');
        var isCurrent = (s.id === currentSessionId);
        item.className = 'history-item history-item-running' + (isCurrent ? ' history-item-current' : '');

        var summaryText = s.summary || 'New session';
        var statusLabel = isCurrent ? ' (active)' : '';

        item.innerHTML =
          '<div class="history-item-left">' +
            '<span class="breathing-indicator"></span>' +
            '<div class="history-item-info">' +
              '<div class="history-item-summary">' + escapeHtml(summaryText) + escapeHtml(statusLabel) + '</div>' +
              '<div class="history-item-meta">' +
                '<span>' + s.msgCount + ' msgs</span>' +
                (s.toolCount > 0 ? '<span>' + s.toolCount + ' tools</span>' : '') +
              '</div>' +
            '</div>' +
          '</div>';

        item.addEventListener('click', function () {
          // Switch to this live session's worker
          if (getWorker(s.id)) {
            showWorker(s.id);
            liveWorkerId = s.id;
            vscode.postMessage({ type: 'focusSession', sessionId: s.id });
            if (backToLiveBtn) { backToLiveBtn.classList.add('hidden'); }
            historyPanel.classList.add('hidden');
          }
        });

        historyList.appendChild(item);
      });
    }

    // ── Past sessions ──
    var lastDateLabel = '';
    pastSessions.forEach(function (s) {
      var dateLabel = getDateLabel(s.ts);
      if (dateLabel !== lastDateLabel) {
        var groupEl = document.createElement('div');
        groupEl.className = 'history-date-group';
        groupEl.textContent = dateLabel;
        historyList.appendChild(groupEl);
        lastDateLabel = dateLabel;
      }

      var item = document.createElement('div');
      item.className = 'history-item';

      var time = new Date(s.ts);
      var timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      item.innerHTML =
        '<div class="history-item-summary">' + escapeHtml(s.summary) + '</div>' +
        '<div class="history-item-meta">' +
          '<span>' + timeStr + '</span>' +
          '<span>' + s.msgCount + ' msgs</span>' +
          (s.toolCount > 0 ? '<span>' + s.toolCount + ' tools</span>' : '') +
        '</div>';

      var actions = document.createElement('div');
      actions.className = 'history-item-actions';

      var viewBtn = document.createElement('button');
      viewBtn.className = 'history-action-btn';
      viewBtn.textContent = 'View';
      viewBtn.title = 'View this session';
      viewBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'loadSession', sessionId: s.id });
      });

      var delBtn = document.createElement('button');
      delBtn.className = 'history-action-btn history-action-delete';
      delBtn.textContent = '✕';
      delBtn.title = 'Delete session';
      delBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'deleteSession', sessionId: s.id });
      });

      actions.appendChild(viewBtn);
      actions.appendChild(delBtn);
      item.appendChild(actions);

      item.addEventListener('click', function () {
        vscode.postMessage({ type: 'loadSession', sessionId: s.id });
      });

      historyList.appendChild(item);
    });
  }

  function renderLoadedSession(session) {
    if (!session || !session.messages) { return; }

    // Clean up old read-only workers
    for (var wid in workers) {
      if (workers[wid].isReadOnly) { destroyWorker(wid); }
    }

    // Create a read-only worker for the past session
    var viewId = 'view-' + session.id;
    var w = createWorker(viewId);
    w.isReadOnly = true;

    renderSessionMessages(w, session);

    // Switch view to this read-only worker
    showWorker(viewId);
    scrollToBottom();

    // Show "Back to live" button if there's an active session
    if (backToLiveBtn && liveWorkerId) {
      backToLiveBtn.classList.remove('hidden');
    }
  }

  /** Restore the last session on webview load — renders messages into a non-read-only worker. */
  function restoreLastSession(session) {
    if (!session || !session.messages || session.messages.length === 0) {
      showWelcome();
      return;
    }

    // Create a worker that can receive new messages (not read-only)
    var w = createWorker(session.id);
    liveWorkerId = session.id;

    renderSessionMessages(w, session);

    showWorker(session.id);
    scrollToBottom();
    setStatus('disconnected', 'Session restored');
  }

  /** Shared helper to render a session's messages into a worker container. */
  function renderSessionMessages(w, session) {
    // Show session banner
    var banner = document.createElement('div');
    banner.className = 'session-banner';
    var dateStr = new Date(session.ts).toLocaleString();
    banner.innerHTML =
      '<div class="session-banner-info">' +
        '<span class="session-banner-label">' + (w.isReadOnly ? 'Past Session' : 'Restored Session') + '</span>' +
        '<span class="session-banner-date">' + escapeHtml(dateStr) + '</span>' +
      '</div>' +
      '<div class="session-banner-summary">' + escapeHtml(session.summary) + '</div>';
    w.container.appendChild(banner);

    // Render messages
    session.messages.forEach(function (m) {
      if (m.role === 'user') {
        wAddMessage(w, 'user', m.text);
      } else if (m.role === 'assistant') {
        var el = document.createElement('div');
        el.className = 'message message-assistant';
        el.innerHTML = renderMarkdown(m.text);
        el.style.whiteSpace = 'normal';
        w.container.appendChild(el);
      } else if (m.role === 'tool') {
        var toolEl = document.createElement('div');
        toolEl.className = 'message message-system';
        toolEl.textContent = '\u2699 ' + (m.text || m.toolName || 'tool');
        w.container.appendChild(toolEl);
      } else if (m.role === 'system') {
        wAddSystemMessage(w, m.text);
      }
    });
  }

  function getDateLabel(ts) {
    var now = new Date();
    var date = new Date(ts);
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var yesterday = new Date(today.getTime() - 86400000);
    var sessionDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (sessionDate.getTime() === today.getTime()) { return 'Today'; }
    if (sessionDate.getTime() === yesterday.getTime()) { return 'Yesterday'; }

    var diff = today.getTime() - sessionDate.getTime();
    if (diff < 7 * 86400000) { return date.toLocaleDateString([], { weekday: 'long' }); }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
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
      '<button class="welcome-btn welcome-btn-secondary" id="welcome-switch-btn">⇄ Switch API</button>' +
      '<button class="welcome-btn welcome-btn-secondary" id="welcome-config-btn">⚙ Configure API</button>' +
      '<button class="welcome-btn welcome-btn-secondary" id="welcome-settings-btn">🔧 Settings</button>' +
      '</div>' +
      '<p class="welcome-hint">Set up your API key first if you haven\'t already.</p>';
    messagesWrapperInner.appendChild(welcome);

    document.getElementById('welcome-start-btn').addEventListener('click', function () {
      vscode.postMessage({ type: 'startSession' });
    });
    document.getElementById('welcome-switch-btn').addEventListener('click', function () {
      vscode.postMessage({ type: 'switchAPI' });
    });
    document.getElementById('welcome-config-btn').addEventListener('click', function () {
      vscode.postMessage({ type: 'configureAPI' });
    });
    document.getElementById('welcome-settings-btn').addEventListener('click', function () {
      vscode.postMessage({ type: 'openSettings' });
    });
  }

  // ── Utility ────────────────────────────────────────────────────────────

  function setStatus(state, text) {
    statusIndicator.className = 'status-' + state;
    statusText.textContent = text;
  }

  /** Disable or enable the input area based on connection state. */
  function setInputDisabled(isDisabled, hint) {
    inputEl.disabled = isDisabled;
    sendBtn.disabled = isDisabled;
    if (isDisabled) {
      inputEl.placeholder = hint || 'Connecting to agent...';
    } else {
      inputEl.placeholder = 'Send a message to the agent...';
    }
  }

  function setBusy(isBusy) {
    sendBtn.disabled = isBusy;
    if (isBusy) {
      stopBtn.classList.remove('hidden');
      sendBtn.style.display = 'none';
      setStatus('busy', 'Agent working...');
    } else {
      stopBtn.classList.add('hidden');
      sendBtn.style.display = '';
      // Check the visible worker's connection state
      var vw = getVisibleWorker();
      if (vw && vw.connected) {
        setStatus('connected', 'Ready');
      }
    }
  }

  function scrollToBottom() {
    var vw = getVisibleWorker();
    if (vw) {
      // Scroll the wrapper, not the container
      messagesWrapperInner.scrollTop = messagesWrapperInner.scrollHeight;
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Lightweight markdown-to-HTML renderer.
   * Handles: code blocks, inline code, headers, bold, italic,
   * links, lists (ul/ol), blockquotes, horizontal rules, paragraphs.
   */
  function renderMarkdown(src) {
    // Normalise line endings
    src = src.replace(/\r\n/g, '\n');

    // ── Pass 1: extract fenced code blocks to protect them ──
    var codeBlocks = [];
    src = src.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
      var idx = codeBlocks.length;
      codeBlocks.push(
        '<pre class="md-code-block"><code class="md-lang-' + escapeHtml(lang || 'text') + '">' +
        escapeHtml(code.replace(/\n$/, '')) +
        '</code></pre>'
      );
      return '\x00CB' + idx + '\x00';
    });

    // ── Process line-by-line ──
    var lines = src.split('\n');
    var out = [];
    var inList = false;
    var listTag = '';
    var inBlockquote = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // Code block placeholder
      var cbMatch = line.match(/^\x00CB(\d+)\x00$/);
      if (cbMatch) {
        closeList(); closeBlockquote();
        out.push(codeBlocks[parseInt(cbMatch[1], 10)]);
        continue;
      }

      // Horizontal rule
      if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
        closeList(); closeBlockquote();
        out.push('<hr class="md-hr">');
        continue;
      }

      // Headers
      var hMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (hMatch) {
        closeList(); closeBlockquote();
        var level = hMatch[1].length;
        out.push('<h' + level + ' class="md-h">' + inlineMarkdown(escapeHtml(hMatch[2])) + '</h' + level + '>');
        continue;
      }

      // Blockquote
      if (/^>\s?/.test(line)) {
        closeList();
        if (!inBlockquote) {
          out.push('<blockquote class="md-blockquote">');
          inBlockquote = true;
        }
        out.push(inlineMarkdown(escapeHtml(line.replace(/^>\s?/, ''))) + '<br>');
        continue;
      } else if (inBlockquote) {
        closeBlockquote();
      }

      // Unordered list
      var ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
      if (ulMatch) {
        if (!inList || listTag !== 'ul') {
          closeList();
          out.push('<ul class="md-list">');
          inList = true;
          listTag = 'ul';
        }
        out.push('<li>' + inlineMarkdown(escapeHtml(ulMatch[2])) + '</li>');
        continue;
      }

      // Ordered list
      var olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
      if (olMatch) {
        if (!inList || listTag !== 'ol') {
          closeList();
          out.push('<ol class="md-list">');
          inList = true;
          listTag = 'ol';
        }
        out.push('<li>' + inlineMarkdown(escapeHtml(olMatch[2])) + '</li>');
        continue;
      }

      // Close list if we hit a non-list line
      if (inList) { closeList(); }

      // Blank line
      if (!line.trim()) {
        continue;
      }

      // Normal paragraph
      out.push('<p class="md-p">' + inlineMarkdown(escapeHtml(line)) + '</p>');
    }

    closeList();
    closeBlockquote();
    return out.join('\n');

    function closeList() {
      if (inList) {
        out.push('</' + listTag + '>');
        inList = false;
        listTag = '';
      }
    }
    function closeBlockquote() {
      if (inBlockquote) {
        out.push('</blockquote>');
        inBlockquote = false;
      }
    }
  }

  /** Render inline markdown: bold, italic, strikethrough, code, links. */
  function inlineMarkdown(html) {
    // Inline code (must come first to protect contents)
    html = html.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
    // Bold + italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');
    // Strikethrough
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
    // Links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="md-link" href="$2" title="$2">$1</a>');
    return html;
  }

  // ── Request initial session list for welcome screen ──────────────────

  vscode.postMessage({ type: 'listSessions' });
})();
