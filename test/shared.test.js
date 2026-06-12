const assert = require("node:assert/strict");
const test = require("node:test");

const {
  TASK_STATUS,
  TASK_TIMEOUT_POLICY,
  createTaskFromPrompt,
  createTaskFromInput,
  normalizeTaskSequenceNumber,
  normalizeTaskSequenceNumbers,
  getNextTaskSequenceNumber,
  getEarliestOpenBatchId,
  reconcileDownloadItems,
  resetTaskForRetry,
  shouldScheduleAfterTaskResult,
  computeCooldownResumeAt
} = require("../shared");

test("waits for downloads before scheduling the next task when auto-download is enabled", () => {
  assert.equal(shouldScheduleAfterTaskResult({ autoDownload: true }, 1), false);
  assert.equal(shouldScheduleAfterTaskResult({ autoDownload: true }, 4), false);
  assert.equal(shouldScheduleAfterTaskResult({ autoDownload: false }, 1), true);
  assert.equal(shouldScheduleAfterTaskResult({ autoDownload: true }, 0), true);
});

test("retry reset preserves the original numbered filename", () => {
  const original = createTaskFromPrompt("一只小猫", 4, {
    filenamePrefix: "image",
    downloadSubfolder: "chatgpt-images"
  });
  const failedTask = Object.assign({}, original, {
    status: TASK_STATUS.FAILED,
    retries: 2,
    lastError: "download failed",
    downloads: {
      items: [{ id: 1, filename: "chatgpt-images/image_一只小猫_005.png", state: "failed" }],
      total: 1,
      completed: 0,
      failed: 1
    }
  });

  const retried = resetTaskForRetry(failedTask);

  assert.equal(retried.filename, original.filename);
  assert.equal(retried.sequenceNumber, original.sequenceNumber);
  assert.equal(retried.status, TASK_STATUS.PENDING);
  assert.equal(retried.retries, 0);
  assert.equal(retried.lastError, "");
  assert.deepEqual(retried.downloads, {
    items: [],
    total: 0,
    completed: 0,
    failed: 0
  });
  assert.equal(retried.batchId, failedTask.batchId);
  assert.equal(retried.batchCreatedAt, failedTask.batchCreatedAt);
});

test("explicit filename import preserves the provided sequence number", () => {
  const task = createTaskFromInput(
    {
      prompt: "一只小猫",
      filename: "image_一只小猫_042"
    },
    0,
    {
      filenamePrefix: "image",
      downloadSubfolder: "chatgpt-images"
    }
  );

  assert.equal(task.filename, "image_一只小猫_042");
  assert.equal(task.sequenceNumber, 42);
  assert.equal(task.prompt, "一只小猫");
});

test("new tasks store a fixed sequence number when they enter the queue", () => {
  const task = createTaskFromPrompt("一只小猫", 4, {
    filenamePrefix: "image",
    downloadSubfolder: "chatgpt-images"
  });

  assert.equal(task.sequenceNumber, 5);
  assert.match(task.filename, /_005$/);
});

test("next sequence number advances past deleted-task gaps instead of reusing them", () => {
  const next = getNextTaskSequenceNumber([
    { id: "task_1", filename: "image_a_001", sequenceNumber: 1 },
    { id: "task_3", filename: "image_c_003", sequenceNumber: 3 }
  ]);

  assert.equal(next, 4);
});

test("legacy tasks derive their fixed sequence number from filename", () => {
  const normalized = normalizeTaskSequenceNumber({
    id: "legacy_1",
    filename: "image_old_007",
    prompt: "旧任务"
  });

  assert.equal(normalized.sequenceNumber, 7);
  assert.equal(normalized.filename, "image_old_007");
});

