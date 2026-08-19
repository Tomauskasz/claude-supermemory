const { getContainerTag } = require('./lib/container-tag');
const { loadSettings, debugLog, getRecallConfig } = require('./lib/settings');
const { readStdin, writeOutput } = require('./lib/stdin');

function buildDirective(containerTag) {
  return `<supermemory-recall>
Before responding, consider whether saved memory (past sessions, decisions, conventions, the user's preferences) could improve your answer to THIS message. When in doubt, search — recall is cheap, read-only, and pre-approved.

Recall — via the supermemory search_memory tool (containerTag: "${containerTag}") — when the message:
- refers to earlier work or decisions ("the auth flow", "like we did", "continue", "the bug from before")
- touches an area where saved conventions, patterns, or preferences may exist
- starts a new task or feature — check for prior decisions before choosing an approach
- is ambiguous in a way past context would resolve

For deep background (resuming after time away, starting substantial work), launch the supermemory context-gatherer agent instead of a single search.

Skip only for greetings/meta, trivially mechanical requests, or topics you already recalled this session.

Be visible about it: ◪ is the supermemory mark — anything derived from recalled or injected memory carries it. When a memory shapes your answer, credit it at the point of use as a natural sentence prefixed with ◪ (e.g. "◪ last week you told me about X", "◪ on Aug 6 you decided X"). If you name the source, say "from supermemory" — never "from memory".
</supermemory-recall>`;
}

async function main() {
  const settings = loadSettings();

  try {
    const input = await readStdin();
    const cwd = input.cwd || process.cwd();
    const { directive } = getRecallConfig(cwd);

    debugLog(settings, 'Injecting recall directive', {
      sessionId: input.session_id,
      custom: !!directive,
    });

    writeOutput({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: directive || buildDirective(getContainerTag(cwd)),
      },
    });
  } catch (err) {
    debugLog(settings, 'Recall directive error', { error: err.message });
    writeOutput({ continue: true, suppressOutput: true });
  }
}

main().catch(() => {
  writeOutput({ continue: true, suppressOutput: true });
});
