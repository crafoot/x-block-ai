// X-block AI service worker: owns LLM calls and keeps storage-derived state warm.
var DB_KEY = "xhb2-db";
var CONFIG_KEY = "xhb2-config";
var BLOCKED_KEY = "xhb2-blocked";
var MAX_FEATURES = 1500;
var MAX_SAMPLES = 500;
var KEEP_AFTER_DISTILL = 220;
var MIN_DISTILL_SPAM = 12;
var MIN_DISTILL_NEW_WEIGHT = 18;
var MIN_DISTILL_INTERVAL_MS = 12 * 60 * 60 * 1000;
var DISTILL_SAMPLE_LIMIT = 80;

var DB = { accounts: {}, bayes: { spamCount: 0, hamCount: 0, words: {} } };
var CONFIG = {
  autoBlock: true,
  testMode: false,
  useLLM: true,
  llmEndpoint: "",
  llmApiKey: "",
  llmModel: "gpt-4.1-mini",
  bayesMinConfidence: 0.82,
  llmMinConfidence: 0.55
};
var distillPromise = null;

function normalizeHandle(handle) {
  return (handle || "").toLowerCase().replace(/^@/, "");
}

function normalizeDB(db) {
  db = db || {};
  db.accounts = db.accounts || {};
  db.bayes = db.bayes || { spamCount: 0, hamCount: 0, words: {} };
  db.bayes.words = db.bayes.words || {};
  db.bayes.spamCount = db.bayes.spamCount || 0;
  db.bayes.hamCount = db.bayes.hamCount || 0;
  db.samples = db.samples || [];
  db.aiRules = db.aiRules || [];
  db.distillJob = db.distillJob || { status: "idle" };
  return db;
}

function isValidFeature(feature) {
  if (!feature || feature.length > 32 || /\s/.test(feature)) return false;
  if (/^W:/.test(feature)) return feature.length <= 26 && /^W:[a-z0-9_]+$/.test(feature);
  if (/^H:/.test(feature)) return feature.length <= 17 && /^H:[a-z0-9_]+$/.test(feature);
  if (/^C:/.test(feature)) return feature.length >= 4 && feature.length <= 6;
  return feature.length <= 6;
}

