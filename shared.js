(function initShared(global) {
  "use strict";

  var STORAGE_KB = "xhb2-kb";
  var STORAGE_CONFIG = "xhb2-config";

  var DEFAULT_CONFIG = {
    llmEndpoint: "",
    llmApiKey: "",
    llmModel: "gpt-4o-mini",
    autoBlock: true,
    kbSimThreshold: 0.30
  };

  // ── N-gram ──
  function extractNgrams(text, n) {
    n = n || 3;
    var cleaned = (text || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!cleaned) return [];
    var grams = [];
    for (var i = 0; i <= cleaned.length - n; i++) {
      grams.push(cleaned.slice(i, i + n));
    }
    return Array.from(new Set(grams));
  }

  function jaccardSim(a, b) {
    if (!a || !b || !a.length || !b.length) return 0;
    var sa = new Set(a), sb = new Set(b);
    var inter = 0;
    sa.forEach(function(v) { if (sb.has(v)) inter++; });
    var union = sa.size + sb.size - inter;
    return union === 0 ? 0 : inter / union;
  }

  function namePattern(name) {
    return (name || "").toLowerCase().trim()
      .replace(/[a-z]+/g, function(m) { return m.length + "L"; })
      .replace(/[\u4e00-\u9fff]+/g, function(m) { return m.length + "C"; })
      .replace(/\d+/g, function(m) { return m.length + "D"; })
      .replace(/[^LCD\s]/g, "S").replace(/\s+/g, "");
  }

  // ── KB ──
  function createEmptyKB() {
    return { version: 3, updatedAt: new Date().toISOString(), entries: [] };
  }

  async function getKB() {
    var raw = await chrome.storage.local.get(STORAGE_KB);
    return raw[STORAGE_KB] || createEmptyKB();
  }

  async function saveKB(kb) {
    kb.updatedAt = new Date().toISOString();
    await chrome.storage.local.set(((_a={}, _a[STORAGE_KB]=kb, _a)));
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

  // ── Learn: add a confirmed spam to KB ──
  async function learnFromBlock(text, profile, reason) {
    var kb = await getKB();
    var handle = (profile.handle || "").toLowerCase();
    var existing = kb.entries.find(function(e) { return e.handle === handle; });
    if (existing) {
      existing.textSamples = Array.from(new Set((existing.textSamples || []).concat(text)));
      var newGrams = extractNgrams(text);
      existing.textNgrams = Array.from(new Set((existing.textNgrams || []).concat(newGrams)));
      existing.blocks = (existing.blocks || 0) + 1;
      existing.lastSeen = new Date().toISOString();
      if (reason) existing.reasons = Array.from(new Set((existing.reasons || []).concat([reason])));
    } else {
      kb.entries.push({
        handle: handle,
        displayName: profile.displayName || "",
        namePattern: namePattern(profile.displayName),
        textSamples: [text],
        textNgrams: extractNgrams(text),
        reasons: reason ? [reason] : [],
        blocks: 1,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString()
      });
    }
    await saveKB(kb);
    return kb;
  }

  // ── KB matching (local, fast, offline) ──
  async function matchKB(text, profile) {
    var kb = await getKB();
    var handle = (profile.handle || "").toLowerCase();
    if (!text || kb.entries.length === 0) return { matched: false, reason: "kb-empty", score: 0 };

    var inputGrams = extractNgrams(text);
    if (!inputGrams.length) return { matched: false, reason: "no-text", score: 0 };

    var best = { entry: null, score: 0, reason: "" };

    kb.entries.forEach(function(entry) {
      // handle exact match → instant high score
      if (entry.handle === handle) {
        best = { entry: entry, score: 0.95, reason: "handle-exact" };
        return;
      }

      var textSim = jaccardSim(inputGrams, entry.textNgrams);
      if (textSim === 0) return;

      var nameA = entry.namePattern, nameB = namePattern(profile.displayName || "");
      var nameBonus = (nameA && nameB && nameA === nameB && nameA.length > 2) ? 0.2 : 0;
      var combined = textSim * 0.8 + nameBonus;

      if (combined > best.score) {
        best = { entry: entry, score: combined, reason: "text:" + textSim.toFixed(2) + (nameBonus ? " namePattern" : "") };
      }
    });

    var cfg = await getConfig();
    return best.score >= cfg.kbSimThreshold
      ? { matched: true, reason: "kb:" + best.reason, score: best.score }
      : { matched: false, reason: "kb-low(" + best.score.toFixed(2) + ")", score: best.score };
  }

  // ── LLM classification ──
  async function classifyWithLLM(text, profile) {
    var cfg = await getConfig();
    if (!cfg.llmEndpoint || !cfg.llmApiKey) {
      return { isSpam: false, confidence: 0, reason: "no-llm-config" };
    }

    var prompt = [
      "Classify this X.com comment. Is it spam/porn/advertisement bot content?",
      "",
      "Account: @" + (profile.handle || "?") + " (" + (profile.displayName || "?") + ")",
      "Comment: \"" + text + "\"",
      "",
      "Spam indicators to look for:",
      "- Porn/sex solicitation or innuendo",
      "- Adult dating/sugar daddy/sugar baby ads",
      "- Cryptocurrency/gambling scams",
      "- Generic romantic/love spam (especially with decorative symbols)",
      "- Promotional content with external links/contact info",
      "- Bot-generated usernames (random letters + numbers)",
      "",
      "Reply with ONLY this JSON, no other text:",
      "{ \"isSpam\": true/false, \"confidence\": 0.0-1.0, \"reason\": \"brief 5-10 word explanation\" }"
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
        max_tokens: 200,
        temperature: 0
      })
    });

    if (!res.ok) throw new Error("LLM API error: " + res.status);

    var data = await res.json();
    var content = data.choices[0].message.content.trim();

    try {
      return JSON.parse(content);
    } catch (e) {
      // Extract JSON from markdown code block
      var m = content.match(/\{[\s\S]*\}/);
      return m ? JSON.parse(m[0]) : { isSpam: false, confidence: 0, reason: "parse-error" };
    }
  }

  // ── Full pipeline: KB → LLM → learn ──
  async function classifyComment(text, profile) {
    // 1. Try local KB first
    var kbResult = await matchKB(text, profile);
    if (kbResult.matched) {
      return { isSpam: true, confidence: kbResult.score, reason: kbResult.reason, source: "kb" };
    }

    // 2. Ask LLM
    try {
      var llmResult = await classifyWithLLM(text, profile);
      if (llmResult.isSpam && llmResult.confidence >= 0.6) {
        // Learn from LLM's verdict
        await learnFromBlock(text, profile, "llm:" + (llmResult.reason || "auto"));
        return { isSpam: true, confidence: llmResult.confidence, reason: "llm:" + (llmResult.reason || ""), source: "llm" };
      }
      return { isSpam: false, confidence: llmResult.confidence || 0, reason: "llm:" + (llmResult.reason || "not-spam"), source: "llm" };
    } catch (e) {
      return { isSpam: false, confidence: 0, reason: "llm-error:" + e.message, source: "error" };
    }
  }

  // ── Manual block → learn ──
  async function manualBlock(text, profile) {
    await learnFromBlock(text, profile, "manual");
  }

  // ── Stats & Export ──
  async function getKBStats() {
    var kb = await getKB();
    return {
      entries: kb.entries.length,
      totalBlocks: kb.entries.reduce(function(s, e) { return s + (e.blocks || 1); }, 0)
    };
  }

  async function exportKB() {
    return JSON.stringify(await getKB(), null, 2);
  }

  async function importKB(json) {
    var incoming = JSON.parse(json);
    if (!incoming || !incoming.entries) throw new Error("Invalid KB");
    var current = await getKB();
    var seen = new Set(current.entries.map(function(e) { return e.handle; }));
    incoming.entries.forEach(function(e) {
      if (!seen.has(e.handle)) {
        current.entries.push(e);
        seen.add(e.handle);
      }
    });
    await saveKB(current);
    return current;
  }

  global.XHB2 = {
    extractNgrams: extractNgrams,
    jaccardSim: jaccardSim,
    namePattern: namePattern,
    learnFromBlock: learnFromBlock,
    matchKB: matchKB,
    classifyWithLLM: classifyWithLLM,
    classifyComment: classifyComment,
    manualBlock: manualBlock,
    getKB: getKB, saveKB: saveKB,
    getConfig: getConfig, saveConfig: saveConfig,
    getKBStats: getKBStats,
    exportKB: exportKB, importKB: importKB,
    STORAGE_KB: STORAGE_KB, STORAGE_CONFIG: STORAGE_CONFIG
  };
})(typeof window !== "undefined" ? window : globalThis);
