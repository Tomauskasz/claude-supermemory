import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  SESSION_RETENTION_MS,
  countLoadedProfileItems,
  getSessionDir,
  pruneState,
  readState,
  writeState,
} = require('../plugin/hooks/lib/statusline-state.js');
const {
  CAPTURE_TTL_MS,
  SAVING_TTL_MS,
  SEARCH_TTL_MS,
  getStatusLabel,
  renderStatusline,
} = require('../plugin/statusline.js');

const HOOKS_DIR = join(process.cwd(), 'plugin', 'hooks');

function hash16(input) {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function makeTempDir(t, prefix) {
  const root = join(tmpdir(), `claude-sm-${prefix}-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeRepo(t, name = 'Example Project') {
  const root = join(tmpdir(), `claude-sm-${Date.now()}-${Math.random()}`);
  const repo = join(root, name);
  const home = join(root, 'home');
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  git(['remote', 'add', 'origin', 'git@github.com:acme/Example.Project.git']);
  writeFileSync(join(repo, 'README.md'), '# example\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { repo, git, home };
}

function readTags(cwd, home) {
  const modulePath = join(HOOKS_DIR, 'lib', 'container-tag.js');
  const script = `
    const tags = require(${JSON.stringify(modulePath)});
    console.log(JSON.stringify({
      tag: tags.getContainerTag(process.argv[1]),
      projectName: tags.getProjectName(process.argv[1]),
    }));
  `;
  const result = spawnSync('node', ['-e', script, cwd], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runHook(name, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [join(HOOKS_DIR, name)], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

function startStubServer(t, handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const record = { method: req.method, url: req.url, headers: req.headers, body };
        requests.push(record);
        handler(record, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close());
      resolve({ url: `http://127.0.0.1:${server.address().port}`, requests });
    });
  });
}

function makeAuthedHome(t, apiKey = 'sm_test_key_0123456789abcdef') {
  const home = makeTempDir(t, 'home');
  mkdirSync(join(home, '.supermemory-claude'), { recursive: true });
  writeFileSync(
    join(home, '.supermemory-claude', 'credentials.json'),
    JSON.stringify({ apiKey }),
  );
  return home;
}

describe('container tags', () => {
  test('derives one canonical repo tag from the git remote', (t) => {
    const { repo, home } = makeRepo(t);
    const { tag, projectName } = readTags(repo, home);
    assert.equal(tag, `repo_example_project__${hash16('github.com/acme/example.project')}`);
    assert.equal(projectName, 'Example.Project');
  });

  test('uses the shared git common root for linked worktrees', (t) => {
    const { repo, git, home } = makeRepo(t, 'repo');
    git(['add', 'README.md']);
    git(['commit', '-m', 'initial']);
    const worktree = join(repo, '..', 'worktree');
    git(['worktree', 'add', '--detach', worktree, 'HEAD']);
    assert.equal(readTags(worktree, home).tag, readTags(repo, home).tag);
  });

  test('honors the project-config override', (t) => {
    const { repo, git, home } = makeRepo(t);
    const configDir = join(git(['rev-parse', '--show-toplevel']), '.claude', '.supermemory-claude');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ repoContainerTag: 'team_tag' }));
    assert.equal(readTags(repo, home).tag, 'team_tag');
  });
});

describe('recall-directive hook', () => {
  test('injects the directive with the active container tag', async (t) => {
    const { repo, home } = makeRepo(t);
    const { code, stdout } = await runHook(
      'recall-directive.js',
      { session_id: 's1', cwd: repo },
      { HOME: home, USERPROFILE: home },
    );
    assert.equal(code, 0);
    const output = JSON.parse(stdout);
    const context = output.hookSpecificOutput.additionalContext;
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(context, /<supermemory-recall>/);
    assert.match(context, /search_memory/);
    assert.match(context, /repo_example_project__/);
    assert.match(context, /◆ from memory/);
  });
});

