const assert = require("node:assert/strict");
const test = require("node:test");

const { createBackgroundStateHelpers } = require("../background-state");

test("background-state exposes runtime helpers and undo snapshot creator", () => {
  assert.equal(typeof createBackgroundStateHelpers, "function");

  const helpers = createBackgroundStateHelpers({
    QUEUE_MODE: {
      IDLE: "idle",
      STOPPING: "stopping"
    },
    STORAGE_KEYS: {
      UNDO_STACK: "undoStack"
    },
    DEFAULT_RUNTIME: {
      mode: "idle"
    },
    DEFAULT_SETTINGS: {
      fixedIntervalSec: 25
    },
    UNDO_LIMIT: 3,
    generateId: () => "undo_1",
    now: () => 123,
    setState: async () => {},
    cloneForStorage: (value) => JSON.parse(JSON.stringify(value))
  });

  assert.equal(typeof helpers.createIdleRuntime, "function");
  assert.equal(typeof helpers.buildStopQueueRuntime, "function");
  assert.equal(typeof helpers.buildUndoRestoreState, "function");
  assert.equal(typeof helpers.saveUndoSnapshot, "function");
});

test("background-state saveUndoSnapshot stores newest snapshot first", async () => {
  const writes = [];
  const helpers = createBackgroundStateHelpers({
    QUEUE_MODE: {
      IDLE: "idle",
      STOPPING: "stopping"
    },
    STORAGE_KEYS: {
      UNDO_STACK: "undoStack"
    },
    DEFAULT_RUNTIME: {
      mode: "idle"
    },
    DEFAULT_SETTINGS: {
      fixedIntervalSec: 25
    },
    UNDO_LIMIT: 2,
    generateId: () => "undo_new",
    now: () => 456,
    setState: async (patch) => {
      writes.push(patch);
    },
    cloneForStorage: (value) => JSON.parse(JSON.stringify(value))
  });

  await helpers.saveUndoSnapshot("测试动作", {
    tasks: [{ id: "task_1" }],
    logs: [{ id: "log_1" }],
    runtime: { mode: "idle" },
    settings: { fixedIntervalSec: 99 },
    popupDraft: { promptText: "一只小猫" },
    undoStack: [{ id: "undo_old" }]
  });

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    undoStack: [
      {
        id: "undo_new",
        action: "测试动作",
        createdAt: 456,
        tasks: [{ id: "task_1" }],
        logs: [{ id: "log_1" }],
        runtime: { mode: "idle" },
        settings: { fixedIntervalSec: 99 },
        popupDraft: { promptText: "一只小猫" }
      },
      { id: "undo_old" }
    ]
  });
});