function pruneBayes() {
  DB = normalizeDB(DB);
  var entries = Object.keys(DB.bayes.words).filter(isValidFeature).map(function(k) {
    var v = DB.bayes.words[k] || {};
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
  var changed = Object.keys(DB.bayes.words).length !== Object.keys(next).length;
  DB.bayes.words = next;
  return changed;
}

function loadState() {
  chrome.storage.local.get([DB_KEY, CONFIG_KEY], function(r) {
    DB = normalizeDB(r[DB_KEY]);
    CONFIG = Object.assign({}, CONFIG, r[CONFIG_KEY] || {});
  });
}

function refreshState() {
  return new Promise(function(resolve) {
    chrome.storage.local.get([DB_KEY, CONFIG_KEY], function(r) {
      DB = normalizeDB(r[DB_KEY]);
      CONFIG = Object.assign({}, CONFIG, r[CONFIG_KEY] || {});
      resolve();
    });
  });
}

function saveDB(callback) {
  var blocked = Object.keys(DB.accounts).filter(function(h) {
    return DB.accounts[h] && DB.accounts[h].blocked;
  });
  var data = {};
  data[DB_KEY] = DB;
  data[BLOCKED_KEY] = blocked;
  chrome.storage.local.set(data, callback);
}

function setDistillJob(patch) {
  DB = normalizeDB(DB);
  DB.distillJob = Object.assign({}, DB.distillJob || {}, patch || {}, {
    updatedAt: new Date().toISOString()
  });
  var data = {};
  data[DB_KEY] = DB;
  return chrome.storage.local.set(data);
}

function startDistillRules() {
  if (distillPromise) return { started: false, running: true };
  distillPromise = distillRules().catch(function(err) {
    return setDistillJob({
      status: "error",
      step: "failed",
      error: err.message,
      completedAt: new Date().toISOString()
    });
  }).finally(function() {
    distillPromise = null;
  });
  return { started: true, running: true };
}

function sampleWeight(sample) {
  return Math.max(1, Math.min(8, Number(sample && sample.weight) || 1));
}

function compactSamples(afterDistill) {
  DB = normalizeDB(DB);
  var limit = afterDistill ? KEEP_AFTER_DISTILL : MAX_SAMPLES;
  DB.samples = DB.samples.map(function(sample) {
    sample.weight = sampleWeight(sample);
    return sample;
  }).sort(function(a, b) {
    var aw = sampleWeight(a) + (/manual|restore/.test(a.source || "") ? 3 : 0);
    var bw = sampleWeight(b) + (/manual|restore/.test(b.source || "") ? 3 : 0);
    return bw - aw || String(b.at || "").localeCompare(String(a.at || ""));
  }).slice(0, limit).sort(function(a, b) {
    return String(a.at || "").localeCompare(String(b.at || ""));
  });
}

function addAccount(profile, reason, source) {
  var h = normalizeHandle(profile && profile.handle);
  if (!h) return;
  var now = new Date().toISOString();
  var acc = DB.accounts[h];
  if (!acc) {
    acc = DB.accounts[h] = {
      handle: "@" + h,
      displayName: profile.displayName || "",
      blocked: true,
      reasons: [],
      sources: [],
      firstSeen: now,
      blockCount: 0
    };
  }
  acc.displayName = acc.displayName || profile.displayName || "";
  acc.blocked = true;
  acc.blockCount = (acc.blockCount || 0) + 1;
  acc.lastSeen = now;
  acc.reasons = Array.from(new Set((acc.reasons || []).concat(reason ? [reason] : [])));
  acc.sources = Array.from(new Set((acc.sources || []).concat(source ? [source] : [])));
}

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

function trainBayes(text, isSpam) {
  var feats = getFeatures(text);
  if (!feats.length) return;
  if (!isSpam && DB.bayes.hamCount >= Math.max(30, DB.bayes.spamCount * 3)) return;
  if (isSpam) DB.bayes.spamCount++;
  else DB.bayes.hamCount++;
  feats.forEach(function(f) {
    DB.bayes.words[f] = DB.bayes.words[f] || { spam: 0, ham: 0 };
    if (isSpam) DB.bayes.words[f].spam++;
    else DB.bayes.words[f].ham++;
  });
  pruneBayes();
}

function buildLLMPrompt(msg) {
  return [
    "你是 Chrome 插件里的 X.com 黄推评论过滤器。",
    "请判断这个账号和评论是否属于黄推、色情导流、裸聊、约炮、外围、OnlyFans/Telegram 引流、成人内容推广或类似垃圾评论。",
    "要同时看昵称、用户名和评论内容。不要因为普通用户讨论相关词汇就误判。",
    "",
    "昵称: " + (msg.profile && msg.profile.displayName || ""),
    "用户名: " + (msg.profile && msg.profile.handle || ""),
    "评论: " + (msg.text || ""),
    "",
    "只返回 JSON: {\"isSpam\":true/false,\"confidence\":0.0-1.0,\"reason\":\"不超过8个字\"}"
  ].join("\n");
}

async function classifyLLM(msg) {
  if (!CONFIG.useLLM || !CONFIG.llmEndpoint || !CONFIG.llmApiKey) {
    return { isSpam: false, confidence: 0, reason: "no-config" };
  }

  var response = await fetch(CONFIG.llmEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + CONFIG.llmApiKey
    },
    body: JSON.stringify(prepareLLMBody({
      model: CONFIG.llmModel || "gpt-4.1-mini",
      messages: [{ role: "user", content: buildLLMPrompt(msg) }],
      temperature: 0,
      max_tokens: 120
    }))
  });

  if (!response.ok) throw new Error("LLM HTTP " + response.status);
  var data = await response.json();
  var content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content || ""
    : "";
  var match = content.match(/\{[\s\S]*\}/);
  var parsed = JSON.parse(match ? match[0] : content);
  return {
    isSpam: !!parsed.isSpam,
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    reason: String(parsed.reason || "llm")
  };
}

async function fetchLLMJSON(body, timeoutMs) {
  try {
    return await fetchLLMJSONOnce(body, timeoutMs);
  } catch(err) {
    if (/非 JSON/.test(err.message || "") && err.rawContent) {
      await setDistillJob({ status: "running", step: "repair-json", error: err.message });
      return repairLLMJSON(err.rawContent, timeoutMs);
    }
    throw err;
  }
}

