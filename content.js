(function() {
  "use strict";

  var ARTICLE = 'article[role="article"]';
  var TEXT = '[data-testid="tweetText"]';
  var NAME = '[data-testid="User-Name"]';
  var STORAGE = "xhb2-db";
  var BLOCKED = "xhb2-blocked";

  var config = { autoBlock: true, bayesMinConfidence: 0.82, llmMinConfidence: 0.55, useLLM: true };
  var blockedHandles = new Set();
  var db = null;
  var observer = null;
  var scheduled = false;
  var blockQueue = Promise.resolve();
  var classifying = new Set();

  // ── Load state ──
  async function loadState() {
    var raw = await chrome.storage.local.get([STORAGE, "xhb2-config", BLOCKED]);
    db = raw[STORAGE] || { accounts: {}, bayes: { spamCount: 0, hamCount: 0, words: {} } };
    var cfg = raw["xhb2-config"] || {};
    config.bayesMinConfidence = cfg.bayesMinConfidence || 0.82;
    config.llmMinConfidence = cfg.llmMinConfidence || 0.55;
    config.useLLM = cfg.useLLM !== false && !!cfg.llmEndpoint;
    blockedHandles = new Set(raw[BLOCKED] || []);
    schedule();
  }

  async function saveState() {
    var handles = Object.keys(db.accounts).filter(function(h) { return db.accounts[h].blocked; });
    var data = {}; data[STORAGE] = db; data[BLOCKED] = handles;
    await chrome.storage.local.set(data);
  }

  // ── Bayes ──
  function getFeatures(text) {
    var cleaned = (text || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!cleaned) return [];
    var feats = [];
    for (var n = 3; n <= 4; n++)
      for (var i = 0; i <= cleaned.length - n; i++) feats.push(cleaned.slice(i, i + n));
    cleaned.split(/\s+/).forEach(function(w) { if (w.length >= 2) feats.push("W:" + w); });
    return Array.from(new Set(feats));
  }

  function classifyLocal(text) {
    if (!db || db.bayes.spamCount < 3 || db.bayes.hamCount < 1) return { spam: false, conf: 0 };
    var feats = getFeatures(text);
    if (!feats.length) return { spam: false, conf: 0 };
    var ts = db.bayes.spamCount, th = db.bayes.hamCount, total = ts + th;
    var sScore = Math.log(ts / total), hScore = Math.log(th / total);
    var vocab = Object.keys(db.bayes.words).length || 1;
    feats.forEach(function(f) {
      var w = db.bayes.words[f] || { spam: 0, ham: 0 };
      sScore += Math.log((w.spam + 1) / (ts + vocab));
      hScore += Math.log((w.ham + 1) / (th + vocab));
    });
    var max = Math.max(sScore, hScore);
    var prob = Math.exp(sScore - max) / (Math.exp(sScore - max) + Math.exp(hScore - max));
    return { spam: prob >= 0.5, conf: prob };
  }

  function trainLocal(text, isSpam) {
    if (!db) return;
    if (isSpam) db.bayes.spamCount++; else db.bayes.hamCount++;
    getFeatures(text).forEach(function(f) {
      if (!db.bayes.words[f]) db.bayes.words[f] = { spam: 0, ham: 0 };
      if (isSpam) db.bayes.words[f].spam++; else db.bayes.words[f].ham++;
    });
  }

  // ── Add to account DB ──
  function addAccount(profile, reason, source) {
    var h = (profile.handle || "").toLowerCase().replace(/^@/, "");
    if (!h) return;
    var acc = db.accounts[h];
    if (acc) {
      acc.blocked = true; acc.blockCount = (acc.blockCount || 0) + 1;
      acc.reasons = Array.from(new Set((acc.reasons || []).concat([reason])));
      acc.sources = Array.from(new Set((acc.sources || []).concat([source])));
      acc.lastSeen = new Date().toISOString();
    } else {
      db.accounts[h] = {
        handle: "@" + h, displayName: profile.displayName || "", blocked: true,
        reasons: [reason], sources: [source],
        firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), blockCount: 1
      };
    }
    blockedHandles.add(h);
  }

  // ── DOM ──
  function getText(article) { var el = article.querySelector(TEXT); return el ? el.innerText.trim() : ""; }
  function getProfile(article) {
    var el = article.querySelector(NAME); var raw = el ? el.innerText : "";
    var m = raw.match(/@([A-Za-z0-9_]+)/);
    return { displayName: m ? raw.slice(0, m.index).trim() : raw.trim(), handle: m ? "@" + m[1] : "" };
  }

  // ── Block button ──
  function ensureBlockBtn(article) {
    if (article.querySelector(".xhb2-block-btn")) return;
    var btn = document.createElement("button");
    btn.className = "xhb2-block-btn";
    btn.textContent = "🚫 屏蔽并学习";
    btn.onclick = async function(e) {
      e.preventDefault(); e.stopPropagation();
      btn.textContent = "⏳"; btn.disabled = true;
      var text = getText(article), profile = getProfile(article);
      if (text && profile.handle) {
        addAccount(profile, "manual", "manual");
        trainLocal(text, true);
        await saveState();
      }
      applyMask(article, "manual");
      enqueueAutoBlock(article, profile.handle);
      btn.textContent = "✅"; btn.disabled = false;
    };
    article.appendChild(btn);
  }

  // ── Mask ──
  function applyMask(article, reason) {
    article.setAttribute("data-xhb2-masked", "true");
    article.setAttribute("data-xhb2-reason", reason);
    if (article.querySelector(".xhb2-overlay")) return;
    var overlay = document.createElement("div"); overlay.className = "xhb2-overlay";
    var meta = document.createElement("div"); meta.className = "xhb2-overlay-meta"; meta.textContent = "🚫 已屏蔽";
    var rbtn = document.createElement("button"); rbtn.className = "xhb2-overlay-btn"; rbtn.textContent = "恢复";
    rbtn.onclick = function(ev) { ev.preventDefault(); ev.stopPropagation();
      var rev = article.getAttribute("data-xhb2-revealed") === "true";
      article.setAttribute("data-xhb2-revealed", rev ? "false" : "true");
      rbtn.textContent = rev ? "恢复" : "隐藏";
    };
    overlay.append(meta, rbtn); article.appendChild(overlay);
    [TEXT, NAME].forEach(function(s) { article.querySelectorAll(s).forEach(function(el) { el.classList.add("xhb2-blur"); }); });
  }

  // ── Auto-block DOM ──
  function enqueueAutoBlock(article, handle) {
    blockQueue = blockQueue.then(function() { return autoBlock(article, handle); }).catch(function() {});
  }
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  async function autoBlock(article, handle) {
    // Inject hide CSS BEFORE any clicks
    var hideStyle = document.createElement("style"); hideStyle.id = "xhb2-hide-dialog";
    hideStyle.textContent = '[role="dialog"]{opacity:0!important}[data-testid*="confirmation"]{opacity:0!important}[data-testid*="sheetDialog"]{opacity:0!important}[data-testid*="sheet"]{opacity:0!important}';
    document.head.appendChild(hideStyle);

    var clean = handle.replace("@", "");
    var menu = article.querySelector('[data-testid="caret"], [aria-label*="More" i]');
    if (!menu) { hideStyle.remove(); return; }
    menu.click(); await wait(500);

    var items = document.querySelectorAll('[role="menuitem"]');
    var blockItem = null;
    [new RegExp("(Block|屏蔽|封锁).*" + clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
     /^(Block|屏蔽|封锁)$/i, /(Block|屏蔽|封锁)/i].forEach(function(p) {
      if (!blockItem) items.forEach(function(it) { if (p.test((it.innerText||"").replace(/\s+/g," ").trim())) blockItem = it; });
    });
    if (!blockItem) { document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); hideStyle.remove(); return; }
    blockItem.click(); await wait(600);

    // Find confirm button
    var confirm = null;
    var allBtns = document.querySelectorAll('[role="dialog"] [role="button"], [data-testid="confirmationSheetConfirm"]');
    allBtns.forEach(function(b) { if (/^(Block|屏蔽|封锁|ブロック)$/i.test((b.innerText||"").trim())) confirm = b; });
    if (!confirm) allBtns.forEach(function(b) { if (/(Block|屏蔽|封锁|ブロック)/i.test((b.innerText||"").trim())) confirm = b; });
    if (!confirm) {
      var diag = document.querySelector('[role="dialog"]');
      if (diag) { var dbtns = diag.querySelectorAll('[role="button"]'); if (dbtns.length) confirm = dbtns[dbtns.length - 1]; }
    }
    if (confirm) confirm.click();
    else document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
    await wait(400); hideStyle.remove();
  }

  // ── Check blocked ──
  function isBlocked(handle) {
    var h = (handle || "").toLowerCase().replace(/^@/, "");
    return blockedHandles.has(h) || (db.accounts[h] && db.accounts[h].blocked);
  }

  // ── LLM call ──
  function callLLM(text, profile) {
    return new Promise(function(resolve) {
      var done = false;
      var timer = setTimeout(function() { if (!done) { done = true; resolve(null); } }, 5000);
      try {
        chrome.runtime.sendMessage({ type: "XHB2_CLASSIFY", text: text, profile: profile }, function(r) {
          if (!done) { done = true; clearTimeout(timer); resolve(r); }
        });
      } catch(e) { if (!done) { done = true; clearTimeout(timer); resolve(null); } }
    });
  }

  // ── Auto classify + block ──
  async function autoHandle(article, text, profile) {
    var h = (profile.handle || "").toLowerCase();
    if (classifying.has(h)) return;
    classifying.add(h);

    try {
      // Local Bayes
      var result = classifyLocal(text);
      if (result.conf >= config.bayesMinConfidence && result.spam) {
        addAccount(profile, "bayes(" + result.conf.toFixed(2) + ")", "bayes");
        trainLocal(text, true);
        await saveState();
        applyMask(article, "bayes:" + result.conf.toFixed(2));
        enqueueAutoBlock(article, profile.handle);
        return;
      }

      // LLM fallback
      if (config.useLLM && result.conf >= config.llmMinConfidence) {
        var llm = await callLLM(text, profile);
        if (llm && llm.isSpam) {
          addAccount(profile, "llm:" + (llm.reason || ""), "llm");
          trainLocal(text, true);
          await saveState();
          applyMask(article, "llm:" + (llm.confidence||0).toFixed(2));
          enqueueAutoBlock(article, profile.handle);
        }
      }
    } catch(e) { console.warn("xhb2 classify:", e.message); }
    finally { classifying.delete(h); }
  }

  // ── Process ──
  function processArticle(article) {
    if (article.hasAttribute("data-xhb2")) return;
    article.setAttribute("data-xhb2", "1");
    ensureBlockBtn(article);
    var text = getText(article), profile = getProfile(article);
    if (!text) return;
    if (isBlocked(profile.handle)) { applyMask(article, "account-db"); return; }

    var textNode = article.querySelector(TEXT);
    var media = article.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="card.wrapper"]');
    if (media && textNode && !textNode.contains(media)) return;

    autoHandle(article, text, profile);
  }

  function scanPage() { document.querySelectorAll(ARTICLE).forEach(processArticle); }
  function schedule() { if (scheduled) return; scheduled = true; requestAnimationFrame(function() { scheduled = false; scanPage(); }); }
  function startObserver() { observer = new MutationObserver(function(ms) { for (var i = 0; i < ms.length; i++) if (ms[i].addedNodes.length) { schedule(); break; } }); observer.observe(document.body, { childList: true, subtree: true }); }

  chrome.storage.onChanged.addListener(function(changes) { if (changes[STORAGE] || changes[BLOCKED]) loadState(); });
  loadState(); startObserver();
})();
