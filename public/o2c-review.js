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
[data-o2c-review] tr.o2c-editing{background:#fffbea}`;
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
      tr.querySelectorAll('[data-l]').forEach(x => { x.disabled = !on; });
      btn.textContent = on ? '✓' : '✏️';
      btn.title = on ? 'Done editing this row' : 'Edit this row';
      if (on) tr.querySelector('[data-l]')?.focus();
    },

    removeRow(btn) {
      const c = card(btn), tr = btn.closest('tr');
      if (c.querySelectorAll('tr[data-row]').length <= 1) { alert('The document needs at least one row.'); return; }
      if (!confirm(`Remove ${tr.dataset.item} from this document?`)) return;
      tr.remove();
      c.querySelectorAll('tr[data-row] [data-no]').forEach((td, i) => { td.textContent = i + 1; });
      this.recalc(c);
    },

    recalc(elOrCard) {
      const c = elOrCard.matches?.('[data-o2c-review]') ? elOrCard : card(elOrCard);
      let total = 0;
      c.querySelectorAll('tr[data-row]').forEach(tr => {
        const v = k => num(tr.querySelector(`[data-l="${k}"]`)?.value);
        const t = v('quantity') * v('unitPrice') * (1 - v('discountPercent') / 100);
        total += t;
        tr.querySelector('[data-lt]').textContent = fmt(t);
      });
      c.querySelector('[data-total]').textContent = fmt(total);
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