async function fetchLLMJSONOnce(body, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs || 45000);
  try {
    var payload = prepareLLMBody(body);
    var response = await fetch(CONFIG.llmEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + CONFIG.llmApiKey
      },
      signal: controller.signal,
      body: JSON.stringify(payload)
    });
    if (!response.ok && payload.response_format) {
      var fallbackPayload = Object.assign({}, payload);
      delete fallbackPayload.response_format;
      response = await fetch(CONFIG.llmEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + CONFIG.llmApiKey
        },
        signal: controller.signal,
        body: JSON.stringify(fallbackPayload)
      });
    }
    if (!response.ok) throw new Error("LLM HTTP " + response.status);
    var data = await response.json();
    var content = extractLLMContent(data);
    if (!String(content || "").trim()) {
      await setDistillJob({ status: "running", step: "empty-llm-content", raw: JSON.stringify(data).slice(0, 500) });
      var choice = data && data.choices && data.choices[0] || {};
      var msg = choice.message || {};
      if (msg.reasoning_content) {
        throw new Error("模型只返回推理过程，没有输出最终 JSON。DeepSeek 请在 Model 填 deepseek-v4-flash 或 deepseek-v4-pro，不要用 deepseek-reasoner。");
      }
    }
    return parseLLMJSONContent(content);
  } catch(e) {
    if (e && e.name === "AbortError") throw new Error("LLM 请求超时");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function prepareLLMBody(body) {
  var next = Object.assign({}, body || {});
  var model = String(next.model || CONFIG.llmModel || "").toLowerCase();
  var endpoint = String(CONFIG.llmEndpoint || "").toLowerCase();
  if (endpoint.indexOf("deepseek.com") >= 0 && model.indexOf("deepseek-v4") >= 0) {
    next.thinking = { type: "disabled" };
  }
  return next;
}

function extractLLMContent(data) {
  var choice = data && data.choices && data.choices[0] || {};
  var msg = choice.message || {};
  var content = msg.content || choice.text || data.output_text || "";
  if (Array.isArray(content)) {
    content = content.map(function(part) {
      return typeof part === "string" ? part : part.text || part.content || "";
    }).join("");
  }
  // Do not treat reasoning_content as the answer. Reasoning models may put
  // analysis there while leaving the final JSON content empty.
  if (!content && msg.refusal) content = msg.refusal;
  return content;
}

function parseLLMJSONContent(content) {
  content = String(content || "").trim();
  if (!content) throw new Error("大模型返回空内容");
  content = content.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();

  var candidates = [content];
  var first = content.indexOf("{");
  var last = content.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(content.slice(first, last + 1));
  var balanced = extractBalancedJSONObject(content);
  if (balanced) candidates.push(balanced);

  for (var i = 0; i < candidates.length; i++) {
    var candidate = candidates[i];
    try {
      return JSON.parse(candidate);
    } catch(e) {
      try {
        return JSON.parse(escapeControlCharsInJSONString(candidate));
      } catch(e2) {}
    }
  }

  var err = new Error("大模型返回非 JSON: " + content.slice(0, 180));
  err.rawContent = content.slice(0, 4000);
  throw err;
}

function extractBalancedJSONObject(text) {
  text = String(text || "");
  var start = text.indexOf("{");
  if (start < 0) return "";
  var depth = 0;
  var inString = false;
  var escaped = false;
  for (var i = start; i < text.length; i++) {
    var ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return "";
}

function escapeControlCharsInJSONString(text) {
  text = String(text || "");
  var out = "";
  var inString = false;
  var escaped = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === "\\") {
        out += ch;
        escaped = true;
      } else if (ch === "\"") {
        out += ch;
        inString = false;
      } else if (ch === "\n") {
        out += "\\n";
      } else if (ch === "\r") {
        out += "\\r";
      } else if (ch === "\t") {
        out += "\\t";
      } else {
        out += ch;
      }
      continue;
    }
    out += ch;
    if (ch === "\"") inString = true;
  }
  return out;
}

