/*
 * ClearReader content script.
 * Runs on every http/https page but stays idle until asked.
 * Jobs: extract the article on demand, host the floating player in a
 * Shadow DOM (page CSS cannot touch it), relay player commands and
 * keyboard shortcuts to the background service worker.
 */
(function () {
  "use strict";
  if (window.__clearReaderLoaded) return;
  window.__clearReaderLoaded = true;

  var HOST_ID = "clearreader-player-host";
  var speed = 1;

  function setSpeed(v) {
    v = Math.round(Number(v) * 2) / 2; // snap to 0.5 steps
    if (!isFinite(v)) v = 1;
    speed = Math.min(4, Math.max(0.5, v));
    if (els.speed) els.speed.textContent = speed + "x";
    sendCmd("speed", speed);
  }

  /* ---------- article extraction ---------- */

  /* Replace images with their alt text so the narrator can describe them. */
  function annotateImages(root) {
    var imgs = root.querySelectorAll ? root.querySelectorAll("img") : [];
    for (var i = 0; i < imgs.length; i++) {
      var alt = (imgs[i].getAttribute("alt") || "").trim();
      var marker = alt ? "[Image: " + alt + "]" : "[Image]";
      var node = root.ownerDocument.createTextNode("\n" + marker + "\n");
      imgs[i].parentNode.replaceChild(node, imgs[i]);
    }
  }

  function extractArticle() {
    var result = null;
    try {
      if (typeof Readability !== "undefined") {
        var clone = document.cloneNode(true);
        annotateImages(clone);
        result = new Readability(clone).parse();
      }
    } catch (e) {
      result = null;
    }
    if (result && result.textContent && result.textContent.trim().length > 200) {
      return {
        title: result.title || document.title,
        byline: result.byline || "",
        text: result.textContent.trim(),
      };
    }
    // Fallbacks: selected text, then body text.
    var sel = "";
    try {
      sel = window.getSelection().toString().trim();
    } catch (e) {}
    if (sel.length > 50) {
      return { title: document.title, byline: "", text: sel };
    }
    var bodyText = (document.body ? document.body.innerText : "").trim();
    return { title: document.title, byline: "", text: bodyText.slice(0, 60000) };
  }

  /* ---------- floating player ---------- */

  var host = null;
  var els = {};

  var CSS = [
    ":host { all: initial; }",
    ".cr-pill { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;",
    "  display: flex; align-items: center; gap: 8px;",
    "  background: #141821; color: #e8ecf3; border: 1px solid #2a3348;",
    "  border-radius: 999px; padding: 8px 10px 8px 8px;",
    "  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 13px;",
    "  box-shadow: 0 8px 30px rgba(0,0,0,.45); max-width: min(480px, 90vw); }",
    ".cr-btn { width: 34px; height: 34px; border-radius: 50%; border: 1px solid #2a3348;",
    "  background: #1d2433; color: #e8ecf3; cursor: pointer; flex: 0 0 auto;",
    "  display: flex; align-items: center; justify-content: center; font-size: 13px; }",
    ".cr-btn:hover { background: #28324a; }",
    ".cr-btn.main { width: 42px; height: 42px; background: #2563eb; border-color: #2563eb; }",
    ".cr-btn.main:hover { background: #1d4ed8; }",
    ".cr-btn svg { width: 16px; height: 16px; fill: currentColor; }",
    ".cr-btn.main svg { width: 18px; height: 18px; }",
    ".cr-mid { display: flex; flex-direction: column; gap: 5px; min-width: 0; flex: 1 1 auto; }",
    ".cr-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis;",
    "  max-width: 220px; font-weight: 600; }",
    ".cr-status { color: #93a0b8; font-size: 11px; white-space: nowrap; overflow: hidden;",
    "  text-overflow: ellipsis; max-width: 220px; }",
    ".cr-bar { height: 6px; border-radius: 3px; background: #2a3348; cursor: pointer;",
    "  position: relative; min-width: 140px; }",
    ".cr-fill { height: 100%; border-radius: 3px; background: #2563eb; width: 0%; }",
    ".cr-speed { min-width: 44px; border-radius: 999px; height: 30px; font-size: 12px; }",
    ".cr-x { background: transparent; border: none; width: 28px; height: 28px; font-size: 15px; }",
  ].join("\n");

  var ICON_PLAY =
    '<svg viewBox="0 0 16 16"><path d="M4 2l9 6-9 6z"/></svg>';
  var ICON_PAUSE =
    '<svg viewBox="0 0 16 16"><path d="M3 2h4v12H3zM9 2h4v12H9z"/></svg>';

  function buildPlayer(title) {
    closePlayer();
    host = document.createElement("div");
    host.id = HOST_ID;
    var shadow = host.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent = CSS;
    var pill = document.createElement("div");
    pill.className = "cr-pill";
    pill.innerHTML =
      '<button class="cr-btn main" data-cmd="toggle" title="Play/Pause (Space)">' +
      ICON_PLAY +
      "</button>" +
      '<button class="cr-btn" data-cmd="back" title="Back 15s">&#8722;15</button>' +
      '<button class="cr-btn" data-cmd="fwd" title="Forward 15s">+15</button>' +
      '<div class="cr-mid">' +
      '<div class="cr-title"></div>' +
      '<div class="cr-bar" title="Seek"><div class="cr-fill"></div></div>' +
      '<div class="cr-status">Starting...</div>' +
      "</div>" +
      '<button class="cr-btn cr-speed" data-cmd="speed" title="Playback speed">1x</button>' +
      '<button class="cr-btn cr-x" data-cmd="close" title="Close (Esc)">&#10005;</button>';
    shadow.appendChild(style);
    shadow.appendChild(pill);
    document.documentElement.appendChild(host);

    els = {
      pill: pill,
      playBtn: pill.querySelector('[data-cmd="toggle"]'),
      title: pill.querySelector(".cr-title"),
      status: pill.querySelector(".cr-status"),
      bar: pill.querySelector(".cr-bar"),
      fill: pill.querySelector(".cr-fill"),
      speed: pill.querySelector('[data-cmd="speed"]'),
    };
    els.title.textContent = title || document.title;
    els.title.title = title || document.title;

    pill.addEventListener("click", function (ev) {
      var btn = ev.target.closest("[data-cmd]");
      if (btn) {
        handleCommand(btn.getAttribute("data-cmd"));
        return;
      }
      var bar = ev.target.closest(".cr-bar");
      if (bar) {
        var rect = bar.getBoundingClientRect();
        var frac = (ev.clientX - rect.left) / rect.width;
        sendCmd("seekFrac", Math.max(0, Math.min(1, frac)));
      }
    });
  }

  function closePlayer() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    els = {};
  }

  function handleCommand(cmd) {
    if (cmd === "close") {
      sendCmd("close");
      closePlayer();
      return;
    }
    if (cmd === "speed") {
      setSpeed(speed >= 4 ? 0.5 : speed + 0.5); // click cycles up, wraps around
      return;
    }
    sendCmd(cmd);
  }

  function sendCmd(cmd, value) {
    try {
      chrome.runtime.sendMessage({ type: "CR_CMD", cmd: cmd, value: value });
    } catch (e) {}
  }

  function setPlaying(playing) {
    if (els.playBtn) els.playBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  }

  function setStatus(text) {
    if (els.status) els.status.textContent = text;
  }

  function setProgress(p) {
    // p: {index, total, currentTime, duration}
    if (!els.fill) return;
    var frac = 0;
    if (p.total > 0) {
      var within = p.duration > 0 ? p.currentTime / p.duration : 0;
      frac = (p.index + Math.max(0, Math.min(1, within))) / p.total;
    }
    els.fill.style.width = Math.max(0, Math.min(100, frac * 100)).toFixed(1) + "%";
    var label = "Part " + (p.index + 1) + "/" + p.total;
    if (els.status && !els.status.dataset.busy) els.status.textContent = label;
  }

  /* ---------- keyboard shortcuts (player-local) ---------- */

  function isTypingTarget(t) {
    if (!t) return false;
    var tag = (t.tagName || "").toLowerCase();
    return (
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      t.isContentEditable === true
    );
  }

  document.addEventListener(
    "keydown",
    function (ev) {
      if (!host || isTypingTarget(ev.target)) return;
      if (ev.code === "Space") {
        ev.preventDefault();
        handleCommand("toggle");
      } else if (ev.code === "ArrowLeft") {
        ev.preventDefault();
        sendCmd("seek", -15);
      } else if (ev.code === "ArrowRight") {
        ev.preventDefault();
        sendCmd("seek", 15);
      } else if (ev.code === "BracketLeft") {
        ev.preventDefault();
        setSpeed(speed - 0.5);
      } else if (ev.code === "BracketRight") {
        ev.preventDefault();
        setSpeed(speed + 0.5);
      } else if (ev.code === "Escape") {
        handleCommand("close");
      }
    },
    false
  );

  /* ---------- messages from background ---------- */

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "CR_EXTRACT":
        sendResponse({ ok: true, article: extractArticle() });
        break;
      case "CR_PLAYER_SHOW":
        buildPlayer(msg.title);
        if (typeof msg.speed === "number") setSpeed(msg.speed);
        break;
      case "CR_STATUS":
        if (els.status) {
          els.status.dataset.busy = msg.sticky ? "1" : "";
          els.status.textContent = msg.text;
          if (!msg.sticky) {
            setTimeout(function () {
              if (els.status) delete els.status.dataset.busy;
            }, 2500);
          }
        }
        break;
      case "CR_PROGRESS":
        setProgress(msg);
        break;
      case "CR_PLAYING":
        setPlaying(!!msg.playing);
        break;
      case "CR_CLOSE":
        closePlayer();
        break;
    }
  });
})();
