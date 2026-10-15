# ZNZRYB Playwright background extension

Fork: https://github.com/znzryb/playwright

This branch replaces the extension-mode bootstrap with an authenticated local WebSocket connection. The extension initiates the connection. Background mode never starts Chrome, opens an authorization page, activates a browser window, or selects an automation tab.

The existing MCP process hosts discovery. No native messaging host, additional application, cloud service, or hidden page is installed. The extension requires Chrome 120 or newer.

## Use on this machine

1. In Canary's `chrome://extensions`, reload **Playwright · ZNZRYB No Focus**, version **0.4.0-znzryb.2**. The unpacked directory is `~/chrome-extensions/playwright-no-focus/`.
2. Open the extension's status/settings page once, manually. It migrates the existing token from extension `localStorage` into `chrome.storage.local` without changing the token. No page opens automatically.
3. Start the MCP server with `~/Documents/GitHub/playwright/utils/local-extension-mcp.sh`. Use this script as the MCP command when choosing this local extension mode. The existing headless configuration is not changed automatically.

The launcher reads `PLAYWRIGHT_MCP_EXTENSION_TOKEN` from its environment or the existing `~/.codex/secrets/playwright-extension-token` file. A different file can be selected with `PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE`. For a fresh installation, use the token shown in extension settings to configure the MCP environment. Never put the token in command-line arguments, URLs, or logs.

A connection alone creates no page. Listing tabs can return an empty list. Navigating or explicitly creating a tab creates a background task tab. Manual clicks on the extension and its status page keep normal user-directed behavior.

## Port and sessions

The default discovery address is `ws://127.0.0.1:8765/bridge`. To change it, set `PLAYWRIGHT_MCP_EXTENSION_BRIDGE_PORT` for MCP and save the same port in extension settings. Distinct browser profiles with different pairing tokens should use distinct ports.

Multiple MCP processes using the same token and port share discovery but have separate relay connections and tab groups. The first process owns discovery; remaining processes can take over after it exits. An unrelated service occupying the port produces an error, with no browser-launch fallback.

Both parties prove knowledge of the token using fresh nonces and HMAC-SHA-256. Discovery accepts only the extension's origin or authenticated local MCP registrations. Session relay connections use separate random credentials. No tasks run before authentication.

Disconnects do not replay input or previously issued actions. A stopped worker or disconnected browser context is rebuilt on the next tool call; existing web pages remain open. Regenerating the pairing token requires updating the MCP environment and restarting MCP.

## Background connection lifecycle

Heartbeat and watchdog timings follow the installed Claude extension. Discovery retries are capped at 5 seconds so a server started after a long idle period is found within the MCP 30-second connection deadline:

| Setting | Value |
| --- | --- |
| Heartbeat | 20 seconds |
| Alarm health check | 30 seconds |
| Initial retry base | 2 seconds |
| Retry multiplier | 1.5 |
| Retry jitter | 80–120% |
| Retry cap | 5 seconds |
| Connecting watchdog threshold | 30 seconds |
| Retry after connecting timeout | 5 seconds |
| Stale pong threshold | 90 seconds |

Successful authentication resets backoff. Alarms recover suspended background workers; online events reconnect unhealthy sockets without duplicating healthy connections. Chrome can delay background alarms, so these are scheduling targets rather than hard real-time guarantees.

The opt-in switch is `PLAYWRIGHT_MCP_EXTENSION_NO_FOCUS=1`, enabled by the launcher. Ordinary upstream extension mode remains available when this variable is unset. Only that ordinary mode retains the original authorization-page launch behavior.

## Build and verify

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts
npm run build -- --disable-install
npm run test-extension -- background.spec.ts background-lifecycle.spec.ts --workers=1
cp -R packages/extension/dist/. ~/chrome-extensions/playwright-no-focus/
```

All new browser regressions use isolated headless Chromium. Tests cover page-free bootstrap, inactive task tabs, background input and screenshots, multi-process takeover, pairing migration, invalid credentials, forged servers, port conflicts, worker recovery without action replay, and legacy handshake compatibility. Controlled-clock tests check lifecycle thresholds and retry calculations. A forbidden-launch executable records any accidental browser launch.

The automated checks observe active tabs and activation API calls; they do not claim a macOS foreground-window test. Real Canary acceptance is a separate user-approved step after reloading the extension.