async function repairLLMJSON(rawContent, timeoutMs) {
  return fetchLLMJSONOnce({
    model: CONFIG.llmModel || "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content: "You convert text into valid JSON only. Output exactly one JSON object and nothing else."
      },
      {
        role: "user",
        content: [
          "把下面内容提取并转换为这个 JSON 结构：",
          "{\"rules\":[{\"id\":\"\",\"title\":\"\",\"textAny\":[],\"nameAny\":[],\"handleAny\":[],\"anyAny\":[],\"textWeight\":3,\"nameWeight\":2,\"handleWeight\":2,\"anyWeight\":2,\"minScore\":5}],\"releaseHandles\":[]}",
          "最多 8 条 rules。关键词必须短，不要复制整句样本，不要输出长句。",
          "只输出 JSON，不要解释，不要分析过程。输出必须从 { 开始，到 } 结束。",
          "",
          String(rawContent || "").slice(0, 3500)
        ].join("\n")
      }
    ],
    temperature: 0,
    max_tokens: 1000
  }, timeoutMs || 60000);
}

function sanitizeKeywords(list, maxItems, maxLen) {
  return (Array.isArray(list) ? list : []).map(function(v) {
    return String(v || "").toLowerCase().trim();
  }).filter(function(v, i, arr) {
    return v.length >= 2 && v.length <= maxLen && arr.indexOf(v) === i;
  }).slice(0, maxItems);
}

function sanitizeRules(rules) {
  return (Array.isArray(rules) ? rules : []).map(function(rule, idx) {
    return {
      id: String(rule.id || "ai-" + (idx + 1)).replace(/[^a-z0-9_-]/gi, "").slice(0, 32) || "ai-" + (idx + 1),
      title: String(rule.title || "").slice(0, 40),
      textAny: sanitizeKeywords(rule.textAny, 8, 16),
      nameAny: sanitizeKeywords(rule.nameAny, 8, 16),
      handleAny: sanitizeKeywords(rule.handleAny, 8, 16),
      anyAny: sanitizeKeywords(rule.anyAny, 8, 16),
      textWeight: Math.max(1, Math.min(6, Number(rule.textWeight) || 3)),
      nameWeight: Math.max(1, Math.min(6, Number(rule.nameWeight) || 2)),
      handleWeight: Math.max(1, Math.min(6, Number(rule.handleWeight) || 2)),
      anyWeight: Math.max(1, Math.min(6, Number(rule.anyWeight) || 2)),
      minScore: Math.max(2, Math.min(12, Number(rule.minScore) || 4))
    };
  }).filter(function(rule) {
    return rule.textAny.length || rule.nameAny.length || rule.handleAny.length || rule.anyAny.length;
  }).slice(0, 20);
}

function sanitizeReleaseHandles(list) {
  return (Array.isArray(list) ? list : []).map(function(v) {
    return normalizeHandle(typeof v === "string" ? v : v && v.handle);
  }).filter(function(v, i, arr) {
    return /^[a-z0-9_]{1,15}$/.test(v) && arr.indexOf(v) === i;
  }).slice(0, 40);
}

function isProtectedAccount(acc) {
  var sources = (acc.sources || []).join(",");
  var reasons = (acc.reasons || []).join(",");
  return (acc.blockCount || 0) > 5 || /manual|manual-confirm/.test(sources + "," + reasons);
}

function applyReleaseSuggestions(handles) {
  DB = normalizeDB(DB);
  var released = [];
  var protectedHandles = [];
  handles.forEach(function(h) {
    var acc = DB.accounts[h];
    if (!acc || !acc.blocked) return;
    if (isProtectedAccount(acc)) {
      protectedHandles.push("@" + h);
      return;
    }
    acc.blocked = false;
    acc.releasedAt = new Date().toISOString();
    acc.releaseReason = "ai-distill";
    acc.reasons = Array.from(new Set((acc.reasons || []).concat(["ai-release"])));
    released.push("@" + h);
    DB.samples.push({
      label: "ham",
      source: "ai-release",
      reason: "distill-release",
      weight: 3,
      category: "ai-release",
      displayName: acc.displayName || "",
      handle: acc.handle || "@" + h,
      text: "",
      at: new Date().toISOString()
    });
  });
  compactSamples(false);
  return { released: released, protectedHandles: protectedHandles };
}

