/*
 * ClearReader background service worker.
 * Orchestrates the pipeline: extract article -> LLM rewrite into a
 * listenable script -> TTS chunk synthesis -> offscreen audio playback.
 * Holds per-tab reading state and relays player commands.
 */
"use strict";

/* ---------- settings ---------- */

var DEFAULTS = {
  provider: "openai", // openai | gemini | custom
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

function getSettings() {
  return chrome.storage.local.get(DEFAULTS).then(function (s) {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      out[k] = s[k] !== undefined && s[k] !== null ? s[k] : DEFAULTS[k];
    });
    return out;
  });
}

/* ---------- LLM script pass ---------- */

var SYSTEM_PROMPT = [
  "Prepare the web article below for text to speech.",
  "Keep prose paragraphs word for word exactly as written.",
  "If a single sentence would sound wrong read aloud, fix only that sentence, minimally.",
  "Never paraphrase ordinary prose for style.",
  "Only rewrite these hard to listen to elements:",
  "tables become short spoken comparisons of what matters, never read cell by cell,",
  "each [Image: ...] marker becomes a one or two sentence narration of what it shows,",
  "for example say what rises or falls in a chart, never skip a marker,",
  "code blocks become one or two plain sentences instead of reading the code aloud.",
  "Cut navigation menus, ads, cookie banners, signup prompts, and other page cruft.",
  "You may use short section headers.",
  "Output plain text only: no markdown, no bullet characters, no asterisks, no emojis.",
].join(" ");

function truncateForLlm(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n\n[article truncated for length]";
}

function providerConfig(settings) {
  if (settings.provider === "gemini") {
    if (!settings.geminiKey) throw new Error("Add your Gemini API key in Options first.");
    return { kind: "gemini", key: settings.geminiKey, llmModel: settings.geminiModel };
  }
  if (settings.provider === "custom") {
    var base = (settings.customBaseUrl || "").replace(/\/+$/, "");
    if (!base) throw new Error("Set your custom base URL in Options first.");
    if (!settings.customKey) throw new Error("Add your API key in Options first.");
    if (!settings.customLlmModel) throw new Error("Set your custom LLM model in Options first.");
    return { kind: "openaiCompat", base: base, key: settings.customKey, llmModel: settings.customLlmModel };
  }
  if (!settings.openaiKey) throw new Error("Add your OpenAI API key in Options first.");
  return {
    kind: "openaiCompat",
    base: "https://api.openai.com",
    key: settings.openaiKey,
    llmModel: settings.openaiLlmModel,
  };
}

function llmRewrite(article, settings) {
  var cfg = providerConfig(settings);
  var userText =
    "Title: " + (article.title || "untitled") + "\n\nArticle:\n" + truncateForLlm(article.text || "", 12000);

  if (cfg.kind === "gemini") {
    var url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(cfg.llmModel) +
      ":generateContent?key=" +
      encodeURIComponent(cfg.key);
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: userText }] }],
        generationConfig: { maxOutputTokens: 4000, temperature: 0.3 },
      }),
    })
      .then(checkJson)
      .then(function (data) {
        var t = ((((data.candidates || [])[0] || {}).content || {}).parts || [])
          .map(function (p) {
            return p.text || "";
          })
          .join("");
        if (!t.trim()) throw new Error("Empty script from model.");
        return t.trim();
      });
  }

  return fetch(cfg.base + "/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + cfg.key,
    },
    body: JSON.stringify({
      model: cfg.llmModel,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText },
      ],
      max_completion_tokens: 4000,
    }),
  })
    .then(checkJson)
    .then(function (data) {
      var t = (((data.choices || [])[0] || {}).message || {}).content || "";
      if (!t.trim()) throw new Error("Empty script from model.");
      return t.trim();
    });
}

function checkJson(resp) {
  if (!resp.ok) {
    return resp.text().then(function (body) {
      throw new Error("Request failed (" + resp.status + "): " + body.slice(0, 200));
    });
  }
  return resp.json();
}

/* ---------- TTS ---------- */