describe('recall-approve hook', () => {
  test('auto-approves read-only supermemory tools with a visible message', async (t) => {
    const home = makeTempDir(t, 'approve-home');
    for (const toolName of [
      'mcp__supermemory__search_memory',
      'mcp__plugin_supermemory_supermemory__search_memory',
    ]) {
      const { stdout } = await runHook(
        'recall-approve.js',
        {
          session_id: 's1',
          tool_name: toolName,
          tool_input: { query: 'auth flow decisions' },
        },
        { HOME: home, USERPROFILE: home },
      );
      const output = JSON.parse(stdout);
      assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
      assert.equal(output.systemMessage, '◆ supermemory · recalling: auth flow decisions');
    }
  });

  test('lets write tools and unrelated tools fall through to normal permissions', async (t) => {
    const home = makeTempDir(t, 'approve-home2');
    for (const toolName of ['mcp__supermemory__add_memory', 'Bash', 'mcp__other__search_memory']) {
      const { stdout } = await runHook(
        'recall-approve.js',
        { session_id: 's1', tool_name: toolName, tool_input: {} },
        { HOME: home, USERPROFILE: home },
      );
      const output = JSON.parse(stdout);
      assert.equal(output.hookSpecificOutput, undefined);
      assert.equal(output.continue, true);
    }
  });
});

describe('session-start hook', () => {
  test('injects profile memories and announces the count', async (t) => {
    const { repo, home } = makeRepo(t);
    mkdirSync(join(home, '.supermemory-claude'), { recursive: true });
    writeFileSync(
      join(home, '.supermemory-claude', 'credentials.json'),
      JSON.stringify({ apiKey: 'sm_test_key_0123456789abcdef' }),
    );
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          profile: { static: ['Uses Bun'], dynamic: ['Working on statusline'] },
        }),
      );
    });

    const { code, stdout } = await runHook(
      'session-start.js',
      { session_id: 'sess-1', cwd: repo },
      { HOME: home, USERPROFILE: home, SUPERMEMORY_API_URL: stub.url },
    );
    assert.equal(code, 0);
    const output = JSON.parse(stdout);
    assert.match(output.hookSpecificOutput.additionalContext, /Uses Bun/);
    assert.match(output.hookSpecificOutput.additionalContext, /Working on statusline/);
    assert.match(output.systemMessage, /◆ supermemory · 2 memories loaded for Example\.Project/);
    assert.equal(stub.requests[0].url, '/v4/profile');
    assert.match(stub.requests[0].headers.authorization, /^Bearer sm_test/);

    const state = readState('sess-1', {
      dataDir: join(home, '.supermemory-claude', 'statusline'),
    });
    assert.equal(state.context.status, 'ready');
    assert.equal(state.context.memoryItemsLoaded, 2);
  });
});

describe('capture hook', () => {
  test('saves the transcript delta with scope metadata and entity context', async (t) => {
    const { repo, home } = makeRepo(t);
    mkdirSync(join(home, '.supermemory-claude'), { recursive: true });
    writeFileSync(
      join(home, '.supermemory-claude', 'credentials.json'),
      JSON.stringify({ apiKey: 'sm_test_key_0123456789abcdef' }),
    );
    const transcript = join(makeTempDir(t, 'transcript'), 'session.jsonl');
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-08-18T20:00:00Z',
          message: { content: 'Please fix the statusline symlink handling in the plugin' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          message: {
            content: [{ type: 'text', text: 'Fixed: the symlink now re-points each session.' }],
          },
        }),
      ].join('\n'),
    );
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'doc_123', status: 'queued' }));
    });

    const { code } = await runHook(
      'capture.js',
      { session_id: 'sess-2', cwd: repo, transcript_path: transcript },
      { HOME: home, USERPROFILE: home, SUPERMEMORY_API_URL: stub.url },
    );
    assert.equal(code, 0);
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].url, '/v3/documents');
    const body = JSON.parse(stub.requests[0].body);
    assert.match(body.content, /statusline symlink/);
    assert.match(body.containerTag, /^repo_example_project__/);
    assert.equal(body.metadata.sm_scope, 'personal');
    assert.equal(body.customId, 'sess-2');
    assert.match(body.entityContext, /EXTRACT/);

    const state = readState('sess-2', {
      dataDir: join(home, '.supermemory-claude', 'statusline'),
    });
    assert.equal(state.capture.status, 'saved');
  });
});

