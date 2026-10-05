#!/usr/bin/env node
// macOS CLI that runs REV Hardware Client's OS and firmware update steps for the
// Driver Hub, Control Hub, and Expansion Hub. The steps come from the main process
// of REV Hardware Client 1.7.6 (resources/app.asar, main.js). Needs no Wine,
// CrossOver, or Electron.
//
// Protocol
//   1. `adb devices` finds the device over USB. getprop gives the device type.
//        adb -s <id> shell getprop persist.ftcandroid.serialasusb   "true" means Control Hub
//        adb -s <id> shell getprop persist.rds                      "true" means Driver Hub
//   2. adb forwards two local TCP ports to the device's web server.
//        adb -s <id> forward tcp:<P>   tcp:8080   (HTTP control API)
//        adb -s <id> forward tcp:<P+1> tcp:8081   (WebSocket, unused here)
//   3. REV's public manifest names the update file
//      (https://www.revrobotics.com/content/sw/rev-hw-client/main.json, then the
//      RevHub plugin JSON). The tool downloads it over HTTPS and checks its SHA-256.
//   4. The tool POSTs the file as multipart/form-data to the device's REST API.
//        POST /uploadDriverHubOta        (Driver Hub OS update)
//        POST /uploadControlHubOta       (Control Hub OS update)
//        POST /uploadExpansionHubFirmware, then POST /performRevFirmwareUpdate
//                                         (firmware for the Control Hub itself or for
//                                          a connected Expansion Hub, chosen by serial)
//
// This path uses no native Windows binaries.
//
// Usage
//   ./rev-hardware-client.mjs list
//   ./rev-hardware-client.mjs update driver-hub-os   [--adb-id <id>]
//   ./rev-hardware-client.mjs update control-hub-os  [--adb-id <id>]
//   ./rev-hardware-client.mjs update hub-firmware    [--adb-id <id>] [--serial "(embedded)"]
//   ./rev-hardware-client.mjs discover-hubs          [--adb-id <id>]   # list serials for hub-firmware
//
// `update` prints what it would send and contacts the hub only when given --yes.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const MAIN_JSON_URL =
  'https://www.revrobotics.com/content/sw/rev-hw-client/main.json';
const CACHE_DIR = path.join(homedir(), '.rhc-mac-tool');
const DOWNLOADS_DIR = path.join(CACHE_DIR, 'downloads');

const UPLOAD_URI = {
  'control-hub-os': '/uploadControlHubOta',
  'driver-hub-os': '/uploadDriverHubOta',
  'hub-firmware': '/uploadExpansionHubFirmware',
};

function log(...args) {
  console.log(...args);
}

function die(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function adb(args, { adbId } = {}) {
  const fullArgs = adbId ? ['-s', adbId, ...args] : args;
  try {
    return execFileSync('adb', fullArgs, { encoding: 'utf8' });
  } catch (e) {
    die(`adb ${fullArgs.join(' ')} failed: ${e.stderr || e.message}`);
  }
}

function checkAdbAvailable() {
  try {
    execFileSync('adb', ['version'], { stdio: 'ignore' });
  } catch {
    die(
      'adb not found on PATH. Install it with: brew install android-platform-tools',
    );
  }
}

function listAdbDevices() {
  const output = adb(['devices']);
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('*'))
    .map((line) => line.split(/\s+/))
    .filter(([, state]) => state === 'device')
    .map(([id]) => id);
}

function getprop(adbId, key) {
  return adb(['shell', `getprop ${key}`], { adbId }).trim();
}

function identifyDevice(adbId) {
  const isControlHub =
    getprop(adbId, 'persist.ftcandroid.serialasusb') === 'true';
  const isDriverHub = getprop(adbId, 'persist.rds') === 'true';
  if (isControlHub) return 'control-hub';
  if (isDriverHub) return 'driver-hub';
  return 'unknown';
}

