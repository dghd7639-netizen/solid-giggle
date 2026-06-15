// Content-script hotfix: broaden Create Image / image tool detection before content.js runs.
// The main content.js still owns task execution; this helper only nudges the UI into
// image mode when the visible ChatGPT wording changed or is localized.
(function () {
  const shared = globalThis.BatchImageShared || {};
  const MESSAGE_TYPES = shared.MESSAGE_TYPES || {};
  const RUN_TASK_TYPE = MESSAGE_TYPES.RUN_TASK || "batch-image:run-task";

  const IMAGE_MODE_RE = /(?:create|generate|make|draw)\s+(?:an?\s+)?(?:image|picture|photo)|image\s+(?:generation|tool|mode)|生成(?:一张|图片|图像|照片)?|创建(?:图片|图像|照片)|图片生成|图像生成|画图|绘图/i;
  const TOOL_BUTTON_RE = /^(tools?|all tools|view all tools|more tools|use a tool|工具|更多工具|查看全部工具)$/i;

  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.onMessage) {
    return;
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== RUN_TASK_TYPE) {
      return false;
    }
    if (message.settings && message.settings.autoSelectCreateImage === false) {
      return false;
    }

    setTimeout(() => {
      tryEnableImageModeHotfix();
    }, 0);

    return false;
  });

  function tryEnableImageModeHotfix() {
    if (isImageModeAlreadyActive()) {
      return;
    }

    const composer = findComposer();
    const direct = findCandidate(
      "button,[role='button'],[role='tab'],[aria-pressed],[data-state],[data-selected]",
      (node) => IMAGE_MODE_RE.test(getText(node)) && isNearComposer(node, composer)
    );
    if (direct) {
      clickElement(direct);
      return;
    }

    const toolButton = findCandidate(
      "button,[role='button']",
      (node) => TOOL_BUTTON_RE.test(getText(node)) && isNearComposer(node, composer)
    );
    if (!toolButton) {
      return;
    }

    clickElement(toolButton);
    setTimeout(() => {
      const menuItem = findCandidate(
        "[role='menuitem'],[role='option'],button,[role='button'],[role='tab']",
        (node) => IMAGE_MODE_RE.test(getText(node))
      );
      if (menuItem) {
        clickElement(menuItem);
      }
    }, 300);
  }

  function isImageModeAlreadyActive() {
    const nodes = Array.from(
      document.querySelectorAll("button,[role='button'],[role='tab'],[aria-pressed],[data-state],[data-selected]")
    );
    return nodes.some((node) => {
      if (!(node instanceof HTMLElement) || !isVisible(node)) {
        return false;
      }
      if (!IMAGE_MODE_RE.test(getText(node))) {
        return false;
      }
      return (
        node.getAttribute("aria-pressed") === "true" ||
        node.getAttribute("data-state") === "on" ||
        node.getAttribute("data-selected") === "true" ||
        node.getAttribute("aria-selected") === "true"
      );
    });
  }

  function findCandidate(selector, predicate) {
    const nodes = Array.from(document.querySelectorAll(selector));
    for (const node of nodes) {
      if (!(node instanceof HTMLElement) || !isVisible(node)) {
        continue;
      }
      if (predicate(node)) {
        return node;
      }
    }
    return null;
  }

  function findComposer() {
    const selectors = [
      "textarea[data-testid='composer-text-input']",
      "textarea#prompt-textarea",
      "[contenteditable='true'][role='textbox']",
      "form textarea",
      "footer textarea",
      "form [contenteditable='true']",
      "footer [contenteditable='true']"
    ];

    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node instanceof HTMLElement && isVisible(node)) {
        return node;
      }
    }
    return null;
  }

  function isNearComposer(node, composer) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    if (composer instanceof HTMLElement) {
      const nodeForm = node.closest("form");
      const composerForm = composer.closest("form");
      if (nodeForm && composerForm && nodeForm === composerForm) {
        return true;
      }

      const nodeFooter = node.closest("footer");
      const composerFooter = composer.closest("footer");
      if (nodeFooter && composerFooter && nodeFooter === composerFooter) {
        return true;
      }

      const a = node.getBoundingClientRect();
      const b = composer.getBoundingClientRect();
      const verticalGap = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom));
      const horizontalGap = Math.max(0, Math.max(a.left - b.right, b.left - a.right));
      return verticalGap <= 260 && horizontalGap <= 480;
    }

    const rect = node.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    return rect.top > viewportHeight * 0.45;
  }

  function clickElement(node) {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    if (typeof node.click === "function") {
      node.click();
    }
  }

  function getText(node) {
    return normalizeText([
      node.getAttribute("aria-label") || "",
      node.getAttribute("title") || "",
      node.getAttribute("placeholder") || "",
      node.textContent || ""
    ].join(" "));
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(node) {
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
})();
