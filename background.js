if (typeof importScripts === "function") {
  importScripts("shared.js", "background-state.js", "background-queue.js");
}

const backgroundShared =
  globalThis.BatchImageShared ||
  (typeof module !== "undefined" && module.exports ? require("./shared") : null);
const backgroundStateModule =
  globalThis.BatchImageBackgroundState ||
  (typeof module !== "undefined" && module.exports ? require("./background-state") : null);
const backgroundQueueModule =
  globalThis.BatchImageBackgroundQueue ||
  (typeof module !== "undefined" && module.exports ? require("./background-queue") : null);

const {
  TASK_STATUS,
  QUEUE_MODE,
  STORAGE_KEYS,
  MESSAGE_TYPES,
  DEFAULT_SETTINGS,
  DEFAULT_RUNTIME,
  CHATGPT_URL_PATTERNS,
  normalizeSettings,
  createTaskFromInput,
  computeDelayMs,
  now,
  sleep,
  generateId,
  sanitizeFilename,
  updateTaskSequenceNumber,
  getNextTaskSequenceNumber,
  normalizeTaskSequenceNumbers,
  getTaskSummary,
  getEarliestOpenBatchId,
  reconcileDownloadItems,
  resetTaskForRetry,
  shouldScheduleAfterTaskResult,
  computeCooldownResumeAt,
  TASK_TIMEOUT_POLICY
} = backgroundShared;

const QUEUE_ALARM = "batch-image-next-task";
const TASK_TOTAL_TIMEOUT_ALARM = "batch-image-task-total-timeout";
const TASK_TIMEOUT_COOLDOWN_ALARM = "batch-image-task-timeout-cooldown";
const LOG_LIMIT = 300;
const UNDO_LIMIT = 10;
const NATIVE_HOST_NAME = "com.chatgpt_batch_image_generator.cli";
const NATIVE_RECONNECT_DELAY_MS = 5000;
const CONTENT_PING_TYPE = "PING";
const PING_RETRY_LIMIT = 5;
const RUN_TASK_RETRY_LIMIT = 2;
const PING_RETRY_DELAY_MS = 300;
const HANDOFF_RETRY_DELAY_MS = 250;
const MESSAGE_TIMEOUT_MS = 2000;
const TAB_READY_TIMEOUT_MS = 15000;

const ERROR_CODES = {
  CHATGPT_TAB_NOT_FOUND: "CHATGPT_TAB_NOT_FOUND",
  CONTENT_SCRIPT_NOT_READY: "CONTENT_SCRIPT_NOT_READY",
  PING_TIMEOUT: "PING_TIMEOUT",
  PING_FAILED: "PING_FAILED",
  SCRIPT_INJECT_FAILED: "SCRIPT_INJECT_FAILED",
  RUN_TASK_HANDOFF_FAILED: "RUN_TASK_HANDOFF_FAILED"
};

const stateHelpers = backgroundStateModule.createBackgroundStateHelpers({
  QUEUE_MODE,
  STORAGE_KEYS,
  DEFAULT_RUNTIME,
  DEFAULT_SETTINGS,
  UNDO_LIMIT,
  normalizeSettings,
  normalizeTaskSequenceNumbers,
  generateId,
  now,
  setState,
  cloneForStorage
});

const queueHelpers = backgroundQueueModule.createBackgroundQueueHelpers({
  TASK_STATUS,
  createTaskFromInput,
  getNextTaskSequenceNumber,
  getEarliestOpenBatchId,
  generateId,
  now
});

const {
  createIdleRuntime,
  buildStopQueueRuntime,
  buildUndoRestoreState,
  saveUndoSnapshot
} = stateHelpers;

const {
  normalizePromptDraftText,
  promptsToDraftText,
  getPopupDraftState,
  resolveImportDraftPlan,
  normalizePromptInputs,
  buildImportedTasks,
  pickNextRunnableTask
} = queueHelpers;

let nativePort = null;
let nativeReconnectTimer = null;
const hasChromeRuntime =
  typeof chrome !== "undefined" &&
  chrome &&
  chrome.runtime &&
  chrome.storage &&
  chrome.storage.local;

if (hasChromeRuntime) {
  bootstrap().catch((error) => {
    console.error("[batch-image] bootstrap failed", error);
  });

  chrome.runtime.onInstalled.addListener(() => {
    void bootstrap();
  });

  chrome.runtime.onStartup.addListener(() => {
    void bootstrap();
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === QUEUE_ALARM) {
      void runNextTask();
    } else if (alarm.name === TASK_TOTAL_TIMEOUT_ALARM) {
      void pauseForTaskTimeout("total", "Task total runtime exceeded CLI timeout");
    } else if (alarm.name === TASK_TIMEOUT_COOLDOWN_ALARM) {
      void resumeQueueAfterCooldown();
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void handleTabRemoved(tabId);
  });

  chrome.downloads.onChanged.addListener((delta) => {
    void handleDownloadChanged(delta);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => {
        console.error("[batch-image] message error", error);
        sendResponse({ ok: false, error: error.message || String(error) });
      });

    return true;
  });
}

