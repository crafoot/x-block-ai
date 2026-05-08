importScripts("shared.js");

(function() {
  "use strict";

  chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    // ── 3-tier classification ──
    if (msg.type === "XHB2_CLASSIFY") {
      globalThis.XHB2.classifyComment(msg.text, msg.profile)
        .then(function(result) {
          // Auto-learn from result
          return globalThis.XHB2.learnFromResult(msg.text, msg.profile, result)
            .then(function() { return result; });
        })
        .then(function(result) {
          sendResponse({
            isSpam: result.isSpam,
            confidence: result.confidence,
            reason: result.reason,
            source: result.source
          });
        })
        .catch(function(e) {
          sendResponse({ isSpam: false, reason: "error:" + e.message });
        });
      return true;
    }

    // ── Manual block + learn ──
    if (msg.type === "XHB2_MANUAL_BLOCK") {
      globalThis.XHB2.manualBlock(msg.text, msg.profile)
        .then(function() { sendResponse({ ok: true }); })
        .catch(function(e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    // ── Account was blocked in DOM ──
    if (msg.type === "XHB2_BLOCKED") {
      globalThis.XHB2.addToAccountDB(
        { handle: msg.handle, displayName: "" },
        "auto-blocked", "dom-block", true
      ).then(function() { sendResponse({ ok: true }); })
        .catch(function() { sendResponse({ ok: true }); });
      return true;
    }

    // ── Stats ──
    if (msg.type === "XHB2_GET_STATS") {
      globalThis.XHB2.getStats()
        .then(function(s) { sendResponse(s); })
        .catch(function() { sendResponse({}); });
      return true;
    }

    // ── Export / Import ──
    if (msg.type === "XHB2_EXPORT") {
      globalThis.XHB2.exportDB()
        .then(function(j) { sendResponse({ ok: true, data: j }); })
        .catch(function(e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }
    if (msg.type === "XHB2_IMPORT") {
      globalThis.XHB2.importDB(msg.data)
        .then(function(db) { sendResponse({ ok: true, count: Object.keys(db.accounts).length }); })
        .catch(function(e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    // ── Config ──
    if (msg.type === "XHB2_GET_CONFIG") {
      globalThis.XHB2.getConfig()
        .then(function(c) { sendResponse(c); })
        .catch(function() { sendResponse({}); });
      return true;
    }
    if (msg.type === "XHB2_SAVE_CONFIG") {
      globalThis.XHB2.saveConfig(msg.config)
        .then(function() { sendResponse({ ok: true }); })
        .catch(function(e) { sendResponse({ ok: false, error: e.message }); });
      return true;
    }

    return false;
  });
})();
