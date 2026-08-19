const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RUNTIME_FILENAME = 'statusline.cjs';

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
}

function atomicCopy(source, destination) {
  const dir = path.dirname(destination);
  ensurePrivateDir(dir);
  const temporary = path.join(
    dir,
    `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );

  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    try {
      fs.chmodSync(temporary, 0o600);
    } catch {
      // Best effort on filesystems without POSIX permissions.
    }
    fs.renameSync(temporary, destination);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The rename already removed the temporary file in the normal path.
    }
  }
}

function atomicWriteSettings(settingsPath, settings, mode = 0o600) {
  const dir = path.dirname(settingsPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    dir,
    `.settings.${process.pid}.${crypto.randomUUID()}.tmp`,
  );

  try {
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode,
    });
    fs.renameSync(temporary, settingsPath);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The rename already removed the temporary file in the normal path.
    }
  }
}

function formatStatuslineCommand(runtimePath) {
  const isWindowsAbsolute = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(runtimePath);
  const absolute =
    path.isAbsolute(runtimePath) || isWindowsAbsolute
      ? runtimePath
      : path.resolve(runtimePath);
  const normalized = absolute.replaceAll('\\', '/');
  const hasUnsafeCharacter = [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return character === "'" || code < 32 || code === 127;
  });
  if (hasUnsafeCharacter) {
    throw new Error(
      'The statusline path cannot contain control characters or single quotes',
    );
  }
  return `node '${normalized}'`;
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Claude settings must contain a JSON object');
  }
  return parsed;
}

function installStatusline(options) {
  const pluginDataDir = path.resolve(options.pluginDataDir);
  const sourcePath = path.resolve(options.sourcePath);
  const configDir = path.resolve(
    options.configDir ||
      process.env.CLAUDE_CONFIG_DIR ||
      path.join(os.homedir(), '.claude'),
  );
  const settingsPath = path.join(configDir, 'settings.json');
  const runtimePath = path.join(pluginDataDir, RUNTIME_FILENAME);
  const command = formatStatuslineCommand(runtimePath);
  const settings = readSettings(settingsPath);
  const existing = settings.statusLine;

  if (existing != null && existing?.command !== command) {
    return {
      status: 'existing-statusline',
      settingsPath,
      runtimePath,
    };
  }

  atomicCopy(sourcePath, runtimePath);

  let settingsMode = 0o600;
  try {
    settingsMode = fs.statSync(settingsPath).mode & 0o777;
  } catch {
    // New settings files should be private.
  }

  settings.statusLine = {
    ...(existing && typeof existing === 'object' ? existing : {}),
    type: 'command',
    command,
    refreshInterval: 1,
  };
  atomicWriteSettings(settingsPath, settings, settingsMode);

  return { status: 'installed', command, settingsPath, runtimePath };
}

function refreshInstalledStatusline(options = {}) {
  const pluginRoot = options.pluginRoot || process.env.CLAUDE_PLUGIN_ROOT;
  const pluginDataDir = options.pluginDataDir || process.env.CLAUDE_PLUGIN_DATA;
  if (!pluginRoot || !pluginDataDir) return false;

  const sourcePath = path.join(pluginRoot, 'scripts', RUNTIME_FILENAME);
  const runtimePath = path.join(pluginDataDir, RUNTIME_FILENAME);
  if (
    !fs.existsSync(sourcePath) ||
    !isStatuslineInstalled(pluginDataDir, options.configDir)
  ) {
    return false;
  }

  try {
    if (fs.readFileSync(sourcePath).equals(fs.readFileSync(runtimePath))) {
      return false;
    }
    atomicCopy(sourcePath, runtimePath);
    return true;
  } catch {
    return false;
  }
}

function isStatuslineInstalled(pluginDataDir, configDir) {
  if (!pluginDataDir) return false;
  const runtimePath = path.resolve(pluginDataDir, RUNTIME_FILENAME);
  const settingsPath = path.join(
    path.resolve(
      configDir ||
        process.env.CLAUDE_CONFIG_DIR ||
        path.join(os.homedir(), '.claude'),
    ),
    'settings.json',
  );

  try {
    const settings = readSettings(settingsPath);
    const command = settings.statusLine?.command;
    if (
      !fs.existsSync(runtimePath) ||
      settings.statusLine?.type !== 'command' ||
      typeof command !== 'string'
    ) {
      return false;
    }
    // Match by path so composite statuslines that embed the runtime
    // (absolute or ~-prefixed) count as installed.
    const normalized = runtimePath.replaceAll('\\', '/');
    const home = os.homedir().replaceAll('\\', '/');
    const tilde = normalized.startsWith(`${home}/`)
      ? `~${normalized.slice(home.length)}`
      : null;
    return (
      command.includes(normalized) || (tilde !== null && command.includes(tilde))
    );
  } catch {
    return false;
  }
}

module.exports = {
  RUNTIME_FILENAME,
  formatStatuslineCommand,
  installStatusline,
  isStatuslineInstalled,
  refreshInstalledStatusline,
};
