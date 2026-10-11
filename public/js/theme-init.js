// Runs before the first paint so the page never flashes the wrong theme. The same rules live in lib/theme.js.
(function () {
  var mode = 'system';
  try {
    var saved = localStorage.getItem('overseer-theme');
    if (saved === 'light' || saved === 'dark') mode = saved;
  } catch (e) {
    /* Storage can be blocked; the system theme applies. */
  }
  var light = mode === 'light' || (mode === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  var bar = document.querySelector('meta[name="theme-color"]');
  if (bar) bar.setAttribute('content', light ? '#f3efe2' : '#0a0f0a');
})();