async function bootstrap() {
  const current = await chrome.storage.local.get([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.TASKS,
    STORAGE_KEYS.RUNTIME,
    STORAGE_KEYS.LOGS,
    STORAGE_KEYS.UNDO_STACK,
    STORAGE_KEYS.POPUP_DRAFT
  ]);

  const patch = {};
  patch[STORAGE_KEYS.SETTINGS] = normalizeSettings(
    current[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS
  );
  patch[STORAGE_KEYS.TASKS] = normalizeTaskSequenceNumbers(
    Array.isArray(current[STORAGE_KEYS.TASKS]) ? current[STORAGE_KEYS.TASKS] : []
  );
  patch[STORAGE_KEYS.RUNTIME] = Object.assign(
    {},
    DEFAULT_RUNTIME,
    current[STORAGE_KEYS.RUNTIME] || {}
  );
  patch[STORAGE_KEYS.LOGS] = Array.isArray(current[STORAGE_KEYS.LOGS])
    ? current[STORAGE_KEYS.LOGS].slice(0, LOG_LIMIT)
    : [];
  patch[STORAGE_KEYS.UNDO_STACK] = Array.isArray(current[STORAGE_KEYS.UNDO_STACK])
    ? current[STORAGE_KEYS.UNDO_STACK].slice(0, UNDO_LIMIT)
    : [];
  patch[STORAGE_KEYS.POPUP_DRAFT] =
    current[STORAGE_KEYS.POPUP_DRAFT] && typeof current[STORAGE_KEYS.POPUP_DRAFT] === "object"
      ? current[STORAGE_KEYS.POPUP_DRAFT]
      : {};

  await chrome.storage.local.set(patch);
  connectNativeHost();
}

async function handleMessage(message, sender) {
  switch (message && message.type) {
    case MESSAGE_TYPES.GET_STATE:
      return getPublicState();
    case MESSAGE_TYPES.IMPORT_PROMPTS:
      return importPrompts(message.prompts || [], {
        draftPolicy: message.draftPolicy || "",
        source: "popup"
      });
    case MESSAGE_TYPES.UPDATE_SETTINGS:
      return updateSettings(message.settings || {}, {
        saveUndo: Boolean(message.saveUndo)
      });
    case MESSAGE_TYPES.CLEAR_DRAFT:
      return clearPopupDraft();
    case MESSAGE_TYPES.START_QUEUE:
      return startQueue();
    case MESSAGE_TYPES.RETRY_FAILED:
      return retryFailedTasks();
    case MESSAGE_TYPES.RETRY_TASK:
      return retryTask(message.taskId);
    case MESSAGE_TYPES.DELETE_TASK:
      return deleteTask(message.taskId);
    case MESSAGE_TYPES.UPDATE_TASK_SEQUENCE:
      return updateTaskSequence(message.taskId, message.sequenceNumber);
    case MESSAGE_TYPES.UNDO_LAST_ACTION:
      return undoLastAction();
    case MESSAGE_TYPES.PAUSE_QUEUE:
      return pauseQueue();
    case MESSAGE_TYPES.RESUME_QUEUE:
      return resumeQueue();
    case MESSAGE_TYPES.STOP_QUEUE:
      return stopQueue();
    case MESSAGE_TYPES.CLEAR_COMPLETED:
      return clearCompletedTasks();
    case MESSAGE_TYPES.CLEAR_FAILED:
      return clearFailedTasks();
    case MESSAGE_TYPES.CLEAR_ALL_TASKS:
      return clearAllTasks();
    case MESSAGE_TYPES.CLEAR_LOGS:
      return clearLogs();
    case MESSAGE_TYPES.TASK_RESULT:
      return processTaskResult(message);
    case MESSAGE_TYPES.TASK_LOG:
      return appendLog(message.level || "info", message.message || "", {
        taskId: message.taskId || null,
        source: "content"
      });
    case MESSAGE_TYPES.TASK_TIMEOUT_PAUSE:
      return pauseForTaskTimeout(message.reason || "busy", message.message || "Task exceeded CLI timeout");
    default:
      throw new Error("Unsupported message type");
  }
}

function connectNativeHost() {
  if (!chrome.runtime.connectNative || nativePort) {
    return;
  }

  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (error) {
    scheduleNativeReconnect(error);
    return;
  }

  nativePort.onMessage.addListener((message) => {
    void handleNativeMessage(message);
  });
  nativePort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError;
    nativePort = null;
    scheduleNativeReconnect(error);
  });
}

function scheduleNativeReconnect(error) {
  if (error) {
    console.warn("[batch-image] native host unavailable", error.message || error);
  }
  if (nativeReconnectTimer) {
    return;
  }
  nativeReconnectTimer = setTimeout(() => {
    nativeReconnectTimer = null;
    connectNativeHost();
  }, NATIVE_RECONNECT_DELAY_MS);
}

async function handleNativeMessage(message) {
  const id = message && message.id;
  try {
    const result = await handleNativeCommand(message || {});
    postNativeResponse({ id, ok: true, result });
  } catch (error) {
    postNativeResponse({
      id,
      ok: false,
      error: error.message || String(error)
    });
  }
}

function postNativeResponse(response) {
  if (!nativePort) {
    return;
  }
  try {
    nativePort.postMessage(response);
  } catch (error) {
    console.warn("[batch-image] failed to post native response", error);
  }
}

async function handleNativeCommand(message) {
  const payload = message.payload || {};
  switch (message.command) {
    case "status":
      return getPublicState();
    case "import-prompts":
      return importPrompts(payload.prompts || [], {
        draftPolicy: payload.draftPolicy || "",
        source: "native"
      });
    case "start":
      return startQueueFromCli(payload);
    case "pause":
      return pauseQueue();
    case "resume":
      return resumeQueue();
    case "clear-draft":
      return clearPopupDraft();
    case "undo":
      return undoLastAction();
    case "stop":
      return stopQueue();
    case "update-settings":
      return updateSettings(payload.settings || {}, {
        saveUndo: true
      });
    case "delete-task":
      return deleteTask(payload.taskId);
    case "update-task-sequence":
      return updateTaskSequence(payload.taskId, payload.sequenceNumber);
    case "clear-completed":
      return clearCompletedTasks();
    case "clear-failed":
      return clearFailedTasks();
    case "clear-all":
      return clearAllTasks();
    case "clear-logs":
      return clearLogs();
    default:
      throw new Error(`Unsupported native command: ${message.command || ""}`);
  }
}

async function getState() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.TASKS,
    STORAGE_KEYS.RUNTIME,
    STORAGE_KEYS.LOGS,
    STORAGE_KEYS.UNDO_STACK,
    STORAGE_KEYS.POPUP_DRAFT
  ]);

  return {
    settings: normalizeSettings(data[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS),
    tasks: normalizeTaskSequenceNumbers(
      Array.isArray(data[STORAGE_KEYS.TASKS]) ? data[STORAGE_KEYS.TASKS] : []
    ),
    runtime: Object.assign({}, DEFAULT_RUNTIME, data[STORAGE_KEYS.RUNTIME] || {}),
    logs: Array.isArray(data[STORAGE_KEYS.LOGS]) ? data[STORAGE_KEYS.LOGS] : [],
    undoStack: Array.isArray(data[STORAGE_KEYS.UNDO_STACK]) ? data[STORAGE_KEYS.UNDO_STACK] : [],
    popupDraft:
      data[STORAGE_KEYS.POPUP_DRAFT] && typeof data[STORAGE_KEYS.POPUP_DRAFT] === "object"
        ? data[STORAGE_KEYS.POPUP_DRAFT]
        : {}
  };
}

async function setState(partial) {
  await chrome.storage.local.set(partial);
}

async function getPublicState() {
  const state = await reconcileActiveDownloads();
  return {
    settings: state.settings,
    runtime: state.runtime,
    tasks: state.tasks,
    logs: state.logs,
    draft: getPopupDraftState(state.popupDraft),
    summary: getTaskSummary(state.tasks)
  };
}

async function appendLog(level, message, extra) {
  const state = await getState();
  const entry = Object.assign(
    {
      id: generateId("log"),
      level,
      message,
      timestamp: now()
    },
    extra || {}
  );
  const logs = [entry].concat(state.logs).slice(0, LOG_LIMIT);
  await setState({ [STORAGE_KEYS.LOGS]: logs });
  return entry;
}

async function logTaskStep(taskId, level, code, message, extra) {
  const detail = extra ? ` | ${safeJson(extra)}` : "";
  await appendLog(level, `[${code}] ${message}${detail}`, { taskId });
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({ note: "unserializable", error: error.message || String(error) });
  }
}

function createBackgroundError(code, message, extra) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  error.extra = extra || null;
  return error;
}

async function updateSettings(settingsPatch, options) {
  const state = await getState();
  const settings = normalizeSettings(Object.assign({}, state.settings, settingsPatch));
  if (options && options.saveUndo) {
    await saveUndoSnapshot("更新设置", state);
  }
  await setState({ [STORAGE_KEYS.SETTINGS]: settings });
  await appendLog("info", "Settings updated");
  return getPublicState();
}

async function clearPopupDraft() {
  const state = await getState();
  const currentPromptText = String((state.popupDraft && state.popupDraft.promptText) || "").trim();
  if (!currentPromptText) {
    await appendLog("info", "草稿已经是空的");
    return getPublicState();
  }

  await saveUndoSnapshot("清空草稿", state);
  await setState({
    [STORAGE_KEYS.POPUP_DRAFT]: Object.assign({}, state.popupDraft, {
      promptText: ""
    })
  });
  await appendLog("info", "草稿已清空");
  return getPublicState();
}

