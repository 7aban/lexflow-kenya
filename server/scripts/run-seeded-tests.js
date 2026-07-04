const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const serverDir = path.join(__dirname, '..');
const jestBin = require.resolve('jest/bin/jest');
const testRoots = ['test', 'tests'];
const testFilePattern = /\.(test|spec)\.[cm]?[jt]sx?$/;
const logDir = process.env.LEXFLOW_SEEDED_LOG_DIR
  ? path.resolve(process.env.LEXFLOW_SEEDED_LOG_DIR)
  : null;

if (logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  console.log(`Writing seeded suite logs to ${logDir}`);
}

function collectTestFiles(directory) {
  if (!fs.existsSync(directory)) return [];

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? collectTestFiles(entryPath)
      : testFilePattern.test(entry.name) ? [entryPath] : [];
  });
}

const testFiles = testRoots
  .flatMap(root => collectTestFiles(path.join(serverDir, root)))
  .sort((left, right) => left.localeCompare(right));

if (testFiles.length === 0) {
  console.error('No seeded backend test suites were found.');
  process.exit(1);
}

const failures = [];
console.log(`Running ${testFiles.length} seeded backend suites in isolated Jest processes.`);

for (const [index, testFile] of testFiles.entries()) {
  const relativeTestFile = path.relative(serverDir, testFile);
  console.log(`\n[${index + 1}/${testFiles.length}] ${relativeTestFile}`);

  const result = spawnSync(
    process.execPath,
    [jestBin, '--runInBand', '--runTestsByPath', testFile],
    {
      cwd: serverDir,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  let failureLog;
  if (result.error || result.status !== 0) {
    if (logDir) {
      const safeName = relativeTestFile.replace(/[\\/:"*?<>|]+/g, '_');
      failureLog = path.join(logDir, `${safeName}.log`);
      fs.writeFileSync(
        failureLog,
        [
          `Suite: ${relativeTestFile}`,
          `Exit status: ${result.status}`,
          result.error ? `Spawn error: ${result.error.stack || result.error.message}` : '',
          '\n--- STDOUT ---\n',
          result.stdout || '',
          '\n--- STDERR ---\n',
          result.stderr || '',
        ].join('\n'),
      );
    }
  }

  if (result.error) {
    console.error(`Unable to run ${relativeTestFile}: ${result.error.message}`);
    failures.push({ testFile: relativeTestFile, logPath: failureLog });
  } else if (result.status !== 0) {
    failures.push({ testFile: relativeTestFile, logPath: failureLog });
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} seeded backend suite(s) failed:`);
  failures.forEach(({ testFile, logPath }) => {
    console.error(`- ${testFile}${logPath ? ` (full log: ${logPath})` : ''}`);
  });
  process.exit(1);
}

console.log(`\nAll ${testFiles.length} seeded backend suites passed.`);
