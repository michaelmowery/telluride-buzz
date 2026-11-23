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

// Resources: search box and category sub-tabs (All, Emergency, Medical, ...).
// A sub-tab shows only that section, opened; search shows only matching entries,
// with their sections opened. Both work together.
(() => {
  for (const tools of document.querySelectorAll('.res-tools')) {
    const root = tools.parentElement;
    const input = tools.querySelector('.res-search');
    const subs = [...tools.querySelectorAll('.res-sub')];
    const sections = [...root.querySelectorAll('details.res-cat')];
    const empty = root.querySelector('.res-empty');
    let cat = '';
    input.hidden = false;
    subs.forEach((a) => { a.hidden = false; });

    function apply() {
      const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      let any = false;
      for (const d of sections) {
        let hits = 0;
        for (const li of d.querySelectorAll('li.res')) {
          const text = li.textContent.toLowerCase().replace(/\s+/g, ' ');
          const ok = words.every((w) => text.includes(w) || text.replace(/\D/g, '').includes(w.replace(/\D/g, '') || '\0'));
          li.hidden = !ok;
          if (ok) hits++;
        }
        const show = (!cat || d.id === cat) && hits > 0;
        d.hidden = !show;
        if (show && (cat || words.length)) d.open = true;
        any ||= show;
      }
      empty.hidden = any;
    }
    function pick(c) {
      cat = c;
      subs.forEach((a) => a.setAttribute('aria-current', String(a.dataset.cat === cat)));
      if (!cat && !input.value.trim()) sections.forEach((d) => { d.open = false; });
      apply();
    }
    subs.forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      pick(cat === a.dataset.cat ? '' : a.dataset.cat);
    }));
    input.addEventListener('input', apply);
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = ''; apply(); } });
    // A shared link to a section (#medical) selects that sub-tab.
    const fromHash = () => { const id = location.hash.slice(1); if (subs.some((a) => a.dataset.cat === id && id)) pick(id); };
    window.addEventListener('hashchange', fromHash);
    fromHash();
  }
})();