async function startQueueFromCli(payload) {
  const patch = {};
  if (payload.timeoutTotalSec !== undefined) {
    patch.cliTimeoutTotalSec = payload.timeoutTotalSec;
  }
  if (payload.timeoutBusySec !== undefined) {
    patch.cliTimeoutBusySec = payload.timeoutBusySec;
  }

  if (Object.keys(patch).length) {
    const state = await getState();
    const settings = normalizeSettings(Object.assign({}, state.settings, patch));
    await setState({ [STORAGE_KEYS.SETTINGS]: settings });
    await appendLog("info", "CLI timeout settings updated", {
      timeoutTotalSec: settings.cliTimeoutTotalSec,
      timeoutBusySec: settings.cliTimeoutBusySec
    });
  }

  return startQueue();
}

async function importPrompts(rawPrompts, options) {
  const state = await getState();
  const draftPlan = resolveImportDraftPlan(
    state.popupDraft && state.popupDraft.promptText,
    rawPrompts,
    options && options.draftPolicy
  );

  if (draftPlan.requiresChoice) {
    throw new Error("Popup draft already contains different prompts. Re-run import with --replace-draft or --keep-draft.");
  }

  const newTasks = buildImportedTasks(rawPrompts, state.tasks, state.settings);
  const tasks = state.tasks.concat(newTasks);
  const patch = {
    [STORAGE_KEYS.TASKS]: tasks
  };

  if (draftPlan.shouldUpdateDraft) {
    patch[STORAGE_KEYS.POPUP_DRAFT] = Object.assign({}, state.popupDraft, {
      promptText: draftPlan.nextDraftText
    });
  }

  await saveUndoSnapshot("导入提示词", state);
  await setState(patch);
  await appendLog("info", `Imported ${newTasks.length} prompts`);

  return getPublicState();
}

async function startQueue() {
  const state = await getState();
  await saveUndoSnapshot("开始队列", state);
  const runtime = Object.assign({}, state.runtime, {
    mode: QUEUE_MODE.RUNNING,
    targetTabId: state.runtime.currentTaskId ? state.runtime.targetTabId || null : null,
    stopRequested: false,
    pausedUntil: null,
    pauseReason: ""
  });

  await setState({ [STORAGE_KEYS.RUNTIME]: runtime });
  await appendLog("info", "Queue started");
  await chrome.alarms.clear(QUEUE_ALARM);
  await chrome.alarms.clear(TASK_TIMEOUT_COOLDOWN_ALARM);
  await runNextTask();
  return getPublicState();
}

async function pauseQueue() {
  const state = await getState();
  await saveUndoSnapshot("暂停队列", state);
  const runtime = Object.assign({}, state.runtime, {
    mode: QUEUE_MODE.PAUSED,
    pausedUntil: null,
    pauseReason: ""
  });

  await setState({ [STORAGE_KEYS.RUNTIME]: runtime });
  await chrome.alarms.clear(TASK_TIMEOUT_COOLDOWN_ALARM);
  await appendLog("info", "Queue paused");

  if (runtime.currentTaskId && runtime.activeTabId) {
    await sendControl(runtime.activeTabId, runtime.currentTaskId, "pause");
  }

  return getPublicState();
}

async function resumeQueue() {
  const state = await getState();
  await saveUndoSnapshot("继续队列", state);
  const runtime = Object.assign({}, state.runtime, {
    mode: QUEUE_MODE.RUNNING,
    stopRequested: false,
    pausedUntil: null,
    pauseReason: ""
  });

  await setState({ [STORAGE_KEYS.RUNTIME]: runtime });
  await chrome.alarms.clear(TASK_TIMEOUT_COOLDOWN_ALARM);
  await appendLog("info", "Queue resumed");

  if (runtime.currentTaskId && runtime.activeTabId) {
    await sendControl(runtime.activeTabId, runtime.currentTaskId, "resume");
  } else {
    await chrome.alarms.clear(QUEUE_ALARM);
    await runNextTask();
  }

  return getPublicState();
}

async function stopQueue() {
  const state = await getState();
  await saveUndoSnapshot("停止队列", state);
  const runtime = buildStopQueueRuntime(state.runtime);
  const tasks = state.tasks.map((task) => {
    if (
      task.id !== state.runtime.currentTaskId &&
      [TASK_STATUS.PENDING, TASK_STATUS.WAITING].includes(task.status)
    ) {
      return Object.assign({}, task, {
        status: TASK_STATUS.STOPPED,
        readyAt: null,
        lastError: "Queue stopped"
      });
    }
    return task;
  });

  await setState({
    [STORAGE_KEYS.RUNTIME]: runtime,
    [STORAGE_KEYS.TASKS]: tasks
  });
  await chrome.alarms.clear(QUEUE_ALARM);
  await chrome.alarms.clear(TASK_TOTAL_TIMEOUT_ALARM);
  await chrome.alarms.clear(TASK_TIMEOUT_COOLDOWN_ALARM);
  await appendLog("info", "Stop requested");

  if (runtime.currentTaskId && runtime.activeTabId) {
    await sendControl(runtime.activeTabId, runtime.currentTaskId, "stop");
  }

  return getPublicState();
}

async function clearCompletedTasks() {
  const state = await getState();
  const keep = state.tasks.filter((task) =>
    ![
      TASK_STATUS.SUCCESS,
      TASK_STATUS.DOWNLOADED
    ].includes(task.status)
  );
  const clearedCount = state.tasks.length - keep.length;

  if (!clearedCount) {
    await appendLog("info", "没有可清理的完成任务");
    return getPublicState();
  }

  await saveUndoSnapshot("清理已完成任务", state);
  await setState({ [STORAGE_KEYS.TASKS]: keep });
  await appendLog("info", `已清理 ${clearedCount} 个完成任务`);
  return getPublicState();
}

async function clearFailedTasks() {
  const state = await getState();
  const failedStatuses = [TASK_STATUS.FAILED, TASK_STATUS.STOPPED];
  const keep = state.tasks.filter((task) => !failedStatuses.includes(task.status));
  const clearedCount = state.tasks.length - keep.length;

  if (!clearedCount) {
    await appendLog("info", "没有可清理的失败任务");
    return getPublicState();
  }

  await saveUndoSnapshot("清理失败任务", state);
  await setState({ [STORAGE_KEYS.TASKS]: keep });
  await appendLog("info", `已清理 ${clearedCount} 个失败任务`);
  return getPublicState();
}

async function clearAllTasks() {
  const state = await getState();
  const currentTaskId = state.runtime.currentTaskId;
  const activeTabId = state.runtime.activeTabId;

  if (!state.tasks.length) {
    await appendLog("info", "没有可清空的任务");
    return getPublicState();
  }

  await saveUndoSnapshot("清空全部任务", state);
  await chrome.alarms.clear(QUEUE_ALARM);
  await chrome.alarms.clear(TASK_TOTAL_TIMEOUT_ALARM);
  await chrome.alarms.clear(TASK_TIMEOUT_COOLDOWN_ALARM);
  await setState({
    [STORAGE_KEYS.TASKS]: [],
    [STORAGE_KEYS.RUNTIME]: createIdleRuntime(state.runtime)
  });

  if (currentTaskId && activeTabId) {
    await sendControl(activeTabId, currentTaskId, "stop");
  }

  await appendLog("info", currentTaskId ? "Queue cleared and active task stopped" : "Queue cleared");
  return getPublicState();
}

