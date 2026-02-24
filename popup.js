const statusElement = document.getElementById("status");
const cleanToggleButton = document.getElementById("clean-toggle-button");
const undoToggleButton = document.getElementById("undo-toggle-button");
const errorElement = document.getElementById("error");

function setError(message) {
  errorElement.textContent = message || "";
}

function setButtonsDisabled(disabled) {
  cleanToggleButton.disabled = disabled;
  undoToggleButton.disabled = disabled;
}

function updateUI(modeState) {
  const cleanEnabled = Boolean(modeState && modeState.cleanEnabled);
  const undoEnabled = Boolean(modeState && modeState.undoEnabled);

  let modeLabel = "OFF";
  if (cleanEnabled) {
    modeLabel = "掃除モード ON";
  } else if (undoEnabled) {
    modeLabel = "元に戻すモード ON";
  }

  statusElement.textContent = `現在: ${modeLabel}`;

  cleanToggleButton.textContent = cleanEnabled
    ? "掃除モードを停止"
    : "掃除モードを開始";
  undoToggleButton.textContent = undoEnabled
    ? "元に戻すモードを停止"
    : "元に戻すモードを開始";

  cleanToggleButton.classList.toggle("is-active", cleanEnabled);
  undoToggleButton.classList.toggle("is-active", undoEnabled);
}

function withActiveTab(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    callback(tabs[0]);
  });
}

function sendMessageToActiveTab(message) {
  return new Promise((resolve, reject) => {
    withActiveTab((tab) => {
      if (!tab || typeof tab.id !== "number") {
        reject(new Error("アクティブなタブを取得できません。"));
        return;
      }

      chrome.tabs.sendMessage(tab.id, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  });
}

async function syncMode() {
  try {
    const response = await sendMessageToActiveTab({ type: "GET_MODES" });
    updateUI(response);
    setButtonsDisabled(false);
    setError("");
  } catch (_error) {
    updateUI({ cleanEnabled: false, undoEnabled: false });
    setButtonsDisabled(true);
    setError("このページでは利用できません。");
  }
}

cleanToggleButton.addEventListener("click", async () => {
  setButtonsDisabled(true);
  setError("");

  try {
    const response = await sendMessageToActiveTab({ type: "TOGGLE_CLEAN_MODE" });
    updateUI(response);
  } catch (_error) {
    setError("掃除モードの切替に失敗しました。");
  } finally {
    await syncMode();
  }
});

undoToggleButton.addEventListener("click", async () => {
  setButtonsDisabled(true);
  setError("");

  try {
    const response = await sendMessageToActiveTab({ type: "TOGGLE_UNDO_MODE" });
    updateUI(response);
  } catch (_error) {
    setError("元に戻すモードの切替に失敗しました。");
  } finally {
    await syncMode();
  }
});

syncMode();
