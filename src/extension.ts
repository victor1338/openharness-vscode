/**
 * OpenHarness VS Code Extension — main entry point.
 *
 * Activates the sidebar chat panel, manages the Python backend lifecycle,
 * and registers all commands including API configuration.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { BackendOptions } from './backend';
import { ChatViewProvider } from './chatViewProvider';
import { SettingsPanel } from './settingsPanel';
import { StatusBar } from './statusBar';

// Secret storage keys
const SECRET_API_KEY = 'openharness.apiKey';

let statusBar: StatusBar;
let chatProvider: ChatViewProvider;
let outputChannel: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel('OpenHarness');
  statusBar = new StatusBar();
  chatProvider = new ChatViewProvider(context.extensionUri, context, outputChannel);
  chatProvider.setStatusBar(statusBar);
  chatProvider.setBackendFactory(buildBackendOptions);

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
    vscode.commands.registerCommand('openharness.interruptAgent', interruptAgent),
    vscode.commands.registerCommand('openharness.sendMessage', sendMessage),
    vscode.commands.registerCommand('openharness.clearChat', clearChat),
    vscode.commands.registerCommand('openharness.newChat', () => {
      chatProvider.postMessage({ type: 'triggerNewChat' });
    }),
    vscode.commands.registerCommand('openharness.openPanel', openPanel),
    vscode.commands.registerCommand('openharness.configureAPI', configureAPI),
    vscode.commands.registerCommand('openharness.switchAPI', switchAPI),
    vscode.commands.registerCommand('openharness.openSettings', () => {
      SettingsPanel.open(context.extensionUri, context.secrets);
    }),
  );

  context.subscriptions.push(statusBar);
  context.subscriptions.push({ dispose: () => chatProvider.dispose() });

  outputChannel.appendLine('[OpenHarness] Extension activated.');

  // Auto-start session on activation
  startSession();
}

export function deactivate() {
  chatProvider?.dispose();
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

// ── API Profile Management ───────────────────────────────────────────────

interface ApiProfile {
  name: string;
  apiFormat: string;
  baseUrl: string;
  model: string;
}

function getSavedProfiles(): ApiProfile[] {
  const cfg = vscode.workspace.getConfiguration('openharness');
  return cfg.get<ApiProfile[]>('apiProfiles', []);
}

async function saveProfile(profile: ApiProfile): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('openharness');
  const profiles = getSavedProfiles();
  const existingIdx = profiles.findIndex(p => p.name === profile.name);
  if (existingIdx >= 0) {
    profiles[existingIdx] = profile;
  } else {
    profiles.push(profile);
  }
  await cfg.update('apiProfiles', profiles, vscode.ConfigurationTarget.Global);
}

async function activateProfile(profile: ApiProfile): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('openharness');
  const target = vscode.ConfigurationTarget.Global;
  await cfg.update('apiFormat', profile.apiFormat, target);
  await cfg.update('baseUrl', profile.baseUrl || undefined, target);
  await cfg.update('model', profile.model || undefined, target);
  await cfg.update('activeApiProfile', profile.name, target);
}

async function deleteProfile(profileName: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('openharness');
  const profiles = getSavedProfiles().filter(p => p.name !== profileName);
  await cfg.update('apiProfiles', profiles, vscode.ConfigurationTarget.Global);
  // Clear active if it was the deleted one
  if (cfg.get<string>('activeApiProfile') === profileName) {
    await cfg.update('activeApiProfile', '', vscode.ConfigurationTarget.Global);
  }
}

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
    const apiKey = await vscode.window.showInputBox({
      title: `${picked.label} — API Key`,
      prompt: `Enter your API key (stored securely in VS Code secret storage)`,
      placeHolder: provider.keyPlaceholder,
      password: true,
      validateInput: (value) => {
        if (!value) { return null; }
        if (value.length < 8) { return 'API key seems too short'; }
        return null;
      },
    });

    if (apiKey === undefined) { return; } // cancelled
    if (apiKey) {
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

  // Step 6: Save as a named profile
  const providerLabel = picked.label.replace(/\$\([^)]+\)\s*/, '');
  const profileName = modelInput
    ? `${providerLabel} (${modelInput})`
    : providerLabel;

  const profile: ApiProfile = {
    name: profileName,
    apiFormat: provider.apiFormat,
    baseUrl: baseUrl || '',
    model: modelInput || '',
  };
  await saveProfile(profile);
  await config.update('activeApiProfile', profileName, vscode.ConfigurationTarget.Global);

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

// ── Switch API (quick pick among saved profiles) ─────────────────────────

