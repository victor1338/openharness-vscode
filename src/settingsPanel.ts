/**
 * OpenHarness Settings Panel — webview editor tab for configuration.
 *
 * Surfaces the main OpenHarness settings: API provider, model, permissions,
 * MCP servers, skills, memory, and behavior options.
 */

import * as vscode from 'vscode';
import { getNonce } from './utils';

export class SettingsPanel {
  public static readonly viewType = 'openharness.settingsPanel';

  private static currentPanel: SettingsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly secrets: vscode.SecretStorage;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    secrets: vscode.SecretStorage,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.secrets = secrets;

    this.panel.webview.html = this.getHtml(this.panel.webview);

    // Send current settings to webview once it's loaded
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Push initial config after a brief delay for webview init
    setTimeout(() => this.pushConfig(), 100);
  }

  /**
   * Open (or focus) the settings panel.
   */
  public static open(extensionUri: vscode.Uri, secrets: vscode.SecretStorage): void {
    if (SettingsPanel.currentPanel) {
      SettingsPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      SettingsPanel.viewType,
      'OpenHarness Settings',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        retainContextWhenHidden: true,
      },
    );

    SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri, secrets);
  }

  private dispose(): void {
    SettingsPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  /** Read all current settings and send to the webview. */
  private async pushConfig(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('openharness');
    const apiKey = await this.secrets.get('openharness.apiKey');

    this.panel.webview.postMessage({
      type: 'loadConfig',
      config: {
        model: cfg.get<string>('model') || 'sonnet',
        maxTurns: cfg.get<number>('maxTurns') ?? 10,
        apiFormat: cfg.get<string>('apiFormat') || 'anthropic',
        baseUrl: cfg.get<string>('baseUrl') || '',
        permissionMode: cfg.get<string>('permissionMode') || 'default',
        profile: cfg.get<string>('profile') || '',
        pythonPath: cfg.get<string>('pythonPath') || 'python',
        hasApiKey: !!apiKey,
        apiProfiles: cfg.get<any[]>('apiProfiles') || [],
        activeApiProfile: cfg.get<string>('activeApiProfile') || '',
      },
    });
  }

  /** Handle messages from the settings webview. */
  private async handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.pushConfig();
        break;

      case 'saveConfig': {
        const cfg = vscode.workspace.getConfiguration('openharness');
        const data = msg.config;
        const target = vscode.ConfigurationTarget.Global;

        if (data.model !== undefined) { await cfg.update('model', data.model || undefined, target); }
        if (data.maxTurns !== undefined) { await cfg.update('maxTurns', data.maxTurns, target); }
        if (data.apiFormat !== undefined) { await cfg.update('apiFormat', data.apiFormat, target); }
        if (data.baseUrl !== undefined) { await cfg.update('baseUrl', data.baseUrl || undefined, target); }
        if (data.permissionMode !== undefined) { await cfg.update('permissionMode', data.permissionMode, target); }
        if (data.profile !== undefined) { await cfg.update('profile', data.profile || undefined, target); }
        if (data.pythonPath !== undefined) { await cfg.update('pythonPath', data.pythonPath || 'python', target); }

        vscode.window.showInformationMessage('OpenHarness settings saved.');
        await this.pushConfig();
        break;
      }

      case 'saveApiKey': {
        if (msg.apiKey) {
          await this.secrets.store('openharness.apiKey', msg.apiKey);
          vscode.window.showInformationMessage('API key saved securely.');
        }
        await this.pushConfig();
        break;
      }

      case 'clearApiKey': {
        await this.secrets.delete('openharness.apiKey');
        vscode.window.showInformationMessage('API key removed.');
        await this.pushConfig();
        break;
      }

      case 'openConfigFile': {
        // Open .openharness/ settings.json in the workspace
        const folders = vscode.workspace.workspaceFolders;
        if (folders) {
          const settingsPath = vscode.Uri.joinPath(folders[0].uri, '.openharness', 'settings.json');
          try {
            await vscode.workspace.fs.stat(settingsPath);
            await vscode.window.showTextDocument(settingsPath);
          } catch {
            // Create with defaults
            const defaults = {
              "$schema": "https://openharness.dev/schema/settings.json",
              "permissions": { "mode": "default", "allowed_tools": [], "denied_tools": [] },
              "mcp_servers": {},
              "hooks": {},
              "memory": { "enabled": true }
            };
            await vscode.workspace.fs.writeFile(
              settingsPath,
              Buffer.from(JSON.stringify(defaults, null, 2)),
            );
            await vscode.window.showTextDocument(settingsPath);
          }
        }
        break;
      }

      case 'openMcpConfig': {
        const folders = vscode.workspace.workspaceFolders;
        if (folders) {
          const mcpPath = vscode.Uri.joinPath(folders[0].uri, '.openharness', 'mcp.json');
          try {
            await vscode.workspace.fs.stat(mcpPath);
            await vscode.window.showTextDocument(mcpPath);
          } catch {
            const defaults = { "mcpServers": {} };
            await vscode.workspace.fs.writeFile(
              mcpPath,
              Buffer.from(JSON.stringify(defaults, null, 2)),
            );
            await vscode.window.showTextDocument(mcpPath);
          }
        }
        break;
      }

      case 'openSkillsDir': {
        // Open the skills directory
        const folders = vscode.workspace.workspaceFolders;
        if (folders) {
          const skillsDir = vscode.Uri.joinPath(folders[0].uri, '.openharness', 'skills');
          try {
            await vscode.workspace.fs.stat(skillsDir);
          } catch {
            await vscode.workspace.fs.createDirectory(skillsDir);
          }
          // Open the folder in the explorer
          vscode.commands.executeCommand('revealInExplorer', skillsDir);
        }
        break;
      }

      case 'openHooksConfig': {
        // Same as openConfigFile but focused on hooks
        const folders = vscode.workspace.workspaceFolders;
        if (folders) {
          const settingsPath = vscode.Uri.joinPath(folders[0].uri, '.openharness', 'settings.json');
          try {
            await vscode.workspace.fs.stat(settingsPath);
          } catch {
            const defaults = {
              "hooks": {},
              "permissions": { "mode": "default" },
            };
            await vscode.workspace.fs.writeFile(
              settingsPath,
              Buffer.from(JSON.stringify(defaults, null, 2)),
            );
          }
          await vscode.window.showTextDocument(settingsPath);
        }
        break;
      }

      case 'configureAPI': {
        vscode.commands.executeCommand('openharness.configureAPI');
        break;
      }

      case 'switchProfile': {
        const cfg = vscode.workspace.getConfiguration('openharness');
        const profiles = cfg.get<any[]>('apiProfiles') || [];
        const target = vscode.ConfigurationTarget.Global;
        const profile = profiles.find((p: any) => p.name === msg.profileName);
        if (profile) {
          await cfg.update('apiFormat', profile.apiFormat, target);
          await cfg.update('baseUrl', profile.baseUrl || undefined, target);
          await cfg.update('model', profile.model || undefined, target);
          await cfg.update('activeApiProfile', profile.name, target);
          vscode.window.showInformationMessage(`Switched to: ${profile.name}`);
          await this.pushConfig();
        }
        break;
      }

      case 'saveProfile': {
        const cfg = vscode.workspace.getConfiguration('openharness');
        const profiles = cfg.get<any[]>('apiProfiles') || [];
        const target = vscode.ConfigurationTarget.Global;
        const newProfile = {
          name: msg.profile.name,
          apiFormat: msg.profile.apiFormat,
          baseUrl: msg.profile.baseUrl || '',
          model: msg.profile.model || '',
        };
        const existingIdx = profiles.findIndex((p: any) => p.name === newProfile.name);
        if (existingIdx >= 0) {
          profiles[existingIdx] = newProfile;
        } else {
          profiles.push(newProfile);
        }
        await cfg.update('apiProfiles', profiles, target);
        // Also apply this profile as the active one
        await cfg.update('apiFormat', newProfile.apiFormat, target);
        await cfg.update('baseUrl', newProfile.baseUrl || undefined, target);
        await cfg.update('model', newProfile.model || undefined, target);
        await cfg.update('activeApiProfile', newProfile.name, target);
        vscode.window.showInformationMessage(`Profile saved: ${newProfile.name}`);
        await this.pushConfig();
        break;
      }

      case 'deleteProfile': {
        const cfg = vscode.workspace.getConfiguration('openharness');
        const profiles = (cfg.get<any[]>('apiProfiles') || []).filter(
          (p: any) => p.name !== msg.profileName,
        );
        const target = vscode.ConfigurationTarget.Global;
        await cfg.update('apiProfiles', profiles, target);
        if (cfg.get<string>('activeApiProfile') === msg.profileName) {
          await cfg.update('activeApiProfile', '', target);
        }
        vscode.window.showInformationMessage(`Removed profile: ${msg.profileName}`);
        await this.pushConfig();
        break;
      }

      case 'startSession': {
        vscode.commands.executeCommand('openharness.startSession');
        break;
      }

      case 'scanSkills': {
        const skills = await this.scanSkills();
        this.panel.webview.postMessage({ type: 'skillsList', skills });
        break;
      }

      case 'scanPlugins': {
        const plugins = await this.scanPlugins();
        this.panel.webview.postMessage({ type: 'pluginsList', plugins });
        break;
      }

      case 'scanMemory': {
        const memory = await this.scanMemory();
        this.panel.webview.postMessage({ type: 'memoryList', files: memory.files, memoryDir: memory.dir });
        break;
      }

      case 'openFile': {
        if (msg.path) {
          const uri = vscode.Uri.file(msg.path);
          try {
            await vscode.window.showTextDocument(uri);
          } catch { /* file may not exist */ }
        }
        break;
      }

      case 'deleteMemoryFile': {
        if (msg.path) {
          try {
            await vscode.workspace.fs.delete(vscode.Uri.file(msg.path));
            const memory = await this.scanMemory();
            this.panel.webview.postMessage({ type: 'memoryList', files: memory.files, memoryDir: memory.dir });
          } catch { /* file may not exist */ }
        }
        break;
      }

      case 'createSkill': {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && msg.name) {
          const safeName = msg.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
          const skillDir = vscode.Uri.joinPath(folders[0].uri, '.openharness', 'skills', safeName);
          const skillFile = vscode.Uri.joinPath(skillDir, 'SKILL.md');
          try {
            await vscode.workspace.fs.createDirectory(skillDir);
            const template = `---\nname: ${safeName}\ndescription: ${msg.description || 'Custom skill'}\n---\n\n# ${msg.name}\n\n<!-- Add your skill instructions here -->\n`;
            await vscode.workspace.fs.writeFile(skillFile, Buffer.from(template));
            await vscode.window.showTextDocument(skillFile);
            const skills = await this.scanSkills();
            this.panel.webview.postMessage({ type: 'skillsList', skills });
          } catch { /* dir creation error */ }
        }
        break;
      }

      case 'createPlugin': {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && msg.name) {
          const safeName = msg.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
          const pluginDir = vscode.Uri.joinPath(folders[0].uri, '.openharness', 'plugins', safeName);
          const manifestFile = vscode.Uri.joinPath(pluginDir, 'plugin.json');
          const skillsDir = vscode.Uri.joinPath(pluginDir, 'skills');
          try {
            await vscode.workspace.fs.createDirectory(pluginDir);
            await vscode.workspace.fs.createDirectory(skillsDir);
            const manifest = {
              name: safeName,
              version: '1.0.0',
              description: msg.description || 'Custom plugin',
              enabled_by_default: true,
              skills_dir: 'skills',
            };
            await vscode.workspace.fs.writeFile(manifestFile, Buffer.from(JSON.stringify(manifest, null, 2)));
            await vscode.window.showTextDocument(manifestFile);
            const plugins = await this.scanPlugins();
            this.panel.webview.postMessage({ type: 'pluginsList', plugins });
          } catch { /* creation error */ }
        }
        break;
      }

      case 'openMemoryDir': {
        const memoryDir = this.getMemoryDir();
        if (memoryDir) {
          vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(memoryDir));
        }
        break;
      }

      case 'scanMcp': {
        const servers = await this.scanMcpServers();
        this.panel.webview.postMessage({ type: 'mcpList', servers });
        break;
      }

      case 'addMcpServer': {
        if (msg.name && msg.server) {
          await this.addMcpServer(msg.name, msg.server);
          const servers = await this.scanMcpServers();
          this.panel.webview.postMessage({ type: 'mcpList', servers });
        }
        break;
      }

      case 'removeMcpServer': {
        if (msg.name) {
          await this.removeMcpServer(msg.name);
          const servers = await this.scanMcpServers();
          this.panel.webview.postMessage({ type: 'mcpList', servers });
        }
        break;
      }
    }
  }

  // ── Filesystem scanning helpers ────────────────────────────────────────

  private getProjectRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    return folders?.[0]?.uri.fsPath || null;
  }

  private getMemoryDir(): string | null {
    const root = this.getProjectRoot();
    if (!root) { return null; }
    const path = require('path');
    return path.join(root, '.openharness', 'memory');
  }

  private async scanSkills(): Promise<Array<{name: string; description: string; source: string; path: string}>> {
    const path = require('path');
    const skills: Array<{name: string; description: string; source: string; path: string}> = [];
    const seen = new Set<string>();

    const scanDir = async (dir: string, source: string) => {
      try {
        const dirUri = vscode.Uri.file(dir);
        const entries = await vscode.workspace.fs.readDirectory(dirUri);
        for (const [name, type] of entries) {
          if (type !== vscode.FileType.Directory) { continue; }
          const skillFile = path.join(dir, name, 'SKILL.md');
          try {
            await vscode.workspace.fs.stat(vscode.Uri.file(skillFile));
            if (seen.has(name.toLowerCase())) { continue; }
            seen.add(name.toLowerCase());
            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(skillFile));
            const content = Buffer.from(bytes).toString();
            const desc = this.parseSkillDescription(content);
            skills.push({ name, description: desc, source, path: skillFile });
          } catch { /* no SKILL.md */ }
        }
      } catch { /* dir doesn't exist */ }
    };

    // Project skills
    const root = this.getProjectRoot();
    if (root) {
      await scanDir(path.join(root, '.openharness', 'skills'), 'project');
    }

    // User skills
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    if (homeDir) {
      await scanDir(path.join(homeDir, '.openharness', 'skills'), 'user');
    }

    return skills;
  }

  private parseSkillDescription(content: string): string {
    // Parse YAML frontmatter description
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const descMatch = fmMatch[1].match(/description:\s*['"]?(.+?)['"]?\s*$/m);
      if (descMatch) { return descMatch[1]; }
    }
    // Fallback: first paragraph after heading
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#')) {
        for (let j = i + 1; j < lines.length; j++) {
          const line = lines[j].trim();
          if (line && !line.startsWith('#')) { return line.slice(0, 120); }
        }
      }
    }
    return '';
  }

  private async scanPlugins(): Promise<Array<{name: string; description: string; version: string; source: string; path: string; enabled: boolean}>> {
    const path = require('path');
    const plugins: Array<{name: string; description: string; version: string; source: string; path: string; enabled: boolean}> = [];

    const scanDir = async (dir: string, source: string) => {
      try {
        const dirUri = vscode.Uri.file(dir);
        const entries = await vscode.workspace.fs.readDirectory(dirUri);
        for (const [name, type] of entries) {
          if (type !== vscode.FileType.Directory) { continue; }
          // Check plugin.json or .claude-plugin/plugin.json
          for (const manifestPath of [
            path.join(dir, name, 'plugin.json'),
            path.join(dir, name, '.claude-plugin', 'plugin.json'),
          ]) {
            try {
              const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(manifestPath));
              const manifest = JSON.parse(Buffer.from(bytes).toString());
              plugins.push({
                name: manifest.name || name,
                description: manifest.description || '',
                version: manifest.version || '0.0.0',
                source,
                path: path.join(dir, name),
                enabled: manifest.enabled_by_default !== false,
              });
              break;
            } catch { /* no manifest */ }
          }
        }
      } catch { /* dir doesn't exist */ }
    };

    // Project plugins
    const root = this.getProjectRoot();
    if (root) {
      await scanDir(path.join(root, '.openharness', 'plugins'), 'project');
    }

    // User plugins
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    if (homeDir) {
      await scanDir(path.join(homeDir, '.openharness', 'plugins'), 'user');
    }

    return plugins;
  }

  private async scanMemory(): Promise<{files: Array<{name: string; path: string; size: number; modified: string}>; dir: string}> {
    const memoryDir = this.getMemoryDir();
    const files: Array<{name: string; path: string; size: number; modified: string}> = [];
    if (!memoryDir) { return { files, dir: '' }; }

    try {
      // Ensure directory exists
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(memoryDir));
    } catch { /* may already exist */ }

    try {
      const dirUri = vscode.Uri.file(memoryDir);
      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith('.md')) { continue; }
        const filePath = require('path').join(memoryDir, name);
        try {
          const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
          files.push({
            name: name.replace(/\.md$/, ''),
            path: filePath,
            size: stat.size,
            modified: new Date(stat.mtime).toLocaleString(),
          });
        } catch { /* stat error */ }
      }
    } catch { /* dir doesn't exist yet */ }

    return { files, dir: memoryDir };
  }

  private getMcpConfigPath(): string | null {
    const root = this.getProjectRoot();
    if (!root) { return null; }
    const path = require('path');
    return path.join(root, '.openharness', 'mcp.json');
  }

  private async readMcpConfig(): Promise<{mcpServers: Record<string, any>}> {
    const configPath = this.getMcpConfigPath();
    if (!configPath) { return { mcpServers: {} }; }
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(configPath));
      return JSON.parse(Buffer.from(bytes).toString());
    } catch {
      return { mcpServers: {} };
    }
  }

  private async writeMcpConfig(config: {mcpServers: Record<string, any>}): Promise<void> {
    const configPath = this.getMcpConfigPath();
    if (!configPath) { return; }
    const path = require('path');
    // Ensure .openharness dir exists
    try {
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.file(path.dirname(configPath))
      );
    } catch { /* already exists */ }
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(configPath),
      Buffer.from(JSON.stringify(config, null, 2)),
    );
  }

  private async scanMcpServers(): Promise<Array<{name: string; type: string; detail: string; source: string}>> {
    const servers: Array<{name: string; type: string; detail: string; source: string}> = [];

    // Read from .openharness/mcp.json
    const mcpConfig = await this.readMcpConfig();
    if (mcpConfig.mcpServers) {
      for (const [name, cfg] of Object.entries(mcpConfig.mcpServers as Record<string, any>)) {
        const type = cfg.type || 'stdio';
        let detail = '';
        if (type === 'stdio') {
          detail = [cfg.command, ...(cfg.args || [])].join(' ');
        } else if (type === 'http' || type === 'ws') {
          detail = cfg.url || '';
        }
        servers.push({ name, type, detail, source: 'mcp.json' });
      }
    }

    // Also check .openharness/settings.json mcp_servers
    const root = this.getProjectRoot();
    if (root) {
      const path = require('path');
      const settingsPath = path.join(root, '.openharness', 'settings.json');
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(settingsPath));
        const settings = JSON.parse(Buffer.from(bytes).toString());
        if (settings.mcp_servers) {
          for (const [name, cfg] of Object.entries(settings.mcp_servers as Record<string, any>)) {
            // Don't duplicate if already in mcp.json
            if (servers.some(s => s.name === name)) { continue; }
            const type = cfg.type || 'stdio';
            let detail = '';
            if (type === 'stdio') {
              detail = [cfg.command, ...(cfg.args || [])].join(' ');
            } else if (type === 'http' || type === 'ws') {
              detail = cfg.url || '';
            }
            servers.push({ name, type, detail, source: 'settings.json' });
          }
        }
      } catch { /* no settings file */ }
    }

    return servers;
  }

  private async addMcpServer(name: string, server: any): Promise<void> {
    const config = await this.readMcpConfig();
    if (!config.mcpServers) { config.mcpServers = {}; }
    config.mcpServers[name] = server;
    await this.writeMcpConfig(config);
    vscode.window.showInformationMessage(`MCP server "${name}" added.`);
  }

  private async removeMcpServer(name: string): Promise<void> {
    const config = await this.readMcpConfig();
    if (config.mcpServers && config.mcpServers[name]) {
      delete config.mcpServers[name];
      await this.writeMcpConfig(config);
      vscode.window.showInformationMessage(`MCP server "${name}" removed.`);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'settings.css'),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'settings.js'),
    );
    const nonce = getNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <link href="${styleUri}" rel="stylesheet">
  <title>OpenHarness Settings</title>
