// Hotfix wrapper for the MV3 service worker.
// Loads the existing background.js, then repairs stale runtime/download states caused by
// extension reloads, Chrome restarts, or missing chrome.downloads records.
if (typeof importScripts === "function") {
  importScripts("background.js");
}

(function () {
  const shared = globalThis.BatchImageShared || {};
  const {
    TASK_STATUS = {},
    QUEUE_MODE = {},
    STORAGE_KEYS = {},
    DEFAULT_SETTINGS = {},
    DEFAULT_RUNTIME = {},
    normalizeSettings = (value) => value || {},
    normalizeTaskSequenceNumbers = (items) => (Array.isArray(items) ? items : []),
    computeDelayMs = () => 0
  } = shared;

  const QUEUE_ALARM = "batch-image-next-task";
  const HOTFIX_ALARM = "batch-image-hotfix-repair";
  const LOG_LIMIT = 300;
  const DEFAULT_TOTAL_TIMEOUT_SEC = 300;
  const STALE_GRACE_SEC = 60;
  const MIN_STALE_CURRENT_TASK_MS = 7 * 60 * 1000;
  const STALE_DOWNLOAD_MS = 10 * 60 * 1000;

  const hasChromeRuntime =
    typeof chrome !== "undefined" &&
    chrome &&
    chrome.storage &&
    chrome.storage.local &&
    chrome.alarms;

  if (!hasChromeRuntime) {
    return;
  }

  setTimeout(() => {
    void runHotfixRepair("startup");
    chrome.alarms.create(HOTFIX_ALARM, { periodInMinutes: 1 });
  }, 250);

  chrome.runtime.onInstalled.addListener(() => {
    setTimeout(() => void runHotfixRepair("installed"), 250);
  });

  chrome.runtime.onStartup.addListener(() => {
    setTimeout(() => void runHotfixRepair("browser-startup"), 250);
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === HOTFIX_ALARM) {
      void runHotfixRepair("periodic");
    }
  });

  async function runHotfixRepair(reason) {
    try {
      const keys = [
        STORAGE_KEYS.SETTINGS,
        STORAGE_KEYS.TASKS,
        STORAGE_KEYS.RUNTIME,
        STORAGE_KEYS.LOGS
      ].filter(Boolean);
      const raw = await chrome.storage.local.get(keys);
      const settings = normalizeSettings(raw[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS);
      let tasks = normalizeTaskSequenceNumbers(
        Array.isArray(raw[STORAGE_KEYS.TASKS]) ? raw[STORAGE_KEYS.TASKS] : []
      );
      let runtime = Object.assign({}, DEFAULT_RUNTIME, raw[STORAGE_KEYS.RUNTIME] || {});
      let tasksChanged = false;
      let runtimeChanged = false;
      let shouldWakeQueue = false;
      const logs = [];
      const currentTime = Date.now();

      const currentTask = runtime.currentTaskId
        ? tasks.find((task) => task && task.id === runtime.currentTaskId)
        : null;

      if (runtime.currentTaskId && !currentTask) {
        runtime = clearActiveRuntime(runtime);
        runtimeChanged = true;
        shouldWakeQueue = runtime.mode === QUEUE_MODE.RUNNING;
        logs.push("Cleared runtime.currentTaskId because the task no longer exists");
      } else if (
        currentTask &&
        [TASK_STATUS.RUNNING, TASK_STATUS.DOWNLOADING].includes(currentTask.status) &&
        isCurrentTaskStale(runtime, settings, currentTime)
      ) {
        const result = retryOrFailTask(
          currentTask,
          "Recovered stale running task after extension/browser restart",
          settings,
          currentTime
        );
        tasks = tasks.map((task) => (task.id === currentTask.id ? result.task : task));
        runtime = clearActiveRuntime(runtime);
        tasksChanged = true;
        runtimeChanged = true;
        shouldWakeQueue = true;
        logs.push(`Recovered stale active task: ${currentTask.filename || currentTask.id}`);
      }

      const downloadResult = await repairStaleDownloads(tasks, settings, currentTime);
      if (downloadResult.changed) {
        tasks = downloadResult.tasks;
        tasksChanged = true;
        shouldWakeQueue = shouldWakeQueue || downloadResult.shouldWakeQueue;
        logs.push(...downloadResult.logs);
      }

      const patch = {};
      if (tasksChanged) {
        patch[STORAGE_KEYS.TASKS] = tasks;
      }
      if (runtimeChanged) {
        patch[STORAGE_KEYS.RUNTIME] = runtime;
      }

      if (Object.keys(patch).length) {
        await chrome.storage.local.set(patch);
        for (const message of logs) {
          await appendHotfixLog("warning", `${message} (${reason})`);
        }
      }

      if (shouldWakeQueue && runtime.mode === QUEUE_MODE.RUNNING) {
        chrome.alarms.create(QUEUE_ALARM, { when: Date.now() + 1000 });
      }
    } catch (error) {
      await appendHotfixLog("error", `Hotfix repair failed: ${error.message || error}`);
    }
  }

  function clearActiveRuntime(runtime) {
    return Object.assign({}, runtime, {
      currentTaskId: null,
      currentTaskStartedAt: null,
      activeTabId: null,
      stopRequested: false,
      pausedUntil: null,
      pauseReason: ""
    });
  }

  function isCurrentTaskStale(runtime, settings, currentTime) {
    const startedAt = Number(runtime && runtime.currentTaskStartedAt);
    if (!Number.isFinite(startedAt) || startedAt <= 0) {
      return true;
    }

    const configuredSec = Number(settings && settings.cliTimeoutTotalSec);
    const timeoutSec = Number.isFinite(configuredSec) && configuredSec > 0
      ? configuredSec
      : DEFAULT_TOTAL_TIMEOUT_SEC;
    const staleMs = Math.max((timeoutSec + STALE_GRACE_SEC) * 1000, MIN_STALE_CURRENT_TASK_MS);
    return currentTime - startedAt > staleMs;
  }

  async function repairStaleDownloads(tasks, settings, currentTime) {
    let changed = false;
    let shouldWakeQueue = false;
    const logs = [];
    const nextTasks = [];

    for (const task of tasks || []) {
      if (!task || task.status !== TASK_STATUS.DOWNLOADING || !task.downloads) {
        nextTasks.push(task);
        continue;
      }

      const items = Array.isArray(task.downloads.items) ? task.downloads.items : [];
      if (!items.length) {
        const result = retryOrFailTask(task, "Download state was empty", settings, currentTime);
        nextTasks.push(result.task);
        changed = true;
        shouldWakeQueue = true;
        logs.push(`Recovered empty download state: ${task.filename || task.id}`);
        continue;
      }

      let itemChanged = false;
      const nextItems = [];
      for (const item of items) {
        if (!item || typeof item !== "object" || item.state !== "in_progress" || typeof item.id !== "number") {
          nextItems.push(item);
          continue;
        }

        const repairedItem = await repairDownloadItem(item, currentTime);
        if (repairedItem !== item) {
          itemChanged = true;
        }
        nextItems.push(repairedItem);
      }

      const completed = nextItems.filter((item) => item && item.state === "complete").length;
      const failed = nextItems.filter((item) =>
        item && (item.state === "interrupted" || item.state === "failed")
      ).length;
      const allDone = nextItems.every((item) =>
        item && ["complete", "interrupted", "failed"].includes(item.state)
      );

      if (!itemChanged) {
        nextTasks.push(task);
        continue;
      }

      changed = true;

      if (allDone && failed > 0) {
        const result = retryOrFailTask(
          Object.assign({}, task, {
            downloads: Object.assign({}, task.downloads, {
              items: nextItems,
              total: nextItems.length,
              completed,
              failed
            })
          }),
          `Download failed for ${failed} image${failed === 1 ? "" : "s"}`,
          settings,
          currentTime
        );
        nextTasks.push(result.task);
        shouldWakeQueue = true;
        logs.push(`Recovered failed download task: ${task.filename || task.id}`);
      } else {
        const nextStatus = allDone ? TASK_STATUS.DOWNLOADED : TASK_STATUS.DOWNLOADING;
        nextTasks.push(Object.assign({}, task, {
          status: nextStatus,
          downloads: {
            items: nextItems,
            total: nextItems.length,
            completed,
            failed
          }
        }));
        if (allDone) {
          shouldWakeQueue = true;
          logs.push(`Recovered completed download task: ${task.filename || task.id}`);
        }
      }
    }

    return { changed, tasks: nextTasks, shouldWakeQueue, logs };
  }

  async function repairDownloadItem(item, currentTime) {
    let record = null;
    try {
      const records = await chrome.downloads.search({ id: item.id });
      record = records && records[0] ? records[0] : null;
    } catch (error) {
      record = null;
    }

    if (record && record.state === "complete") {
      return Object.assign({}, item, { state: "complete" });
    }
    if (record && record.state === "interrupted") {
      return Object.assign({}, item, { state: "interrupted" });
    }

    const firstSeenAt = Number(item.firstSeenAt) || currentTime;
    const ageMs = currentTime - firstSeenAt;
    if (!record && ageMs > STALE_DOWNLOAD_MS) {
      return Object.assign({}, item, {
        state: "interrupted",
        firstSeenAt,
        error: "Download record disappeared before completion"
      });
    }
    if (record && record.state === "in_progress" && ageMs > STALE_DOWNLOAD_MS) {
      return Object.assign({}, item, {
        state: "interrupted",
        firstSeenAt,
        error: "Download stayed in progress for too long"
      });
    }
    if (!item.firstSeenAt) {
      return Object.assign({}, item, { firstSeenAt });
    }
    return item;
  }

  function retryOrFailTask(task, reason, settings, currentTime) {
    const retryLimit = Number(settings && settings.retryLimit);
    const currentRetries = Number(task && task.retries) || 0;
    if (Number.isFinite(retryLimit) && currentRetries < retryLimit) {
      const delayMs = Math.max(0, Number(computeDelayMs(settings)) || 0);
      return {
        task: Object.assign({}, task, {
          status: TASK_STATUS.WAITING,
          retries: currentRetries + 1,
          readyAt: currentTime + delayMs,
          lastError: reason,
          imageCount: 0,
          downloads: { items: [], total: 0, completed: 0, failed: 0 }
        })
      };
    }
    return {
      task: Object.assign({}, task, {
        status: TASK_STATUS.FAILED,
        readyAt: null,
        lastError: reason
      })
    };
  }

  async function appendHotfixLog(level, message) {
    try {
      const data = await chrome.storage.local.get([STORAGE_KEYS.LOGS]);
      const logs = Array.isArray(data[STORAGE_KEYS.LOGS]) ? data[STORAGE_KEYS.LOGS] : [];
      const entry = {
        id: `hotfix_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        level,
        message: `[HOTFIX] ${message}`,
        timestamp: Date.now(),
        source: "hotfix"
      };
      await chrome.storage.local.set({
        [STORAGE_KEYS.LOGS]: [entry].concat(logs).slice(0, LOG_LIMIT)
      });
    } catch (error) {
      console.warn("[batch-image-hotfix] failed to write log", error);
    }
  }
})();
