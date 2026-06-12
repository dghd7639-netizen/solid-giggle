(function () {
  function prepareContentBootstrap(scope) {
    const target = scope || globalThis;
    const shared = target.BatchImageShared || null;

    if (target.__batchImageContentInjected) {
      return {
        shouldRun: false,
        shared
      };
    }

    if (!shared) {
      return {
        shouldRun: false,
        shared: null
      };
    }

    target.__batchImageContentInjected = true;
    return {
      shouldRun: true,
      shared
    };
  }

  function rectDistance(a, b, startKey, endKey) {
    return Math.max(0, Math.max(a[startKey] - b[endKey], b[startKey] - a[endKey]));
  }

  function shouldTreatNodeAsNearComposer({
    nodeRect,
    composerRect,
    sharesFormContainer,
    sharesFooterContainer,
    viewportHeight
  }) {
    if (sharesFormContainer || sharesFooterContainer) {
      return true;
    }

    if (nodeRect && composerRect) {
      const verticalGap = rectDistance(nodeRect, composerRect, "top", "bottom");
      const horizontalGap = rectDistance(nodeRect, composerRect, "left", "right");
      if (verticalGap <= 220 && horizontalGap <= 420) {
        return true;
      }
      return false;
    }

    return Boolean(nodeRect) && Number.isFinite(viewportHeight) && nodeRect.top > viewportHeight * 0.45;
  }

  function isStrongToolButtonText(text) {
    return /^(tools|tool|all tools|view all tools|more tools|use a tool|\u5de5\u5177|\u66f4\u591a\u5de5\u5177|\u67e5\u770b\u5168\u90e8\u5de5\u5177)$/i.test(
      normalizeText(text)
    );
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      prepareContentBootstrap,
      shouldTreatNodeAsNearComposer,
      isStrongToolButtonText
    };
  }

  const bootstrap = prepareContentBootstrap(globalThis);
  if (!bootstrap.shouldRun) {
    return;
  }

  const { MESSAGE_TYPES, sleep } = bootstrap.shared;

  const activeRuns = new Map();

  const ERROR_CODES = {
    COMPOSER_NOT_FOUND: "COMPOSER_NOT_FOUND",
    COMPOSER_NOT_USABLE: "COMPOSER_NOT_USABLE",
    PROMPT_WRITE_FAILED: "PROMPT_WRITE_FAILED",
    IMAGE_MODE_NOT_FOUND: "IMAGE_MODE_NOT_FOUND",
    SUBMIT_FAILED: "SUBMIT_FAILED",
    SUBMIT_NOT_CONFIRMED: "SUBMIT_NOT_CONFIRMED",
    IMAGE_RESULT_TIMEOUT: "IMAGE_RESULT_TIMEOUT",
    IMAGE_RESULT_NOT_FOUND: "IMAGE_RESULT_NOT_FOUND",
    IMAGE_URL_NOT_FOUND: "IMAGE_URL_NOT_FOUND",
    WAIT_TIMEOUT: "WAIT_TIMEOUT"
  };

  const IMAGE_MODE_TEXT_RE =
    /(create image|generate image|image generation|images|\u56fe\u50cf\u751f\u6210|\u751f\u6210\u56fe\u7247|\u751f\u6210\u56fe\u50cf)/i;
  const IMAGE_MODE_LOOSE_TEXT_RE =
    /(create image|generate image|image generation|images?|image tool|\u56fe\u50cf|\u56fe\u7247|\u751f\u6210\u56fe)/i;
  const TOOL_BUTTON_TEXT_RE =
    /(tools|tool|all tools|view all tools|more tools|use a tool|\u5de5\u5177|\u66f4\u591a\u5de5\u5177|\u67e5\u770b\u5168\u90e8\u5de5\u5177)/i;
  const SEND_BUTTON_TEXT_RE = /^(send|submit|\u53d1\u9001|\u63d0\u4ea4)$/i;
  const LOADING_TEXT_RE =
    /(creating|generating|thinking|working|loading|rendering|\u751f\u6210\u4e2d|\u521b\u5efa\u4e2d|\u601d\u8003\u4e2d|\u5904\u7406\u4e2d)/i;
  const SEARCH_LIKE_RE =
    /(search|\u67e5\u627e|\u641c\u7d22|setting|\u8bbe\u7f6e|rename|\u547d\u540d|title|\u6807\u9898|memory|\u8bb0\u5fc6|project|\u9879\u76ee)/i;
  const COMPOSER_HINT_RE =
    /(message|ask|anything|prompt|chatgpt|\u53d1\u9001\u6d88\u606f|\u8f93\u5165|\u7ed9.*\u53d1\u9001\u6d88\u606f|\u7ed9 chatgpt \u53d1\u9001\u6d88\u606f)/i;

  const COMPOSER_SELECTOR_GROUPS = [
    {
      label: "textarea-primary",
      selectors: [
        "textarea[data-testid='composer-text-input']",
        "textarea#prompt-textarea",
        "textarea[placeholder]",
        "form textarea",
        "footer textarea",
        "main textarea"
      ]
    },
    {
      label: "contenteditable-primary",
      selectors: [
        "[contenteditable='true'][role='textbox']",
        "form [contenteditable='true']",
        "footer [contenteditable='true']",
        "main [contenteditable='true']"
      ]
    },
    {
      label: "aria-and-testid",
      selectors: [
        "[data-testid*='composer']",
        "[data-testid*='prompt']",
        "[aria-label*='message' i]",
        "[aria-label*='prompt' i]",
        "[placeholder*='message' i]",
        "[placeholder*='prompt' i]"
      ]
    },
    {
      label: "form-fallback",
      selectors: [
        "form [role='textbox']",
        "form input[type='text']",
        "footer [role='textbox']",
        "footer input[type='text']"
      ]
    }
  ];

  const MESSAGE_CONTAINER_SELECTORS = [
    "main [data-message-author-role]",
    "main [data-testid*='conversation-turn']",
    "main article",
    "main [role='article']"
  ];

  const SEND_BUTTON_SELECTORS = [
    "button[data-testid='send-button']",
    "form button[type='submit']",
    "button[aria-label*='Send' i]",
    "button[title*='Send' i]",
    "button[data-testid*='send']",
    "form [role='button']"
  ];

  const IMAGE_MODE_SELECTORS = [
    "button",
    "[role='button']",
    "[role='tab']",
    "[aria-pressed]",
    "[data-state]",
    "[data-selected]"
  ];

  const MENU_ITEM_SELECTORS = [
    "[role='menuitem']",
    "[role='option']",
    "button",
    "[role='button']",
    "[role='tab']"
  ];

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) {
      return false;
    }

    if (message.type === "PING") {
      sendResponse({
        ok: true,
        pong: true,
        url: location.href,
        readyState: document.readyState
      });
      return false;
    }

    if (message.type === MESSAGE_TYPES.RUN_TASK) {
      const task = message.task;
      if (activeRuns.has(task.id)) {
        sendResponse({ accepted: false, reason: "Task already running" });
        return false;
      }

      const run = {
        taskId: task.id,
        paused: false,
        stopped: false,
        debug: getDebugMode(message.settings || {}),
        timeoutBusySec: Number(message.settings && message.settings.cliTimeoutBusySec) || 0,
        timeoutPauseSent: false
      };

      activeRuns.set(task.id, run);
      void executeTask(task, message.settings || {}, run);
      sendResponse({ accepted: true });
      return false;
    }

    if (message.type === MESSAGE_TYPES.CONTROL_TASK) {
      const run = activeRuns.get(message.taskId);
      if (run) {
        if (message.action === "pause") {
          run.paused = true;
          void logStep(message.taskId, "info", "TASK_PAUSED", "Task paused");
        } else if (message.action === "resume") {
          run.paused = false;
          void logStep(message.taskId, "info", "TASK_RESUMED", "Task resumed");
        } else if (message.action === "stop") {
          run.stopped = true;
          run.paused = false;
          void logStep(message.taskId, "warning", "TASK_STOP_REQUESTED", "Task stop requested");
        }
      }
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  async function executeTask(task, settings, run) {
    try {
      await logStep(task.id, "info", "TASK_START", "Starting content task", {
        debug: run.debug,
        url: location.href
      });

      await waitForPageReady(run, task.id, 15000);

      const composer = await findComposer(task.id, run, 30000);
      const initialRead = readComposerValue(composer);
      await logDebug(task.id, "COMPOSER_INITIAL", "Composer initial state", {
        composer: summarizeNode(composer),
        value: initialRead
      });

      if (settings.autoSelectCreateImage) {
        await tryEnableImageMode(task.id, run, 12000);
      } else {
        await logStep(task.id, "info", "IMAGE_MODE_SKIP", "Auto image mode selection disabled");
      }

      await writePromptRobust(composer, task.prompt, task.id);

      const beforeSnapshot = snapshotConversation(task.id);
      await logDebug(task.id, "SNAPSHOT_BEFORE_SUBMIT", "Snapshot before submit", {
        snapshot: summarizeSnapshot(beforeSnapshot)
      });

      await submitPromptRobust(composer, beforeSnapshot, task.id, run, 14000);
      await logStep(task.id, "info", "SUBMIT_CONFIRMED", "Prompt submit confirmed");

      const result = await waitForNewImageResult(
        beforeSnapshot,
        Number(settings.detectTimeoutSec || 180) * 1000,
        task.id,
        run,
        Number(settings.postSuccessStableMs || 3500)
      );

      await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.TASK_RESULT,
        taskId: task.id,
        success: true,
        images: result.images
      });
    } catch (error) {
      const stopped = Boolean(error && error.code === "TASK_STOPPED");
      await logStep(
        task.id,
        stopped ? "warning" : "error",
        error && error.code ? error.code : "TASK_EXCEPTION",
        error && error.message ? error.message : String(error),
        error && error.details ? error.details : null
      );

      await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.TASK_RESULT,
        taskId: task.id,
        success: false,
        stopped,
        error: error && error.message ? error.message : String(error)
      });
    } finally {
      activeRuns.delete(task.id);
    }
  }

  async function waitForPageReady(run, taskId, timeoutMs) {
    const startedAt = Date.now();
    await logStep(taskId, "info", "PAGE_READY_WAIT", "Waiting for page readiness", {
      readyState: document.readyState
    });

    while (Date.now() - startedAt < timeoutMs) {
      await waitForUnpaused(run, taskId, timeoutMs);
      if (document.readyState === "interactive" || document.readyState === "complete") {
        await logStep(taskId, "info", "PAGE_READY_OK", "Page is ready", {
          readyState: document.readyState
        });
        return;
      }
      await sleep(100);
    }

    throw createTaskError(ERROR_CODES.WAIT_TIMEOUT, "Timed out waiting for page readiness");
  }

  async function findComposer(taskId, run, timeoutMs) {
    const startedAt = Date.now();
    let lastCandidateDigest = "";

    while (Date.now() - startedAt < timeoutMs) {
      await waitForUnpaused(run, taskId, timeoutMs);
      const candidates = collectComposerCandidates();
      const usable = candidates.filter((item) => isComposerUsable(item.node));

      if (usable.length) {
        usable.sort((a, b) => b.score - a.score);
        const winner = usable[0];
        await logStep(taskId, "info", "COMPOSER_FOUND", "Composer located", {
          selectorGroup: winner.group,
          selector: winner.selector,
          score: winner.score,
          node: summarizeNode(winner.node)
        });
        return winner.node;
      }

      const digest = candidates
        .slice(0, 3)
        .map((item) => `${item.group}:${item.score}:${summarizeNode(item.node)}`)
        .join(" || ");
      if (digest && digest !== lastCandidateDigest) {
        lastCandidateDigest = digest;
        await logDebug(taskId, "COMPOSER_CANDIDATES", "Composer candidates updated", {
          candidates: candidates.slice(0, 5).map((item) => ({
            group: item.group,
            selector: item.selector,
            score: item.score,
            node: summarizeNode(item.node)
          }))
        });
      }

      await sleep(250);
    }

    throw createTaskError(
      ERROR_CODES.COMPOSER_NOT_FOUND,
      "Unable to find a usable composer on the current ChatGPT page"
    );
  }

  function collectComposerCandidates() {
    const map = new Map();
    const footer = document.querySelector("footer");
    const form = document.querySelector("form");
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

    for (const group of COMPOSER_SELECTOR_GROUPS) {
      for (const selector of group.selectors) {
        const nodes = Array.from(document.querySelectorAll(selector));
        for (const node of nodes) {
          if (!(node instanceof HTMLElement)) {
            continue;
          }

          const id = getNodeIdentity(node);
          if (map.has(id)) {
            const existing = map.get(id);
            existing.score = Math.max(existing.score, scoreComposerCandidate(node));
            continue;
          }

          const rect = node.getBoundingClientRect();
          const distanceToBottom = Math.abs(viewportHeight - rect.bottom);
          const nearBottomScore = Math.max(0, 300 - Math.min(300, distanceToBottom));
          const insideForm = Boolean(node.closest("form")) || (form && form.contains(node));
          const insideFooter = Boolean(node.closest("footer")) || (footer && footer.contains(node));

          map.set(id, {
            node,
            selector,
            group: group.label,
            score:
              scoreComposerCandidate(node) +
              nearBottomScore +
              (insideForm ? 160 : 0) +
              (insideFooter ? 140 : 0)
          });
        }
      }
    }

    return Array.from(map.values()).sort((a, b) => b.score - a.score);
  }

  function isComposerUsable(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    if (!isVisible(node)) {
      return false;
    }

    const rect = node.getBoundingClientRect();
    if (rect.height < 24 || rect.width < 120) {
      return false;
    }

    const tagName = node.tagName.toLowerCase();
    const type = String(node.getAttribute("type") || "").toLowerCase();
    if (tagName === "input" && !["text", "search", ""].includes(type)) {
      return false;
    }

    if (node.matches("[disabled], [readonly], [aria-disabled='true']")) {
      return false;
    }

    const text = getElementText(node);
    if (SEARCH_LIKE_RE.test(text) && !COMPOSER_HINT_RE.test(text)) {
      return false;
    }

    if (!isFocusable(node)) {
      return false;
    }

    if (!isNearConversationInput(node)) {
      return false;
    }

    return true;
  }

  function scoreComposerCandidate(node) {
    let score = 0;
    const tagName = node.tagName.toLowerCase();
    const text = getElementText(node);
    const rect = node.getBoundingClientRect();

    if (tagName === "textarea") {
      score += 800;
    }
    if (node.isContentEditable) {
      score += 760;
    }
    if (node.getAttribute("role") === "textbox") {
      score += 300;
    }
    if (node.hasAttribute("data-testid")) {
      score += 160;
    }
    if (COMPOSER_HINT_RE.test(text)) {
      score += 260;
    }
    if (SEARCH_LIKE_RE.test(text)) {
      score -= 300;
    }
    if (rect.height >= 48) {
      score += 120;
    }
    if (rect.width >= 300) {
      score += 80;
    }
    if (document.activeElement === node) {
      score += 200;
    }

    return score;
  }

  async function clearComposer(node, taskId) {
    if (!isComposerUsable(node)) {
      throw createTaskError(
        ERROR_CODES.COMPOSER_NOT_USABLE,
        "Composer is not usable before clearing",
        { node: summarizeNode(node) }
      );
    }

    const strategies = [
      {
        name: "select-all-delete",
        run() {
          focusComposer(node);
          selectAllComposer(node);
          dispatchKey(node, "a", { ctrlKey: true });
          dispatchKey(node, "a", { metaKey: true });
          dispatchKey(node, "Delete");
          dispatchKey(node, "Backspace");
          if ("value" in node) {
            node.value = "";
          }
          if (typeof node.setRangeText === "function") {
            const value = String(node.value || "");
            node.setRangeText("", 0, value.length, "end");
          }
          if (node.isContentEditable) {
            node.textContent = "";
            const selection = window.getSelection();
            if (selection) {
              selection.removeAllRanges();
            }
          }
          dispatchInputSequence(node, "", "deleteContentBackward");
        }
      },
      {
        name: "native-empty",
        run() {
          focusComposer(node);
          if ("value" in node) {
            const prototype = Object.getPrototypeOf(node);
            const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
            if (descriptor && typeof descriptor.set === "function") {
              descriptor.set.call(node, "");
            } else {
              node.value = "";
            }
          } else if (node.isContentEditable) {
            node.textContent = "";
          }
          dispatchInputSequence(node, "", "deleteByCut");
        }
      },
      {
        name: "execcommand-delete",
        run() {
          focusComposer(node);
          selectAllComposer(node);
          if (typeof document.execCommand === "function") {
            document.execCommand("delete", false);
          }
          if (node.isContentEditable) {
            node.textContent = "";
          }
          dispatchInputSequence(node, "", "deleteContentBackward");
        }
      }
    ];

    for (const strategy of strategies) {
      try {
        strategy.run();
        const value = normalizeText(readComposerValue(node));
        const success = !value;
        await logStep(taskId, success ? "info" : "warning", "COMPOSER_CLEAR_ATTEMPT", "Composer clear attempt finished", {
          strategy: strategy.name,
          success,
          value
        });
        if (success) {
          return true;
        }
      } catch (error) {
        await logStep(taskId, "warning", "COMPOSER_CLEAR_ATTEMPT", "Composer clear attempt failed", {
          strategy: strategy.name,
          error: error.message || String(error)
        });
      }
    }

    await logStep(taskId, "warning", "COMPOSER_CLEAR_PARTIAL", "Composer could not be fully cleared");
    return false;
  }

  async function writePromptRobust(node, prompt, taskId) {
    if (!isComposerUsable(node)) {
      throw createTaskError(
        ERROR_CODES.COMPOSER_NOT_USABLE,
        "Composer is not usable before writing",
        { node: summarizeNode(node) }
      );
    }

    const normalizedPrompt = normalizeText(prompt);
    await clearComposer(node, taskId);

    const strategies = [
      {
        name: "execcommand-insertText",
        run() {
          focusComposer(node);
          selectAllComposer(node);
          if (typeof document.execCommand === "function") {
            document.execCommand("insertText", false, prompt);
          }
          dispatchInputSequence(node, prompt, "insertText");
        }
      },
      {
        name: "setRangeText",
        run() {
          focusComposer(node);
          if (typeof node.setRangeText === "function") {
            const current = String(node.value || "");
            node.setSelectionRange(0, current.length);
            node.setRangeText(prompt, 0, current.length, "end");
            dispatchInputSequence(node, prompt, "insertText");
          }
        }
      },
      {
        name: "native-value-setter",
        run() {
          focusComposer(node);
          if ("value" in node) {
            const prototype = Object.getPrototypeOf(node);
            const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
            if (descriptor && typeof descriptor.set === "function") {
              descriptor.set.call(node, prompt);
            } else {
              node.value = prompt;
            }
            dispatchInputSequence(node, prompt, "insertText");
          }
        }
      },
      {
        name: "selection-range",
        run() {
          focusComposer(node);
          if (node.isContentEditable) {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(node);
            range.deleteContents();
            range.selectNodeContents(node);
            range.collapse(false);
            if (selection) {
              selection.removeAllRanges();
              selection.addRange(range);
            }
            const textNode = document.createTextNode(prompt);
            range.insertNode(textNode);
            range.setStartAfter(textNode);
            range.collapse(true);
            if (selection) {
              selection.removeAllRanges();
              selection.addRange(range);
            }
            dispatchInputSequence(node, prompt, "insertText");
          }
        }
      },
      {
        name: "textContent-fallback",
        run() {
          focusComposer(node);
          if (node.isContentEditable) {
            node.textContent = prompt;
          } else if ("value" in node) {
            node.value = prompt;
          }
          dispatchInputSequence(node, prompt, "insertText");
          dispatchKey(node, "End");
        }
      }
    ];

    for (const strategy of strategies) {
      let success = false;
      try {
        strategy.run();
        const readback = normalizeText(readComposerValue(node));
        success = readback === normalizedPrompt || readback.includes(normalizedPrompt);
        await logStep(taskId, success ? "info" : "warning", "PROMPT_WRITE_ATTEMPT", "Prompt write attempt finished", {
          strategy: strategy.name,
          success,
          expected: normalizedPrompt,
          actual: readback
        });
        if (success) {
          return true;
        }
      } catch (error) {
        await logStep(taskId, "warning", "PROMPT_WRITE_ATTEMPT", "Prompt write attempt threw", {
          strategy: strategy.name,
          error: error.message || String(error)
        });
      }
    }

    throw createTaskError(
      ERROR_CODES.PROMPT_WRITE_FAILED,
      "Failed to write prompt into composer",
      {
        composer: summarizeNode(node),
        finalValue: readComposerValue(node)
      }
    );
  }

  function readComposerValue(node) {
    const values = [];

    if (node && typeof node.value === "string") {
      values.push(node.value);
    }
    if (node && typeof node.textContent === "string") {
      values.push(node.textContent);
    }
    if (node && typeof node.innerText === "string") {
      values.push(node.innerText);
    }
    if (node && typeof node.getAttribute === "function") {
      values.push(node.getAttribute("aria-valuetext") || "");
    }

    values.sort((a, b) => normalizeText(b).length - normalizeText(a).length);
    return normalizeText(values.find((value) => normalizeText(value)) || "");
  }

  function detectImageMode(taskId) {
    const activeCandidates = [];
    const generalCandidates = [];
    const toolButtons = [];
    const composer = findComposerImmediate();

    for (const selector of IMAGE_MODE_SELECTORS) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) {
        if (!(node instanceof HTMLElement) || !isVisible(node)) {
          continue;
        }

        const text = getElementText(node);
        if (isStrongToolButtonText(text) && isNearConversationInput(node, composer)) {
          toolButtons.push(node);
          void logDebug(taskId, "IMAGE_MODE_TOOL_ACCEPT", "Accepted tools button candidate", {
            selector,
            node: summarizeNode(node),
            text
          });
        }

        if (IMAGE_MODE_LOOSE_TEXT_RE.test(text) && !isNearConversationInput(node, composer)) {
          void logDebug(taskId, "IMAGE_MODE_REJECT", "Rejected image mode candidate because it is not near composer", {
            selector,
            node: summarizeNode(node),
            text
          });
        }

        if (IMAGE_MODE_LOOSE_TEXT_RE.test(text) && isNearConversationInput(node, composer) && !IMAGE_MODE_TEXT_RE.test(text)) {
          void logDebug(taskId, "IMAGE_MODE_REJECT", "Rejected image mode candidate because text confidence is too low", {
            selector,
            node: summarizeNode(node),
            text
          });
        }

        if (!IMAGE_MODE_TEXT_RE.test(text) || !isNearConversationInput(node, composer)) {
          continue;
        }

        generalCandidates.push(node);
        void logDebug(taskId, "IMAGE_MODE_ACCEPT", "Accepted image mode candidate", {
          selector,
          node: summarizeNode(node),
          text
        });
        if (
          node.getAttribute("aria-pressed") === "true" ||
          node.getAttribute("data-state") === "on" ||
          node.getAttribute("data-selected") === "true" ||
          node.getAttribute("aria-selected") === "true"
        ) {
          activeCandidates.push(node);
          void logDebug(taskId, "IMAGE_MODE_ACTIVE", "Candidate marked as active image mode", {
            selector,
            node: summarizeNode(node),
            text
          });
        }
      }
    }

    return {
      enabled: activeCandidates.length > 0,
      activeNode: activeCandidates[0] || null,
      clickableNode: generalCandidates[0] || null,
      toolButton: toolButtons[0] || null,
      activeCount: activeCandidates.length,
      candidateCount: generalCandidates.length
    };
  }

  async function tryEnableImageMode(taskId, run, timeoutMs) {
    const initial = detectImageMode(taskId);
    await logStep(taskId, "info", "IMAGE_MODE_DETECT", "Initial image mode detection", {
      enabled: initial.enabled,
      activeCount: initial.activeCount,
      candidateCount: initial.candidateCount,
      activeNode: summarizeNode(initial.activeNode),
      clickableNode: summarizeNode(initial.clickableNode),
      toolButton: summarizeNode(initial.toolButton)
    });

    if (initial.enabled) {
      await logStep(taskId, "info", "IMAGE_MODE_READY", "Image mode already enabled");
      return true;
    }

    if (initial.clickableNode) {
      clickElementRobust(initial.clickableNode);
      await logStep(taskId, "info", "IMAGE_MODE_CLICK", "Clicked direct image mode candidate", {
        node: summarizeNode(initial.clickableNode)
      });
      const directEnabled = await waitForImageModeEnabled(taskId, run, 2500);
      if (directEnabled) {
        return true;
      }
    }

    const current = detectImageMode(taskId);
    if (current.toolButton) {
      clickElementRobust(current.toolButton);
      await logStep(taskId, "info", "IMAGE_MODE_TOOLS", "Opened tools or mode menu", {
        node: summarizeNode(current.toolButton)
      });
      await waitForUiSettle(run, taskId, 1500);

      const menuCandidate = await findMatchingElement(
        MENU_ITEM_SELECTORS,
        timeoutMs,
        run,
        (node) => IMAGE_MODE_TEXT_RE.test(getElementText(node))
      );

      if (menuCandidate) {
        clickElementRobust(menuCandidate);
        await logStep(taskId, "info", "IMAGE_MODE_MENU_CLICK", "Clicked image mode menu item", {
          node: summarizeNode(menuCandidate)
        });
        const enabled = await waitForImageModeEnabled(taskId, run, 3000);
        if (enabled) {
          return true;
        }
      }
    }

    await logStep(
      taskId,
      "warning",
      ERROR_CODES.IMAGE_MODE_NOT_FOUND,
      "Image mode not confirmed, continuing with direct prompt submission"
    );
    return false;
  }

  async function waitForImageModeEnabled(taskId, run, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await waitForUnpaused(run, taskId, timeoutMs);
      const state = detectImageMode(taskId);
      if (state.enabled) {
        await logStep(taskId, "info", "IMAGE_MODE_ENABLED", "Image mode confirmed", {
          activeNode: summarizeNode(state.activeNode)
        });
        return true;
      }
      await sleep(200);
    }
    await logDebug(taskId, "IMAGE_MODE_PENDING", "Image mode was not confirmed within wait window");
    return false;
  }

  async function submitPromptRobust(node, beforeSnapshot, taskId, run, timeoutMs) {
    const methods = [
      {
        name: "enter",
        run() {
          focusComposer(node);
          dispatchEnter(node, {});
        }
      },
      {
        name: "ctrl-enter",
        run() {
          focusComposer(node);
          dispatchEnter(node, { ctrlKey: true });
        }
      },
      {
        name: "meta-enter",
        run() {
          focusComposer(node);
          dispatchEnter(node, { metaKey: true });
        }
      },
      {
        name: "send-button-click",
        run() {
          const button = findSendButton(node);
          if (!button) {
            return false;
          }
          clickElementRobust(button);
          return true;
        }
      },
      {
        name: "form-submit",
        run() {
          const form = node.closest("form");
          if (!form) {
            return false;
          }
          if (typeof form.requestSubmit === "function") {
            form.requestSubmit();
          } else {
            form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          }
          return true;
        }
      }
    ];

    for (const method of methods) {
      await waitForUnpaused(run, taskId, timeoutMs);
      await logStep(taskId, "info", "SUBMIT_ATTEMPT", "Trying submit method", {
        method: method.name
      });

      let attempted = false;
      try {
        const result = method.run();
        attempted = result !== false;
      } catch (error) {
        await logStep(taskId, "warning", "SUBMIT_ATTEMPT", "Submit method threw", {
          method: method.name,
          error: error.message || String(error)
        });
      }

      if (!attempted) {
        await logStep(taskId, "warning", "SUBMIT_ATTEMPT", "Submit method not applicable", {
          method: method.name
        });
        continue;
      }

      const confirmation = await waitForSubmitConfirmation(
        beforeSnapshot,
        node,
        taskId,
        run,
        Math.min(4500, timeoutMs)
      );

      await logStep(
        taskId,
        confirmation.ok ? "info" : "warning",
        "SUBMIT_ATTEMPT_RESULT",
        "Submit attempt finished",
        {
          method: method.name,
          ok: confirmation.ok,
          reasons: confirmation.reasons,
          snapshot: confirmation.snapshot ? summarizeSnapshot(confirmation.snapshot) : null
        }
      );

      if (confirmation.ok) {
        return confirmation;
      }
    }

    throw createTaskError(
      ERROR_CODES.SUBMIT_NOT_CONFIRMED,
      "Prompt submit could not be confirmed after all strategies"
    );
  }

  async function waitForSubmitConfirmation(beforeSnapshot, node, taskId, run, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await waitForUnpaused(run, taskId, timeoutMs);
      const afterSnapshot = snapshotConversation(taskId);
      const result = detectSubmitSuccess(beforeSnapshot, afterSnapshot);
      if (result.ok) {
        return {
          ok: true,
          reasons: result.reasons,
          snapshot: afterSnapshot
        };
      }
      await sleep(250);
    }

    return {
      ok: false,
      reasons: [],
      snapshot: snapshotConversation(taskId)
    };
  }

  function detectSubmitSuccess(beforeSnapshot, afterSnapshot) {
    const reasons = [];
    const composerCleared =
      !normalizeText(afterSnapshot.composerValue) ||
      normalizeText(afterSnapshot.composerValue) !== normalizeText(beforeSnapshot.composerValue);
    const newUserMessage =
      afterSnapshot.userItems.length > beforeSnapshot.userItems.length ||
      (!beforeSnapshot.userSet.has(afterSnapshot.lastUserElement) && Boolean(afterSnapshot.lastUserElement));
    const newMessageCount = afterSnapshot.messageItems.length > beforeSnapshot.messageItems.length;
    const loadingAppeared = afterSnapshot.loadingCount > beforeSnapshot.loadingCount;
    const stopButtonAppeared = afterSnapshot.stopButtonVisible && !beforeSnapshot.stopButtonVisible;
    const sendButtonDisabled =
      beforeSnapshot.sendButtonEnabled && afterSnapshot.sendButtonEnabled === false;

    if (composerCleared) {
      reasons.push("composer-cleared");
    }
    if (newUserMessage) {
      reasons.push("new-user-message");
    }
    if (newMessageCount) {
      reasons.push("new-message-count");
    }
    if (loadingAppeared) {
      reasons.push("loading-appeared");
    }
    if (stopButtonAppeared) {
      reasons.push("stop-button-appeared");
    }
    if (sendButtonDisabled) {
      reasons.push("send-button-disabled");
    }

    const ok =
      newUserMessage ||
      loadingAppeared ||
      stopButtonAppeared ||
      (composerCleared && newMessageCount) ||
      (composerCleared && sendButtonDisabled);

    return { ok, reasons };
  }

  function snapshotConversation(taskId) {
    const composer = findComposerImmediate();
    const messageItems = collectConversationContainers(taskId);
    const assistantItems = messageItems.filter((item) => item.author === "assistant");
    const userItems = messageItems.filter((item) => item.author === "user");
    const allImageCandidates = dedupeImageCandidates(
      assistantItems.flatMap((item) => collectImagesFromContainer(item.element))
    );
    const sendButton = findSendButton(composer);
    const stopButtonVisible = Boolean(findStopButton());
    const loadingContext = getDefaultLoadingContext(messageItems, assistantItems);
    const loadingSignals = collectLoadingIndicators(loadingContext, taskId);

    return {
      time: Date.now(),
      composerValue: composer ? readComposerValue(composer) : "",
      messageItems,
      messageSet: new Set(messageItems.map((item) => item.element)),
      assistantItems,
      assistantSet: new Set(assistantItems.map((item) => item.element)),
      userItems,
      userSet: new Set(userItems.map((item) => item.element)),
      lastAssistantElement: assistantItems.length
        ? assistantItems[assistantItems.length - 1].element
        : null,
      lastAssistantText: assistantItems.length
        ? assistantItems[assistantItems.length - 1].text
        : "",
      lastUserElement: userItems.length ? userItems[userItems.length - 1].element : null,
      imageCandidates: allImageCandidates,
      imageKeySet: new Set(allImageCandidates.map((item) => item.key)),
      loadingCount: loadingSignals.length,
      loadingSignals,
      sendButtonEnabled: sendButton ? !sendButton.disabled : null,
      stopButtonVisible
    };
  }

  async function waitForNewImageResult(beforeSnapshot, timeoutMs, taskId, run, stableMs) {
    const startedAt = Date.now();
    let stableSince = 0;
    let lastKeys = "";
    let sawNewReplySignal = false;
    let busySince = 0;

    while (Date.now() - startedAt < timeoutMs) {
      await waitForUnpaused(run, taskId, timeoutMs);
      const errorText = detectVisibleError();
      if (errorText) {
        throw createTaskError(ERROR_CODES.IMAGE_RESULT_NOT_FOUND, errorText);
      }

      const afterSnapshot = snapshotConversation(taskId);
      const relevantContainers = getRelevantResultContainers(beforeSnapshot, afterSnapshot);
      const candidates = dedupeImageCandidates(
        relevantContainers.flatMap((container) => collectImagesFromContainer(container))
      ).filter((item) => !beforeSnapshot.imageKeySet.has(item.key));
      const replySignal = detectNewReplySignal(beforeSnapshot, afterSnapshot, relevantContainers, candidates);
      const localizedLoadingSignals = collectLoadingIndicators(
        getLoadingContextForReply(beforeSnapshot, afterSnapshot, relevantContainers),
        taskId
      );
      if (replySignal.hasSignal) {
        sawNewReplySignal = true;
      }

      if (localizedLoadingSignals.length) {
        if (!busySince) {
          busySince = Date.now();
        }
        await maybePauseForBusyTimeout(taskId, run, busySince);
        await logDebug(taskId, "LOADING_NEAR_REPLY", "Localized loading signals detected", {
          signals: localizedLoadingSignals.map((item) => ({
            node: summarizeNode(item.node),
            container: summarizeNode(item.container),
            text: item.text
          }))
        });
      } else {
        busySince = 0;
      }

      const currentKeys = candidates.map((item) => item.key).join("|");
      if (candidates.length) {
        if (currentKeys !== lastKeys) {
          lastKeys = currentKeys;
          stableSince = Date.now();
          await logStep(taskId, "info", "IMAGE_CANDIDATES_UPDATED", "New image candidates detected", {
            count: candidates.length,
            containers: relevantContainers.map((container) => summarizeNode(container)),
            candidates: candidates.map((item) => ({
              source: item.source,
              width: item.width,
              height: item.height,
              url: item.url
            }))
          });
        }

        if (Date.now() - stableSince >= stableMs) {
          await logStep(taskId, "info", "IMAGE_RESULT_READY", "New image result stabilized", {
            count: candidates.length
          });
          return {
            images: candidates.map(stripInternalFields),
            snapshot: afterSnapshot
          };
        }
      } else if (run.debug) {
        await logDebug(taskId, "IMAGE_CANDIDATES_EMPTY", "No new image candidates yet", {
          snapshot: summarizeSnapshot(afterSnapshot),
          relevantContainers: relevantContainers.map((container) => summarizeNode(container)),
          replySignal
        });
      }

      await sleep(900);
    }

    if (sawNewReplySignal) {
      throw createTaskError(
        ERROR_CODES.IMAGE_URL_NOT_FOUND,
        "A new reply appeared but no valid image URL was extracted"
      );
    }

    throw createTaskError(
      ERROR_CODES.IMAGE_RESULT_TIMEOUT,
      "Timed out while waiting for a new image result"
    );
  }

  async function maybePauseForBusyTimeout(taskId, run, busySince) {
    const timeoutSec = Number(run && run.timeoutBusySec);
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || run.timeoutPauseSent) {
      return;
    }

    const elapsedMs = Date.now() - busySince;
    if (elapsedMs < timeoutSec * 1000) {
      return;
    }

    run.timeoutPauseSent = true;
    await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.TASK_TIMEOUT_PAUSE,
      taskId,
      reason: "busy",
      message: `Page stayed in generating state for ${Math.round(elapsedMs / 1000)}s`
    });
  }

  function getRelevantResultContainers(beforeSnapshot, afterSnapshot) {
    const newAssistantContainers = afterSnapshot.assistantItems
      .filter((item) => !beforeSnapshot.assistantSet.has(item.element))
      .map((item) => item.element);

    if (newAssistantContainers.length) {
      return newAssistantContainers;
    }

    const newUnknownContainers = afterSnapshot.messageItems
      .filter(
        (item) =>
          item.author === "unknown" &&
          !beforeSnapshot.messageSet.has(item.element)
      )
      .map((item) => item.element);

    if (newUnknownContainers.length) {
      return newUnknownContainers;
    }

    const fallback = [];
    if (
      afterSnapshot.lastAssistantElement &&
      afterSnapshot.lastAssistantElement !== beforeSnapshot.lastAssistantElement
    ) {
      fallback.push(afterSnapshot.lastAssistantElement);
    }

    const tail = afterSnapshot.assistantItems
      .slice(Math.max(0, afterSnapshot.assistantItems.length - 3))
      .map((item) => item.element);

    for (const element of tail) {
      if (!fallback.includes(element)) {
        fallback.push(element);
      }
    }

    return fallback;
  }

  function detectNewReplySignal(beforeSnapshot, afterSnapshot, relevantContainers, candidates) {
    const assistantAdded = afterSnapshot.assistantItems.some(
      (item) => !beforeSnapshot.assistantSet.has(item.element)
    );
    const lastAssistantChanged =
      Boolean(beforeSnapshot.lastAssistantElement) &&
      beforeSnapshot.lastAssistantElement === afterSnapshot.lastAssistantElement &&
      normalizeText(afterSnapshot.lastAssistantText) !== normalizeText(beforeSnapshot.lastAssistantText) &&
      normalizeText(afterSnapshot.lastAssistantText).length >
        normalizeText(beforeSnapshot.lastAssistantText).length;
    const newImageInNewContainer =
      candidates.length > 0 &&
      relevantContainers.some(
        (container) =>
          !beforeSnapshot.assistantSet.has(container) && !beforeSnapshot.messageSet.has(container)
      );

    return {
      hasSignal: assistantAdded || lastAssistantChanged || newImageInNewContainer,
      assistantAdded,
      lastAssistantChanged,
      newImageInNewContainer
    };
  }

  function getLoadingContextForReply(beforeSnapshot, afterSnapshot, relevantContainers) {
    const context = [];
    for (const container of relevantContainers || []) {
      if (container instanceof Element) {
        context.push(container);
      }
    }
    if (afterSnapshot.lastAssistantElement instanceof Element) {
      context.push(afterSnapshot.lastAssistantElement);
    }
    if (beforeSnapshot.lastAssistantElement instanceof Element) {
      context.push(beforeSnapshot.lastAssistantElement);
    }
    return dedupeNodes(context);
  }

  function collectImagesFromContainer(container) {
    return extractBestImageCandidates(container);
  }

  function extractBestImageCandidates(container) {
    if (!(container instanceof Element)) {
      return [];
    }

    const candidates = [];

    const imageNodes = Array.from(container.querySelectorAll("img"));
    for (const img of imageNodes) {
      if (!(img instanceof HTMLImageElement) || !isVisible(img)) {
        continue;
      }

      const rect = img.getBoundingClientRect();
      const naturalWidth = Number(img.naturalWidth || 0);
      const naturalHeight = Number(img.naturalHeight || 0);
      const width = Math.max(Math.round(rect.width || 0), naturalWidth);
      const height = Math.max(Math.round(rect.height || 0), naturalHeight);

      const sources = [
        { url: img.currentSrc, source: "img.currentSrc", priority: 5000 },
        { url: pickLargestSrcset(img.srcset), source: "img.srcset", priority: 4800 },
        { url: img.src, source: "img.src", priority: 4600 }
      ];

      for (const source of sources) {
        if (!isValidImageUrl(source.url)) {
          continue;
        }
        if (!isLikelyUsefulImage(width, height, source.url)) {
          continue;
        }
        candidates.push(
          buildImageCandidate(source.url, source.source, width, height, container, source.priority)
        );
      }

      const anchor = img.closest("a[href]");
      if (anchor && isValidImageUrl(anchor.href)) {
        candidates.push(
          buildImageCandidate(anchor.href, "anchor.href", width, height, container, 4400)
        );
      }
    }

    const bgNodes = Array.from(container.querySelectorAll("*"));
    for (const node of bgNodes) {
      if (!(node instanceof HTMLElement) || !isVisible(node)) {
        continue;
      }

      const bgUrl = extractBackgroundImageUrl(node);
      if (!isValidImageUrl(bgUrl)) {
        continue;
      }

      const rect = node.getBoundingClientRect();
      const width = Math.round(rect.width || 0);
      const height = Math.round(rect.height || 0);
      if (!isLikelyUsefulImage(width, height, bgUrl)) {
        continue;
      }

      candidates.push(buildImageCandidate(bgUrl, "background-image", width, height, container, 4200));
    }

    return dedupeImageCandidates(candidates);
  }

  function dedupeImageCandidates(items) {
    const byKey = new Map();

    for (const item of items || []) {
      if (!item || !item.url) {
        continue;
      }

      const key = normalizeUrlKey(item.url);
      const existing = byKey.get(key);
      if (!existing || item.qualityScore > existing.qualityScore) {
        byKey.set(key, Object.assign({}, item, { key }));
      }
    }

    return Array.from(byKey.values()).sort((a, b) => b.qualityScore - a.qualityScore);
  }

  function buildImageCandidate(url, source, width, height, container, priority) {
    return {
      url: String(url).trim(),
      source,
      width: Number(width || 0),
      height: Number(height || 0),
      qualityScore:
        Number(priority || 0) +
        Math.max(Number(width || 0), Number(height || 0)) * 2 +
        Math.round((Number(width || 0) * Number(height || 0)) / 5000),
      containerSummary: summarizeNode(container)
    };
  }

  function stripInternalFields(item) {
    return {
      url: item.url,
      width: item.width,
      height: item.height
    };
  }

  function collectConversationContainers(taskId) {
    const main = document.querySelector("main") || document.body;
    const map = new Map();
    const provisional = [];

    for (const selector of MESSAGE_CONTAINER_SELECTORS) {
      const nodes = Array.from(main.querySelectorAll(selector));
      for (const node of nodes) {
        if (!(node instanceof HTMLElement) || !isVisible(node)) {
          continue;
        }

        const evaluation = evaluateMessageContainerCandidate(node, selector);
        if (!evaluation.accept) {
          void logDebug(taskId, "MESSAGE_CONTAINER_REJECT", "Rejected message container candidate", {
            selector,
            reason: evaluation.reason,
            node: summarizeNode(node)
          });
          continue;
        }

        const text = normalizeText(node.innerText || node.textContent || "");
        const imgCount = node.querySelectorAll("img").length;
        const identity = getNodeIdentity(node);
        if (map.has(identity)) {
          continue;
        }

        map.set(identity, true);
        provisional.push({
          element: node,
          selector,
          text: text.slice(0, 240),
          imgCount
        });
        void logDebug(taskId, "MESSAGE_CONTAINER_ACCEPT", "Accepted message container candidate", {
          selector,
          reason: evaluation.reason,
          node: summarizeNode(node),
          textLength: text.length,
          imgCount
        });
      }
    }

    const sorted = provisional.sort((a, b) => {
      const rectA = a.element.getBoundingClientRect();
      const rectB = b.element.getBoundingClientRect();
      return rectA.top - rectB.top;
    });

    return sorted.map((item, index) => {
      const author = detectContainerAuthor(item.element, {
        index,
        items: sorted
      }, taskId);

      return {
        element: item.element,
        author: author || "unknown",
        text: item.text,
        selector: item.selector
      };
    });
  }

  function evaluateMessageContainerCandidate(node, selector) {
    const explicit = getExplicitAuthor(node);
    if (explicit) {
      return { accept: true, reason: "explicit-author" };
    }

    if (node.closest("form, footer")) {
      return { accept: false, reason: "inside-form-or-footer" };
    }

    const nestedStrongAncestor = node.parentElement && node.parentElement.closest(
      "[data-message-author-role], [data-testid*='conversation-turn'], article, [role='article']"
    );
    if (nestedStrongAncestor && nestedStrongAncestor !== node && nestedStrongAncestor.contains(node)) {
      return { accept: false, reason: "nested-under-strong-message-container" };
    }

    const rect = node.getBoundingClientRect();
    if (rect.width < 180 || rect.height < 24) {
      return { accept: false, reason: "too-small" };
    }

    const text = normalizeText(node.innerText || node.textContent || "");
    const hasMessageBody = Boolean(
      node.querySelector(".markdown, .prose, [data-message-content], [data-testid*='message-content']")
    );
    const hasMedia = Boolean(node.querySelector("img, picture, canvas"));
    const hasCode = Boolean(node.querySelector("pre, code"));
    const containsComposer = Boolean(node.querySelector("textarea, [contenteditable='true']"));
    if (containsComposer) {
      return { accept: false, reason: "contains-composer" };
    }

    if (selector.includes("conversation-turn")) {
      return { accept: true, reason: "conversation-turn-selector" };
    }

    if (selector.includes("article") || selector.includes("role='article'")) {
      if (hasMessageBody || hasMedia || hasCode || text.length >= 24) {
        return { accept: true, reason: hasMessageBody ? "article-with-message-body" : "article-with-content" };
      }
      return { accept: false, reason: "article-without-message-structure" };
    }

    if (text.length >= 24 || hasMedia) {
      return { accept: true, reason: "content-threshold" };
    }

    return { accept: false, reason: "insufficient-message-structure" };
  }

  function detectContainerAuthor(node, context, taskId) {
    const explicit = getExplicitAuthor(node);
    if (explicit === "assistant" || explicit === "user") {
      void logDebug(taskId, "MESSAGE_AUTHOR_DECISION", "Resolved author from explicit attribute", {
        author: explicit,
        node: summarizeNode(node)
      });
      return explicit;
    }

    const testIdText = normalizeText(
      [
        node.getAttribute("data-testid") || "",
        node.className || ""
      ].join(" ")
    );
    if (/assistant-message|response|markdown|prose/i.test(testIdText)) {
      void logDebug(taskId, "MESSAGE_AUTHOR_DECISION", "Resolved author from message-body markers", {
        author: "assistant",
        node: summarizeNode(node)
      });
      return "assistant";
    }

    const hasMessageBody = Boolean(
      node.querySelector(".markdown, .prose, [data-message-content], [data-testid*='message-content']")
    );
    if (hasMessageBody) {
      const previousExplicitAuthor = findNearestExplicitNeighbor(context, "previous", node);
      const nextExplicitAuthor = findNearestExplicitNeighbor(context, "next", node);
      if (previousExplicitAuthor === "user" || nextExplicitAuthor === "assistant") {
        void logDebug(taskId, "MESSAGE_AUTHOR_DECISION", "Resolved author from neighbor context plus message body", {
          author: "assistant",
          node: summarizeNode(node),
          previousExplicitAuthor,
          nextExplicitAuthor
        });
        return "assistant";
      }
    }

    void logDebug(taskId, "MESSAGE_AUTHOR_DECISION", "Author left as unknown", {
      author: "unknown",
      node: summarizeNode(node)
    });
    return "";
  }

  function getExplicitAuthor(node) {
    if (!(node instanceof Element)) {
      return "";
    }

    const selfAuthor = String(node.getAttribute("data-message-author-role") || "").toLowerCase();
    if (selfAuthor === "assistant" || selfAuthor === "user") {
      return selfAuthor;
    }

    const ancestor = node.closest("[data-message-author-role]");
    if (ancestor instanceof Element) {
      const ancestorAuthor = String(
        ancestor.getAttribute("data-message-author-role") || ""
      ).toLowerCase();
      if (ancestorAuthor === "assistant" || ancestorAuthor === "user") {
        return ancestorAuthor;
      }
    }

    return "";
  }

  function findNearestExplicitNeighbor(context, direction, node) {
    if (!context || !Array.isArray(context.items)) {
      return "";
    }

    const currentIndex = context.items.findIndex((item) => item.element === node);
    if (currentIndex < 0) {
      return "";
    }

    const step = direction === "previous" ? -1 : 1;
    for (
      let index = currentIndex + step;
      index >= 0 && index < context.items.length;
      index += step
    ) {
      const author = getExplicitAuthor(context.items[index].element);
      if (author) {
        return author;
      }
    }

    return "";
  }

  function getDefaultLoadingContext(messageItems, assistantItems) {
    const context = [];
    if (assistantItems.length) {
      context.push(assistantItems[assistantItems.length - 1].element);
    }

    for (const item of messageItems.slice(Math.max(0, messageItems.length - 2))) {
      context.push(item.element);
    }

    return dedupeNodes(context);
  }

  function dedupeLoadingSignals(items) {
    const seen = new Set();
    const results = [];
    for (const item of items || []) {
      const key = `${getNodeIdentity(item.node)}::${getNodeIdentity(item.container)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(item);
    }
    return results;
  }

  function findSendButton(composer) {
    const candidates = [];

    for (const selector of SEND_BUTTON_SELECTORS) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) {
        if (!(node instanceof HTMLButtonElement || node instanceof HTMLElement)) {
          continue;
        }
        if (!isVisible(node)) {
          continue;
        }

        const text = getElementText(node);
        const ariaLabel = normalizeText(node.getAttribute("aria-label") || "");
        const title = normalizeText(node.getAttribute("title") || "");
        const dataTestId = normalizeText(node.getAttribute("data-testid") || "");
        const isStrongSelector =
          node.matches("[data-testid='send-button'], [type='submit']") ||
          /\bsend\b/i.test(dataTestId) ||
          /^send$/i.test(ariaLabel) ||
          /^send$/i.test(title) ||
          /^\u53d1\u9001$/i.test(ariaLabel) ||
          /^\u53d1\u9001$/i.test(title);
        if (
          !isStrongSelector &&
          !SEND_BUTTON_TEXT_RE.test(text)
        ) {
          continue;
        }

        const score =
          (composer && isNearby(node, composer) ? 300 : 0) +
          (node.matches("[data-testid='send-button']") ? 400 : 0) +
          (node.matches("[type='submit']") ? 350 : 0) +
          (/^send$/i.test(ariaLabel) || /^\u53d1\u9001$/i.test(ariaLabel) ? 320 : 0) +
          (node.closest("form") ? 120 : 0) +
          (!node.disabled ? 100 : 0);

        candidates.push({ node, score });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].node : null;
  }

  function findStopButton() {
    const selectors = [
      "button[aria-label*='Stop' i]",
      "button[title*='Stop' i]",
      "button[data-testid*='stop']",
      "[role='button'][aria-label*='Stop' i]"
    ];

    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) {
        if (!(node instanceof HTMLElement) || !isVisible(node)) {
          continue;
        }
        return node;
      }
    }

    return null;
  }

  function collectLoadingIndicators(contextContainers, taskId) {
    const selectors = [
      "[role='progressbar']",
      "[aria-busy='true']",
      "[data-testid*='typing']",
      "[data-testid*='loading']",
      "[data-testid*='result-streaming']",
      "button[aria-label*='Stop' i]"
    ];

    const scopes = [];
    for (const container of contextContainers || []) {
      if (container instanceof HTMLElement) {
        scopes.push(container);
        if (container.parentElement instanceof HTMLElement) {
          scopes.push(container.parentElement);
        }
      }
    }

    const uniqueScopes = dedupeNodes(scopes);
    const results = [];

    for (const scope of uniqueScopes) {
      for (const selector of selectors) {
        const nodes = [];
        if (scope.matches && scope.matches(selector)) {
          nodes.push(scope);
        }
        nodes.push(...Array.from(scope.querySelectorAll(selector)));

        for (const node of nodes) {
          if (!(node instanceof HTMLElement) || !isVisible(node)) {
            continue;
          }
          const text = getElementText(node);
          if (!text && !node.matches("[role='progressbar'], [aria-busy='true']")) {
            continue;
          }
          if (text && !LOADING_TEXT_RE.test(text) && !node.matches("[role='progressbar'], [aria-busy='true']")) {
            continue;
          }
          results.push({
            node,
            container: scope,
            text
          });
          void logDebug(taskId, "LOADING_SIGNAL_ACCEPT", "Accepted loading signal near reply container", {
            node: summarizeNode(node),
            container: summarizeNode(scope),
            text
          });
        }
      }
    }

    return dedupeLoadingSignals(results);
  }

  function detectVisibleError() {
    const selectors = [
      "[role='alert']",
      "[data-testid*='toast']",
      ".toast",
      "[aria-live='assertive']"
    ];

    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) {
        if (!(node instanceof HTMLElement) || !isVisible(node)) {
          continue;
        }
        const text = getElementText(node);
        if (
          /(something went wrong|unable to|failed|error|try again later|network error|\u51fa\u73b0\u9519\u8bef|\u5931\u8d25|\u65e0\u6cd5)/i.test(
            text
          )
        ) {
          return text.slice(0, 200);
        }
      }
    }

    return "";
  }

  async function findMatchingElement(selectors, timeoutMs, run, predicate) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await waitForUnpaused(run, null, timeoutMs);
      for (const selector of selectors) {
        const nodes = Array.from(document.querySelectorAll(selector));
        for (const node of nodes) {
          if (!(node instanceof HTMLElement) || !isVisible(node)) {
            continue;
          }
          if (typeof predicate === "function" && !predicate(node)) {
            continue;
          }
          return node;
        }
      }
      await sleep(200);
    }

    return null;
  }

  async function waitForUiSettle(run, taskId, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await waitForUnpaused(run, taskId, timeoutMs);
      await sleep(120);
    }
  }

  async function waitForUnpaused(run, taskId, timeoutMs) {
    const startedAt = Date.now();
    const maxWait = Math.max(timeoutMs || 0, 10 * 60 * 1000);

    while (run && run.paused) {
      if (run.stopped) {
        throwStopped();
      }
      if (Date.now() - startedAt > maxWait) {
        throw createTaskError(ERROR_CODES.WAIT_TIMEOUT, "Timed out while waiting in paused state");
      }
      await sleep(300);
    }

    if (run && run.stopped) {
      throwStopped();
    }
  }

  function createTaskError(code, message, details) {
    const error = new Error(`[${code}] ${message}`);
    error.code = code;
    error.details = details || null;
    return error;
  }

  function throwStopped() {
    const error = new Error("Task stopped");
    error.code = "TASK_STOPPED";
    throw error;
  }

  function findComposerImmediate() {
    const candidates = collectComposerCandidates().filter((item) => isComposerUsable(item.node));
    return candidates.length ? candidates[0].node : null;
  }

  function focusComposer(node) {
    if (typeof node.focus === "function") {
      node.focus();
    }
    if (typeof node.click === "function") {
      node.click();
    }
  }

  function selectAllComposer(node) {
    if ("select" in node && typeof node.select === "function") {
      node.select();
      return;
    }

    if (node.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(node);
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return;
    }

    if ("setSelectionRange" in node && typeof node.setSelectionRange === "function") {
      const value = String(node.value || "");
      node.setSelectionRange(0, value.length);
    }
  }

  function dispatchInputSequence(node, text, inputType) {
    const payload = {
      bubbles: true,
      cancelable: true,
      data: text,
      inputType: inputType || "insertText"
    };

    try {
      node.dispatchEvent(new InputEvent("beforeinput", payload));
    } catch (error) {
      node.dispatchEvent(new Event("beforeinput", { bubbles: true, cancelable: true }));
    }

    try {
      node.dispatchEvent(new InputEvent("input", payload));
    } catch (error) {
      node.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    }

    node.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function dispatchKey(node, key, modifiers) {
    const init = Object.assign(
      {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        which: key === "Enter" ? 13 : undefined,
        keyCode: key === "Enter" ? 13 : undefined,
        bubbles: true,
        cancelable: true
      },
      modifiers || {}
    );

    node.dispatchEvent(new KeyboardEvent("keydown", init));
    node.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  function dispatchEnter(node, modifiers) {
    const init = Object.assign(
      {
        key: "Enter",
        code: "Enter",
        which: 13,
        keyCode: 13,
        bubbles: true,
        cancelable: true
      },
      modifiers || {}
    );

    node.dispatchEvent(new KeyboardEvent("keydown", init));
    node.dispatchEvent(new KeyboardEvent("keypress", init));
    node.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  function clickElementRobust(node) {
    if (!(node instanceof HTMLElement)) {
      return;
    }

    node.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window })
    );
    node.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window })
    );
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    if (typeof node.click === "function") {
      node.click();
    }
  }

  function getElementText(node) {
    if (!(node instanceof Element)) {
      return "";
    }

    return normalizeText(
      [
        node.getAttribute("aria-label") || "",
        node.getAttribute("title") || "",
        node.getAttribute("placeholder") || "",
        node.textContent || ""
      ].join(" ")
    );
  }

  function summarizeNode(node) {
    if (!(node instanceof Element)) {
      return "";
    }

    const tag = node.tagName.toLowerCase();
    const id = node.id ? `#${node.id}` : "";
    const cls =
      node.classList && node.classList.length
        ? `.${Array.from(node.classList).slice(0, 3).join(".")}`
        : "";
    const attrs = [
      node.getAttribute("data-testid"),
      node.getAttribute("role"),
      node.getAttribute("aria-label"),
      node.getAttribute("placeholder")
    ]
      .filter(Boolean)
      .join("|");
    return `${tag}${id}${cls}${attrs ? `[${attrs.slice(0, 80)}]` : ""}`;
  }

  function summarizeSnapshot(snapshot) {
    return {
      messageCount: snapshot.messageItems.length,
      assistantCount: snapshot.assistantItems.length,
      userCount: snapshot.userItems.length,
      imageCount: snapshot.imageCandidates.length,
      loadingCount: snapshot.loadingCount,
      sendButtonEnabled: snapshot.sendButtonEnabled,
      stopButtonVisible: snapshot.stopButtonVisible,
      composerValue: snapshot.composerValue.slice(0, 120)
    };
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }

    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isFocusable(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    if (typeof node.focus !== "function") {
      return false;
    }

    if (
      node.matches("textarea, input, [contenteditable='true'], [role='textbox']") ||
      node.tabIndex >= 0
    ) {
      return true;
    }

    return false;
  }

  function isNearConversationInput(node, composerOverride) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    const composer = composerOverride instanceof HTMLElement ? composerOverride : null;
    const nodeRect = node.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const nodeForm = node.closest("form");
    const composerForm = composer instanceof HTMLElement ? composer.closest("form") : null;
    const nodeFooter = node.closest("footer");
    const composerFooter = composer instanceof HTMLElement ? composer.closest("footer") : null;

    return shouldTreatNodeAsNearComposer({
      nodeRect,
      composerRect: composer instanceof HTMLElement ? composer.getBoundingClientRect() : null,
      sharesFormContainer: Boolean(nodeForm && composerForm && nodeForm === composerForm),
      sharesFooterContainer: Boolean(nodeFooter && composerFooter && nodeFooter === composerFooter),
      viewportHeight
    });
  }

  function isNearby(a, b) {
    if (!(a instanceof Element) || !(b instanceof Element)) {
      return false;
    }

    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return Math.abs(ra.top - rb.top) < 180 && Math.abs(ra.left - rb.left) < 400;
  }

  function getNodeIdentity(node) {
    if (!(node instanceof Element)) {
      return "";
    }

    if (!node.__batchImageIdentity) {
      node.__batchImageIdentity = `bi_${Math.random().toString(36).slice(2, 10)}`;
    }
    return node.__batchImageIdentity;
  }

  function dedupeNodes(nodes) {
    const seen = new Set();
    const results = [];
    for (const node of nodes) {
      const id = getNodeIdentity(node);
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      results.push(node);
    }
    return results;
  }

  function pickLargestSrcset(srcset) {
    const entries = String(srcset || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const match = part.match(/^(\S+)\s+(\d+)(w|x)$/i);
        if (match) {
          return {
            url: match[1],
            size: Number(match[2] || 0)
          };
        }
        return {
          url: part.split(/\s+/)[0],
          size: 0
        };
      })
      .sort((a, b) => b.size - a.size);

    return entries.length ? entries[0].url : "";
  }

  function extractBackgroundImageUrl(node) {
    if (!(node instanceof HTMLElement)) {
      return "";
    }

    const style = window.getComputedStyle(node);
    const value = style.backgroundImage || "";
    const match = value.match(/url\(["']?([^"')]+)["']?\)/i);
    return match ? match[1] : "";
  }

  function isValidImageUrl(url) {
    const value = String(url || "").trim();
    if (!value) {
      return false;
    }
    if (/^(blob:|data:)/i.test(value)) {
      return false;
    }
    return /^https?:\/\//i.test(value);
  }

  function isLikelyUsefulImage(width, height, url) {
    if (width >= 256 && height >= 256) {
      return true;
    }
    return !/avatar|icon|thumb|thumbnail/i.test(String(url || ""));
  }

  function normalizeUrlKey(url) {
    try {
      const parsed = new URL(String(url || "").trim());
      parsed.hash = "";
      return parsed.toString();
    } catch (error) {
      return String(url || "").trim();
    }
  }

  function getDebugMode(settings) {
    if (settings && typeof settings.debugMode === "boolean") {
      return settings.debugMode;
    }

    try {
      const local = window.localStorage.getItem("__batchImageDebug");
      if (local === "1" || local === "true") {
        return true;
      }
      const session = window.sessionStorage.getItem("__batchImageDebug");
      if (session === "1" || session === "true") {
        return true;
      }
    } catch (error) {
      console.warn("[batch-image] debug mode lookup failed", error);
    }

    return false;
  }

  async function logDebug(taskId, code, message, data) {
    const run = taskId ? activeRuns.get(taskId) : null;
    if (!run || !run.debug) {
      return;
    }
    await logStep(taskId, "info", code, message, data, true);
  }

  async function logStep(taskId, level, code, message, data, debugOnly) {
    const detail = data ? safeJson(data) : "";
    const text = detail ? `[${code}] ${message} | ${detail}` : `[${code}] ${message}`;
    await sendLog(taskId, level, text, debugOnly);
  }

  function safeJson(value) {
    const seen = new WeakSet();
    return JSON.stringify(
      value,
      (key, current) => {
        if (current instanceof Element) {
          return summarizeNode(current);
        }
        if (typeof current === "object" && current !== null) {
          if (seen.has(current)) {
            return "[Circular]";
          }
          seen.add(current);
        }
        return current;
      }
    );
  }

  async function sendLog(taskId, level, message) {
    try {
      await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.TASK_LOG,
        taskId,
        level,
        message
      });
    } catch (error) {
      console.warn("[batch-image] sendLog failed", error);
    }
  }
})();