</head>
<body>
  <div id="settings-app">

    <header id="settings-header">
      <h1>⚙ OpenHarness Settings</h1>
      <p class="subtitle">Configure your AI agent environment</p>
    </header>

    <!-- ── Tabs ─────────────────────────────────────── -->
    <nav id="tabs">
      <button class="tab active" data-tab="provider">Provider &amp; Model</button>
      <button class="tab" data-tab="permissions">Permissions</button>
      <button class="tab" data-tab="tools">Tools &amp; MCP</button>
      <button class="tab" data-tab="skills">Skills</button>
      <button class="tab" data-tab="plugins">Plugins</button>
      <button class="tab" data-tab="memory">Memory</button>
      <button class="tab" data-tab="advanced">Advanced</button>
    </nav>

    <!-- ── Provider & Model Tab ─────────────────────── -->
    <section class="tab-content active" data-tab="provider">

      <!-- Saved Profiles -->
      <div class="card">
        <div class="card-header-row">
          <div>
            <h2>API Profiles</h2>
            <p class="card-desc">Your saved provider configurations. Click "Use" to switch.</p>
          </div>
        </div>
        <div id="profiles-list" class="profiles-list">
          <p class="hint">No saved profiles yet. Configure a provider below and save it.</p>
        </div>
        <div class="separator"></div>
        <div class="save-profile-row">
          <input type="text" id="save-profile-name" placeholder="Profile name (e.g. Claude Sonnet, GPT-4o)..." class="save-profile-input">
          <button class="btn btn-primary" id="save-profile-btn">💾 Save Current as Profile</button>
        </div>
        <span class="hint">Saves the current Provider, Base URL, and Model as a reusable profile.</span>
      </div>

      <!-- Current Configuration -->
      <div class="card">
        <h2>Current Configuration</h2>
        <p class="card-desc">Set your provider, model, and generation limits. Changes apply when you save settings or save as a profile.</p>

        <div class="config-grid">
          <div class="field">
            <label for="api-format">Provider Format</label>
            <select id="api-format">
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI / Compatible</option>
              <option value="copilot">GitHub Copilot</option>
            </select>
          </div>
          <div class="field">
            <label for="model">Model</label>
            <input type="text" id="model" placeholder="sonnet, opus, gpt-4o, deepseek-chat...">
            <span class="hint">Alias or full model name</span>
          </div>
          <div class="field">
            <label for="base-url">Base URL <span class="hint">(blank = default)</span></label>
            <input type="text" id="base-url" placeholder="https://api.example.com/v1">
          </div>
          <div class="field">
            <label for="max-turns">Max Turns</label>
            <input type="number" id="max-turns" min="1" max="500" value="10">
            <span class="hint">Turns per message</span>
          </div>
        </div>

        <div class="field">
          <label for="profile">Profile Tag <span class="hint">(optional)</span></label>
          <input type="text" id="profile" placeholder="e.g. claude-api, openai-compatible">
        </div>
      </div>

      <!-- Quick Provider Select -->
      <div class="card">
        <h2>Quick Provider Setup</h2>
        <p class="card-desc">Click a provider to auto-fill format and base URL, then set your model above.</p>
        <div class="provider-grid">
          <button class="provider-btn" data-provider="anthropic" data-url="">
            <span class="provider-icon">☁</span>
            <span>Anthropic</span>
          </button>
          <button class="provider-btn" data-provider="openai" data-url="">
            <span class="provider-icon">🌐</span>
            <span>OpenAI</span>
          </button>
          <button class="provider-btn" data-provider="openai" data-url="https://api.deepseek.com/v1">
            <span class="provider-icon">🚀</span>
            <span>DeepSeek</span>
          </button>
          <button class="provider-btn" data-provider="openai" data-url="https://generativelanguage.googleapis.com/v1beta/openai">
            <span class="provider-icon">✦</span>
            <span>Gemini</span>
          </button>
          <button class="provider-btn" data-provider="openai" data-url="https://openrouter.ai/api/v1">
            <span class="provider-icon">⇄</span>
            <span>OpenRouter</span>
          </button>
          <button class="provider-btn" data-provider="copilot" data-url="">
            <span class="provider-icon">🐙</span>
            <span>Copilot</span>
          </button>
        </div>
      </div>

      <!-- API Key -->
      <div class="card">
        <h3>API Key</h3>
        <div class="field">
          <div id="api-key-status" class="key-status">No API key configured</div>
          <div class="field-row">
            <input type="password" id="api-key-input" placeholder="Enter your API key...">
            <button class="btn btn-primary" id="save-key-btn">Save Key</button>
          </div>
          <div class="field-row" style="margin-top:6px">
            <button class="btn btn-secondary" id="clear-key-btn">Clear Key</button>
            <button class="btn btn-secondary" id="run-wizard-btn">Run Setup Wizard</button>
          </div>
        </div>
      </div>

      <!-- Model Aliases (collapsible) -->
      <details class="card collapsible-card">
        <summary class="collapsible-header">Model Aliases — common shortcuts</summary>
        <table class="alias-table" style="margin-top:8px">
          <tr><td><code>sonnet</code></td><td>Claude Sonnet (latest)</td></tr>
          <tr><td><code>opus</code></td><td>Claude Opus (latest)</td></tr>
          <tr><td><code>haiku</code></td><td>Claude Haiku (fast, cheap)</td></tr>
          <tr><td><code>best</code></td><td>Best available model for your profile</td></tr>
          <tr><td><code>default</code></td><td>Default model for your profile</td></tr>
        </table>
      </details>
    </section>

    <!-- ── Permissions Tab ──────────────────────────── -->
    <section class="tab-content" data-tab="permissions">
      <div class="card">
        <h2>Permission Mode</h2>
        <p class="card-desc">Control how the agent requests approval for actions.</p>

        <div class="field">
          <label for="permission-mode">Mode</label>
          <select id="permission-mode">
            <option value="default">Default — Ask for sensitive operations</option>
            <option value="plan">Plan — Require plan approval first</option>
            <option value="full_auto">Full Auto — No confirmations (use with caution)</option>
          </select>
        </div>
      </div>

      <div class="card">
        <h2>Tool Access Rules</h2>
        <p class="card-desc">Fine-tune which tools the agent can use. Configure in your project's
          <code>.openharness/settings.json</code>.</p>
        <button class="btn btn-secondary" id="open-permissions-config-btn">
          Open settings.json
        </button>
        <div class="info-box" style="margin-top:12px">
          <strong>settings.json format:</strong>
          <pre>{
  "permissions": {
    "mode": "default",
    "allowed_tools": ["file_read", "grep"],
    "denied_tools": ["bash_tool"],
    "denied_commands": ["rm -rf"],
    "path_rules": [
      { "pattern": "**/.env*", "allow": false }
    ]
  }
}</pre>
        </div>
      </div>
    </section>

    <!-- ── Tools & MCP Tab ──────────────────────────── -->
    <section class="tab-content" data-tab="tools">
      <div class="card">
        <div class="card-header-row">
          <div>
            <h2>MCP Servers</h2>
            <p class="card-desc">Model Context Protocol servers extend the agent with external tools.</p>
          </div>
          <button class="btn btn-primary btn-sm" id="scan-mcp-btn">🔄 Scan</button>
        </div>
        <div id="mcp-list" class="items-list">
          <p class="hint">Click "Scan" to discover configured MCP servers.</p>
        </div>
      </div>

      <div class="card">
        <h2>Add MCP Server</h2>
        <div class="field">
          <label for="mcp-server-name">Server Name</label>
          <input type="text" id="mcp-server-name" placeholder="e.g. my-server">
        </div>
        <div class="field">
          <label for="mcp-server-type">Type</label>
          <select id="mcp-server-type">
            <option value="stdio">stdio (local command)</option>
            <option value="http">HTTP (remote URL)</option>
          </select>
        </div>
        <div id="mcp-stdio-fields">
          <div class="field">
            <label for="mcp-server-command">Command</label>
            <input type="text" id="mcp-server-command" placeholder="e.g. npx">
          </div>
          <div class="field">
            <label for="mcp-server-args">Arguments <span class="hint">(comma-separated)</span></label>
            <input type="text" id="mcp-server-args" placeholder="e.g. -y, @my/mcp-server">
          </div>
        </div>
        <div id="mcp-http-fields" style="display:none">
          <div class="field">
            <label for="mcp-server-url">URL</label>
            <input type="text" id="mcp-server-url" placeholder="https://mcp.example.com">
          </div>
        </div>
        <button class="btn btn-primary" id="add-mcp-btn" style="margin-top:8px">+ Add Server</button>
      </div>

      <div class="card">
        <div class="field-row" style="gap:8px">
          <button class="btn btn-secondary" id="open-mcp-config-btn">Open mcp.json</button>
        </div>
      </div>

      <div class="card">
        <h2>Built-in Tools</h2>
        <p class="card-desc">OpenHarness includes 43+ tools out of the box:</p>
        <div class="tool-grid">
          <div class="tool-chip">file_read</div>
          <div class="tool-chip">file_write</div>
          <div class="tool-chip">file_edit</div>
          <div class="tool-chip">bash_tool</div>
          <div class="tool-chip">grep</div>
          <div class="tool-chip">glob</div>
          <div class="tool-chip">web_search</div>
          <div class="tool-chip">web_fetch</div>
          <div class="tool-chip">lsp</div>
          <div class="tool-chip">notebook_edit</div>
          <div class="tool-chip">agent_tool</div>
          <div class="tool-chip">task_create</div>
          <div class="tool-chip">mcp_tool</div>
          <div class="tool-chip">skill_tool</div>
          <div class="tool-chip">config_tool</div>
          <div class="tool-chip">cron_*</div>
        </div>
        <p class="hint" style="margin-top:8px">Use <code>permissions.denied_tools</code> in settings.json to disable specific tools.</p>
      </div>
    </section>

    <!-- ── Skills Tab ───────────────────────────────── -->
    <section class="tab-content" data-tab="skills">
      <div class="card">
        <div class="card-header-row">
          <div>
            <h2>Skills</h2>
            <p class="card-desc">Reusable instruction sets that guide the agent's behavior.</p>
          </div>
          <button class="btn btn-primary btn-sm" id="scan-skills-btn">🔄 Scan</button>
        </div>
        <div id="skills-list" class="items-list">
          <p class="hint">Click "Scan" to discover skills from your project and user directories.</p>
        </div>
      </div>

      <div class="card">
        <h2>Create New Skill</h2>
        <div class="field-row" style="gap:8px; align-items:flex-end">
          <div class="field" style="flex:1">
            <label for="new-skill-name">Skill Name</label>
            <input type="text" id="new-skill-name" placeholder="e.g. code-review">
          </div>
          <div class="field" style="flex:2">
            <label for="new-skill-desc">Description</label>
            <input type="text" id="new-skill-desc" placeholder="Brief description of the skill">
          </div>
          <button class="btn btn-primary" id="create-skill-btn">+ Create</button>
        </div>
        <span class="hint">Creates a SKILL.md template in <code>.openharness/skills/</code></span>
      </div>

      <div class="card">
        <h2>Skill Directory Locations</h2>
        <div class="info-box">
          <pre>Project:  .openharness/skills/{name}/SKILL.md
