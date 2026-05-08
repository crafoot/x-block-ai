// X-block AI — minimal service worker
var DB = { accounts: {}, bayes: { spamCount: 0, hamCount: 0, words: {} } };
var CONFIG = { autoBlock: true, bayesMinConfidence: 0.82 };

// Load persisted data
chrome.storage.local.get(["xhb2-db","xhb2-config"], function(r) {
  if (r["xhb2-db"]) DB = r["xhb2-db"];
  if (r["xhb2-config"]) CONFIG = r["xhb2-config"];
});

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  // Manual block
  if (msg.type === "XHB2_MANUAL_BLOCK") {
    var h = (msg.profile.handle||"").toLowerCase().replace("@","");
    if (h) {
      DB.accounts[h] = DB.accounts[h] || {handle:"@"+h, displayName:msg.profile.displayName,blocked:true,reasons:[],sources:[],firstSeen:new Date().toISOString(),blockCount:0};
      DB.accounts[h].blocked = true;
      DB.accounts[h].reasons.push("manual");
      DB.accounts[h].blockCount++;
      DB.accounts[h].lastSeen = new Date().toISOString();
      
      // Train bayes
      DB.bayes.spamCount++;
      var feats = getFeatures(msg.text);
      feats.forEach(function(f) {
        DB.bayes.words[f] = DB.bayes.words[f] || {spam:0,ham:0};
        DB.bayes.words[f].spam++;
      });
      
      chrome.storage.local.set({"xhb2-db": DB});
    }
    sendResponse({ok:true});
    return true;
  }
  
  // Stats
  if (msg.type === "XHB2_GET_STATS") {
    var keys = Object.keys(DB.accounts);
    var blocked = keys.filter(function(k){return DB.accounts[k].blocked}).length;
    sendResponse({accounts:keys.length, blocked:blocked, vocabulary:Object.keys(DB.bayes.words).length, spamSamples:DB.bayes.spamCount, hamSamples:DB.bayes.hamCount});
    return true;
  }
  
  // Export
  if (msg.type === "XHB2_EXPORT") {
    sendResponse({ok:true, data: JSON.stringify(DB, null, 2)});
    return true;
  }
  
  // Import
  if (msg.type === "XHB2_IMPORT") {
    try {
      var incoming = JSON.parse(msg.data);
      if (incoming.accounts) {
        Object.values(incoming.accounts).forEach(function(a) {
          var h = (a.handle||"").toLowerCase().replace("@","");
          if (h && !DB.accounts[h]) DB.accounts[h] = a;
        });
      }
      if (incoming.bayes) {
        DB.bayes.spamCount += incoming.bayes.spamCount||0;
        DB.bayes.hamCount += incoming.bayes.hamCount||0;
        Object.entries(incoming.bayes.words||{}).forEach(function(e) {
          DB.bayes.words[e[0]] = DB.bayes.words[e[0]] || {spam:0,ham:0};
          DB.bayes.words[e[0]].spam += e[1].spam||0;
          DB.bayes.words[e[0]].ham += e[1].ham||0;
        });
      }
      chrome.storage.local.set({"xhb2-db": DB});
      sendResponse({ok:true, count: Object.keys(DB.accounts).length});
    } catch(e) {
      sendResponse({ok:false, error:e.message});
    }
    return true;
  }
  
  // Get config
  if (msg.type === "XHB2_GET_CONFIG") { sendResponse(CONFIG); return true; }
  
  // Save config
  if (msg.type === "XHB2_SAVE_CONFIG") {
    CONFIG = msg.config;
    chrome.storage.local.set({"xhb2-config": CONFIG});
    sendResponse({ok:true});
    return true;
  }
  
  return false;
});

function getFeatures(text) {
  var cleaned = (text||"").toLowerCase().replace(/\s+/g," ").trim();
  if (!cleaned) return [];
  var feats = [];
  for (var n = 3; n <= 4; n++) {
    for (var i = 0; i <= cleaned.length - n; i++) {
      feats.push(cleaned.slice(i, i+n));
    }
  }
  cleaned.split(/\s+/).forEach(function(w) {
    if (w.length >= 2) feats.push("W:"+w);
  });
  return Array.from(new Set(feats));
}
