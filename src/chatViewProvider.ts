/**
 * Webview provider for the OpenHarness chat sidebar panel.
 * Renders chat messages, tool executions, and handles user input.
 */

import * as vscode from 'vscode';
import { BackendManager } from './backend';
import { BackendEvent, TranscriptItem } from './protocol';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'openharness.chatView';

  private view?: vscode.WebviewView;
  private backend: BackendManager;
  private extensionUri: vscode.Uri;

  constructor(extensionUri: vscode.Uri, backend: BackendManager) {
    this.extensionUri = extensionUri;
    this.backend = backend;

    // Forward all backend events to the webview
    this.backend.on('event', (event: BackendEvent) => {
      this.postMessage({ type: 'backendEvent', event });
    });

    this.backend.on('exit', () => {
      this.postMessage({ type: 'sessionEnded' });
    });
  }

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
    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.type) {
        case 'submitMessage':
          if (this.backend.isRunning && this.backend.isReady) {
            this.backend.submitMessage(message.text);
          } else {
            vscode.window.showWarningMessage(
              'OpenHarness session is not active. Use "OpenHarness: Start Agent Session" first.'
            );
          }
          break;

        case 'permissionResponse':
          this.backend.respondPermission(message.requestId, message.allowed);
          break;

        case 'questionResponse':
          this.backend.respondQuestion(message.requestId, message.answer);
          break;

        case 'startSession':
          vscode.commands.executeCommand('openharness.startSession');
          break;

        case 'stopSession':
          vscode.commands.executeCommand('openharness.stopSession');
          break;

        case 'configureAPI':
          vscode.commands.executeCommand('openharness.configureAPI');
          break;

        case 'openFile': {
          const filePath = message.path;
          if (filePath) {
            const uri = vscode.Uri.file(filePath);
            vscode.window.showTextDocument(uri, { preview: true });
          }
          break;
        }
      }
    });
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
      <span id="model-label"></span>
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
      <div id="input-wrapper">
        <textarea
          id="message-input"
          placeholder="Send a message to the agent..."
          rows="1"
        ></textarea>
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

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
