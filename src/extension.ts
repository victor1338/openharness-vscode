/**
 * OpenHarness VS Code Extension — main entry point.
 *
 * Activates the sidebar chat panel, manages the Python backend lifecycle,
 * and registers all commands including API configuration.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { BackendManager, BackendOptions } from './backend';
import { ChatViewProvider } from './chatViewProvider';
import { StatusBar } from './statusBar';

// Secret storage keys
const SECRET_API_KEY = 'openharness.apiKey';

let backend: BackendManager;
let statusBar: StatusBar;
let chatProvider: ChatViewProvider;
let outputChannel: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel('OpenHarness');
  backend = new BackendManager(outputChannel);
  statusBar = new StatusBar(backend);
  chatProvider = new ChatViewProvider(context.extensionUri, backend);

  // Register sidebar webview
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ── Commands ──────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('openharness.startSession', startSession),
    vscode.commands.registerCommand('openharness.stopSession', stopSession),
    vscode.commands.registerCommand('openharness.sendMessage', sendMessage),
    vscode.commands.registerCommand('openharness.clearChat', clearChat),
    vscode.commands.registerCommand('openharness.openPanel', openPanel),
    vscode.commands.registerCommand('openharness.configureAPI', configureAPI),
  );

  context.subscriptions.push(statusBar);
  context.subscriptions.push({ dispose: () => backend.dispose() });

  outputChannel.appendLine('[OpenHarness] Extension activated.');
}

export function deactivate() {
  backend?.stop();
}

// ── Python venv + OpenHarness auto-install ───────────────────────────────

/** Path to the extension's private venv. */
function getVenvDir(): string {
  return path.join(extensionContext.globalStorageUri.fsPath, 'venv');
}

