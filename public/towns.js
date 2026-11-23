// Town picker: tapping the header logo opens a list of towns, each in its own
// logo. Without JavaScript the logo is a plain link home.
(() => {
  const brand = document.getElementById('brand');
  const menu = document.getElementById('town-menu');
  if (!brand || !menu) return;
  const set = (open) => {
    menu.hidden = !open;
    brand.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('a:not([aria-current])')?.focus({ preventScroll: true });
  };
  brand.addEventListener('click', (e) => { e.preventDefault(); set(menu.hidden); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target) && !brand.contains(e.target)) set(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { set(false); brand.focus(); } });
})();

// Resources page: a jump link (#medical) opens that collapsed section.
(() => {
  const open = () => {
    const el = location.hash.length > 1 && document.getElementById(location.hash.slice(1));
    if (el && el.tagName === 'DETAILS') el.open = true;
  };
  window.addEventListener('hashchange', open);
  document.addEventListener('DOMContentLoaded', open);
})();
