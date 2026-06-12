(function () {
  function createBackgroundStateHelpers(deps) {
    const {
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
    } = deps;

    function createIdleRuntime(runtime) {
      return Object.assign({}, runtime, {
        mode: QUEUE_MODE.IDLE,
        currentTaskId: null,
        activeTabId: null,
        targetTabId: null,
        lastScheduleAt: null,
        stopRequested: false,
        pausedUntil: null,
        pauseReason: "",
        currentTaskStartedAt: null
      });
    }

    function buildStopQueueRuntime(runtime) {
      if (!runtime.currentTaskId) {
        return createIdleRuntime(runtime);
      }

      return Object.assign({}, runtime, {
        mode: QUEUE_MODE.STOPPING,
        stopRequested: true,
        pausedUntil: null,
        pauseReason: ""
      });
    }

    function normalizeTasksForUndo(tasks, runtime) {
      const currentTaskId = runtime && runtime.currentTaskId;
      return (Array.isArray(tasks) ? tasks : []).map((task) => {
        if (!task || typeof task !== "object") {
          return task;
        }

        if (
          task.id === currentTaskId &&
          (task.status === "running" || task.status === "downloading")
        ) {
          return Object.assign({}, task, {
            status: "pending",
            readyAt: null,
            lastError: ""
          });
        }

        return task;
      });
    }

    function buildUndoRestoreState(snapshot) {
      const snapshotRuntime = Object.assign({}, DEFAULT_RUNTIME, snapshot.runtime || {});
      const shouldRestoreAsPaused =
        snapshotRuntime.mode === QUEUE_MODE.RUNNING || snapshotRuntime.mode === QUEUE_MODE.STOPPING;

      const runtime = shouldRestoreAsPaused
        ? Object.assign({}, snapshotRuntime, {
            mode: "paused",
            currentTaskId: null,
            activeTabId: null,
            targetTabId: null,
            stopRequested: false,
            pausedUntil: null,
            pauseReason: ""
          })
        : Object.assign({}, snapshotRuntime, {
            currentTaskId: snapshotRuntime.currentTaskId || null,
            activeTabId: snapshotRuntime.activeTabId || null,
            targetTabId: snapshotRuntime.targetTabId || null,
            stopRequested: Boolean(snapshotRuntime.stopRequested),
            pausedUntil: snapshotRuntime.pausedUntil || null,
            pauseReason: snapshotRuntime.pauseReason || ""
          });

      return {
        settings: normalizeSettings
          ? normalizeSettings((snapshot && snapshot.settings) || DEFAULT_SETTINGS)
          : Object.assign({}, DEFAULT_SETTINGS, snapshot.settings || {}),
        tasks: normalizeTaskSequenceNumbers
          ? normalizeTaskSequenceNumbers(normalizeTasksForUndo(snapshot.tasks || [], snapshotRuntime))
          : normalizeTasksForUndo(snapshot.tasks || [], snapshotRuntime),
        logs: Array.isArray(snapshot.logs) ? snapshot.logs : [],
        runtime,
        popupDraft:
          snapshot.popupDraft && typeof snapshot.popupDraft === "object" ? snapshot.popupDraft : {}
      };
    }

    async function saveUndoSnapshot(action, state) {
      const snapshot = {
        id: generateId("undo"),
        action,
        createdAt: now(),
        tasks: cloneForStorage(state.tasks || []),
        logs: cloneForStorage(state.logs || []),
        runtime: cloneForStorage(state.runtime || DEFAULT_RUNTIME),
        settings: cloneForStorage(state.settings || DEFAULT_SETTINGS),
        popupDraft: cloneForStorage(state.popupDraft || {})
      };
      const undoStack = [snapshot].concat(state.undoStack || []).slice(0, UNDO_LIMIT);
      await setState({ [STORAGE_KEYS.UNDO_STACK]: undoStack });
    }

    return {
      createIdleRuntime,
      buildStopQueueRuntime,
      normalizeTasksForUndo,
      buildUndoRestoreState,
      saveUndoSnapshot
    };
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      createBackgroundStateHelpers
    };
    return;
  }

  globalThis.BatchImageBackgroundState = {
    createBackgroundStateHelpers
  };
})();
