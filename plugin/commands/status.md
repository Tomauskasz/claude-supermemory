---
description: Show Supermemory authentication and connection status
allowed-tools: ["Bash", "Read"]
---

# Supermemory Status

Report the user's Supermemory status:

1. Read `~/.supermemory-claude/credentials.json` (may not exist). Never print the full API key — show at most the first 6 and last 4 characters.
2. Call the `whoAmI` MCP tool if the supermemory MCP server is connected.
3. Report: authenticated or not, key source (env `SUPERMEMORY_CC_API_KEY` beats credentials file), the active project container tag, and whether the MCP server is reachable.

If not authenticated, tell the user a new session will open the browser login automatically, or they can set `SUPERMEMORY_CC_API_KEY`.