function splitScript(script, maxLen) {
  maxLen = maxLen || 4000;
  var sentences = script.match(/[^.!?]+[.!?]+["']?\s*/g) || [script];
  var chunks = [];
  var cur = "";
  sentences.forEach(function (s) {
    if ((cur + s).length > maxLen && cur) {
      chunks.push(cur.trim());
      cur = "";
    }
    cur += s;
  });
  if (cur.trim()) chunks.push(cur.trim());
  // Hard-split any overlong chunk.
  var out = [];
  chunks.forEach(function (c) {
    while (c.length > maxLen) {
      out.push(c.slice(0, maxLen));
      c = c.slice(maxLen);
    }
    if (c) out.push(c);
  });
  return out;
}

function base64ToBuffer(b64) {
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function synthesizeChunk(text, settings) {
  if (settings.provider === "gemini") {
    var url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(settings.geminiTtsModel || settings.geminiModel) +
      ":generateContent?key=" +
      encodeURIComponent(settings.geminiKey);
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Read this aloud naturally: " + text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
          },
        },
      }),
    })
      .then(checkJson)
      .then(function (data) {
        var parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
        for (var i = 0; i < parts.length; i++) {
          var inline = parts[i].inlineData || parts[i].inline_data;
          if (inline && inline.data) {
            return { buffer: base64ToBuffer(inline.data), mime: inline.mimeType || "audio/mp3" };
          }
        }
        throw new Error("No audio in Gemini response (model may not support TTS).");
      });
  }

  var base = "https://api.openai.com";
  var key = settings.openaiKey;
  var ttsModel = settings.openaiTtsModel || "gpt-4o-mini-tts";
  if (settings.provider === "custom") {
    base = (settings.customBaseUrl || "").replace(/\/+$/, "");
    key = settings.customKey;
    ttsModel = settings.customTtsModel;
  }
  var ttsBody = {
    model: ttsModel,
    voice: settings.openaiVoice || "marin",
    input: text,
    response_format: "mp3",
  };
  // Tone/style steering is only supported by gpt-4o-mini-tts.
  if (
    settings.openaiVoiceInstructions &&
    /gpt-4o-mini-tts/.test(ttsModel)
  ) {
    ttsBody.instructions = settings.openaiVoiceInstructions;
  }
  return fetch(base + "/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify(ttsBody),
  }).then(function (resp) {
    if (!resp.ok) {
      return resp.text().then(function (body) {
        throw new Error("TTS failed (" + resp.status + "): " + body.slice(0, 200));
      });
    }
    return resp.arrayBuffer().then(function (buf) {
      return { buffer: buf, mime: "audio/mp3" };
    });
  });
}

/* ---------- offscreen audio ---------- */

function ensureOffscreen() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    return chrome.offscreen.hasDocument().then(function (exists) {
      if (exists) return;
      return chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Play synthesized article audio while the service worker sleeps.",
      });
    });
  }
  return chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Play synthesized article audio while the service worker sleeps.",
  });
}

function sendOffscreen(msg) {
  return chrome.runtime.sendMessage(Object.assign({ target: "offscreen" }, msg));
}

/* ---------- reading state ---------- */

var readings = new Map(); // tabId -> { chunks, total, requested:Set, done:Set, tabId }

function setPlayerStatus(tabId, text, sticky) {
  chrome.tabs.sendMessage(tabId, { type: "CR_STATUS", text: text, sticky: !!sticky }).catch(function () {});
}

function failReading(tabId, err) {
  readings.delete(tabId);
  sendOffscreen({ type: "OFFSCREEN_CMD", cmd: "stop" }).catch(function () {});
  setPlayerStatus(tabId, "Error: " + (err && err.message ? err.message : err), true);
}

function startReading(tabId, article) {
  getSettings()
    .then(function (settings) {
      chrome.tabs.sendMessage(tabId, {
        type: "CR_PLAYER_SHOW",
        title: article.title,
        speed: Number(settings.defaultSpeed) || 1,
      }).catch(function () {});
      setPlayerStatus(tabId, "Writing script...", true);
      return llmRewrite(article, settings).then(function (script) {
        return { settings: settings, script: script };
      });
    })
    .then(function (res) {
      var chunks = splitScript(res.script, 4000);
      if (!chunks.length) throw new Error("Script came back empty.");
      readings.set(tabId, {
        tabId: tabId,
        chunks: chunks,
        total: chunks.length,
        requested: new Set(),
        settings: res.settings,
      });
      setPlayerStatus(tabId, "Voicing 1/" + chunks.length + "...", true);
      return ensureOffscreen().then(function () {
        return sendOffscreen({
          type: "OFFSCREEN_START",
          total: chunks.length,
          speed: Number(res.settings.defaultSpeed) || 1,
        });
      });
    })
    .then(function () {
      requestChunk(tabId, 0);
    })
    .catch(function (err) {
      failReading(tabId, err);
    });
}

