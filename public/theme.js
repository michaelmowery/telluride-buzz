// Applies the saved color theme before the page paints (loaded in <head>).
// Shared by every page; the Preferences panel in app.js writes the choice.
// Each town has its own theme (set in admin, <html data-town-theme>) so towns look
// different. A visitor's own pick is saved per town (buzz-theme:<town>), so choosing
// purple for Durango leaves Telluride in its own colors.
(function () {
  var THEMES = { lake: '#1f4e6e', trailhead: '#2f4a3a', aspen: '#8a3f12', columbine: '#4a3570' };
  var root = document.documentElement;
  var town = root.dataset.town || '';
  var def = THEMES[root.dataset.townTheme] ? root.dataset.townTheme : 'lake';
  var key = town ? 'buzz-theme:' + town : 'buzz-theme';
  var t = '';
  try {
    t = localStorage.getItem(key) || '';
    // Before themes were per town every town shared one pick; let the town's own colors show.
    if (town) localStorage.removeItem('buzz-theme');
  } catch (e) { /* storage blocked */ }
  if (!THEMES[t]) t = def;
  root.dataset.palette = t;
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) m.content = THEMES[t];
  window.BUZZ_THEMES = THEMES;
  window.BUZZ_THEME = { key: key, townDefault: def };
  // Home screen sections this device chose to hide (Preferences).
  var hide = [];
  try { hide = JSON.parse(localStorage.getItem('buzz-hide') || '[]'); } catch (e) { /* ignore */ }
  root.dataset.hide = Array.isArray(hide) ? hide.join(' ') : '';
})();
