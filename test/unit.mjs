import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  mergeProfileResponses,
  mergeSearchResponses,
} = require('../src/lib/result-merge.js');
const {
  SESSION_RETENTION_MS,
  countLoadedProfileItems,
  getSessionDir,
  pruneState,
  readState,
  writeState,
} = require('../src/lib/statusline-state.js');
const {
  formatStatuslineCommand,
  installStatusline,
  isStatuslineInstalled,
  refreshInstalledStatusline,
} = require('../src/lib/statusline-install.js');
const { parseSearchArgs } = require('../src/lib/search-args.js');
const {
  CAPTURE_TTL_MS,
  CONTEXT_TTL_MS,
  SAVING_TTL_MS,
  SEARCH_TTL_MS,
  getStatusLabel,
  renderStatusline,
} = require('../src/statusline.js');

function hash16(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function makeTempDir(t, name) {
  const root = join(tmpdir(), `claude-sm-${name}-${Date.now()}-${Math.random()}`);
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
  const modulePath = join(process.cwd(), 'src', 'lib', 'container-tag.js');
  const script = `
    const tags = require(${JSON.stringify(modulePath)});
    console.log(JSON.stringify({
      personal: tags.getContainerTag(process.argv[1]),
      project: tags.getRepoContainerTag(process.argv[1]),
      personalReads: tags.getPersonalReadTags(process.argv[1]),
      projectReads: tags.getProjectReadTags(process.argv[1]),
    }));
  `;
  const result = spawnSync('node', ['-e', script, cwd], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      USER: 'test-user',
      USERNAME: '',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

describe('unified container tags', () => {
  test('writes one stable canonical tag and reads all agent legacy tags', (t) => {
    const { repo, git, home } = makeRepo(t);
    const tags = readTags(repo, home);
    const pathHash = hash16(git(['rev-parse', '--show-toplevel']));
    const userHash = hash16('test@example.com');
    const projectHash = hash16('github.com/acme/example.project');
    const canonicalTag = `repo_example_project__${projectHash}`;

    assert.equal(tags.personal, canonicalTag);
    assert.equal(tags.project, canonicalTag);
    assert.deepEqual(tags.personalReads, [
      canonicalTag,
      `user_project_${pathHash}`,
      `claudecode_project_${pathHash}`,
      `codex_user_${userHash}`,
      `opencode_user_${userHash}`,
      `cursor_user_${userHash}`,
    ]);
    assert.deepEqual(tags.projectReads, [
      canonicalTag,
      'repo_example_project',
      `codex_project_${pathHash}`,
      ...[...new Set([hash16(repo), pathHash])].map(
        (hash) => `opencode_project_${hash}`,
      ),
      `cursor_project_${pathHash}`,
    ]);
  });

  test('uses the shared git common root for linked worktrees', (t) => {
    const { repo, git, home } = makeRepo(t, 'repo');
    git(['add', 'README.md']);
    git(['commit', '-m', 'initial']);
    const worktree = join(repo, '..', 'worktree');
    git(['worktree', 'add', '--detach', worktree, 'HEAD']);
    const repoTags = readTags(repo, home);
    const worktreeTags = readTags(worktree, home);
    assert.equal(worktreeTags.personal, repoTags.personal);
  });

  test('honors existing explicit Codex overrides for shared writes', (t) => {
    const { repo, home } = makeRepo(t);
    const codexDir = join(home, '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, 'supermemory.json'),
      JSON.stringify({
        userContainerTag: 'shared_personal',
        projectContainerTag: 'shared_project',
      }),
    );

    const tags = readTags(repo, home);
    assert.equal(tags.personal, 'shared_project');
    assert.equal(tags.project, 'shared_project');
    assert.equal(tags.personalReads[0], 'shared_project');
    assert.ok(tags.personalReads.includes('shared_personal'));
    assert.equal(tags.projectReads[0], 'shared_project');
  });
});

describe('cross-container result merging', () => {
  test('globally ranks and deduplicates search results', () => {
    const merged = mergeSearchResponses(
      [
        { results: [{ id: 'old', memory: 'A', similarity: 0.4 }] },
        {
          results: [
            { id: 'best', memory: 'B', similarity: 0.9 },
            { id: 'new', memory: 'A', similarity: 0.8 },
          ],
        },
      ],
      10,
    );
    assert.deepEqual(merged.results.map((result) => result.id), ['best', 'new']);
  });

  test('deduplicates profile facts across legacy containers', () => {
    const merged = mergeProfileResponses([
      { profile: { static: ['Uses pnpm'], dynamic: ['Working on auth'] } },
      { profile: { static: ['uses pnpm'], dynamic: ['Testing agents'] } },
    ]);
    assert.deepEqual(merged.profile.static, ['Uses pnpm']);
    assert.deepEqual(merged.profile.dynamic, ['Working on auth', 'Testing agents']);
  });
});

describe('statusline state', () => {
  test('isolates sessions and writes private atomic event files', (t) => {
    const dataDir = makeTempDir(t, 'status-state');
    assert.equal(
      writeState(
        '../../session-a',
        'context',
        { status: 'ready', memoryItemsLoaded: 4 },
        { dataDir, now: 1000 },
      ),
      true,
    );
    writeState(
      'session-a',
      'search',
      { results: 2, query: 'must not be stored' },
      { dataDir, now: 1100 },
    );
    writeState(
      'session-b',
      'context',
      { status: 'ready', memoryItemsLoaded: 9 },
      { dataDir, now: 1200 },
    );

    const first = readState('../../session-a', { dataDir });
    const second = readState('session-b', { dataDir });
    assert.equal(first.context.memoryItemsLoaded, 4);
    assert.equal(first.search, null);
    assert.equal(second.context.memoryItemsLoaded, 9);

    const traversalDir = getSessionDir('../../session-a', dataDir);
    assert.match(basename(traversalDir), /^[a-f0-9]{64}$/);
    const contextPath = join(traversalDir, 'context.json');
    if (process.platform !== 'win32') {
      assert.equal(statSync(traversalDir).mode & 0o777, 0o700);
      assert.equal(statSync(contextPath).mode & 0o777, 0o600);
    }
    assert.equal(readdirSync(traversalDir).some((name) => name.endsWith('.tmp')), false);
  });

  test('keeps context, capture, and search updates independent', (t) => {
    const dataDir = makeTempDir(t, 'status-events');
    writeState(
      'session-a',
      'context',
      { status: 'ready', memoryItemsLoaded: 3 },
      { dataDir, now: 1000 },
    );
    writeState(
      'session-a',
      'capture',
      { status: 'saving' },
      { dataDir, now: 1100 },
    );
    writeState(
      'session-a',
      'search',
      { results: 1, query: 'private query' },
      { dataDir, now: 1200 },
    );

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
      profile: {
        static: ['a', 'b', 'c'],
        dynamic: ['d', 'e', 'f'],
      },
      searchResults: { results: [{ memory: 'not injected' }] },
    };
    assert.equal(countLoadedProfileItems(result, 2), 4);
  });

  test('prunes only stale hashed session directories', (t) => {
    const dataDir = makeTempDir(t, 'status-prune');
    writeState(
      'stale-session',
      'context',
      { status: 'ready', memoryItemsLoaded: 1 },
      { dataDir },
    );
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
      getStatusLabel(
        {
          context,
          search: { results: 1, updatedAt: now + 10 },
        },
        now + 20,
      ),
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
      getStatusLabel(
        {
          context,
          capture: { status: 'saving', updatedAt: now + 15 },
        },
        now + 20,
      ),
      'saving session',
    );
    assert.equal(renderStatusline({ context }, { now, color: false }), 'supermemory · 3 memory items loaded');
  });

  test('suppresses stale and pre-session events', () => {
    assert.equal(
      getStatusLabel(
        {
          context,
          capture: {
            status: 'saving',
            updatedAt: now - SAVING_TTL_MS,
          },
          search: { results: 4, updatedAt: now - SEARCH_TTL_MS },
        },
        now,
      ),
      '3 memory items loaded',
    );
    assert.equal(
      getStatusLabel(
        {
          context,
          capture: {
            status: 'saved',
            updatedAt: now - CAPTURE_TTL_MS,
          },
        },
        now,
      ),
      '3 memory items loaded',
    );
    assert.equal(
      getStatusLabel(
        {
          context,
          search: { results: 4, updatedAt: now - 1 },
        },
        now,
      ),
      '3 memory items loaded',
    );
    assert.equal(
      getStatusLabel(
        {
          context: { ...context, status: 'error' },
        },
        now,
      ),
      null,
    );
  });

  test('shows fresh activity even when context is stale or failed', () => {
    assert.equal(
      getStatusLabel(
        {
          context: {
            ...context,
            status: 'error',
          },
          search: { results: 4, updatedAt: now + 1 },
        },
        now + 2,
      ),
      '4 search results',
    );
    assert.equal(
      getStatusLabel(
        {
          context: {
            ...context,
            updatedAt: now - CONTEXT_TTL_MS,
          },
          capture: { status: 'saved', updatedAt: now - 1 },
        },
        now,
      ),
      'session captured',
    );
    assert.equal(
      getStatusLabel(
        {
          context: {
            ...context,
            updatedAt: now - CONTEXT_TTL_MS,
          },
        },
        now,
      ),
      null,
    );
  });
});

describe('statusline installer', () => {
  test('installs a persistent cross-platform command without losing settings', (t) => {
    const root = makeTempDir(t, 'status-install');
    const pluginDataDir = join(root, 'plugin data');
    const configDir = join(root, 'claude config');
    const sourcePath = join(root, 'statusline.cjs');
    writeFileSync(sourcePath, 'console.log("v1");\n');
    mkdirSync(configDir, { recursive: true });
    if (process.platform !== 'win32') chmodSync(configDir, 0o755);
    writeFileSync(
      join(configDir, 'settings.json'),
      `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`,
    );

    const result = installStatusline({ pluginDataDir, configDir, sourcePath });
    const settings = JSON.parse(
      readFileSync(join(configDir, 'settings.json'), 'utf8'),
    );
    assert.equal(result.status, 'installed');
    assert.equal(settings.theme, 'dark');
    assert.equal(settings.statusLine.type, 'command');
    assert.equal(settings.statusLine.refreshInterval, 1);
    assert.match(
      settings.statusLine.command,
      /^node '.*plugin data\/statusline\.cjs'$/,
    );
    assert.equal(readFileSync(result.runtimePath, 'utf8'), 'console.log("v1");\n');
    if (process.platform !== 'win32') {
      assert.equal(statSync(result.runtimePath).mode & 0o777, 0o600);
      assert.equal(statSync(configDir).mode & 0o777, 0o755);
    }
    assert.equal(isStatuslineInstalled(pluginDataDir, configDir), true);
    assert.equal(
      formatStatuslineCommand('C:\\Users\\Ishaan Gupta\\plugin\\statusline.cjs'),
      "node 'C:/Users/Ishaan Gupta/plugin/statusline.cjs'",
    );
    assert.equal(
      formatStatuslineCommand('/tmp/config-$(id)/statusline.cjs'),
      "node '/tmp/config-$(id)/statusline.cjs'",
    );
    assert.throws(() =>
      formatStatuslineCommand("/tmp/config-'unsafe'/statusline.cjs"),
    );
  });

  test('leaves an unrelated existing status line untouched', (t) => {
    const root = makeTempDir(t, 'status-existing');
    const pluginDataDir = join(root, 'plugin-data');
    const configDir = join(root, 'config');
    const settingsPath = join(configDir, 'settings.json');
    const sourcePath = join(root, 'statusline.cjs');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(sourcePath, 'new runtime');
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ statusLine: { type: 'command', command: 'my-status' } }, null, 2)}\n`,
    );

    const before = readFileSync(settingsPath, 'utf8');
    const result = installStatusline({ pluginDataDir, configDir, sourcePath });
    assert.equal(result.status, 'existing-statusline');
    assert.equal(readFileSync(settingsPath, 'utf8'), before);
    assert.equal(existsSync(join(pluginDataDir, 'statusline.cjs')), false);
    assert.equal(isStatuslineInstalled(pluginDataDir, configDir), false);
  });

  test('refreshes an opted-in runtime after plugin updates', (t) => {
    const root = makeTempDir(t, 'status-refresh');
    const pluginRoot = join(root, 'plugin');
    const pluginDataDir = join(root, 'data');
    const configDir = join(root, 'config');
    mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
    mkdirSync(pluginDataDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(pluginRoot, 'scripts', 'statusline.cjs'), 'new');
    writeFileSync(join(pluginDataDir, 'statusline.cjs'), 'old');
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({
        statusLine: {
          type: 'command',
          command: formatStatuslineCommand(
            join(pluginDataDir, 'statusline.cjs'),
          ),
        },
      }),
    );

    assert.equal(
      refreshInstalledStatusline({ pluginRoot, pluginDataDir, configDir }),
      true,
    );
    assert.equal(readFileSync(join(pluginDataDir, 'statusline.cjs'), 'utf8'), 'new');
    assert.equal(
      refreshInstalledStatusline({ pluginRoot, pluginDataDir, configDir }),
      false,
    );
  });

  test('does not overwrite malformed Claude settings', (t) => {
    const root = makeTempDir(t, 'status-malformed');
    const pluginDataDir = join(root, 'plugin-data');
    const configDir = join(root, 'config');
    const settingsPath = join(configDir, 'settings.json');
    const sourcePath = join(root, 'statusline.cjs');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(sourcePath, 'runtime');
    writeFileSync(settingsPath, '{broken');

    assert.throws(() =>
      installStatusline({ pluginDataDir, configDir, sourcePath }),
    );
    assert.equal(readFileSync(settingsPath, 'utf8'), '{broken');
    assert.equal(existsSync(join(pluginDataDir, 'statusline.cjs')), false);
  });
});

describe('statusline command', () => {
  test('selects state using statusline stdin session_id', (t) => {
    const dataDir = makeTempDir(t, 'status-command');
    const now = Date.now();
    writeState(
      'session-a',
      'context',
      { status: 'ready', memoryItemsLoaded: 6 },
      { dataDir, now },
    );

    const result = spawnSync('node', ['src/statusline.js'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 'session-a' }),
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /6 memory items loaded/);
  });

  test('fails silently on malformed statusline input', () => {
    const result = spawnSync('node', ['src/statusline.js'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: '{broken',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  });

  test('renders and exits while the input pipe remains open', async (t) => {
    const dataDir = makeTempDir(t, 'status-held-open');
    writeState(
      'session-held-open',
      'context',
      { status: 'ready', memoryItemsLoaded: 8 },
      { dataDir },
    );

    const child = spawn(process.execPath, ['src/statusline.js'], {
      cwd: process.cwd(),
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => child.kill());

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify({ session_id: 'session-held-open' }));

    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('statusline waited for stdin EOF'));
      }, 1500);
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    assert.equal(exitCode, 0, stderr);
    assert.match(stdout, /8 memory items loaded/);
  });
});

describe('search statusline bridge', () => {
  test('parses the persistent data directory separately from the query', () => {
    assert.deepEqual(
      parseSearchArgs([
        '--statusline-data-dir',
        '/tmp/plugin data',
        '--repo',
        'authentication implementation',
      ]),
      {
        containerType: 'repo',
        query: 'authentication implementation',
        statuslineDataDir: '/tmp/plugin data',
      },
    );
  });
});