async function findFreePortPair() {
  const tryPort = (port) =>
    new Promise((resolve) => {
      const srv = createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
  for (let port = 15000; port < 15100; port += 2) {
    if ((await tryPort(port)) && (await tryPort(port + 1))) {
      return port;
    }
  }
  die('Could not find a free local port pair for adb forward');
}

async function forwardPorts(adbId) {
  const port = await findFreePortPair();
  adb(['forward', `tcp:${port}`, 'tcp:8080'], { adbId });
  adb(['forward', `tcp:${port + 1}`, 'tcp:8081'], { adbId });
  log(`Forwarded 127.0.0.1:${port} -> device:8080 (and ${port + 1} -> 8081)`);
  return port;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) die(`GET ${url} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function getRevHubPluginUrl() {
  const mainJson = await fetchJson(MAIN_JSON_URL);
  const plugin = mainJson.plugins.find((p) => p.name === 'RevHub');
  if (!plugin) die('RevHub plugin entry not found in main.json');
  return plugin.url;
}

async function getLatestSoftwareInfo(permanentSoftwareName) {
  const pluginUrl = await getRevHubPluginUrl();
  const pluginJson = await fetchJson(pluginUrl);
  const entry = pluginJson.latestSoftware.find(
    (sw) => sw.permanentSoftwareName === permanentSoftwareName,
  );
  if (!entry) die(`No latest version found for ${permanentSoftwareName}`);
  return entry;
}

async function downloadAndVerify(softwareInfo) {
  mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const fileName = `${softwareInfo.permanentSoftwareName}-${softwareInfo.versionString}${path.extname(
    new URL(softwareInfo.url).pathname,
  )}`;
  const filePath = path.join(DOWNLOADS_DIR, fileName);

  if (
    existsSync(filePath) &&
    sha256Of(filePath) === softwareInfo.sha256.toLowerCase()
  ) {
    log(`Using cached, checksum-verified file: ${filePath}`);
    return filePath;
  }

  log(`Downloading ${softwareInfo.url} ...`);
  const res = await fetch(softwareInfo.url);
  if (!res.ok) die(`Download failed: ${res.status} ${res.statusText}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(filePath, buffer);

  const actualSha256 = sha256Of(filePath);
  if (actualSha256 !== softwareInfo.sha256.toLowerCase()) {
    die(
      `Checksum mismatch for ${filePath}\n  expected: ${softwareInfo.sha256}\n  actual:   ${actualSha256}`,
    );
  }
  log(`Downloaded and verified: ${filePath}`);
  return filePath;
}

function sha256Of(filePath) {
  return createHash('sha256')
    .update(readFileSync(filePath))
    .digest('hex')
    .toLowerCase();
}

// Minimal multipart/form-data encoder, so the tool needs no npm dependencies.
export function buildMultipartBody(fields, fileField) {
  const boundary = `----rhcmac${Date.now().toString(16)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  if (fileField) {
    const { name, filename, data } = fileField;
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
    );
    parts.push(data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function postMultipart(port, uploadPath, fields, fileField) {
  const { body, contentType } = buildMultipartBody(fields, fileField);
  const res = await fetch(`http://127.0.0.1:${port}${uploadPath}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });
  const text = await res.text();
  if (!res.ok) die(`POST ${uploadPath} failed: ${res.status} ${text}`);
  return text;
}

async function getHubJson(port, hubPath, timeoutMs = 6000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/${hubPath}`, {
      signal: controller.signal,
    });
    if (!res.ok) return void 0;
    return await res.json();
  } catch {
    return void 0;
  } finally {
    clearTimeout(timeout);
  }
}

async function cmdList() {
  checkAdbAvailable();
  const ids = listAdbDevices();
  if (ids.length === 0) {
    log('No ADB devices found. Plug in a Driver Hub or Control Hub over USB.');
    return;
  }
  for (const id of ids) {
    const type = identifyDevice(id);
    log(`${id}\t${type}`);
  }
}

async function cmdDiscoverHubs({ adbId }) {
  checkAdbAvailable();
  const id = adbId ?? requireSingleDevice();
  const type = identifyDevice(id);
  if (type !== 'control-hub') {
    die(
      `discover-hubs only applies to a Control Hub (device ${id} is a ${type})`,
    );
  }
  const port = await forwardPorts(id);
  const modules = await getHubJson(port, 'revHubsAvailableForUpdate');
  if (!modules)
    die(
      "Could not reach the Control Hub's local API (is the Robot Controller app running?)",
    );
  log('Hubs available for firmware update:');
  for (const m of modules.modules) {
    log(
      `  serial=${m.serialNumber}\tmoduleAddress=${m.moduleAddress}\tfirmware=${m.formattedFirmwareVersionString}`,
    );
  }
}

function requireSingleDevice() {
  const ids = listAdbDevices();
  if (ids.length === 0) die('No ADB devices found.');
  if (ids.length > 1)
    die(`Multiple ADB devices found (${ids.join(', ')}). Pass --adb-id <id>.`);
  return ids[0];
}

async function cmdUpdate(permanentSoftwareName, { adbId, serial, yes }) {
  checkAdbAvailable();
  if (!UPLOAD_URI[permanentSoftwareName]) {
    die(`Unknown update target: ${permanentSoftwareName}`);
  }
  const id = adbId ?? requireSingleDevice();
  const type = identifyDevice(id);
  log(`Device ${id} identified as: ${type}`);

  if (permanentSoftwareName === 'driver-hub-os' && type !== 'driver-hub') {
    die(
      `driver-hub-os update requires a Driver Hub (device ${id} is a ${type})`,
    );
  }
  if (
    (permanentSoftwareName === 'control-hub-os' ||
      permanentSoftwareName === 'hub-firmware') &&
    type !== 'control-hub'
  ) {
    die(
      `${permanentSoftwareName} update requires a Control Hub (device ${id} is a ${type})`,
    );
  }

  const softwareInfo = await getLatestSoftwareInfo(permanentSoftwareName);
  log(
    `Latest ${permanentSoftwareName}: version ${softwareInfo.versionString} (versionCode ${softwareInfo.versionCode})`,
  );

  const filePath = await downloadAndVerify(softwareInfo);

  if (!yes) {
    log(
      `\nDRY RUN (pass --yes to flash). Would upload ${filePath} to device ${id} ` +
        `via ${UPLOAD_URI[permanentSoftwareName]}` +
        (permanentSoftwareName === 'hub-firmware'
          ? ` and trigger performRevFirmwareUpdate for serial=${serial ?? '(embedded)'}`
          : ''),
    );
    return;
  }

  const port = await forwardPorts(id);
  const fileData = readFileSync(filePath);
  const fileName = path.basename(filePath);

  if (permanentSoftwareName === 'hub-firmware') {
    log('Uploading firmware file to Control Hub...');
    const uploadedFileName = (
      await postMultipart(
        port,
        UPLOAD_URI[permanentSoftwareName],
        { force: 'true' },
        {
          name: 'file',
          filename: fileName,
          data: fileData,
        },
      )
    ).trim();
    log(`Hub accepted upload as: ${uploadedFileName}`);
    const targetSerial = serial ?? '(embedded)';
    log(`Triggering firmware update for serial=${targetSerial} ...`);
    const response = await postMultipart(port, '/performRevFirmwareUpdate', {
      serialNumber: targetSerial,
      filename: uploadedFileName,
    });
    let json;
    try {
      json = JSON.parse(response);
    } catch {
      die(`Unexpected response from /performRevFirmwareUpdate: ${response}`);
    }
    if (json.success) {
      log(
        `Firmware update succeeded: ${permanentSoftwareName} -> ${softwareInfo.versionString}`,
      );
    } else {
      die(json.errorMessage ?? 'Firmware could not be updated');
    }
  } else {
    log(`Uploading OS update to ${type}...`);
    const response = await postMultipart(
      port,
      UPLOAD_URI[permanentSoftwareName],
      { force: 'true' },
      {
        name: 'file',
        filename: fileName,
        data: fileData,
      },
    );
    let json;
    try {
      json = JSON.parse(response);
    } catch {
      log(`Upload complete. Raw response: ${response}`);
      return;
    }
    log(`Upload complete: ${JSON.stringify(json)}`);
    log('The device will apply the update and reboot on its own.');
  }
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes') flags.yes = true;
    else if (arg === '--adb-id') flags.adbId = argv[++i];
    else if (arg === '--serial') flags.serial = argv[++i];
    else positional.push(arg);
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, target] = positional;

  switch (command) {
    case 'list':
      return cmdList();
    case 'discover-hubs':
      return cmdDiscoverHubs(flags);
    case 'update':
      if (!target)
        die('Usage: update <driver-hub-os|control-hub-os|hub-firmware>');
      return cmdUpdate(target, flags);
    default:
      log(
        'Usage:\n' +
          '  rev-hardware-client.mjs list\n' +
          '  rev-hardware-client.mjs discover-hubs [--adb-id <id>]\n' +
          '  rev-hardware-client.mjs update driver-hub-os|control-hub-os|hub-firmware [--adb-id <id>] [--serial <serial>] [--yes]\n',
      );
      process.exit(command ? 1 : 0);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => die(e.stack || e.message));
}
