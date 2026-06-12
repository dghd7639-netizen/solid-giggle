const assert = require("node:assert/strict");
const test = require("node:test");

const { buildUndoRestoreState, createIdleRuntime, buildStopQueueRuntime } = require("../background");

test("undo restore keeps explicit settings and popup draft snapshots", () => {
  const patch = buildUndoRestoreState({
    tasks: [],
    logs: [{ id: "log_1", message: "old" }],
    runtime: { mode: "idle" },
    settings: { fixedIntervalSec: 42 },
    popupDraft: { promptText: "一只小猫" }
  });

  assert.equal(patch.settings.fixedIntervalSec, 42);
  assert.equal(patch.popupDraft.promptText, "一只小猫");
  assert.equal(patch.runtime.mode, "idle");
});

test("undo restore converts a previously running snapshot into a safe paused queue", () => {
  const patch = buildUndoRestoreState({
    tasks: [
      { id: "task_running", status: "running", filename: "image_001", sequenceNumber: 1 },
      { id: "task_waiting", status: "waiting", filename: "image_002", sequenceNumber: 2 }
    ],
    logs: [],
    runtime: {
      mode: "running",
      currentTaskId: "task_running",
      activeTabId: 123,
      targetTabId: 123,
      stopRequested: false
    },
    settings: {},
    popupDraft: {}
  });

  assert.equal(patch.runtime.mode, "paused");
  assert.equal(patch.runtime.currentTaskId, null);
  assert.equal(patch.runtime.activeTabId, null);
  assert.equal(patch.runtime.targetTabId, null);
  assert.equal(patch.tasks[0].status, "pending");
  assert.equal(patch.tasks[1].status, "waiting");
});

test("createIdleRuntime clears transient runtime fields", () => {
  const runtime = createIdleRuntime({
    mode: "running",
    currentTaskId: "task_1",
    activeTabId: 12,
    targetTabId: 13,
    lastScheduleAt: 100,
    stopRequested: true,
    pausedUntil: 200,
    pauseReason: "cooldown",
    currentTaskStartedAt: 300
  });

  assert.deepEqual(runtime, {
    mode: "idle",
    currentTaskId: null,
    activeTabId: null,
    targetTabId: null,
    lastScheduleAt: null,
    stopRequested: false,
    pausedUntil: null,
    pauseReason: "",
    currentTaskStartedAt: null
  });
});

test("buildStopQueueRuntime stays fully idle when no task is active", () => {
  const runtime = buildStopQueueRuntime({
    mode: "paused",
    currentTaskId: null,
    activeTabId: 12,
    targetTabId: 13,
    lastScheduleAt: 100,
    stopRequested: false,
    pausedUntil: 200,
    pauseReason: "manual",
    currentTaskStartedAt: 300
  });

  assert.equal(runtime.mode, "idle");
  assert.equal(runtime.stopRequested, false);
  assert.equal(runtime.currentTaskStartedAt, null);
});