User:     ~/.openharness/skills/{name}/SKILL.md</pre>
        </div>
        <div class="field-row" style="gap:8px; margin-top:8px">
          <button class="btn btn-secondary" id="open-skills-dir-btn">Open Project Skills</button>
          <button class="btn btn-secondary" id="open-project-config-btn">Open settings.json</button>
        </div>
      </div>
    </section>

    <!-- ── Plugins Tab ──────────────────────────────── -->
    <section class="tab-content" data-tab="plugins">
      <div class="card">
        <div class="card-header-row">
          <div>
            <h2>Plugins</h2>
            <p class="card-desc">Plugins extend OpenHarness with skills, commands, hooks, and MCP servers.</p>
          </div>
          <button class="btn btn-primary btn-sm" id="scan-plugins-btn">🔄 Scan</button>
        </div>
        <div id="plugins-list" class="items-list">
          <p class="hint">Click "Scan" to discover plugins from your project and user directories.</p>
        </div>
      </div>

      <div class="card">
        <h2>Create New Plugin</h2>
        <div class="field-row" style="gap:8px; align-items:flex-end">
          <div class="field" style="flex:1">
            <label for="new-plugin-name">Plugin Name</label>
            <input type="text" id="new-plugin-name" placeholder="e.g. my-plugin">
          </div>
          <div class="field" style="flex:2">
            <label for="new-plugin-desc">Description</label>
            <input type="text" id="new-plugin-desc" placeholder="Brief description of the plugin">
          </div>
          <button class="btn btn-primary" id="create-plugin-btn">+ Create</button>
        </div>
        <span class="hint">Creates a plugin scaffold with plugin.json in <code>.openharness/plugins/</code></span>
      </div>

      <div class="card">
        <h2>Plugin Structure</h2>
        <div class="info-box">
          <pre>.openharness/plugins/{name}/
    plugin.json         # Manifest
    skills/             # Skill definitions
    commands/           # Custom commands
    agents/             # Agent definitions

