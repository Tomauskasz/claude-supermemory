const fs = require('node:fs');
const os = require('node:os');
const { CREDENTIALS_FILE } = require('./lib/auth');
const { getBaseUrl, SETTINGS_FILE } = require('./lib/settings');
const {
  getProjectName,
  getContainerTag,
  getAllReadTags,
} = require('./lib/container-tag');
const { getConfigPath } = require('./lib/project-config');

const SESSION_TIMEOUT_MS = 5000;

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { exists: false, data: null, error: null };
    }
    return {
      exists: true,
      data: JSON.parse(fs.readFileSync(filePath, 'utf-8')),
      error: null,
    };
  } catch (err) {
    return {
      exists: true,
      data: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function maskApiKey(apiKey) {
  if (!apiKey) return 'not set';
  if (apiKey.length <= 12) return `${apiKey.slice(0, 3)}... masked`;
  return `${apiKey.slice(0, 6)}...${apiKey.slice(-4)} masked`;
}

function displayPath(filePath) {
  if (!filePath) return 'not found';
  const home = os.homedir();
  return filePath.startsWith(`${home}/`)
    ? `~/${filePath.slice(home.length + 1)}`
    : filePath;
}

function resolveApiKey(cwd) {
  const globalSettings = readJson(SETTINGS_FILE);
  const projectConfigPath = getConfigPath(cwd);
  const projectConfig = readJson(projectConfigPath);
  const credentials = readJson(CREDENTIALS_FILE);

  const envKey = stringValue(process.env.SUPERMEMORY_CC_API_KEY);
  if (envKey) {
    return {
      apiKey: envKey,
      source: 'SUPERMEMORY_CC_API_KEY environment variable',
    };
  }

  const globalSettingsKey = stringValue(globalSettings.data?.apiKey);
  if (globalSettingsKey) {
    return {
      apiKey: globalSettingsKey,
      source: SETTINGS_FILE,
    };
  }

  const projectConfigKey = stringValue(projectConfig.data?.apiKey);
  if (projectConfigKey) {
    return {
      apiKey: projectConfigKey,
      source: projectConfigPath,
    };
  }

  const credentialsKey = stringValue(credentials.data?.apiKey);
  return {
    apiKey: credentialsKey,
    source: credentialsKey ? CREDENTIALS_FILE : null,
  };
}

async function getSession(apiKey, baseUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SESSION_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v3/session`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'x-sm-source': 'claude-code',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, status: response.status };
    }

    const session = await response.json();
    if (!session?.user) {
      return { ok: false, error: 'Session response did not include a user' };
    }

    return { ok: true, session };
  } catch (err) {
    return {
      ok: false,
      error:
        err?.name === 'AbortError'
          ? 'Request timed out'
          : err instanceof Error
            ? err.message
            : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function connectionError(result) {
  if (result.status === 401) return 'API key was rejected (HTTP 401)';
  if (result.status === 403)
    return 'API key does not have permission (HTTP 403)';
  if (result.status) return `API returned HTTP ${result.status}`;
  return result.error || 'Unknown connection error';
}

async function main() {
  const cwd = process.cwd();
  const projectName = getProjectName(cwd);
  const auth = resolveApiKey(cwd);
  let baseUrl = null;
  let verification = null;

  if (auth.apiKey) {
    try {
      baseUrl = getBaseUrl(cwd);
      verification = await getSession(auth.apiKey, baseUrl);
    } catch (err) {
      verification = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  let statusLabel = 'not authenticated';
  if (verification?.ok) {
    statusLabel = 'connected';
  } else if (auth.apiKey && verification?.status !== 401) {
    statusLabel = 'configured, but the connection could not be verified';
  }

  console.log(`Supermemory is ${statusLabel}.`);
  console.log('');
  console.log('Status:');
  console.log(`- Project: ${projectName}`);
  console.log(`- Project container: ${getContainerTag(cwd)}`);
  console.log(`- Reads (including legacy): ${getAllReadTags(cwd).join(', ')}`);
  console.log(`- API key source: ${displayPath(auth.source)}`);
  console.log(`- API key: ${maskApiKey(auth.apiKey)}`);
  if (baseUrl) console.log(`- API URL: ${baseUrl}`);

  if (verification?.ok) {
    const { user, org } = verification.session;
    console.log('');
    console.log('Account:');
    if (user.email) console.log(`- Email: ${user.email}`);
    if (user.name) console.log(`- Name: ${user.name}`);
    if (user.id) console.log(`- User ID: ${user.id}`);
    if (org?.name) console.log(`- Organization: ${org.name}`);
  } else if (verification) {
    console.log('');
    console.log(`Connection check failed: ${connectionError(verification)}`);
  }
}

main().catch((err) => {
  console.error(
    `Failed to get Supermemory status: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
});
