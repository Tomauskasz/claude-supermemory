const { loadSettings, debugLog } = require('./lib/settings');
const { readState, writeState } = require('./lib/statusline-state');
const { readStdin, writeOutput } = require('./lib/stdin');

// Plugin MCP tool names arrive as mcp__supermemory__<tool> (direct config) or
// mcp__plugin_supermemory_supermemory__<tool> (plugin-scoped). Only read-only
// tools run without a prompt; writes (add_memory, save-memory, ...) still ask.
const TOOL_NAME_RE = /^mcp__(?:plugin_supermemory_)?supermemory__(.+)$/;
const READ_ONLY_TOOLS = new Set([
  'search_memory',
  'listSpaces',
  'listMemories',
  'listDocuments',
  'getDocument',
  'whoAmI',
  'memory-graph',
  'fetch-graph-data',
]);

async function main() {
  const settings = loadSettings();

  try {
    const input = await readStdin();
    const tool = TOOL_NAME_RE.exec(input.tool_name || '')?.[1];

    if (tool && READ_ONLY_TOOLS.has(tool)) {
      debugLog(settings, 'Auto-approving supermemory recall', { tool });
      const query =
        typeof input.tool_input?.query === 'string'
          ? input.tool_input.query
          : null;
      if (tool === 'search_memory') {
        const recalls = readState(input.session_id).search?.count || 0;
        writeState(input.session_id, 'search', { results: 0, count: recalls + 1 });
      }
      writeOutput({
        systemMessage: query
          ? `◪ supermemory · recalling: ${query}`
          : '◪ supermemory · recalling memories',
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason:
            'Supermemory recall runs automatically (read-only memory access).',
        },
      });
      return;
    }

    writeOutput({ continue: true, suppressOutput: true });
  } catch (err) {
    debugLog(settings, 'Recall approve error', { error: err.message });
    writeOutput({ continue: true, suppressOutput: true });
  }
}

main().catch(() => {
  writeOutput({ continue: true, suppressOutput: true });
});
