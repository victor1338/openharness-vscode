/**
 * Webview provider for the OpenHarness chat sidebar panel.
 * Manages multiple parallel chat sessions, each with its own backend process.
 */

import * as vscode from 'vscode';
import { BackendManager, BackendOptions } from './backend';
import { BackendEvent } from './protocol';
import { StatusBar } from './statusBar';
import { getNonce } from './utils';

// ── Session persistence types ────────────────────────────────────────────

interface SessionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  toolName?: string;
  ts: number;
}

interface SavedSession {
  id: string;
  ts: number;
  summary: string;
  msgCount: number;
  toolCount: number;
  messages: SessionMessage[];
}

// ── Live session tracking ────────────────────────────────────────────────

interface LiveSession {
  id: string;
  backend: BackendManager;
  messages: SessionMessage[];
  assistantAccum: string;
  thinkingAccum: string;
  active: boolean;
  busy: boolean;
  pendingMessage?: string;
}

const SESSIONS_KEY = 'openharness.sessions';
const MAX_SESSIONS = 50;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'openharness.chatView';

  private view?: vscode.WebviewView;
  private extensionUri: vscode.Uri;
  private context: vscode.ExtensionContext;
  private outputChannel: vscode.OutputChannel;
  private statusBar: StatusBar | null = null;

  // Multi-session management
  private liveSessions = new Map<string, LiveSession>();
  private currentSessionId = '';

  // Backend factory — provided by extension.ts
  private _backendFactory: (() => Promise<BackendOptions | null>) | null = null;

  constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
    this.extensionUri = extensionUri;
    this.context = context;
    this.outputChannel = outputChannel;
  }

  setBackendFactory(factory: () => Promise<BackendOptions | null>): void {
    this._backendFactory = factory;
  }

  setStatusBar(bar: StatusBar): void {
    this.statusBar = bar;
  }

  // ── Public methods for extension commands ─────────────────────────────

  getCurrentBackend(): BackendManager | null {
    const ls = this.liveSessions.get(this.currentSessionId);
    return ls?.backend ?? null;
  }

  /** Start (or restart) the backend for the current session. */
  startCurrentSession(options: BackendOptions): void {
    if (!this.currentSessionId) {
      this.currentSessionId = this.generateSessionId();
      this.postMessage({ type: 'liveSessionCreated', sessionId: this.currentSessionId });
    }

    let ls = this.liveSessions.get(this.currentSessionId);
    if (ls) {
      ls.backend.resetInterruptFlag();
      ls.backend.start(options);
    } else {
      ls = this.createLiveSession(this.currentSessionId, options);
    }

    this.postMessage({ type: 'sessionStarted', sessionId: this.currentSessionId });
  }

  async stopCurrentSession(): Promise<void> {
    const ls = this.liveSessions.get(this.currentSessionId);
    if (!ls || !ls.backend.isRunning) { return; }
    await ls.backend.stop();
  }

  async interruptSession(sessionId?: string): Promise<void> {
    const sid = sessionId || this.currentSessionId;
    const ls = this.liveSessions.get(sid);
    if (!ls || !ls.backend.isRunning) { return; }

    this.postMessage({ type: 'sessionStopped', sessionId: sid });
    ls.busy = false;
    await ls.backend.interrupt();
    this.sendSessionList();

    // Auto-restart the backend for this session
    if (this._backendFactory) {
      const options = await this._backendFactory();
      if (options) {
        ls.backend.resetInterruptFlag();
        ls.backend.start(options);
      }
    }
  }

  dispose(): void {
    // Flush any pending debounced saves
    for (const [sid, timer] of this._saveTimers) {
      global.clearTimeout(timer);
    }
    this._saveTimers.clear();

    // Synchronously save all live sessions before killing backends
    for (const [id, ls] of this.liveSessions) {
      if (ls.messages.length > 0) {
        this.saveSessionMessagesImmediate(id);
      }
      ls.backend.dispose();
    }
    this.liveSessions.clear();
  }

  // ── Webview lifecycle ─────────────────────────────────────────────────

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'submitMessage': {
          const sid = message.sessionId || this.currentSessionId;
          let ls = this.liveSessions.get(sid);

          if (!ls) {
            // No backend for this session — auto-start one
            if (!this._backendFactory) {
              this.postMessage({
                type: 'backendEvent',
                event: { type: 'error', message: 'No API configured. Use "OpenHarness: Configure API" first.' },
                sessionId: sid,
              });
              break;
            }
            const options = await this._backendFactory();
            if (!options) {
              this.postMessage({
                type: 'backendEvent',
                event: { type: 'error', message: 'Failed to start session. Check Output panel.' },
                sessionId: sid,
              });
              break;
            }
            ls = this.createLiveSession(sid, options);
            ls.pendingMessage = message.text;
            ls.busy = true;
            this.postMessage({ type: 'sessionStarted', sessionId: sid });
          } else if (ls.backend.isRunning && ls.backend.isReady) {
            ls.messages.push({ role: 'user', text: message.text, ts: Date.now() });
            ls.busy = true;
            ls.backend.submitMessage(message.text);
            this.debouncedSave(sid);
            this.sendSessionList();
          } else if (!ls.backend.isRunning) {
            // Backend not running — restart it
            if (!this._backendFactory) { break; }
            const options = await this._backendFactory();
            if (!options) { break; }
            ls.pendingMessage = message.text;
            ls.backend.resetInterruptFlag();
            ls.backend.start(options);
            this.postMessage({ type: 'sessionStarted', sessionId: sid });
          } else {
            // Backend running but not ready yet — queue message
            ls.pendingMessage = message.text;
          }
          break;
        }

        case 'permissionResponse': {
          // sessionId MUST come from the modal that stored it — never fall back to currentSessionId
          const permSid = message.sessionId;
          if (!permSid) {
            this.outputChannel.appendLine('[OpenHarness] WARNING: permissionResponse without sessionId, dropping');
            break;
          }
          const permLs = this.liveSessions.get(permSid);
          if (permLs) { permLs.backend.respondPermission(message.requestId, message.allowed); }
          break;
        }

        case 'questionResponse': {
          const qSid = message.sessionId;
          if (!qSid) {
            this.outputChannel.appendLine('[OpenHarness] WARNING: questionResponse without sessionId, dropping');
            break;
          }
          const qLs = this.liveSessions.get(qSid);
          if (qLs) { qLs.backend.respondQuestion(message.requestId, message.answer); }
          break;
        }

        case 'startSession':
          vscode.commands.executeCommand('openharness.startSession');
          break;

        case 'stopSession':
        case 'killSession':
          vscode.commands.executeCommand('openharness.stopSession');
          break;

        case 'interruptAgent': {
          const sid = message.sessionId || this.currentSessionId;
          await this.interruptSession(sid);
          break;
        }

        case 'selectCommand': {
          const sid2 = message.sessionId || this.currentSessionId;
          const ls2 = this.liveSessions.get(sid2);
          if (ls2?.backend.isRunning && ls2.backend.isReady) {
            ls2.backend.selectCommand(message.command);
          }
          break;
        }

        case 'applySelectCommand': {
          const sid3 = message.sessionId || this.currentSessionId;
          const ls3 = this.liveSessions.get(sid3);
          if (ls3?.backend.isRunning && ls3.backend.isReady) {
            ls3.busy = true;
            ls3.backend.applySelectCommand(message.command, message.value);
          }
          break;
        }

        case 'configureAPI':
          vscode.commands.executeCommand('openharness.configureAPI');
          break;

        case 'switchAPI':
          vscode.commands.executeCommand('openharness.switchAPI');
          break;

        case 'openSettings':
          vscode.commands.executeCommand('openharness.openSettings');
          break;

        case 'openFile': {
          const filePath = message.path;
          if (filePath) {
            const uri = vscode.Uri.file(filePath);
            vscode.window.showTextDocument(uri, { preview: true });
          }
          break;
        }

        case 'newChat': {
          // Save current session messages to history
          if (this.currentSessionId) {
            await this.saveSessionMessages(this.currentSessionId);
          }
          // Create new session ID
          const newId = this.generateSessionId();
          this.currentSessionId = newId;
          this.postMessage({ type: 'liveSessionCreated', sessionId: newId });
          this.sendSessionList();
          break;
        }

        case 'listSessions':
          this.sendSessionList();
          break;

        case 'webviewReady':
          this.restoreAndAutoStart();
          break;

        case 'loadSession': {
          const sessions = this.getSessions();
          const session = sessions.find(s => s.id === message.sessionId);
          if (session) {
            this.postMessage({ type: 'sessionLoaded', session });
          }
          break;
        }

        case 'deleteSession':
          await this.deleteSession(message.sessionId);
          this.sendSessionList();
          break;

        case 'focusSession': {
          // User switched focus to a different live session
          const sid = message.sessionId;
          if (this.liveSessions.has(sid)) {
            this.currentSessionId = sid;
          }
          break;
        }
      }
    });
  }

  // ── Live session management ───────────────────────────────────────────

  private createLiveSession(sessionId: string, options: BackendOptions): LiveSession {
    const backend = new BackendManager(this.outputChannel);

    const ls: LiveSession = {
      id: sessionId,
      backend,
      messages: [],
      assistantAccum: '',
      thinkingAccum: '',
      active: false,
      busy: false,
    };

    backend.on('event', (event: BackendEvent) => {
      this.trackSessionEvent(sessionId, event);
      // Always include sessionId so frontend can route correctly
      this.postMessage({ type: 'backendEvent', event, sessionId });
      // Update status bar only for the focused session
      if (sessionId === this.currentSessionId) {
        this.statusBar?.handleEvent(event);
      }
    });

    backend.on('exit', (code: number) => {
      this.outputChannel.appendLine(`[OpenHarness] Session ${sessionId} backend exited (code=${code}, interrupted=${backend.wasInterrupted})`);
      if (backend.wasInterrupted) {
        // Interrupted — don't save to history, session will be restarted
      } else {
        this.saveSessionMessages(sessionId);
        this.postMessage({ type: 'sessionEnded', sessionId });
        if (sessionId === this.currentSessionId) {
          this.statusBar?.handleExit();
        }
        this.liveSessions.delete(sessionId);
        this.sendSessionList();
      }
    });

    backend.on('error', (err: Error) => {
      this.outputChannel.appendLine(`[OpenHarness] Session ${sessionId} backend error: ${err.message}`);
    });

    this.liveSessions.set(sessionId, ls);
    this.outputChannel.appendLine(`[OpenHarness] Starting backend for session ${sessionId} (total live: ${this.liveSessions.size})`);
    backend.start(options);
    return ls;
  }

  // ── Session event tracking ────────────────────────────────────────────

  private trackSessionEvent(sessionId: string, event: BackendEvent): void {
    const ls = this.liveSessions.get(sessionId);
    if (!ls) { return; }

    switch (event.type) {
      case 'ready':
        ls.active = true;
        // Send queued message if any
        if (ls.pendingMessage) {
          ls.messages.push({ role: 'user', text: ls.pendingMessage, ts: Date.now() });
          ls.busy = true;
          ls.backend.submitMessage(ls.pendingMessage);
          ls.pendingMessage = undefined;
          this.sendSessionList();
        }
        break;
      case 'thinking_delta':
        ls.thinkingAccum += event.message || '';
        break;
      case 'assistant_delta':
        ls.assistantAccum += event.message || '';
        break;
      case 'assistant_complete':
      case 'line_complete': {
        let text = ls.assistantAccum;
        if (!text && ls.thinkingAccum) {
          text = ls.thinkingAccum;
        }
        if (text) {
          ls.messages.push({ role: 'assistant', text, ts: Date.now() });
        }
        ls.assistantAccum = '';
        ls.thinkingAccum = '';
        ls.busy = false;
        // Auto-save after each complete turn
        this.debouncedSave(sessionId);
        this.sendSessionList();
        break;
      }
      case 'tool_started':
        ls.messages.push({
          role: 'tool',
          text: `${event.tool_name || 'tool'}: running`,
          toolName: event.tool_name,
          ts: Date.now(),
        });
        break;
      case 'tool_completed': {
        const lastTool = [...ls.messages].reverse().find(
          m => m.role === 'tool' && m.toolName === event.tool_name
        );
        if (lastTool) {
          lastTool.text = `${event.tool_name}: ${event.is_error ? 'error' : 'done'}`;
        }
        break;
      }
      case 'transcript_item':
        if (event.item?.role === 'system') {
          ls.messages.push({
            role: 'system',
            text: event.item.text,
            ts: Date.now(),
          });
        }
        break;
      case 'error':
        ls.messages.push({
          role: 'system',
          text: `Error: ${event.message || 'Unknown error'}`,
          ts: Date.now(),
        });
        ls.busy = false;
        this.debouncedSave(sessionId);
        this.sendSessionList();
        break;
    }
  }

  // ── Debounced auto-save ────────────────────────────────────────────────

  private _saveTimers = new Map<string, NodeJS.Timeout>();

  private debouncedSave(sessionId: string): void {
    const existing = this._saveTimers.get(sessionId);
    if (existing) { global.clearTimeout(existing); }
    this._saveTimers.set(sessionId, global.setTimeout(() => {
      this._saveTimers.delete(sessionId);
      this.saveSessionMessages(sessionId);
    }, 1000));
  }

  // ── Session persistence ───────────────────────────────────────────────

  private generateSessionId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  private async saveSessionMessages(sessionId: string): Promise<void> {
    const ls = this.liveSessions.get(sessionId);
    if (!ls || ls.messages.length === 0) { return; }

    const firstUserMsg = ls.messages.find(m => m.role === 'user');
    const summary = firstUserMsg
      ? firstUserMsg.text.substring(0, 120) + (firstUserMsg.text.length > 120 ? '…' : '')
      : 'Session';

    const msgCount = ls.messages.filter(m => m.role === 'user' || m.role === 'assistant').length;
    const toolCount = ls.messages.filter(m => m.role === 'tool').length;

    const session: SavedSession = {
      id: sessionId,
      ts: Date.now(),
      summary,
      msgCount,
      toolCount,
      messages: ls.messages.slice(),
    };

    const sessions = this.getSessions();
    const existingIdx = sessions.findIndex(s => s.id === session.id);
    if (existingIdx >= 0) {
      sessions[existingIdx] = session;
    } else {
      sessions.unshift(session);
    }

    while (sessions.length > MAX_SESSIONS) { sessions.pop(); }
    await this.context.workspaceState.update(SESSIONS_KEY, sessions);
  }

  /** Synchronous variant for use in dispose() — fires the update but doesn't await. */
  private saveSessionMessagesImmediate(sessionId: string): void {
    const ls = this.liveSessions.get(sessionId);
    if (!ls || ls.messages.length === 0) { return; }

    const firstUserMsg = ls.messages.find(m => m.role === 'user');
    const summary = firstUserMsg
      ? firstUserMsg.text.substring(0, 120) + (firstUserMsg.text.length > 120 ? '\u2026' : '')
      : 'Session';
    const msgCount = ls.messages.filter(m => m.role === 'user' || m.role === 'assistant').length;
    const toolCount = ls.messages.filter(m => m.role === 'tool').length;

    const session: SavedSession = {
      id: sessionId, ts: Date.now(), summary, msgCount, toolCount,
      messages: ls.messages.slice(),
    };

    const sessions = this.getSessions();
    const existingIdx = sessions.findIndex(s => s.id === session.id);
    if (existingIdx >= 0) { sessions[existingIdx] = session; } else { sessions.unshift(session); }
    while (sessions.length > MAX_SESSIONS) { sessions.pop(); }
    // Fire-and-forget — VS Code will flush workspaceState synchronously on shutdown
    this.context.workspaceState.update(SESSIONS_KEY, sessions);
  }

  private getSessions(): SavedSession[] {
    return this.context.workspaceState.get<SavedSession[]>(SESSIONS_KEY, []);
  }

  private async deleteSession(sessionId: string): Promise<void> {
    const sessions = this.getSessions().filter(s => s.id !== sessionId);
    await this.context.workspaceState.update(SESSIONS_KEY, sessions);
  }

  /** Restore the most recent session and auto-start a backend so it's ready to use. */
  private async restoreAndAutoStart(): Promise<void> {
    const sessions = this.getSessions();
    if (sessions.length === 0) {
      this.postMessage({ type: 'restoreSession', session: null });
      // Still auto-start a fresh session so the user can type immediately
      await this.autoStartSession();
      return;
    }
    const latest = sessions[0];
    this.currentSessionId = latest.id;
    this.postMessage({ type: 'restoreSession', session: latest });
    await this.autoStartSession();
  }

  /** Silently start a backend for the current session (creates one if needed). */
  private async autoStartSession(): Promise<void> {
    if (!this._backendFactory) { return; }
    const options = await this._backendFactory();
    if (!options) { return; }

    if (!this.currentSessionId) {
      this.currentSessionId = this.generateSessionId();
      this.postMessage({ type: 'liveSessionCreated', sessionId: this.currentSessionId });
    }

    let ls = this.liveSessions.get(this.currentSessionId);
    if (ls) {
      if (!ls.backend.isRunning) {
        ls.backend.resetInterruptFlag();
        ls.backend.start(options);
      }
    } else {
      ls = this.createLiveSession(this.currentSessionId, options);
    }
    this.postMessage({ type: 'sessionStarted', sessionId: this.currentSessionId });
  }

  private sendSessionList(): void {
    // Build list of running (live) sessions
    const liveSessions: Array<{ id: string; ts: number; summary: string; msgCount: number; toolCount: number; running: boolean }> = [];
    for (const [id, ls] of this.liveSessions) {
      const firstUser = ls.messages.find(m => m.role === 'user');
      const summary = firstUser
        ? firstUser.text.substring(0, 120) + (firstUser.text.length > 120 ? '…' : '')
        : 'New session';
      const msgCount = ls.messages.filter(m => m.role === 'user' || m.role === 'assistant').length;
      const toolCount = ls.messages.filter(m => m.role === 'tool').length;
      liveSessions.push({
        id,
        ts: ls.messages.length > 0 ? ls.messages[0].ts : Date.now(),
        summary,
        msgCount,
        toolCount,
        running: ls.busy,
      });
    }

    // Saved (past) sessions
    const savedSessions = this.getSessions().map(s => ({
      id: s.id,
      ts: s.ts,
      summary: s.summary,
      msgCount: s.msgCount,
      toolCount: s.toolCount,
      running: false,
    }));

    // Live sessions first, then saved
    const sessions = [...liveSessions, ...savedSessions];
    this.postMessage({ type: 'sessionList', sessions, currentSessionId: this.currentSessionId });
  }

  /**
   * Post a message to the webview.
   */
  postMessage(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.js')
    );
    const nonce = getNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <link href="${styleUri}" rel="stylesheet">
  <title>OpenHarness</title>
