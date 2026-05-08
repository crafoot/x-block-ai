(function initShared(global) {
  "use strict";

  var STORAGE_DB = "xhb2-db";
  var STORAGE_CONFIG = "xhb2-config";

  // ── Default config ──
  var DEFAULT_CONFIG = {
    llmEndpoint: "",
    llmApiKey: "",
    llmModel: "gpt-4o-mini",
    autoBlock: true,
    bayesMinConfidence: 0.82,
    llmMinConfidence: 0.55,
    useLLM: true
  };

  // ═══════════════════════════════════════════
  //  TIER 1: ACCOUNT DATABASE (instant lookup)
  // ═══════════════════════════════════════════

  function createEmptyDB() {
    return {
      version: 4,
      updatedAt: new Date().toISOString(),
      accounts: {},        // handle → {handle,displayName,blocked,reasons[],blockedAt,source}
      bayes: {             // Naive Bayes model
        spamCount: 0,
        hamCount: 0,
        words: {}           // word → {spam: count, ham: count}
      },
      blockedHandles: []    // quick lookup set stored separately
    };
  }

  async function getDB() {
    var raw = await chrome.storage.local.get(STORAGE_DB);
    return raw[STORAGE_DB] || createEmptyDB();
  }

  async function saveDB(db) {
    db.updatedAt = new Date().toISOString();
    await chrome.storage.local.set(((_a={}, _a[STORAGE_DB]=db, _a)));
  }

  async function getConfig() {
    var raw = await chrome.storage.local.get(STORAGE_CONFIG);
    var cfg = raw[STORAGE_CONFIG] || {};
    Object.keys(DEFAULT_CONFIG).forEach(function(k) {
      if (cfg[k] === undefined) cfg[k] = DEFAULT_CONFIG[k];
    });
    return cfg;
  }

  async function saveConfig(cfg) {
    await chrome.storage.local.set(((_b={}, _b[STORAGE_CONFIG]=cfg, _b)));
  }

  // ── Tier 1: blocked account check ──
  function isHandleInDB(db, handle) {
    var h = (handle || "").toLowerCase().replace(/^@/, "");
    return !!db.accounts[h];
  }

  function isHandleBlocked(db, handle) {
    var h = (handle || "").toLowerCase().replace(/^@/, "");
    var acc = db.accounts[h];
    return acc && acc.blocked;
  }

  async function addToAccountDB(profile, reason, source, blocked) {
    if (blocked === undefined) blocked = true;
    var db = await getDB();
    var h = (profile.handle || "").toLowerCase().replace(/^@/, "");
    if (!h) return db;

    var existing = db.accounts[h];
    if (existing) {
      existing.blocked = existing.blocked || blocked;
      existing.reasons = Array.from(new Set((existing.reasons || []).concat(reason ? [reason] : [])));
      existing.sources = Array.from(new Set((existing.sources || []).concat([source])));
      existing.lastSeen = new Date().toISOString();
      if (blocked) existing.blockedAt = new Date().toISOString();
      existing.blockCount = (existing.blockCount || 0) + 1;
    } else {
      db.accounts[h] = {
        handle: "@" + h,
        displayName: profile.displayName || "",
        blocked: blocked,
        reasons: reason ? [reason] : [],
        sources: [source],
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        blockedAt: blocked ? new Date().toISOString() : "",
        blockCount: 1
      };
    }

    await saveDB(db);
    return db;
  }

  // ═══════════════════════════════════════════
  //  TIER 2: LOCAL NAIVE BAYES CLASSIFIER
  // ═══════════════════════════════════════════

  function extractFeatures(text) {
    // Character n-grams (3-5)
    var cleaned = (text || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!cleaned) return [];
    var feats = [];
    [3, 4].forEach(function(n) {
      for (var i = 0; i <= cleaned.length - n; i++) {
        feats.push("ng:" + cleaned.slice(i, i + n));
      }
    });
    // Word-level features
    var words = cleaned.split(/\s+/);
    words.forEach(function(w) {
      if (w.length >= 2) feats.push("w:" + w);
    });
    return Array.from(new Set(feats));
  }

  async function trainBayes(text, isSpam) {
    var db = await getDB();
    var feats = extractFeatures(text);
    if (!feats.length) return db;

    if (isSpam) db.bayes.spamCount++;
    else db.bayes.hamCount++;

    feats.forEach(function(f) {
      if (!db.bayes.words[f]) db.bayes.words[f] = { spam: 0, ham: 0 };
      if (isSpam) db.bayes.words[f].spam++;
      else db.bayes.words[f].ham++;
    });

    await saveDB(db);
    return db;
  }

  async function classifyBayes(text) {
    var db = await getDB();
    var feats = extractFeatures(text);
    if (!feats.length || db.bayes.spamCount === 0 || db.bayes.hamCount === 0) {
      return { isSpam: false, confidence: 0, reason: "insufficient-training" };
    }

    var totalSpam = db.bayes.spamCount;
    var totalHam = db.bayes.hamCount;
    var total = totalSpam + totalHam;
    var priorSpam = Math.log(totalSpam / total);
    var priorHam = Math.log(totalHam / total);
    var alpha = 1.0; // Laplace smoothing

    var spamScore = priorSpam;
    var hamScore = priorHam;

    feats.forEach(function(f) {
      var w = db.bayes.words[f] || { spam: 0, ham: 0 };
      var vocabSize = Object.keys(db.bayes.words).length || 1;
      spamScore += Math.log((w.spam + alpha) / (totalSpam + alpha * vocabSize));
      hamScore += Math.log((w.ham + alpha) / (totalHam + alpha * vocabSize));
    });

    // Convert log to probability
    var maxScore = Math.max(spamScore, hamScore);
    var spamExp = Math.exp(spamScore - maxScore);
    var hamExp = Math.exp(hamScore - maxScore);
    var prob = spamExp / (spamExp + hamExp);

    return {
      isSpam: prob >= 0.5,
      confidence: prob,
      reason: "bayes(" + prob.toFixed(3) + ")"
    };
  }

  // ═══════════════════════════════════════════
  //  TIER 3: LLM API CLASSIFIER
  // ═══════════════════════════════════════════

  async function classifyLLM(text, profile, bayesResult) {
    var cfg = await getConfig();
    if (!cfg.llmEndpoint || !cfg.llmApiKey) {
      return { isSpam: false, confidence: 0, reason: "no-llm-config" };
    }

    // Build context-aware prompt with Bayes hints to save tokens
    var bayesHint = "";
    if (bayesResult && bayesResult.confidence > 0.4) {
      bayesHint = "\nLocal ML model score: " + bayesResult.confidence.toFixed(2) +
        " (0=ham, 1=spam). Use this as a hint, not authoritative.";
    }

    var prompt = [
      "Classify this X.com comment as SPAM or NOT SPAM.",
      "Spam includes: porn/sugar-daddy/dating ads, crypto scams,",
      "generic love/romance bot messages (especially with decorative symbols),",
      "and promotional content from bot accounts.",
      "",
      "Account: @" + (profile.handle || "?"),
      "Display name: " + (profile.displayName || "?"),
      "Comment: \"" + text + "\"",
      bayesHint,
      "",
      "Reply ONLY: {\"isSpam\":true/false,\"confidence\":0.0-1.0,\"reason\":\"<5 words>\"}"
    ].join("\n");

    var res = await fetch(cfg.llmEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + cfg.llmApiKey
      },
      body: JSON.stringify({
        model: cfg.llmModel,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 150,
        temperature: 0
      })
    });

    if (!res.ok) throw new Error("LLM HTTP " + res.status);
    var data = await res.json();
    var content = data.choices[0].message.content.trim();
    try {
      return JSON.parse(content);
    } catch(e) {
      var m = content.match(/\{[\s\S]*\}/);
      return m ? JSON.parse(m[0]) : { isSpam: false, confidence: 0, reason: "parse-error" };
    }
  }

  // ═══════════════════════════════════════════
  //  FULL 3-TIER PIPELINE
  // ═══════════════════════════════════════════

  async function classifyComment(text, profile) {
    var cfg = await getConfig();
    var db = await getDB();

    // Tier 1: Account database (instant)
    var h = (profile.handle || "").toLowerCase().replace(/^@/, "");
    if (h && isHandleBlocked(db, profile.handle)) {
      return { isSpam: true, confidence: 1.0, reason: "account-db", source: "tier1", skipLearn: true };
    }

    // Tier 2: Local Naive Bayes
    var bayesResult = await classifyBayes(text);
    if (bayesResult.confidence >= cfg.bayesMinConfidence) {
      return {
        isSpam: bayesResult.isSpam,
        confidence: bayesResult.confidence,
        reason: bayesResult.reason,
        source: "tier2",
        skipLearn: false
      };
    }

    // Tier 3: LLM (only for borderline or unclear cases)
    if (cfg.useLLM && bayesResult.confidence >= cfg.llmMinConfidence) {
      try {
        var llmResult = await classifyLLM(text, profile, bayesResult);
        return {
          isSpam: llmResult.isSpam,
          confidence: llmResult.confidence,
          reason: "llm:" + (llmResult.reason || "auto"),
          source: "tier3",
          skipLearn: false
        };
      } catch(e) {
        // LLM failed, fall through to skip
      }
    }

    return { isSpam: false, confidence: bayesResult.confidence, reason: "below-threshold", source: "none", skipLearn: true };
  }

  // ═══════════════════════════════════════════
  //  LEARNING (updates all 3 tiers)
  // ═══════════════════════════════════════════

  async function learnFromResult(text, profile, result) {
    if (result.skipLearn) return;

    // Train Bayes
    await trainBayes(text, result.isSpam);

    // Add to account DB
    if (result.isSpam) {
      await addToAccountDB(profile, result.reason, result.source, true);
    }
  }

  async function manualBlock(text, profile) {
    var result = { isSpam: true, confidence: 1.0, reason: "manual", source: "manual", skipLearn: false };
    await learnFromResult(text, profile, result);
    return result;
  }

  // ═══════════════════════════════════════════
  //  STATS & EXPORT/IMPORT
  // ═══════════════════════════════════════════

  async function getStats() {
    var db = await getDB();
    var total = Object.keys(db.accounts).length;
    var blocked = Object.values(db.accounts).filter(function(a) { return a.blocked; }).length;
    return {
      accounts: total,
      blocked: blocked,
      spamSamples: db.bayes.spamCount,
      hamSamples: db.bayes.hamCount,
      vocabulary: Object.keys(db.bayes.words).length
    };
  }

  async function exportDB() {
    return JSON.stringify(await getDB(), null, 2);
  }

  async function importDB(json) {
    var incoming = JSON.parse(json);
    if (!incoming || !incoming.accounts) throw new Error("Invalid DB format");
    var current = await getDB();

    // Merge accounts
    Object.values(incoming.accounts).forEach(function(acc) {
      var h = (acc.handle || "").toLowerCase().replace(/^@/, "");
      if (h && !current.accounts[h]) {
        current.accounts[h] = acc;
      }
    });

    // Merge Bayes stats
    if (incoming.bayes) {
      current.bayes.spamCount += incoming.bayes.spamCount || 0;
      current.bayes.hamCount += incoming.bayes.hamCount || 0;
      Object.entries(incoming.bayes.words || {}).forEach(function(e) {
        var word = e[0], counts = e[1];
        if (!current.bayes.words[word]) current.bayes.words[word] = { spam: 0, ham: 0 };
        current.bayes.words[word].spam += counts.spam || 0;
        current.bayes.words[word].ham += counts.ham || 0;
      });
    }

    await saveDB(current);
    return current;
  }

  global.XHB2 = {
    // Config
    getConfig: getConfig, saveConfig: saveConfig,
    // 3-tier pipeline
    classifyComment: classifyComment,
    // Learning
    learnFromResult: learnFromResult,
    manualBlock: manualBlock,
    // Account DB (tier 1)
    addToAccountDB: addToAccountDB,
    isHandleBlocked: function(h) { return getDB().then(function(db) { return isHandleBlocked(db, h); }); },
    // Stats & I/O
    getStats: getStats,
    exportDB: exportDB,
    importDB: importDB,
    // Storage keys
    STORAGE_DB: STORAGE_DB,
    STORAGE_CONFIG: STORAGE_CONFIG
  };
})(typeof window !== "undefined" ? window : globalThis);