/** Python executable inside the venv (platform-aware). */
function getVenvPython(): string {
  const venvDir = getVenvDir();
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

/** The system Python used only to create the venv. */
function getSystemPython(): string {
  return vscode.workspace.getConfiguration('openharness').get<string>('pythonPath', 'python');
}

/** Run a command and return stdout. Rejects on non-zero exit. */
function execCmd(bin: string, args: string[], timeoutMs = 300_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/** Check if a Python binary is reachable and return its version. */
async function checkPython(pythonPath: string): Promise<string | null> {
  try {
    return await execCmd(pythonPath, ['--version']);
  } catch {
    return null;
  }
}

/** Check if openharness is importable via a given Python. */
async function checkOpenHarness(pythonPath: string): Promise<boolean> {
  try {
    await execCmd(pythonPath, [
      '-c', 'from openharness.ui.backend_host import run_backend_host; print("ok")',
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Check if the private venv already exists. */
async function venvExists(): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(getVenvPython()));
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a private venv with OpenHarness is ready.
 *  1. Locate the system Python (only used to create the venv).
 *  2. Create a venv under globalStorage if it doesn't exist.
 *  3. pip-install openharness-ai into that venv if not already present.
 * Returns the venv Python path on success, or null on failure.
 */
async function ensureOpenHarnessInstalled(): Promise<string | null> {
  const venvPython = getVenvPython();

  // Fast path: venv exists and openharness is importable
  if (await venvExists() && await checkOpenHarness(venvPython)) {
    outputChannel.appendLine(`[OpenHarness] Venv ready: ${venvPython}`);
    return venvPython;
  }

  // Need system Python to bootstrap the venv
  const systemPython = getSystemPython();
  const pyVersion = await checkPython(systemPython);
  if (!pyVersion) {
    const action = await vscode.window.showErrorMessage(
      `Python not found at "${systemPython}". Install Python ≥ 3.10 or set "openharness.pythonPath" in settings.`,
      'Open Settings'
    );
    if (action === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'openharness.pythonPath');
    }
    return null;
  }
  outputChannel.appendLine(`[OpenHarness] System ${pyVersion} at ${systemPython}`);

  chatProvider.postMessage({
    type: 'backendEvent',
    event: { type: 'transcript_item', item: { role: 'system', text: 'Setting up OpenHarness environment... (one-time setup)' } },
  });

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'OpenHarness',
      cancellable: false,
    },
    async (progress) => {
      try {
        const venvDir = getVenvDir();

        // ── Create venv ────────────────────────────────────────────
        if (!(await venvExists())) {
          progress.report({ message: 'Creating virtual environment...' });
          outputChannel.appendLine(`[OpenHarness] Creating venv at ${venvDir}`);
          // Ensure parent dir exists
          await vscode.workspace.fs.createDirectory(
            vscode.Uri.file(path.dirname(venvDir))
          );
          await execCmd(systemPython, ['-m', 'venv', venvDir]);
          outputChannel.appendLine('[OpenHarness] Venv created.');
        }

        // ── Upgrade pip ────────────────────────────────────────────
        progress.report({ message: 'Upgrading pip...' });
        await execCmd(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);

        // ── Install openharness-ai ─────────────────────────────────
        if (await checkOpenHarness(venvPython)) {
          outputChannel.appendLine('[OpenHarness] Already installed in venv.');
          return venvPython;
        }

        // Check for local repo in workspace
        let localRepo: string | null = null;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
          for (const folder of workspaceFolders) {
            for (const sub of ['OpenHarness', '.']) {
              const candidate = path.join(folder.uri.fsPath, sub, 'pyproject.toml');
              try {
                const stat = await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
                if (stat.type === vscode.FileType.File) {
                  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(candidate));
                  if (Buffer.from(bytes).toString().includes('openharness')) {
                    localRepo = path.join(folder.uri.fsPath, sub);
                    break;
                  }
                }
              } catch { /* not found */ }
            }
            if (localRepo) { break; }
          }
        }

        if (localRepo) {
          progress.report({ message: 'Installing from local source...' });
          outputChannel.appendLine(`[OpenHarness] pip install -e ${localRepo}`);
          const out = await execCmd(venvPython, ['-m', 'pip', 'install', '-e', localRepo]);
          outputChannel.appendLine(out);
        } else {
          progress.report({ message: 'Installing openharness-ai from PyPI...' });
          outputChannel.appendLine('[OpenHarness] pip install openharness-ai');
          const out = await execCmd(venvPython, ['-m', 'pip', 'install', 'openharness-ai']);
          outputChannel.appendLine(out);
        }

        // Verify
        if (await checkOpenHarness(venvPython)) {
          return venvPython;
        }
        outputChannel.appendLine('[OpenHarness] Install succeeded but import still fails.');
        return null;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        outputChannel.appendLine(`[OpenHarness] Setup failed: ${msg}`);
        return null;
      }
    }
  );

  if (result) {
    chatProvider.postMessage({
      type: 'backendEvent',
      event: { type: 'transcript_item', item: { role: 'system', text: 'Environment ready.' } },
    });
    return result;
  }

  chatProvider.postMessage({
    type: 'backendEvent',
    event: { type: 'error', message: 'Failed to set up OpenHarness environment. Check Output panel.' },
  });
  const action = await vscode.window.showErrorMessage(
    'Failed to set up OpenHarness. See Output panel for details.',
    'Show Output',
    'Open Settings'
  );
  if (action === 'Show Output') {
    outputChannel.show();
  } else if (action === 'Open Settings') {
    vscode.commands.executeCommand('workbench.action.openSettings', 'openharness.pythonPath');
  }
  return null;
}

// ── API Configuration Wizard ─────────────────────────────────────────────

interface ProviderOption {
  label: string;
  apiFormat: string;
  envVar: string;
  defaultBaseUrl: string;
  keyPlaceholder: string;
  modelHint: string;
}

