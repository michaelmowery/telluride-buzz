// Click events for the visit counts (see src/analytics.js). Loaded only when analytics
// are on. Umami's own script sends the page views; this names the clicks that matter.
// Nothing personal is sent: the event name, the town and what was clicked.
(() => {
  const town = document.currentScript?.dataset.town || '';
  const track = (name, data = {}) => { try { window.umami?.track(name, { town, ...data }); } catch { /* never break a click */ } };
  window.buzzTrack = track;

  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const action = (a) => (a.classList.contains('res-call') ? 'call' : /^map$/i.test(text(a)) ? 'map' : 'website');

  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a) return;
    const label = text(a);
    const listing = a.closest('li.res');
    if (listing) {
      const business = text(listing.querySelector('.res-name'));
      return track(listing.classList.contains('res-sponsored') ? 'sponsored-click' : 'listing-click', { business, action: action(a) });
    }
    const post = a.closest('li.post');
    if (post) return track('feed-click', { source: text(post.querySelector('.src')) });
    if (/suggest/i.test(label)) return track('suggest-click', { kind: /town/i.test(label) ? 'town' : 'resource' });
    if (/feedback|tell us|report a problem/i.test(label)) return track('feedback-click', { kind: /report/i.test(label) ? 'support' : 'feedback' });
    if (a.closest('#town-menu, .town-list, [data-town-list]') && a.host !== location.host) return track('town-switch', { to: a.host });
  }, { capture: true });
})();
