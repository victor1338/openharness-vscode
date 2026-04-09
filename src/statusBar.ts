/**
 * Status bar integration showing backend state, model, and provider info.
 */

import * as vscode from 'vscode';
import { BackendManager } from './backend';
import { BackendEvent, AppState } from './protocol';

export class StatusBar {
  private statusItem: vscode.StatusBarItem;
  private modelItem: vscode.StatusBarItem;
  private backend: BackendManager;

  constructor(backend: BackendManager) {
    this.backend = backend;

    this.statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusItem.command = 'openharness.openPanel';
    this.statusItem.text = '$(hubot) OH: Idle';
    this.statusItem.tooltip = 'OpenHarness — Click to open chat';
    this.statusItem.show();

    this.modelItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99
    );
    this.modelItem.show();

    this.backend.on('event', (event: BackendEvent) => {
      this.handleEvent(event);
    });

    this.backend.on('exit', () => {
      this.statusItem.text = '$(hubot) OH: Idle';
      this.statusItem.color = undefined;
      this.modelItem.text = '';
    });
  }

  private handleEvent(event: BackendEvent): void {
    switch (event.type) {
      case 'ready':
        this.statusItem.text = '$(hubot) OH: Ready';
        this.statusItem.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
        if (event.state) {
          this.updateState(event.state);
        }
        break;

      case 'state_snapshot':
        if (event.state) {
          this.updateState(event.state);
        }
        break;

      case 'assistant_delta':
        this.statusItem.text = '$(loading~spin) OH: Thinking...';
        break;

      case 'tool_started':
        this.statusItem.text = `$(gear~spin) OH: ${event.tool_name || 'tool'}`;
        break;

      case 'line_complete':
      case 'assistant_complete':
        this.statusItem.text = '$(hubot) OH: Ready';
        break;

      case 'error':
        this.statusItem.text = '$(warning) OH: Error';
        break;
    }
  }

  private updateState(state: AppState): void {
    const model = state.model || 'unknown';
    const provider = state.provider || '';
    this.modelItem.text = `$(symbol-event) ${model}`;
    this.modelItem.tooltip = `Provider: ${provider}\nPermission: ${state.permission_mode}\nCWD: ${state.cwd}`;
  }

  dispose(): void {
    this.statusItem.dispose();
    this.modelItem.dispose();
  }
}
