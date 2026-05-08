(function() {
  "use strict";
  var $ = function(id) { return document.getElementById(id); };

  var PRESETS = {
    deepseek:  { endpoint: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat" },
    openai:    { endpoint: "https://api.openai.com/v1/chat/completions",   model: "gpt-4o-mini" },
    openrouter:{ endpoint: "https://openrouter.ai/api/v1/chat/completions", model: "openai/gpt-4o-mini" },
    groq:      { endpoint: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile" },
    siliconflow:{ endpoint: "https://api.siliconflow.cn/v1/chat/completions", model: "deepseek-ai/DeepSeek-V3" },
    zhipu:     { endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions", model: "glm-4-flash" }
  };

  var DEFAULT_CONFIG = {
    llmEndpoint: "", llmApiKey: "", llmModel: "gpt-4o-mini",
    autoBlock: true, useLLM: true,
    bayesMinConfidence: 0.82, llmMinConfidence: 0.55
  };

  var el = {
    statAccounts: $("statAccounts"), statBlocked: $("statBlocked"), statVocab: $("statVocab"),
    btnExport: $("btnExport"), btnImport: $("btnImport"), importFile: $("importFile"),
    pipelineInfo: $("pipelineInfo"),
    provider: $("provider"), llmEndpoint: $("llmEndpoint"), llmApiKey: $("llmApiKey"), llmModel: $("llmModel"),
    bayesThreshold: $("bayesThreshold"), bayesLabel: $("bayesLabel"),
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
  }

  async function getStats() {
    var raw = await chrome.storage.local.get("xhb2-db");
    var db = raw["xhb2-db"] || {};
    var accounts = db.accounts || {};
    var keys = Object.keys(accounts);
    var blocked = keys.filter(function(k) { return accounts[k].blocked; }).length;
    var vocab = db.bayes && db.bayes.words ? Object.keys(db.bayes.words).length : 0;
    return { accounts: keys.length, blocked: blocked, vocabulary: vocab };
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

  // Save config
  el.btnSave.addEventListener("click", async function() {
    el.btnSave.textContent = "⏳ 保存中...";
    el.btnSave.disabled = true;

    try {
      var cfg = await getConfig();
      cfg.llmEndpoint = el.llmEndpoint.value.trim();
      cfg.llmApiKey = el.llmApiKey.value.trim();
      cfg.llmModel = el.llmModel.value.trim() || "gpt-4o-mini";
      cfg.bayesMinConfidence = parseInt(el.bayesThreshold.value) / 100;
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
      var parts = ["① 账号库", "② 贝叶斯≥" + (cfg.bayesMinConfidence || 0.82).toFixed(2)];
      parts.push(cfg.llmEndpoint ? "③ LLM(" + (cfg.llmModel||"?") + ")" : "③ 仅本地");
      el.pipelineInfo.textContent = parts.join(" → ");
    });
  }

  async function loadConfig() {
    var c = await getConfig();
    el.llmEndpoint.value = c.llmEndpoint || "";
    el.llmApiKey.value = c.llmApiKey || "";
    el.llmModel.value = c.llmModel || "";
    el.bayesThreshold.value = Math.round((c.bayesMinConfidence || 0.82) * 100);
    el.bayesLabel.textContent = (c.bayesMinConfidence || 0.82).toFixed(2);

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
  el.importFile.addEventListener("change", async function(e) {
    var file = e.target.files[0]; if (!file) return;
    try {
      var text = await file.text();
      var incoming = JSON.parse(text);
      if (!incoming.accounts) throw new Error("Invalid format");
      
      // Read current DB, merge, write back
      var raw = await chrome.storage.local.get("xhb2-db");
      var current = raw["xhb2-db"] || { accounts: {}, bayes: { spamCount: 0, hamCount: 0, words: {} } };
      
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
      
      await chrome.storage.local.set({ "xhb2-db": current });
      toast("导入 " + added + " 个账号", true);
      loadStats();
    } catch(err) {
      toast("导入失败: " + err.message, false);
    }
    el.importFile.value = "";
  });

  loadConfig(); loadStats();
})();
