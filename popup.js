"use strict";

document.getElementById("read").addEventListener("click", function () {
  var status = document.getElementById("status");
  status.textContent = "Starting...";
  chrome.runtime.sendMessage({ type: "CR_READ" }, function (resp) {
    if (chrome.runtime.lastError) {
      status.textContent = "Could not reach the background worker.";
      return;
    }
    if (resp && resp.ok) {
      window.close();
    } else {
      status.textContent = (resp && resp.error) || "Failed to start.";
    }
  });
});

document.getElementById("opts").addEventListener("click", function (e) {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
