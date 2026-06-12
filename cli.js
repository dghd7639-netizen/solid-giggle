#!/usr/bin/env node

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SOCKET_PATH = process.env.BATCH_IMAGE_SOCKET || "/tmp/cgbi.sock";

function parseArgs(argv) {
  const [rawCommand, ...rest] = argv;
  if (!rawCommand || rawCommand === "help" || rawCommand === "--help" || rawCommand === "-h") {
    return { command: "help", payload: {} };
  }

  if (rawCommand === "status") {
    assertNoExtra(rest, "status");
    return { command: "status", payload: {} };
  }

  if (
    rawCommand === "pause" ||
    rawCommand === "resume" ||
    rawCommand === "clear-draft" ||
    rawCommand === "undo" ||
    rawCommand === "stop" ||
    rawCommand === "clear-completed" ||
    rawCommand === "clear-failed" ||
    rawCommand === "clear-all" ||
    rawCommand === "clear-logs"
  ) {
    assertNoExtra(rest, rawCommand);
    return { command: rawCommand, payload: {} };
  }

  if (rawCommand === "delete") {
    return {
      command: "delete-task",
      payload: parseDeletePayload(rest)
    };
  }

  if (rawCommand === "update-sequence") {
    return {
      command: "update-task-sequence",
      payload: parseUpdateSequencePayload(rest)
    };
  }

  if (rawCommand === "start") {
    return {
      command: "start",
      payload: parseStartPayload(rest)
    };
  }

  if (rawCommand === "import") {
    return {
      command: "import-prompts",
      payload: parseImportPayload(rest)
    };
  }

  if (rawCommand === "update-settings") {
    return {
      command: "update-settings",
      payload: parseSettingsPayload(rest)
    };
  }

  throw new Error(`Unknown command: ${rawCommand}`);
}

function parseStartPayload(args) {
  const payload = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--timeout-total") {
      payload.timeoutTotalSec = parsePositiveNumber(args[++index], arg);
    } else if (arg === "--timeout-busy") {
      payload.timeoutBusySec = parseNonNegativeNumber(args[++index], arg);
    } else {
      throw new Error(`Unknown start option: ${arg}`);
    }
  }
  return payload;
}

function parseImportPayload(args) {
  const prompts = [];
  let draftPolicy = "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--prompt") {
      const value = args[++index];
      if (!value) {
        throw new Error("--prompt requires a value");
      }
      prompts.push(value);
    } else if (arg === "--file") {
      const file = args[++index];
      if (!file) {
        throw new Error("--file requires a path");
      }
      prompts.push(...readImportFile(file));
    } else if (arg === "--replace-draft") {
      draftPolicy = mergeDraftPolicy(draftPolicy, "replace");
    } else if (arg === "--keep-draft") {
      draftPolicy = mergeDraftPolicy(draftPolicy, "keep");
    } else {
      throw new Error(`Unknown import option: ${arg}`);
    }
  }

  if (!prompts.length) {
    throw new Error("import requires --prompt or --file");
  }

  return {
    prompts,
    ...(draftPolicy ? { draftPolicy } : {})
  };
}

function mergeDraftPolicy(currentPolicy, nextPolicy) {
  if (!currentPolicy) {
    return nextPolicy;
  }
  if (currentPolicy !== nextPolicy) {
    throw new Error("Choose only one draft policy: --replace-draft or --keep-draft");
  }
  return currentPolicy;
}

function parseDeletePayload(args) {
  let taskId = "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--task-id") {
      taskId = args[++index];
      if (!taskId) {
        throw new Error("--task-id requires a value");
      }
    } else {
      throw new Error(`Unknown delete option: ${arg}`);
    }
  }

  if (!taskId) {
    throw new Error("--task-id requires a value");
  }

  return { taskId };
}

