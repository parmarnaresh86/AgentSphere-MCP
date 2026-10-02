/**
 * app-locale.js — one display locale for the whole app, driven by the
 * connected SAP company's base currency (OADM.MainCurncy):
 *   INR → en-IN (12,34,567 · DD/MM/YYYY), anything else → en-US (1,234,567 · MM/DD/YYYY).
 *
 * Without this, every locale-less toLocaleString()/toLocaleDateString()/
 * Intl.*Format call and every <input type="date"> follows the *browser's*
 * locale, so a PC set to India showed Indian formats for a US company.
 *
 * Load it first in <head>. It:
 *  1. routes locale-less Number/Date/Intl formatting to window.APP_LOCALE;
 *  2. turns every <input type="date"> (now or added later) into a text box
 *     that shows the date in the app format with a calendar button, while its
 *     .value keeps reading/writing ISO YYYY-MM-DD — existing code is unchanged.
 *     Opt out per field with data-native-date.
 *
 * The page sets the currency with window.setAppCurrency({ code, symbol }).
 * Pages inside an iframe inherit the parent's locale automatically.
 */
(function () {
  if (window.__appLocaleInstalled) return;
  window.__appLocaleInstalled = true;

  const localeFor = cur => (cur && cur.code === 'INR') ? 'en-IN' : 'en-US';
  let parentLocale = null;
  try { if (window.parent !== window && window.parent.APP_LOCALE) parentLocale = window.parent.APP_LOCALE; } catch {}
  window.APP_LOCALE = window.APP_LOCALE || parentLocale || 'en-US';
  window.appLocaleFor = window.appLocaleFor || localeFor;
  const L = () => window.APP_LOCALE || 'en-US';

  // ── 1. Locale-less formatting → APP_LOCALE ──────────────────────────────────
  const wrap = (proto, name) => {
    const native = proto[name];
    if (!native || native.__appLocale) return;
    const fn = function (locales, opts) { return native.call(this, locales === undefined ? L() : locales, opts); };
    fn.__appLocale = true;
    proto[name] = fn;
  };
  wrap(Number.prototype, 'toLocaleString');
  wrap(Date.prototype, 'toLocaleString');
  wrap(Date.prototype, 'toLocaleDateString');
  wrap(Date.prototype, 'toLocaleTimeString');
  const wrapIntl = name => {
    const Native = Intl[name];
    if (!Native || Native.__appLocale) return;
    function AppFormat(locales, opts) { return new Native(locales === undefined ? L() : locales, opts); }
    AppFormat.prototype = Native.prototype;
    AppFormat.supportedLocalesOf = Native.supportedLocalesOf.bind(Native);
    AppFormat.__appLocale = true;
    Intl[name] = AppFormat;
  };
  wrapIntl('NumberFormat');
  wrapIntl('DateTimeFormat');

  // ── 2. Date fields in the app format ────────────────────────────────────────
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const nativeGet = el => desc.get.call(el), nativeSet = (el, v) => desc.set.call(el, v);
  const pad = n => String(n).padStart(2, '0');
  const isIso = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
  const inIndia = () => L() === 'en-IN';
  const placeholder = () => (inIndia() ? 'DD/MM/YYYY' : 'MM/DD/YYYY');
  const toDisplay = iso => {
    if (!isIso(iso)) return '';
    const [y, m, d] = iso.split('-');
    return inIndia() ? `${d}/${m}/${y}` : `${m}/${d}/${y}`;
  };
  // text in the app format (or ISO) → ISO, '' for empty, null for invalid
  const parse = text => {
    const t = String(text ?? '').trim();
    if (!t) return '';
    if (isIso(t)) return t;
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
    if (!m) return null;
    const [mm, dd] = inIndia() ? [+m[2], +m[1]] : [+m[1], +m[2]];
    const dt = new Date(Date.UTC(+m[3], mm - 1, dd));
    return dt.getUTCMonth() === mm - 1 && dt.getUTCDate() === dd ? `${m[3]}-${pad(mm)}-${pad(dd)}` : null;
  };
  window.appFormatDate = toDisplay;
  window.appParseDate = parse;

  const ICON = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%236a6d70' stroke-width='2'%3E%3Crect x='3' y='4' width='18' height='18' rx='2'/%3E%3Cline x1='16' y1='2' x2='16' y2='6'/%3E%3Cline x1='8' y1='2' x2='8' y2='6'/%3E%3Cline x1='3' y1='10' x2='21' y2='10'/%3E%3C/svg%3E\")";
  const css = document.createElement('style');
  css.textContent = `input[data-app-date]{background-image:${ICON};background-repeat:no-repeat;background-position:right 7px center;padding-right:26px!important;min-width:118px}
input[data-app-date].app-date-bad{border-color:#BB0000!important;outline-color:#BB0000}
input.app-date-picker{position:absolute!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;border:0!important;padding:0!important;margin:0!important}`;
  (document.head || document.documentElement).appendChild(css);

  function enhance(el) {
    if (el.__appDate || el.type !== 'date' || el.hasAttribute('data-native-date') || el.classList.contains('app-date-picker')) return;
    el.__appDate = true;
    const startIso = nativeGet(el) || el.getAttribute('value') || '';
    // hidden native picker supplies the calendar popup
    const picker = document.createElement('input');
    picker.type = 'date'; picker.className = 'app-date-picker'; picker.tabIndex = -1; picker.setAttribute('aria-hidden', 'true');
    for (const a of ['min', 'max']) if (el.getAttribute(a)) picker.setAttribute(a, el.getAttribute(a));

    el.type = 'text';
    el.setAttribute('data-app-date', '');
    el.setAttribute('autocomplete', 'off');
    if (!el.placeholder) el.placeholder = placeholder();
    el.after(picker);

    let iso = isIso(startIso) ? startIso : '';
    const show = () => { nativeSet(el, toDisplay(iso)); el.classList.remove('app-date-bad'); };
    Object.defineProperty(el, 'value', {
      configurable: true,
      get: () => iso,
      set: v => { const p = parse(v); iso = p || ''; show(); },
    });
    Object.defineProperty(el, 'valueAsDate', {
      configurable: true,
      get: () => (iso ? new Date(`${iso}T00:00:00Z`) : null),
      set: d => { el.value = d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 10) : ''; },
    });
    el.__appDateCommit = () => {          // typed text → ISO (called before anyone else sees change)
      const p = parse(nativeGet(el));
      if (p === null) { el.classList.add('app-date-bad'); return; }
      iso = p; show();
    };
    el.__appDateRefresh = () => { el.placeholder = placeholder(); show(); };
    show();

    const openPicker = () => {
      picker.value = iso;
      for (const a of ['min', 'max']) { const v = el.getAttribute(a); v ? picker.setAttribute(a, v) : picker.removeAttribute(a); }
      try { picker.showPicker(); } catch { picker.focus(); picker.click(); }
    };
    el.addEventListener('click', e => {
      if (el.disabled || el.readOnly) return;
      const r = el.getBoundingClientRect();
      if (e.clientX >= r.right - 28) openPicker();       // calendar icon area
    });
    el.addEventListener('keydown', e => {
      if ((e.altKey && e.key === 'ArrowDown') || e.key === 'F4') { e.preventDefault(); openPicker(); }
    });
    picker.addEventListener('change', () => {
      if (!picker.value) return;
      iso = picker.value; show();
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // Commit typed text before any page handler reads .value on change/blur.
  for (const ev of ['change', 'blur']) {
    document.addEventListener(ev, e => { const t = e.target; if (t && t.__appDate) t.__appDateCommit(); }, true);
  }
  // ...and before an Enter keypress submits a filter.
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target && e.target.__appDate) e.target.__appDateCommit(); }, true);

  const scan = root => {
    if (!root || root.nodeType !== 1) return;
    if (root.tagName === 'INPUT') return enhance(root);
    root.querySelectorAll && root.querySelectorAll('input[type="date"]').forEach(enhance);
  };
  const start = () => {
    scan(document.body);
    new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type === 'attributes') { if (m.target.tagName === 'INPUT') enhance(m.target); continue; }
        m.addedNodes.forEach(scan);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['type'] });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);

  // ── Currency → locale ───────────────────────────────────────────────────────
  window.setAppCurrency = cur => {
    if (cur && cur.code) window.APP_CURRENCY = cur;
    const next = localeFor(window.APP_CURRENCY);
    if (next === window.APP_LOCALE) return;
    window.APP_LOCALE = next;
    if (window.Chart && window.Chart.defaults) window.Chart.defaults.locale = next;
    document.querySelectorAll('input[data-app-date]').forEach(el => el.__appDateRefresh && el.__appDateRefresh());
    try { document.querySelectorAll('iframe').forEach(f => f.contentWindow && f.contentWindow.setAppCurrency && f.contentWindow.setAppCurrency(cur)); } catch {}
  };
  // Chart.js reads its own default locale (the browser's) — pin it once it loads.
  const pinChart = () => { if (window.Chart && window.Chart.defaults && !window.Chart.__appLocale) { window.Chart.defaults.locale = L(); window.Chart.__appLocale = true; } };
  document.addEventListener('DOMContentLoaded', pinChart);
  window.addEventListener('load', pinChart);
})();
