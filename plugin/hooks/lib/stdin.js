async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch (err) {
        reject(new Error(`Failed to parse stdin JSON: ${err.message}`));
      }
    });
    process.stdin.on('error', reject);
    if (process.stdin.isTTY) resolve({});
  });
}

function writeOutput(data) {
  console.log(JSON.stringify(data));
}

module.exports = { readStdin, writeOutput };
