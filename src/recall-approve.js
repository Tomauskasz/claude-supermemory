const { loadSettings, debugLog } = require('./lib/settings');
const { readStdin, writeOutput } = require('./lib/stdin');

// Allowlist, not a blocklist: matches only the exact invocation shape
// documented in the supermemory-search skill -
// `node <path-to-search-memory.cjs> [--user|--repo|--both] "query"` - anchored
// to the whole command. A blocklist of shell metacharacters is easy to bypass
// (e.g. a newline-separated extra command, or `$(...)` command substitution
// inside the quoted query, which bash still expands) and this hook's
// "allow" decision skips the user's permission prompt entirely, so any gap
// here lets an injected instruction run arbitrary shell commands unconfirmed.
const SEARCH_BASH_RE =
  /^node\s+"?(?:[^"\n$`]|\$(?!\())*search-memory\.cjs"?\s+(?:--(?:user|repo|both)\s+)?"(?:[^"\n$`]|\$(?!\())*"\s*$/;
const SEARCH_SKILL = 'supermemory-search';

function isSupermemorySearch(toolName, toolInput) {
  if (toolName === 'Skill') {
    return JSON.stringify(toolInput || {}).includes(SEARCH_SKILL);
  }
  if (toolName === 'Bash') {
    const cmd = String(toolInput?.command || '');
    return SEARCH_BASH_RE.test(cmd);
  }
  return false;
}

async function main() {
  const settings = loadSettings();

  try {
    const input = await readStdin();

    if (isSupermemorySearch(input.tool_name, input.tool_input)) {
      debugLog(settings, 'Auto-approving recall search', {
        toolName: input.tool_name,
      });
      writeOutput({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason:
            'Supermemory reasoned recall runs automatically (read-only memory search).',
        },
      });
      return;
    }

    writeOutput({ continue: true, suppressOutput: true });
  } catch (err) {
    debugLog(settings, 'Recall approve hook error', { error: err.message });
    writeOutput({ continue: true, suppressOutput: true });
  }
}

main().catch(() => {
  writeOutput({ continue: true, suppressOutput: true });
});
