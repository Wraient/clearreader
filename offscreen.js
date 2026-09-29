/*
 * ClearReader offscreen document.
 * MV3 service workers cannot hold audio, so this hidden document owns the
 * single Audio element. It plays queued chunks in order, prefetches one
 * chunk ahead, and reports progress back to the background worker.
 */
"use strict";

var audio = new Audio();
audio.preload = "auto";

var queue = []; // [{index, url}]
var total = 0;
var currentIndex = -1;
var playing = false;
var lastProgressSent = 0;

function report(kind, extra) {
  chrome.runtime.sendMessage(
    Object.assign({ type: "CR_OFFSCREEN", kind: kind }, extra || {})
  );
}

function revokeUrl(url) {
  try {
    URL.revokeObjectURL(url);
  } catch (e) {}
}

function tryPlay() {
  if (playing) return;
  // Play strictly in order; wait if the next chunk has not arrived yet.
  var next = queue.find(function (q) {
    return q.index === currentIndex + 1;
  });
  if (!next) {
    // Ask for more audio if the queue is running dry.
    if (currentIndex + 1 < total) report("NEED", { next: currentIndex + 1 });
    return;
  }
  queue = queue.filter(function (q) {
    return q !== next;
  });
  currentIndex = next.index;
  playing = true;
  audio.src = next.url;
  audio
    .play()
    .then(function () {
      report("PROGRESS", progressPayload());
    })
    .catch(function () {
      playing = false;
      revokeUrl(next.url);
    });
  // Keep one chunk prefetched.
  if (queue.length < 1 && currentIndex + 1 < total) {
    report("NEED", { next: currentIndex + 1 });
  }
}

function progressPayload() {
  return {
    index: Math.max(0, currentIndex),
    total: total,
    currentTime: audio.currentTime || 0,
    duration: audio.duration || 0,
    playing: playing && !audio.paused,
  };
}

audio.addEventListener("ended", function () {
  playing = false;
  try {
    revokeUrl(audio.src);
  } catch (e) {}
  if (currentIndex + 1 >= total) {
    report("ENDED_ALL", {});
    currentIndex = -1;
    total = 0;
    return;
  }
  tryPlay();
});

audio.addEventListener("timeupdate", function () {
  var now = Date.now();
  if (now - lastProgressSent < 500) return;
  lastProgressSent = now;
  report("PROGRESS", progressPayload());
});

audio.addEventListener("play", function () {
  report("PROGRESS", progressPayload());
});
audio.addEventListener("pause", function () {
  report("PROGRESS", progressPayload());
});

chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || msg.target !== "offscreen") return;

  if (msg.type === "OFFSCREEN_START") {
    queue.forEach(function (q) {
      revokeUrl(q.url);
    });
    queue = [];
    total = msg.total || 0;
    currentIndex = -1;
    playing = false;
    if (msg.speed) audio.playbackRate = msg.speed;
    return;
  }

  if (msg.type === "OFFSCREEN_QUEUE") {
    var blob = new Blob([msg.audio], { type: msg.mime || "audio/mp3" });
    queue.push({ index: msg.index, url: URL.createObjectURL(blob) });
    tryPlay();
    return;
  }

  if (msg.type === "OFFSCREEN_CMD") {
    var cmd = msg.cmd;
    if (cmd === "toggle") {
      if (audio.paused) {
        if (audio.src) {
          audio.play().catch(function () {});
        } else {
          tryPlay();
        }
      } else {
        audio.pause();
      }
    } else if (cmd === "play") {
      if (audio.src) audio.play().catch(function () {});
      else tryPlay();
    } else if (cmd === "pause") {
      audio.pause();
    } else if (cmd === "seek") {
      var t = (audio.currentTime || 0) + Number(msg.value || 0);
      audio.currentTime = Math.max(0, Math.min(audio.duration || t, t));
    } else if (cmd === "seekFrac") {
      if (audio.duration) {
        // Fraction is overall progress across all chunks; approximate
        // by seeking within the current chunk only when it is the target.
        var targetChunk = Math.floor(Number(msg.value) * total);
        if (targetChunk === currentIndex && audio.duration) {
          var frac = Number(msg.value) * total - targetChunk;
          audio.currentTime = frac * audio.duration;
        }
      }
    } else if (cmd === "speed") {
      audio.playbackRate = Number(msg.value) || 1;
    } else if (cmd === "stop") {
      audio.pause();
      try {
        audio.removeAttribute("src");
        audio.load();
      } catch (e) {}
      queue.forEach(function (q) {
        revokeUrl(q.url);
      });
      queue = [];
      total = 0;
      currentIndex = -1;
      playing = false;
    }
  }
});
