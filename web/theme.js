/* Governance UI — theme manager (light / dark / system).
 *
 * Loaded as a classic script in <head>, BEFORE the module boots, so the
 * resolved theme is on <html> before the first paint and there is no flash.
 *
 * Three modes, one attribute:
 *   light  -> data-theme="light"
 *   dark   -> data-theme="dark"
 *   system -> data-theme="system", and the attribute tracks the OS via
 *             matchMedia so a flip at dusk restyles the page live.
 *
 * The choice persists in localStorage. The stylesheet owns what the themes
 * look like (tools/theme.css); this file only owns which one is active.
 */
(function () {
  'use strict';

  var KEY = 'gov.theme';
  var MODES = ['light', 'dark', 'system'];

  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return MODES.indexOf(v) >= 0 ? v : 'system';
    } catch (e) {
      return 'system';
    }
  }

  function write(mode) {
    try { localStorage.setItem(KEY, mode); } catch (e) { /* private mode: keep in memory */ }
  }

  function apply(mode) {
    document.documentElement.setAttribute('data-theme', mode);
  }

  var mode = read();
  apply(mode);

  // System mode follows the OS live. Changing the OS setting while the user
  // sits on "system" must restyle the page without a reload.
  if (media) {
    var onChange = function () { if (mode === 'system') apply('system'); };
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange);
  }

  function next() {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    write(mode);
    apply(mode);
    return mode;
  }

  function label() {
    // Single words on purpose: the chip sits in the menubar next to the
    // language chip, and "Light / Dark / System" read fine in both locales.
    return mode.charAt(0).toUpperCase() + mode.slice(1);
  }

  window.ThemeUI = {
    get mode() { return mode; },
    next: next,
    label: label,
    isDark: function () {
      return mode === 'dark' || (mode === 'system' && media && media.matches);
    },
  };
})();
