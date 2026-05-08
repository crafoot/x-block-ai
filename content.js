(function() {
  "use strict";

  var ARTICLE_SEL = 'article[role="article"]';
  var TEXT_SEL = '[data-testid="tweetText"]';
  var NAME_SEL = '[data-testid="User-Name"]';
  var PROCESSED = "data-xhb2";
  var MASKED = "data-xhb2-masked";
  var REVEALED = "data-xhb2-revealed";

  var config = null;
  var observer = null;
  var scheduled = false;
  var classifying = new Set();
  var blockQueue = Promise.resolve();

  // ── DOM helpers ──
  function getArticleText(article) {
    var el = article.querySelector(TEXT_SEL);
    return el ? el.innerText.trim() : "";
  }

  function getProfile(article) {
    var nameEl = article.querySelector(NAME_SEL);
    var raw = nameEl ? nameEl.innerText : "";
    var m = raw.match(/@([A-Za-z0-9_]+)/);
    var handle = m ? "@" + m[1] : "";
    var displayName = m ? raw.slice(0, m.index).trim() : raw.trim();
    return { displayName: displayName, handle: handle };
  }

  function isPureText(article) {
    var textNode = article.querySelector(TEXT_SEL);
    if (!textNode) return false;
    var mediaSelectors = [
      '[data-testid="tweetPhoto"]', '[data-testid="videoPlayer"]',
      '[data-testid="card.wrapper"]', '[role="blockquote"]'
    ];
    return !mediaSelectors.some(function(s) {
      var m = article.querySelector(s);
      return m && !textNode.contains(m);
    });
  }

  // ── Masking ──
  function applyMask(article, reason) {
    article.setAttribute(MASKED, "true");
    article.setAttribute("data-xhb2-reason", reason);

    var overlay = article.querySelector(".xhb2-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "xhb2-overlay";
      var meta = document.createElement("div");
      meta.className = "xhb2-overlay-meta";
      meta.textContent = "🤖 AI判定垃圾评论";
      var btn = document.createElement("button");
      btn.className = "xhb2-overlay-btn";
      btn.textContent = "恢复查看";
      btn.onclick = function(e) {
        e.preventDefault(); e.stopPropagation();
        var r = article.getAttribute(REVEALED) === "true";
        article.setAttribute(REVEALED, r ? "false" : "true");
        btn.textContent = r ? "恢复查看" : "重新屏蔽";
        meta.textContent = r ? "🤖 AI判定垃圾评论" : "已恢复查看";
      };
      overlay.append(meta, btn);
      article.appendChild(overlay);
    }

    // Blur content
    [TEXT_SEL, NAME_SEL].forEach(function(s) {
      article.querySelectorAll(s).forEach(function(el) {
        el.classList.add("xhb2-blur");
      });
    });
  }

  function clearMask(article) {
    article.removeAttribute(MASKED);
    article.removeAttribute(REVEALED);
    article.querySelector(".xhb2-overlay")?.remove();
    article.querySelectorAll(".xhb2-blur").forEach(function(el) {
      el.classList.remove("xhb2-blur");
    });
  }

  // ── Manual block button ──
  function ensureBlockBtn(article) {
    var btn = article.querySelector(".xhb2-block-btn");
    if (btn) return;
    btn = document.createElement("button");
    btn.className = "xhb2-block-btn";
    btn.textContent = "🚫 屏蔽并学习";
    btn.onclick = async function(e) {
      e.preventDefault(); e.stopPropagation();
      btn.textContent = "⏳ 学习中...";
      btn.disabled = true;

      var text = getArticleText(article);
      var profile = getProfile(article);

      await chrome.runtime.sendMessage({
        type: "XHB2_MANUAL_BLOCK",
        text: text,
        profile: profile
      });

      applyMask(article, "manual");
      btn.textContent = "✅ 已学习";
    };
    article.appendChild(btn);
  }

  // ── Auto-classify ──
  async function autoClassify(article, text, profile) {
    var handle = profile.handle.toLowerCase();
    if (classifying.has(handle)) return;
    classifying.add(handle);

    try {
      var resp = await chrome.runtime.sendMessage({
        type: "XHB2_CLASSIFY",
        text: text,
        profile: profile
      });
      if (resp && resp.isSpam && config.autoBlock) {
        applyMask(article, resp.reason);
        enqueueAutoBlock(article, handle);
      }
    } catch(e) {
      console.warn("xhb2 classify err:", e);
    } finally {
      classifying.delete(handle);
    }
  }

  // ── Auto-block via DOM ──
  function enqueueAutoBlock(article, handle) {
    blockQueue = blockQueue.then(function() {
      return autoBlockAccount(article, handle);
    }).catch(function() {});
  }

  function wait(ms) {
    return new Promise(function(r) { setTimeout(r, ms); });
  }

  async function autoBlockAccount(article, handle) {
    var cleanHandle = handle.replace("@", "");
    var menuBtn = article.querySelector('[data-testid="caret"], [aria-label*="More" i], [aria-label*="更多"]');
    if (!menuBtn) return false;
    menuBtn.click();
    await wait(500);

    var patterns = [
      new RegExp("(Block|屏蔽|封锁|ブロック).*" + cleanHandle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      /^(Block|屏蔽|封锁|ブロック)$/i,
      /(Block|屏蔽|封锁|ブロック)/i
    ];
    var items = document.querySelectorAll('[role="menuitem"]');
    var blockItem = null;
    for (var i = 0; i < patterns.length && !blockItem; i++) {
      items.forEach(function(item) {
        if (patterns[i].test((item.innerText || "").replace(/\s+/g, " ").trim())) blockItem = item;
      });
    }
    if (!blockItem) { document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true})); return false; }
    blockItem.click();
    await wait(500);

    var buttons = document.querySelectorAll('[role="dialog"] [role="button"]');
    var confirmBtn = null;
    buttons.forEach(function(b) {
      if (/^(Block|屏蔽|封锁|ブロック)$/i.test((b.innerText||"").trim())) confirmBtn = b;
    });
    if (!confirmBtn) { document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true})); return false; }
    confirmBtn.click();

    chrome.runtime.sendMessage({ type: "XHB2_BLOCKED", handle: handle });
    return true;
  }

  // ── Main processing ──
  function processArticle(article) {
    if (article.hasAttribute(PROCESSED)) return;
    article.setAttribute(PROCESSED, "1");
    ensureBlockBtn(article);

    var text = getArticleText(article);
    var profile = getProfile(article);
    if (!text) return;

    if (!isPureText(article)) {
      clearMask(article);
      return;
    }

    // Async classification
    autoClassify(article, text, profile);
  }

  function scanPage() {
    document.querySelectorAll(ARTICLE_SEL).forEach(processArticle);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function() {
      scheduled = false;
      scanPage();
    });
  }

  async function loadConfig() {
    config = await new Promise(function(r) {
      chrome.storage.local.get("xhb2-config", function(d) { r(d["xhb2-config"] || {}); });
    });
    schedule();
  }

  function startObserver() {
    observer = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes.length || mutations[i].removedNodes.length) {
          schedule(); break;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  chrome.storage.onChanged.addListener(function(changes) {
    if (changes["xhb2-config"]) loadConfig();
  });

  loadConfig();
  startObserver();
})();
