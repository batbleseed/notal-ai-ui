/* The landing page's scroll demo, on the vendored Motion build (globalThis.Motion
   — Framer Motion's vanilla API, not React). Read index.html's .demo rules first:
   a page where this file never runs still shows every caption in reading order,
   so no copy here depends on an animation to become legible. */
(() => {
  const M = window.Motion;
  const demo = document.getElementById("demo");
  const rail = document.getElementById("demoRail");
  if (!M || !demo || !rail) return;

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Only hide what is still below the fold. Anything already on screen is left
     alone, so a first paint never flashes and a stalled script never blanks. */
  if (!reduced) {
    for (const group of document.querySelectorAll("[data-reveal]")) {
      const kids = [...group.children].filter(el => el.getBoundingClientRect().top > innerHeight * 0.92);
      if (!kids.length) continue;
      kids.forEach(el => { el.style.opacity = "0"; el.style.transform = "translateY(14px)"; });
      /* inView's cleanup disconnects an observer shared by every group on this
         root and margin, so the guard stays here and the watch is left running */
      let played = false;
      M.inView(group, () => {
        if (played) return;
        played = true;
        M.animate(kids, { opacity: [0, 1], y: [14, 0] },
          { duration: 0.55, delay: M.stagger(0.07), ease: [0.22, 1, 0.36, 1] });
      }, { margin: "0px 0px -8% 0px" });
    }
  }

  const PROPS = ["--menu", "--set", "--dim", "--o-open", "--o-models", "--o-lock", "--o-start"];
  const roomy = matchMedia("(min-width: 901px)");
  const caps = [...demo.querySelectorAll(".cap")];
  const clamp = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const seg = (p, a, b) => clamp((p - a) / (b - a));
  /* rises across a→b, holds, falls away across c→d */
  const band = (p, a, b, c, d) => Math.min(seg(p, a, b), 1 - seg(p, c, d));

  function scrub(p) {
    /* the four beats: the menu opens and closes, then Settings opens on Security,
       then the window gives the page over to the two ways in */
    const o = {
      "--menu": band(p, 0.08, 0.16, 0.30, 0.37),
      "--set": band(p, 0.40, 0.48, 0.66, 0.73),
      "--dim": seg(p, 0.76, 0.86),
      "--o-open": 1 - seg(p, 0.06, 0.12),
      "--o-models": band(p, 0.13, 0.20, 0.29, 0.35),
      "--o-lock": band(p, 0.36, 0.44, 0.64, 0.70),
      "--o-start": seg(p, 0.72, 0.80),
    };
    for (const key in o) demo.style.setProperty(key, o[key].toFixed(3));
    for (const cap of caps) cap.setAttribute("aria-hidden", o["--o-" + cap.dataset.cap] < 0.5);
  }

  /* A narrow screen gets the stacked version instead of a 340vh pinned stage:
     scrubbing a mock app through a phone's address bar is not a demo, it's a fight. */
  function setMode(wide) {
    demo.classList.toggle("demo-scrub", wide && !reduced);
    if (wide && !reduced) {
      /* scroll() stays quiet until the first scroll event, so paint the opening
         frame from the rail's own box — a reload deep in the page would otherwise
         sit on the CSS defaults until the reader moves */
      const r = rail.getBoundingClientRect();
      scrub(clamp(-r.top / Math.max(1, r.height - innerHeight)));
      if (!armed) armed = M.scroll(p => { if (demo.classList.contains("demo-scrub")) scrub(p); },
        { target: rail, offset: ["start start", "end end"] });
    } else {
      for (const key of PROPS) demo.style.removeProperty(key);
    }
  }

  let armed = null;
  setMode(roomy.matches);
  roomy.addEventListener("change", e => setMode(e.matches));
})();
