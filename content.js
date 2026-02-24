(() => {
  const STYLE_ID = "__purgedom_cleaner_style__";
  const CLEAN_MODE_CLASS = "__purgedom_clean_mode_active__";
  const UNDO_MODE_CLASS = "__purgedom_undo_mode_active__";
  const CLEAN_HIGHLIGHT_CLASS = "__purgedom_cleaner_highlight__";
  const RESTORE_HIGHLIGHT_CLASS = "__purgedom_restore_highlight__";
  const STORAGE_KEY = "__purgedom_removed_selectors__";
  const REMOVED_ATTR = "data-purgedom-removed";
  const REMOVED_SELECTOR_ATTR = "data-purgedom-selector";
  const UNDO_PANEL_ID = "__purgedom_undo_panel__";
  const UNDO_PANEL_LABEL_CLASS = "__purgedom_undo_panel_label__";
  const RESTORE_ALL_BUTTON_CLASS = "__purgedom_restore_all_button__";

  let cleanModeEnabled = false;
  let undoModeEnabled = false;
  let highlightedElement = null;
  let persistedSelectors = [];
  let persistenceObserver = null;
  let persistApplyScheduled = false;
  let interactionListenersAttached = false;
  let storageWriteQueue = Promise.resolve();
  let undoPanelElement = null;
  let restoreAllButtonElement = null;

  function getPageStorageKey() {
    return `${window.location.origin}${window.location.pathname}${window.location.search}`;
  }

  async function getStorageData() {
    const result = await browser.storage.local.get(STORAGE_KEY);
    const value = result[STORAGE_KEY];

    if (!value || typeof value !== "object") {
      return {};
    }

    return value;
  }

  async function setStorageData(data) {
    await browser.storage.local.set({ [STORAGE_KEY]: data });
  }

  function normalizeSelectorList(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    const seen = new Set();
    const normalized = [];

    value.forEach((item) => {
      if (typeof item !== "string") {
        return;
      }

      const selector = item.trim();
      if (!selector || seen.has(selector)) {
        return;
      }

      seen.add(selector);
      normalized.push(selector);
    });

    return normalized;
  }

  async function loadPersistedSelectors() {
    try {
      const allData = await getStorageData();
      const pageKey = getPageStorageKey();
      return normalizeSelectorList(allData[pageKey]);
    } catch (_error) {
      return [];
    }
  }

  function enqueuePersistedSelectorsSave() {
    const selectorSnapshot = persistedSelectors.slice();

    storageWriteQueue = storageWriteQueue.then(async () => {
      try {
        const allData = await getStorageData();
        const pageKey = getPageStorageKey();

        if (selectorSnapshot.length === 0) {
          delete allData[pageKey];
        } else {
          allData[pageKey] = selectorSnapshot;
        }

        await setStorageData(allData);
      } catch (_error) {
        // 永続化に失敗しても画面操作は継続させる。
      }
    });
  }

  function startPersistenceObserver() {
    if (persistenceObserver || persistedSelectors.length === 0) {
      return;
    }

    persistenceObserver = new MutationObserver(() => {
      schedulePersistedRemovalApply();
    });

    persistenceObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function stopPersistenceObserver() {
    if (!persistenceObserver) {
      return;
    }

    persistenceObserver.disconnect();
    persistenceObserver = null;
  }

  function syncPersistenceObserver() {
    if (persistedSelectors.length === 0) {
      stopPersistenceObserver();
      return;
    }

    startPersistenceObserver();
  }

  function addPersistedSelector(selector) {
    if (typeof selector !== "string" || selector.length === 0) {
      return;
    }

    if (persistedSelectors.includes(selector)) {
      return;
    }

    persistedSelectors.push(selector);
    syncPersistenceObserver();
    enqueuePersistedSelectorsSave();
    updateRestoreAllButtonState();
  }

  function removePersistedSelector(selector) {
    if (typeof selector !== "string" || selector.length === 0) {
      return;
    }

    const next = persistedSelectors.filter((item) => item !== selector);
    if (next.length === persistedSelectors.length) {
      return;
    }

    persistedSelectors = next;
    syncPersistenceObserver();
    enqueuePersistedSelectorsSave();
    updateRestoreAllButtonState();
  }

  function ensureStyleElement() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${CLEAN_MODE_CLASS}, .${CLEAN_MODE_CLASS} * {
        cursor: crosshair !important;
      }

      .${UNDO_MODE_CLASS}, .${UNDO_MODE_CLASS} * {
        cursor: pointer !important;
      }

      .${CLEAN_MODE_CLASS}::before {
        content: "";
        position: fixed;
        inset: 0;
        background:
          repeating-linear-gradient(
            -45deg,
            rgba(255, 59, 48, 0.09) 0,
            rgba(255, 59, 48, 0.09) 10px,
            rgba(255, 59, 48, 0.05) 10px,
            rgba(255, 59, 48, 0.05) 20px
          );
        pointer-events: none !important;
        z-index: 2147483645;
      }

      .${CLEAN_MODE_CLASS}::after {
        content: "掃除モード ON: クリックで要素を掃除 / Escで終了";
        position: fixed;
        top: 14px;
        left: 50%;
        transform: translateX(-50%);
        padding: 8px 12px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.55);
        background: rgba(146, 27, 19, 0.92);
        color: #ffffff;
        font: 700 12px/1.2 "Hiragino Sans", "Yu Gothic UI", sans-serif;
        letter-spacing: 0.02em;
        pointer-events: none !important;
        z-index: 2147483646;
      }

      .${UNDO_MODE_CLASS}::before {
        content: "";
        position: fixed;
        inset: 0;
        background:
          repeating-linear-gradient(
            -45deg,
            rgba(22, 163, 74, 0.08) 0,
            rgba(22, 163, 74, 0.08) 10px,
            rgba(34, 197, 94, 0.04) 10px,
            rgba(34, 197, 94, 0.04) 20px
          );
        pointer-events: none !important;
        z-index: 2147483645;
      }

      #${UNDO_PANEL_ID} {
        position: fixed;
        top: 14px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        display: none;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        pointer-events: none !important;
      }

      .${UNDO_MODE_CLASS} #${UNDO_PANEL_ID} {
        display: flex;
      }

      .${UNDO_PANEL_LABEL_CLASS} {
        padding: 8px 12px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.55);
        background: rgba(21, 128, 61, 0.92);
        color: #ffffff;
        font: 700 12px/1.2 "Hiragino Sans", "Yu Gothic UI", sans-serif;
        letter-spacing: 0.02em;
      }

      .${RESTORE_ALL_BUTTON_CLASS} {
        border: 0;
        border-radius: 999px;
        padding: 8px 14px;
        background: #dcfce7;
        color: #14532d;
        font: 700 12px/1.2 "Hiragino Sans", "Yu Gothic UI", sans-serif;
        box-shadow: 0 2px 8px rgba(21, 128, 61, 0.25);
        cursor: pointer;
        pointer-events: auto !important;
      }

      .${RESTORE_ALL_BUTTON_CLASS}:hover {
        background: #bbf7d0;
      }

      .${RESTORE_ALL_BUTTON_CLASS}:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      [${REMOVED_ATTR}="1"] {
        display: none !important;
      }

      .${UNDO_MODE_CLASS} [${REMOVED_ATTR}="1"] {
        display: revert !important;
        box-shadow: inset 0 0 0 9999px rgba(74, 222, 128, 0.18) !important;
        outline: 1px dashed rgba(21, 128, 61, 0.55) !important;
        outline-offset: -1px !important;
        pointer-events: auto !important;
      }

      .${CLEAN_HIGHLIGHT_CLASS} {
        outline: 2px solid #ff3b30 !important;
        outline-offset: -2px !important;
      }

      .${RESTORE_HIGHLIGHT_CLASS} {
        outline: 2px solid #16a34a !important;
        outline-offset: -2px !important;
      }
    `;

    document.documentElement.appendChild(style);
  }

  function updateRestoreAllButtonState() {
    if (!restoreAllButtonElement) {
      return;
    }

    restoreAllButtonElement.disabled = persistedSelectors.length === 0;
  }

  function restoreAllRemovedElements() {
    const selectors = persistedSelectors.slice();
    selectors.forEach((selector) => {
      restoreElementsByStoredSelector(selector);
    });

    const remainingRemovedElements = document.querySelectorAll(
      `[${REMOVED_ATTR}="1"]`
    );
    remainingRemovedElements.forEach((element) => {
      restoreRemovedElement(element);
    });

    if (persistedSelectors.length > 0) {
      persistedSelectors = [];
      syncPersistenceObserver();
      enqueuePersistedSelectorsSave();
    }

    clearHighlight();
    updateRestoreAllButtonState();
  }

  function ensureUndoPanel() {
    if (undoPanelElement && restoreAllButtonElement) {
      return;
    }

    let panel = document.getElementById(UNDO_PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = UNDO_PANEL_ID;

      const label = document.createElement("div");
      label.className = UNDO_PANEL_LABEL_CLASS;
      label.textContent = "元に戻すモード中";

      const button = document.createElement("button");
      button.type = "button";
      button.className = RESTORE_ALL_BUTTON_CLASS;
      button.textContent = "掃除済みの要素をすべて元に戻す";

      panel.appendChild(label);
      panel.appendChild(button);
      document.documentElement.appendChild(panel);
    }

    undoPanelElement = panel;
    restoreAllButtonElement = panel.querySelector(`.${RESTORE_ALL_BUTTON_CLASS}`);

    if (restoreAllButtonElement && !restoreAllButtonElement.dataset.bound) {
      restoreAllButtonElement.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        restoreAllRemovedElements();
      });
      restoreAllButtonElement.dataset.bound = "1";
    }

    updateRestoreAllButtonState();
  }

  function clearHighlight() {
    if (!highlightedElement) {
      return;
    }

    highlightedElement.classList.remove(
      CLEAN_HIGHLIGHT_CLASS,
      RESTORE_HIGHLIGHT_CLASS
    );
    highlightedElement = null;
  }

  function setHighlight(target, className) {
    if (
      target === highlightedElement &&
      highlightedElement.classList.contains(className)
    ) {
      return;
    }

    clearHighlight();
    highlightedElement = target;
    highlightedElement.classList.add(className);
  }

  function isRemovableElement(target) {
    return Boolean(
      target &&
        target !== document.documentElement &&
        target !== document.body &&
        target.nodeType === Node.ELEMENT_NODE
    );
  }

  function isMarkedRemoved(element) {
    return (
      element instanceof Element && element.getAttribute(REMOVED_ATTR) === "1"
    );
  }

  function buildElementSelector(element) {
    if (!(element instanceof Element)) {
      return null;
    }

    const segments = [];
    let current = element;

    while (
      current &&
      current !== document.body &&
      current !== document.documentElement
    ) {
      const parent = current.parentElement;
      if (!parent) {
        break;
      }

      const tagName = current.tagName.toLowerCase();
      let index = 1;
      let sibling = current.previousElementSibling;

      while (sibling) {
        if (sibling.tagName === current.tagName) {
          index += 1;
        }
        sibling = sibling.previousElementSibling;
      }

      segments.unshift(`${tagName}:nth-of-type(${index})`);
      current = parent;
    }

    if (segments.length === 0) {
      return null;
    }

    return `body > ${segments.join(" > ")}`;
  }

  function queryElements(selector) {
    if (typeof selector !== "string" || selector.length === 0) {
      return [];
    }

    try {
      return Array.from(document.querySelectorAll(selector));
    } catch (_error) {
      return [];
    }
  }

  function markElementAsRemoved(element, selector) {
    if (!isRemovableElement(element)) {
      return;
    }

    element.classList.remove(CLEAN_HIGHLIGHT_CLASS, RESTORE_HIGHLIGHT_CLASS);
    element.setAttribute(REMOVED_ATTR, "1");
    element.setAttribute(REMOVED_SELECTOR_ATTR, selector);
  }

  function restoreRemovedElement(element) {
    if (!(element instanceof Element)) {
      return;
    }

    element.classList.remove(CLEAN_HIGHLIGHT_CLASS, RESTORE_HIGHLIGHT_CLASS);
    element.removeAttribute(REMOVED_ATTR);
    element.removeAttribute(REMOVED_SELECTOR_ATTR);
  }

  function markElementsAsRemovedBySelector(selector) {
    const elements = queryElements(selector);
    elements.forEach((element) => {
      markElementAsRemoved(element, selector);
      if (element === highlightedElement) {
        highlightedElement = null;
      }
    });
  }

  function findRemovedElementsByStoredSelector(selector) {
    if (typeof selector !== "string" || selector.length === 0) {
      return [];
    }

    const removedElements = document.querySelectorAll(`[${REMOVED_ATTR}="1"]`);
    return Array.from(removedElements).filter(
      (element) => element.getAttribute(REMOVED_SELECTOR_ATTR) === selector
    );
  }

  function restoreElementsByStoredSelector(selector) {
    const elements = findRemovedElementsByStoredSelector(selector);
    elements.forEach((element) => {
      restoreRemovedElement(element);
      if (element === highlightedElement) {
        highlightedElement = null;
      }
    });
    return elements.length;
  }

  function applyPersistedRemovals() {
    persistedSelectors.forEach((selector) => {
      markElementsAsRemovedBySelector(selector);
    });
  }

  function schedulePersistedRemovalApply() {
    if (persistApplyScheduled) {
      return;
    }

    persistApplyScheduled = true;
    window.requestAnimationFrame(() => {
      persistApplyScheduled = false;
      applyPersistedRemovals();
    });
  }

  function findRestoreTargetFromEvent(eventTarget) {
    if (!(eventTarget instanceof Element)) {
      return null;
    }

    const candidate = eventTarget.closest(`[${REMOVED_ATTR}="1"]`);
    if (!isRemovableElement(candidate)) {
      return null;
    }

    return candidate;
  }

  function onMouseMove(event) {
    if (cleanModeEnabled) {
      const target = event.target instanceof Element ? event.target : null;
      if (!isRemovableElement(target) || isMarkedRemoved(target)) {
        clearHighlight();
        return;
      }

      setHighlight(target, CLEAN_HIGHLIGHT_CLASS);
      return;
    }

    if (undoModeEnabled) {
      const target = findRestoreTargetFromEvent(event.target);
      if (!target) {
        clearHighlight();
        return;
      }

      setHighlight(target, RESTORE_HIGHLIGHT_CLASS);
    }
  }

  function onClick(event) {
    if (cleanModeEnabled) {
      const target = event.target instanceof Element ? event.target : null;
      if (!isRemovableElement(target) || isMarkedRemoved(target)) {
        return;
      }

      const selector = buildElementSelector(target);
      if (!selector) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      addPersistedSelector(selector);
      markElementsAsRemovedBySelector(selector);
      clearHighlight();
      return;
    }

    if (undoModeEnabled) {
      const target = findRestoreTargetFromEvent(event.target);
      if (!target) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const selector = target.getAttribute(REMOVED_SELECTOR_ATTR);
      if (!selector) {
        restoreRemovedElement(target);
        clearHighlight();
        return;
      }

      const restoredCount = restoreElementsByStoredSelector(selector);

      // DOM変化で旧selectorが現在DOMに一致しなくても、クリックした要素は確実に復活させる。
      if (restoredCount === 0) {
        restoreRemovedElement(target);
      }

      removePersistedSelector(selector);

      clearHighlight();
    }
  }

  function isEscapeKey(event) {
    return (
      event.key === "Escape" ||
      event.key === "Esc" ||
      event.code === "Escape" ||
      event.keyCode === 27
    );
  }

  function onEscapeKey(event) {
    if (!cleanModeEnabled && !undoModeEnabled) {
      return;
    }

    if (!isEscapeKey(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    disableAllModes();
  }

  function attachInteractionListeners() {
    if (interactionListenersAttached) {
      return;
    }

    interactionListenersAttached = true;
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onEscapeKey, true);
    window.addEventListener("keydown", onEscapeKey, true);
    window.addEventListener("keyup", onEscapeKey, true);
  }

  function detachInteractionListeners() {
    if (!interactionListenersAttached) {
      return;
    }

    interactionListenersAttached = false;
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onEscapeKey, true);
    window.removeEventListener("keydown", onEscapeKey, true);
    window.removeEventListener("keyup", onEscapeKey, true);
  }

  function enableCleanMode() {
    if (cleanModeEnabled) {
      return;
    }

    disableUndoMode();
    ensureStyleElement();
    cleanModeEnabled = true;
    document.documentElement.classList.add(CLEAN_MODE_CLASS);
    attachInteractionListeners();
  }

  function disableCleanMode() {
    if (!cleanModeEnabled) {
      return;
    }

    cleanModeEnabled = false;
    document.documentElement.classList.remove(CLEAN_MODE_CLASS);

    if (!undoModeEnabled) {
      detachInteractionListeners();
      clearHighlight();
    }
  }

  function enableUndoMode() {
    if (undoModeEnabled) {
      return;
    }

    disableCleanMode();
    ensureStyleElement();
    ensureUndoPanel();
    undoModeEnabled = true;
    document.documentElement.classList.add(UNDO_MODE_CLASS);
    attachInteractionListeners();
    applyPersistedRemovals();
    updateRestoreAllButtonState();
  }

  function disableUndoMode() {
    if (!undoModeEnabled) {
      return;
    }

    undoModeEnabled = false;
    document.documentElement.classList.remove(UNDO_MODE_CLASS);

    if (!cleanModeEnabled) {
      detachInteractionListeners();
      clearHighlight();
    }

    updateRestoreAllButtonState();
  }

  function disableAllModes() {
    disableCleanMode();
    disableUndoMode();
  }

  function buildModeStateResponse() {
    return {
      enabled: cleanModeEnabled,
      cleanEnabled: cleanModeEnabled,
      undoEnabled: undoModeEnabled
    };
  }

  async function initializePersistence() {
    // モードOFFでも掃除済み要素を隠せるよう、初期化時にスタイルを注入する。
    ensureStyleElement();
    persistedSelectors = await loadPersistedSelectors();
    applyPersistedRemovals();
    syncPersistenceObserver();

    // 遅延描画されるDOMにも再適用する。
    window.addEventListener(
      "load",
      () => {
        schedulePersistedRemovalApply();
      },
      { once: true }
    );
  }

  void initializePersistence();

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== "string") {
      return undefined;
    }

    if (message.type === "GET_CLEAN_MODE") {
      return buildModeStateResponse();
    }

    if (message.type === "GET_MODES") {
      return buildModeStateResponse();
    }

    if (message.type === "TOGGLE_CLEAN_MODE") {
      if (cleanModeEnabled) {
        disableCleanMode();
      } else {
        enableCleanMode();
      }
      return buildModeStateResponse();
    }

    if (message.type === "TOGGLE_UNDO_MODE") {
      if (undoModeEnabled) {
        disableUndoMode();
      } else {
        enableUndoMode();
      }
      return buildModeStateResponse();
    }

    if (message.type === "SET_CLEAN_MODE") {
      if (message.enabled) {
        enableCleanMode();
      } else {
        disableCleanMode();
      }
      return buildModeStateResponse();
    }

    if (message.type === "SET_UNDO_MODE") {
      if (message.enabled) {
        enableUndoMode();
      } else {
        disableUndoMode();
      }
      return buildModeStateResponse();
    }

    return undefined;
  });
})();
