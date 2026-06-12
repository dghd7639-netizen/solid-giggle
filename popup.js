function normalizePromptDraftText(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function shouldConfirmDraftReplacement(currentDraftText, nextPromptText) {
  const current = normalizePromptDraftText(currentDraftText);
  const next = normalizePromptDraftText(nextPromptText);

  return Boolean(current && next && current !== next);
}

function buildDraftReplaceMessage() {
  return "输入框里还有未导入的提示词草稿。导入新提示词会替换这些草稿，但不会影响已经加入队列的任务。要继续吗？";
}

(function () {
  if (
    typeof document === "undefined" ||
    typeof chrome === "undefined" ||
    !globalThis.BatchImageShared
  ) {
    return;
  }

  const {
    MESSAGE_TYPES,
    STORAGE_KEYS,
    DEFAULT_SETTINGS,
    normalizeSettings
  } = globalThis.BatchImageShared;

  const POPUP_DRAFT_KEY = (STORAGE_KEYS && STORAGE_KEYS.POPUP_DRAFT) || "popupDraft";
  const RETRY_FAILED_TYPE =
    (MESSAGE_TYPES && MESSAGE_TYPES.RETRY_FAILED) || "batch-image:retry-failed";
  const CLEAR_FAILED_TYPE =
    (MESSAGE_TYPES && MESSAGE_TYPES.CLEAR_FAILED) || "batch-image:clear-failed";
  const RETRY_TASK_TYPE =
    (MESSAGE_TYPES && MESSAGE_TYPES.RETRY_TASK) || "batch-image:retry-task";
  const DELETE_TASK_TYPE =
    (MESSAGE_TYPES && MESSAGE_TYPES.DELETE_TASK) || "batch-image:delete-task";
  const UPDATE_TASK_SEQUENCE_TYPE =
    (MESSAGE_TYPES && MESSAGE_TYPES.UPDATE_TASK_SEQUENCE) || "batch-image:update-task-sequence";
  const UNDO_LAST_ACTION_TYPE =
    (MESSAGE_TYPES && MESSAGE_TYPES.UNDO_LAST_ACTION) || "batch-image:undo-last-action";
  const DRAFT_SAVE_DEBOUNCE_MS = 300;
  const SETTINGS_SYNC_DEBOUNCE_MS = 350;

  const elements = {
    queueStatusText: document.getElementById("queueStatusText"),
    summary: document.getElementById("summary"),
    overallProgress: document.getElementById("overallProgress"),
    promptInput: document.getElementById("promptInput"),
    fileInput: document.getElementById("fileInput"),
    addPromptsBtn: document.getElementById("addPromptsBtn"),
    saveSettingsBtn: document.getElementById("saveSettingsBtn"),
    startBtn: document.getElementById("startBtn"),
    retryFailedBtn: document.getElementById("retryFailedBtn"),
    pauseBtn: document.getElementById("pauseBtn"),
    resumeBtn: document.getElementById("resumeBtn"),
    stopBtn: document.getElementById("stopBtn"),
    clearCompletedBtn: document.getElementById("clearCompletedBtn"),
    clearFailedBtn: document.getElementById("clearFailedBtn"),
    clearAllBtn: document.getElementById("clearAllBtn"),
    clearLogsBtn: document.getElementById("clearLogsBtn"),
    exportLogsBtn: document.getElementById("exportLogsBtn"),
    exportTasksBtn: document.getElementById("exportTasksBtn"),
    undoLastActionBtn: document.getElementById("undoLastActionBtn"),
    taskList: document.getElementById("taskList"),
    logList: document.getElementById("logList"),
    intervalMode: document.getElementById("intervalMode"),
    fixedIntervalSec: document.getElementById("fixedIntervalSec"),
    randomMinSec: document.getElementById("randomMinSec"),
    randomMaxSec: document.getElementById("randomMaxSec"),
    retryLimit: document.getElementById("retryLimit"),
    detectTimeoutSec: document.getElementById("detectTimeoutSec"),
    downloadSubfolder: document.getElementById("downloadSubfolder"),
    filenamePrefix: document.getElementById("filenamePrefix"),
    autoDownload: document.getElementById("autoDownload"),
    autoSelectCreateImage: document.getElementById("autoSelectCreateImage"),
    rootFolder: document.getElementById("rootFolder"),
    subFolder: document.getElementById("subFolder"),
    filePrefix: document.getElementById("filePrefix"),
    useDateFolder: document.getElementById("useDateFolder"),
    fixedDelaySec: document.getElementById("fixedDelaySec"),
    randomDelayMinSec: document.getElementById("randomDelayMinSec"),
    randomDelayMaxSec: document.getElementById("randomDelayMaxSec"),
    cooldownSec: document.getElementById("cooldownSec"),
    debugMode: document.getElementById("debugMode"),
    clearDraftBtn: document.getElementById("clearDraftBtn")
  };

  let latestState = null;
  let latestDraft = {};
  let isHydratingForm = false;
  let lastScrolledActiveTaskId = "";

  const debouncedPersistDraft = debounce(() => {
    void persistDraftToStorage();
  }, DRAFT_SAVE_DEBOUNCE_MS);

  const debouncedSyncSettings = debounce(() => {
    void syncSettingsToBackground();
  }, SETTINGS_SYNC_DEBOUNCE_MS);

  const debouncedRefreshState = debounce(() => {
    void refreshState();
  }, 80);

  ensureDynamicControls();
  bindEvents();
  void initialize();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    const hasDraftChange = Boolean(changes[POPUP_DRAFT_KEY]);
    const hasStateChange = Boolean(
      changes[STORAGE_KEYS.SETTINGS] ||
        changes[STORAGE_KEYS.TASKS] ||
        changes[STORAGE_KEYS.RUNTIME] ||
        changes[STORAGE_KEYS.LOGS]
    );

    if (changes[POPUP_DRAFT_KEY]) {
      latestDraft = normalizePopupDraft(changes[POPUP_DRAFT_KEY].newValue);
    }

    if (hasStateChange) {
      debouncedRefreshState();
      return;
    }

    if (hasDraftChange && latestState) {
      render(latestState);
    }
  });

  async function initialize() {
    try {
      const [state, storageData] = await Promise.all([
        requestState(),
        chrome.storage.local.get([POPUP_DRAFT_KEY])
      ]);

      latestState = state;
      latestDraft = normalizePopupDraft(storageData[POPUP_DRAFT_KEY]);
      render(state);
    } catch (error) {
      console.error("[popup] initialize failed", error);
      setStatusText(error.message || String(error));
    }
  }

  function ensureDynamicControls() {
    const togglesRow = document.querySelector(".toggles");
    if (togglesRow && !elements.debugMode) {
      const label = document.createElement("label");
      label.className = "checkbox";
      label.innerHTML = '<input id="debugMode" type="checkbox"> Debug mode';
      togglesRow.appendChild(label);
      elements.debugMode = label.querySelector("#debugMode");
    }

    const promptRow = elements.addPromptsBtn ? elements.addPromptsBtn.closest(".row") : null;
    if (promptRow && !elements.clearDraftBtn) {
      const button = document.createElement("button");
      button.id = "clearDraftBtn";
      button.type = "button";
      button.textContent = "清空草稿";
      promptRow.appendChild(button);
      elements.clearDraftBtn = button;
    }

    const taskPanel = elements.taskList ? elements.taskList.closest(".panel") : null;
    if (taskPanel && elements.taskList && !elements.overallProgress) {
      const container = document.createElement("div");
      container.id = "overallProgress";
      container.className = "overall-progress";
      taskPanel.insertBefore(container, elements.taskList);
      elements.overallProgress = container;
    }

    const secondaryControls = document.querySelector(".controls.secondary");
    if (secondaryControls && !elements.retryFailedBtn) {
      const button = document.createElement("button");
      button.id = "retryFailedBtn";
      button.type = "button";
      button.className = "retry";
      button.textContent = "重跑失败任务";
      if (elements.clearAllBtn) {
        secondaryControls.insertBefore(button, elements.clearAllBtn);
      } else {
        secondaryControls.appendChild(button);
      }
      elements.retryFailedBtn = button;
    }

    if (secondaryControls && !elements.clearFailedBtn) {
      const button = document.createElement("button");
      button.id = "clearFailedBtn";
      button.type = "button";
      button.className = "clear-failed";
      button.textContent = "清理失败任务";
      if (elements.clearAllBtn) {
        secondaryControls.insertBefore(button, elements.clearAllBtn);
      } else {
        secondaryControls.appendChild(button);
      }
      elements.clearFailedBtn = button;
    }

    if (secondaryControls && !elements.undoLastActionBtn) {
      const button = document.createElement("button");
      button.id = "undoLastActionBtn";
      button.type = "button";
      button.className = "undo";
      button.textContent = "撤回上一步";
      if (secondaryControls.firstChild) {
        secondaryControls.insertBefore(button, secondaryControls.firstChild);
      } else {
        secondaryControls.appendChild(button);
      }
      elements.undoLastActionBtn = button;
    }

    if (secondaryControls && !elements.exportLogsBtn) {
      const button = document.createElement("button");
      button.id = "exportLogsBtn";
      button.type = "button";
      button.className = "export export-logs";
      button.textContent = "导出日志";
      if (elements.clearLogsBtn) {
        secondaryControls.insertBefore(button, elements.clearLogsBtn);
      } else {
        secondaryControls.appendChild(button);
      }
      elements.exportLogsBtn = button;
    }

    if (secondaryControls && !elements.exportTasksBtn) {
      const button = document.createElement("button");
      button.id = "exportTasksBtn";
      button.type = "button";
      button.className = "export export-tasks";
      button.textContent = "导出任务列表";
      if (elements.exportLogsBtn) {
        secondaryControls.insertBefore(button, elements.exportLogsBtn);
      } else if (elements.clearLogsBtn) {
        secondaryControls.insertBefore(button, elements.clearLogsBtn);
      } else {
        secondaryControls.appendChild(button);
      }
      elements.exportTasksBtn = button;
    }
  }

  function bindEvents() {
    elements.addPromptsBtn.addEventListener("click", onAddPrompts);
    elements.fileInput.addEventListener("change", onImportFile);
    elements.saveSettingsBtn.addEventListener("click", onSaveSettings);
    elements.startBtn.addEventListener("click", () => invokeAndRender(MESSAGE_TYPES.START_QUEUE));
    if (elements.retryFailedBtn) {
      elements.retryFailedBtn.addEventListener("click", () => invokeAndRender(RETRY_FAILED_TYPE));
    }
    if (elements.undoLastActionBtn) {
      elements.undoLastActionBtn.addEventListener("click", () =>
        invokeAndRender(UNDO_LAST_ACTION_TYPE)
      );
    }
    elements.pauseBtn.addEventListener("click", () => invokeAndRender(MESSAGE_TYPES.PAUSE_QUEUE));
    elements.resumeBtn.addEventListener("click", () => invokeAndRender(MESSAGE_TYPES.RESUME_QUEUE));
    elements.stopBtn.addEventListener("click", () => invokeAndRender(MESSAGE_TYPES.STOP_QUEUE));
    elements.clearCompletedBtn.addEventListener("click", () =>
      invokeAndRender(MESSAGE_TYPES.CLEAR_COMPLETED)
    );
    if (elements.clearFailedBtn) {
      elements.clearFailedBtn.addEventListener("click", () => invokeAndRender(CLEAR_FAILED_TYPE));
    }
    elements.clearAllBtn.addEventListener("click", () =>
      invokeAndRender(MESSAGE_TYPES.CLEAR_ALL_TASKS)
    );
    if (elements.exportTasksBtn) {
      elements.exportTasksBtn.addEventListener("click", onExportTasks);
    }
    if (elements.exportLogsBtn) {
      elements.exportLogsBtn.addEventListener("click", onExportLogs);
    }
    elements.clearLogsBtn.addEventListener("click", () => invokeAndRender(MESSAGE_TYPES.CLEAR_LOGS));
    if (elements.taskList) {
      elements.taskList.addEventListener("click", onTaskListClick);
      elements.taskList.addEventListener("change", onTaskListChange);
    }

    if (elements.clearDraftBtn) {
      elements.clearDraftBtn.addEventListener("click", onClearDraft);
    }

    bindDraftAutosave();
  }

  function bindDraftAutosave() {
    bindControlEvents(elements.promptInput, {
      persistDraft: true,
      syncSettings: false
    });

    for (const element of getSettingControls()) {
      bindControlEvents(element, {
        persistDraft: true,
        syncSettings: true
      });
    }

    for (const element of getDraftOnlyControls()) {
      bindControlEvents(element, {
        persistDraft: true,
        syncSettings: false
      });
    }
  }

  function bindControlEvents(element, options) {
    if (!element) {
      return;
    }

    const handler = () => {
      if (isHydratingForm) {
        return;
      }

      latestDraft = buildPopupDraftFromForm();

      if (options.persistDraft) {
        debouncedPersistDraft();
      }
      if (options.syncSettings) {
        debouncedSyncSettings();
      }
    };

    element.addEventListener("input", handler);
    element.addEventListener("change", handler);
  }

  function getSettingControls() {
    return [
      elements.intervalMode,
      elements.fixedIntervalSec,
      elements.randomMinSec,
      elements.randomMaxSec,
      elements.retryLimit,
      elements.detectTimeoutSec,
      elements.downloadSubfolder,
      elements.filenamePrefix,
      elements.autoDownload,
      elements.autoSelectCreateImage,
      elements.debugMode
    ].filter(Boolean);
  }

  function getDraftOnlyControls() {
    return [
      elements.rootFolder,
      elements.subFolder,
      elements.filePrefix,
      elements.useDateFolder,
      elements.fixedDelaySec,
      elements.randomDelayMinSec,
      elements.randomDelayMaxSec,
      elements.cooldownSec
    ].filter(Boolean);
  }

  async function onAddPrompts() {
    const lines = elements.promptInput.value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) {
      setStatusText("Please enter at least one prompt");
      return;
    }

    const state = await invokeRaw(MESSAGE_TYPES.IMPORT_PROMPTS, {
      prompts: lines,
      draftPolicy: "keep"
    });
    latestState = state;
    latestDraft = buildPopupDraftFromForm();
    debouncedPersistDraft();
    render(state);
  }

  async function onImportFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const prompts = parsePromptFile(text, file);

      if (!prompts.length) {
        setStatusText("The selected file contains no prompts");
        event.target.value = "";
        return;
      }

      const nextPromptText = prompts.join("\n");
      const currentDraftText = getTextValue(elements.promptInput);
      if (shouldConfirmDraftReplacement(currentDraftText, nextPromptText)) {
        const confirmed = globalThis.confirm(buildDraftReplaceMessage());
        if (!confirmed) {
          setStatusText("已取消导入，保留当前草稿");
          return;
        }
      }

      if (elements.promptInput) {
        elements.promptInput.value = nextPromptText;
      }

      const state = await invokeRaw(MESSAGE_TYPES.IMPORT_PROMPTS, {
        prompts,
        draftPolicy: "replace"
      });
      latestState = state;
      latestDraft = buildPopupDraftFromForm();
      debouncedPersistDraft();
      render(state);
    } finally {
      event.target.value = "";
    }
  }

  function parsePromptFile(text, file) {
    const filename = String((file && file.name) || "").toLowerCase();
    const type = String((file && file.type) || "").toLowerCase();
    if (filename.endsWith(".csv") || type.includes("csv")) {
      return parseCsvPrompts(text);
    }

    return parseLinePrompts(text);
  }

  function parseLinePrompts(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function parseCsvPrompts(text) {
    const rows = parseCsvRows(text);
    if (!rows.length) {
      return [];
    }

    const header = rows[0].map((cell) => normalizeCsvHeader(cell));
    const promptColumn = header.findIndex((name) =>
      ["prompt", "prompts", "提示词", "关键词"].includes(name)
    );
    const dataRows = promptColumn >= 0 ? rows.slice(1) : rows;
    const prompts = [];

    for (const row of dataRows) {
      const cells = promptColumn >= 0 ? [row[promptColumn]] : row;
      for (const cell of cells) {
        const prompt = String(cell || "").trim();
        if (prompt) {
          prompts.push(prompt);
        }
      }
    }

    return prompts;
  }

  function normalizeCsvHeader(value) {
    return String(value || "")
      .replace(/^\uFEFF/, "")
      .trim()
      .toLowerCase();
  }

  function parseCsvRows(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let inQuotes = false;
    const source = String(text || "");

    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      const next = source[index + 1];

      if (char === '"') {
        if (inQuotes && next === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (char === "," && !inQuotes) {
        row.push(cell);
        cell = "";
        continue;
      }

      if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && next === "\n") {
          index += 1;
        }
        row.push(cell);
        if (row.some((value) => String(value || "").trim())) {
          rows.push(row);
        }
        row = [];
        cell = "";
        continue;
      }

      cell += char;
    }

    row.push(cell);
    if (row.some((value) => String(value || "").trim())) {
      rows.push(row);
    }

    return rows;
  }

  async function onSaveSettings() {
    latestDraft = buildPopupDraftFromForm();
    await persistDraftToStorage();
    await syncSettingsToBackground(true);
  }

  async function onClearDraft() {
    try {
      if (elements.fileInput) {
        elements.fileInput.value = "";
      }
      const state = await invokeRaw(MESSAGE_TYPES.CLEAR_DRAFT);
      latestState = state;
      latestDraft = normalizePopupDraft(
        Object.assign({}, latestDraft, {
          promptText: ""
        })
      );
      render(state);
      setStatusText("草稿已清空");
    } catch (error) {
      console.warn("[popup] clear draft failed", error);
      setStatusText(error.message || String(error));
    }
  }

  async function onTaskListClick(event) {
    if (!(event.target instanceof Element)) {
      return;
    }

    const button = event.target.closest(".task-action");
    if (!button || button.disabled) {
      return;
    }

    const taskId = button.dataset.taskId || "";
    if (!taskId) {
      return;
    }

    if (button.classList.contains("retry-task")) {
      await invokeAndRender(RETRY_TASK_TYPE, { taskId });
      return;
    }

    if (button.classList.contains("delete-task")) {
      await invokeAndRender(DELETE_TASK_TYPE, { taskId });
      return;
    }
  }

  async function onTaskListChange(event) {
    if (!(event.target instanceof HTMLInputElement)) {
      return;
    }

    if (!event.target.classList.contains("task-sequence-input")) {
      return;
    }

    const taskId = event.target.dataset.taskId || "";
    const sequenceNumber = Number(event.target.value);
    if (!taskId || !Number.isInteger(sequenceNumber) || sequenceNumber <= 0) {
      setStatusText("序号必须是大于 0 的整数");
      render(latestState);
      return;
    }

    try {
      const state = await invokeRaw(UPDATE_TASK_SEQUENCE_TYPE, {
        taskId,
        sequenceNumber
      });
      latestState = state;
      render(state);
      setStatusText(`序号已更新为 ${sequenceNumber}`);
    } catch (error) {
      console.warn("[popup] update task sequence failed", error);
      setStatusText(error.message || String(error));
      render(latestState);
    }
  }

  function canEditTaskSequence(task) {
    const status = String((task && task.status) || "pending").toLowerCase();
    return !["running", "downloading"].includes(status);
  }

  async function onExportLogs() {
    try {
      const state = await requestState();
      latestState = state;
      render(state);
      await exportLogs(state.logs || []);
      setStatusText("日志导出已开始");
    } catch (error) {
      console.warn("[popup] export logs failed", error);
      setStatusText(error.message || String(error));
    }
  }

  async function onExportTasks() {
    try {
      const state = await requestState();
      latestState = state;
      render(state);
      await exportTasks(state.tasks || []);
      setStatusText("任务列表导出已开始");
    } catch (error) {
      console.warn("[popup] export tasks failed", error);
      setStatusText(error.message || String(error));
    }
  }

  async function refreshState() {
    try {
      const state = await requestState();
      latestState = state;
      render(state);
    } catch (error) {
      console.error("[popup] refreshState failed", error);
      setStatusText(error.message || String(error));
    }
  }

  async function persistDraftToStorage() {
    try {
      latestDraft = buildPopupDraftFromForm();
      await chrome.storage.local.set({
        [POPUP_DRAFT_KEY]: latestDraft
      });
    } catch (error) {
      console.warn("[popup] persistDraftToStorage failed", error);
    }
  }

  async function syncSettingsToBackground(saveUndo) {
    const settings = buildSettingsPayloadFromForm();

    try {
      const state = await invokeRaw(MESSAGE_TYPES.UPDATE_SETTINGS, {
        settings,
        saveUndo: Boolean(saveUndo)
      });
      latestState = state;
      render(state);
    } catch (error) {
      console.warn("[popup] syncSettingsToBackground failed", error);
      setStatusText(error.message || String(error));
    }
  }

  async function requestState() {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.GET_STATE
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || "Request failed");
    }

    return response.result;
  }

  async function invokeRaw(type, payload) {
    const response = await chrome.runtime.sendMessage(Object.assign({ type }, payload || {}));
    if (!response || !response.ok) {
      throw new Error((response && response.error) || "Request failed");
    }
    return response.result;
  }

  async function invokeAndRender(type, payload) {
    try {
      const result = await invokeRaw(type, payload);
      latestState = result;
      render(result);
      return result;
    } catch (error) {
      setStatusText(error.message || String(error));
      throw error;
    }
  }

  function render(state) {
    const safeState = state || latestState || createEmptyState();
    renderForm(safeState.settings || DEFAULT_SETTINGS);
    renderSummary(safeState);
    renderOverallProgress(safeState.tasks || []);
    renderTasks(safeState.tasks || []);
    renderLogs(safeState.logs || []);
    setStatusText(buildQueueText(safeState.runtime || {}, safeState.summary || {}));
  }

  function renderForm(settings) {
    const merged = mergeDraftWithSettings(settings || DEFAULT_SETTINGS, latestDraft);

    isHydratingForm = true;
    try {
      setElementValue(elements.promptInput, merged.promptText);
      setElementValue(elements.intervalMode, merged.intervalMode);
      setElementValue(elements.fixedIntervalSec, merged.fixedIntervalSec);
      setElementValue(elements.randomMinSec, merged.randomMinSec);
      setElementValue(elements.randomMaxSec, merged.randomMaxSec);
      setElementValue(elements.retryLimit, merged.retryLimit);
      setElementValue(elements.detectTimeoutSec, merged.detectTimeoutSec);
      setElementValue(elements.downloadSubfolder, merged.downloadSubfolder);
      setElementValue(elements.filenamePrefix, merged.filenamePrefix);
      setElementChecked(elements.autoDownload, merged.autoDownload);
      setElementChecked(elements.autoSelectCreateImage, merged.autoSelectCreateImage);
      setElementChecked(elements.debugMode, merged.debugMode);

      setElementValue(elements.rootFolder, merged.rootFolder);
      setElementValue(elements.subFolder, merged.subFolder);
      setElementValue(elements.filePrefix, merged.filePrefix);
      setElementChecked(elements.useDateFolder, merged.useDateFolder);
      setElementValue(elements.fixedDelaySec, merged.fixedDelaySec);
      setElementValue(elements.randomDelayMinSec, merged.randomDelayMinSec);
      setElementValue(elements.randomDelayMaxSec, merged.randomDelayMaxSec);
      setElementValue(elements.cooldownSec, merged.cooldownSec);
    } finally {
      isHydratingForm = false;
    }
  }

  function mergeDraftWithSettings(settings, draft) {
    const normalizedSettings = normalizeSettings(
      Object.assign({}, DEFAULT_SETTINGS, settings || {})
    );

    return {
      promptText: getDraftValue(draft, ["promptText"], ""),
      intervalMode: getDraftValue(draft, ["intervalMode"], normalizedSettings.intervalMode),
      fixedIntervalSec: getDraftValue(
        draft,
        ["fixedIntervalSec", "fixedDelaySec"],
        normalizedSettings.fixedIntervalSec
      ),
      randomMinSec: getDraftValue(
        draft,
        ["randomMinSec", "randomDelayMinSec"],
        normalizedSettings.randomMinSec
      ),
      randomMaxSec: getDraftValue(
        draft,
        ["randomMaxSec", "randomDelayMaxSec"],
        normalizedSettings.randomMaxSec
      ),
      retryLimit: getDraftValue(draft, ["retryLimit"], normalizedSettings.retryLimit),
      detectTimeoutSec: getDraftValue(
        draft,
        ["detectTimeoutSec"],
        normalizedSettings.detectTimeoutSec
      ),
      downloadSubfolder: getDraftValue(
        draft,
        ["downloadSubfolder", "subFolder"],
        normalizedSettings.downloadSubfolder
      ),
      filenamePrefix: getDraftValue(
        draft,
        ["filenamePrefix", "filePrefix"],
        normalizedSettings.filenamePrefix
      ),
      autoDownload: getDraftValue(
        draft,
        ["autoDownload"],
        normalizedSettings.autoDownload
      ),
      autoSelectCreateImage: getDraftValue(
        draft,
        ["autoSelectCreateImage"],
        normalizedSettings.autoSelectCreateImage
      ),
      debugMode: getDraftValue(draft, ["debugMode"], Boolean(normalizedSettings.debugMode)),
      rootFolder: getDraftValue(draft, ["rootFolder"], ""),
      subFolder: getDraftValue(
        draft,
        ["subFolder", "downloadSubfolder"],
        normalizedSettings.downloadSubfolder
      ),
      filePrefix: getDraftValue(
        draft,
        ["filePrefix", "filenamePrefix"],
        normalizedSettings.filenamePrefix
      ),
      useDateFolder: getDraftValue(draft, ["useDateFolder"], false),
      fixedDelaySec: getDraftValue(
        draft,
        ["fixedDelaySec", "fixedIntervalSec"],
        normalizedSettings.fixedIntervalSec
      ),
      randomDelayMinSec: getDraftValue(
        draft,
        ["randomDelayMinSec", "randomMinSec"],
        normalizedSettings.randomMinSec
      ),
      randomDelayMaxSec: getDraftValue(
        draft,
        ["randomDelayMaxSec", "randomMaxSec"],
        normalizedSettings.randomMaxSec
      ),
      cooldownSec: getDraftValue(draft, ["cooldownSec"], "")
    };
  }

  function buildPopupDraftFromForm() {
    const draft = {
      promptText: getTextValue(elements.promptInput),
      rootFolder: getTextValue(elements.rootFolder),
      subFolder: getTextValue(elements.subFolder) || getTextValue(elements.downloadSubfolder),
      filePrefix: getTextValue(elements.filePrefix) || getTextValue(elements.filenamePrefix),
      useDateFolder: getCheckedValue(elements.useDateFolder),
      fixedDelaySec: getTextValue(elements.fixedDelaySec) || getTextValue(elements.fixedIntervalSec),
      randomDelayMinSec:
        getTextValue(elements.randomDelayMinSec) || getTextValue(elements.randomMinSec),
      randomDelayMaxSec:
        getTextValue(elements.randomDelayMaxSec) || getTextValue(elements.randomMaxSec),
      cooldownSec: getTextValue(elements.cooldownSec),
      retryLimit: getTextValue(elements.retryLimit),
      autoDownload: getCheckedValue(elements.autoDownload),
      autoSelectCreateImage: getCheckedValue(elements.autoSelectCreateImage),
      debugMode: getCheckedValue(elements.debugMode),
      intervalMode: getTextValue(elements.intervalMode),
      fixedIntervalSec: getTextValue(elements.fixedIntervalSec),
      randomMinSec: getTextValue(elements.randomMinSec),
      randomMaxSec: getTextValue(elements.randomMaxSec),
      detectTimeoutSec: getTextValue(elements.detectTimeoutSec),
      downloadSubfolder: getTextValue(elements.downloadSubfolder),
      filenamePrefix: getTextValue(elements.filenamePrefix)
    };

    return normalizePopupDraft(draft);
  }

  function buildSettingsPayloadFromForm() {
    return normalizeSettings({
      intervalMode: getTextValue(elements.intervalMode) || DEFAULT_SETTINGS.intervalMode,
      fixedIntervalSec: getTextValue(elements.fixedIntervalSec),
      randomMinSec: getTextValue(elements.randomMinSec),
      randomMaxSec: getTextValue(elements.randomMaxSec),
      retryLimit: getTextValue(elements.retryLimit),
      detectTimeoutSec: getTextValue(elements.detectTimeoutSec),
      downloadSubfolder: getTextValue(elements.downloadSubfolder),
      filenamePrefix: getTextValue(elements.filenamePrefix),
      autoDownload: getCheckedValue(elements.autoDownload),
      autoSelectCreateImage: getCheckedValue(elements.autoSelectCreateImage),
      debugMode: getCheckedValue(elements.debugMode)
    });
  }

  function normalizePopupDraft(rawDraft) {
    if (!rawDraft || typeof rawDraft !== "object") {
      return {};
    }

    const draft = Object.assign({}, rawDraft);

    if (draft.fixedIntervalSec === undefined && draft.fixedDelaySec !== undefined) {
      draft.fixedIntervalSec = draft.fixedDelaySec;
    }
    if (draft.randomMinSec === undefined && draft.randomDelayMinSec !== undefined) {
      draft.randomMinSec = draft.randomDelayMinSec;
    }
    if (draft.randomMaxSec === undefined && draft.randomDelayMaxSec !== undefined) {
      draft.randomMaxSec = draft.randomDelayMaxSec;
    }
    if (draft.downloadSubfolder === undefined && draft.subFolder !== undefined) {
      draft.downloadSubfolder = draft.subFolder;
    }
    if (draft.filenamePrefix === undefined && draft.filePrefix !== undefined) {
      draft.filenamePrefix = draft.filePrefix;
    }

    return draft;
  }

  function renderSummary(state) {
    const summary = state.summary || {};
    const runtime = state.runtime || {};
    elements.summary.innerHTML = [
      `<div>Mode: <strong>${escapeHtml(runtime.mode || "idle")}</strong></div>`,
      `<div>Total: <strong>${summary.total || 0}</strong></div>`,
      `<div>Success: <strong>${(summary.success || 0) + (summary.downloaded || 0)}</strong></div>`,
      `<div>Failed: <strong>${summary.failed || 0}</strong></div>`
    ].join("");
  }

  function getOverallProgressMeta(tasks) {
    const list = Array.isArray(tasks) ? tasks : [];
    const meta = {
      total: list.length,
      completed: 0,
      failed: 0,
      active: 0,
      pending: 0,
      percent: 0,
      colorClass: "overall-gray",
      text: "暂无任务"
    };

    for (const task of list) {
      const status = String((task && task.status) || "pending").toLowerCase();
      if (status === "success" || status === "downloaded") {
        meta.completed += 1;
      } else if (status === "failed" || status === "stopped") {
        meta.failed += 1;
      } else if (status === "waiting" || status === "running" || status === "downloading") {
        meta.active += 1;
      } else {
        meta.pending += 1;
      }
    }

    if (!meta.total) {
      return meta;
    }

    const handled = meta.completed + meta.failed;
    meta.percent = Math.round((handled / meta.total) * 100);

    if (meta.completed === meta.total && meta.failed === 0) {
      meta.colorClass = "overall-green";
      meta.text = `总进度：${meta.completed}/${meta.total} · 100% · 全部完成`;
      return meta;
    }

    meta.colorClass = "overall-blue";
    meta.text = `总进度：${handled}/${meta.total} · ${meta.percent}% · 失败 ${meta.failed}`;
    return meta;
  }

  function renderOverallProgress(tasks) {
    if (!elements.overallProgress) {
      return;
    }

    const meta = getOverallProgressMeta(tasks);
    const safePercent = Math.max(0, Math.min(100, meta.percent));

    elements.overallProgress.innerHTML = `
      <div class="overall-progress-card">
        <div class="overall-progress-head">
          <strong>总任务进度</strong>
          <span>${escapeHtml(meta.text)}</span>
        </div>
        <div class="overall-progress-bar">
          <div
            class="overall-progress-fill ${escapeHtml(meta.colorClass)}"
            style="width: ${safePercent}%;"
          ></div>
        </div>
        <div class="overall-progress-stats">
          <span>总数 ${meta.total}</span>
          <span>完成 ${meta.completed}</span>
          <span>失败 ${meta.failed}</span>
          <span>进行中 ${meta.active}</span>
          <span>未开始 ${meta.pending}</span>
        </div>
      </div>
    `;
  }

  function getTaskProgressMeta(task) {
    const status = String((task && task.status) || "pending").toLowerCase();

    switch (status) {
      case "waiting":
        return { percent: 25, colorClass: "progress-blue", statusText: "等待中" };
      case "running":
        return { percent: 60, colorClass: "progress-blue", statusText: "生成中" };
      case "downloading":
        return { percent: 85, colorClass: "progress-blue", statusText: "下载中" };
      case "success":
      case "downloaded":
        return { percent: 100, colorClass: "progress-green", statusText: "已完成" };
      case "failed":
        return { percent: 100, colorClass: "progress-red", statusText: "失败" };
      case "stopped":
        return { percent: 100, colorClass: "progress-red", statusText: "已停止" };
      case "pending":
      default:
        return { percent: 8, colorClass: "progress-gray", statusText: "未开始" };
    }
  }

  function getTaskCardStateClass(task) {
    const status = String((task && task.status) || "pending").toLowerCase();

    if (status === "running" || status === "downloading") {
      return "task-card-active";
    }
    if (status === "waiting") {
      return "task-card-waiting";
    }
    if (status === "failed" || status === "stopped") {
      return "task-card-error";
    }
    if (status === "success" || status === "downloaded") {
      return "task-card-done";
    }
    return "";
  }

  function canRetryTask(task) {
    const status = String((task && task.status) || "pending").toLowerCase();
    return ["failed", "stopped", "success", "downloaded"].includes(status);
  }

  function canDeleteTask(task) {
    return Boolean(task && task.id);
  }

  function renderTasks(tasks) {
    elements.taskList.innerHTML = "";
    if (!tasks.length) {
      lastScrolledActiveTaskId = "";
      elements.taskList.innerHTML = '<div class="empty">No tasks yet</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const task of tasks.slice().sort((a, b) => a.createdAt - b.createdAt)) {
      const progress = getTaskProgressMeta(task);
      const stateClass = getTaskCardStateClass(task);
      const retryDisabled = canRetryTask(task) ? "" : " disabled";
      const deleteDisabled = canDeleteTask(task) ? "" : " disabled";
      const sequenceDisabled = canEditTaskSequence(task) ? "" : " disabled";
      const sequenceNumber = Number.isInteger(task.sequenceNumber) && task.sequenceNumber > 0
        ? task.sequenceNumber
        : "";
      const card = document.createElement("article");
      card.className = stateClass ? `task-card ${stateClass}` : "task-card";
      card.dataset.taskId = task.id || "";
      card.dataset.taskStatus = task.status || "";
      card.innerHTML = `
        <div class="task-head">
          <div class="task-name">${escapeHtml(task.filename)}</div>
          <span class="badge ${escapeHtml(task.status)}">${escapeHtml(progress.statusText)}</span>
        </div>
        <label class="task-sequence-control">
          <span>下载序号</span>
          <input
            class="task-sequence-input"
            type="number"
            min="1"
            step="1"
            inputmode="numeric"
            value="${escapeHtml(sequenceNumber)}"
            data-task-id="${escapeHtml(task.id || "")}"
            ${sequenceDisabled}
          >
        </label>
        <div class="task-prompt">${escapeHtml(task.prompt)}</div>
        <div class="task-prompt">Retries: ${task.retries || 0} | Images: ${task.imageCount || 0}</div>
        ${
          task.lastError
            ? `<div class="task-prompt">Error: ${escapeHtml(task.lastError)}</div>`
            : ""
        }
        <div class="task-progress">
          <div class="task-progress-bar">
            <div
              class="task-progress-fill ${escapeHtml(progress.colorClass)}"
              style="width: ${progress.percent}%;"
            ></div>
          </div>
          <div class="task-progress-text">${escapeHtml(progress.statusText)} · ${
            progress.percent
          }%</div>
        </div>
        <div class="task-actions">
          <button
            class="task-action retry-task"
            type="button"
            data-task-id="${escapeHtml(task.id || "")}"
            ${retryDisabled}
          >重跑</button>
          <button
            class="task-action delete-task"
            type="button"
            data-task-id="${escapeHtml(task.id || "")}"
            ${deleteDisabled}
          >删除</button>
        </div>
      `;
      fragment.appendChild(card);
    }

    elements.taskList.appendChild(fragment);
    scrollActiveTaskIntoView();
  }

  function scrollActiveTaskIntoView() {
    if (!elements.taskList) {
      return;
    }

    const activeCard = elements.taskList.querySelector(".task-card-active");
    if (!activeCard) {
      lastScrolledActiveTaskId = "";
      return;
    }

    const activeTaskId = activeCard.dataset.taskId || "";
    if (activeTaskId && activeTaskId === lastScrolledActiveTaskId) {
      return;
    }

    lastScrolledActiveTaskId = activeTaskId;
    requestAnimationFrame(() => {
      activeCard.scrollIntoView({
        block: "nearest",
        behavior: "smooth"
      });
    });
  }

  function renderLogs(logs) {
    elements.logList.innerHTML = "";
    if (!logs.length) {
      elements.logList.innerHTML = '<div class="empty">No logs yet</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const log of logs.slice(0, 100)) {
      const item = document.createElement("article");
      item.className = "log-item";
      item.innerHTML = `
        <div class="log-head">
          <strong>${escapeHtml(log.level || "info")}</strong>
          <span>${formatTime(log.timestamp)}</span>
        </div>
        <div class="log-message">${escapeHtml(log.message || "")}</div>
      `;
      fragment.appendChild(item);
    }

    elements.logList.appendChild(fragment);
  }

  async function exportLogs(logs) {
    const exportDate = new Date();
    const list = Array.isArray(logs) ? logs.slice() : [];
    list.sort((a, b) => Number(a && a.timestamp ? a.timestamp : 0) - Number(b && b.timestamp ? b.timestamp : 0));

    const lines = [
      "ChatGPT 批量生图插件日志导出",
      `导出时间：${formatExportDate(exportDate)}`,
      `日志数量：${list.length}`,
      "",
      "-----------------------------------"
    ];

    if (!list.length) {
      lines.push("暂无日志");
    }

    for (const log of list) {
      const timestamp = log && log.timestamp ? formatExportDate(new Date(log.timestamp)) : "--";
      const level = log && log.level ? log.level : "info";
      const message = log && log.message ? log.message : "";
      lines.push(`[${timestamp}] [${level}] ${message}`);

      if (log && log.taskId) {
        lines.push(`taskId: ${log.taskId}`);
      }

      lines.push("");
    }

    lines.push("-----------------------------------");

    const filename = `batch-image-logs_${formatExportDate(exportDate, true)}.txt`;
    await downloadTextFile(filename, lines.join("\n"), "text/plain;charset=utf-8");
  }

  async function exportTasks(tasks) {
    const exportDate = new Date();
    const list = Array.isArray(tasks) ? tasks : [];
    const payload = {
      exportedAt: exportDate.getTime(),
      exportedAtText: formatExportDate(exportDate),
      total: list.length,
      tasks: list
    };

    const filename = `batch-image-tasks_${formatExportDate(exportDate, true)}.json`;
    await downloadTextFile(
      filename,
      JSON.stringify(payload, null, 2),
      "application/json;charset=utf-8"
    );
  }

  async function downloadTextFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);

    try {
      await chrome.downloads.download({
        url,
        filename,
        saveAs: true
      });
    } finally {
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);
    }
  }

  function createEmptyState() {
    return {
      settings: DEFAULT_SETTINGS,
      tasks: [],
      logs: [],
      runtime: {},
      summary: {}
    };
  }

  function getDraftValue(draft, keys, fallback) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(draft || {}, key)) {
        return draft[key];
      }
    }
    return fallback;
  }

  function getTextValue(element) {
    return element ? String(element.value || "") : "";
  }

  function getCheckedValue(element) {
    return element ? Boolean(element.checked) : false;
  }

  function setElementValue(element, value) {
    if (!element) {
      return;
    }
    element.value = value === undefined || value === null ? "" : String(value);
  }

  function setElementChecked(element, value) {
    if (!element) {
      return;
    }
    element.checked = Boolean(value);
  }

  function setStatusText(text) {
    elements.queueStatusText.textContent = text;
  }

  function buildQueueText(runtime, summary) {
    return `Mode ${runtime.mode || "idle"}, running ${summary.running || 0}, waiting ${
      summary.waiting || 0
    }, pending ${summary.pending || 0}`;
  }

  function formatTime(timestamp) {
    if (!timestamp) {
      return "--:--:--";
    }

    return new Date(timestamp).toLocaleTimeString("zh-CN", {
      hour12: false
    });
  }

  function formatExportDate(date, filenameSafe) {
    const value = date instanceof Date ? date : new Date(date);
    const year = value.getFullYear();
    const month = pad2(value.getMonth() + 1);
    const day = pad2(value.getDate());
    const hour = pad2(value.getHours());
    const minute = pad2(value.getMinutes());
    const second = pad2(value.getSeconds());

    if (filenameSafe) {
      return `${year}-${month}-${day}_${hour}-${minute}-${second}`;
    }

    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function debounce(fn, waitMs) {
    let timerId = null;

    return (...args) => {
      if (timerId) {
        clearTimeout(timerId);
      }
      timerId = setTimeout(() => {
        timerId = null;
        fn(...args);
      }, waitMs);
    };
  }
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    buildDraftReplaceMessage,
    normalizePromptDraftText,
    shouldConfirmDraftReplacement
  };
}