describe('mcp proxy', () => {
  function runProxy(t, env, lines) {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [join(HOOKS_DIR, 'mcp-proxy.js')], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.on('error', reject);
      child.on('close', () =>
        resolve(stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))),
      );
      for (const line of lines) child.stdin.write(`${JSON.stringify(line)}\n`);
      child.stdin.end();
    });
  }

  test('forwards requests with the stored key and tracks the MCP session', async (t) => {
    const home = makeAuthedHome(t);
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Mcp-Session-Id', 'mcp-sess-9');
      const { id } = JSON.parse(record.body);
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }));
    });

    const messages = await runProxy(
      t,
      { HOME: home, USERPROFILE: home, SUPERMEMORY_MCP_URL: `${stub.url}/mcp` },
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ],
    );
    assert.deepEqual(messages.map((m) => m.id), [1, 2]);
    assert.match(stub.requests[0].headers.authorization, /^Bearer sm_test/);
    assert.equal(stub.requests[0].headers['mcp-session-id'], undefined);
    assert.equal(stub.requests[1].headers['mcp-session-id'], 'mcp-sess-9');
  });

  test('unwraps SSE responses into stdout lines', async (t) => {
    const home = makeAuthedHome(t);
    const stub = await startStubServer(t, (record, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      const { id } = JSON.parse(record.body);
      res.end(`event: message\ndata: {"jsonrpc":"2.0","id":${id},"result":{"via":"sse"}}\n\n`);
    });

    const messages = await runProxy(
      t,
      { HOME: home, USERPROFILE: home, SUPERMEMORY_MCP_URL: `${stub.url}/mcp` },
      [{ jsonrpc: '2.0', id: 7, method: 'tools/list' }],
    );
    assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 7, result: { via: 'sse' } }]);
  });

  test('answers with a clear JSON-RPC error when unauthenticated', async (t) => {
    const home = makeTempDir(t, 'no-auth-home');
    const messages = await runProxy(
      t,
      {
        HOME: home,
        USERPROFILE: home,
        SUPERMEMORY_MCP_URL: 'http://127.0.0.1:1/mcp',
        SUPERMEMORY_CC_API_KEY: '',
      },
      [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }],
    );
    assert.equal(messages[0].error.code, -32001);
    assert.match(messages[0].error.message, /not authenticated/);
  });
});

