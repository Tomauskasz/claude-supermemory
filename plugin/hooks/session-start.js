const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { getProfile } = require('./lib/api');
const { getContainerTag, getProjectName } = require('./lib/container-tag');
const { loadProjectConfig } = require('./lib/project-config');
const {
  loadSettings,
  getApiKey,
  getBaseUrl,
  debugLog,
} = require('./lib/settings');
const { readStdin, writeOutput } = require('./lib/stdin');
const { startAuthFlow, AUTH_BASE_URL } = require('./lib/auth');
const { getUserFriendlyError, isBenignError } = require('./lib/error-helpers');
const { LAST_SESSION_FILE } = require('./lib/last-session');
const {
  pruneState,
  resolveStatuslineDataDir,
  writeState,
} = require('./lib/statusline-state');

const STATUSLINE_LINK = path.join(
  os.homedir(),
  '.supermemory-claude',
  'statusline-current',
);
const STATUSLINE_TIP_FILE = path.join(
  os.homedir(),
  '.supermemory-claude',
  'statusline-tip-shown',
);

// The statusline setting needs one path that survives plugin updates; a
// symlink re-pointed each session is that path — no code is ever copied.
function refreshStatuslineLink() {
  const target = path.join(__dirname, '..', 'statusline.js');
  try {
    fs.mkdirSync(path.dirname(STATUSLINE_LINK), { recursive: true });
    try {
      if (fs.readlinkSync(STATUSLINE_LINK) === target) return;
      fs.unlinkSync(STATUSLINE_LINK);
    } catch {}
    fs.symlinkSync(target, STATUSLINE_LINK);
  } catch {}
}

function statuslineTip() {
  try {
    if (fs.existsSync(STATUSLINE_TIP_FILE)) return null;
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (
      JSON.stringify(settings.statusLine || '').includes('statusline-current')
    ) {
      return null;
    }
    fs.writeFileSync(STATUSLINE_TIP_FILE, new Date().toISOString());
    return `◆ Supermemory status line available: add \`node ~/.supermemory-claude/statusline-current\` to your statusLine command.`;
  } catch {
    return null;
  }
}

function welcomeBackNotice(containerTag) {
  try {
    const last = JSON.parse(fs.readFileSync(LAST_SESSION_FILE, 'utf-8'));
    if (!last.savedAt || last.containerTag !== containerTag) return null;
    const hours = (Date.now() - new Date(last.savedAt).getTime()) / 3600000;
    if (hours < 6) return null;
    const ago =
      hours < 48 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)}d ago`;
    return `welcome back — last session here ${ago}`;
  } catch {
    return null;
  }
}

function formatRelativeTime(isoTimestamp) {
  try {
    const minutes = (Date.now() - new Date(isoTimestamp).getTime()) / 60000;
    if (minutes < 30) return 'just now';
    if (minutes < 60) return `${Math.floor(minutes)}mins ago`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}hrs ago`;
    if (minutes < 10080) return `${Math.floor(minutes / 1440)}d ago`;
    const dt = new Date(isoTimestamp);
    return `${dt.getDate()} ${dt.toLocaleString('en', { month: 'short' })}`;
  } catch {
    return '';
  }
}

function formatContext(profileResult, maxItems, containerTag, projectName) {
  const statics = (profileResult?.profile?.static || []).slice(0, maxItems);
  const dynamics = (profileResult?.profile?.dynamic || []).slice(0, maxItems);
  if (statics.length === 0 && dynamics.length === 0) return null;

  const sections = [];
  if (statics.length > 0) {
    sections.push(
      `## User Profile (Persistent)\n${statics.map((f) => `- ◆ ${f}`).join('\n')}`,
    );
  }
  if (dynamics.length > 0) {
    sections.push(
      `## Recent Context\n${dynamics.map((f) => `- ◆ ${f}`).join('\n')}`,
    );
  }

  return `<supermemory-context>
Recalled memory for this project (${projectName}). Every line marked ◆ comes from supermemory — keep the mark when citing one (e.g. "◆ from memory: ...").
This project's memory container: ${containerTag}

${sections.join('\n\n')}
</supermemory-context>`;
}

function output(additionalContext, systemMessageParts) {
  const systemMessage = systemMessageParts.filter(Boolean).join('\n');
  writeOutput({
    ...(systemMessage ? { systemMessage } : {}),
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  });
}

async function main() {
  const settings = loadSettings();
  let sessionId;

  try {
    const input = await readStdin();
    sessionId = input.session_id;
    const cwd = input.cwd || process.cwd();

    refreshStatuslineLink();
    pruneState({ dataDir: resolveStatuslineDataDir() });
    writeState(sessionId, 'context', { status: 'loading', memoryItemsLoaded: 0 });

    const projectConfig = loadProjectConfig(cwd);
    const projectName = getProjectName(cwd);
    const containerTag = getContainerTag(cwd);

    debugLog(settings, 'SessionStart', { cwd, projectName, containerTag });

    let apiKey;
    try {
      apiKey = getApiKey(cwd, projectConfig);
    } catch {
      try {
        apiKey = await startAuthFlow();
      } catch (authErr) {
        writeState(sessionId, 'context', { status: 'error', memoryItemsLoaded: 0 });
        output(
          `<supermemory-status>
${authErr.message === 'AUTH_TIMEOUT' ? 'Authentication timed out. Please complete login in the browser window.' : 'Authentication failed.'}
If the browser did not open, visit: ${AUTH_BASE_URL}
Or set the SUPERMEMORY_CC_API_KEY environment variable.
</supermemory-status>`,
          [],
        );
        return;
      }
    }

    const baseUrl = getBaseUrl(cwd, projectConfig);

    let profileResult = null;
    let apiError = null;
    try {
      profileResult = await getProfile(baseUrl, apiKey, containerTag, projectName);
    } catch (err) {
      if (!isBenignError(err)) apiError = getUserFriendlyError(err);
      debugLog(settings, 'Profile fetch failed', { error: err.message });
    }

    const context = formatContext(
      profileResult,
      settings.maxProfileItems,
      containerTag,
      projectName,
    );
    const loaded =
      Math.min(profileResult?.profile?.static?.length || 0, settings.maxProfileItems) +
      Math.min(profileResult?.profile?.dynamic?.length || 0, settings.maxProfileItems);

    writeState(sessionId, 'context', {
      status: apiError ? 'error' : 'ready',
      memoryItemsLoaded: loaded,
    });

    const memoryNotice =
      loaded > 0
        ? `◆ supermemory · ${loaded} ${loaded === 1 ? 'memory' : 'memories'} loaded for ${projectName}`
        : null;

    output(
      (apiError ? `<supermemory-status>\n${apiError}\n</supermemory-status>\n` : '') +
        (context ||
          `<supermemory-context>
No previous memories found for this project (container: ${containerTag}).
Memories will be saved as you work.
</supermemory-context>`),
      [
        [memoryNotice, welcomeBackNotice(containerTag)]
          .filter(Boolean)
          .join(' · ') || null,
        statuslineTip(),
      ],
    );
  } catch (err) {
    const friendly = getUserFriendlyError(err);
    console.error(`Supermemory: ${friendly}`);
    writeState(sessionId, 'context', { status: 'error', memoryItemsLoaded: 0 });
    output(
      `<supermemory-status>
Failed to load memories: ${friendly}
Session will continue without memory context.
</supermemory-status>`,
      [],
    );
  }
}

main().catch((err) => {
  console.error(`Supermemory fatal: ${err.message}`);
  process.exit(1);
});