function buildDistillPrompt(samples) {
  var compact = samples.map(function(s) {
    return {
      label: s.label,
      source: s.source,
      reason: s.reason,
      weight: sampleWeight(s),
      category: sampleCategory(s),
      name: s.displayName,
      handle: s.handle,
      mentions: s.mentions || [],
      text: String(s.text || "").slice(0, 240)
    };
  });
  return [
    "只输出一个合法 JSON 对象。不要写分析过程，不要写 Markdown，不要写代码块。",
    "JSON 顶层必须只有 rules 和 releaseHandles 两个字段。",
    "你在为 X.com 黄推评论过滤器生成本地规则。",
    "输入是用户本地样本，spam=应屏蔽，ham=误杀或正常。",
    "weight 越高越重要：手动屏蔽和手动恢复优先级最高。",
    "原始屏蔽库可能包含误杀。你可以输出 releaseHandles 建议释放误杀账号。",
    "但人工屏蔽/人工确认/反复屏蔽的账号应保守，不要建议释放。",
    "请蒸馏少量可解释关键词组合规则，优先避免误杀 ham。",
    "规则只允许关键词数组，不要返回正则，不要返回解释。",
    "最多输出 8 条规则。每个关键词应是短特征，不要复制整句评论，不要输出随机短码或整段 URL。",
    "中文关键词通常 2-8 个字；英文/日文关键词通常不超过 24 个字符。",
    "如果只能从单条样本得到长句，不要为它生成规则。",
    "字段含义：textAny 匹配评论内容；nameAny 匹配昵称；handleAny 匹配用户名；anyAny 匹配任意字段。",
    "昵称是重要条件。营销/互关/引流号常见昵称特征包括：互fo、互关、回关、互粉、涨粉、推广、接单、兼职、副业。单个营销昵称词不要过度误杀，尽量和评论/任意字段导流词组合。",
    "mentions 是评论中引用的账号，已由插件排除了原发帖人和页面上正常评论者。mentions 可作为加权条件，但不要单独因 mentions 存在就屏蔽。",
    "权重 1-6，minScore 2-12。需要组合条件时提高 minScore。",
    "最终输出必须从 { 开始，到 } 结束。",
    "输出模板：{\"rules\":[{\"id\":\"profile-funnel\",\"title\":\"主页导流\",\"textAny\":[\"主页\",\"私信\"],\"nameAny\":[\"福利\"],\"handleAny\":[],\"anyAny\":[],\"textWeight\":3,\"nameWeight\":2,\"handleWeight\":2,\"anyWeight\":2,\"minScore\":5}],\"releaseHandles\":[\"@maybe_false_positive\"]}",
    "",
    JSON.stringify(compact).slice(0, 12000)
  ].join("\n");
}

function accountFallbackSamples() {
  DB = normalizeDB(DB);
  return Object.values(DB.accounts).filter(function(acc) {
    return acc && acc.blocked;
  }).slice(-80).map(function(acc) {
    return {
      label: "spam",
      source: "account-db",
      reason: (acc.reasons || []).join(",").slice(0, 80),
      weight: isProtectedAccount(acc) ? 4 : 1,
      category: isProtectedAccount(acc) ? "protected-account" : "account-fallback",
      displayName: acc.displayName || "",
      handle: acc.handle || "",
      text: ""
    };
  });
}

function sampleCategory(sample) {
  if (sample.category) return sample.category;
  if (sample.source === "manual" || sample.source === "manual-confirm") return "manual-spam";
  if (sample.source === "restore") return "manual-ham";
  if (sample.source === "ai-release") return "ai-release";
  if (sample.source === "account-db") return "account-fallback";
  if (sample.label === "spam") return "auto-spam";
  return "auto-ham";
}

function sampleKey(sample) {
  return [
    normalizeHandle(sample.handle),
    String(sample.text || "").slice(0, 80).replace(/\s+/g, " ")
  ].join("|");
}

function rankSample(a, b) {
  var ap = sampleWeight(a) + (/manual|restore/.test(a.source || "") ? 4 : 0);
  var bp = sampleWeight(b) + (/manual|restore/.test(b.source || "") ? 4 : 0);
  return bp - ap || String(b.at || "").localeCompare(String(a.at || ""));
}

