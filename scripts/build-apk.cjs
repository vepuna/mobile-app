const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectDir = path.resolve(__dirname, '..');
const outputDir = path.join(projectDir, 'artifacts');
const outputApkPath = path.join(outputDir, 'tutor-assistant-preview.apk');
const buildUrlPattern = /\/builds\/([0-9a-f-]{36})/i;

function resolveEasCliInvocation() {
  const jsEntryCandidates = [
    path.join(projectDir, 'node_modules', 'eas-cli', 'bin', 'run'),
    path.join(projectDir, 'node_modules', 'eas-cli', 'bin', 'run.js'),
  ];

  const jsEntry = jsEntryCandidates.find(candidate => fs.existsSync(candidate));
  if (jsEntry) {
    return {
      command: process.execPath,
      prefixArgs: [jsEntry],
    };
  }

  const binCandidates = process.platform === 'win32'
    ? [
        path.join(projectDir, 'node_modules', '.bin', 'eas.cmd'),
        path.join(projectDir, 'node_modules', '.bin', 'eas-cli.cmd'),
      ]
    : [
        path.join(projectDir, 'node_modules', '.bin', 'eas'),
        path.join(projectDir, 'node_modules', '.bin', 'eas-cli'),
      ];

  const binPath = binCandidates.find(candidate => fs.existsSync(candidate));
  if (binPath) {
    return {
      command: binPath,
      prefixArgs: [],
    };
  }

  return null;
}

function ensureEasCliInstalled() {
  const easCliInvocation = resolveEasCliInvocation();

  if (!easCliInvocation) {
    throw new Error('Local eas-cli was not found. Run npm install and try again.');
  }

  return easCliInvocation;
}

function spawnAndMirror(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectDir,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: false,
      windowsHide: false,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('error', error => {
      const wrapped = new Error(`Failed to start command: ${command} ${args.join(' ')}`);
      wrapped.cause = error;
      reject(wrapped);
    });
    child.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(`Command failed with exit code ${code}.`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function extractBuildId(output) {
  const match = output.match(buildUrlPattern);
  return match ? match[1] : null;
}

function parseJsonOutput(rawOutput, description) {
  try {
    return JSON.parse(rawOutput.trim());
  } catch {
    throw new Error(`Could not parse ${description} JSON output.`);
  }
}

async function main() {
  const easCli = ensureEasCliInstalled();

  console.log('Starting Android APK build on EAS...');
  const buildResult = await spawnAndMirror(easCli.command, [
    ...easCli.prefixArgs,
    'build',
    '-p',
    'android',
    '--profile',
    'preview',
    '--wait',
  ]);
  const buildId = extractBuildId(`${buildResult.stdout}\n${buildResult.stderr}`);

  if (!buildId) {
    throw new Error('The build finished, but the EAS build id could not be detected from CLI output.');
  }

  console.log(`Downloading APK for build ${buildId}...`);
  const downloadResult = await spawnAndMirror(easCli.command, [
    ...easCli.prefixArgs,
    'build:download',
    '--build-id',
    buildId,
    '--json',
  ]);
  const downloadJson = parseJsonOutput(downloadResult.stdout, 'download');
  const downloadedPath = downloadJson.path;

  if (!downloadedPath || !fs.existsSync(downloadedPath)) {
    throw new Error('EAS download completed, but the APK file path was not returned.');
  }

  fs.mkdirSync(outputDir, { recursive: true });
  fs.copyFileSync(downloadedPath, outputApkPath);

  console.log(`APK saved to ${outputApkPath}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});