(function () {
  function createBackgroundQueueHelpers(deps) {
    const {
      TASK_STATUS,
      createTaskFromInput,
      getNextTaskSequenceNumber,
      getEarliestOpenBatchId,
      generateId,
      now
    } = deps;

    function normalizePromptDraftText(value) {
      return String(value || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");
    }

    function promptsToDraftText(rawPrompts) {
      return normalizePromptInputs(rawPrompts)
        .map((item) => (typeof item === "string" ? item : item.prompt))
        .join("\n");
    }

    function getPopupDraftState(rawDraft) {
      const promptText = normalizePromptDraftText(rawDraft && rawDraft.promptText);
      return {
        promptText,
        hasPrompt: Boolean(promptText)
      };
    }

    function resolveImportDraftPlan(currentDraftText, rawPrompts, draftPolicy) {
      const existingDraftText = normalizePromptDraftText(currentDraftText);
      const nextDraftText = promptsToDraftText(rawPrompts);
      const hasConflict = Boolean(existingDraftText && nextDraftText && existingDraftText !== nextDraftText);

      if (hasConflict && draftPolicy !== "replace" && draftPolicy !== "keep") {
        return {
          hasConflict: true,
          requiresChoice: true,
          shouldUpdateDraft: false,
          nextDraftText: existingDraftText
        };
      }

      if (draftPolicy === "keep") {
        return {
          hasConflict,
          requiresChoice: false,
          shouldUpdateDraft: false,
          nextDraftText: existingDraftText
        };
      }

      return {
        hasConflict,
        requiresChoice: false,
        shouldUpdateDraft: Boolean(nextDraftText),
        nextDraftText
      };
    }

    function normalizePromptInputs(rawPrompts) {
      return (Array.isArray(rawPrompts) ? rawPrompts : [])
        .map((item) => {
          if (typeof item === "string") {
            return item.trim();
          }

          if (!item || typeof item !== "object") {
            return "";
          }

          const prompt = String(item.prompt || "").trim();
          if (!prompt) {
            return "";
          }

          return {
            prompt,
            filename: String(item.filename || "").trim(),
            sequenceNumber: item.sequenceNumber
          };
        })
        .filter(Boolean);
    }

    function buildImportedTasks(rawPrompts, existingTasks, settings, options) {
      const inputs = normalizePromptInputs(rawPrompts);
      if (!inputs.length) {
        throw new Error("No prompts to import");
      }

      const existing = Array.isArray(existingTasks) ? existingTasks : [];
      const batchId =
        options && typeof options.createBatchId === "function"
          ? options.createBatchId()
          : generateId("batch");
      const batchCreatedAt =
        options && typeof options.getNow === "function" ? options.getNow() : now();
      const startSequenceNumber = getNextTaskSequenceNumber(existing);

      return inputs.map((input, index) =>
        createTaskFromInput(
          Object.assign({}, typeof input === "string" ? { prompt: input } : input, {
            batchId,
            batchCreatedAt,
            sequenceNumber: startSequenceNumber + index
          }),
          index,
          settings
        )
      );
    }

    function pickNextRunnableTask(tasks, currentTime) {
      const legacyOpenTasks = (tasks || []).filter(
        (task) =>
          task &&
          !task.batchId &&
          [TASK_STATUS.PENDING, TASK_STATUS.WAITING].includes(task.status)
      );

      if (legacyOpenTasks.length) {
        const runnableLegacyTasks = legacyOpenTasks
          .filter((task) => !task.readyAt || task.readyAt <= currentTime)
          .sort((a, b) => a.createdAt - b.createdAt);

        if (runnableLegacyTasks.length) {
          return {
            task: runnableLegacyTasks[0],
            nextWakeAt: null,
            activeBatchId: ""
          };
        }

        const legacyWaitingTimes = legacyOpenTasks
          .filter((task) => task.status === TASK_STATUS.WAITING && task.readyAt)
          .map((task) => task.readyAt)
          .sort((a, b) => a - b);

        return {
          task: null,
          nextWakeAt: legacyWaitingTimes.length ? legacyWaitingTimes[0] : null,
          activeBatchId: ""
        };
      }

      const activeBatchId = getEarliestOpenBatchId(tasks);
      if (!activeBatchId) {
        return {
          task: null,
          nextWakeAt: null,
          activeBatchId: ""
        };
      }

      const activeBatchTasks = (tasks || []).filter((task) => task && task.batchId === activeBatchId);
      const runnableTasks = activeBatchTasks
        .filter((task) => {
          if (![TASK_STATUS.PENDING, TASK_STATUS.WAITING].includes(task.status)) {
            return false;
          }
          return !task.readyAt || task.readyAt <= currentTime;
        })
        .sort((a, b) => a.createdAt - b.createdAt);

      if (runnableTasks.length) {
        return {
          task: runnableTasks[0],
          nextWakeAt: null,
          activeBatchId
        };
      }

      const waitingTimes = activeBatchTasks
        .filter((task) => task.status === TASK_STATUS.WAITING && task.readyAt)
        .map((task) => task.readyAt)
        .sort((a, b) => a - b);

      return {
        task: null,
        nextWakeAt: waitingTimes.length ? waitingTimes[0] : null,
        activeBatchId
      };
    }

    return {
      normalizePromptDraftText,
      promptsToDraftText,
      getPopupDraftState,
      resolveImportDraftPlan,
      normalizePromptInputs,
      buildImportedTasks,
      pickNextRunnableTask
    };
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      createBackgroundQueueHelpers
    };
    return;
  }

  globalThis.BatchImageBackgroundQueue = {
    createBackgroundQueueHelpers
  };
})();