function takeLayer(samples, predicate, limit, used) {
  var out = [];
  samples.filter(predicate).sort(rankSample).forEach(function(sample) {
    if (out.length >= limit) return;
    var key = sampleKey(sample);
    if (used[key]) return;
    used[key] = true;
    out.push(sample);
  });
  return out;
}

function pickDistillSamples(samples) {
  var used = {};
  var selected = [];
  selected = selected.concat(takeLayer(samples, function(s) { return sampleCategory(s) === "manual-spam"; }, 25, used));
  selected = selected.concat(takeLayer(samples, function(s) { return sampleCategory(s) === "auto-spam"; }, 20, used));
  selected = selected.concat(takeLayer(samples, function(s) { return /manual-ham|ai-release|auto-ham/.test(sampleCategory(s)); }, 20, used));
  selected = selected.concat(takeLayer(samples.slice().sort(function(a, b) {
    return String(b.at || "").localeCompare(String(a.at || ""));
  }), function() { return true; }, 10, used));
  selected = selected.concat(takeLayer(samples, function(s) { return /account-fallback|protected-account/.test(sampleCategory(s)); }, 5, used));
  if (selected.length < DISTILL_SAMPLE_LIMIT) {
    selected = selected.concat(takeLayer(samples, function() { return true; }, DISTILL_SAMPLE_LIMIT - selected.length, used));
  }
  return selected.slice(0, DISTILL_SAMPLE_LIMIT).sort(function(a, b) {
    return String(a.at || "").localeCompare(String(b.at || ""));
  });
}

function layerCounts(samples) {
  return samples.reduce(function(map, sample) {
    var cat = sampleCategory(sample);
    map[cat] = (map[cat] || 0) + 1;
    return map;
  }, {});
}

