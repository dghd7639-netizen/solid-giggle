# Batch Queue Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each import create a distinct batch queue, keep later batches blocked until earlier batches finish, and add a popup-only draft warning that never deletes already imported tasks.

**Architecture:** Extend the existing task model with lightweight batch metadata instead of creating a second top-level queue structure. The background scheduler will dynamically choose the earliest unfinished batch and only dispatch tasks from that batch, while the popup will separately guard input-draft replacement before import.

**Tech Stack:** Chrome Manifest V3 extension background script, popup DOM logic, local storage state, Node test runner

---

## File Structure

- Modify: `/Users/hanbala/Desktop/gpt生图插件/shared.js`
  - Add task batch metadata helpers and pure batch-selection utilities.
- Modify: `/Users/hanbala/Desktop/gpt生图插件/background.js`
  - Create batch IDs on import and restrict scheduling to the earliest unfinished batch.
- Modify: `/Users/hanbala/Desktop/gpt生图插件/popup.js`
  - Add draft-only import confirmation and optional batch labels in rendering if needed.
- Modify: `/Users/hanbala/Desktop/gpt生图插件/README.md`
  - Document batch import semantics and draft warning behavior.
- Modify: `/Users/hanbala/Desktop/gpt生图插件/test/shared.test.js`
  - Add pure tests for batch creation and earliest-unfinished-batch selection.
- Create: `/Users/hanbala/Desktop/gpt生图插件/test/background-batches.test.js`
  - Add focused tests for import and scheduling rules without relying on popup UI.

### Task 1: Add Batch Metadata Helpers

**Files:**
- Modify: `/Users/hanbala/Desktop/gpt生图插件/shared.js`
- Test: `/Users/hanbala/Desktop/gpt生图插件/test/shared.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test("creates one batch id for every task in the same import payload", () => {
  const batchId = "batch_a";
  const settings = { filenamePrefix: "image", downloadSubfolder: "chatgpt-images" };
  const first = createTaskFromInput({ prompt: "一只小猫", batchId, batchCreatedAt: 1000 }, 0, settings);
  const second = createTaskFromInput({ prompt: "一只小狗", batchId, batchCreatedAt: 1000 }, 1, settings);

  assert.equal(first.batchId, "batch_a");
  assert.equal(second.batchId, "batch_a");
  assert.equal(first.batchCreatedAt, 1000);
  assert.equal(second.batchCreatedAt, 1000);
});

test("selects the earliest unfinished batch id", () => {
  const tasks = [
    { id: "t1", batchId: "batch_1", batchCreatedAt: 1000, status: TASK_STATUS.DOWNLOADED },
    { id: "t2", batchId: "batch_2", batchCreatedAt: 2000, status: TASK_STATUS.PENDING },
    { id: "t3", batchId: "batch_3", batchCreatedAt: 3000, status: TASK_STATUS.PENDING }
  ];

  assert.equal(getEarliestOpenBatchId(tasks), "batch_2");
});

test("keeps the original batch id when retrying a task", () => {
  const retried = resetTaskForRetry({
    id: "task_1",
    prompt: "一只小猫",
    filename: "image_一只小猫_001",
    batchId: "batch_keep",
    batchCreatedAt: 1000,
    status: TASK_STATUS.FAILED,
    retries: 2,
    downloads: { items: [], total: 0, completed: 0, failed: 0 }
  });

  assert.equal(retried.batchId, "batch_keep");
  assert.equal(retried.batchCreatedAt, 1000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test /Users/hanbala/Desktop/gpt生图插件/test/shared.test.js`

Expected: FAIL because `createTaskFromInput` does not persist batch fields and `getEarliestOpenBatchId` does not exist.

- [ ] **Step 3: Write minimal implementation**

