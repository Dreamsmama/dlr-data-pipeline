const CONTROL_URL = chrome.runtime.getURL("control.html");

async function openControlPage() {
  const tabs = await chrome.tabs.query({ url: `${CONTROL_URL}*` });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId != null) {
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: CONTROL_URL, active: true });
}

chrome.action.onClicked.addListener(() => {
  openControlPage().catch((error) => console.error("open control page failed", error));
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    openControlPage().catch((error) => console.error("open control page failed", error));
  }
});
