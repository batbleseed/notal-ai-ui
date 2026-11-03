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
