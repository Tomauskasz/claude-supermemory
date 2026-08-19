const { SupermemoryClient } = require('./lib/supermemory-client');
const { getProjectName, getAllReadTags } = require('./lib/container-tag');
const { loadProjectConfig } = require('./lib/project-config');
const {
  loadSettings,
  getApiKey,
  getBaseUrl,
  debugLog,
} = require('./lib/settings');
const { readStdin, writeOutput } = require('./lib/stdin');
const { startAuthFlow, AUTH_BASE_URL } = require('./lib/auth');
const { formatContext, combineContexts } = require('./lib/format-context');
const { getUserFriendlyError, isBenignError } = require('./lib/error-helpers');
const { PLUGIN_VERSION } = require('./lib/plugin-version');
const { checkForUpdate, formatUpdateNotice } = require('./lib/version-check');
const {
  countLoadedProfileItems,
  pruneState,
  resolveStatuslineDataDir,
  writeState,
} = require('./lib/statusline-state');
const {
  isStatuslineInstalled,
  refreshInstalledStatusline,
} = require('./lib/statusline-install');
const fs = require('node:fs');
const path = require('node:path');

const STATUSLINE_TIP_FILE = 'statusline-tip-shown';

function getStatuslineOnboardingNotice(dataDir) {
  if (isStatuslineInstalled(dataDir)) return null;
  const tipFile = path.join(dataDir, STATUSLINE_TIP_FILE);

  try {
    if (fs.existsSync(tipFile)) return null;
  } catch {
    // continue
  }

  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tipFile, new Date().toISOString(), {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // best-effort
  }

  return 'Supermemory status line is available. Run /supermemory:statusline to enable it.';
}

function combineOutputParts(parts) {
  return parts
    .map((part) => part?.trim())
    .filter(Boolean)
    .join('\n\n');
}

function writeSessionStartOutput(additionalContext, systemMessage = null) {
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
  let statuslineDataDir;

  try {
    const input = await readStdin();
    sessionId = input.session_id;
    const cwd = input.cwd || process.cwd();
    statuslineDataDir = resolveStatuslineDataDir();
    refreshInstalledStatusline();
    pruneState({ dataDir: statuslineDataDir });
    writeState(
      sessionId,
      'context',
      { status: 'loading', memoryItemsLoaded: 0 },
      { dataDir: statuslineDataDir },
    );
    const projectName = getProjectName(cwd);
    const updateCheck = checkForUpdate(PLUGIN_VERSION).then((info) =>
      info ? formatUpdateNotice(info) : null,
    );
    const projectConfig = loadProjectConfig(cwd);

    debugLog(settings, 'SessionStart', { cwd, projectName });

    let apiKey;
    try {
      apiKey = getApiKey(settings, cwd, projectConfig);
    } catch {
      try {
        debugLog(settings, 'No API key found, starting browser auth flow');
        apiKey = await startAuthFlow();
        debugLog(settings, 'Auth flow completed successfully');
      } catch (authErr) {
        const isTimeout = authErr.message === 'AUTH_TIMEOUT';
        writeState(
          sessionId,
          'context',
          { status: 'error', memoryItemsLoaded: 0 },
          { dataDir: statuslineDataDir },
        );
        writeSessionStartOutput(
          `<supermemory-status>
${isTimeout ? 'Authentication timed out. Please complete login in the browser window.' : 'Authentication failed.'}
If the browser did not open, visit: ${AUTH_BASE_URL}
Or set SUPERMEMORY_CC_API_KEY environment variable manually.
</supermemory-status>`,
          await updateCheck,
        );
        return;
      }
    }

    const baseUrl = getBaseUrl(cwd, projectConfig);
    const client = new SupermemoryClient(apiKey, undefined, { baseUrl });
    const readTags = getAllReadTags(cwd);

    debugLog(settings, 'Fetching project context', { readTags });

    const apiErrors = [];

    const handleProfileError = (label) => (err) => {
      if (isBenignError(err)) {
        debugLog(settings, `Benign error fetching ${label} context`, {
          status: err.status,
          message: err.message,
        });
        return null;
      }
      const friendly = getUserFriendlyError(err);
      debugLog(settings, `Error fetching ${label} context`, {
        status: err.status,
        message: friendly,
      });
      apiErrors.push(friendly);
      return null;
    };

    const projectResult = await client
      .getProfileMany(readTags, projectName, {
        limit: settings.maxProfileItems,
      })
      .catch(handleProfileError('project'));

    const projectContext = formatContext(
      projectResult,
      true,
      false,
      settings.maxProfileItems,
      false,
    );

    const memoryItemsLoaded = countLoadedProfileItems(
      projectResult,
      settings.maxProfileItems,
    );
    writeState(
      sessionId,
      'context',
      {
        status: apiErrors.length > 0 ? 'error' : 'ready',
        memoryItemsLoaded,
      },
      { dataDir: statuslineDataDir },
    );

    const additionalContext = combineContexts([
      {
        label: '### Project Memories (Shared across agents)',
        content: projectContext,
      },
    ]);

    const memoryNotice =
      memoryItemsLoaded > 0
        ? `supermemory · ${memoryItemsLoaded} ${memoryItemsLoaded === 1 ? 'memory' : 'memories'} loaded for ${projectName}`
        : null;

    const errorNotice =
      apiErrors.length > 0
        ? `<supermemory-status>\n${[...new Set(apiErrors)].join('\n')}\n</supermemory-status>\n`
        : '';

    if (!additionalContext) {
      const updateNotice = await updateCheck;
      writeSessionStartOutput(
        apiErrors.length > 0
          ? errorNotice
          : `<supermemory-context>
No previous memories found for this project.
Memories will be saved as you work.
</supermemory-context>`,
        combineOutputParts([
          updateNotice,
          getStatuslineOnboardingNotice(statuslineDataDir),
        ]),
      );
      return;
    }

    debugLog(settings, 'Context generated', {
      length: additionalContext.length,
      hasProject: !!projectContext,
    });

    const updateNotice = await updateCheck;
    writeSessionStartOutput(
      errorNotice + additionalContext,
      combineOutputParts([
        memoryNotice,
        updateNotice,
        getStatuslineOnboardingNotice(statuslineDataDir),
      ]),
    );
  } catch (err) {
    const friendly = getUserFriendlyError(err);
    debugLog(settings, 'Error', { error: friendly });
    console.error(`Supermemory: ${friendly}`);
    writeState(
      sessionId,
      'context',
      { status: 'error', memoryItemsLoaded: 0 },
      { dataDir: statuslineDataDir },
    );
    writeSessionStartOutput(`<supermemory-status>
Failed to load memories: ${friendly}
Session will continue without memory context.
</supermemory-status>`);
  }
}

main().catch((err) => {
  console.error(`Supermemory fatal: ${err.message}`);
  process.exit(1);
});
