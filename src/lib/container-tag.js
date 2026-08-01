const { execSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProjectConfig } = require('./project-config');
const { getGitRoot } = require('./git-utils');

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

const repoInfoCache = new Map();

function normalizeGitRemote(remoteUrl) {
  const raw = remoteUrl.trim();
  if (!raw) return null;

  let normalized;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'file:') {
        normalized = `file:${decodeURIComponent(parsed.pathname)}`;
      } else {
        normalized = `${parsed.hostname.toLowerCase()}${
          parsed.port ? `:${parsed.port}` : ''
        }/${parsed.pathname.replace(/^\/+/, '')}`;
      }
    } catch {
      normalized = raw;
    }
  } else {
    const scpStyle = raw.match(/^(?:[^@/]+@)?([^:]+):(.+)$/);
    normalized = scpStyle
      ? `${scpStyle[1].toLowerCase()}/${scpStyle[2]}`
      : `file:${path.resolve(raw)}`;
  }

  return normalized
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
}

function getGitRepoInfo(cwd) {
  if (repoInfoCache.has(cwd)) {
    return repoInfoCache.get(cwd);
  }
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const normalizedRemote = normalizeGitRemote(remoteUrl);
    const displayRemote = remoteUrl.replace(/\/+$/, '').replace(/\.git$/i, '');
    const separator = Math.max(
      displayRemote.lastIndexOf('/'),
      displayRemote.lastIndexOf(':'),
    );
    const name = displayRemote.slice(separator + 1) || null;
    const result = { name, normalizedRemote };
    repoInfoCache.set(cwd, result);
    return result;
  } catch {
    const result = { name: null, normalizedRemote: null };
    repoInfoCache.set(cwd, result);
    return result;
  }
}

function getGitRepoName(cwd) {
  return getGitRepoInfo(cwd).name;
}

function getProjectBasePath(cwd) {
  return getGitRoot(cwd) || path.resolve(cwd);
}

function getGeneratedContainerTag(cwd) {
  return `user_project_${sha256(getProjectBasePath(cwd))}`;
}

function getContainerTag(cwd) {
  return getRepoContainerTag(cwd);
}

function getLegacyContainerTag(cwd) {
  return `claudecode_project_${sha256(getProjectBasePath(cwd))}`;
}