```js
function createTaskFromInput(input, index, settings) {
  if (typeof input === "string") {
    return createTaskFromPrompt(input, index, settings);
  }

  const prompt = String((input && input.prompt) || "").trim();
  if (!prompt) {
    throw new Error("Task prompt is required");
  }

  const task = createTaskFromPrompt(prompt, index, settings);
  const filename = String((input && input.filename) || "").trim();

  return Object.assign({}, task, {
    batchId: String((input && input.batchId) || ""),
    batchCreatedAt: Number(input && input.batchCreatedAt) || task.createdAt,
    filename: filename ? sanitizeFilename(filename, task.filename) : task.filename
  });
}

function isTerminalTaskStatus(status) {
  return [
    TASK_STATUS.SUCCESS,
    TASK_STATUS.DOWNLOADED,
    TASK_STATUS.FAILED,
    TASK_STATUS.STOPPED
  ].includes(String(status || "").toLowerCase());
}

function getEarliestOpenBatchId(tasks) {
  const open = new Map();
  for (const task of tasks || []) {
    if (!task || !task.batchId) {
      continue;
    }
    if (isTerminalTaskStatus(task.status)) {
      if (!open.has(task.batchId)) {
        open.set(task.batchId, { batchCreatedAt: Number(task.batchCreatedAt) || 0, open: false });
      }
      continue;
    }
    open.set(task.batchId, {
      batchCreatedAt: Number(task.batchCreatedAt) || 0,
      open: true
    });
  }
  return Array.from(open.entries())
    .filter(([, value]) => value.open)
    .sort((a, b) => a[1].batchCreatedAt - b[1].batchCreatedAt)[0]?.[0] || "";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test /Users/hanbala/Desktop/gpt生图插件/test/shared.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/hanbala/Desktop/gpt生图插件/shared.js /Users/hanbala/Desktop/gpt生图插件/test/shared.test.js
git commit -m "feat: add batch metadata helpers"
```

If this workspace is still not a git repository, skip the commit and note that limitation in the execution log.

### Task 2: Batch-Aware Import in Background

**Files:**
- Modify: `/Users/hanbala/Desktop/gpt生图插件/background.js:361-399`
- Test: `/Users/hanbala/Desktop/gpt生图插件/test/background-batches.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("importPrompts assigns one new batch id to all tasks from the same import", async () => {
  const state = createState({
    tasks: [],
    settings: DEFAULT_SETTINGS
  });

  const result = await importPrompts.call(stateHarness(state), ["一只小猫", "一只小狗"]);

  const batchIds = new Set(result.tasks.map((task) => task.batchId));
  assert.equal(batchIds.size, 1);
  assert.equal(result.tasks[0].batchId, result.tasks[1].batchId);
});

test("a later import creates a second batch instead of merging into the first", async () => {
  const first = await importPrompts.call(stateHarness(createState()), ["一只小猫"]);
  const second = await importPrompts.call(stateHarness({
    ...createState(),
    tasks: first.tasks
  }), ["一只小狗"]);

  assert.notEqual(second.tasks[0].batchId, second.tasks[1].batchId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test /Users/hanbala/Desktop/gpt生图插件/test/background-batches.test.js`

Expected: FAIL because no batch ID is generated during import.

- [ ] **Step 3: Write minimal implementation**

```js
async function importPrompts(rawPrompts) {
  const state = await getState();
  const inputs = normalizePromptInputs(rawPrompts);
  if (!inputs.length) {
    throw new Error("No prompts to import");
  }

  const batchId = generateId("batch");
  const batchCreatedAt = now();
  const startIndex = state.tasks.length;
  const newTasks = inputs.map((input, index) =>
    createTaskFromInput(
      Object.assign({}, typeof input === "string" ? { prompt: input } : input, {
        batchId,
        batchCreatedAt
      }),
      startIndex + index,
      state.settings
    )
  );

  const tasks = state.tasks.concat(newTasks);
  await saveUndoSnapshot("导入提示词", state);
  await setState({ [STORAGE_KEYS.TASKS]: tasks });
  await appendLog("info", `Imported ${newTasks.length} prompts as ${batchId}`);
  return getPublicState();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test /Users/hanbala/Desktop/gpt生图插件/test/background-batches.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/hanbala/Desktop/gpt生图插件/background.js /Users/hanbala/Desktop/gpt生图插件/test/background-batches.test.js
git commit -m "feat: assign batch ids on import"
```

If there is no git repository, skip the commit and record that fact.

### Task 3: Restrict Scheduling to the Earliest Open Batch

**Files:**
- Modify: `/Users/hanbala/Desktop/gpt生图插件/background.js:773-840`
- Test: `/Users/hanbala/Desktop/gpt生图插件/test/background-batches.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("runNextTask only dispatches tasks from the earliest unfinished batch", async () => {
  const tasks = [
    { id: "a1", batchId: "batch_1", batchCreatedAt: 1000, createdAt: 1000, status: TASK_STATUS.WAITING, readyAt: 0 },
    { id: "b1", batchId: "batch_2", batchCreatedAt: 2000, createdAt: 2000, status: TASK_STATUS.PENDING, readyAt: 0 }
  ];

  const picked = pickNextRunnableTask(tasks, QUEUE_MODE.RUNNING, 3000);
  assert.equal(picked.id, "a1");
});

test("second batch becomes runnable only after the first batch is terminal", async () => {
  const tasks = [
    { id: "a1", batchId: "batch_1", batchCreatedAt: 1000, createdAt: 1000, status: TASK_STATUS.DOWNLOADED, readyAt: null },
    { id: "a2", batchId: "batch_1", batchCreatedAt: 1000, createdAt: 1001, status: TASK_STATUS.FAILED, readyAt: null },
    { id: "b1", batchId: "batch_2", batchCreatedAt: 2000, createdAt: 2000, status: TASK_STATUS.PENDING, readyAt: 0 }
  ];

  const picked = pickNextRunnableTask(tasks, QUEUE_MODE.RUNNING, 3000);
  assert.equal(picked.id, "b1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test /Users/hanbala/Desktop/gpt生图插件/test/background-batches.test.js`

