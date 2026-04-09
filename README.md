# OpenHarness for VS Code

AI Agent Harness extension for Visual Studio Code — powered by [OpenHarness](https://github.com/HKUDS/OpenHarness).

## Features

- **Sidebar Chat Panel** — Interactive chat with the OpenHarness AI agent directly in VS Code
- **43+ Built-in Tools** — File editing, shell commands, code search, web access, MCP integration
- **Tool Execution Visualization** — See tool calls, inputs, and outputs in real-time
- **Permission Dialogs** — Approve or deny sensitive operations interactively
- **Status Bar** — Model name, provider info, and agent status at a glance
- **Multi-Provider Support** — Anthropic, OpenAI, GitHub Copilot, and 20+ other providers

## Prerequisites

1. **Python ≥ 3.10** installed and on your PATH
2. **OpenHarness** installed:
   ```bash
   pip install openharness
   ```
3. An **API key** configured (e.g. `ANTHROPIC_API_KEY` environment variable)

## Installation

### From Source

```bash
cd openharness-vscode
npm install
npm run compile
```

Then press `F5` in VS Code to launch the Extension Development Host.

### Package as VSIX

```bash
npm run package
```

Install the generated `.vsix` file via **Extensions → ⋯ → Install from VSIX**.

## Usage

1. Open the **OpenHarness** sidebar (Activity Bar icon or `Ctrl+Shift+H`)
2. Click **Start Session** or run `OpenHarness: Start Agent Session` from the Command Palette
3. Type a message and press Enter

### Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| `OpenHarness: Open Chat Panel` | `Ctrl+Shift+H` | Focus the chat sidebar |
| `OpenHarness: Start Agent Session` | — | Start/restart the agent backend |
| `OpenHarness: Stop Agent Session` | — | Stop the running agent |
| `OpenHarness: Send Message` | — | Quick input box to send a message |
| `OpenHarness: Clear Chat` | — | Clear the chat transcript |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `openharness.pythonPath` | `python` | Path to Python with OpenHarness installed |
| `openharness.model` | `sonnet` | Model alias or full name |
| `openharness.maxTurns` | `10` | Max agent turns per message |
| `openharness.permissionMode` | `default` | `default`, `permissive`, or `strict` |
| `openharness.apiKey` | — | API key (prefer env var for security) |
| `openharness.apiFormat` | `anthropic` | `anthropic`, `openai`, or `copilot` |
| `openharness.profile` | — | Provider profile name |

## Architecture

```
┌──────────────────────────────┐
│  VS Code Extension (TS)      │
│  ┌─────────────────────────┐ │
│  │ Webview Chat Panel      │ │
│  │ (HTML/CSS/JS)           │ │
│  └────────┬────────────────┘ │
│           │ postMessage      │
│  ┌────────▼────────────────┐ │
│  │ Extension Host          │ │
│  │ (backend.ts)            │ │
│  └────────┬────────────────┘ │
└───────────┼──────────────────┘
            │ stdin/stdout (OHJSON: protocol)
┌───────────▼──────────────────┐
│  Python Backend              │
│  openharness_vscode_bridge   │
│  └─ ReactBackendHost         │
│     └─ QueryEngine           │
│        └─ ToolRegistry (43+) │
│        └─ API Client         │
│        └─ Permissions        │
└──────────────────────────────┘
```

## License

MIT
