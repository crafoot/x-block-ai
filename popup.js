(function() {
  "use strict";
  var $ = function(id) { return document.getElementById(id); };

  var PRESETS = {
    deepseek:  { endpoint: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-v4-flash" },
    openai:    { endpoint: "https://api.openai.com/v1/chat/completions",   model: "gpt-4.1-mini" },
    openrouter:{ endpoint: "https://openrouter.ai/api/v1/chat/completions", model: "openai/gpt-4.1-mini" },
    groq:      { endpoint: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile" },
    siliconflow:{ endpoint: "https://api.siliconflow.cn/v1/chat/completions", model: "deepseek-ai/DeepSeek-V3" },
    zhipu:     { endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions", model: "glm-4-flash" }
  };

  var DEFAULT_CONFIG = {
    llmEndpoint: "", llmApiKey: "", llmModel: "gpt-4.1-mini",
    autoBlock: true, testMode: false, useLLM: true,
    bayesMinConfidence: 0.82, llmMinConfidence: 0.55, llmReviewMargin: 0.12
  };

  var el = {
    statAccounts: $("statAccounts"), statBlocked: $("statBlocked"), statVocab: $("statVocab"),
    btnExport: $("btnExport"), btnImport: $("btnImport"), btnDistill: $("btnDistill"), btnReset: $("btnReset"), importFile: $("importFile"),
    pipelineInfo: $("pipelineInfo"), learnInfo: $("learnInfo"), dataView: $("dataView"),
    provider: $("provider"), llmEndpoint: $("llmEndpoint"), llmApiKey: $("llmApiKey"), llmModel: $("llmModel"),
    autoBlock: $("autoBlock"), testMode: $("testMode"), useLLM: $("useLLM"),
    bayesThreshold: $("bayesThreshold"), bayesLabel: $("bayesLabel"),
    llmThreshold: $("llmThreshold"), llmLabel: $("llmLabel"),
    reviewMargin: $("reviewMargin"), reviewLabel: $("reviewLabel"),
    btnSave: $("btnSave"), toast: $("toast")
  };

  function toast(text, ok) {
    var t = el.toast;
    t.textContent = text;
    t.className = "toast " + (ok ? "toast-ok" : "toast-err");
    t.style.opacity = "1";
    clearTimeout(t._tid);
    t._tid = setTimeout(function() { t.style.opacity = "0"; }, 2000);
  }

  async function getConfig() {
    var raw = await chrome.storage.local.get("xhb2-config");
    var cfg = raw["xhb2-config"] || {};
    Object.keys(DEFAULT_CONFIG).forEach(function(k) {
      if (cfg[k] === undefined) cfg[k] = DEFAULT_CONFIG[k];
    });
    return cfg;
  }

  async function saveConfig(cfg) {
    await chrome.storage.local.set({ "xhb2-config": cfg });
    try {
      chrome.runtime.sendMessage({ type: "XHB2_SAVE_CONFIG", config: cfg }, function() {});
    } catch(e) {}
  }

  async function getStats() {
    var raw = await chrome.storage.local.get("xhb2-db");
    var db = raw["xhb2-db"] || {};
    var accounts = db.accounts || {};
    var keys = Object.keys(accounts);
    var blocked = keys.filter(function(k) { return accounts[k].blocked; }).length;
    var vocab = db.bayes && db.bayes.words ? Object.keys(db.bayes.words).length : 0;
    return {
      accounts: keys.length,
      blocked: blocked,
      vocabulary: vocab,
      samples: (db.samples || []).length,
      aiRules: (db.aiRules || []).length,
      aiRulesUpdatedAt: db.aiRulesUpdatedAt || ""
    };
  }

  function describeJob(job) {
    job = job || {};
    function layerText(layers) {
      layers = layers || {};
      var parts = [
        ["人工屏蔽", layers["manual-spam"]],
        ["自动屏蔽", layers["auto-spam"]],
        ["纠错/正常", (layers["manual-ham"] || 0) + (layers["ai-release"] || 0) + (layers["auto-ham"] || 0)],
        ["账号兜底", (layers["account-fallback"] || 0) + (layers["protected-account"] || 0)]
      ].filter(function(p) { return p[1]; });
      return parts.length ? " · " + parts.map(function(p) { return p[0] + " " + p[1]; }).join(" / ") : "";
    }
    if (job.status === "running") {
      var detail = job.samples ? " · 本次样本 " + job.samples + " (spam " + (job.spamSamples || 0) + "/ham " + (job.hamSamples || 0) + ")" : "";
      return "AI分析中: " + (job.step || "running") + detail + layerText(job.layers);
    }
    if (job.status === "success") {
      return "AI分析完成: 规则 " + (job.rules || 0) +
        " · 释放 " + (job.released || 0) +
        " · 保护 " + (job.protected || 0) +
        " · 本次样本 " + (job.analyzedSamples || 0) +
        " (spam " + (job.analyzedSpam || 0) + "/ham " + (job.analyzedHam || 0) + ")" +
        layerText(job.layers);
    }
    if (job.status === "error") return "AI分析失败: " + (job.error || "unknown");
    return "";
  }

  function refreshDistillJob() {
    chrome.runtime.sendMessage({ type: "XHB2_DISTILL_STATUS" }, function(res) {
      if (chrome.runtime.lastError || !res || !res.ok) return;
      var text = describeJob(res.job);
      if (text) el.learnInfo.textContent = text;
      if (res.job && res.job.status === "running") {
        el.btnDistill.textContent = "分析中...";
        el.btnDistill.disabled = true;
      } else {
        el.btnDistill.textContent = "AI分析规则";
        el.btnDistill.disabled = false;
      }
    });
  }

  function escapeHTML(text) {
    return String(text || "").replace(/[&<>"']/g, function(ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
    });
  }

  async function loadDataView() {
    var raw = await chrome.storage.local.get("xhb2-db");
    var db = raw["xhb2-db"] || {};
    var accounts = Object.values(db.accounts || {}).filter(function(a) { return a.blocked; }).slice(-8).reverse();
    var totalAccounts = Object.keys(db.accounts || {}).length;
    var totalBlocked = Object.values(db.accounts || {}).filter(function(a) { return a.blocked; }).length;
    var totalSamples = (db.samples || []).length;
    var totalSpamSamples = (db.samples || []).filter(function(s) { return s.label === "spam"; }).length;
    var totalHamSamples = (db.samples || []).filter(function(s) { return s.label === "ham"; }).length;
    var spamSamples = (db.samples || []).filter(function(s) { return s.label === "spam"; }).slice(-6).reverse();
    var hamSamples = (db.samples || []).filter(function(s) { return s.label === "ham"; }).slice(-6).reverse();
    var rules = (db.aiRules || []).slice(0, 5);
    var html = "";
    html += '<div class="data-row"><div class="data-meta">数据范围</div>' +
      '<div class="data-text">账号 ' + totalAccounts + ' · 已屏蔽 ' + totalBlocked + ' · 原始样本 ' + totalSamples +
      ' (spam ' + totalSpamSamples + '/ham ' + totalHamSamples + ') · AI分析最多选取 80 条高权重代表样本</div></div>';
    html += '<div class="data-row"><div class="data-meta">最近屏蔽账号</div>' +
      (accounts.length ? accounts.map(function(a) {
        return '<div class="data-text">' + escapeHTML(a.handle) + ' ' + escapeHTML(a.displayName || "") + '</div>';
      }).join("") : '<div class="data-text">暂无</div>') + '</div>';
    html += '<div class="data-row"><div class="data-meta">最近屏蔽样本</div>' +
      (spamSamples.length ? spamSamples.map(function(s) {
        return '<div class="data-text">[' + escapeHTML(s.source) + '/w' + escapeHTML(s.weight || 1) + '] ' +
          escapeHTML(s.handle) + ' ' + escapeHTML(s.displayName) + '：' + escapeHTML(s.text) + '</div>';
      }).join("") : '<div class="data-text">暂无</div>') + '</div>';
    html += '<div class="data-row"><div class="data-meta">最近正常/纠错样本</div>' +
      (hamSamples.length ? hamSamples.map(function(s) {
        return '<div class="data-text">[' + escapeHTML(s.label) + '/' + escapeHTML(s.source) + '/w' + escapeHTML(s.weight || 1) + '] ' +
          escapeHTML(s.handle) + ' ' + escapeHTML(s.displayName) + '：' + escapeHTML(s.text) + '</div>';
      }).join("") : '<div class="data-text">暂无</div>') + '</div>';
    html += '<div class="data-row"><div class="data-meta">AI规则</div>' +
      (rules.length ? rules.map(function(r) {
        var keys = [].concat(r.textAny || [], r.nameAny || [], r.handleAny || [], r.anyAny || []).join(" / ");
        return '<div class="data-text">' + escapeHTML(r.title || r.id) + '：' + escapeHTML(keys) + '</div>';
      }).join("") : '<div class="data-text">暂无</div>') + '</div>';
    el.dataView.innerHTML = html;
  }

  // Provider change → fill endpoint + model
  el.provider.addEventListener("change", function() {
    var p = PRESETS[el.provider.value];
    if (p) {
      el.llmEndpoint.value = p.endpoint;
      el.llmModel.value = p.model;
    }
  });

  el.bayesThreshold.addEventListener("input", function() {
    el.bayesLabel.textContent = (parseInt(el.bayesThreshold.value) / 100).toFixed(2);
  });

  el.llmThreshold.addEventListener("input", function() {
    el.llmLabel.textContent = (parseInt(el.llmThreshold.value) / 100).toFixed(2);
  });

  el.reviewMargin.addEventListener("input", function() {
    el.reviewLabel.textContent = (parseInt(el.reviewMargin.value) / 100).toFixed(2);
  });

  // Save config
  el.btnSave.addEventListener("click", async function() {
    el.btnSave.textContent = "⏳ 保存中...";
    el.btnSave.disabled = true;

    try {
      var cfg = await getConfig();
      cfg.llmEndpoint = el.llmEndpoint.value.trim();
      cfg.llmApiKey = el.llmApiKey.value.trim();
      cfg.llmModel = el.llmModel.value.trim() || "gpt-4.1-mini";
      cfg.autoBlock = el.autoBlock.checked;
      cfg.testMode = el.testMode.checked;
      cfg.useLLM = el.useLLM.checked;
      cfg.bayesMinConfidence = parseInt(el.bayesThreshold.value) / 100;
      cfg.llmMinConfidence = parseInt(el.llmThreshold.value) / 100;
      cfg.llmReviewMargin = parseInt(el.reviewMargin.value) / 100;
      await saveConfig(cfg);
      toast("✅ 配置已保存", true);
      updatePipeline();
    } catch(e) {
      toast("❌ 保存失败: " + e.message, false);
    }
    el.btnSave.textContent = "💾 保存配置";
    el.btnSave.disabled = false;
  });

  function updatePipeline() {
    getConfig().then(function(cfg) {
      var parts = ["① 账号库", "② 黄推规则", "③ 贝叶斯≥" + (cfg.bayesMinConfidence || 0.82).toFixed(2)];
      parts.push(cfg.useLLM && cfg.llmEndpoint ? "④ 边界±" + (cfg.llmReviewMargin || 0.12).toFixed(2) + "→LLM≥" + (cfg.llmMinConfidence || 0.55).toFixed(2) : "④ 不调 LLM");
      parts.push(cfg.testMode ? "测试模式" : (cfg.autoBlock === false ? "仅入库" : "自动屏蔽"));
      el.pipelineInfo.textContent = parts.join(" → ");
    });
  }

  async function loadConfig() {
    var c = await getConfig();
    el.llmEndpoint.value = c.llmEndpoint || "";
    el.llmApiKey.value = c.llmApiKey || "";
    el.llmModel.value = c.llmModel || "";
    el.autoBlock.checked = c.autoBlock !== false;
    el.testMode.checked = c.testMode === true;
    el.useLLM.checked = c.useLLM !== false;
    el.bayesThreshold.value = Math.round((c.bayesMinConfidence || 0.82) * 100);
    el.bayesLabel.textContent = (c.bayesMinConfidence || 0.82).toFixed(2);
    el.llmThreshold.value = Math.round((c.llmMinConfidence || 0.55) * 100);
    el.llmLabel.textContent = (c.llmMinConfidence || 0.55).toFixed(2);
    el.reviewMargin.value = Math.round((c.llmReviewMargin || 0.12) * 100);
    el.reviewLabel.textContent = (c.llmReviewMargin || 0.12).toFixed(2);

    // Detect preset
    var matched = false;
    Object.entries(PRESETS).forEach(function(e) {
      if (e[1].endpoint === c.llmEndpoint) { el.provider.value = e[0]; matched = true; }
    });
    if (!matched) el.provider.value = "";
    updatePipeline();
  }

  async function loadStats() {
    var s = await getStats();
    el.statAccounts.textContent = s.accounts || 0;
    el.statBlocked.textContent = s.blocked || 0;
    el.statVocab.textContent = s.vocabulary || 0;
    el.learnInfo.textContent = "样本 " + (s.samples || 0) + " · AI规则 " + (s.aiRules || 0) +
      (s.aiRulesUpdatedAt ? " · " + s.aiRulesUpdatedAt.slice(5, 16).replace("T", " ") : "");
    loadDataView();
  }

  // Export → read directly from storage
  el.btnExport.addEventListener("click", async function() {
    var raw = await chrome.storage.local.get("xhb2-db");
    var db = raw["xhb2-db"] || {};
    var json = JSON.stringify(db, null, 2);
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    a.download = "xblock2-db-" + new Date().toISOString().slice(0,10) + ".json";
    a.click();
    toast("已导出 " + Object.keys(db.accounts||{}).length + " 账号", true);
  });

  el.btnImport.addEventListener("click", function() { el.importFile.click(); });
  el.btnDistill.addEventListener("click", async function() {
    el.btnDistill.textContent = "分析中...";
    el.btnDistill.disabled = true;
    el.learnInfo.textContent = "AI规则分析中，最多等待 60 秒...";
    try {
      var cfg = await getConfig();
      cfg.llmEndpoint = el.llmEndpoint.value.trim();
      cfg.llmApiKey = el.llmApiKey.value.trim();
      cfg.llmModel = el.llmModel.value.trim() || "gpt-4.1-mini";
      cfg.autoBlock = el.autoBlock.checked;
      cfg.testMode = el.testMode.checked;
      cfg.useLLM = el.useLLM.checked;
      cfg.bayesMinConfidence = parseInt(el.bayesThreshold.value) / 100;
      cfg.llmMinConfidence = parseInt(el.llmThreshold.value) / 100;
      cfg.llmReviewMargin = parseInt(el.reviewMargin.value) / 100;
      await saveConfig(cfg);
    } catch(e) {
      el.btnDistill.textContent = "AI分析规则";
      el.btnDistill.disabled = false;
      toast("配置保存失败: " + e.message, false);
      return;
    }
    chrome.runtime.sendMessage({ type: "XHB2_DISTILL_RULES" }, function(res) {
      if (chrome.runtime.lastError) {
        toast("分析失败: " + chrome.runtime.lastError.message, false);
        loadStats();
        return;
      }
      if (res && res.ok && res.running) {
        toast(res.started ? "AI分析已启动" : "AI分析已在运行", true);
        refreshDistillJob();
      } else {
        toast("分析失败: " + (res && res.error || "unknown"), false);
      }
    });
  });

  el.btnReset.addEventListener("click", async function() {
    if (!confirm("清空账号库、屏蔽列表和本地学习特征？")) return;
    try {
      await chrome.storage.local.set({
        "xhb2-db": { accounts: {}, bayes: { spamCount: 0, hamCount: 0, words: {} }, samples: [], aiRules: [] },
        "xhb2-blocked": []
      });
      chrome.runtime.sendMessage({ type: "XHB2_RESET_DB" }, function() {});
      toast("学习库已清空", true);
      loadStats();
    } catch(err) {
      toast("清空失败: " + err.message, false);
    }
  });

  el.importFile.addEventListener("change", async function(e) {
    var file = e.target.files[0]; if (!file) return;
    try {
      var text = await file.text();
      var incoming = JSON.parse(text);
      if (!incoming.accounts) throw new Error("Invalid format");
      
      // Read current DB, merge, write back
      var raw = await chrome.storage.local.get("xhb2-db");
      var current = raw["xhb2-db"] || { accounts: {}, bayes: { spamCount: 0, hamCount: 0, words: {} }, samples: [], aiRules: [] };
      current.accounts = current.accounts || {};
      current.bayes = current.bayes || { spamCount: 0, hamCount: 0, words: {} };
      current.bayes.words = current.bayes.words || {};
      current.samples = current.samples || [];
      current.aiRules = current.aiRules || [];
      
      var added = 0;
      Object.values(incoming.accounts).forEach(function(acc) {
        var h = (acc.handle || "").toLowerCase().replace(/^@/, "");
        if (h && !current.accounts[h]) { current.accounts[h] = acc; added++; }
      });
      
      if (incoming.bayes) {
        current.bayes.spamCount += incoming.bayes.spamCount || 0;
        current.bayes.hamCount += incoming.bayes.hamCount || 0;
        Object.entries(incoming.bayes.words || {}).forEach(function(e) {
          if (!current.bayes.words[e[0]]) current.bayes.words[e[0]] = { spam: 0, ham: 0 };
          current.bayes.words[e[0]].spam += e[1].spam || 0;
          current.bayes.words[e[0]].ham += e[1].ham || 0;
        });
      }

      if (Array.isArray(incoming.samples)) {
        current.samples = current.samples.concat(incoming.samples).slice(-500);
      }
      if (Array.isArray(incoming.aiRules) && !current.aiRules.length) {
        current.aiRules = incoming.aiRules;
        current.aiRulesUpdatedAt = incoming.aiRulesUpdatedAt || "";
      }
      
      var blocked = Object.keys(current.accounts).filter(function(h) { return current.accounts[h] && current.accounts[h].blocked; });
      await chrome.storage.local.set({ "xhb2-db": current, "xhb2-blocked": blocked });
      toast("导入 " + added + " 个账号", true);
      loadStats();
    } catch(err) {
      toast("导入失败: " + err.message, false);
    }
    el.importFile.value = "";
  });

  loadConfig(); loadStats(); refreshDistillJob();
  setInterval(refreshDistillJob, 3000);
})();