Expected: FAIL because the current scheduler treats all ready tasks equally.

- [ ] **Step 3: Write minimal implementation**

```js
function pickNextRunnableTask(tasks, mode, currentTime) {
  if (mode !== QUEUE_MODE.RUNNING) {
    return null;
  }
  const batchId = getEarliestOpenBatchId(tasks);
  if (!batchId) {
    return null;
  }
  return (tasks || [])
    .filter((task) => task.batchId === batchId)
    .filter((task) => [TASK_STATUS.PENDING, TASK_STATUS.WAITING].includes(task.status))
    .filter((task) => !task.readyAt || task.readyAt <= currentTime)
    .sort((a, b) => a.createdAt - b.createdAt)[0] || null;
}

async function runNextTask() {
  const state = await getState();
  if (state.runtime.mode !== QUEUE_MODE.RUNNING || state.runtime.currentTaskId) {
    return;
  }

  const task = pickNextRunnableTask(state.tasks, state.runtime.mode, now());
  if (!task) {
    return await handleNoRunnableTask(state);
  }

  // keep existing dispatch flow
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test /Users/hanbala/Desktop/gpt生图插件/test/background-batches.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/hanbala/Desktop/gpt生图插件/background.js /Users/hanbala/Desktop/gpt生图插件/test/background-batches.test.js
git commit -m "feat: schedule tasks by batch order"
```

If there is no git repository, skip the commit and note it.

### Task 4: Keep Retry and Delete Semantics Batch-Safe

**Files:**
- Modify: `/Users/hanbala/Desktop/gpt生图插件/background.js:578-702`
- Test: `/Users/hanbala/Desktop/gpt生图插件/test/background-batches.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("retryTask keeps the original batch id", async () => {
  const state = createState({
    tasks: [
      {
        id: "task_1",
        prompt: "一只小猫",
        filename: "image_一只小猫_001",
        batchId: "batch_keep",
        batchCreatedAt: 1000,
        status: TASK_STATUS.FAILED,
        retries: 1,
        downloads: { items: [], total: 0, completed: 0, failed: 0 }
      }
    ]
  });

  const result = await retryTask.call(stateHarness(state), "task_1");
  assert.equal(result.tasks[0].batchId, "batch_keep");
});

test("deleting the last open task in batch one unlocks batch two", () => {
  const tasks = [
    { id: "a1", batchId: "batch_1", batchCreatedAt: 1000, createdAt: 1000, status: TASK_STATUS.PENDING },
    { id: "b1", batchId: "batch_2", batchCreatedAt: 2000, createdAt: 2000, status: TASK_STATUS.PENDING }
  ];

  const remaining = tasks.filter((task) => task.id !== "a1");
  assert.equal(getEarliestOpenBatchId(remaining), "batch_2");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test /Users/hanbala/Desktop/gpt生图插件/test/background-batches.test.js`

Expected: FAIL if retry or delete logic breaks batch continuity.

- [ ] **Step 3: Write minimal implementation**

```js
async function retryTask(taskId) {
  const state = await getState();
  const target = state.tasks.find((task) => task.id === taskId);
  if (!target) {
    return getPublicState();
  }

  const tasks = state.tasks.map((task) =>
    task.id === target.id ? resetTaskForRetry(task) : task
  );

  await saveUndoSnapshot(`重跑任务「${target.filename}」`, state);
  await setState({ [STORAGE_KEYS.TASKS]: tasks });
  return getPublicState();
}
```

