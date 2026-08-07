---
name: statusline
description: Install the Supermemory activity status line for Claude Code
allowed-tools: Bash(node:*) PowerShell(node:*)
---

# Install the Supermemory status line

Run this command exactly:

```bash
node '${CLAUDE_PLUGIN_ROOT}/scripts/install-statusline.cjs' '${CLAUDE_PLUGIN_DATA}'
```

Then report the command output to the user.

The installer is intentionally conservative:

- It uses Claude Code's persistent plugin data directory, so plugin upgrades do not break the configured path.
- It uses Node on macOS, Linux, and Windows; no POSIX shell syntax is required.
- It preserves all unrelated Claude settings.
- If another status line is already configured, it leaves that configuration untouched and explains what to do next.

Once enabled, the status line displays factual per-session activity such as memory items loaded, search results, session saving, and session captured.