const PROVIDERS: ProviderOption[] = [
  {
    label: '$(cloud) Anthropic (Claude)',
    apiFormat: 'anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    defaultBaseUrl: '',
    keyPlaceholder: 'sk-ant-api03-...',
    modelHint: 'sonnet, opus, haiku, claude-sonnet-4-20250514',
  },
  {
    label: '$(globe) OpenAI (GPT, o1, o3, o4)',
    apiFormat: 'openai',
    envVar: 'OPENAI_API_KEY',
    defaultBaseUrl: '',
    keyPlaceholder: 'sk-...',
    modelHint: 'gpt-4o, o3, o4-mini',
  },
  {
    label: '$(rocket) DeepSeek',
    apiFormat: 'openai',
    envVar: 'DEEPSEEK_API_KEY',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    keyPlaceholder: 'sk-...',
    modelHint: 'deepseek-chat, deepseek-reasoner',
  },
  {
    label: '$(sparkle) Google Gemini',
    apiFormat: 'openai',
    envVar: 'GEMINI_API_KEY',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyPlaceholder: 'AIza...',
    modelHint: 'gemini-2.5-pro, gemini-2.5-flash',
  },
  {
    label: '$(arrow-swap) OpenRouter (any model)',
    apiFormat: 'openai',
    envVar: 'OPENROUTER_API_KEY',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    keyPlaceholder: 'sk-or-...',
    modelHint: 'anthropic/claude-sonnet-4, openai/gpt-4o',
  },
  {
    label: '$(github) GitHub Copilot',
    apiFormat: 'copilot',
    envVar: '',
    defaultBaseUrl: '',
    keyPlaceholder: '',
    modelHint: 'Uses your GitHub Copilot subscription (OAuth)',
  },
  {
    label: '$(server) Custom OpenAI-Compatible Endpoint',
    apiFormat: 'openai',
    envVar: 'OPENAI_API_KEY',
    defaultBaseUrl: '',
    keyPlaceholder: 'your-api-key',
    modelHint: 'Any model supported by your endpoint',
  },
];

async function configureAPI() {
  // Step 1: Pick provider
  const picked = await vscode.window.showQuickPick(
    PROVIDERS.map((p, i) => ({
      label: p.label,
      description: p.modelHint,
      index: i,
    })),
    {
      title: 'OpenHarness — Select API Provider',
      placeHolder: 'Choose your AI provider',
    }
  );

  if (!picked) { return; }
  const provider = PROVIDERS[picked.index];
  const config = vscode.workspace.getConfiguration('openharness');

  // Step 2: API Key (skip for Copilot/OAuth)
  if (provider.envVar) {
    const existingKey = await extensionContext.secrets.get(SECRET_API_KEY);
    const apiKey = await vscode.window.showInputBox({
      title: `${picked.label} — API Key`,
      prompt: `Enter your API key (stored securely in VS Code secret storage)`,
      placeHolder: provider.keyPlaceholder,
      password: true,
      value: existingKey ? '••••••••' : '',
      validateInput: (value) => {
        if (!value || value === '••••••••') { return null; }
        if (value.length < 8) { return 'API key seems too short'; }
        return null;
      },
    });

    if (apiKey === undefined) { return; } // cancelled
    if (apiKey && apiKey !== '••••••••') {
      await extensionContext.secrets.store(SECRET_API_KEY, apiKey);
      outputChannel.appendLine('[OpenHarness] API key saved to secret storage.');
    }
  }

  // Step 3: Base URL (for custom endpoints or if provider has a default)
  let baseUrl = provider.defaultBaseUrl;
  if (picked.label.includes('Custom')) {
    const inputUrl = await vscode.window.showInputBox({
      title: 'Custom Endpoint — Base URL',
      prompt: 'Enter the OpenAI-compatible API base URL',
      placeHolder: 'https://your-server.com/v1',
      validateInput: (value) => {
        if (!value) { return 'Base URL is required for custom endpoints'; }
        try {
          new URL(value);
          return null;
        } catch {
          return 'Please enter a valid URL';
        }
      },
    });
    if (inputUrl === undefined) { return; }
    baseUrl = inputUrl;
  }

  // Step 4: Model
  const modelInput = await vscode.window.showInputBox({
    title: `${picked.label} — Model`,
    prompt: 'Enter the model name (or leave blank for default)',
    placeHolder: provider.modelHint,
    value: config.get<string>('model') || '',
  });
  if (modelInput === undefined) { return; }

  // Step 5: Save all settings
  await config.update('apiFormat', provider.apiFormat, vscode.ConfigurationTarget.Global);
  if (baseUrl) {
    await config.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
  } else {
    await config.update('baseUrl', undefined, vscode.ConfigurationTarget.Global);
  }
  if (modelInput) {
    await config.update('model', modelInput, vscode.ConfigurationTarget.Global);
  }

  // Show summary
  const summary = [
    `Provider: ${picked.label.replace(/\$\([^)]+\)\s*/, '')}`,
    `Format: ${provider.apiFormat}`,
    baseUrl ? `Base URL: ${baseUrl}` : null,
    modelInput ? `Model: ${modelInput}` : null,
    provider.envVar ? `API Key: ••••••••` : 'Auth: OAuth',
  ].filter(Boolean).join('\n');

  const action = await vscode.window.showInformationMessage(
    `API configured! ${picked.label.replace(/\$\([^)]+\)\s*/, '')} is ready.`,
    'Start Session',
    'Done'
  );

  if (action === 'Start Session') {
    vscode.commands.executeCommand('openharness.startSession');
  }

  // Notify webview
  chatProvider.postMessage({ type: 'apiConfigured', provider: picked.label });
}

