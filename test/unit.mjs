import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  mergeProfileResponses,
  mergeSearchResponses,
} = require('../src/lib/result-merge.js');
const { buildSync } = require('esbuild');

function hash16(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
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

describe('agent scope migration', () => {
  const canonicalTag = 'custom_canonical_tag';
  const legacyTag = 'claudecode_project_legacy';
  const expectedFilters = {
    AND: [
      { key: 'agent_scope', value: 'personal', filterType: 'metadata' },
    ],
  };
  let SupermemoryClient;

  function loadSupermemoryClient() {
    if (SupermemoryClient) return SupermemoryClient;

    const outfile = join(process.cwd(), 'test', '.supermemory-client.test.cjs');
    buildSync({
      entryPoints: [join(process.cwd(), 'src', 'lib', 'supermemory-client.js')],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      outfile,
    });
    SupermemoryClient = require(outfile).SupermemoryClient;
    rmSync(outfile, { force: true });
    return SupermemoryClient;
  }

  function createScopedClient() {
    const searchCalls = [];
    const profileCalls = [];
    const Client = loadSupermemoryClient();
    const client = new Client('sm_12345678901234567890', canonicalTag);
    client.client = {
      search: {
        memories: async (payload) => {
          searchCalls.push(payload);
          return { results: [], total: 0, timing: 0 };
        },
      },
      profile: async (payload) => {
        profileCalls.push(payload);
        return { profile: { static: [], dynamic: [] } };
      },
    };
    return { client, searchCalls, profileCalls };
  }

  test('filters canonical scoped searches by agent_scope only', async () => {
    const { client, searchCalls } = createScopedClient();

    await client.searchScoped(
      'test query',
      canonicalTag,
      [canonicalTag, legacyTag],
      'personal',
    );

    assert.deepEqual(searchCalls, [
      {
        q: 'test query',
        containerTag: canonicalTag,
        limit: 10,
        searchMode: 'hybrid',
        filters: expectedFilters,
      },
      {
        q: 'test query',
        containerTag: legacyTag,
        limit: 10,
        searchMode: 'hybrid',
      },
    ]);
  });

  test('filters canonical scoped profiles by agent_scope only', async () => {
    const { client, profileCalls } = createScopedClient();

    await client.getProfileScoped(
      canonicalTag,
      [canonicalTag, legacyTag],
      'personal',
      'test query',
    );

    assert.deepEqual(profileCalls, [
      {
        containerTag: canonicalTag,
        q: 'test query',
        filters: expectedFilters,
      },
      { containerTag: legacyTag, q: 'test query' },
    ]);
  });

  test('writes agent_scope metadata in every memory write path', () => {
    const writePaths = [
      ['../src/add-memory.js', "agent_scope: 'personal'"],
      ['../src/summary-hook.js', "agent_scope: 'personal'"],
      ['../src/save-project-memory.js', "agent_scope: 'project'"],
    ];

    for (const [path, expectedScope] of writePaths) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf-8');
      assert.match(source, new RegExp(expectedScope));
      assert.doesNotMatch(source, /sm_scope/);
    }
  });
});