No special delete code is required beyond making sure the scheduler always recomputes the earliest open batch from remaining tasks.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test /Users/hanbala/Desktop/gpt生图插件/test/background-batches.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/hanbala/Desktop/gpt生图插件/background.js /Users/hanbala/Desktop/gpt生图插件/test/background-batches.test.js
git commit -m "fix: preserve batch semantics for retry and delete"
```

If there is no git repository, skip the commit and mention it.

### Task 5: Add Popup Draft-Only Warning

**Files:**
- Modify: `/Users/hanbala/Desktop/gpt生图插件/popup.js:780-910`
- Test: `/Users/hanbala/Desktop/gpt生图插件/test/background-batches.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("import confirmation triggers when the input draft is non-empty", () => {
  assert.equal(shouldConfirmDraftReplacement("一只小猫\n一只小狗"), true);
  assert.equal(shouldConfirmDraftReplacement("   "), false);
});

test("draft confirmation does not inspect existing task list", () => {
  assert.equal(
    buildDraftReplaceMessage("一只小猫\n一只小狗"),
    "输入框里还有上一批未清空的提示词草稿。是否先清空输入框，再导入这批新提示词？"
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test /Users/hanbala/Desktop/gpt生图插件/test/background-batches.test.js`

Expected: FAIL because no draft-confirmation helpers exist.

- [ ] **Step 3: Write minimal implementation**

```js
function shouldConfirmDraftReplacement(text) {
  return Boolean(String(text || "").trim());
}

function buildDraftReplaceMessage() {
  return "输入框里还有上一批未清空的提示词草稿。是否先清空输入框，再导入这批新提示词？";
}

async function confirmBeforeReplacingDraft(nextText) {
  const currentText = getTextValue(elements.promptInput);
  if (!shouldConfirmDraftReplacement(currentText)) {
    return true;
  }
  return window.confirm(buildDraftReplaceMessage(nextText));
}
```

Wire `confirmBeforeReplacingDraft()` into the popup import path before the import message is sent, and only clear the input box if the confirmation returns `true`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test /Users/hanbala/Desktop/gpt生图插件/test/background-batches.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add /Users/hanbala/Desktop/gpt生图插件/popup.js /Users/hanbala/Desktop/gpt生图插件/test/background-batches.test.js
git commit -m "feat: confirm before replacing import draft"
```

If there is no git repository, skip the commit and record the reason.

### Task 6: Update Docs and Run Full Verification

**Files:**
- Modify: `/Users/hanbala/Desktop/gpt生图插件/README.md`
- Modify: `/Users/hanbala/Desktop/gpt生图插件/docs/superpowers/specs/2026-06-04-batch-queue-groups-design.md` (only if implementation reveals a mismatch)
- Test: `/Users/hanbala/Desktop/gpt生图插件/test/shared.test.js`
- Test: `/Users/hanbala/Desktop/gpt生图插件/test/background-batches.test.js`
- Test: `/Users/hanbala/Desktop/gpt生图插件/test/cli.test.js`
- Test: `/Users/hanbala/Desktop/gpt生图插件/test/native-host.test.js`

- [ ] **Step 1: Update README examples**

```md
- 每次批量导入会形成一个独立批次。
- 后导入的批次会等待前一批次全部完成后再执行。
- popup 在替换输入框里的旧提示词草稿前会弹出确认，不影响已导入任务。
```

- [ ] **Step 2: Run syntax checks**

Run: `node --check /Users/hanbala/Desktop/gpt生图插件/shared.js && node --check /Users/hanbala/Desktop/gpt生图插件/background.js && node --check /Users/hanbala/Desktop/gpt生图插件/popup.js`

Expected: no output

- [ ] **Step 3: Run test suite**

Run: `node --test /Users/hanbala/Desktop/gpt生图插件/test/shared.test.js /Users/hanbala/Desktop/gpt生图插件/test/background-batches.test.js /Users/hanbala/Desktop/gpt生图插件/test/cli.test.js /Users/hanbala/Desktop/gpt生图插件/test/native-host.test.js`

Expected: all tests PASS

- [ ] **Step 4: Validate the Codex plugin still describes the updated behavior if needed**

Run: `python3 /Users/hanbala/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py /Users/hanbala/plugins/gpt-image-plugin`

Expected: `Plugin validation passed`

- [ ] **Step 5: Commit**

```bash
git add /Users/hanbala/Desktop/gpt生图插件/README.md /Users/hanbala/Desktop/gpt生图插件/test/shared.test.js /Users/hanbala/Desktop/gpt生图插件/test/background-batches.test.js /Users/hanbala/Desktop/gpt生图插件/test/cli.test.js /Users/hanbala/Desktop/gpt生图插件/test/native-host.test.js
git commit -m "feat: add sequential batch queue imports"
```

If there is no git repository, skip the commit and include that in the handoff summary.
