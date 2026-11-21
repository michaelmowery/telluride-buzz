// Applies the saved color theme before the page paints (loaded in <head>).
// Shared by every page; the Preferences panel in app.js writes the choice.
(function () {
  var THEMES = { lake: '#1f4e6e', trailhead: '#2f4a3a', aspen: '#8a3f12', columbine: '#4a3570' };
  var t = 'lake';
  try { t = localStorage.getItem('buzz-theme') || t; } catch (e) { /* storage blocked */ }
  if (!THEMES[t]) t = 'lake';
  document.documentElement.dataset.palette = t;
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) m.content = THEMES[t];
  window.BUZZ_THEMES = THEMES;
})();