describe('statusline state', () => {
  test('isolates sessions and writes private atomic event files', (t) => {
    const dataDir = makeTempDir(t, 'status-state');
    assert.equal(
      writeState('../../session-a', 'context', { status: 'ready', memoryItemsLoaded: 4 }, { dataDir, now: 1000 }),
      true,
    );
    writeState('session-a', 'search', { results: 2, query: 'must not be stored' }, { dataDir, now: 1100 });
    writeState('session-b', 'context', { status: 'ready', memoryItemsLoaded: 9 }, { dataDir, now: 1200 });

    const first = readState('../../session-a', { dataDir });
    const second = readState('session-b', { dataDir });
    assert.equal(first.context.memoryItemsLoaded, 4);
    assert.equal(first.search, null);
    assert.equal(second.context.memoryItemsLoaded, 9);

    const traversalDir = getSessionDir('../../session-a', dataDir);
    assert.match(basename(traversalDir), /^[a-f0-9]{64}$/);
    if (process.platform !== 'win32') {
      assert.equal(statSync(traversalDir).mode & 0o777, 0o700);
      assert.equal(statSync(join(traversalDir, 'context.json')).mode & 0o777, 0o600);
    }
    assert.equal(readdirSync(traversalDir).some((name) => name.endsWith('.tmp')), false);
  });

  test('keeps context, capture, and search updates independent', (t) => {
    const dataDir = makeTempDir(t, 'status-events');
    writeState('session-a', 'context', { status: 'ready', memoryItemsLoaded: 3 }, { dataDir, now: 1000 });
    writeState('session-a', 'capture', { status: 'saving' }, { dataDir, now: 1100 });
    writeState('session-a', 'search', { results: 1, query: 'private query' }, { dataDir, now: 1200 });

    const state = readState('session-a', { dataDir });
    assert.equal(state.context.memoryItemsLoaded, 3);
    assert.equal(state.capture.status, 'saving');
    assert.equal(state.search.results, 1);
    assert.equal('query' in state.search, false);
  });

  test('ignores corrupt state without breaking the renderer', (t) => {
    const dataDir = makeTempDir(t, 'status-corrupt');
    const sessionDir = getSessionDir('session-a', dataDir);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'context.json'), '{broken');
    assert.deepEqual(readState('session-a', { dataDir }), {
      context: null,
      capture: null,
      search: null,
    });
    assert.equal(renderStatusline(readState('session-a', { dataDir })), '');
  });

  test('counts only profile items that are actually injected', () => {
    const result = {
      profile: { static: ['a', 'b', 'c'], dynamic: ['d', 'e', 'f'] },
      searchResults: { results: [{ memory: 'not injected' }] },
    };
    assert.equal(countLoadedProfileItems(result, 2), 4);
  });

  test('prunes only stale hashed session directories', (t) => {
    const dataDir = makeTempDir(t, 'status-prune');
    writeState('stale-session', 'context', { status: 'ready', memoryItemsLoaded: 1 }, { dataDir });
    const sessionDir = getSessionDir('stale-session', dataDir);
    utimesSync(join(sessionDir, 'context.json'), new Date(0), new Date(0));
    utimesSync(sessionDir, new Date(0), new Date(0));
    const unrelated = join(sessionDir, '..', 'do-not-delete');
    mkdirSync(unrelated);
    const activeSessionDir = getSessionDir('active-session', dataDir);
    mkdirSync(activeSessionDir);
    writeFileSync(join(activeSessionDir, '.context.tmp'), 'in progress');

    pruneState({ dataDir, now: SESSION_RETENTION_MS + 1 });
    assert.equal(existsSync(sessionDir), false);
    assert.equal(existsSync(unrelated), true);
    assert.equal(existsSync(activeSessionDir), true);
  });
});

describe('statusline rendering', () => {
  const now = 100_000;
  const context = {
    version: 1,
    event: 'context',
    status: 'ready',
    memoryItemsLoaded: 3,
    updatedAt: now,
  };

  test('uses deterministic factual priority and labels', () => {
    assert.equal(getStatusLabel({ context }, now), '3 memory items loaded');
    assert.equal(
      getStatusLabel({ context, search: { results: 1, updatedAt: now + 10 } }, now + 20),
      '1 search result',
    );
    assert.equal(
      getStatusLabel(
        {
          context,
          search: { results: 2, updatedAt: now + 10 },
          capture: { status: 'saved', updatedAt: now + 15 },
        },
        now + 20,
      ),
      'session captured',
    );
    assert.equal(
      getStatusLabel({ context, capture: { status: 'saving', updatedAt: now + 15 } }, now + 20),
      'saving session',
    );
    assert.equal(
      renderStatusline({ context }, { now, color: false }),
      '◆ supermemory · 3 memory items loaded',
    );
  });

  test('suppresses stale and pre-session events', () => {
    assert.equal(
      getStatusLabel(
        {
          context,
          capture: { status: 'saving', updatedAt: now - SAVING_TTL_MS },
          search: { results: 4, updatedAt: now - SEARCH_TTL_MS },
        },
        now,
      ),
      '3 memory items loaded',
    );
    assert.equal(
      getStatusLabel(
        { context, capture: { status: 'saved', updatedAt: now - CAPTURE_TTL_MS } },
        now,
      ),
      '3 memory items loaded',
    );
    assert.equal(
      getStatusLabel({ context, search: { results: 4, updatedAt: now - 1 } }, now),
      '3 memory items loaded',
    );
    assert.equal(getStatusLabel({ context: { ...context, status: 'error' } }, now), null);
  });

  test('shows fresh activity even when context is stale or failed', () => {
    assert.equal(
      getStatusLabel(
        {
          context: { ...context, status: 'error' },
          search: { results: 4, updatedAt: now + 1 },
        },
        now + 2,
      ),
      '4 search results',
    );
  });
});