</head>
<body>
  <div id="app">
    <div id="status-bar">
      <span id="status-indicator" class="status-disconnected">●</span>
      <span id="status-text">Not connected</span>
      <span id="model-label" class="clickable-model" title="Click to switch API provider"></span>
      <span class="status-spacer"></span>
      <button id="history-btn" class="header-btn" title="Session History">🕘</button>
      <button id="new-chat-btn" class="header-btn" title="New Chat">＋</button>
    </div>

    <div id="history-panel" class="hidden">
      <div class="history-header">
        <span class="history-title">Session History</span>
        <button id="history-close-btn" class="header-btn" title="Close">✕</button>
      </div>
      <div id="history-list"></div>
    </div>

    <div id="chat-messages-wrapper">
      <div id="chat-messages"></div>
    </div>

    <div id="modal-overlay" class="hidden">
      <div id="modal-content">
        <div id="modal-title"></div>
        <div id="modal-message"></div>
        <div id="modal-actions"></div>
      </div>
    </div>

    <div id="input-area">
      <button id="back-to-live-btn" class="back-to-live-btn hidden">↩ Back to live session</button>
      <div id="input-wrapper">
        <textarea
          id="message-input"
          placeholder="Send a message to the agent..."
          rows="1"
        ></textarea>
        <button id="stop-btn" class="hidden" title="Stop agent (Escape)">
          <span class="codicon">■</span>
        </button>
        <button id="send-btn" title="Send (Enter)">
          <span class="codicon">▶</span>
        </button>
      </div>
      <div id="input-hint">
        <span>Enter to send · Shift+Enter for newline</span>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
