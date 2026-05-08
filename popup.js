(function() {
  "use strict";
  function $(id) { return document.getElementById(id); }

  var el = {
    statAccounts: $("statAccounts"), statBlocked: $("statBlocked"), statVocab: $("statVocab"),
    statSpam: $("statSpam"), statHam: $("statHam"), statAuto: $("statAuto"),
    btnExport: $("btnExport"), btnImport: $("btnImport"), importFile: $("importFile"),
    pipelineStatus: $("pipelineStatus"), pipelineInfo: $("pipelineInfo"),
    llmEndpoint: $("llmEndpoint"), llmApiKey: $("llmApiKey"), llmModel: $("llmModel"),
    useLLM: $("useLLM"), bayesThreshold: $("bayesThreshold"), bayesLabel: $("bayesLabel"),
    llmThreshold: $("llmThreshold"), llmLabel: $("llmLabel"),
    btnSaveConfig: $("btnSaveConfig"), configStatus: $("configStatus")
  };

  function send(msg) { return new Promise(function(r) { chrome.runtime.sendMessage(msg, function(v) { r(v); }); }); }

  async function loadConfig() {
    var c = await send({ type: "XHB2_GET_CONFIG" });
    el.llmEndpoint.value = c.llmEndpoint || "";
    el.llmApiKey.value = c.llmApiKey || "";
    el.llmModel.value = c.llmModel || "gpt-4o-mini";
    el.useLLM.checked = c.useLLM !== false;
    el.bayesThreshold.value = Math.round((c.bayesMinConfidence || 0.82) * 100);
    el.bayesLabel.textContent = (c.bayesMinConfidence || 0.82).toFixed(2);
    el.llmThreshold.value = Math.round((c.llmMinConfidence || 0.55) * 100);
    el.llmLabel.textContent = (c.llmMinConfidence || 0.55).toFixed(2);
    updatePipeline(c);
  }

  function updatePipeline(cfg) {
    var parts = [];
    parts.push("① 账号库");
    parts.push("② 贝叶斯≥" + (cfg.bayesMinConfidence || 0.82).toFixed(2));
    if (cfg.useLLM && cfg.llmEndpoint) parts.push("③ LLM(" + (cfg.llmModel || "?") + ")");
    else parts.push("③ 仅本地");
    el.pipelineInfo.textContent = parts.join(" → ");
    el.pipelineStatus.textContent = cfg.llmEndpoint ? "🟢 LLM就绪" : "🟡 仅本地";
    el.pipelineStatus.style.color = cfg.llmEndpoint ? "#166534" : "#854d0e";
  }

  async function loadStats() {
    var s = await send({ type: "XHB2_GET_STATS" });
    el.statAccounts.textContent = s.accounts || 0;
    el.statBlocked.textContent = s.blocked || 0;
    el.statVocab.textContent = s.vocabulary || 0;
    el.statSpam.textContent = s.spamSamples || 0;
    el.statHam.textContent = s.hamSamples || 0;
    el.statAuto.textContent = (s.blocked || 0);
  }

  el.bayesThreshold.addEventListener("input", function() {
    el.bayesLabel.textContent = (parseInt(el.bayesThreshold.value) / 100).toFixed(2);
  });
  el.llmThreshold.addEventListener("input", function() {
    el.llmLabel.textContent = (parseInt(el.llmThreshold.value) / 100).toFixed(2);
  });

  el.btnSaveConfig.addEventListener("click", async function() {
    var cfg = {
      llmEndpoint: el.llmEndpoint.value.trim(),
      llmApiKey: el.llmApiKey.value.trim(),
      llmModel: el.llmModel.value.trim() || "gpt-4o-mini",
      useLLM: el.useLLM.checked,
      autoBlock: true,
      bayesMinConfidence: parseInt(el.bayesThreshold.value) / 100,
      llmMinConfidence: parseInt(el.llmThreshold.value) / 100
    };
    await send({ type: "XHB2_SAVE_CONFIG", config: cfg });
    el.configStatus.className = "status status-ok";
    el.configStatus.textContent = "✅";
    updatePipeline(cfg);
    setTimeout(function() { el.configStatus.textContent = ""; }, 2000);
  });

  el.btnExport.addEventListener("click", async function() {
    var r = await send({ type: "XHB2_EXPORT" });
    if (!r || !r.ok) { alert("导出失败"); return; }
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([r.data], { type: "application/json" }));
    a.download = "xblock2-db-" + new Date().toISOString().slice(0,10) + ".json";
    a.click();
  });

  el.btnImport.addEventListener("click", function() { el.importFile.click(); });
  el.importFile.addEventListener("change", async function(e) {
    var file = e.target.files[0]; if (!file) return;
    var text = await file.text();
    var r = await send({ type: "XHB2_IMPORT", data: text });
    el.importFile.value = "";
    if (r && r.ok) { alert("导入成功！" + r.count + " 个账号，模型已合并"); loadStats(); }
    else { alert("导入失败: " + (r && r.error ? r.error : "?")); }
  });

  loadConfig(); loadStats();
})();
