function parseSearchArgs(args) {
  let containerType = 'both';
  let statuslineDataDir;
  const queryParts = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--user') {
      containerType = 'user';
    } else if (arg === '--repo') {
      containerType = 'repo';
    } else if (arg === '--both') {
      containerType = 'both';
    } else if (arg === '--statusline-data-dir') {
      statuslineDataDir = args[index + 1];
      index += 1;
    } else {
      queryParts.push(arg);
    }
  }

  return { containerType, query: queryParts.join(' '), statuslineDataDir };
}

module.exports = { parseSearchArgs };
