/**
 * OpenHarness Settings Panel Script
 *
 * Handles tab switching, form state, and communication with the extension host
 * for reading/writing VS Code settings and SecretStorage.
 */

(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // ── DOM refs ───────────────────────────────────────────────────────────

  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');

  // Provider tab
  const apiFormatEl = document.getElementById('api-format');
  const baseUrlEl = document.getElementById('base-url');
  const profileEl = document.getElementById('profile');
  const apiKeyStatusEl = document.getElementById('api-key-status');
  const apiKeyInputEl = document.getElementById('api-key-input');
  const saveKeyBtn = document.getElementById('save-key-btn');
  const clearKeyBtn = document.getElementById('clear-key-btn');
  const runWizardBtn = document.getElementById('run-wizard-btn');

  // Model (now merged into provider tab)
  const modelEl = document.getElementById('model');
  const maxTurnsEl = document.getElementById('max-turns');

  // Profiles
  const profilesListEl = document.getElementById('profiles-list');
  const saveProfileNameEl = document.getElementById('save-profile-name');
  const saveProfileBtn = document.getElementById('save-profile-btn');

  // Permissions tab
  const permissionModeEl = document.getElementById('permission-mode');

  // Advanced tab
  const pythonPathEl = document.getElementById('python-path');

  // Footer
  const saveAllBtn = document.getElementById('save-all-btn');
  const startSessionBtn = document.getElementById('start-session-btn');

  // Config buttons
  var openPermissionsBtn = document.getElementById('open-permissions-config-btn');
  var openMcpBtn = document.getElementById('open-mcp-config-btn');
  var openSkillsBtn = document.getElementById('open-skills-dir-btn');
  var openProjectBtn = document.getElementById('open-project-config-btn');
  var openHooksBtn = document.getElementById('open-hooks-config-btn');
  var openFullConfigBtn = document.getElementById('open-full-config-btn');

  // ── Tab switching ──────────────────────────────────────────────────────

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var target = this.getAttribute('data-tab');
      tabs.forEach(function (t) { t.classList.remove('active'); });
      tabContents.forEach(function (c) { c.classList.remove('active'); });
      this.classList.add('active');
      var content = document.querySelector('.tab-content[data-tab="' + target + '"]');
      if (content) { content.classList.add('active'); }
    });
  });

  // ── Provider quick-select grid ─────────────────────────────────────────

  var providerBtns = document.querySelectorAll('.provider-btn');
  providerBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var format = this.getAttribute('data-provider');
      var url = this.getAttribute('data-url');
      apiFormatEl.value = format;
      baseUrlEl.value = url || '';
      // Visual feedback
      providerBtns.forEach(function (b) { b.classList.remove('selected'); });
      this.classList.add('selected');
    });
  });

  // ── API Key ────────────────────────────────────────────────────────────

  saveKeyBtn.addEventListener('click', function () {
    var key = apiKeyInputEl.value.trim();
    if (!key) { return; }
    vscode.postMessage({ type: 'saveApiKey', apiKey: key });
    apiKeyInputEl.value = '';
  });

  clearKeyBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'clearApiKey' });
  });

  runWizardBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'configureAPI' });
  });

  // ── Save profile ───────────────────────────────────────────────────────

  saveProfileBtn.addEventListener('click', function () {
    var name = saveProfileNameEl.value.trim();
    if (!name) {
      // Auto-generate a name from current settings
      var format = apiFormatEl.value || 'anthropic';
      var model = modelEl.value.trim();
      var formatLabel = format === 'anthropic' ? 'Anthropic' : format === 'copilot' ? 'Copilot' : 'OpenAI';
      var url = baseUrlEl.value.trim();
      if (url.indexOf('deepseek') >= 0) { formatLabel = 'DeepSeek'; }
      else if (url.indexOf('googleapis') >= 0) { formatLabel = 'Gemini'; }
      else if (url.indexOf('openrouter') >= 0) { formatLabel = 'OpenRouter'; }
      name = model ? formatLabel + ' (' + model + ')' : formatLabel;
    }
    vscode.postMessage({
      type: 'saveProfile',
      profile: {
        name: name,
        apiFormat: apiFormatEl.value,
        baseUrl: baseUrlEl.value.trim(),
        model: modelEl.value.trim(),
      },
    });
    saveProfileNameEl.value = '';
  });

  // ── Config file openers ────────────────────────────────────────────────

  if (openPermissionsBtn) {
    openPermissionsBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'openConfigFile' });
    });
  }

  if (openMcpBtn) {
    openMcpBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'openMcpConfig' });
    });
  }

  if (openSkillsBtn) {
    openSkillsBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'openSkillsDir' });
    });
  }

  if (openProjectBtn) {
    openProjectBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'openConfigFile' });
    });
  }

  if (openHooksBtn) {
    openHooksBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'openHooksConfig' });
    });
  }

  if (openFullConfigBtn) {
    openFullConfigBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'openConfigFile' });
    });
  }

  // ── Save all settings ──────────────────────────────────────────────────

  saveAllBtn.addEventListener('click', function () {
    vscode.postMessage({
      type: 'saveConfig',
      config: {
        model: modelEl.value.trim(),
        maxTurns: parseInt(maxTurnsEl.value, 10) || 10,
        apiFormat: apiFormatEl.value,
        baseUrl: baseUrlEl.value.trim(),
        permissionMode: permissionModeEl.value,
        profile: profileEl.value.trim(),
        pythonPath: pythonPathEl.value.trim(),
      },
    });
  });

  startSessionBtn.addEventListener('click', function () {
    // Save first, then start
    saveAllBtn.click();
    setTimeout(function () {
      vscode.postMessage({ type: 'startSession' });
    }, 300);
  });

  // ── Receive config from extension host ─────────────────────────────────

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (msg.type === 'loadConfig') {
      var c = msg.config;
      modelEl.value = c.model || '';
      maxTurnsEl.value = c.maxTurns || 10;
      apiFormatEl.value = c.apiFormat || 'anthropic';
      baseUrlEl.value = c.baseUrl || '';
      permissionModeEl.value = c.permissionMode || 'default';
      profileEl.value = c.profile || '';
      pythonPathEl.value = c.pythonPath || 'python';

      // Update API key status
      if (c.hasApiKey) {
        apiKeyStatusEl.textContent = '✓ API key is configured';
        apiKeyStatusEl.className = 'key-status has-key';
      } else {
        apiKeyStatusEl.textContent = '✗ No API key configured';
        apiKeyStatusEl.className = 'key-status no-key';
      }

      // Highlight matching provider button
      providerBtns.forEach(function (btn) {
        var fmt = btn.getAttribute('data-provider');
        var url = btn.getAttribute('data-url') || '';
        if (fmt === c.apiFormat && url === (c.baseUrl || '')) {
          btn.classList.add('selected');
        } else {
          btn.classList.remove('selected');
        }
      });

      // Render saved profiles
      renderProfiles(c.apiProfiles || [], c.activeApiProfile || '');
    } else if (msg.type === 'skillsList') {
      renderSkillsList(msg.skills);
    } else if (msg.type === 'pluginsList') {
      renderPluginsList(msg.plugins);
    } else if (msg.type === 'memoryList') {
      renderMemoryList(msg.files, msg.memoryDir);
    } else if (msg.type === 'mcpList') {
      renderMcpList(msg.servers);
    }
  });

  // ── Profile rendering ──────────────────────────────────────────────────

  function renderProfiles(profiles, activeProfileName) {
    if (!profilesListEl) { return; }

    if (!profiles || profiles.length === 0) {
      profilesListEl.innerHTML = '<p class="hint">No saved profiles yet. Configure a provider below or use the Setup Wizard.</p>';
      return;
    }

    profilesListEl.innerHTML = '';

    profiles.forEach(function (p) {
      var isActive = p.name === activeProfileName;
      var item = document.createElement('div');
      item.className = 'profile-item' + (isActive ? ' profile-active' : '');

      var providerIcon = getProviderIcon(p.apiFormat, p.baseUrl);

      item.innerHTML =
        '<div class="profile-info">' +
          '<span class="profile-icon">' + providerIcon + '</span>' +
          '<div class="profile-details">' +
            '<span class="profile-name">' + escapeHtml(p.name) + '</span>' +
            '<span class="profile-meta">' +
              escapeHtml(p.apiFormat) +
              (p.model ? ' · ' + escapeHtml(p.model) : '') +
              (p.baseUrl ? ' · ' + escapeHtml(p.baseUrl) : '') +
            '</span>' +
          '</div>' +
        '</div>' +
        '<div class="profile-actions">' +
          (isActive ? '<span class="profile-badge">Active</span>' : '') +
          '<button class="btn btn-sm' + (isActive ? ' btn-primary' : ' btn-secondary') + ' profile-use-btn">' +
            (isActive ? '✓ In Use' : 'Use') +
          '</button>' +
          '<button class="btn btn-sm btn-danger profile-delete-btn" title="Remove profile">✕</button>' +
        '</div>';

      profilesListEl.appendChild(item);

      // Use button
      var useBtn = item.querySelector('.profile-use-btn');
      useBtn.addEventListener('click', function () {
        vscode.postMessage({ type: 'switchProfile', profileName: p.name });
      });

      // Delete button
      var deleteBtn = item.querySelector('.profile-delete-btn');
      deleteBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        vscode.postMessage({ type: 'deleteProfile', profileName: p.name });
      });
    });
  }

  function getProviderIcon(apiFormat, baseUrl) {
    if (apiFormat === 'copilot') { return '🐙'; }
    if (apiFormat === 'anthropic') { return '☁'; }
    if (baseUrl && baseUrl.indexOf('deepseek') >= 0) { return '🚀'; }
    if (baseUrl && baseUrl.indexOf('generativelanguage.googleapis') >= 0) { return '✦'; }
    if (baseUrl && baseUrl.indexOf('openrouter') >= 0) { return '⇄'; }
    return '🌐';
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  // ── Skills Management ──────────────────────────────────────────────────

  var skillsListEl = document.getElementById('skills-list');
  var scanSkillsBtn = document.getElementById('scan-skills-btn');
  var createSkillBtn = document.getElementById('create-skill-btn');
  var newSkillNameEl = document.getElementById('new-skill-name');
  var newSkillDescEl = document.getElementById('new-skill-desc');

  if (scanSkillsBtn) {
    scanSkillsBtn.addEventListener('click', function () {
      skillsListEl.innerHTML = '<p class="hint">Scanning...</p>';
      vscode.postMessage({ type: 'scanSkills' });
    });
  }

  if (createSkillBtn) {
    createSkillBtn.addEventListener('click', function () {
      var name = newSkillNameEl.value.trim();
      if (!name) { return; }
      vscode.postMessage({ type: 'createSkill', name: name, description: newSkillDescEl.value.trim() });
      newSkillNameEl.value = '';
      newSkillDescEl.value = '';
    });
  }

  function renderSkillsList(skills) {
    if (!skillsListEl) { return; }
    if (!skills || skills.length === 0) {
      skillsListEl.innerHTML = '<p class="hint">No skills found. Create one below or add SKILL.md files to your project.</p>';
      return;
    }
    skillsListEl.innerHTML = '';
    skills.forEach(function (s) {
      var item = document.createElement('div');
      item.className = 'managed-item';
      var sourceBadge = s.source === 'project' ? '📁' : '👤';
      item.innerHTML =
        '<div class="managed-item-info">' +
          '<span class="managed-item-icon">' + sourceBadge + '</span>' +
          '<div class="managed-item-details">' +
            '<span class="managed-item-name">' + escapeHtml(s.name) + '</span>' +
            '<span class="managed-item-meta">' + escapeHtml(s.description) + '</span>' +
            '<span class="managed-item-source">' + escapeHtml(s.source) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="managed-item-actions">' +
          '<button class="btn btn-sm btn-secondary managed-open-btn" title="Edit">📝 Edit</button>' +
        '</div>';
      skillsListEl.appendChild(item);

      item.querySelector('.managed-open-btn').addEventListener('click', function () {
        vscode.postMessage({ type: 'openFile', path: s.path });
      });
    });
  }

  // ── Plugins Management ─────────────────────────────────────────────────

  var pluginsListEl = document.getElementById('plugins-list');
  var scanPluginsBtn = document.getElementById('scan-plugins-btn');
  var createPluginBtn = document.getElementById('create-plugin-btn');
  var newPluginNameEl = document.getElementById('new-plugin-name');
  var newPluginDescEl = document.getElementById('new-plugin-desc');

  if (scanPluginsBtn) {
    scanPluginsBtn.addEventListener('click', function () {
      pluginsListEl.innerHTML = '<p class="hint">Scanning...</p>';
      vscode.postMessage({ type: 'scanPlugins' });
    });
  }

  if (createPluginBtn) {
    createPluginBtn.addEventListener('click', function () {
      var name = newPluginNameEl.value.trim();
      if (!name) { return; }
      vscode.postMessage({ type: 'createPlugin', name: name, description: newPluginDescEl.value.trim() });
      newPluginNameEl.value = '';
      newPluginDescEl.value = '';
    });
  }

  function renderPluginsList(plugins) {
    if (!pluginsListEl) { return; }
    if (!plugins || plugins.length === 0) {
      pluginsListEl.innerHTML = '<p class="hint">No plugins found. Create one below or install plugins to your project.</p>';
      return;
    }
    pluginsListEl.innerHTML = '';
    plugins.forEach(function (p) {
      var item = document.createElement('div');
      item.className = 'managed-item';
      var sourceBadge = p.source === 'project' ? '📁' : '👤';
      var statusBadge = p.enabled ? '<span class="badge badge-success">enabled</span>' : '<span class="badge badge-muted">disabled</span>';
      item.innerHTML =
        '<div class="managed-item-info">' +
          '<span class="managed-item-icon">' + sourceBadge + '</span>' +
          '<div class="managed-item-details">' +
            '<span class="managed-item-name">' + escapeHtml(p.name) + ' <span class="managed-item-version">v' + escapeHtml(p.version) + '</span></span>' +
            '<span class="managed-item-meta">' + escapeHtml(p.description) + '</span>' +
            '<span class="managed-item-source">' + escapeHtml(p.source) + ' ' + statusBadge + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="managed-item-actions">' +
          '<button class="btn btn-sm btn-secondary managed-open-btn" title="Open plugin.json">📝 Edit</button>' +
        '</div>';
      pluginsListEl.appendChild(item);

      item.querySelector('.managed-open-btn').addEventListener('click', function () {
        vscode.postMessage({ type: 'openFile', path: p.path + (p.path.endsWith('.json') ? '' : '/plugin.json') });
      });
    });
  }

  // ── Memory Management ──────────────────────────────────────────────────

  var memoryListEl = document.getElementById('memory-list');
  var memoryDirPathEl = document.getElementById('memory-dir-path');
  var scanMemoryBtn = document.getElementById('scan-memory-btn');
  var openMemoryDirBtn = document.getElementById('open-memory-dir-btn');

  if (scanMemoryBtn) {
    scanMemoryBtn.addEventListener('click', function () {
      memoryListEl.innerHTML = '<p class="hint">Scanning...</p>';
      vscode.postMessage({ type: 'scanMemory' });
    });
  }

  if (openMemoryDirBtn) {
    openMemoryDirBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'openMemoryDir' });
    });
  }

  function renderMemoryList(files, memoryDir) {
    if (memoryDirPathEl && memoryDir) {
      memoryDirPathEl.textContent = memoryDir;
    }
    if (!memoryListEl) { return; }
    if (!files || files.length === 0) {
      memoryListEl.innerHTML = '<p class="hint">No memory files yet. Use <code>/memory add TITLE :: CONTENT</code> in chat to create entries.</p>';
      return;
    }
    memoryListEl.innerHTML = '';
    files.forEach(function (f) {
      var item = document.createElement('div');
      item.className = 'managed-item';
      var sizeKb = (f.size / 1024).toFixed(1);
      item.innerHTML =
        '<div class="managed-item-info">' +
          '<span class="managed-item-icon">📄</span>' +
          '<div class="managed-item-details">' +
            '<span class="managed-item-name">' + escapeHtml(f.name) + '</span>' +
            '<span class="managed-item-meta">' + escapeHtml(sizeKb) + ' KB · ' + escapeHtml(f.modified) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="managed-item-actions">' +
          '<button class="btn btn-sm btn-secondary managed-open-btn" title="View/Edit">📝 Edit</button>' +
          '<button class="btn btn-sm btn-danger managed-delete-btn" title="Delete">✕</button>' +
        '</div>';
      memoryListEl.appendChild(item);

      item.querySelector('.managed-open-btn').addEventListener('click', function () {
        vscode.postMessage({ type: 'openFile', path: f.path });
      });
      item.querySelector('.managed-delete-btn').addEventListener('click', function () {
        vscode.postMessage({ type: 'deleteMemoryFile', path: f.path });
      });
    });
  }

  // ── MCP Server Management ───────────────────────────────────────────────

  var mcpListEl = document.getElementById('mcp-list');
  var scanMcpBtn = document.getElementById('scan-mcp-btn');
  var addMcpBtn = document.getElementById('add-mcp-btn');
  var mcpServerNameEl = document.getElementById('mcp-server-name');
  var mcpServerTypeEl = document.getElementById('mcp-server-type');
  var mcpServerCommandEl = document.getElementById('mcp-server-command');
  var mcpServerArgsEl = document.getElementById('mcp-server-args');
  var mcpServerUrlEl = document.getElementById('mcp-server-url');
  var mcpStdioFieldsEl = document.getElementById('mcp-stdio-fields');
  var mcpHttpFieldsEl = document.getElementById('mcp-http-fields');

  if (mcpServerTypeEl) {
    mcpServerTypeEl.addEventListener('change', function () {
      if (mcpServerTypeEl.value === 'stdio') {
        mcpStdioFieldsEl.style.display = '';
        mcpHttpFieldsEl.style.display = 'none';
      } else {
        mcpStdioFieldsEl.style.display = 'none';
        mcpHttpFieldsEl.style.display = '';
      }
    });
  }

  if (scanMcpBtn) {
    scanMcpBtn.addEventListener('click', function () {
      mcpListEl.innerHTML = '<p class="hint">Scanning...</p>';
      vscode.postMessage({ type: 'scanMcp' });
    });
  }

  if (addMcpBtn) {
    addMcpBtn.addEventListener('click', function () {
      var name = mcpServerNameEl.value.trim();
      if (!name) { return; }
      var serverType = mcpServerTypeEl.value;
      var server;
      if (serverType === 'stdio') {
        var command = mcpServerCommandEl.value.trim();
        if (!command) { return; }
        var argsRaw = mcpServerArgsEl.value.trim();
        var args = argsRaw ? argsRaw.split(',').map(function(a) { return a.trim(); }).filter(Boolean) : [];
        server = { type: 'stdio', command: command, args: args };
      } else {
        var url = mcpServerUrlEl.value.trim();
        if (!url) { return; }
        server = { type: serverType, url: url };
      }
      vscode.postMessage({ type: 'addMcpServer', name: name, server: server });
      mcpServerNameEl.value = '';
      mcpServerCommandEl.value = '';
      mcpServerArgsEl.value = '';
      mcpServerUrlEl.value = '';
    });
  }

  function renderMcpList(servers) {
    if (!mcpListEl) { return; }
    if (!servers || servers.length === 0) {
      mcpListEl.innerHTML = '<p class="hint">No MCP servers configured. Add one below or edit mcp.json directly.</p>';
      return;
    }
    mcpListEl.innerHTML = '';
    servers.forEach(function (s) {
      var item = document.createElement('div');
      item.className = 'managed-item';
      var typeIcon = s.type === 'stdio' ? '⚙️' : '🌐';
      var typeBadge = '<span class="badge badge-' + (s.type === 'stdio' ? 'success' : 'info') + '">' + escapeHtml(s.type) + '</span>';
      item.innerHTML =
        '<div class="managed-item-info">' +
          '<span class="managed-item-icon">' + typeIcon + '</span>' +
          '<div class="managed-item-details">' +
            '<span class="managed-item-name">' + escapeHtml(s.name) + ' ' + typeBadge + '</span>' +
            '<span class="managed-item-meta">' + escapeHtml(s.detail) + '</span>' +
            '<span class="managed-item-source">' + escapeHtml(s.source) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="managed-item-actions">' +
          '<button class="btn btn-sm btn-danger managed-remove-btn" title="Remove">✕</button>' +
        '</div>';
      mcpListEl.appendChild(item);

      item.querySelector('.managed-remove-btn').addEventListener('click', function () {
        vscode.postMessage({ type: 'removeMcpServer', name: s.name });
      });
    });
  }

  // ── Request initial config ─────────────────────────────────────────────

  vscode.postMessage({ type: 'ready' });
})();
