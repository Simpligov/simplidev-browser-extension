# SimpliDev Browser Extension

A Chrome extension that enables Sid Voice to control your browser via voice commands. Forked from [Playwright MCP Extension](https://github.com/microsoft/playwright-mcp/tree/main/extension).

## Features

- **Voice-controlled browsing**: "Show me SID-262" navigates to Jira tickets
- **Remote browser control**: Sid Voice sends commands via SignalR
- **Works with existing sessions**: Uses your logged-in state for Jira, GitHub, Confluence
- **MCP compatibility**: Still works with Cursor IDE's Playwright MCP

## Quick Start

### 1. Build the Extension

```bash
npm install
npm run build
```

### 2. Load in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in the top right corner)
3. Click "Load unpacked" and select the `dist` directory

### 3. Connect to Sid Voice

1. Click the SimpliDev extension icon
2. Enter your SimpliGov email
3. Click "Connect to Sid Voice"

Now you can control your browser with voice commands in Sid Voice!

## Voice Commands (when connected)

| Command | Action |
|---------|--------|
| "Show me SID-262" | Opens Jira ticket |
| "Open the linked PR" | Navigates to PR from ticket |
| "Click Approve" | Clicks the Approve button |
| "Fill in the description: LGTM" | Types into a field |

## Architecture

```
User's Browser
├── SimpliDev Extension
│   ├── SignalR → Sid Voice Server (voice commands)
│   └── WebSocket → Local MCP (Cursor IDE)
│
├── Jira Tab (authenticated)
├── GitHub Tab
└── Confluence Tab
```

## Development

```bash
# Build and watch for changes
npm run watch

# Run tests
npm test

# Clean build
npm run clean
```

## MCP Mode (for Cursor IDE)

This extension also works with Playwright MCP for Cursor:

```json
{
  "mcpServers": {
    "playwright-extension": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--extension"
      ]
    }
  }
}
```

## License

Apache-2.0 (forked from Microsoft Playwright MCP)