async function distillRules() {
  await refreshState();
  DB = normalizeDB(DB);
  await setDistillJob({ status: "running", step: "checking-config", error: "", startedAt: new Date().toISOString() });
  if (!CONFIG.llmEndpoint || !CONFIG.llmApiKey) throw new Error("请先配置大模型 API");
  var samples = pickDistillSamples(DB.samples);
  var spam = samples.filter(function(s) { return s.label === "spam"; }).length;
  if (spam < 8) {
    samples = pickDistillSamples(samples.concat(accountFallbackSamples()));
  }
  spam = samples.filter(function(s) { return s.label === "spam"; }).length;
  var ham = samples.filter(function(s) { return s.label === "ham"; }).length;
  if (spam < 8) throw new Error("屏蔽样本太少，至少需要 8 条");
  var layers = layerCounts(samples);
  await setDistillJob({ status: "running", step: "calling-llm", samples: samples.length, spamSamples: spam, hamSamples: ham, layers: layers });

  var parsed = await fetchLLMJSON({
    model: CONFIG.llmModel || "gpt-4.1-mini",
    messages: [
      { role: "system", content: "You are a JSON generator. Return exactly one valid JSON object. Do not include reasoning or explanation." },
      { role: "user", content: buildDistillPrompt(samples) }
    ],
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: 1800
  }, 120000);
  await setDistillJob({ status: "running", step: "parsing-result" });
  DB.aiRules = sanitizeRules(parsed.rules);
  if (!DB.aiRules.length) throw new Error("大模型没有返回有效规则");
  var release = applyReleaseSuggestions(sanitizeReleaseHandles(parsed.releaseHandles));
  DB.aiRulesUpdatedAt = new Date().toISOString();
  DB.aiRulesSampleCount = DB.samples.length;
  DB.aiRulesSampleWeight = DB.samples.reduce(function(sum, s) { return sum + sampleWeight(s); }, 0);
  compactSamples(true);
  return new Promise(function(resolve) {
    DB.distillJob = Object.assign({}, DB.distillJob || {}, {
      status: "success",
      step: "done",
      error: "",
      rules: DB.aiRules.length,
      released: release.released.length,
      protected: release.protectedHandles.length,
      analyzedSamples: samples.length,
      analyzedSpam: spam,
      analyzedHam: ham,
      layers: layers,
      totalSamples: DB.samples.length,
      totalAccounts: Object.keys(DB.accounts || {}).length,
      totalBlocked: Object.keys(DB.accounts || {}).filter(function(h) { return DB.accounts[h] && DB.accounts[h].blocked; }).length,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    saveDB(function() {
      resolve({
        ok: true,
        rules: DB.aiRules.length,
        released: release.released.length,
        protected: release.protectedHandles.length,
        spamSamples: spam,
        hamSamples: ham
      });
    });
  });
}

function getDistillStatus() {
  DB = normalizeDB(DB);
  var totalWeight = DB.samples.reduce(function(sum, s) { return sum + sampleWeight(s); }, 0);
  var lastWeight = DB.aiRulesSampleWeight || 0;
  var newWeight = Math.max(0, totalWeight - lastWeight);
  var lastAt = DB.aiRulesUpdatedAt ? Date.parse(DB.aiRulesUpdatedAt) : 0;
  var enoughTime = !lastAt || Date.now() - lastAt >= MIN_DISTILL_INTERVAL_MS;
  var spam = DB.samples.filter(function(s) { return s.label === "spam"; }).length;
  var ham = DB.samples.filter(function(s) { return s.label === "ham"; }).length;
  var ready = spam >= MIN_DISTILL_SPAM && newWeight >= MIN_DISTILL_NEW_WEIGHT && enoughTime;
  return {
    ready: ready,
    sampleCount: DB.samples.length,
    sampleWeight: totalWeight,
    newWeight: newWeight,
    spamSamples: spam,
    hamSamples: ham,
    aiRules: DB.aiRules.length,
    updatedAt: DB.aiRulesUpdatedAt || "",
    reason: ready ? "ready" : "需要更多新样本或等待周期"
  };
}

chrome.storage.onChanged.addListener(function(changes) {
  if (changes[DB_KEY]) DB = normalizeDB(changes[DB_KEY].newValue);
  if (changes[CONFIG_KEY]) CONFIG = Object.assign({}, CONFIG, changes[CONFIG_KEY].newValue || {});
});

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type === "XHB2_CLASSIFY") {
    classifyLLM(msg).then(sendResponse).catch(function(err) {
      sendResponse({ isSpam: false, confidence: 0, reason: "error:" + err.message });
    });
    return true;
  }

  if (msg.type === "XHB2_MANUAL_BLOCK") {
    addAccount(msg.profile || {}, "manual", "manual");
    trainBayes([msg.profile && msg.profile.displayName || "", msg.profile && msg.profile.handle || "", msg.text || ""].join(" "), true);
    saveDB(function() { sendResponse({ ok: true }); });
    return true;
  }

  if (msg.type === "XHB2_GET_STATS") {
    var keys = Object.keys(DB.accounts);
    var blocked = keys.filter(function(k) { return DB.accounts[k].blocked; }).length;
    sendResponse({
      accounts: keys.length,
      blocked: blocked,
      vocabulary: Object.keys(DB.bayes.words).length,
      sampleCount: DB.samples.length,
      aiRules: DB.aiRules.length,
      distill: getDistillStatus(),
      spamSamples: DB.bayes.spamCount,
      hamSamples: DB.bayes.hamCount
    });
    return true;
  }

  if (msg.type === "XHB2_GET_CONFIG") {
    sendResponse(CONFIG);
    return true;
  }

  if (msg.type === "XHB2_RESET_DB") {
    DB = { accounts: {}, bayes: { spamCount: 0, hamCount: 0, words: {} }, samples: [], aiRules: [] };
    var resetData = {};
    resetData[DB_KEY] = DB;
    resetData[BLOCKED_KEY] = [];
    chrome.storage.local.set(resetData, function() { sendResponse({ ok: true }); });
    return true;
  }

  if (msg.type === "XHB2_DISTILL_RULES") {
    sendResponse(Object.assign({ ok: true }, startDistillRules()));
    return false;
  }

  if (msg.type === "XHB2_DISTILL_STATUS") {
    refreshState().then(function() {
      DB = normalizeDB(DB);
      sendResponse({ ok: true, status: getDistillStatus(), job: DB.distillJob || { status: "idle" } });
    });
    return true;
  }

  if (msg.type === "XHB2_SAVE_CONFIG") {
    CONFIG = Object.assign({}, CONFIG, msg.config || {});
    var data = {};
    data[CONFIG_KEY] = CONFIG;
    chrome.storage.local.set(data, function() { sendResponse({ ok: true }); });
    return true;
  }

  return false;
});

loadState();