async function clearLogs() {
  const state = await getState();
  if (!state.logs.length) {
    return getPublicState();
  }

  await saveUndoSnapshot("清空日志", state);
  await setState({ [STORAGE_KEYS.LOGS]: [] });
  return getPublicState();
}

async function retryFailedTasks() {
  const state = await getState();
  let retriedCount = 0;

  const tasks = state.tasks.map((task) => {
    if (![TASK_STATUS.FAILED, TASK_STATUS.STOPPED].includes(task.status)) {
      return task;
    }

    retriedCount += 1;
    return resetTaskForRetry(task);
  });

  if (!retriedCount) {
    await appendLog("info", "没有可重跑的失败任务");
    return getPublicState();
  }

  await saveUndoSnapshot("重跑失败任务", state);
  await setState({ [STORAGE_KEYS.TASKS]: tasks });
  await appendLog("info", `已将 ${retriedCount} 个失败任务重新加入队列`);
  return getPublicState();
}

async function retryTask(taskId) {
  const state = await getState();
  const target = state.tasks.find((task) => task.id === taskId);

  if (!target) {
    await appendLog("warning", "未找到要重跑的任务");
    return getPublicState();
  }

  if ([TASK_STATUS.RUNNING, TASK_STATUS.DOWNLOADING, TASK_STATUS.WAITING].includes(target.status)) {
    await appendLog("warning", `当前任务正在执行或等待中，不能重跑：${target.filename}`, {
      taskId: target.id
    });
    return getPublicState();
  }

  if (
    ![
      TASK_STATUS.FAILED,
      TASK_STATUS.STOPPED,
      TASK_STATUS.SUCCESS,
      TASK_STATUS.DOWNLOADED
    ].includes(target.status)
  ) {
    await appendLog("warning", `当前任务状态不能重跑：${target.filename}`, {
      taskId: target.id
    });
    return getPublicState();
  }

  const tasks = state.tasks.map((task) =>
    task.id === target.id
      ? resetTaskForRetry(task)
      : task
  );

  await saveUndoSnapshot(`重跑任务「${target.filename}」`, state);
  await setState({ [STORAGE_KEYS.TASKS]: tasks });
  await appendLog("info", `已将任务「${target.filename}」重新加入队列`, {
    taskId: target.id
  });
  return getPublicState();
}

async function updateTaskSequence(taskId, sequenceNumber) {
  const state = await getState();
  const target = state.tasks.find((task) => task.id === taskId);

  if (!target) {
    await appendLog("warning", "未找到要修改序号的任务");
    return getPublicState();
  }

  if ([TASK_STATUS.RUNNING, TASK_STATUS.DOWNLOADING].includes(target.status)) {
    await appendLog("warning", `任务正在生成或下载中，不能修改序号：${target.filename}`, {
      taskId: target.id
    });
    return getPublicState();
  }

  const nextSequenceNumber = Number(sequenceNumber);
  if (!Number.isInteger(nextSequenceNumber) || nextSequenceNumber <= 0) {
    throw new Error("序号必须是大于 0 的整数");
  }

  const tasks = state.tasks.map((task) =>
    task.id === target.id
      ? updateTaskSequenceNumber(task, nextSequenceNumber)
      : task
  );
  const updated = tasks.find((task) => task.id === target.id);

  await saveUndoSnapshot(`修改任务序号「${target.filename}」`, state);
  await setState({ [STORAGE_KEYS.TASKS]: tasks });
  await appendLog("info", `任务序号已更新为 ${nextSequenceNumber}：${updated.filename}`, {
    taskId: target.id
  });
  return getPublicState();
}

async function deleteTask(taskId) {
  const state = await getState();
  const target = state.tasks.find((task) => task.id === taskId);

  if (!target) {
    await appendLog("warning", "未找到要删除的任务");
    return getPublicState();
  }

  const isCurrentTask = state.runtime.currentTaskId === target.id;
  const shouldStopActiveTask = isCurrentTask && state.runtime.activeTabId;
  const tasks = state.tasks.filter((task) => task.id !== target.id);
  let runtime = isCurrentTask
    ? Object.assign({}, state.runtime, {
        currentTaskId: null
      })
    : state.runtime;

  if (!tasks.length) {
    await chrome.alarms.clear(QUEUE_ALARM);
    runtime = createIdleRuntime(runtime);
  }

  await saveUndoSnapshot(`删除任务「${target.filename}」`, state);
  await setState({
    [STORAGE_KEYS.TASKS]: tasks,
    [STORAGE_KEYS.RUNTIME]: runtime
  });

  if (shouldStopActiveTask) {
    await sendControl(state.runtime.activeTabId, target.id, "stop");
  }

  if (target.status === TASK_STATUS.DOWNLOADING) {
    await cancelTaskDownloads(target);
  }

  await appendLog("info", `已删除任务「${target.filename}」`, {
    taskId: target.id
  });

  if (tasks.length && isCurrentTask && runtime.mode === QUEUE_MODE.RUNNING) {
    await scheduleAfterTask(target.id);
  }

  return getPublicState();
}

async function undoLastAction() {
  const state = await getState();
  const undoStack = Array.isArray(state.undoStack) ? state.undoStack : [];
  const snapshot = undoStack[0];

  if (!snapshot) {
    await appendLog("info", "没有可撤回的操作");
    return getPublicState();
  }

  if (
    state.runtime.currentTaskId ||
    state.runtime.mode === QUEUE_MODE.RUNNING ||
    state.runtime.mode === QUEUE_MODE.STOPPING
  ) {
    await appendLog("warning", "队列运行中，暂不能撤回操作");
    return getPublicState();
  }

  const restored = buildUndoRestoreState(snapshot);

  await setState({
    [STORAGE_KEYS.TASKS]: restored.tasks,
    [STORAGE_KEYS.LOGS]: restored.logs,
    [STORAGE_KEYS.RUNTIME]: restored.runtime,
    [STORAGE_KEYS.SETTINGS]: restored.settings,
    [STORAGE_KEYS.POPUP_DRAFT]: restored.popupDraft,
    [STORAGE_KEYS.UNDO_STACK]: undoStack.slice(1)
  });

  await appendLog("info", `已撤回操作：${snapshot.action || "上一步操作"}`);
  return getPublicState();
}

function cloneForStorage(value) {
  return JSON.parse(JSON.stringify(value));
}

async function cancelTaskDownloads(task) {
  const items = task && task.downloads && Array.isArray(task.downloads.items)
    ? task.downloads.items
    : [];

  for (const item of items) {
    if (typeof item.id !== "number" || item.state !== "in_progress") {
      continue;
    }

    try {
      await chrome.downloads.cancel(item.id);
    } catch (error) {
      await appendLog("warning", `Failed to cancel download: ${error.message || error}`, {
        taskId: task.id
      });
    }
  }
}

