const assert = require("node:assert/strict");
const test = require("node:test");

const { buildImportedTasks, pickNextRunnableTask } = require("../background");
const { resetTaskForRetry } = require("../shared");

const settings = {
  filenamePrefix: "image",
  downloadSubfolder: "chatgpt-images"
};

test("buildImportedTasks assigns one shared batch to every task in the same import", () => {
  const tasks = buildImportedTasks(["一只小猫", "一只小狗"], [], settings, {
    createBatchId: () => "batch_a",
    getNow: () => 1000
  });

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].batchId, "batch_a");
  assert.equal(tasks[1].batchId, "batch_a");
  assert.equal(tasks[0].batchCreatedAt, 1000);
  assert.equal(tasks[1].batchCreatedAt, 1000);
});

test("a later import creates a distinct second batch", () => {
  const firstBatchTasks = buildImportedTasks(["一只小猫"], [], settings, {
    createBatchId: () => "batch_1",
    getNow: () => 1000
  });
  const secondBatchTasks = buildImportedTasks(["一只小狗"], firstBatchTasks, settings, {
    createBatchId: () => "batch_2",
    getNow: () => 2000
  });

  assert.equal(firstBatchTasks[0].batchId, "batch_1");
  assert.equal(secondBatchTasks[0].batchId, "batch_2");
  assert.notEqual(firstBatchTasks[0].batchId, secondBatchTasks[0].batchId);
  assert.equal(secondBatchTasks[0].batchCreatedAt, 2000);
});

test("later imports keep advancing sequence numbers even if earlier tasks were deleted", () => {
  const importedTasks = buildImportedTasks(
    ["一只小狗"],
    [
      {
        id: "kept_task",
        filename: "image_old_001",
        sequenceNumber: 1,
        createdAt: 1000,
        status: "pending"
      },
      {
        id: "later_task",
        filename: "image_old_003",
        sequenceNumber: 3,
        createdAt: 3000,
        status: "pending"
      }
    ],
    settings,
    {
      createBatchId: () => "batch_2",
      getNow: () => 4000
    }
  );

  assert.equal(importedTasks[0].sequenceNumber, 4);
  assert.match(importedTasks[0].filename, /_004$/);
});

test("later batch does not run while earlier batch still has open tasks", () => {
  const decision = pickNextRunnableTask(
    [
      {
        id: "early_waiting",
        batchId: "batch_1",
        batchCreatedAt: 1000,
        createdAt: 1000,
        status: "waiting",
        readyAt: 1500
      },
      {
        id: "late_pending",
        batchId: "batch_2",
        batchCreatedAt: 2000,
        createdAt: 2000,
        status: "pending",
        readyAt: null
      }
    ],
    1200
  );

  assert.equal(decision.task, null);
  assert.equal(decision.activeBatchId, "batch_1");
  assert.equal(decision.nextWakeAt, 1500);
});

test("once the earlier batch is terminal the next batch becomes eligible", () => {
  const decision = pickNextRunnableTask(
    [
      {
        id: "early_done",
        batchId: "batch_1",
        batchCreatedAt: 1000,
        createdAt: 1000,
        status: "downloaded",
        readyAt: null
      },
      {
        id: "late_pending",
        batchId: "batch_2",
        batchCreatedAt: 2000,
        createdAt: 2000,
        status: "pending",
        readyAt: null
      }
    ],
    1200
  );

  assert.equal(decision.activeBatchId, "batch_2");
  assert.equal(decision.nextWakeAt, null);
  assert.equal(decision.task && decision.task.id, "late_pending");
});

test("active batch with only waiting tasks exposes the earliest wake time", () => {
  const decision = pickNextRunnableTask(
    [
      {
        id: "early_wait_2",
        batchId: "batch_1",
        batchCreatedAt: 1000,
        createdAt: 1100,
        status: "waiting",
        readyAt: 2200
      },
      {
        id: "early_wait_1",
        batchId: "batch_1",
        batchCreatedAt: 1000,
        createdAt: 1000,
        status: "waiting",
        readyAt: 1800
      },
      {
        id: "late_pending",
        batchId: "batch_2",
        batchCreatedAt: 2000,
        createdAt: 2000,
        status: "pending",
        readyAt: null
      }
    ],
    1200
  );

  assert.equal(decision.task, null);
  assert.equal(decision.activeBatchId, "batch_1");
  assert.equal(decision.nextWakeAt, 1800);
});

test("legacy unbatched open tasks still run before later batched imports", () => {
  const decision = pickNextRunnableTask(
    [
      {
        id: "legacy_pending",
        createdAt: 900,
        status: "pending",
        readyAt: null
      },
      {
        id: "batched_pending",
        batchId: "batch_1",
        batchCreatedAt: 1000,
        createdAt: 1000,
        status: "pending",
        readyAt: null
      }
    ],
    1200
  );

  assert.equal(decision.task && decision.task.id, "legacy_pending");
  assert.equal(decision.nextWakeAt, null);
  assert.equal(decision.activeBatchId, "");
});

test("retry keeps a task in its original batch and still blocks later batches", () => {
  const retriedTask = resetTaskForRetry({
    id: "batch_1_failed",
    batchId: "batch_1",
    batchCreatedAt: 1000,
    createdAt: 1000,
    filename: "image_001",
    prompt: "一只小猫",
    status: "failed",
    retries: 1,
    readyAt: null,
    lastError: "boom",
    imageCount: 1,
    downloads: {
      items: [],
      total: 0,
      completed: 0,
      failed: 0
    }
  });

  const decision = pickNextRunnableTask(
    [
      retriedTask,
      {
        id: "batch_2_pending",
        batchId: "batch_2",
        batchCreatedAt: 2000,
        createdAt: 2000,
        status: "pending",
        readyAt: null
      }
    ],
    1200
  );

  assert.equal(retriedTask.batchId, "batch_1");
  assert.equal(retriedTask.batchCreatedAt, 1000);
  assert.equal(decision.activeBatchId, "batch_1");
  assert.equal(decision.task && decision.task.id, "batch_1_failed");
});

test("deleting the last open task from batch one unlocks batch two", () => {
  const tasks = [
    {
      id: "batch_1_pending",
      batchId: "batch_1",
      batchCreatedAt: 1000,
      createdAt: 1000,
      status: "pending",
      readyAt: null
    },
    {
      id: "batch_2_pending",
      batchId: "batch_2",
      batchCreatedAt: 2000,
      createdAt: 2000,
      status: "pending",
      readyAt: null
    }
  ];

  const beforeDelete = pickNextRunnableTask(tasks, 1200);
  const afterDelete = pickNextRunnableTask(
    tasks.filter((task) => task.id !== "batch_1_pending"),
    1200
  );

  assert.equal(beforeDelete.activeBatchId, "batch_1");
  assert.equal(beforeDelete.task && beforeDelete.task.id, "batch_1_pending");
  assert.equal(afterDelete.activeBatchId, "batch_2");
  assert.equal(afterDelete.task && afterDelete.task.id, "batch_2_pending");
});
