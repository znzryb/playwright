#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export PLAYWRIGHT_MCP_EXTENSION_NO_FOCUS=1

# Keep the existing Codex token out of arguments and logs.
token_file="${PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE:-$HOME/.codex/secrets/playwright-extension-token}"
if [ -z "${PLAYWRIGHT_MCP_EXTENSION_TOKEN:-}" ] && [ -r "$token_file" ]; then
  extension_token=$(tr -d '\r\n' < "$token_file")
  export PLAYWRIGHT_MCP_EXTENSION_TOKEN="${extension_token#PLAYWRIGHT_MCP_EXTENSION_TOKEN=}"
  unset extension_token
fi

exec node "$repo_dir/packages/playwright-core/cli.js" mcp --extension --browser chrome-canary "$@"