async function runNextTask() {
  const state = await reconcileActiveDownloads();
  if (state.runtime.mode !== QUEUE_MODE.RUNNING || state.runtime.currentTaskId) {
    return;
  }

  const currentTime = now();
  const nextTaskDecision = pickNextRunnableTask(state.tasks, currentTime);

  if (!nextTaskDecision.task) {
    if (nextTaskDecision.nextWakeAt) {
      await scheduleWake(nextTaskDecision.nextWakeAt);
      return;
    }

    if (nextTaskDecision.activeBatchId) {
      return;
    }

    await setState({
      [STORAGE_KEYS.RUNTIME]: Object.assign({}, state.runtime, {
        mode: QUEUE_MODE.IDLE,
        currentTaskId: null,
        activeTabId: null,
        targetTabId: null,
        stopRequested: false
      })
    });
    await appendLog("info", "Queue finished");
    return;
  }

  const task = nextTaskDecision.task;
  const pinnedTabId = state.runtime.targetTabId || state.runtime.activeTabId;
  const selectedTab = await findChatGPTTab(pinnedTabId, task.id, Boolean(pinnedTabId));
  const tasks = state.tasks.map((item) =>
    item.id === task.id
      ? Object.assign({}, item, {
          status: TASK_STATUS.RUNNING,
          readyAt: null,
          lastError: ""
        })
      : item
  );
  const runtime = Object.assign({}, state.runtime, {
    currentTaskId: task.id,
    activeTabId: selectedTab.id,
    targetTabId: state.runtime.targetTabId || selectedTab.id,
    currentTaskStartedAt: now(),
    mode: QUEUE_MODE.RUNNING
  });

  await setState({
    [STORAGE_KEYS.TASKS]: tasks,
    [STORAGE_KEYS.RUNTIME]: runtime
  });

  await appendLog("info", `Starting task ${task.filename}`, { taskId: task.id });
  await scheduleTaskTotalTimeout(task.id, state.settings);

  try {
    await waitForTabReady(selectedTab.id, TAB_READY_TIMEOUT_MS);

    const taskPayload = {
      type: MESSAGE_TYPES.RUN_TASK,
      task: Object.assign({}, task, {
        status: TASK_STATUS.RUNNING,
        outputPath: task.outputPath || state.settings.downloadSubfolder
      }),
      settings: state.settings
    };

    await handoffTaskToTab(selectedTab, taskPayload, task.id);
  } catch (error) {
    console.error("[batch-image] failed to send task", error);
    await logTaskStep(
      task.id,
      "error",
      error.code || ERROR_CODES.RUN_TASK_HANDOFF_FAILED,
      "Task handoff failed",
      {
        error: error.message || String(error)
      }
    );
    await handleTaskFailure(task.id, `Failed to hand off task: ${error.message || error}`);
  }
}

async function handoffTaskToTab(tab, payload, taskId) {
  const handshake = await ensureContentScriptReady(tab, taskId);
  if (!handshake.ok) {
    throw handshake.error;
  }

  for (let attempt = 1; attempt <= RUN_TASK_RETRY_LIMIT + 1; attempt += 1) {
    await logTaskStep(taskId, "info", "RUN_TASK_ATTEMPT", "Sending RUN_TASK", {
      attempt,
      tab: summarizeTab(tab)
    });

    try {
      const response = await sendMessageWithTimeout(tab.id, payload, MESSAGE_TIMEOUT_MS);
      if (response && response.accepted === false) {
        throw createBackgroundError(
          ERROR_CODES.RUN_TASK_HANDOFF_FAILED,
          response.reason || "Content script rejected task",
          {
            tab: summarizeTab(tab),
            response
          }
        );
      }

      await logTaskStep(taskId, "success", "RUN_TASK_SENT", "RUN_TASK handed off successfully", {
        attempt,
        tab: summarizeTab(tab),
        response: response === undefined ? "undefined" : response
      });
      return response;
    } catch (error) {
      const receivingEndMissing = isReceivingEndMissingError(error);
      await logTaskStep(
        taskId,
        attempt <= RUN_TASK_RETRY_LIMIT ? "warning" : "error",
        receivingEndMissing ? ERROR_CODES.RUN_TASK_HANDOFF_FAILED : error.code || ERROR_CODES.RUN_TASK_HANDOFF_FAILED,
        "RUN_TASK handoff attempt failed",
        {
          attempt,
          tab: summarizeTab(tab),
          error: error.message || String(error)
        }
      );

      if (!receivingEndMissing || attempt > RUN_TASK_RETRY_LIMIT) {
        throw createBackgroundError(
          ERROR_CODES.RUN_TASK_HANDOFF_FAILED,
          `RUN_TASK failed on attempt ${attempt}`,
          {
            tab: summarizeTab(tab),
            originalError: error.message || String(error)
          }
        );
      }

      const pingResult = await ensureContentScriptReady(tab, taskId, {
        allowInjection: false
      });
      if (!pingResult.ok) {
        throw createBackgroundError(
          ERROR_CODES.RUN_TASK_HANDOFF_FAILED,
          "RUN_TASK retry failed because content script was not ready after re-ping",
          {
            tab: summarizeTab(tab),
            pingError: pingResult.error ? pingResult.error.message || String(pingResult.error) : ""
          }
        );
      }

      await sleep(HANDOFF_RETRY_DELAY_MS);
    }
  }

  throw createBackgroundError(
    ERROR_CODES.RUN_TASK_HANDOFF_FAILED,
    "RUN_TASK handoff failed after retry limit",
    { tab: summarizeTab(tab) }
  );
}

async function ensureContentScriptReady(tab, taskId, options) {
  const allowInjection = !options || options.allowInjection !== false;
  const pingResult = await pingTabWithRetry(tab, taskId, PING_RETRY_LIMIT);
  if (pingResult.ok) {
    return pingResult;
  }

  if (!allowInjection || !isChatGPTUrl(tab.url || "")) {
    return {
      ok: false,
      error:
        pingResult.error ||
        createBackgroundError(
          ERROR_CODES.CONTENT_SCRIPT_NOT_READY,
          "Content script did not become ready",
          { tab: summarizeTab(tab) }
        )
    };
  }

  try {
    await injectContentScripts(tab, taskId);
  } catch (error) {
    return { ok: false, error };
  }

  const postInjectPing = await pingTabWithRetry(tab, taskId, PING_RETRY_LIMIT);
  if (postInjectPing.ok) {
    return postInjectPing;
  }

  return {
    ok: false,
    error:
      postInjectPing.error ||
      createBackgroundError(
        ERROR_CODES.CONTENT_SCRIPT_NOT_READY,
        "Content script still not ready after injection",
        { tab: summarizeTab(tab) }
      )
  };
}