function requestChunk(tabId, index) {
  var r = readings.get(tabId);
  if (!r || index >= r.total || r.requested.has(index)) return;
  r.requested.add(index);
  synthesizeChunk(r.chunks[index], r.settings)
    .then(function (audio) {
      if (!readings.get(tabId)) return; // reading was cancelled
      return sendOffscreen({
        type: "OFFSCREEN_QUEUE",
        index: index,
        total: r.total,
        audio: audio.buffer,
        mime: audio.mime,
      });
    })
    .catch(function (err) {
      failReading(tabId, err);
    });
}

/* ---------- entry points ---------- */

/* When the extension is reloaded, declared content scripts are evicted from
 * already-open tabs. If the first message to a tab fails with "Could not
 * establish connection. Receiving end does not exist.", inject the content
 * script ourselves and retry once instead of showing a dead error. */
function ensureContentScript(tabId) {
  return chrome.scripting
    .executeScript({
      target: { tabId: tabId },
      files: ["vendor/readability.js", "content.js"],
    })
    .catch(function () {
      throw new Error("Refresh the page and try again.");
    });
}

function extractFromTab(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: "CR_EXTRACT" }).catch(function (err) {
    var msg = (err && err.message) || "";
    if (/could not establish|receiving end/i.test(msg)) {
      return ensureContentScript(tabId).then(function () {
        return chrome.tabs.sendMessage(tabId, { type: "CR_EXTRACT" });
      });
    }
    throw err;
  });
}

function readActiveTab() {
  return chrome.tabs
    .query({ active: true, currentWindow: true })
    .then(function (tabs) {
      var tab = tabs[0];
      if (!tab || !tab.id || !/^https?:/.test(tab.url || "")) {
        throw new Error("Open a normal web page first.");
      }
      return extractFromTab(tab.id).then(function (resp) {
        if (!resp || !resp.ok || !resp.article || !resp.article.text) {
          throw new Error("Could not find article text on this page.");
        }
        startReading(tab.id, resp.article);
        return { ok: true };
      });
    });
}

chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.create({
    id: "cr-read",
    title: "Read article aloud",
    contexts: ["page", "selection"],
  });
});

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId === "cr-read" && tab && tab.id) {
    extractFromTab(tab.id)
      .then(function (resp) {
        if (resp && resp.ok && resp.article && resp.article.text) {
          startReading(tab.id, resp.article);
        }
      })
      .catch(function () {});
  }
});

chrome.commands.onCommand.addListener(function (command) {
  if (command === "read-article") {
    readActiveTab().catch(function () {});
  } else if (command === "toggle-play") {
    sendOffscreen({ type: "OFFSCREEN_CMD", cmd: "toggle" }).catch(function () {});
  }
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  readings.delete(tabId);
});

/* ---------- message hub ---------- */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  if (msg.type === "CR_READ") {
    readActiveTab().then(
      function () {
        sendResponse({ ok: true });
      },
      function (err) {
        sendResponse({ ok: false, error: err.message });
      }
    );
    return true;
  }

  // Player commands from the content script player.
  if (msg.type === "CR_CMD") {
    var tabId = sender.tab && sender.tab.id;
    if (msg.cmd === "close") {
      if (tabId) readings.delete(tabId);
      sendOffscreen({ type: "OFFSCREEN_CMD", cmd: "stop" }).catch(function () {});
      return;
    }
    var oc = { type: "OFFSCREEN_CMD", cmd: msg.cmd, value: msg.value };
    sendOffscreen(oc).catch(function () {});
    return;
  }

  // Reports from the offscreen document.
  if (msg.type === "CR_OFFSCREEN") {
    if (msg.kind === "NEED") {
      // Find which reading this belongs to (single active reading for now).
      readings.forEach(function (r) {
        requestChunk(r.tabId, msg.next);
      });
    } else if (msg.kind === "PROGRESS") {
      readings.forEach(function (r) {
        chrome.tabs
          .sendMessage(r.tabId, {
            type: "CR_PROGRESS",
            index: msg.index,
            total: msg.total,
            currentTime: msg.currentTime,
            duration: msg.duration,
          })
          .catch(function () {});
        if (typeof msg.playing === "boolean") {
          chrome.tabs.sendMessage(r.tabId, { type: "CR_PLAYING", playing: msg.playing }).catch(function () {});
        }
        if (msg.index === 0 && msg.currentTime < 1) {
          setPlayerStatus(r.tabId, "Part 1/" + msg.total, false);
        }
      });
    } else if (msg.kind === "ENDED_ALL") {
      readings.forEach(function (r) {
        setPlayerStatus(r.tabId, "Done.", false);
        chrome.tabs.sendMessage(r.tabId, { type: "CR_PLAYING", playing: false }).catch(function () {});
      });
      readings.clear();
    }
    return;
  }
});
