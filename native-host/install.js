#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOST_NAME = "com.chatgpt_batch_image_generator.cli";
const HOST_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Google",
  "Chrome",
  "NativeMessagingHosts"
);
const HOST_MANIFEST_PATH = path.join(HOST_DIR, `${HOST_NAME}.json`);
const RUNNER_DIR = path.join(os.homedir(), ".chatgpt-batch-image-native-host");

function parseInstallArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--extension-id") {
      result.extensionId = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return result;
}

function validateExtensionId(extensionId) {
  if (!/^[a-p]{32}$/.test(extensionId || "")) {
    throw new Error("Extension ID must be 32 lowercase letters from a to p");
  }
}

function install(extensionId) {
  validateExtensionId(extensionId);
  fs.mkdirSync(HOST_DIR, { recursive: true });
  fs.mkdirSync(RUNNER_DIR, { recursive: true });

  const runnerPath = path.join(RUNNER_DIR, "run-host.sh");
  const nodePath = process.execPath;
  fs.writeFileSync(
    runnerPath,
    `#!/bin/sh\nexec "${nodePath}" "${path.join(__dirname, "index.js")}"\n`
  );
  fs.chmodSync(runnerPath, 0o755);

  const manifest = {
    name: HOST_NAME,
    description: "CLI bridge for ChatGPT Batch Image Generator",
    path: runnerPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`]
  };

  fs.writeFileSync(HOST_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.chmodSync(path.join(__dirname, "index.js"), 0o755);
  fs.chmodSync(path.join(__dirname, "..", "cli.js"), 0o755);
  return HOST_MANIFEST_PATH;
}

function printHelp() {
  console.log(`Usage:
  node native-host/install.js --extension-id <chrome extension id>`);
}

if (require.main === module) {
  try {
    const args = parseInstallArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
    } else {
      const installedPath = install(args.extensionId);
      console.log(`Installed native host manifest: ${installedPath}`);
    }
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  install,
  parseInstallArgs,
  validateExtensionId
};