test("normalizing a task list backfills missing sequence numbers without changing existing ones", () => {
  const tasks = normalizeTaskSequenceNumbers([
    { id: "legacy_1", filename: "image_old_001", prompt: "旧任务 1" },
    { id: "modern_3", filename: "image_new_003", prompt: "新任务", sequenceNumber: 3 },
    { id: "legacy_gap", filename: "image_misc", prompt: "无序号任务" }
  ]);

  assert.equal(tasks[0].sequenceNumber, 1);
  assert.equal(tasks[1].sequenceNumber, 3);
  assert.equal(tasks[2].sequenceNumber, 4);
});

test("same import payload preserves shared batch metadata on every task", () => {
  const settings = {
    filenamePrefix: "image",
    downloadSubfolder: "chatgpt-images"
  };
  const first = createTaskFromInput(
    {
      prompt: "一只小猫",
      batchId: "batch_a",
      batchCreatedAt: 1000
    },
    0,
    settings
  );
  const second = createTaskFromInput(
    {
      prompt: "一只小狗",
      batchId: "batch_a",
      batchCreatedAt: 1000
    },
    1,
    settings
  );

  assert.equal(first.batchId, "batch_a");
  assert.equal(second.batchId, "batch_a");
  assert.equal(first.batchCreatedAt, 1000);
  assert.equal(second.batchCreatedAt, 1000);
});

test("selects the earliest unfinished batch id", () => {
  const tasks = [
    { id: "t1", batchId: "batch_1", batchCreatedAt: 1000, status: TASK_STATUS.DOWNLOADED },
    { id: "t2", batchId: "batch_2", batchCreatedAt: 2000, status: TASK_STATUS.PENDING },
    { id: "t3", batchId: "batch_2", batchCreatedAt: 2000, status: TASK_STATUS.SUCCESS },
    { id: "t4", batchId: "batch_3", batchCreatedAt: 3000, status: TASK_STATUS.PENDING }
  ];

  assert.equal(getEarliestOpenBatchId(tasks), "batch_2");
});

test("ignores malformed batchCreatedAt values when choosing the earliest open batch", () => {
  const tasks = [
    { id: "t1", batchId: "batch_bad", batchCreatedAt: "oops", status: TASK_STATUS.PENDING },
    { id: "t2", batchId: "batch_good", batchCreatedAt: 2000, status: TASK_STATUS.PENDING },
    { id: "t3", batchId: "batch_late", batchCreatedAt: 3000, status: TASK_STATUS.PENDING }
  ];

  assert.equal(getEarliestOpenBatchId(tasks), "batch_good");
});

test("reconciles missed download completion events from current download records", () => {
  const result = reconcileDownloadItems(
    [
      { id: 11, filename: "a.png", state: "in_progress" },
      { id: 12, filename: "b.png", state: "in_progress" },
      { id: 13, filename: "c.png", state: "complete" }
    ],
    new Map([
      [11, { id: 11, state: { current: "complete" } }],
      [12, { id: 12, state: { current: "complete" } }],
      [13, { id: 13, state: { current: "complete" } }]
    ])
  );

  assert.equal(result.changed, true);
  assert.equal(result.completed, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.allDone, true);
  assert.equal(result.items[0].state, "complete");
  assert.equal(result.items[1].state, "complete");
});

test("reconcileDownloadItems skips malformed persisted download items", () => {
  const result = reconcileDownloadItems(
    [
      null,
      "bad",
      { id: 11, filename: "a.png", state: "in_progress" },
      42,
      { id: 12, filename: "b.png", state: "failed" }
    ],
    new Map([[11, { id: 11, state: { current: "complete" } }]])
  );

  assert.deepEqual(result.items, [
    { id: 11, filename: "a.png", state: "complete" },
    { id: 12, filename: "b.png", state: "failed" }
  ]);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.allDone, true);
  assert.equal(result.changed, true);
});

test("computes a two-hour cooldown resume timestamp for timed out tasks", () => {
  const startedAt = 1_700_000_000_000;
  assert.equal(
    computeCooldownResumeAt(startedAt),
    startedAt + TASK_TIMEOUT_POLICY.COOLDOWN_RESUME_MS
  );
});
