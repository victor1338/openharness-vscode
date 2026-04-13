/**
 * Manages the OpenHarness Python backend process.
 * Spawns `python -m openharness.ui.backend_host` and communicates
 * via the OHJSON: JSON-lines protocol over stdin/stdout.
 */

import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { BackendEvent, FrontendRequest } from './protocol';

const PROTOCOL_PREFIX = 'OHJSON:';

export interface BackendOptions {
  pythonPath: string;
  cwd: string;
  model?: string;
  maxTurns?: number;
  apiKey?: string;
  apiFormat?: string;
  baseUrl?: string;
  permissionMode?: string;
  profile?: string;
  bridgeScriptPath: string;
}

export class BackendManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private _ready = false;
  private _interrupted = false;
  private outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    super();
    this.outputChannel = outputChannel;
  }

  get isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  get isReady(): boolean {
    return this._ready;
  }

  /**
   * Spawn the OpenHarness backend host process.
   */
  start(options: BackendOptions): void {
    if (this.isRunning) {
      this.outputChannel.appendLine('[OpenHarness] Backend already running.');
      return;
    }

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (options.apiKey) {
      // Set the appropriate env var based on provider format
      const format = options.apiFormat || 'anthropic';
      if (format === 'anthropic') {
        env['ANTHROPIC_API_KEY'] = options.apiKey;
      } else if (format === 'openai' || format === 'copilot') {
        env['OPENAI_API_KEY'] = options.apiKey;
      }
      // Also set a generic key that OpenHarness can pick up
      env['ANTHROPIC_API_KEY'] = env['ANTHROPIC_API_KEY'] || options.apiKey;
      env['OPENAI_API_KEY'] = env['OPENAI_API_KEY'] || options.apiKey;
    }

    // Build args: run the bridge script
    const args = [
      options.bridgeScriptPath,
      '--cwd', options.cwd,
    ];
    if (options.model) {
      args.push('--model', options.model);
    }
    if (options.maxTurns !== undefined) {
      args.push('--max-turns', String(options.maxTurns));
    }
    if (options.apiFormat) {
      args.push('--api-format', options.apiFormat);
    }
    if (options.baseUrl) {
      args.push('--base-url', options.baseUrl);
    }
    if (options.permissionMode) {
      args.push('--permission-mode', options.permissionMode);
    }
    if (options.profile) {
      args.push('--profile', options.profile);
    }

    this.outputChannel.appendLine(
      `[OpenHarness] Starting: ${options.pythonPath} ${args.join(' ')}`
    );
    this.outputChannel.appendLine(`[OpenHarness] CWD: ${options.cwd}`);

    this.process = spawn(options.pythonPath, args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Read stdout line-by-line for OHJSON: events
    this.rl = readline.createInterface({ input: this.process.stdout! });
    this.rl.on('line', (line: string) => {
      if (line.startsWith(PROTOCOL_PREFIX)) {
        const json = line.slice(PROTOCOL_PREFIX.length);
        try {
          const event: BackendEvent = JSON.parse(json);
          this.handleEvent(event);
        } catch (e) {
          this.outputChannel.appendLine(`[OpenHarness] Parse error: ${e}`);
        }
      } else {
        // Non-protocol output (logging, debug)
        this.outputChannel.appendLine(`[Backend] ${line}`);
      }
    });

    // Stderr → output channel
    this.process.stderr?.on('data', (data: Buffer) => {
      this.outputChannel.appendLine(`[Backend stderr] ${data.toString().trimEnd()}`);
    });

    this.process.on('exit', (code) => {
      this.outputChannel.appendLine(`[OpenHarness] Backend exited with code ${code}`);
      this._ready = false;
      this.process = null;
      this.rl = null;
      this.emit('exit', code);
    });

    this.process.on('error', (err) => {
      this.outputChannel.appendLine(`[OpenHarness] Backend error: ${err.message}`);
      vscode.window.showErrorMessage(
        `OpenHarness backend failed to start: ${err.message}`
      );
      this.emit('error', err);
    });
  }

  /**
   * Send a request to the backend via stdin.
   */
  send(request: FrontendRequest): void {
    if (!this.isRunning || !this.process?.stdin?.writable) {
      vscode.window.showWarningMessage('OpenHarness backend is not running.');
      return;
    }
    const json = JSON.stringify(request);
    this.process.stdin.write(json + '\n');
  }

  /**
   * Send a user message to the agent.
   */
  submitMessage(text: string): void {
    this.send({ type: 'submit_line', line: text });
  }

  /**
   * Request selection options for a command (e.g. /model, /provider).
   */
  selectCommand(command: string): void {
    this.send({ type: 'select_command', command });
  }

  /**
   * Apply a user's selection for a command.
   */
  applySelectCommand(command: string, value: string): void {
    this.send({ type: 'apply_select_command', command, value });
  }

  /**
   * Respond to a permission request.
   */
  respondPermission(requestId: string, allowed: boolean): void {
    this.send({ type: 'permission_response', request_id: requestId, allowed });
  }

  /**
   * Respond to a question from the agent.
   */
  respondQuestion(requestId: string, answer: string): void {
    this.send({ type: 'question_response', request_id: requestId, answer });
  }

  /**
   * Cancel the currently running agent turn without killing the session.
   */
  cancelTurn(): void {
    this.send({ type: 'cancel_turn' });
  }

  /**
   * Stop the backend gracefully.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) { return; }
    this.send({ type: 'shutdown' });

    // Wait briefly for graceful shutdown, then kill
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill();
        }
        resolve();
      }, 5000);

      this.process?.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  /**
   * Interrupt the current agent turn by killing the process immediately.
   * Unlike stop(), this doesn't attempt graceful shutdown.
   */
  async interrupt(): Promise<void> {
    if (!this.isRunning) { return; }
    this._interrupted = true;
    this.process?.kill();
    await new Promise<void>((resolve) => {
      if (!this.process) { resolve(); return; }
      this.process.on('exit', () => resolve());
      setTimeout(() => resolve(), 3000);
    });
  }

  get wasInterrupted(): boolean {
    return this._interrupted;
  }

  resetInterruptFlag(): void {
    this._interrupted = false;
  }

  private handleEvent(event: BackendEvent): void {
    if (event.type === 'ready') {
      this._ready = true;
      this.outputChannel.appendLine('[OpenHarness] Backend ready.');
    }
    this.emit('event', event);
  }

  dispose(): void {
    if (this.isRunning) {
      this.process?.kill();
    }
    this.rl?.close();
  }
}
