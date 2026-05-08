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

  var el = {
    statAccounts: $("statAccounts"), statBlocked: $("statBlocked"), statVocab: $("statVocab"),
    btnExport: $("btnExport"), btnImport: $("btnImport"), importFile: $("importFile"),
    pipelineInfo: $("pipelineInfo"),
    provider: $("provider"), llmEndpoint: $("llmEndpoint"), llmApiKey: $("llmApiKey"), llmModel: $("llmModel"),
    bayesThreshold: $("bayesThreshold"), bayesLabel: $("bayesLabel"),
    btnSave: $("btnSave"), toast: $("toast")
  };

  function send(msg) {
    return new Promise(function(r) { chrome.runtime.sendMessage(msg, function(v) { r(v); }); });
  }

  function toast(text, ok) {
    var t = el.toast;
    t.textContent = text;
    t.className = "toast " + (ok ? "toast-ok" : "toast-err");
    t.style.opacity = "1";
    clearTimeout(t._tid);
    t._tid = setTimeout(function() { t.style.opacity = "0"; }, 2000);
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

    var cfg = await send({ type: "XHB2_GET_CONFIG" });
    cfg.llmEndpoint = el.llmEndpoint.value.trim();
    cfg.llmApiKey = el.llmApiKey.value.trim();
    cfg.llmModel = el.llmModel.value.trim() || "gpt-4o-mini";
    cfg.bayesMinConfidence = parseInt(el.bayesThreshold.value) / 100;

    await send({ type: "XHB2_SAVE_CONFIG", config: cfg });
    toast("✅ 配置已保存", true);
    el.btnSave.textContent = "💾 保存配置";
    el.btnSave.disabled = false;
    updatePipeline(cfg);
  });

  function updatePipeline(cfg) {
    var parts = ["① 账号库"];
    parts.push("② 贝叶斯≥" + (cfg.bayesMinConfidence || 0.82).toFixed(2));
    parts.push(cfg.llmEndpoint ? "③ LLM(" + (cfg.llmModel||"?") + ")" : "③ 仅本地");
    el.pipelineInfo.textContent = parts.join(" → ");
  }

  async function loadConfig() {
    var c = await send({ type: "XHB2_GET_CONFIG" }) || {};
    el.llmEndpoint.value = c.llmEndpoint || "";
    el.llmApiKey.value = c.llmApiKey || "";
    el.llmModel.value = c.llmModel || "";
    el.bayesThreshold.value = Math.round((c.bayesMinConfidence || 0.82) * 100);
    el.bayesLabel.textContent = (c.bayesMinConfidence || 0.82).toFixed(2);

    // Detect preset
    var matched = false;
    Object.entries(PRESETS).forEach(function(e) {
      if (e[1].endpoint === c.llmEndpoint && e[1].model === c.llmModel) {
        el.provider.value = e[0]; matched = true;
      }
    });
    if (!matched) el.provider.value = "";

    updatePipeline(c);
  }

  async function loadStats() {
    var s = await send({ type: "XHB2_GET_STATS" }) || {};
    el.statAccounts.textContent = s.accounts || 0;
    el.statBlocked.textContent = s.blocked || 0;
    el.statVocab.textContent = s.vocabulary || 0;
  }

  el.btnExport.addEventListener("click", async function() {
    var r = await send({ type: "XHB2_EXPORT" });
    if (!r || !r.ok) { toast("导出失败", false); return; }
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([r.data], { type: "application/json" }));
    a.download = "xblock2-db-" + new Date().toISOString().slice(0,10) + ".json";
    a.click();
    toast("已导出", true);
  });

  el.btnImport.addEventListener("click", function() { el.importFile.click(); });
  el.importFile.addEventListener("change", async function(e) {
    var file = e.target.files[0]; if (!file) return;
    var text = await file.text();
    var r = await send({ type: "XHB2_IMPORT", data: text });
    el.importFile.value = "";
    if (r && r.ok) { toast("导入 " + r.count + " 个账号", true); loadStats(); }
    else { toast("导入失败", false); }
  });

  loadConfig(); loadStats();
})();
