const { readState } = require('./lib/statusline-state');

const SAVING_TTL_MS = 30 * 1000;
const CAPTURE_TTL_MS = 2 * 60 * 1000;
const SEARCH_TTL_MS = 60 * 1000;
const CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;
const STATUSLINE_INPUT_TIMEOUT_MS = 500;

const BLUE = '\x1b[38;2;59;53;243m';
const WHITE = '\x1b[97m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function isFresh(record, ttl, now, contextUpdatedAt = 0) {
  return (
    record &&
    record.updatedAt >= contextUpdatedAt &&
    now - record.updatedAt >= 0 &&
    now - record.updatedAt < ttl
  );
}

function getStatusLabel(state, now = Date.now()) {
  const context = state.context;
  const generation = Number.isFinite(context?.updatedAt)
    ? context.updatedAt
    : 0;
  const capture = state.capture;
  const search = state.search;

  if (
    capture?.status === 'saving' &&
    isFresh(capture, SAVING_TTL_MS, now, generation)
  ) {
    return 'saving session';
  }

  if (
    capture?.status === 'saved' &&
    isFresh(capture, CAPTURE_TTL_MS, now, generation)
  ) {
    return 'session captured';
  }

  if (
    capture?.status === 'error' &&
    isFresh(capture, SEARCH_TTL_MS, now, generation)
  ) {
    return 'session sync failed';
  }

  if (isFresh(search, SEARCH_TTL_MS, now, generation)) {
    const count = search.results || 0;
    return `${count} search ${count === 1 ? 'result' : 'results'}`;
  }

  if (!isFresh(context, CONTEXT_TTL_MS, now)) return null;
  if (context.status !== 'ready') return null;
  const count = context.memoryItemsLoaded || 0;
  if (count === 0) return 'ready';
  return `${count} memory ${count === 1 ? 'item' : 'items'} loaded`;
}

function renderStatusline(state, options = {}) {
  const label = getStatusLabel(state, options.now);
  if (!label) return '';
  if (options.color === false) return `supermemory · ${label}`;
  return `${BLUE}${BOLD}⚡ supermemory${RESET} ${WHITE}· ${label}${RESET}`;
}

function readStatuslineInput(input = process.stdin, options = {}) {
  const timeoutMs = options.timeoutMs ?? STATUSLINE_INPUT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;
    let timer;

    const cleanup = () => {
      clearTimeout(timer);
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      try {
        input.pause();
        input.unref?.();
      } catch {
        // Some test streams do not expose socket lifecycle methods.
      }
    };

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };

    const parse = (final) => {
      const value = data.trim();
      if (!value) {
        if (final) finish(resolve, {});
        return;
      }

      try {
        finish(resolve, JSON.parse(value));
      } catch (error) {
        if (final) {
          finish(
            reject,
            new Error(`Failed to parse statusline JSON: ${error.message}`),
          );
        }
      }
    };

    function onData(chunk) {
      data += chunk;
      parse(false);
    }

    function onEnd() {
      parse(true);
    }

    function onError(error) {
      finish(reject, error);
    }

    input.setEncoding('utf8');
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);

    if (input.isTTY) {
      finish(resolve, {});
      return;
    }

    if (!settled) timer = setTimeout(() => parse(true), timeoutMs);
  });
}

async function main() {
  try {
    const input = await readStatuslineInput();
    const sessionId = input?.session_id;
    if (!sessionId) return;

    const state = readState(sessionId, {
      dataDir: process.env.CLAUDE_PLUGIN_DATA || __dirname,
    });
    const output = renderStatusline(state);
    if (output) process.stdout.write(output);
  } catch {
    // A status line must fail silently so it never disrupts Claude Code.
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  CAPTURE_TTL_MS,
  CONTEXT_TTL_MS,
  SAVING_TTL_MS,
  SEARCH_TTL_MS,
  STATUSLINE_INPUT_TIMEOUT_MS,
  getStatusLabel,
  readStatuslineInput,
  renderStatusline,
};
