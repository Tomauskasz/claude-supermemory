// Grok Build runs Claude-format plugin hooks but delivers camelCase field
// names (sessionId, transcriptPath) and wraps the prompt in <user_query>
// tags. Normalize to the Claude shape so every hook handles both hosts.
function normalizeHookInput(input) {
  const isGrok = 'sessionId' in input && !('session_id' in input);
  const prompt = (input.prompt || '')
    .replace(/^\s*<user_query>\s*/i, '')
    .replace(/\s*<\/user_query>\s*$/i, '');
  return {
    ...input,
    isGrok,
    prompt,
    session_id: input.session_id ?? input.sessionId,
    transcript_path: input.transcript_path ?? input.transcriptPath,
  };
}

module.exports = { normalizeHookInput };
