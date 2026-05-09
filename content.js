(function() {
  "use strict";

  var ARTICLE = 'article[role="article"]';
  var TEXT = '[data-testid="tweetText"]';
  var NAME = '[data-testid="User-Name"]';
  var STORAGE = "xhb2-db";
  var BLOCKED = "xhb2-blocked";
  var MAX_FEATURES = 1500;

  var config = { autoBlock: true, testMode: false, bayesMinConfidence: 0.9, llmMinConfidence: 0.72, llmReviewMargin: 0.1, useLLM: true };
  var blockedHandles = new Set();
  var db = null;
  var observer = null;
  var scheduled = false;
  var blockQueue = Promise.resolve();
  var classifying = new Set();
  var prunedOnce = false;
  var stateReady = null;
  var recentPostSaveTimer = null;
  var LLM_HARD_BLOCK_CONFIDENCE = 0.88;
  var BAYES_HARD_BLOCK_CONFIDENCE = 0.97;

  var AI_RULES = [
    {
      id: "adult-direct",
      minScore: 6,
      signals: [
        { field: "any", weight: 6, pattern: /(外围|援交|楼凤|裸聊|卖淫|约炮|口交|成人交友|onlyfans|fansly|escort|nudes?)/i }
      ]
    },
    {
      id: "profile-funnel",
      minScore: 7,
      signals: [
        { field: "text", weight: 4, pattern: /(主页|私信|加v|加微|电报|telegram|tg)/i },
        { field: "text", weight: 3, pattern: /(福利|资源|视频|写真|可约|上门|空降|裸聊)/i },
        { field: "name", weight: 2, pattern: /(福利|约|资源|视频|裸|骚|成人)/i }
      ]
    },
    {
      id: "sexual-template",
      minScore: 6,
      signals: [
        { field: "text", weight: 4, pattern: /(她好(看|骚|涩)|比她(好看|骚)|没她(好看|骚)|我不行了)/ },
        { field: "text", weight: 2, pattern: /(主页|私信|打了半天|刷了半天|看主页)/ }
      ]
    },
    {
      id: "nearby-service",
      minScore: 6,
      signals: [
        { field: "text", weight: 4, pattern: /(同城|附近|本地)/ },
        { field: "text", weight: 3, pattern: /(可约|上门|空降|服务|约|啪)/ }
      ]
    },
    {
      id: "marketing-name",
      minScore: 6,
      signals: [
        { field: "name", weight: 4, pattern: /(互fo|互关|回关|互粉|涨粉|引流|推广|接单|兼职|副业)/i },
        { field: "any", weight: 2, pattern: /(主页|私信|关注|福利|资源|加v|加微|电报|telegram|tg|合作|推广)/i }
      ]
    },
    {
      id: "mention-funnel",
      minScore: 6,
      signals: [
        { field: "mentions", weight: 3, pattern: /./ },
        { field: "any", weight: 3, pattern: /(主页|私信|加v|加微|福利|资源|视频|约|裸|骚|推广|互关|互fo)/i }
      ]
    }
  ];

  // ── Load state ──
  async function loadState() {
    var raw = await chrome.storage.local.get([STORAGE, "xhb2-config", BLOCKED]);
    db = raw[STORAGE] || { accounts: {}, bayes: { spamCount: 0, hamCount: 0, words: {} } };
    db.accounts = db.accounts || {};
    db.bayes = db.bayes || { spamCount: 0, hamCount: 0, words: {} };
    db.bayes.words = db.bayes.words || {};
    db.samples = db.samples || [];
    db.aiRules = db.aiRules || [];
    var cfg = raw["xhb2-config"] || {};
    config.autoBlock = cfg.autoBlock !== false;
    config.testMode = cfg.testMode === true;
    config.bayesMinConfidence = cfg.bayesMinConfidence || 0.9;
    config.llmMinConfidence = cfg.llmMinConfidence || 0.72;
    config.llmReviewMargin = cfg.llmReviewMargin || 0.1;
    config.useLLM = cfg.useLLM !== false && !!cfg.llmEndpoint && !!cfg.llmApiKey;
    blockedHandles = new Set(raw[BLOCKED] || []);
    if (!prunedOnce) {
      prunedOnce = true;
      if (pruneBayes()) await saveState();
    }
    schedule();
  }

  function ensureStateReady() {
    if (db) return Promise.resolve();
    if (!stateReady) stateReady = loadState();
    return stateReady;
  }

  async function saveState() {
    var handles = Object.keys(db.accounts).filter(function(h) { return db.accounts[h].blocked; });
    var data = {}; data[STORAGE] = db; data[BLOCKED] = handles;
    await chrome.storage.local.set(data);
  }

  function scheduleRecentPostSave() {
    clearTimeout(recentPostSaveTimer);
    recentPostSaveTimer = setTimeout(function() {
      saveState().catch(function() {});
    }, 1200);
  }

  // ── Bayes ──
  function getFeatures(text) {
    var cleaned = (text || "").toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return [];
    var feats = [];

    var handles = cleaned.match(/@[a-z0-9_]{1,15}/g) || [];
    handles.forEach(function(h) { feats.push("H:" + h.slice(1)); });

    var latin = cleaned.match(/[a-z0-9_]{2,24}/g) || [];
    latin.forEach(function(w) {
      if (!/^\d+$/.test(w)) feats.push("W:" + w);
    });

    var cjk = (cleaned.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).join("");
    for (var n = 2; n <= 4; n++) {
      for (var i = 0; i <= cjk.length - n; i++) feats.push("C:" + cjk.slice(i, i + n));
    }

    return Array.from(new Set(feats)).filter(isValidFeature).slice(0, 180);
  }

  function isValidFeature(feature) {
    if (!feature || feature.length > 32 || /\s/.test(feature)) return false;
    if (/^W:/.test(feature)) return feature.length <= 26 && /^W:[a-z0-9_]+$/.test(feature);
    if (/^H:/.test(feature)) return feature.length <= 17 && /^H:[a-z0-9_]+$/.test(feature);
    if (/^C:/.test(feature)) return feature.length >= 4 && feature.length <= 6;
    return feature.length <= 6;
  }

  function pruneBayes() {
    if (!db || !db.bayes || !db.bayes.words) return false;
    var words = db.bayes.words;
    var entries = Object.keys(words).filter(isValidFeature).map(function(k) {
      var v = words[k] || {};
      return { key: k, value: { spam: v.spam || 0, ham: v.ham || 0 } };
    });
    entries.sort(function(a, b) {
      var as = a.value.spam * 4 + a.value.ham;
      var bs = b.value.spam * 4 + b.value.ham;
      return bs - as;
    });
    entries = entries.slice(0, MAX_FEATURES);
    var next = {};
    entries.forEach(function(e) { next[e.key] = e.value; });
    var changed = Object.keys(words).length !== Object.keys(next).length;
    db.bayes.words = next;
    return changed;
  }

  function classifyHeuristic(text, profile) {
    var mentionProfiles = getMentionedProfiles(text, profile);
    var ctx = {
      text: (text || "").toLowerCase(),
      name: (profile && profile.displayName || "").toLowerCase(),
      handle: (profile && profile.handle || "").toLowerCase(),
      mentions: mentionProfiles.map(function(p) { return p.handle; }).join(" ").toLowerCase()
    };
    ctx.any = [ctx.text, ctx.name, ctx.handle].join(" ");
    var learned = classifyLearnedRules(ctx);
    if (learned.spam) return learned;
    var distilled = classifyAIRules(ctx);
    if (distilled.spam) return distilled;
    var haystack = ctx.any;
    var strong = [
      /约[^\s]{0,6}(炮|啪|爱)/,
      /(同城|附近)[^\s]{0,8}(约|上门|空降|可约|服务)/,
      /(外围|援交|楼凤|裸聊|卖淫|叫床|口交|激情视频|成人交友)/,
      /(加v|加微|看主页|点主页|私信)[^\s]{0,10}(约|福利|资源|视频|写真|裸聊)/,
      /(🔞|18\+|onlyfans|telegram|电报)[^\s]{0,16}(福利|裸|约|视频|资源)?/,
      /(horny|nudes?|sex|escort|sugar\s*(baby|daddy)|onlyfans|fansly)/i
    ];
    var weak = [
      /福利/,
      /资源/,
      /私信/,
      /主页/,
      /写真/,
      /嫩妹|少妇|萝莉|御姐|学生妹/,
      /可约|上门|空降/,
      /telegram|电报|tg/,
      /裸|骚|啪|约/
    ];
    var weakHits = weak.reduce(function(n, pattern) { return n + (pattern.test(haystack) ? 1 : 0); }, 0);
    if (strong.some(function(pattern) { return pattern.test(haystack); })) {
      return { spam: true, conf: 0.96, reason: "yellow-keyword" };
    }
    if (weakHits >= 3) return { spam: true, conf: 0.9, reason: "yellow-pattern" };
    return { spam: false, conf: 0, reason: "" };
  }

  function keywordHit(value, keywords) {
    value = value || "";
    return (keywords || []).some(function(k) {
      return k && value.indexOf(String(k).toLowerCase()) >= 0;
    });
  }

  function classifyLearnedRules(ctx) {
    var rules = (db && db.aiRules || []).slice(0, 50);
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i] || {};
      var score = 0;
      if (keywordHit(ctx.text, rule.textAny)) score += Number(rule.textWeight) || 3;
      if (keywordHit(ctx.name, rule.nameAny)) score += Number(rule.nameWeight) || 2;
      if (keywordHit(ctx.handle, rule.handleAny)) score += Number(rule.handleWeight) || 2;
      if (keywordHit(ctx.any, rule.anyAny)) score += Number(rule.anyWeight) || 2;
      if (score >= (Number(rule.minScore) || 4)) {
        return { spam: true, conf: Math.min(0.88, 0.68 + score / 80), reason: "learned-rule:" + (rule.id || "ai") };
      }
    }
    return { spam: false, conf: 0, reason: "" };
  }

  function classifyAIRules(ctx) {
    for (var i = 0; i < AI_RULES.length; i++) {
      var rule = AI_RULES[i];
      var score = 0;
      rule.signals.forEach(function(signal) {
        if (signal.pattern.test(ctx[signal.field] || "")) score += signal.weight;
      });
      if (score >= rule.minScore) {
        var conf = rule.id === "adult-direct" ? 0.96 : Math.min(0.88, 0.68 + score / 80);
        return { spam: true, conf: conf, reason: "ai-rule:" + rule.id };
      }
    }
    return { spam: false, conf: 0, reason: "" };
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
    var spam = prob >= 0.5;
    return { spam: spam, conf: spam ? prob : 1 - prob, spamProbability: prob };
  }

  function trainLocal(text, isSpam, force) {
    if (!db) return;
    if (!force && !isSpam && db.bayes.hamCount >= Math.max(30, db.bayes.spamCount * 3)) return;
    if (isSpam) db.bayes.spamCount++; else db.bayes.hamCount++;
    getFeatures(text).forEach(function(f) {
      if (!db.bayes.words[f]) db.bayes.words[f] = { spam: 0, ham: 0 };
      if (isSpam) db.bayes.words[f].spam++; else db.bayes.words[f].ham++;
    });
    pruneBayes();
  }

  function getProfileTrainingText(text, profile) {
    return [
      profile && profile.displayName || "",
      profile && profile.handle || "",
      text || ""
    ].join(" ").trim();
  }

  function recordSample(text, profile, label, source, reason, weight, category) {
    if (!db) return;
    db.samples = db.samples || [];
    if (!label && source === "llm") {
      var hamCount = db.samples.filter(function(s) { return s.label === "ham" && s.source === "llm"; }).length;
      var spamCount = db.samples.filter(function(s) { return s.label === "spam"; }).length;
      if (hamCount >= Math.max(12, spamCount * 2)) return;
    }
    db.samples.push({
      label: label ? "spam" : "ham",
      source: source || "",
      reason: reason || "",
      weight: weight || 1,
      category: category || inferSampleCategory(label, source),
      text: String(text || "").slice(0, 1000),
      displayName: String(profile && profile.displayName || "").slice(0, 80),
      handle: String(profile && profile.handle || "").slice(0, 32),
      mentions: getMentionedProfiles(text, profile).map(function(p) { return p.handle; }).slice(0, 8),
      at: new Date().toISOString()
    });
    if (db.samples.length > 500) db.samples = db.samples.slice(db.samples.length - 500);
  }

  function inferSampleCategory(label, source) {
    if (source === "manual" || source === "manual-confirm") return "manual-spam";
    if (source === "restore") return "manual-ham";
    if (source === "ai-release") return "ai-release";
    if (/-observe$/.test(source || "")) return "auto-suspect";
    if (label) return "auto-spam";
    return "auto-ham";
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

  function addObservation(profile, reason, source) {
    var h = (profile.handle || "").toLowerCase().replace(/^@/, "");
    if (!h) return;
    var now = new Date().toISOString();
    var acc = db.accounts[h];
    if (acc) {
      acc.displayName = acc.displayName || profile.displayName || "";
      acc.lastSeen = now;
      acc.observationCount = (acc.observationCount || 0) + 1;
      acc.reasons = Array.from(new Set((acc.reasons || []).concat([reason])));
      acc.sources = Array.from(new Set((acc.sources || []).concat([source])));
    } else {
      db.accounts[h] = {
        handle: "@" + h,
        displayName: profile.displayName || "",
        blocked: false,
        reasons: [reason],
        sources: [source],
        firstSeen: now,
        lastSeen: now,
        blockCount: 0,
        observationCount: 1
      };
    }
  }

  function shouldProtectFromAuto(profile) {
    var h = (profile && profile.handle || "").toLowerCase().replace(/^@/, "");
    var acc = h && db && db.accounts ? db.accounts[h] : null;
    if (!acc) return false;
    var sources = (acc.sources || []).join(",");
    var reasons = (acc.reasons || []).join(",");
    return !!acc.userReleasedAt || /restore|ai-release|local-review/.test(sources + "," + reasons);
  }

  function strongAccountEvidence(text, profile, reason, confidence) {
    var haystack = [
      text || "",
      profile && profile.displayName || "",
      profile && profile.handle || "",
      reason || ""
    ].join(" ").toLowerCase();
    if (confidence >= 0.98) return true;
    var hasAdult = /(外围|援交|楼凤|裸聊|卖淫|约炮|口交|onlyfans|fansly|escort|nudes?|🔞|18\+)/i.test(haystack);
    var hasFunnel = /(主页|点主页|私信|加v|加微|电报|telegram|tg|whatsapp)/i.test(haystack);
    var hasService = /(福利|资源|视频|写真|可约|上门|空降|服务|约|裸|骚|成人)/i.test(haystack);
    if (hasAdult && confidence >= 0.92) return true;
    if (hasFunnel && hasService && confidence >= 0.9) return true;
    return false;
  }

  async function handleAutoSpam(article, text, profile, reason, source, confidence, sampleWeight, hardBlock) {
    if (shouldProtectFromAuto(profile)) {
      trainLocal(getProfileTrainingText(text, profile), false, true);
      recordSample(text, profile, false, "auto-protected", "protected-after-restore", 4, "manual-ham");
      await saveState();
      return;
    }

    var canBlockAccount = hardBlock || strongAccountEvidence(text, profile, reason, confidence);
    if (canBlockAccount) {
      addAccount(profile, reason, source);
      addMentionedAccounts(text, profile, reason, source);
      trainLocal(getProfileTrainingText(text, profile), true);
      recordSample(text, profile, true, source, reason, sampleWeight || 1);
    } else {
      addObservation(profile, reason, source + "-observe");
      recordSample(text, profile, true, source + "-observe", reason, 1, "auto-suspect");
    }
    await saveState();
    applyMask(article, reason + ":" + confidence.toFixed(2));
  }

  function rememberRecentPost(profile, text) {
    if (!db || !profile || !profile.handle || !text) return;
    var h = (profile.handle || "").toLowerCase().replace(/^@/, "");
    if (!h || !db.accounts[h]) return;
    var item = {
      text: String(text || "").replace(/\s+/g, " ").trim().slice(0, 500),
      at: new Date().toISOString(),
      source: "visible-post"
    };
    if (!item.text || item.text.length < 2) return;
    var acc = db.accounts[h];
    var posts = (acc.recentPosts || []).filter(function(p) {
      return p && p.text && p.text !== item.text;
    });
    posts.push(item);
    acc.recentPosts = posts.slice(-5);
    acc.recentPostsUpdatedAt = item.at;
    scheduleRecentPostSave();
  }

  function unblockAccount(profile, reason) {
    var h = (profile.handle || "").toLowerCase().replace(/^@/, "");
    if (!h || !db.accounts[h]) return;
    db.accounts[h].blocked = false;
    db.accounts[h].unblockedAt = new Date().toISOString();
    db.accounts[h].userReleasedAt = new Date().toISOString();
    db.accounts[h].reasons = Array.from(new Set((db.accounts[h].reasons || []).concat([reason || "restore"])));
    db.accounts[h].sources = Array.from(new Set((db.accounts[h].sources || []).concat(["restore"])));
    blockedHandles.delete(h);
  }

  function getOriginalPosterHandle() {
    var pathHandle = (location.pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:$|[/?#])/i) || [])[1];
    if (pathHandle && !/^(home|explore|notifications|messages|i|settings|search)$/i.test(pathHandle)) {
      return pathHandle.toLowerCase();
    }
    var firstArticle = document.querySelector(ARTICLE);
    var firstProfile = firstArticle ? getProfile(firstArticle) : null;
    return firstProfile && firstProfile.handle ? firstProfile.handle.toLowerCase().replace(/^@/, "") : "";
  }

  function isOriginalPostArticle(article) {
    if (!/\/status\/\d+/.test(location.pathname)) return false;
    return article === document.querySelector(ARTICLE);
  }

  function getProfilePageHandle() {
    if (/\/status\/\d+/.test(location.pathname)) return "";
    var h = (location.pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:$|[/?#])/i) || [])[1];
    if (!h || /^(home|explore|notifications|messages|i|settings|search|compose|jobs)$/i.test(h)) return "";
    return h.toLowerCase();
  }

  function getVisibleCommenterHandles() {
    var handles = {};
    document.querySelectorAll(ARTICLE).forEach(function(article) {
      var profile = getProfile(article);
      var h = (profile.handle || "").toLowerCase().replace(/^@/, "");
      if (h) handles[h] = true;
    });
    return handles;
  }

  function getMentionedProfiles(text, profile) {
    var original = getOriginalPosterHandle();
    var self = (profile && profile.handle || "").toLowerCase().replace(/^@/, "");
    var commenters = getVisibleCommenterHandles();
    var seen = {};
    var result = [];
    var re = /@([A-Za-z0-9_]{1,15})/g;
    var match;
    while ((match = re.exec(text || ""))) {
      var h = match[1].toLowerCase();
      if (h === original || h === self || seen[h]) continue;
      if (commenters[h] && !isBlocked(h)) continue;
      seen[h] = true;
      result.push({ handle: "@" + h, displayName: "" });
    }
    return result;
  }

  function addMentionedAccounts(text, profile, reason, source) {
    getMentionedProfiles(text, profile).forEach(function(mentioned) {
      addAccount(mentioned, reason + ":mentioned", source);
    });
  }

  // ── DOM ──
  function getText(article) { var el = article.querySelector(TEXT); return el ? el.innerText.trim() : ""; }
  function getProfile(article) {
    var el = article.querySelector(NAME); var raw = el ? el.innerText : "";
    var m = raw.match(/@([A-Za-z0-9_]+)/);
    if (!m) {
      var link = article.querySelector('a[href^="/"][role="link"]');
      if (link) m = (link.getAttribute("href") || "").match(/^\/([A-Za-z0-9_]{1,15})(?:$|[/?#])/);
    }
    var at = raw.indexOf("@");
    return { displayName: m && raw && at > 0 ? raw.slice(0, at).trim() : raw.trim(), handle: m ? "@" + m[1] : "" };
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
      var ok = false;
      try {
        await ensureStateReady();
        var text = getText(article), profile = getProfile(article);
        if (text && profile.handle) {
          addAccount(profile, "manual", "manual");
          trainLocal(getProfileTrainingText(text, profile), true);
          recordSample(text, profile, true, "manual", "manual", 4);
          addMentionedAccounts(text, profile, "manual", "manual");
          await saveState();
        }
        applyMask(article, "manual");
        if (config.autoBlock && !config.testMode) enqueueAutoBlock(article, profile.handle);
        ok = true;
      } catch (err) {
        console.warn("[X-block AI] manual block failed", err);
      } finally {
        btn.textContent = ok ? "✅" : "重试";
        btn.disabled = false;
      }
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
    rbtn.onclick = async function(ev) { ev.preventDefault(); ev.stopPropagation();
      var rev = article.getAttribute("data-xhb2-revealed") === "true";
      if (rev) {
        article.setAttribute("data-xhb2-revealed", "false");
        rbtn.textContent = "恢复";
        if (article.getAttribute("data-xhb2-corrected") === "ham") {
          var confirmText = getText(article), confirmProfile = getProfile(article);
          if (confirmText && confirmProfile.handle) {
            addAccount(confirmProfile, "confirm-spam-after-restore", "manual-confirm");
            trainLocal(getProfileTrainingText(confirmText, confirmProfile), true, true);
            recordSample(confirmText, confirmProfile, true, "manual-confirm", "hide-after-restore", 6);
            addMentionedAccounts(confirmText, confirmProfile, "manual-confirm", "manual-confirm");
            article.setAttribute("data-xhb2-corrected", "spam");
            await saveState();
            if (config.autoBlock && !config.testMode) enqueueAutoBlock(article, confirmProfile.handle);
          }
        }
        return;
      }
      article.setAttribute("data-xhb2-revealed", "true");
      article.setAttribute("data-xhb2-corrected", "ham");
      rbtn.textContent = "隐藏";
      var text = getText(article), profile = getProfile(article);
      if (text && profile.handle) {
        trainLocal(getProfileTrainingText(text, profile), false, true);
        recordSample(text, profile, false, "restore", "restore-ham", 5);
        unblockAccount(profile, "restore-ham");
        getMentionedProfiles(text, profile).forEach(function(mentioned) {
          unblockAccount(mentioned, "restore-mentioned-ham");
        });
        await saveState();
      }
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
    if (!profile.handle || classifying.has(h)) return;
    classifying.add(h);

    try {
      var localThreshold = config.bayesMinConfidence || 0.9;
      var reviewFloor = Math.max(0.5, localThreshold - config.llmReviewMargin);

      var heuristic = classifyHeuristic(text, profile);
      if (heuristic.spam && heuristic.conf >= Math.min(0.94, localThreshold + 0.08)) {
        await handleAutoSpam(article, text, profile, heuristic.reason, "heuristic", heuristic.conf, 2, heuristic.conf >= 0.98);
        return;
      }

      // Local Bayes
      var trainingText = getProfileTrainingText(text, profile);
      var result = classifyLocal(trainingText);
      if (result.conf >= Math.min(0.94, localThreshold + 0.08) && result.spam) {
        await handleAutoSpam(article, text, profile, "bayes(" + result.conf.toFixed(2) + ")", "bayes", result.conf, 1, result.conf >= BAYES_HARD_BLOCK_CONFIDENCE);
        return;
      }
      if (result.conf >= Math.min(0.94, localThreshold + 0.08) && !result.spam) return;

      var needsLLMReview = db.bayes.spamCount < 3 ||
        (heuristic.spam && heuristic.conf >= reviewFloor) ||
        (result.conf >= reviewFloor && result.conf < Math.min(0.94, localThreshold + 0.08));

      // LLM fallback
      if (config.useLLM && needsLLMReview) {
        var llm = await callLLM(text, profile);
        if (llm && llm.isSpam && (llm.confidence || 0) >= config.llmMinConfidence) {
          await handleAutoSpam(article, text, profile, "llm:" + (llm.reason || ""), "llm", llm.confidence || 0, 2, (llm.confidence || 0) >= LLM_HARD_BLOCK_CONFIDENCE);
        } else if (llm && !llm.isSpam && (llm.confidence || 0) >= config.llmMinConfidence) {
          trainLocal(trainingText, false);
          recordSample(text, profile, false, "llm", llm.reason || "", 1);
          await saveState();
        }
      }
    } catch(e) { console.warn("xhb2 classify:", e.message); }
    finally { classifying.delete(h); }
  }

  // ── Process ──
  function processArticle(article) {
    if (article.hasAttribute("data-xhb2")) return;
    article.setAttribute("data-xhb2", "1");
    var text = getText(article), profile = getProfile(article);
    if (!text || !profile.handle) return;
    var pageHandle = getProfilePageHandle();
    var articleHandle = profile.handle.toLowerCase().replace(/^@/, "");
    if (pageHandle && articleHandle === pageHandle) rememberRecentPost(profile, text);
    if (isOriginalPostArticle(article)) return;
    ensureBlockBtn(article);
    if (isBlocked(profile.handle)) { applyMask(article, "account-db"); return; }

    var textNode = article.querySelector(TEXT);
    var media = article.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="card.wrapper"]');
    if (media && textNode && !textNode.contains(media)) return;

    autoHandle(article, text, profile);
  }

  function scanPage() { document.querySelectorAll(ARTICLE).forEach(processArticle); }
  function schedule() { if (scheduled) return; scheduled = true; requestAnimationFrame(function() { scheduled = false; scanPage(); }); }
  function startObserver() { observer = new MutationObserver(function(ms) { for (var i = 0; i < ms.length; i++) if (ms[i].addedNodes.length) { schedule(); break; } }); observer.observe(document.body, { childList: true, subtree: true }); }

  chrome.storage.onChanged.addListener(function(changes) { if (changes[STORAGE] || changes[BLOCKED]) stateReady = loadState(); });
  stateReady = loadState(); startObserver();
})();