~/.openharness/plugins/  # User-global plugins</pre>
        </div>
      </div>
    </section>

    <!-- ── Memory Tab ───────────────────────────────── -->
    <section class="tab-content" data-tab="memory">
      <div class="card">
        <div class="card-header-row">
          <div>
            <h2>Memory Files</h2>
            <p class="card-desc">The agent remembers context across sessions using markdown files.</p>
          </div>
          <button class="btn btn-primary btn-sm" id="scan-memory-btn">🔄 Scan</button>
        </div>
        <div id="memory-dir-display" class="info-box" style="margin-bottom:8px">
          <strong>Location:</strong> <code id="memory-dir-path">.openharness/memory/</code>
        </div>
        <div id="memory-list" class="items-list">
          <p class="hint">Click "Scan" to see memory files for this project.</p>
        </div>
        <div class="field-row" style="gap:8px; margin-top:8px">
          <button class="btn btn-secondary" id="open-memory-dir-btn">Open in Explorer</button>
        </div>
      </div>

      <div class="card">
        <h2>Memory Settings</h2>
        <p class="card-desc">Configure memory behavior in <code>.openharness/settings.json</code>:</p>
        <div class="info-box" style="margin-top:8px">
          <pre>{
  "memory": {
    "enabled": true,
    "max_files": 5,
    "max_entrypoint_lines": 200
  }
}</pre>
        </div>
        <p class="hint" style="margin-top:8px">
          Use <code>/memory</code> in chat to manage entries, or edit the markdown files directly.
        </p>
      </div>
    </section>

    <!-- ── Advanced Tab ─────────────────────────────── -->
    <section class="tab-content" data-tab="advanced">
      <div class="card">
        <h2>Python Environment</h2>
        <div class="field">
          <label for="python-path">System Python Path</label>
          <input type="text" id="python-path" placeholder="python">
          <span class="hint">Used to create the extension's private venv. Requires Python ≥ 3.10.</span>
        </div>
      </div>

      <div class="card">
        <h2>Hooks</h2>
        <p class="card-desc">Hooks run custom validation logic before/after tool invocations.</p>
        <button class="btn btn-secondary" id="open-hooks-config-btn">
          Open settings.json
        </button>
        <div class="info-box" style="margin-top:12px">
          <strong>Hook types:</strong>
          <pre>{
  "hooks": {
    "tool_invocation": [
      {
        "type": "command",
        "command": "eslint --fix $ARGUMENTS",
        "timeout_seconds": 30,
        "block_on_failure": true
      },
      {
        "type": "prompt",
        "prompt": "Verify this is safe",
        "timeout_seconds": 30
      },
      {
        "type": "http",
        "url": "https://audit.example.com/hook",
        "timeout_seconds": 10
      }
    ]
  }
}</pre>
        </div>
      </div>

      <div class="card">
        <h2>Project Configuration File</h2>
        <p class="card-desc">All advanced settings can be configured in a single file:</p>
        <button class="btn btn-primary" id="open-full-config-btn">
          Open .openharness/settings.json
        </button>
      </div>
    </section>

    <!-- ── Footer ───────────────────────────────────── -->
    <footer id="settings-footer">
      <button class="btn btn-primary" id="save-all-btn">Save Settings</button>
      <button class="btn btn-secondary" id="start-session-btn">Start Session</button>
    </footer>

  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
