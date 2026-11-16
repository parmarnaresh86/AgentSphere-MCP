/**
 * o2c-review.js — browser side of the sales agents' review card (lib/o2c-review.mjs) and
 * step locking for chat-style agents.
 *
 *   O2CReview.lockPrevious(area)  disable every input / select / button in the agent cards already in
 *                                 the chat, so an earlier step can't be changed once the agent moved on
 *   O2CReview.toggleHeader(btn)   unlock / lock the header fields of the review card
 *   O2CReview.toggleRow(btn)      unlock / lock one row
 *   O2CReview.removeRow(btn)      remove a row (at least one must stay)
 *   O2CReview.post(btn)           send the card once: { action, seq, header, lines }
 */
(function () {
  'use strict';
  if (window.O2CReview) return;

  const st = document.createElement('style');
  st.textContent = `
.o2c-locked{opacity:.55;filter:grayscale(.35);transition:opacity .2s}
.o2c-locked input,.o2c-locked select,.o2c-locked textarea,.o2c-locked button{pointer-events:none;cursor:not-allowed}
.o2c-locked a{pointer-events:auto}
[data-o2c-review] input:not(:disabled),[data-o2c-review] select:not(:disabled){border-color:#0070F2!important;background:#fffbea!important}
[data-o2c-review] input:disabled,[data-o2c-review] select:disabled{background:#f3f4f6!important;color:#4b5563;border-color:#e5e7eb!important}
[data-o2c-review] tr.o2c-editing{background:#fffbea}
[data-items] button:disabled,[data-o2c-review] button:disabled{opacity:.45;cursor:not-allowed}
[data-o2c-review] tr.o2c-noitem [data-item-in]{border-color:#dc2626!important;background:#fef2f2!important}`;
  document.head.appendChild(st);

  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const fmt = n => num(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const card = el => el.closest('[data-o2c-review]');

  function lockEl(root) {
    if (!root || root.classList.contains('o2c-locked')) return;
    root.classList.add('o2c-locked');
    root.querySelectorAll('input,select,textarea,button').forEach(x => { x.disabled = true; x.tabIndex = -1; });
  }

  window.O2CReview = {
    /** Lock every agent card already in the chat area (call before showing the next agent message). */
    lockPrevious(area) {
      if (!area) return;
      [...area.children].forEach(wrap => {
        if (wrap.querySelector('input,select,textarea,button')) lockEl(wrap);
      });
    },

    /** Lock every card in the chat area except `keep` (the card just shown). */
    lockExcept(area, keep) {
      if (!area) return;
      [...area.children].forEach(wrap => {
        if (wrap !== keep && wrap.querySelector('input,select,textarea,button')) lockEl(wrap);
      });
    },

    /**
     * Copy-from review form (lib/copy-doc-flow.mjs): lock header fields and rows behind "✏️ Edit Header"
     * and a ✏️ per row. Rows added with "+ Add Line" stay editable.
     */
    gateCopyForm(form) {
      if (!form || form.dataset.gated) return;
      form.dataset.gated = '1';
      const heads = [...form.querySelectorAll('[data-h]')];
      heads.forEach(x => { x.disabled = true; });
      if (heads.length) {
        const bar = document.createElement('div');
        bar.style.cssText = 'display:flex;justify-content:flex-end;margin:-2px 0 6px';
        bar.innerHTML = '<button type="button" style="border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer">✏️ Edit Header</button>';
        const grid = heads[0].closest('div[style*="grid"]') || heads[0].parentElement;
        grid.parentElement.insertBefore(bar, grid);
        const b = bar.querySelector('button');
        b.onclick = () => {
          const on = b.dataset.on !== '1';
          form.querySelectorAll('[data-h]').forEach(x => { x.disabled = !on; });
          b.dataset.on = on ? '1' : '';
          b.textContent = on ? '✓ Done' : '✏️ Edit Header';
        };
      }
      form.querySelector('thead tr')?.insertAdjacentHTML('beforeend', '<th></th>');
      form.querySelector('template[data-cf-extra-tpl]')?.content.firstElementChild?.insertAdjacentHTML('beforeend', '<td></td>');
      form.querySelectorAll('tr[data-cf-line]').forEach(tr => {
        const ctrls = () => tr.querySelectorAll('input,select,button:not([data-row-edit])');
        ctrls().forEach(x => { x.disabled = true; });
        const td = document.createElement('td');
        td.style.cssText = 'padding:6px 6px;white-space:nowrap';
        td.innerHTML = '<button type="button" data-row-edit title="Edit this row" style="border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer">✏️</button>';
        tr.appendChild(td);
        const b = td.querySelector('button');
        b.onclick = () => {
          const on = !tr.classList.contains('o2c-editing');
          tr.classList.toggle('o2c-editing', on);
          ctrls().forEach(x => { x.disabled = !on; });
          b.textContent = on ? '✓' : '✏️';
          b.title = on ? 'Done editing this row' : 'Edit this row';
        };
      });
    },

    toggleHeader(btn) {
      const box = btn.closest('[data-o2c-head]');
      const on = btn.dataset.on !== '1';
      box.querySelectorAll('[data-h]').forEach(x => { x.disabled = !on; });
      btn.dataset.on = on ? '1' : '';
      btn.textContent = on ? '✓ Done' : '✏️ Edit Header';
      if (on) box.querySelector('[data-h]')?.focus();
    },

    toggleRow(btn) {
      const tr = btn.closest('tr');
      const on = !tr.classList.contains('o2c-editing');
      tr.classList.toggle('o2c-editing', on);
      tr.querySelectorAll('[data-l],[data-item-in]').forEach(x => { x.disabled = !on; });
      btn.textContent = on ? '✓' : '✏️';
      btn.title = on ? 'Done editing this row' : 'Edit this row';
      if (on) tr.querySelector('[data-l]')?.focus();
    },

    removeRow(btn) {
      const c = card(btn), tr = btn.closest('tr');
      if (c.querySelectorAll('tr[data-row]').length <= 1) { alert('The document needs at least one row.'); return; }
      if (tr.dataset.item && !confirm(`Remove ${tr.dataset.item} from this document?`)) return;
      tr.remove();
      this.renumber(c);
      this.recalc(c);
    },

    renumber(c) { c.querySelectorAll('tr[data-row] [data-no]').forEach((td, i) => { td.textContent = i + 1; }); },

    /** "+ Add Row": a new, open row with an item search. */
    addRow(btn) {
      const c = card(btn), tpl = c.querySelector('template[data-new-row]');
      if (!tpl) return;
      const blank = [...c.querySelectorAll('tr[data-row][data-new]')].find(r => !r.dataset.item);
      if (blank) { blank.classList.add('o2c-noitem'); blank.querySelector('[data-item-in]')?.focus(); alert('Pick an item in the open row first (or remove it with 🗑).'); return; }
      const tr = tpl.content.firstElementChild.cloneNode(true);
      c.querySelector('tbody').appendChild(tr);
      this.renumber(c);
      tr.querySelector('[data-item-in]')?.focus();
    },

    /** Item picked / typed in a new row: keep the item code, show its name, fetch the customer's price. */
    pickItem(input) {
      const tr = input.closest('tr'), c = card(input);
      const raw = input.value.trim();
      const opt = [...(input.list?.options || [])].find(o => o.value.toLowerCase() === raw.toLowerCase()
        || (o.textContent && `${o.value} — ${o.textContent}`.toLowerCase() === raw.toLowerCase()));
      let code = opt ? opt.value : raw.split(/\s+[—–-]\s+/)[0].trim();
      if (code && !opt && input.list?.options.length) {
        alert(`"${raw}" is not in the item list — pick an item from the list.`);
        code = ''; input.value = '';
      }
      tr.dataset.item = code;
      tr.classList.toggle('o2c-noitem', !code);
      input.value = code;
      tr.querySelector('[data-item-name]').textContent = opt?.textContent || (code ? 'Checked when you post' : '');
      const pr = tr.querySelector('[data-l="unitPrice"]'); if (pr) delete pr.dataset.manual;
      if (code) this.loadPrice(tr, c);
    },

    /** Quantity changed on a new row → customer price may depend on quantity (volume discounts). */
    qtyChanged(input) {
      const tr = input.closest('tr');
      if (tr.hasAttribute('data-new') && tr.dataset.item) this.loadPrice(tr, card(input));
    },

    async loadPrice(tr, c) {
      const api = c.dataset.priceApi, priceEl = tr.querySelector('[data-l="unitPrice"]'), note = tr.querySelector('[data-item-name]');
      if (!api || !priceEl || priceEl.dataset.manual) return;
      const itemCode = tr.dataset.item, qty = tr.querySelector('[data-l="quantity"]')?.value || 1;
      try {
        const q = new URLSearchParams({ sessionId: c.dataset.sid || '', itemCode, qty });
        const r = await fetch(api + '/item-price?' + q, { headers: { 'x-auth-token': localStorage.getItem('hanny_token') || '' } }).then(x => x.json());
        if (priceEl.dataset.manual || tr.dataset.item !== itemCode) return;
        if (r.ok && r.price > 0) {
          priceEl.value = r.price;
          if (note && !/✓|⚠️/.test(note.textContent)) note.textContent += r.source === 'fallback' ? ' · ⚠️ base price list' : ` · ✓ ${r.source === 'vendor' ? 'vendor' : 'customer'} price`;
        } else if (note && !/⚠️/.test(note.textContent)) note.textContent += ' · ⚠️ no price — enter it';
      } catch { /* price stays editable */ }
      this.recalc(c);
    },

    recalc(elOrCard) {
      const c = elOrCard.matches?.('[data-o2c-review]') ? elOrCard : card(elOrCard);
      let sub = 0, tax = 0;
      c.querySelectorAll('tr[data-row]').forEach(tr => {
        const v = k => num(tr.querySelector(`[data-l="${k}"]`)?.value);
        const t = v('quantity') * v('unitPrice') * (1 - v('discountPercent') / 100);
        const ts = tr.querySelector('[data-l="taxCode"]');
        const rate = num(ts?.selectedOptions?.[0]?.dataset.rate);
        const tx = t * rate / 100;
        sub += t; tax += tx;
        tr.querySelector('[data-lt]').textContent = fmt(t);
        const tc = tr.querySelector('[data-ltax]'); if (tc) tc.textContent = fmt(tx);
      });
      const set = (sel, v) => { const e = c.querySelector(sel); if (e) e.textContent = fmt(v); };
      set('[data-sub]', sub); set('[data-tax]', tax); set('[data-total]', sub + tax);
    },

    /** Send a plain action from inside a card (e.g. "+ Add More Items"), once. */
    send(btn, payload) {
      const c = card(btn);
      if (c.dataset.sent) return;
      c.dataset.sent = '1';
      const fn = window[c.dataset.send];
      if (typeof fn === 'function') fn(payload);
    },

    post(btn) {
      const c = card(btn);
      if (c.dataset.sent) return;                         // one click only
      const header = {};
      c.querySelectorAll('[data-h]').forEach(x => { header[x.dataset.h] = x.value; });
      const lines = [...c.querySelectorAll('tr[data-row]')].map(tr => {
        const v = k => tr.querySelector(`[data-l="${k}"]`)?.value ?? '';
        return { itemCode: tr.dataset.item, quantity: num(v('quantity')), unitPrice: num(v('unitPrice')),
          discountPercent: num(v('discountPercent')), taxCode: v('taxCode'), warehouseCode: v('warehouseCode') };
      });
      const noItem = lines.findIndex(l => !l.itemCode);
      if (noItem >= 0) { c.querySelectorAll('tr[data-row]')[noItem]?.classList.add('o2c-noitem'); alert(`Row ${noItem + 1}: pick an item, or remove the row with 🗑.`); return; }
      const bad = lines.findIndex(l => !(l.quantity > 0));
      if (bad >= 0) { alert(`Row ${bad + 1} (${lines[bad].itemCode}): quantity must be more than 0.`); return; }
      c.dataset.sent = '1';
      btn.disabled = true;
      btn.textContent = '⏳ Posting…';
      c.querySelectorAll('input,select,button').forEach(x => { x.disabled = true; });
      const fn = window[c.dataset.send];
      if (typeof fn === 'function') fn(JSON.stringify({ action: c.dataset.action, seq: num(c.dataset.seq), header, lines }));
    },
  };
})();
