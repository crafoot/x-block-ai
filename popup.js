(function() {
  "use strict";

  var el = {
    llmEndpoint: document.getElementById("llmEndpoint"),
    llmApiKey: document.getElementById("llmApiKey"),
    llmModel: document.getElementById("llmModel"),
    btnSaveConfig: document.getElementById("btnSaveConfig"),
    configStatus: document.getElementById("configStatus"),
    statEntries: document.getElementById("statEntries"),
    statBlocks: document.getElementById("statBlocks"),
    btnExport: document.getElementById("btnExport"),
    btnImport: document.getElementById("btnImport"),
    importFile: document.getElementById("importFile"),
    autoBlockToggle: document.getElementById("autoBlockToggle"),
    kbThreshold: document.getElementById("kbThreshold"),
    kbThresholdLabel: document.getElementById("kbThresholdLabel")
  };

  function send(msg) {
    return new Promise(function(resolve) {
      chrome.runtime.sendMessage(msg, function(r) { resolve(r); });
    });
  }

  async function loadConfig() {
    var cfg = await send({ type: "XHB2_GET_CONFIG" });
    el.llmEndpoint.value = cfg.llmEndpoint || "";
    el.llmApiKey.value = cfg.llmApiKey || "";
    el.llmModel.value = cfg.llmModel || "gpt-4o-mini";
    el.autoBlockToggle.checked = cfg.autoBlock !== false;
    el.kbThreshold.value = Math.round((cfg.kbSimThreshold || 0.30) * 100);
    el.kbThresholdLabel.textContent = (cfg.kbSimThreshold || 0.30).toFixed(2);
  }

  async function loadStats() {
    var s = await send({ type: "XHB2_GET_STATS" });
    el.statEntries.textContent = s.entries || 0;
    el.statBlocks.textContent = s.totalBlocks || 0;
  }

  el.btnSaveConfig.addEventListener("click", async function() {
    var cfg = {
      llmEndpoint: el.llmEndpoint.value.trim(),
      llmApiKey: el.llmApiKey.value.trim(),
      llmModel: el.llmModel.value.trim() || "gpt-4o-mini",
      autoBlock: el.autoBlockToggle.checked,
      kbSimThreshold: parseInt(el.kbThreshold.value) / 100
    };
    await send({ type: "XHB2_SAVE_CONFIG", config: cfg });
    el.configStatus.className = "status status-ok";
    el.configStatus.textContent = "✅ 已保存";
    setTimeout(function() { el.configStatus.textContent = ""; }, 2000);
  });

  el.kbThreshold.addEventListener("input", function() {
    el.kbThresholdLabel.textContent = (parseInt(el.kbThreshold.value) / 100).toFixed(2);
  });

  el.btnExport.addEventListener("click", async function() {
    var r = await send({ type: "XHB2_EXPORT" });
    if (!r || !r.ok) { alert("导出失败"); return; }
    var blob = new Blob([r.data], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "xblock2-kb-" + new Date().toISOString().slice(0,10) + ".json";
    a.click();
  });

  el.btnImport.addEventListener("click", function() { el.importFile.click(); });
  el.importFile.addEventListener("change", async function(e) {
    var file = e.target.files[0];
    if (!file) return;
    var text = await file.text();
    var r = await send({ type: "XHB2_IMPORT", data: text });
    el.importFile.value = "";
    if (r && r.ok) { alert("导入成功！" + r.count + " 个账号"); loadStats(); }
    else { alert("导入失败: " + (r && r.error ? r.error : "?")); }
  });

  loadConfig();
  loadStats();
})();
