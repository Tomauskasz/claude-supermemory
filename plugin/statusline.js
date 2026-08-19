#!/usr/bin/env node
// Self-contained statusline renderer. Reads per-session state written by the
// hooks from the fixed ~/.supermemory-claude/statusline directory; user
// settings reference this file via the ~/.supermemory-claude/statusline-current
// symlink that session-start maintains.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATE_ROOT = path.join(
  os.homedir(),
  '.supermemory-claude',
  'statusline',
  'statusline-state',
);
const SCHEMA_VERSION = 1;

const SAVING_TTL_MS = 30 * 1000;
const ERROR_TTL_MS = 60 * 1000;
const CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;
const STATUSLINE_INPUT_TIMEOUT_MS = 500;

const BLUE = '\x1b[38;2;59;53;243m';
const WHITE = '\x1b[97m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function readEvent(sessionDir, event) {
  try {
    const record = JSON.parse(
      fs.readFileSync(path.join(sessionDir, `${event}.json`), 'utf8'),
    );
    if (
      record?.version !== SCHEMA_VERSION ||
      record?.event !== event ||
      !Number.isFinite(record?.updatedAt)
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

function readState(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return {};
  const sessionDir = path.join(
    STATE_ROOT,
    crypto.createHash('sha256').update(sessionId.trim()).digest('hex'),
  );
  return {
    context: readEvent(sessionDir, 'context'),
    capture: readEvent(sessionDir, 'capture'),
    search: readEvent(sessionDir, 'search'),
  };
}

function isFresh(record, ttl, now, contextUpdatedAt = 0) {
  return (
    record &&
    record.updatedAt >= contextUpdatedAt &&
    now - record.updatedAt >= 0 &&
    now - record.updatedAt < ttl
  );
}

// Resting label is a live session tally — the captured count ticks up on
// every turn and recalls on every search, so the line is always moving.
// Transient states (saving, errors) briefly take over.
function getStatusLabel(state, now = Date.now()) {
  const { context, capture, search } = state;
  const generation = Number.isFinite(context?.updatedAt) ? context.updatedAt : 0;

  if (
    capture?.status === 'saving' &&
    isFresh(capture, SAVING_TTL_MS, now, generation)
  ) {
    return 'saving session';
  }
  if (
    capture?.status === 'error' &&
    isFresh(capture, ERROR_TTL_MS, now, generation)
  ) {
    return 'session sync failed';
  }

  const contextReady =
    isFresh(context, CONTEXT_TTL_MS, now) && context.status === 'ready';
  const parts = [];
  if (contextReady && context.memoryItemsLoaded > 0) {
    parts.push(`${context.memoryItemsLoaded} loaded`);
  }
  if (capture?.count > 0 && capture.updatedAt >= generation) {
    parts.push(`${capture.count} captured`);
  }
  if (search?.count > 0 && search.updatedAt >= generation) {
    parts.push(`${search.count} ${search.count === 1 ? 'recall' : 'recalls'}`);
  }

  if (parts.length > 0) return parts.join(' · ');
  return contextReady ? 'ready' : null;
}

function renderStatusline(state, options = {}) {
  const label = getStatusLabel(state, options.now);
  if (!label) return '';
  if (options.color === false) return `◆ supermemory · ${label}`;
  return `${BLUE}${BOLD}◆ supermemory${RESET} ${WHITE}· ${label}${RESET}`;
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
      } catch {}
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
    const output = renderStatusline(readState(sessionId));
    if (output) process.stdout.write(output);
  } catch {
    // A status line must fail silently so it never disrupts Claude Code.
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  CONTEXT_TTL_MS,
  ERROR_TTL_MS,
  SAVING_TTL_MS,
  STATUSLINE_INPUT_TIMEOUT_MS,
  getStatusLabel,
  readState,
  readStatuslineInput,
  renderStatusline,
};
