/* Which section of the nav you are on. A page load can read that off the address;
   a click has to be marked at once, because a link that only scrolls to a section
   on the same page never reloads to tell us. */
(function () {
  const links = Array.prototype.slice.call(document.querySelectorAll(".nav-links a"));
  if (!links.length) return;

  const here = () => location.pathname + location.hash;
  const target = (link) => {
    try {
      const url = new URL(link.href, location.href);
      return url.pathname + url.hash;
    } catch {
      return "";
    }
  };

  function mark(link) {
    links.forEach((l) => l.classList.toggle("on", l === link));
  }

  links.forEach((link) => {
    if (target(link) === here()) mark(link);
    link.addEventListener("click", () => mark(link));
  });

  /* back and forward between sections moves the bar with the address */
  addEventListener("hashchange", () => {
    const match = links.filter((l) => target(l) === here()).pop();
    if (match) mark(match);
  });
})();

/* The three lines. They only appear on a phone, where the links live in a panel
   under the bar: choosing a link, tapping outside, Escape or widening the window
   all put it away again. */
(function () {
  const nav = document.querySelector(".nav");
  const burger = document.querySelector(".nav-burger");
  if (!nav || !burger) return;

  const set = (open) => {
    nav.classList.toggle("open", open);
    burger.setAttribute("aria-expanded", String(open));
  };

  burger.addEventListener("click", (e) => {
    e.stopPropagation();
    set(!nav.classList.contains("open"));
  });
  document.addEventListener("click", (e) => {
    if (nav.classList.contains("open") && !e.target.closest(".nav")) set(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") set(false);
  });
  nav.querySelectorAll(".nav-links a").forEach((a) => a.addEventListener("click", () => set(false)));

  const wide = matchMedia("(min-width: 641px)");
  if (wide.addEventListener) wide.addEventListener("change", (e) => { if (e.matches) set(false); });
})();
