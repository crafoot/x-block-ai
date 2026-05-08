importScripts("shared.js");

(function() {
  "use strict";

  chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.type === "XHB2_CLASSIFY") {
      globalThis.XHB2.classifyComment(message.text, message.profile)
        .then(function(result) {
          sendResponse({ isSpam: result.isSpam, confidence: result.confidence, reason: result.reason, source: result.source });
        })
        .catch(function(e) {
          sendResponse({ isSpam: false, reason: "error:" + e.message });
        });
      return true;
    }

    if (message.type === "XHB2_MANUAL_BLOCK") {
      globalThis.XHB2.manualBlock(message.text, message.profile)
        .then(function() { sendResponse({ ok: true }); })
        .catch(function(e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (message.type === "XHB2_BLOCKED") {
      globalThis.XHB2.learnFromBlock("", { handle: message.handle }, "auto-blocked")
        .then(function() { sendResponse({ ok: true }); })
        .catch(function() { sendResponse({ ok: true }); });
      return true;
    }

    if (message.type === "XHB2_GET_STATS") {
      globalThis.XHB2.getKBStats()
        .then(function(s) { sendResponse(s); })
        .catch(function() { sendResponse({ entries: 0, totalBlocks: 0 }); });
      return true;
    }

    if (message.type === "XHB2_EXPORT") {
      globalThis.XHB2.exportKB()
        .then(function(j) { sendResponse({ ok: true, data: j }); })
        .catch(function(e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (message.type === "XHB2_IMPORT") {
      globalThis.XHB2.importKB(message.data)
        .then(function(kb) { sendResponse({ ok: true, count: kb.entries.length }); })
        .catch(function(e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    if (message.type === "XHB2_GET_CONFIG") {
      globalThis.XHB2.getConfig()
        .then(function(c) { sendResponse(c); })
        .catch(function() { sendResponse({}); });
      return true;
    }

    if (message.type === "XHB2_SAVE_CONFIG") {
      globalThis.XHB2.saveConfig(message.config)
        .then(function() { sendResponse({ ok: true }); })
        .catch(function(e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    return false;
  });
})();