function parseUpdateSequencePayload(args) {
  let taskId = "";
  let sequenceNumber = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--task-id") {
      taskId = args[++index];
      if (!taskId) {
        throw new Error("--task-id requires a value");
      }
    } else if (arg === "--sequence-number") {
      sequenceNumber = parsePositiveInteger(args[++index], arg);
    } else {
      throw new Error(`Unknown update-sequence option: ${arg}`);
    }
  }

  if (!taskId) {
    throw new Error("--task-id requires a value");
  }
  if (!sequenceNumber) {
    throw new Error("--sequence-number requires a value");
  }

  return { taskId, sequenceNumber };
}

function parseSettingsPayload(args) {
  let settings = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      settings = parseSettingsJson(args[++index], arg);
    } else if (arg === "--file") {
      const file = args[++index];
      if (!file) {
        throw new Error("--file requires a path");
      }
      settings = parseSettingsJson(fs.readFileSync(file, "utf8"), arg);
    } else {
      throw new Error(`Unknown update-settings option: ${arg}`);
    }
  }

  if (!settings) {
    throw new Error("update-settings requires --json or --file");
  }

  return { settings };
}

function parseSettingsJson(value, flag) {
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON for ${flag}: ${error.message || error}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${flag} must describe a JSON object`);
  }

  return parsed;
}

function parsePositiveNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Invalid number for ${flag}: ${value}`);
  }
  return number;
}

function parsePositiveInteger(value, flag) {
  const number = parsePositiveNumber(value, flag);
  if (!Number.isInteger(number)) {
    throw new Error(`Invalid integer for ${flag}: ${value}`);
  }
  return number;
}

function parseNonNegativeNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Invalid number for ${flag}: ${value}`);
  }
  return number;
}

function readImportFile(file) {
  const content = fs.readFileSync(file, "utf8");
  if (path.extname(file).toLowerCase() === ".json") {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) {
      throw new Error("JSON import file must contain an array");
    }
    return parsed;
  }

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function assertNoExtra(args, command) {
  if (args.length) {
    throw new Error(`${command} does not accept arguments`);
  }
}

function sendCommand(request, socketPath = SOCKET_PATH) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let buffer = "";

    client.setEncoding("utf8");
    client.on("connect", () => {
      client.write(`${JSON.stringify(request)}\n`);
    });
    client.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      client.end();
      try {
        const response = JSON.parse(line);
        if (response.ok === false) {
          reject(new Error(response.error || "Command failed"));
          return;
        }
        resolve(response);
      } catch (error) {
        reject(error);
      }
    });
    client.on("error", (error) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        reject(new Error(`Native host socket is not available at ${socketPath}. Open Chrome and reload the extension.`));
        return;
      }
      reject(error);
    });
  });
}

function printHelp() {
  console.log(`Usage:
  node cli.js status
  node cli.js import --prompt "prompt text"
  node cli.js import --prompt "prompt text" --replace-draft
  node cli.js import --prompt "prompt text" --keep-draft
  node cli.js import --file prompts.txt
  node cli.js import --file prompts.txt --replace-draft
  node cli.js import --file prompts.txt --keep-draft
  node cli.js import --file tasks.json
  node cli.js start
  node cli.js start --timeout-total 300
  node cli.js start --timeout-total 300 --timeout-busy 90
  node cli.js delete --task-id task_123
  node cli.js update-sequence --task-id task_123 --sequence-number 12
  node cli.js clear-completed
  node cli.js clear-failed
  node cli.js clear-all
  node cli.js clear-logs
  node cli.js clear-draft
  node cli.js pause
  node cli.js resume
  node cli.js undo
  node cli.js update-settings --json '{"debugMode":true}'
  node cli.js update-settings --file settings.json
  node cli.js stop`);
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.command === "help") {
    printHelp();
    return;
  }

  const response = await sendCommand({
    command: parsed.command,
    payload: parsed.payload
  });
  console.log(JSON.stringify(response.result || response, null, 2));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  sendCommand
};
