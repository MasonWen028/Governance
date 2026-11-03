// Minimal DOM shim for smoke-testing index.html's render functions under node.
// Elements are cached per id so innerHTML written by a renderer can be read back.
const _cache = {};
function mkEl(id) {
  return {
    id: id || '',
    innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
    offsetLeft: 0, offsetTop: 0,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelectorAll: () => [],
    querySelector: () => null,
    appendChild() {}, remove() {},
    addEventListener() {}, closest: () => null,
    focus() {}, blur() {}
  };
}
global.document = {
  getElementById(id) {
    if (!_cache[id]) _cache[id] = mkEl(id);
    return _cache[id];
  },
  querySelectorAll: () => [],
  querySelector: () => mkEl(),
  createElement: () => mkEl(),
  addEventListener() {},
  documentElement: { lang: '', setAttribute() {}, getAttribute() { return ''; } },
  body: mkEl('body')
};
global.window = { addEventListener() {} };
global.navigator = { language: 'en-AU' };
global.__cache = _cache;
