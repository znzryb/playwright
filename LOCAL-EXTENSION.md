# Local extension background mode

This branch adds `PLAYWRIGHT_MCP_EXTENSION_NO_FOCUS=1`. With it enabled:

- Connecting does not call `chrome.tabs.update({ active: true })` or `chrome.windows.update({ focused: true })`.
- MCP-created tabs use `active: false`.
- The extension relay acknowledges `Page.bringToFront` and `Target.activateTarget` without forwarding them. MCP tab selection still changes the agent's current page.
- Manual clicks on the extension action and status page keep their normal behavior.

Without the environment variable, upstream behavior is preserved. This requires both the local MCP server and the local unpacked extension.

## Build and run

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts
npm run build -- --disable-install
./utils/local-extension-mcp.sh
```

The launcher reads the existing Codex extension token file if no token is set in the environment. It never prints it. The unpacked extension has the same extension ID as the store build; keep only one enabled in the target Chrome profile. Use the token shown by the unpacked extension if it differs from the existing token.

On this machine the extension deployment directory is:

`~/chrome-extensions/playwright-no-focus/`

Load it once through Canary's `chrome://extensions` → Developer mode → Load unpacked. The launcher can be used as the MCP command in extension mode. It does not change the existing headless MCP configuration.

## Scope and remaining limitation

Opening the initial connection/authorization page still uses Chrome's process-singleton command-line path. Chrome may activate its window or select that page. This change does not guarantee zero focus changes during that first handshake. The background behavior applies after that bootstrap, including connection completion, new tabs, selection, and ordinary input. Closing the user's active tab or a website opening its own popup can also change the browser's active tab.

Regression test:

```sh
npm run test-extension -- tab-management.spec.ts --workers=1
```

The regression observes Chrome's active tab while MCP creates/selects pages and fills/clicks controls in the background. It also records extension focus API calls during connection. It does not measure macOS foreground application focus.
