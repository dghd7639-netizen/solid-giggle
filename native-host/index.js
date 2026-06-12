#!/usr/bin/env node

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const { decodeNativeMessages, encodeNativeMessage } = require("./protocol");

const SOCKET_PATH = process.env.BATCH_IMAGE_SOCKET || "/tmp/cgbi.sock";
const LOG_PATH = process.env.BATCH_IMAGE_HOST_LOG || "/tmp/cgbi-host.log";
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

let nativeBuffer = Buffer.alloc(0);
let nextRequestId = 1;
const pending = new Map();

startSocketServer();
startNativeReader();

function startSocketServer() {
  removeStaleSocket();

  const server = net.createServer((client) => {
    client.setEncoding("utf8");
    let buffer = "";

    client.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (line) {
          forwardClientRequest(client, line);
        }
      }
    });
  });

  server.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, 0o600);
    log(`socket listening at ${SOCKET_PATH}`);
  });

  server.on("error", (error) => {
    log(`socket error: ${error.message || error}`);
    process.exit(1);
  });
}

function startNativeReader() {
  process.stdin.on("data", (chunk) => {
    nativeBuffer = Buffer.concat([nativeBuffer, chunk]);
    const result = decodeNativeMessages(nativeBuffer);
    nativeBuffer = result.remainder;

    for (const message of result.messages) {
      completeClientRequest(message);
    }
  });

  process.stdin.on("end", () => {
    failAll("Extension disconnected from native host");
    cleanupSocket();
  });

  process.on("exit", cleanupSocket);
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));
}

function forwardClientRequest(client, line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    writeClient(client, { ok: false, error: `Invalid JSON: ${error.message || error}` });
    return;
  }

  const id = request.id || `cli_${Date.now()}_${nextRequestId++}`;
  const timer = setTimeout(() => {
    if (!pending.has(id)) {
      return;
    }
    pending.delete(id);
    writeClient(client, { id, ok: false, error: "Timed out waiting for extension response" });
  }, REQUEST_TIMEOUT_MS);

  pending.set(id, { client, timer });
  process.stdout.write(encodeNativeMessage(Object.assign({}, request, { id })));
}

function completeClientRequest(message) {
  const entry = pending.get(message && message.id);
  if (!entry) {
    log(`received response for unknown request: ${JSON.stringify(message)}`);
    return;
  }

  clearTimeout(entry.timer);
  pending.delete(message.id);
  writeClient(entry.client, message);
}

function writeClient(client, message) {
  client.write(`${JSON.stringify(message)}\n`, () => {
    client.end();
  });
}

function failAll(error) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    writeClient(entry.client, { id, ok: false, error });
  }
  pending.clear();
}

function removeStaleSocket() {
  try {
    if (fs.existsSync(SOCKET_PATH)) {
      fs.unlinkSync(SOCKET_PATH);
    }
  } catch (error) {
    log(`failed to remove stale socket: ${error.message || error}`);
  }
}

function cleanupSocket() {
  try {
    if (fs.existsSync(SOCKET_PATH)) {
      fs.unlinkSync(SOCKET_PATH);
    }
  } catch (error) {
    log(`failed to cleanup socket: ${error.message || error}`);
  }
}

function log(message) {
  const line = `[batch-image-native-host] ${new Date().toISOString()} ${message}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch (error) {
    process.stderr.write(`[batch-image-native-host] failed to write log: ${error.message || error}\n`);
  }
}
