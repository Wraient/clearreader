/*
 * ClearReader options page logic: load/save settings, show the right
 * provider section, and run a tiny "say hi" test against the provider
 * so a key can be verified without burning tokens.
 */
"use strict";

var DEFAULTS = {
  provider: "openai",
  openaiKey: "",
  openaiLlmModel: "gpt-6-luna",
  openaiTtsModel: "gpt-4o-mini-tts",
  openaiVoice: "marin",
  openaiVoiceInstructions: "",
  geminiKey: "",
  geminiModel: "gemini-2.0-flash",
  geminiTtsModel: "gemini-2.0-flash",
  customBaseUrl: "",
  customKey: "",
  customLlmModel: "",
  customTtsModel: "",
  defaultSpeed: 1,
};

var FIELDS = Object.keys(DEFAULTS);

function showMsg(text, ok) {
  var m = document.getElementById("msg");
  m.textContent = text;
  m.className = ok ? "ok" : "err";
}

function showProvider(name) {
  ["openai", "gemini", "custom"].forEach(function (p) {
    document.getElementById("prov-" + p).classList.toggle("on", p === name);
  });
}

function load() {
  chrome.storage.local.get(DEFAULTS, function (s) {
    FIELDS.forEach(function (k) {
      var el = document.getElementById(k);
      if (el) el.value = s[k] !== undefined && s[k] !== null ? s[k] : DEFAULTS[k];
    });
    showProvider(document.getElementById("provider").value);
  });
}

function save(silent) {
  var s = {};
  FIELDS.forEach(function (k) {
    var el = document.getElementById(k);
    if (el) s[k] = el.value;
  });
  s.defaultSpeed = Number(s.defaultSpeed) || 1;
  chrome.storage.local.set(s, function () {
    if (!silent) showMsg("Saved.", true);
  });
  return s;
}

function testConnection() {
  var s = save(true);
  showMsg("Testing...", true);
  var provider = s.provider;

  function doneOk() {
    showMsg("OK: provider answered.", true);
  }
  function doneErr(e) {
    showMsg("Failed: " + (e && e.message ? e.message : e), false);
  }

  if (provider === "gemini") {
    if (!s.geminiKey) return doneErr(new Error("Enter a Gemini key first."));
    var url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(s.geminiModel || DEFAULTS.geminiModel) +
      ":generateContent?key=" +
      encodeURIComponent(s.geminiKey);
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "say hi" }] }],
        generationConfig: { maxOutputTokens: 5 },
      }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(doneOk, doneErr);
    return;
  }

  var base = "https://api.openai.com";
  var key = s.openaiKey;
  var model = s.openaiLlmModel || DEFAULTS.openaiLlmModel;
  if (provider === "custom") {
    base = (s.customBaseUrl || "").replace(/\/+$/, "");
    key = s.customKey;
    model = s.customLlmModel;
    if (!base) return doneErr(new Error("Enter a base URL first."));
  }
  if (!key) return doneErr(new Error("Enter an API key first."));
  fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({
      model: model,
      messages: [{ role: "user", content: "say hi" }],
      max_completion_tokens: 5,
    }),
  })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(doneOk, doneErr);
}

document.getElementById("provider").addEventListener("change", function (e) {
  showProvider(e.target.value);
});
document.getElementById("save").addEventListener("click", function () {
  save(false);
});
document.getElementById("test").addEventListener("click", testConnection);

load();
