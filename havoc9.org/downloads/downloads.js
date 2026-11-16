// HAVOC9: DOWNLOADS (downloads/). Each button's file is asked for with a HEAD request (the headers only, not the file): one the
// server does not have (404) greys out its card, and every other link to it on the page, until the file is put in place. A part an
// admin closed is greyed out by script.js (GET /api/site) instead; its 503 is left to that.
(function () {
  "use strict";
  var style = document.createElement("style");
  style.textContent = ".h9-missing{opacity:.4;filter:grayscale(1);cursor:not-allowed;pointer-events:none}";
  document.head.appendChild(style);

  var buttons = document.querySelectorAll(".download-card a.download-btn[href$='.zip'], .download-card a.download-btn[href$='.exe']");
  Array.prototype.forEach.call(buttons, function (btn) {
    var file = btn.getAttribute("href");
    fetch(file, { method: "HEAD", cache: "no-store", credentials: "same-origin" })
      .then(function (res) {
        if (res.status !== 404) return;
        var card = btn.closest(".download-card");
        if (card) card.classList.add("h9-missing");
        btn.textContent = "NOT AVAILABLE YET";
        btn.setAttribute("aria-disabled", "true");
        btn.removeAttribute("href");
        Array.prototype.forEach.call(document.querySelectorAll("a[href='" + file + "']"), function (a) {
          a.classList.add("h9-missing");
          a.setAttribute("aria-disabled", "true");
        });
      })
      .catch(function () { /* no answer: leave the button as it is */ });
  });
})();