async function pingTabWithRetry(tab, taskId, maxAttempts) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await logTaskStep(taskId, "info", "PING_ATTEMPT", "Pinging target tab", {
      attempt,
      tab: summarizeTab(tab)
    });

    try {
      const response = await sendMessageWithTimeout(
        tab.id,
        { type: CONTENT_PING_TYPE, timestamp: now() },
        MESSAGE_TIMEOUT_MS
      );
      await logTaskStep(taskId, "success", "PING_SUCCESS", "Ping succeeded", {
        attempt,
        tab: summarizeTab(tab),
        response: response === undefined ? "undefined" : response
      });
      return { ok: true, response };
    } catch (error) {
      lastError = error;
      const code = error.code || (isReceivingEndMissingError(error) ? ERROR_CODES.PING_FAILED : ERROR_CODES.PING_TIMEOUT);
      const level = attempt < maxAttempts ? "warning" : "error";
      const logCode = attempt < maxAttempts ? "PING_RETRY" : "PING_FAILED";

      await logTaskStep(taskId, level, logCode, "Ping attempt failed", {
        attempt,
        tab: summarizeTab(tab),
        error: error.message || String(error),
        code
      });

      if (attempt < maxAttempts) {
        await sleep(PING_RETRY_DELAY_MS);
      }
    }
  }

  return {
    ok: false,
    error:
      lastError ||
      createBackgroundError(ERROR_CODES.PING_FAILED, "Ping failed", {
        tab: summarizeTab(tab)
      })
  };
}

async function injectContentScripts(tab, taskId) {
  await logTaskStep(taskId, "warning", "SCRIPT_INJECT_ATTEMPT", "Injecting content scripts", {
    tab: summarizeTab(tab)
  });

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["shared.js"]
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    await sleep(PING_RETRY_DELAY_MS);
  } catch (error) {
    await logTaskStep(taskId, "error", ERROR_CODES.SCRIPT_INJECT_FAILED, "Script injection failed", {
      tab: summarizeTab(tab),
      error: error.message || String(error)
    });
    throw createBackgroundError(
      ERROR_CODES.SCRIPT_INJECT_FAILED,
      "Failed to inject content scripts",
      {
        tab: summarizeTab(tab),
        originalError: error.message || String(error)
      }
    );
  }
}

async function findChatGPTTab(preferredTabId, taskId, requirePreferred) {
  if (typeof preferredTabId === "number") {
    try {
      const preferredTab = await chrome.tabs.get(preferredTabId);
      if (preferredTab && typeof preferredTab.id === "number" && isChatGPTUrl(preferredTab.url || "")) {
        await logTaskStep(taskId, "info", "CHATGPT_TAB_SELECTED", "Selected pinned ChatGPT tab", {
          source: "runtime-active-tab",
          tab: summarizeTab(preferredTab)
        });
        return preferredTab;
      }
      if (requirePreferred) {
        throw createBackgroundError(
          ERROR_CODES.CHATGPT_TAB_NOT_FOUND,
          "Pinned ChatGPT tab is no longer a ChatGPT page",
          { tab: summarizeTab(preferredTab) }
        );
      }
    } catch (error) {
      await logTaskStep(taskId, "warning", "CHATGPT_TAB_PIN_MISSING", "Pinned ChatGPT tab unavailable", {
        tabId: preferredTabId,
        error: error.message || String(error)
      });
      if (requirePreferred) {
        throw createBackgroundError(
          ERROR_CODES.CHATGPT_TAB_NOT_FOUND,
          "Pinned ChatGPT tab unavailable; refusing to switch to another page",
          {
            tabId: preferredTabId,
            originalError: error.message || String(error)
          }
        );
      }
    }
  }

  const activeTabs = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  const activeTab = activeTabs.find((tab) => typeof tab.id === "number");
  if (activeTab && isChatGPTUrl(activeTab.url || "")) {
    await logTaskStep(taskId, "info", "CHATGPT_TAB_SELECTED", "Selected active ChatGPT tab", {
      source: "current-window-active",
      tab: summarizeTab(activeTab)
    });
    return activeTab;
  }

  const currentWindowTabs = await chrome.tabs.query({
    currentWindow: true
  });
  const candidates = currentWindowTabs
    .filter((tab) => typeof tab.id === "number" && isChatGPTUrl(tab.url || ""))
    .sort((a, b) => {
      if (a.id === preferredTabId) {
        return -1;
      }
      if (b.id === preferredTabId) {
        return 1;
      }
      return Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0);
    });

  if (candidates.length) {
    await logTaskStep(taskId, "info", "CHATGPT_TAB_SELECTED", "Selected recent ChatGPT tab", {
      source: "current-window-recent",
      tab: summarizeTab(candidates[0])
    });
    return candidates[0];
  }

  const error = createBackgroundError(
    ERROR_CODES.CHATGPT_TAB_NOT_FOUND,
    "No ChatGPT tab found in the current window"
  );
  await logTaskStep(taskId, "error", ERROR_CODES.CHATGPT_TAB_NOT_FOUND, "ChatGPT tab not found");
  throw error;
}

function summarizeTab(tab) {
  if (!tab) {
    return null;
  }

  return {
    id: tab.id,
    url: tab.url || "",
    title: tab.title || ""
  };
}

function isReceivingEndMissingError(error) {
  const message = String((error && error.message) || error || "");
  return /Receiving end does not exist/i.test(message);
}

async function sendMessageWithTimeout(tabId, payload, timeoutMs) {
  return await Promise.race([
    chrome.tabs.sendMessage(tabId, payload),
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(
          createBackgroundError(
            ERROR_CODES.PING_TIMEOUT,
            `Timed out waiting for response from tab ${tabId}`
          )
        );
      }, timeoutMs);
    })
  ]);
}

async function processTaskResult(message) {
  const state = await getState();
  const task = state.tasks.find((item) => item.id === message.taskId);
  if (!task) {
    return getPublicState();
  }
  if (state.runtime.currentTaskId !== message.taskId && task.status !== TASK_STATUS.RUNNING) {
    return getPublicState();
  }

  const runtime = Object.assign({}, state.runtime, {
    currentTaskId: null,
    currentTaskStartedAt: null
  });

  await chrome.alarms.clear(TASK_TOTAL_TIMEOUT_ALARM);
  await setState({ [STORAGE_KEYS.RUNTIME]: runtime });

  if (message.stopped) {
    const tasks = state.tasks.map((item) =>
      item.id === task.id
        ? Object.assign({}, item, {
            status: TASK_STATUS.STOPPED,
            lastError: message.error || "Task stopped"
          })
        : item
    );
    await setState({ [STORAGE_KEYS.TASKS]: tasks });
    await appendLog("warning", `Task stopped ${task.filename}`, { taskId: task.id });
    await finalizeStoppingIfNeeded();
    return getPublicState();
  }

  if (!message.success) {
    await handleTaskFailure(task.id, message.error || "Unknown error");
    return getPublicState();
  }

  const images = Array.isArray(message.images) ? message.images : [];
  const updatedTasks = state.tasks.map((item) =>
    item.id === task.id
      ? Object.assign({}, item, {
          status: TASK_STATUS.SUCCESS,
          imageCount: images.length,
          lastError: "",
          outputPath: item.outputPath || state.settings.downloadSubfolder
        })
      : item
  );

  await setState({
    [STORAGE_KEYS.TASKS]: updatedTasks,
    [STORAGE_KEYS.RUNTIME]: runtime
  });
  await appendLog("success", `Detected ${images.length} images for ${task.filename}`, {
    taskId: task.id
  });

  if (state.settings.autoDownload && images.length) {
    await beginDownloads(task.id, images, state.settings);
    return getPublicState();
  }

  if (shouldScheduleAfterTaskResult(state.settings, images.length)) {
    await scheduleAfterTask(task.id);
  }
  return getPublicState();
}