function getLegacyCodexUserTag(cwd) {
  let identity = null;
  try {
    identity = execSync('git config user.email', {
      cwd: getProjectBasePath(cwd),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {}
  identity =
    identity || process.env.USER || process.env.USERNAME || os.hostname();
  return `codex_user_${sha256(identity)}`;
}

function getLegacyCodexProjectTag(cwd) {
  return `codex_project_${sha256(getProjectBasePath(cwd))}`;
}

function loadLegacyCodexConfig() {
  try {
    const configPath = path.join(os.homedir(), '.codex', 'supermemory.json');
    if (!fs.existsSync(configPath)) return null;
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

function loadLegacyCursorConfig(cwd) {
  const globalConfigPath = path.join(
    os.homedir(),
    '.config',
    'cursor',
    'supermemory.json',
  );
  let globalConfig = null;
  try {
    if (fs.existsSync(globalConfigPath)) {
      globalConfig = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'));
    }
  } catch {}

  let projectConfig = null;
  let directory = path.resolve(cwd);
  while (true) {
    const configPath = path.join(
      directory,
      '.cursor',
      '.supermemory',
      'config.json',
    );
    try {
      if (fs.existsSync(configPath)) {
        projectConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        break;
      }
    } catch {}
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return { ...(globalConfig || {}), ...(projectConfig || {}) };
}

function getLegacyCursorUserTags(cwd) {
  const config = loadLegacyCursorConfig(cwd);
  let gitEmail = null;
  try {
    gitEmail = execSync('git config user.email', {
      cwd: getProjectBasePath(cwd),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {}
  const machineId = `${os.hostname()}_${os.userInfo().username}`;
  return uniqueTags([
    config.userContainerTag ||
      process.env.SUPERMEMORY_USER_TAG ||
      process.env.CURSOR_USER_EMAIL ||
      gitEmail ||
      machineId,
  ]).map((identity) => `cursor_user_${sha256(identity)}`);
}

function getLegacyCursorProjectTags(cwd) {
  const config = loadLegacyCursorConfig(cwd);
  const basePath = getProjectBasePath(cwd);
  return uniqueTags([
    config.projectContainerTag ||
      process.env.SUPERMEMORY_PROJECT_TAG ||
      basePath,
  ]).map((identity) => `cursor_project_${sha256(identity)}`);
}

function stripJsoncComments(content) {
  let result = '';
  let index = 0;
  let inString = false;
  let singleLineComment = false;
  let multiLineComment = false;

  while (index < content.length) {
    const char = content[index];
    const next = content[index + 1];

    if (!singleLineComment && !multiLineComment && char === '"') {
      let backslashes = 0;
      for (
        let cursor = index - 1;
        cursor >= 0 && content[cursor] === '\\';
        cursor--
      ) {
        backslashes++;
      }
      if (backslashes % 2 === 0) inString = !inString;
      result += char;
      index++;
      continue;
    }

    if (inString) {
      result += char;
      index++;
      continue;
    }

    if (
      !singleLineComment &&
      !multiLineComment &&
      char === '/' &&
      next === '/'
    ) {
      singleLineComment = true;
      index += 2;
      continue;
    }
    if (
      !singleLineComment &&
      !multiLineComment &&
      char === '/' &&
      next === '*'
    ) {
      multiLineComment = true;
      index += 2;
      continue;
    }
    if (singleLineComment) {
      if (char === '\n') {
        singleLineComment = false;
        result += char;
      }
      index++;
      continue;
    }
    if (multiLineComment) {
      if (char === '*' && next === '/') {
        multiLineComment = false;
        index += 2;
        continue;
      }
      if (char === '\n') result += char;
      index++;
      continue;
    }

    result += char;
    index++;
  }

  return result.replace(/,\s*([}\]])/g, '$1');
}

function loadLegacyOpenCodeConfig() {
  const configDir = path.join(os.homedir(), '.config', 'opencode');
  for (const filename of ['supermemory.jsonc', 'supermemory.json']) {
    try {
      const configPath = path.join(configDir, filename);
      if (!fs.existsSync(configPath)) continue;
      return JSON.parse(
        stripJsoncComments(fs.readFileSync(configPath, 'utf-8')),
      );
    } catch {
      return null;
    }
  }
  return null;
}

function getLegacyOpenCodeUserTags(cwd) {
  const config = loadLegacyOpenCodeConfig();
  let identity = null;
  try {
    identity = execSync('git config user.email', {
      cwd: getProjectBasePath(cwd),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {}
  identity =
    identity || process.env.USER || process.env.USERNAME || 'anonymous';
  const suffix = sha256(identity);
  return uniqueTags([
    config?.userContainerTag,
    `${config?.containerTagPrefix || 'opencode'}_user_${suffix}`,
    `opencode_user_${suffix}`,
  ]);
}

function getLegacyOpenCodeProjectTags(cwd) {
  const config = loadLegacyOpenCodeConfig();
  const hashes = [
    ...new Set(
      [cwd, path.resolve(cwd), getProjectBasePath(cwd)].map((value) =>
        sha256(value),
      ),
    ),
  ];
  return uniqueTags([
    config?.projectContainerTag,
    ...hashes.flatMap((suffix) => [
      `${config?.containerTagPrefix || 'opencode'}_project_${suffix}`,
      `opencode_project_${suffix}`,
    ]),
  ]);
}

function getLegacyCodexUserTags(cwd) {
  const config = loadLegacyCodexConfig();
  const defaultTag = getLegacyCodexUserTag(cwd);
  const suffix = defaultTag.slice('codex_user_'.length);
  return uniqueTags([
    config?.userContainerTag,
    `${config?.containerTagPrefix || 'codex'}_user_${suffix}`,
    defaultTag,
  ]);
}

function getLegacyCodexProjectTags(cwd) {
  const config = loadLegacyCodexConfig();
  const defaultTag = getLegacyCodexProjectTag(cwd);
  const suffix = defaultTag.slice('codex_project_'.length);
  return uniqueTags([
    config?.projectContainerTag,
    `${config?.containerTagPrefix || 'codex'}_project_${suffix}`,
    defaultTag,
  ]);
}

function sanitizeRepoName(name) {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return (sanitized || 'unknown').slice(0, 95).replace(/_+$/g, '') || 'unknown';
}

function getProjectIdentity(cwd) {
  const basePath = getProjectBasePath(cwd);
  const { normalizedRemote } = getGitRepoInfo(basePath);
  const isolateWorktrees = process.env.SUPERMEMORY_ISOLATE_WORKTREES === 'true';
  let localIdentity = basePath;
  try {
    localIdentity = fs.realpathSync.native(basePath);
  } catch {}
  return sha256(
    !isolateWorktrees && normalizedRemote
      ? normalizedRemote
      : `path:${localIdentity}`,
  );
}

function getLegacyGeneratedRepoContainerTag(cwd) {
  const basePath = getProjectBasePath(cwd);
  const gitRepoName = getGitRepoName(basePath);
  const repoName = gitRepoName || path.basename(basePath) || 'unknown';
  return `repo_${sanitizeRepoName(repoName)}`;
}

function getGeneratedRepoContainerTag(cwd) {
  const basePath = getProjectBasePath(cwd);
  const gitRepoName = getGitRepoName(basePath);
  const repoName = gitRepoName || path.basename(basePath) || 'unknown';
  const shortName = sanitizeRepoName(repoName).slice(0, 72).replace(/_+$/g, '');
  return `repo_${shortName || 'unknown'}__${getProjectIdentity(cwd)}`;
}

function getRepoContainerTag(cwd) {
  const projectConfig = loadProjectConfig(cwd);
  return (
    projectConfig?.repoContainerTag ||
    process.env.SUPERMEMORY_REPO_TAG ||
    loadLegacyCursorConfig(cwd)?.repoContainerTag ||
    loadLegacyCodexConfig()?.projectContainerTag ||
    loadLegacyOpenCodeConfig()?.projectContainerTag ||
    getGeneratedRepoContainerTag(cwd)
  );
}

function getProjectName(cwd) {
  const basePath = getProjectBasePath(cwd);
  const gitRepoName = getGitRepoName(basePath);
  return gitRepoName || path.basename(basePath) || 'unknown';
}

function uniqueTags(tags) {
  return [
    ...new Set(tags.filter((tag) => typeof tag === 'string' && tag.trim())),
  ];
}

function getPersonalReadTags(cwd) {
  const projectConfig = loadProjectConfig(cwd);
  const legacyCodexConfig = loadLegacyCodexConfig();
  return uniqueTags([
    getContainerTag(cwd),
    getGeneratedRepoContainerTag(cwd),
    projectConfig?.personalContainerTag,
    legacyCodexConfig?.userContainerTag,
    getGeneratedContainerTag(cwd),
    getLegacyContainerTag(cwd),
    ...getLegacyCodexUserTags(cwd),
    ...getLegacyOpenCodeUserTags(cwd),
    ...getLegacyCursorUserTags(cwd),
  ]);
}

function getProjectReadTags(cwd) {
  return uniqueTags([
    getRepoContainerTag(cwd),
    getGeneratedRepoContainerTag(cwd),
    getLegacyGeneratedRepoContainerTag(cwd),
    ...getLegacyCodexProjectTags(cwd),
    ...getLegacyOpenCodeProjectTags(cwd),
    ...getLegacyCursorProjectTags(cwd),
  ]);
}

function getAllReadTags(cwd) {
  return uniqueTags([...getPersonalReadTags(cwd), ...getProjectReadTags(cwd)]);
}

module.exports = {
  sha256,
  getGitRoot,
  normalizeGitRemote,
  getGitRepoName,
  getProjectIdentity,
  getContainerTag,
  getGeneratedContainerTag,
  getLegacyContainerTag,
  getLegacyCodexUserTag,
  getLegacyCodexProjectTag,
  getLegacyOpenCodeUserTags,
  getLegacyOpenCodeProjectTags,
  getLegacyCursorUserTags,
  getLegacyCursorProjectTags,
  getRepoContainerTag,
  getGeneratedRepoContainerTag,
  getLegacyGeneratedRepoContainerTag,
  getProjectName,
  getPersonalReadTags,
  getProjectReadTags,
  getAllReadTags,
  sanitizeRepoName,
};
