// Chromium's service worker can't play audio, so alert sounds come here.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "offscreenSound") globalThis.tetherSound.play(msg.name, msg.opts || {});
});
