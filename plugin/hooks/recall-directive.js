const { getProfile } = require('./lib/api');
const { getContainerTag } = require('./lib/container-tag');
const { loadProjectConfig } = require('./lib/project-config');
const {
  loadSettings,
  getApiKey,
  getBaseUrl,
  debugLog,
  getRecallConfig,
} = require('./lib/settings');
const { readState, writeState } = require('./lib/statusline-state');
const { readStdin, writeOutput } = require('./lib/stdin');

// Recall is performed HERE, not delegated to the model: the hook searches
// supermemory with the prompt itself and injects the top matches, so recall
// happens on every substantive prompt instead of only when the model chooses
// to spend a tool call. A configured recallDirective restores advisory mode.
const MIN_PROMPT_LENGTH = 12;
const MAX_QUERY_LENGTH = 500;
const MAX_RESULTS = 5;
const MAX_RESULT_CHARS = 300;
const MIN_SIMILARITY = 0.55;
const SEARCH_TIMEOUT_MS = 4000;

function shouldSkip(prompt) {
  if (prompt.length < MIN_PROMPT_LENGTH) return true;
  return ['/', '!', '#'].includes(prompt[0]);
}

function formatRecall(results, containerTag) {
  const lines = results.map(
    (r) => `- ◪ ${r.memory.replace(/\s+/g, ' ').slice(0, MAX_RESULT_CHARS)}`,
  );
  return `<supermemory-recall>
◪ Recalled from supermemory for this prompt (relevance-ranked):
${lines.join('\n')}

When one of these shapes your answer, credit it naturally with the ◪ prefix (e.g. "◪ earlier you decided X"); if you name the source, say "from supermemory" — never "from memory". For deeper history, call the supermemory search_memory tool (containerTag: "${containerTag}") or launch the context-gatherer agent.
</supermemory-recall>`;
}

async function main() {
  const settings = loadSettings();

  try {
    const input = await readStdin();
    const cwd = input.cwd || process.cwd();
    const prompt = (input.prompt || '').trim();
    const { directive } = getRecallConfig(cwd);

    if (directive) {
      writeOutput({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: directive,
        },
      });
      return;
    }

    if (shouldSkip(prompt)) {
      writeOutput({ continue: true, suppressOutput: true });
      return;
    }

    const projectConfig = loadProjectConfig(cwd);
    let apiKey;
    try {
      apiKey = getApiKey(cwd, projectConfig);
    } catch {
      writeOutput({ continue: true, suppressOutput: true });
      return;
    }

    const containerTag = getContainerTag(cwd);
    const response = await getProfile(
      getBaseUrl(cwd, projectConfig),
      apiKey,
      containerTag,
      prompt.slice(0, MAX_QUERY_LENGTH),
      { timeoutMs: SEARCH_TIMEOUT_MS },
    );

    const results = (response?.searchResults?.results || [])
      .filter((r) => typeof r?.memory === 'string' && r.memory.trim())
      .filter((r) => !Number.isFinite(r.similarity) || r.similarity >= MIN_SIMILARITY)
      .slice(0, MAX_RESULTS);

    if (input.session_id) {
      const recalls = readState(input.session_id).search?.count || 0;
      writeState(input.session_id, 'search', {
        results: results.length,
        count: recalls + 1,
      });
    }

    debugLog(settings, 'Prompt recall', { query: prompt.slice(0, 80), hits: results.length });

    if (results.length === 0) {
      writeOutput({ continue: true, suppressOutput: true });
      return;
    }

    writeOutput({
      systemMessage: `◪ supermemory · recalled ${results.length} ${results.length === 1 ? 'memory' : 'memories'}`,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: formatRecall(results, containerTag),
      },
    });
  } catch (err) {
    debugLog(settings, 'Recall directive error', { error: err.message });
    writeOutput({
      systemMessage: `◪ supermemory · recall failed: ${err.message.slice(0, 80)}`,
      continue: true,
      suppressOutput: true,
    });
  }
}

main().catch(() => {
  writeOutput({ continue: true, suppressOutput: true });
});
