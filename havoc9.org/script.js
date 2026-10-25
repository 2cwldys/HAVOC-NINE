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