async function handleTaskFailure(taskId, reason) {
  const state = await getState();
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) {
    return;
  }

  const runtime = Object.assign({}, state.runtime, {
    currentTaskId: null,
    currentTaskStartedAt: null
  });

  await chrome.alarms.clear(TASK_TOTAL_TIMEOUT_ALARM);
  if (!state.runtime.stopRequested && task.retries < state.settings.retryLimit) {
    const delayMs = computeDelayMs(state.settings);
    const readyAt = now() + delayMs;
    const tasks = state.tasks.map((item) =>
      item.id === taskId
        ? Object.assign({}, item, {
            status: TASK_STATUS.WAITING,
            retries: item.retries + 1,
            readyAt,
            lastError: reason
          })
        : item
    );

    await setState({
      [STORAGE_KEYS.TASKS]: tasks,
      [STORAGE_KEYS.RUNTIME]: runtime
    });
    await appendLog("warning", `Task failed, retry ${task.retries + 1}: ${reason}`, {
      taskId
    });
    await scheduleWake(readyAt);
    return;
  }

  const tasks = state.tasks.map((item) =>
    item.id === taskId
      ? Object.assign({}, item, {
          status: state.runtime.stopRequested ? TASK_STATUS.STOPPED : TASK_STATUS.FAILED,
          lastError: reason,
          readyAt: null
        })
      : item
  );

  await setState({
    [STORAGE_KEYS.TASKS]: tasks,
    [STORAGE_KEYS.RUNTIME]: runtime
  });
  await appendLog("error", `Task failed: ${reason}`, { taskId });
  await finalizeStoppingIfNeeded();

  const refreshed = await getState();
  if (refreshed.runtime.mode === QUEUE_MODE.RUNNING) {
    await scheduleAfterTask(taskId);
  }
}

async function scheduleAfterTask(taskId) {
  const state = await getState();
  if (state.runtime.stopRequested || state.runtime.mode === QUEUE_MODE.STOPPING) {
    await finalizeStoppingIfNeeded();
    return;
  }

  if (state.runtime.mode !== QUEUE_MODE.RUNNING) {
    return;
  }

  const delayMs = computeDelayMs(state.settings);
  if (delayMs <= 0) {
    await runNextTask();
    return;
  }

  await appendLog("info", `Waiting ${Math.round(delayMs / 1000)}s before next task`, {
    taskId
  });
  await scheduleWake(now() + delayMs);
}

async function scheduleWake(when) {
  await chrome.alarms.clear(QUEUE_ALARM);
  chrome.alarms.create(QUEUE_ALARM, { when });

  const state = await getState();
  await setState({
    [STORAGE_KEYS.RUNTIME]: Object.assign({}, state.runtime, {
      lastScheduleAt: when
    })
  });
}

async function scheduleTaskTotalTimeout(taskId, settings) {
  await chrome.alarms.clear(TASK_TOTAL_TIMEOUT_ALARM);
  const configuredTimeoutSec = Number(settings && settings.cliTimeoutTotalSec);
  const timeoutSec = Number.isFinite(configuredTimeoutSec) && configuredTimeoutSec > 0
    ? configuredTimeoutSec
    : TASK_TIMEOUT_POLICY.AUTO_PAUSE_TOTAL_SEC;

  chrome.alarms.create(TASK_TOTAL_TIMEOUT_ALARM, {
    when: now() + timeoutSec * 1000
  });
  await appendLog("info", `CLI total timeout armed for ${Math.round(timeoutSec)}s`, {
    taskId
  });
}

async function pauseForTaskTimeout(reason, message) {
  const state = await getState();
  if (state.runtime.mode !== QUEUE_MODE.RUNNING || !state.runtime.currentTaskId) {
    return getPublicState();
  }

  const taskId = state.runtime.currentTaskId;
  const resumeAt = computeCooldownResumeAt(now());
  const tasks = state.tasks.map((item) =>
    item.id === taskId
      ? Object.assign({}, item, {
          status: TASK_STATUS.FAILED,
          lastError: message,
          readyAt: null
        })
      : item
  );
  const runtime = Object.assign({}, state.runtime, {
    mode: QUEUE_MODE.PAUSED,
    currentTaskId: null,
    currentTaskStartedAt: null,
    stopRequested: false,
    pausedUntil: resumeAt,
    pauseReason: TASK_TIMEOUT_POLICY.COOLDOWN_REASON
  });

  await appendLog("warning", `[CLI_TIMEOUT] ${message}`, {
    taskId,
    reason
  });
  await chrome.alarms.clear(QUEUE_ALARM);
  await chrome.alarms.clear(TASK_TOTAL_TIMEOUT_ALARM);
  await setState({
    [STORAGE_KEYS.TASKS]: tasks,
    [STORAGE_KEYS.RUNTIME]: runtime
  });
  await scheduleCooldownResume(resumeAt);
  await appendLog("info", `Queue paused for cooldown until ${new Date(resumeAt).toLocaleString()}`, {
    taskId,
    reason
  });

  if (state.runtime.activeTabId) {
    await sendControl(state.runtime.activeTabId, taskId, "stop");
  }

  return getPublicState();
}

async function beginDownloads(taskId, images, settings) {
  const state = await getState();
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) {
    return;
  }

  const downloadItems = [];
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const filename = buildDownloadFilename(task, image, index, images.length, settings);
    try {
      const downloadId = await chrome.downloads.download({
        url: image.url,
        filename,
        saveAs: false,
        conflictAction: "uniquify"
      });
      downloadItems.push({
        id: downloadId,
        filename,
        url: image.url,
        state: "in_progress"
      });
    } catch (error) {
      downloadItems.push({
        id: null,
        filename,
        url: image.url,
        state: "failed",
        error: error.message || String(error)
      });
      await appendLog("error", `Failed to start download: ${error.message || error}`, {
        taskId
      });
    }
  }

  const completed = downloadItems.filter((item) => item.state === "complete").length;
  const failed = downloadItems.filter((item) => item.state === "failed").length;
  const total = downloadItems.length;

  let status = TASK_STATUS.FAILED;
  if (total > 0 && total === completed) {
    status = TASK_STATUS.DOWNLOADED;
  } else if (total > 0 && failed < total) {
    status = TASK_STATUS.DOWNLOADING;
  }

  const tasks = state.tasks.map((item) =>
    item.id === taskId
      ? Object.assign({}, item, {
          status,
          downloads: {
            items: downloadItems,
            total,
            completed,
            failed
          }
        })
      : item
  );

  await setState({ [STORAGE_KEYS.TASKS]: tasks });
  await appendLog("info", `Created ${downloadItems.length} download requests`, { taskId });
  await finalizeDownloadBatch(taskId, status, failed);

  if (status === TASK_STATUS.DOWNLOADING) {
    await scheduleWake(now() + 2000);
  }
}

function buildDownloadFilename(task, image, index, total, settings) {
  const folder = task.outputPath || settings.downloadSubfolder || "";
  const extension = detectExtension(image.url);
  const suffix = total > 1 ? `_${String(index + 1).padStart(2, "0")}` : "";
  const baseName = sanitizeFilename(task.filename, "image");
  const relative = `${baseName}${suffix}.${extension}`;
  return folder ? `${folder}/${relative}` : relative;
}

function detectExtension(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
    if (match) {
      return match[1].toLowerCase();
    }
  } catch (error) {
    console.warn("[batch-image] detectExtension failed", error);
  }
  return "png";
}

