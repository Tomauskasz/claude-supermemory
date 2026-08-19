const { loadSettings, debugLog, getRecallConfig } = require('./lib/settings');
const { readStdin, writeOutput } = require('./lib/stdin');

const DEFAULT_RECALL_DIRECTIVE = `<supermemory-recall>
Before responding, consider whether saved memory (past sessions, decisions, conventions, the user's preferences) could improve your answer to THIS message. When in doubt, search — recall is cheap, read-only, and pre-approved.

Recall — via the supermemory-search skill — when the message:
- refers to earlier work or decisions ("the auth flow", "like we did", "continue", "the bug from before")
- touches an area where saved conventions, patterns, or preferences may exist
- starts a new task or feature — check for prior decisions before choosing an approach
- is ambiguous in a way past context would resolve

Skip only for greetings/meta, trivially mechanical requests, or topics you already recalled this session.

Be visible about it: when a recalled or injected memory shapes your answer, credit it in one short line at the point of use (e.g. "◆ from memory: you decided X on Aug 6").
</supermemory-recall>`;

const RECALL_DEBUG_SUFFIX = `<recall-debug>
DEBUG MODE: Begin your reply with exactly one line, then continue normally:
[recall-decision] yes|no — <short reason>
"yes" means you are recalling saved Supermemory memory (via the supermemory-search skill, separate from any obsidian/smfs notes mount) for THIS message; "no" means you are skipping it.
</recall-debug>`;

async function main() {
  const settings = loadSettings();

  try {
    const input = await readStdin();
    const cwd = input.cwd || process.cwd();

    const { directive } = getRecallConfig(cwd);

    let additionalContext = directive || DEFAULT_RECALL_DIRECTIVE;
    if (settings.debug) {
      additionalContext += `\n\n${RECALL_DEBUG_SUFFIX}`;
    }

    debugLog(settings, 'Injecting recall directive', {
      sessionId: input.session_id,
      custom: !!directive,
      debugDecision: !!settings.debug,
    });

    writeOutput({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext,
      },
    });
  } catch (err) {
    debugLog(settings, 'Recall hook error', { error: err.message });
    writeOutput({ continue: true, suppressOutput: true });
  }
}

main().catch(() => {
  writeOutput({ continue: true, suppressOutput: true });
});
