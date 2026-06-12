(function () {
  const TASK_STATUS = {
    PENDING: "pending",
    RUNNING: "running",
    WAITING: "waiting",
    SUCCESS: "success",
    FAILED: "failed",
    DOWNLOADING: "downloading",
    DOWNLOADED: "downloaded",
    STOPPED: "stopped"
  };

  const QUEUE_MODE = {
    IDLE: "idle",
    RUNNING: "running",
    PAUSED: "paused",
    STOPPING: "stopping"
  };

  const STORAGE_KEYS = {
    SETTINGS: "settings",
    TASKS: "tasks",
    RUNTIME: "runtime",
    LOGS: "logs",
    POPUP_DRAFT: "popupDraft",
    UNDO_STACK: "undoStack"
  };

  const MESSAGE_TYPES = {
    GET_STATE: "batch-image:get-state",
    IMPORT_PROMPTS: "batch-image:import-prompts",
    UPDATE_SETTINGS: "batch-image:update-settings",
    CLEAR_DRAFT: "batch-image:clear-draft",
    START_QUEUE: "batch-image:start-queue",
    RETRY_FAILED: "batch-image:retry-failed",
    RETRY_TASK: "batch-image:retry-task",
    DELETE_TASK: "batch-image:delete-task",
    UNDO_LAST_ACTION: "batch-image:undo-last-action",
    PAUSE_QUEUE: "batch-image:pause-queue",
    RESUME_QUEUE: "batch-image:resume-queue",
    STOP_QUEUE: "batch-image:stop-queue",
    CLEAR_COMPLETED: "batch-image:clear-completed",
    CLEAR_FAILED: "batch-image:clear-failed",
    CLEAR_ALL_TASKS: "batch-image:clear-all-tasks",
    CLEAR_LOGS: "batch-image:clear-logs",
    RUN_TASK: "batch-image:run-task",
    CONTROL_TASK: "batch-image:control-task",
    TASK_RESULT: "batch-image:task-result",
    TASK_LOG: "batch-image:task-log",
    TASK_TIMEOUT_PAUSE: "batch-image:task-timeout-pause"
  };

  const DEFAULT_SETTINGS = {
    intervalMode: "fixed",
    fixedIntervalSec: 25,
    randomMinSec: 15,
    randomMaxSec: 45,
    retryLimit: 2,
    autoDownload: true,
    downloadSubfolder: "chatgpt-images",
    detectTimeoutSec: 180,
    cliTimeoutTotalSec: 300,
    cliTimeoutBusySec: 0,
    postSuccessStableMs: 3500,
    filenamePrefix: "image",
    autoSelectCreateImage: true,
    debugMode: false
  };

  const TASK_TIMEOUT_POLICY = {
    AUTO_PAUSE_TOTAL_SEC: 300,
    COOLDOWN_RESUME_MS: 2 * 60 * 60 * 1000,
    COOLDOWN_REASON: "timeout-cooldown"
  };

  const DEFAULT_RUNTIME = {
    mode: QUEUE_MODE.IDLE,
    currentTaskId: null,
    activeTabId: null,
    targetTabId: null,
    lastScheduleAt: null,
    stopRequested: false,
    pausedUntil: null,
    pauseReason: ""
  };

  const CHATGPT_URL_PATTERNS = [
    "https://chatgpt.com/*",
    "https://chat.openai.com/*"
  ];

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function now() {
    return Date.now();
  }

  function generateId(prefix) {
    const random = Math.random().toString(36).slice(2, 10);
    return [prefix, Date.now().toString(36), random].join("_");
  }

  function sanitizeFilename(input, fallback) {
    const normalized = String(input || "")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "");
    return (normalized || fallback || "image").slice(0, 120);
  }

  function extractTrailingSequenceNumber(value) {
    const match = String(value || "").trim().match(/_(\d{1,9})(?:\.[a-z0-9]+)?$/i);
    if (!match) {
      return null;
    }
    const parsed = Number(match[1]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function getTaskSequenceNumber(task) {
    if (task && Number.isInteger(task.sequenceNumber) && task.sequenceNumber > 0) {
      return task.sequenceNumber;
    }

    return extractTrailingSequenceNumber(task && task.filename);
  }

  function getNextTaskSequenceNumber(tasks) {
    const numbers = (Array.isArray(tasks) ? tasks : [])
      .map((task) => getTaskSequenceNumber(task))
      .filter((value) => Number.isInteger(value) && value > 0);

    if (!numbers.length) {
      return 1;
    }

    return Math.max(...numbers) + 1;
  }

  function normalizeTaskSequenceNumber(task, fallbackSequenceNumber) {
    if (!task || typeof task !== "object") {
      return task;
    }

    const existingSequenceNumber = getTaskSequenceNumber(task);
    const nextSequenceNumber =
      existingSequenceNumber ||
      (Number.isInteger(fallbackSequenceNumber) && fallbackSequenceNumber > 0
        ? fallbackSequenceNumber
        : null);

    if (
      existingSequenceNumber &&
      Number.isInteger(task.sequenceNumber) &&
      task.sequenceNumber === existingSequenceNumber
    ) {
      return task;
    }

    if (!nextSequenceNumber) {
      return task;
    }

    return Object.assign({}, task, {
      sequenceNumber: nextSequenceNumber
    });
  }

  function normalizeTaskSequenceNumbers(tasks) {
    const list = Array.isArray(tasks) ? tasks : [];
    let nextSequenceNumber = getNextTaskSequenceNumber(list);

    return list.map((task) => {
      const normalizedTask = normalizeTaskSequenceNumber(task, nextSequenceNumber);
      if (
        normalizedTask &&
        Number.isInteger(normalizedTask.sequenceNumber) &&
        normalizedTask.sequenceNumber >= nextSequenceNumber
      ) {
        nextSequenceNumber = normalizedTask.sequenceNumber + 1;
      }
      return normalizedTask;
    });
  }

  function createTaskFromPrompt(prompt, index, settings, options) {
    const trimmed = String(prompt || "").trim();
    const prefix = sanitizeFilename((settings && settings.filenamePrefix) || "image", "image");
    const promptBase = sanitizeFilename(trimmed.slice(0, 60), "");
    const base = sanitizeFilename(promptBase ? `${prefix}_${promptBase}` : prefix, prefix);
    const sequenceNumber =
      options && Number.isInteger(options.sequenceNumber) && options.sequenceNumber > 0
        ? options.sequenceNumber
        : index + 1;

    return {
      id: generateId("task"),
      prompt: trimmed,
      sequenceNumber,
      filename: `${base}_${String(sequenceNumber).padStart(3, "0")}`,
      status: TASK_STATUS.PENDING,
      retries: 0,
      createdAt: now(),
      outputPath: (settings && settings.downloadSubfolder) || "",
      lastError: "",
      readyAt: null,
      imageCount: 0,
      downloads: {
        items: [],
        total: 0,
        completed: 0,
        failed: 0
      }
    };
  }

  function createTaskFromInput(input, index, settings) {
    if (typeof input === "string") {
      return createTaskFromPrompt(input, index, settings);
    }

    const prompt = String((input && input.prompt) || "").trim();
    if (!prompt) {
      throw new Error("Task prompt is required");
    }

    const explicitFilename = String((input && input.filename) || "").trim();
    const explicitSequenceNumber =
      Number.isInteger(input && input.sequenceNumber) && input.sequenceNumber > 0
        ? input.sequenceNumber
        : extractTrailingSequenceNumber(explicitFilename);
    const task = createTaskFromPrompt(prompt, index, settings, {
      sequenceNumber: explicitSequenceNumber || undefined
    });
    const filename = String((input && input.filename) || "").trim();
    const batchId = String((input && input.batchId) || "").trim();
    const batchCreatedAt = Number(input && input.batchCreatedAt);

    return Object.assign({}, task, {
      batchId,
      batchCreatedAt: Number.isFinite(batchCreatedAt) ? batchCreatedAt : task.createdAt,
      filename: filename ? sanitizeFilename(filename, task.filename) : task.filename
    });
  }

  function isTerminalTaskStatus(status) {
    return [
      TASK_STATUS.SUCCESS,
      TASK_STATUS.FAILED,
      TASK_STATUS.DOWNLOADED,
      TASK_STATUS.STOPPED
    ].includes(String(status || "").toLowerCase());
  }

  function getEarliestOpenBatchId(tasks) {
    const openBatches = new Map();

    for (const task of tasks || []) {
      if (!task || !task.batchId || isTerminalTaskStatus(task.status)) {
        continue;
      }

      const existing = openBatches.get(task.batchId);
      const batchCreatedAt = Number(task.batchCreatedAt);
      const normalizedCreatedAt = Number.isFinite(batchCreatedAt) ? batchCreatedAt : Infinity;

      if (!existing || normalizedCreatedAt < existing.batchCreatedAt) {
        openBatches.set(task.batchId, {
          batchCreatedAt: normalizedCreatedAt
        });
      }
    }

    let earliestBatchId = "";
    let earliestBatchCreatedAt = Infinity;
    for (const [batchId, batch] of openBatches.entries()) {
      if (batch.batchCreatedAt < earliestBatchCreatedAt) {
        earliestBatchId = batchId;
        earliestBatchCreatedAt = batch.batchCreatedAt;
      }
    }

    return earliestBatchId;
  }

  function clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, num));
  }

  function normalizeSettings(settings) {
    const merged = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const minSec = clampNumber(merged.randomMinSec, 1, 3600, DEFAULT_SETTINGS.randomMinSec);
    const maxSec = clampNumber(merged.randomMaxSec, minSec, 3600, DEFAULT_SETTINGS.randomMaxSec);

    return {
      intervalMode: merged.intervalMode === "random" ? "random" : "fixed",
      fixedIntervalSec: clampNumber(
        merged.fixedIntervalSec,
        0,
        3600,
        DEFAULT_SETTINGS.fixedIntervalSec
      ),
      randomMinSec: minSec,
      randomMaxSec: maxSec,
      retryLimit: clampNumber(merged.retryLimit, 0, 10, DEFAULT_SETTINGS.retryLimit),
      autoDownload: Boolean(merged.autoDownload),
      downloadSubfolder: sanitizeDownloadSubfolder(merged.downloadSubfolder),
      detectTimeoutSec: clampNumber(
        merged.detectTimeoutSec,
        30,
        900,
        DEFAULT_SETTINGS.detectTimeoutSec
      ),
      cliTimeoutTotalSec: clampNumber(
        merged.cliTimeoutTotalSec,
        0,
        24 * 3600,
        DEFAULT_SETTINGS.cliTimeoutTotalSec
      ),
      cliTimeoutBusySec: clampNumber(
        merged.cliTimeoutBusySec,
        0,
        24 * 3600,
        DEFAULT_SETTINGS.cliTimeoutBusySec
      ),
      postSuccessStableMs: clampNumber(
        merged.postSuccessStableMs,
        1000,
        15000,
        DEFAULT_SETTINGS.postSuccessStableMs
      ),
      filenamePrefix: sanitizeFilename(merged.filenamePrefix, DEFAULT_SETTINGS.filenamePrefix),
      autoSelectCreateImage: merged.autoSelectCreateImage !== false,
      debugMode: Boolean(merged.debugMode)
    };
  }

  function sanitizeDownloadSubfolder(value) {
    return String(value || "")
      .split(/[\\/]+/)
      .map((part) => sanitizeFilename(part, ""))
      .filter(Boolean)
      .join("/");
  }

  function computeDelayMs(settings) {
    const normalized = normalizeSettings(settings);
    if (normalized.intervalMode === "random") {
      const min = normalized.randomMinSec * 1000;
      const max = normalized.randomMaxSec * 1000;
      if (max <= min) {
        return min;
      }
      return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    return normalized.fixedIntervalSec * 1000;
  }

  function toLineList(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function getTaskSummary(tasks) {
    const summary = {
      total: 0,
      pending: 0,
      running: 0,
      waiting: 0,
      success: 0,
      failed: 0,
      downloading: 0,
      downloaded: 0,
      stopped: 0
    };

    for (const task of tasks || []) {
      summary.total += 1;
      if (summary[task.status] !== undefined) {
        summary[task.status] += 1;
      }
    }

    return summary;
  }

  function reconcileDownloadItems(items, recordsById) {
    const validItems = (items || []).filter(
      (item) => item && typeof item === "object" && !Array.isArray(item)
    );
    const nextItems = validItems.map((item) => {
      if (!item || typeof item.id !== "number") {
        return item;
      }

      const record = recordsById instanceof Map ? recordsById.get(item.id) : null;
      if (!record || !record.state || !record.state.current) {
        return item;
      }

      return Object.assign({}, item, {
        state: record.state.current
      });
    });

    const completed = nextItems.filter((item) => item.state === "complete").length;
    const failed = nextItems.filter(
      (item) => item.state === "interrupted" || item.state === "failed"
    ).length;
    const allDone = nextItems.every((item) =>
      ["complete", "interrupted", "failed"].includes(item.state)
    );
    const changed =
      validItems.length !== (items || []).length ||
      nextItems.some((item, index) => item !== validItems[index]);

    return {
      items: nextItems,
      completed,
      failed,
      allDone,
      changed
    };
  }

  function resetTaskForRetry(task, overrides) {
    return Object.assign({}, task, overrides || {}, {
      status: TASK_STATUS.PENDING,
      retries: 0,
      readyAt: null,
      lastError: "",
      imageCount: 0,
      downloads: {
        items: [],
        total: 0,
        completed: 0,
        failed: 0
      }
    });
  }

  function shouldScheduleAfterTaskResult(settings, imageCount) {
    return !(settings && settings.autoDownload && Number(imageCount) > 0);
  }

  function computeCooldownResumeAt(startedAtMs) {
    const base = Number.isFinite(Number(startedAtMs)) ? Number(startedAtMs) : now();
    return base + TASK_TIMEOUT_POLICY.COOLDOWN_RESUME_MS;
  }

  const shared = {
    TASK_STATUS,
    QUEUE_MODE,
    STORAGE_KEYS,
    MESSAGE_TYPES,
    DEFAULT_SETTINGS,
    DEFAULT_RUNTIME,
    TASK_TIMEOUT_POLICY,
    CHATGPT_URL_PATTERNS,
    sleep,
    now,
    generateId,
    sanitizeFilename,
    extractTrailingSequenceNumber,
    getTaskSequenceNumber,
    getNextTaskSequenceNumber,
    normalizeTaskSequenceNumber,
    normalizeTaskSequenceNumbers,
    sanitizeDownloadSubfolder,
    normalizeSettings,
    createTaskFromPrompt,
    createTaskFromInput,
    isTerminalTaskStatus,
    getEarliestOpenBatchId,
    computeDelayMs,
    toLineList,
    getTaskSummary,
    reconcileDownloadItems,
    resetTaskForRetry,
    shouldScheduleAfterTaskResult,
    computeCooldownResumeAt
  };

  globalThis.BatchImageShared = shared;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = shared;
  }
})();