async function handleDownloadChanged(delta) {
  if (!delta || typeof delta.id !== "number") {
    return;
  }

  const state = await getState();
  const affectedTask = state.tasks.find((task) =>
    task.downloads &&
    Array.isArray(task.downloads.items) &&
    task.downloads.items.some((item) => item.id === delta.id)
  );

  if (!affectedTask) {
    return;
  }

  const items = affectedTask.downloads.items.map((item) => {
    if (item.id !== delta.id) {
      return item;
    }

    return Object.assign({}, item, {
      state: delta.state ? delta.state.current : item.state
    });
  });

  const completed = items.filter((item) => item.state === "complete").length;
  const failed = items.filter(
    (item) => item.state === "interrupted" || item.state === "failed"
  ).length;
  const allDone = items.every((item) =>
    ["complete", "interrupted", "failed"].includes(item.state)
  );

  const nextStatus = allDone
    ? failed > 0
      ? TASK_STATUS.FAILED
      : TASK_STATUS.DOWNLOADED
    : TASK_STATUS.DOWNLOADING;

  const tasks = state.tasks.map((task) =>
    task.id === affectedTask.id
      ? Object.assign({}, task, {
          status: nextStatus,
          downloads: {
            items,
            total: items.length,
            completed,
            failed
          }
        })
      : task
  );

  await setState({ [STORAGE_KEYS.TASKS]: tasks });

  if (delta.state && delta.state.current === "complete") {
    await appendLog("success", `Download completed for ${affectedTask.filename}`, {
      taskId: affectedTask.id
    });
  } else if (delta.state && delta.state.current === "interrupted") {
    await appendLog("error", `Download interrupted for ${affectedTask.filename}`, {
      taskId: affectedTask.id
    });
  }

  if (allDone) {
    await finalizeDownloadBatch(affectedTask.id, nextStatus, failed);
  }
}

async function reconcileActiveDownloads() {
  const state = await getState();
  const candidates = state.tasks.filter((task) =>
    task &&
    task.status === TASK_STATUS.DOWNLOADING &&
    task.downloads &&
    Array.isArray(task.downloads.items) &&
    task.downloads.items.some(
      (item) => item && typeof item.id === "number" && item.state === "in_progress"
    )
  );

  if (!candidates.length) {
    return state;
  }

  let changed = false;
  const finalized = [];
  const taskMap = new Map(state.tasks.map((task) => [task.id, task]));

  for (const task of candidates) {
    const recordsById = new Map();
    for (const item of task.downloads.items) {
      if (!item || typeof item.id !== "number" || item.state !== "in_progress") {
        continue;
      }
      const records = await chrome.downloads.search({ id: item.id });
      if (records && records[0]) {
        recordsById.set(item.id, records[0]);
      }
    }

    const reconciled = reconcileDownloadItems(task.downloads.items, recordsById);
    if (!reconciled.changed) {
      continue;
    }

    changed = true;
    const nextStatus = reconciled.allDone
      ? reconciled.failed > 0
        ? TASK_STATUS.FAILED
        : TASK_STATUS.DOWNLOADED
      : TASK_STATUS.DOWNLOADING;

    taskMap.set(
      task.id,
      Object.assign({}, task, {
        status: nextStatus,
        downloads: {
          items: reconciled.items,
          total: reconciled.items.length,
          completed: reconciled.completed,
          failed: reconciled.failed
        }
      })
    );

    if (reconciled.allDone) {
      finalized.push({
        taskId: task.id,
        status: nextStatus,
        failed: reconciled.failed
      });
    }
  }

  if (!changed) {
    return state;
  }

  const nextState = Object.assign({}, state, {
    tasks: state.tasks.map((task) => taskMap.get(task.id) || task)
  });

  await setState({ [STORAGE_KEYS.TASKS]: nextState.tasks });

  for (const item of finalized) {
    await appendLog("info", `Reconciled download state for ${item.taskId}`, {
      taskId: item.taskId
    });
    await finalizeDownloadBatch(item.taskId, item.status, item.failed);
  }

  return Object.assign({}, nextState, {
    logs: finalized.length ? (await getState()).logs : state.logs
  });
}

async function finalizeDownloadBatch(taskId, status, failedCount) {
  if (status === TASK_STATUS.DOWNLOADED) {
    await scheduleAfterTask(taskId);
    return;
  }

  if (status === TASK_STATUS.FAILED) {
    const reason = failedCount > 0
      ? `Download failed for ${failedCount} image${failedCount === 1 ? "" : "s"}`
      : "Download failed";
    await handleTaskFailure(taskId, reason);
  }
}

async function scheduleCooldownResume(when) {
  await chrome.alarms.clear(TASK_TIMEOUT_COOLDOWN_ALARM);
  chrome.alarms.create(TASK_TIMEOUT_COOLDOWN_ALARM, { when });
}

async function resumeQueueAfterCooldown() {
  const state = await getState();
  if (
    state.runtime.mode !== QUEUE_MODE.PAUSED ||
    state.runtime.pauseReason !== TASK_TIMEOUT_POLICY.COOLDOWN_REASON
  ) {
    return;
  }

  await appendLog("info", "Cooldown finished, resuming queue automatically");
  await resumeQueue();
}

function isChatGPTUrl(url) {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(url || "");
}

async function waitForTabReady(tabId, timeoutMs) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") {
    return;
  }

  await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(
        createBackgroundError(
          ERROR_CODES.CONTENT_SCRIPT_NOT_READY,
          `Tab ${tabId} did not finish loading in time`
        )
      );
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function sendControl(tabId, taskId, action) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE_TYPES.CONTROL_TASK,
      taskId,
      action
    });
  } catch (error) {
    await appendLog("warning", `Failed to send control message: ${error.message || error}`, {
      taskId
    });
  }
}

async function finalizeStoppingIfNeeded() {
  const state = await getState();
  if (!state.runtime.stopRequested && state.runtime.mode !== QUEUE_MODE.STOPPING) {
    return;
  }

  const runtime = createIdleRuntime(state.runtime);
  await setState({ [STORAGE_KEYS.RUNTIME]: runtime });
  await appendLog("info", "Queue stopped");
}

async function handleTabRemoved(tabId) {
  const state = await getState();
  if (state.runtime.activeTabId !== tabId && state.runtime.targetTabId !== tabId) {
    return;
  }

  const currentTaskId = state.runtime.currentTaskId;
  await setState({
    [STORAGE_KEYS.RUNTIME]: Object.assign({}, state.runtime, {
      activeTabId: state.runtime.activeTabId === tabId ? null : state.runtime.activeTabId,
      targetTabId: state.runtime.targetTabId === tabId ? null : state.runtime.targetTabId
    })
  });

  if (currentTaskId) {
    await appendLog("error", "ChatGPT tab was closed while a task was running", {
      taskId: currentTaskId
    });
    await handleTaskFailure(currentTaskId, "ChatGPT tab was closed");
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    normalizePromptInputs,
    buildImportedTasks,
    pickNextRunnableTask,
    getPopupDraftState,
    resolveImportDraftPlan,
    buildUndoRestoreState,
    handleNativeCommand,
    createIdleRuntime,
    buildStopQueueRuntime
  };
}
