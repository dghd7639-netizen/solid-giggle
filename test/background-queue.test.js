const assert = require("node:assert/strict");
const test = require("node:test");

const { createBackgroundQueueHelpers } = require("../background-queue");

test("background-queue exposes prompt and task selection helpers", () => {
  assert.equal(typeof createBackgroundQueueHelpers, "function");

  const helpers = createBackgroundQueueHelpers({
    TASK_STATUS: {
      PENDING: "pending",
      WAITING: "waiting",
      RUNNING: "running",
      FAILED: "failed",
      STOPPED: "stopped",
      SUCCESS: "success",
      DOWNLOADED: "downloaded"
    },
    createTaskFromInput: (input) => ({
      prompt: input.prompt || input,
      sequenceNumber: input.sequenceNumber,
      filename: `image_${String(input.sequenceNumber).padStart(3, "0")}`,
      batchId: input.batchId,
      batchCreatedAt: input.batchCreatedAt,
      status: "pending"
    }),
    getNextTaskSequenceNumber: () => 7,
    getEarliestOpenBatchId: () => "batch_1",
    generateId: () => "batch_1",
    now: () => 1000
  });

  assert.equal(typeof helpers.normalizePromptInputs, "function");
  assert.equal(typeof helpers.buildImportedTasks, "function");
  assert.equal(typeof helpers.pickNextRunnableTask, "function");
  assert.equal(typeof helpers.resolveImportDraftPlan, "function");
});

test("background-queue buildImportedTasks assigns shared batch metadata and advancing sequence numbers", () => {
  const helpers = createBackgroundQueueHelpers({
    TASK_STATUS: {
      PENDING: "pending",
      WAITING: "waiting",
      RUNNING: "running",
      FAILED: "failed",
      STOPPED: "stopped",
      SUCCESS: "success",
      DOWNLOADED: "downloaded"
    },
    createTaskFromInput: (input) => ({
      prompt: input.prompt || input,
      sequenceNumber: input.sequenceNumber,
      filename: `image_${String(input.sequenceNumber).padStart(3, "0")}`,
      batchId: input.batchId,
      batchCreatedAt: input.batchCreatedAt,
      status: "pending"
    }),
    getNextTaskSequenceNumber: () => 7,
    getEarliestOpenBatchId: () => "batch_1",
    generateId: () => "batch_new",
    now: () => 2222
  });

  const tasks = helpers.buildImportedTasks(["一只小猫", "一只小狗"], [], {});

  assert.deepEqual(
    tasks.map((task) => ({
      prompt: task.prompt,
      sequenceNumber: task.sequenceNumber,
      batchId: task.batchId,
      batchCreatedAt: task.batchCreatedAt
    })),
    [
      {
        prompt: "一只小猫",
        sequenceNumber: 7,
        batchId: "batch_new",
        batchCreatedAt: 2222
      },
      {
        prompt: "一只小狗",
        sequenceNumber: 8,
        batchId: "batch_new",
        batchCreatedAt: 2222
      }
    ]
  );
});
