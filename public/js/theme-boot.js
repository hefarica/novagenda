/* Arranque del tema ANTES de pintar la página (script clásico, sin módulo).
   Evita el destello del tema equivocado. No depende de nada más. */
(function () {
  var KEY = 'agenda-p95.theme.v1';
  var CHOICES = ['dark', 'light', 'system'];
  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return CHOICES.indexOf(v) !== -1 ? v : 'system';
    } catch (e) { return 'system'; }
  }
  function resolve(choice) {
    if (choice === 'dark' || choice === 'light') return choice;
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return prefersDark ? 'dark' : 'light';
  }
  var choice = stored();
  var theme = resolve(choice);
  var root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themeChoice = choice;
  if (theme === 'light') root.style.colorScheme = 'light';
  var meta = document.getElementById('metaThemeColor');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#FFFFFF' : '#03265d');
})();

