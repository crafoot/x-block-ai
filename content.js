(function() {
  "use strict";

  var ARTICLE = 'article[role="article"]';
  var TEXT = '[data-testid="tweetText"]';
  var NAME = '[data-testid="User-Name"]';
  var STORAGE = "xhb2-db";
  var BLOCKED = "xhb2-blocked";

  var config = { autoBlock: true };
  var blockedHandles = new Set();
  var db = null;
  var observer = null;
  var scheduled = false;
  var blockQueue = Promise.resolve();

  // ── Load state ──
  async function loadState() {
    var raw = await chrome.storage.local.get([STORAGE, "xhb2-config", BLOCKED]);
    db = raw[STORAGE] || { accounts: {}, bayes: { spamCount: 0, hamCount: 0, words: {} } };
    config = raw["xhb2-config"] || config;
    blockedHandles = new Set(raw[BLOCKED] || []);
    schedule();
  }

  async function saveState() {
    var handles = Object.keys(db.accounts).filter(function(h) { return db.accounts[h].blocked; });
    await chrome.storage.local.set((function() {
      var d = {};
      d[STORAGE] = db;
      d[BLOCKED] = handles;
      return d;
    })());
  }

  // ── Feature extraction ──
  function getFeatures(text) {
    var cleaned = (text || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!cleaned) return [];
    var feats = [];
    for (var n = 3; n <= 4; n++) {
      for (var i = 0; i <= cleaned.length - n; i++) {
        feats.push(cleaned.slice(i, i + n));
      }
    }
    cleaned.split(/\s+/).forEach(function(w) { if (w.length >= 2) feats.push("W:" + w); });
    return Array.from(new Set(feats));
  }

  // ── DOM helpers ──
  function getText(article) { var el = article.querySelector(TEXT); return el ? el.innerText.trim() : ""; }
  function getProfile(article) {
    var el = article.querySelector(NAME);
    var raw = el ? el.innerText : "";
    var m = raw.match(/@([A-Za-z0-9_]+)/);
    return { displayName: m ? raw.slice(0, m.index).trim() : raw.trim(), handle: m ? "@" + m[1] : "" };
  }

  // ── Manual block ──
  function ensureBlockBtn(article) {
    if (article.querySelector(".xhb2-block-btn")) return;
    var btn = document.createElement("button");
    btn.className = "xhb2-block-btn";
    btn.textContent = "🚫 屏蔽并学习";
    btn.onclick = async function(e) {
      e.preventDefault(); e.stopPropagation();
      btn.textContent = "⏳"; btn.disabled = true;

      var text = getText(article);
      var profile = getProfile(article);
      var h = (profile.handle || "").toLowerCase().replace(/^@/, "");

      if (h && text) {
        // Add to account DB
        if (!db.accounts[h]) {
          db.accounts[h] = {
            handle: "@" + h, displayName: profile.displayName,
            blocked: true, reasons: ["manual"], sources: ["manual"],
            firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
            blockedAt: new Date().toISOString(), blockCount: 1
          };
        } else {
          db.accounts[h].blocked = true;
          db.accounts[h].reasons = (db.accounts[h].reasons || []).concat(["manual"]);
          db.accounts[h].blockCount = (db.accounts[h].blockCount || 0) + 1;
          db.accounts[h].lastSeen = new Date().toISOString();
          db.accounts[h].blockedAt = new Date().toISOString();
        }
        blockedHandles.add(h);

        // Train bayes
        db.bayes.spamCount++;
        var feats = getFeatures(text);
        feats.forEach(function(f) {
          if (!db.bayes.words[f]) db.bayes.words[f] = { spam: 0, ham: 0 };
          db.bayes.words[f].spam++;
        });

        await saveState();
      }

      applyMask(article, "manual");
      enqueueAutoBlock(article, profile.handle);
      btn.textContent = "✅"; btn.disabled = false;
    };
    article.appendChild(btn);
  }

  // ── Masking ──
  function applyMask(article, reason) {
    article.setAttribute("data-xhb2-masked", "true");
    article.setAttribute("data-xhb2-reason", reason);
    if (article.querySelector(".xhb2-overlay")) return;
    var overlay = document.createElement("div");
    overlay.className = "xhb2-overlay";
    var meta = document.createElement("div");
    meta.className = "xhb2-overlay-meta";
    meta.textContent = "🚫 已屏蔽";
    var btn = document.createElement("button");
    btn.className = "xhb2-overlay-btn";
    btn.textContent = "恢复";
    btn.onclick = function(e) {
      e.preventDefault(); e.stopPropagation();
      var rev = article.getAttribute("data-xhb2-revealed") === "true";
      article.setAttribute("data-xhb2-revealed", rev ? "false" : "true");
      btn.textContent = rev ? "恢复" : "隐藏";
    };
    overlay.append(meta, btn);
    article.appendChild(overlay);
    [TEXT, NAME].forEach(function(s) {
      article.querySelectorAll(s).forEach(function(el) { el.classList.add("xhb2-blur"); });
    });
  }

  // ── Auto-block via DOM ──
  function enqueueAutoBlock(article, handle) {
    blockQueue = blockQueue.then(function() { return autoBlock(article, handle); }).catch(function() {});
  }
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  async function autoBlock(article, handle) {
    var clean = handle.replace("@", "");
    var menu = article.querySelector('[data-testid="caret"], [aria-label*="More" i]');
    if (!menu) return;
    menu.click(); await wait(500);
    var items = document.querySelectorAll('[role="menuitem"]');
    var blockItem = null;
    [new RegExp("(Block|屏蔽|封锁).*" + clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
     /^(Block|屏蔽|封锁)$/i, /(Block|屏蔽|封锁)/i].forEach(function(p) {
      if (!blockItem) items.forEach(function(it) { if (p.test((it.innerText||"").replace(/\s+/g," ").trim())) blockItem = it; });
    });
    if (!blockItem) { document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); return; }
    blockItem.click(); await wait(500);
    var btns = document.querySelectorAll('[role="dialog"] [role="button"]');
    var confirm = null;
    btns.forEach(function(b) { if (/^(Block|屏蔽|封锁)$/i.test((b.innerText||"").trim())) confirm = b; });
    if (!confirm) { document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); return; }
    confirm.click();
  }

  // ── Check if blocked ──
  function isBlocked(handle) {
    var h = (handle || "").toLowerCase().replace(/^@/, "");
    return blockedHandles.has(h) || (db.accounts[h] && db.accounts[h].blocked);
  }

  // ── Process article ──
  function processArticle(article) {
    if (article.hasAttribute("data-xhb2")) return;
    article.setAttribute("data-xhb2", "1");
    ensureBlockBtn(article);

    var text = getText(article);
    var profile = getProfile(article);
    if (!text) return;

    // Already blocked → auto-mask
    if (isBlocked(profile.handle)) {
      applyMask(article, "account-db");
      return;
    }

    // Media check — skip if has images/video/cards (not pure text spam)
    var textNode = article.querySelector(TEXT);
    var media = article.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="card.wrapper"]');
    if (media && textNode && !textNode.contains(media)) return;
  }

  function scanPage() {
    document.querySelectorAll(ARTICLE).forEach(processArticle);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function() { scheduled = false; scanPage(); });
  }

  function startObserver() {
    observer = new MutationObserver(function(ms) {
      for (var i = 0; i < ms.length; i++) {
        if (ms[i].addedNodes.length) { schedule(); break; }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  chrome.storage.onChanged.addListener(function(changes) {
    if (changes[STORAGE] || changes[BLOCKED]) loadState();
  });

  loadState();
  startObserver();
})();
