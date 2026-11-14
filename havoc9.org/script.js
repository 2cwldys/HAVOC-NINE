// HAVOC9 — minimal interactions

document.addEventListener("DOMContentLoaded", () => {
  const nav = document.getElementById("nav");
  const navToggle = document.getElementById("navToggle");
  const navLinks = document.getElementById("navLinks");
  const links = navLinks.querySelectorAll("a");

  // Sticky nav background
  window.addEventListener("scroll", () => {
    nav.classList.toggle("scrolled", window.scrollY > 40);
  });

  // Mobile menu
  navToggle.addEventListener("click", () => {
    navLinks.classList.toggle("open");
  });

  links.forEach((link) => {
    link.addEventListener("click", () => {
      navLinks.classList.remove("open");
    });
  });

  // Close menu on outside click
  document.addEventListener("click", (e) => {
    if (
      navLinks.classList.contains("open") &&
      !navLinks.contains(e.target) &&
      !navToggle.contains(e.target)
    ) {
      navLinks.classList.remove("open");
    }
  });

  // Active section highlight
  const sections = document.querySelectorAll("section[id], header[id]");
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          links.forEach((a) => a.classList.remove("active"));
          const id = entry.target.getAttribute("id");
          const active = navLinks.querySelector(`a[href="#${id}"]`);
          if (active) active.classList.add("active");
        }
      });
    },
    { rootMargin: "-40% 0px -50% 0px", threshold: 0 }
  );

  sections.forEach((s) => observer.observe(s));
});


// A part an admin has closed (GET /api/site, h9web/lib/siteflags.js): its links are greyed out and cannot be followed, and the download page
// greys out the whole area under a line that says why. The server refuses the part as well (nginx asks h9web before it serves one).
(function () {
  if (!window.fetch) return;
  fetch("/api/site", { headers: { Accept: "application/json" }, credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (site) {
      if (!site) return;
      var closed = [];
      [["downloads", "/downloads/"], ["webclient", "/webclient/"]].forEach(function (p) {
        if (site[p[0]] && site[p[0]].enabled === false) closed.push({ part: p[0], prefix: p[1], note: site[p[0]].note || "Closed for now." });
      });
      if (!closed.length) return;
      var style = document.createElement("style");
      style.textContent = ".h9-closed{opacity:.4;filter:grayscale(1);cursor:not-allowed;pointer-events:none}"
        + ".h9-closed-banner{margin:0 auto 18px;max-width:960px;padding:14px 18px;border:1px solid #7a6a30;background:rgba(122,106,48,.15);text-align:center;font-weight:600;letter-spacing:.04em}";
      document.head.appendChild(style);
      closed.forEach(function (c) {
        document.querySelectorAll("a[href]").forEach(function (a) {
          var path;
          try { path = new URL(a.getAttribute("href"), location.href).pathname; } catch (e) { return; }
          if (path.indexOf(c.prefix) !== 0) return;
          a.classList.add("h9-closed");
          a.setAttribute("aria-disabled", "true");
          a.setAttribute("tabindex", "-1");
          a.title = c.note;
        });
        if (c.part === "downloads" && location.pathname.indexOf(c.prefix) === 0) {
          var cards = document.querySelectorAll(".download-card");
          if (cards.length) {
            var banner = document.createElement("p");
            banner.className = "h9-closed-banner";
            banner.textContent = "THE DOWNLOADS ARE CLOSED RIGHT NOW. " + c.note;
            cards[0].parentNode.parentNode.insertBefore(banner, cards[0].parentNode);
            cards.forEach(function (card) { card.classList.add("h9-closed"); });
          }
        }
      });
    })
    .catch(function () { /* the site is open when it cannot be asked */ });
})();
