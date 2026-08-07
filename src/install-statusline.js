const path = require('node:path');
const { installStatusline } = require('./lib/statusline-install');

function main() {
  const pluginDataDir = process.argv[2] || process.env.CLAUDE_PLUGIN_DATA;
  if (!pluginDataDir) {
    throw new Error(
      'Claude did not provide a persistent plugin data directory',
    );
  }

  const result = installStatusline({
    pluginDataDir,
    sourcePath: path.join(__dirname, 'statusline.cjs'),
  });

  if (result.status === 'existing-statusline') {
    console.log(
      `An existing Claude Code status line is already configured in ${result.settingsPath}. It was left unchanged.`,
    );
    console.log(
      'Remove the existing status line setting, then run /supermemory:statusline again.',
    );
    return;
  }

  console.log(`Supermemory status line installed in ${result.settingsPath}.`);
  console.log('It will appear on the next Claude Code status refresh.');
}

try {
  main();
} catch (error) {
  console.error(
    `Could not install the Supermemory status line: ${error.message}`,
  );
  process.exitCode = 1;
}