async function switchAPI() {
  const profiles = getSavedProfiles();
  const config = vscode.workspace.getConfiguration('openharness');
  const activeProfile = config.get<string>('activeApiProfile', '');

  if (profiles.length === 0) {
    const action = await vscode.window.showInformationMessage(
      'No saved API profiles. Configure one first.',
      'Configure API'
    );
    if (action === 'Configure API') {
      vscode.commands.executeCommand('openharness.configureAPI');
    }
    return;
  }

  // Build quick pick items from saved profiles
  const items: (vscode.QuickPickItem & { profileName?: string; action?: string })[] = profiles.map(p => ({
    label: `${p.name === activeProfile ? '$(check) ' : ''}${p.name}`,
    description: `${p.apiFormat}${p.model ? ' · ' + p.model : ''}${p.baseUrl ? ' · ' + p.baseUrl : ''}`,
    profileName: p.name,
  }));

  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator } as any,
    { label: '$(add) Add New Provider...', action: 'add' },
    { label: '$(trash) Remove a Profile...', action: 'remove' },
  );

  const picked = await vscode.window.showQuickPick(items, {
    title: 'OpenHarness — Switch API Provider',
    placeHolder: 'Select an API provider to use',
  });

  if (!picked) { return; }

  if ((picked as any).action === 'add') {
    vscode.commands.executeCommand('openharness.configureAPI');
    return;
  }

  if ((picked as any).action === 'remove') {
    const removeItems = profiles.map(p => ({
      label: p.name,
      description: `${p.apiFormat}${p.model ? ' · ' + p.model : ''}`,
    }));
    const toRemove = await vscode.window.showQuickPick(removeItems, {
      title: 'Remove API Profile',
      placeHolder: 'Select a profile to remove',
    });
    if (toRemove) {
      await deleteProfile(toRemove.label);
      vscode.window.showInformationMessage(`Removed profile: ${toRemove.label}`);
      chatProvider.postMessage({ type: 'apiProfilesChanged' });
    }
    return;
  }

  // Activate the selected profile
  const profileName = (picked as any).profileName;
  const profile = profiles.find(p => p.name === profileName);
  if (profile) {
    await activateProfile(profile);
    vscode.window.showInformationMessage(`Switched to: ${profile.name}`);
    chatProvider.postMessage({
      type: 'apiSwitched',
      profile: profile.name,
      model: profile.model,
      apiFormat: profile.apiFormat,
    });

    // If a session is running, ask to restart
    if (chatProvider.getCurrentBackend()?.isRunning) {
      const restart = await vscode.window.showInformationMessage(
        'API provider changed. Restart the session to use the new provider?',
        'Restart',
        'Later'
      );
      if (restart === 'Restart') {
        await chatProvider.stopCurrentSession();
        vscode.commands.executeCommand('openharness.startSession');
      }
    }
  }
}

// ── Command implementations ──────────────────────────────────────────────

/**
 * Build backend options from current configuration.
 * Handles venv setup, API key retrieval, and config resolution.
 * Returns null if setup fails or is cancelled.
 */
async function buildBackendOptions(): Promise<BackendOptions | null> {
  // Ensure Python + OpenHarness are available (auto-installs if needed)
  const venvPython = await ensureOpenHarnessInstalled();
  if (!venvPython) { return null; }

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
      return null;
    }
    if (!action) { return null; }
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const cwd = workspaceFolders?.[0]?.uri.fsPath || process.cwd();

  const model = config.get<string>('model') || undefined;
  const maxTurns = config.get<number>('maxTurns');
  outputChannel.appendLine(`[OpenHarness] Config → model=${model}, maxTurns=${maxTurns}, apiFormat=${apiFormat}`);

  return {
    pythonPath: venvPython,
    cwd,
    bridgeScriptPath: path.join(extensionContext.extensionPath, 'bridge', 'openharness_vscode_bridge.py'),
    model,
    maxTurns,
    apiKey: storedKey || undefined,
    apiFormat: apiFormat || undefined,
    baseUrl: config.get<string>('baseUrl') || undefined,
    permissionMode: config.get<string>('permissionMode') || undefined,
    profile: config.get<string>('profile') || undefined,
  };
}

async function startSession() {
  const currentBackend = chatProvider.getCurrentBackend();
  if (currentBackend?.isRunning) {
    const choice = await vscode.window.showWarningMessage(
      'This session already has a running backend. Restart it?',
      'Restart',
      'Cancel'
    );
    if (choice !== 'Restart') { return; }
    await chatProvider.stopCurrentSession();
  }

  const options = await buildBackendOptions();
  if (!options) { return; }

  chatProvider.startCurrentSession(options);
}

async function stopSession() {
  const currentBackend = chatProvider.getCurrentBackend();
  if (!currentBackend?.isRunning) {
    vscode.window.showInformationMessage('No OpenHarness session is running.');
    return;
  }
  await chatProvider.stopCurrentSession();
  vscode.window.showInformationMessage('OpenHarness session stopped.');
}

async function interruptAgent() {
  await chatProvider.interruptSession();
}

async function sendMessage() {
  const currentBackend = chatProvider.getCurrentBackend();
  if (!currentBackend?.isRunning || !currentBackend.isReady) {
    vscode.window.showWarningMessage('Start an OpenHarness session first.');
    return;
  }

  const text = await vscode.window.showInputBox({
    prompt: 'Enter message for the agent',
    placeHolder: 'e.g. "Refactor the auth module"',
  });

  if (text) {
    currentBackend.submitMessage(text);
  }
}

function clearChat() {
  chatProvider.postMessage({ type: 'clearChat' });
}

function openPanel() {
  vscode.commands.executeCommand('openharness.chatView.focus');
}