// ── Command implementations ──────────────────────────────────────────────

async function startSession() {
  if (backend.isRunning) {
    const choice = await vscode.window.showWarningMessage(
      'An OpenHarness session is already running. Restart it?',
      'Restart',
      'Cancel'
    );
    if (choice !== 'Restart') { return; }
    await backend.stop();
  }

  // Ensure Python + OpenHarness are available (auto-installs if needed)
  const venvPython = await ensureOpenHarnessInstalled();
  if (!venvPython) { return; }

  // Check if API is configured
  const config = vscode.workspace.getConfiguration('openharness');
  const apiFormat = config.get<string>('apiFormat', 'anthropic');
  const storedKey = await extensionContext.secrets.get(SECRET_API_KEY);
  const hasEnvKey = !!(
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.OPENROUTER_API_KEY
  );

  if (!storedKey && !hasEnvKey && apiFormat !== 'copilot') {
    const action = await vscode.window.showWarningMessage(
      'No API key configured. Set up a provider first.',
      'Configure API',
      'Continue Anyway'
    );
    if (action === 'Configure API') {
      vscode.commands.executeCommand('openharness.configureAPI');
      return;
    }
    if (!action) { return; }
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const cwd = workspaceFolders?.[0]?.uri.fsPath || process.cwd();

  const options: BackendOptions = {
    pythonPath: venvPython,
    cwd,
    bridgeScriptPath: path.join(extensionContext.extensionPath, 'bridge', 'openharness_vscode_bridge.py'),
    model: config.get<string>('model') || undefined,
    maxTurns: config.get<number>('maxTurns'),
    apiKey: storedKey || undefined,
    apiFormat: apiFormat || undefined,
    baseUrl: config.get<string>('baseUrl') || undefined,
    permissionMode: config.get<string>('permissionMode') || undefined,
    profile: config.get<string>('profile') || undefined,
  };

  backend.start(options);
  chatProvider.postMessage({ type: 'sessionStarted' });
}

async function stopSession() {
  if (!backend.isRunning) {
    vscode.window.showInformationMessage('No OpenHarness session is running.');
    return;
  }
  await backend.stop();
  vscode.window.showInformationMessage('OpenHarness session stopped.');
}

async function sendMessage() {
  if (!backend.isRunning || !backend.isReady) {
    vscode.window.showWarningMessage('Start an OpenHarness session first.');
    return;
  }

  const text = await vscode.window.showInputBox({
    prompt: 'Enter message for the agent',
    placeHolder: 'e.g. "Refactor the auth module"',
  });

  if (text) {
    backend.submitMessage(text);
  }
}

function clearChat() {
  chatProvider.postMessage({ type: 'clearChat' });
}

function openPanel() {
  vscode.commands.executeCommand('openharness.chatView.focus');
}
