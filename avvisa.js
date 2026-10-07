/* OviAmo – "Avvisa su WhatsApp": manda a una persona della rubrica il messaggio con le uova disponibili.
   Usato da report.html e area.html:  const wa = OviAvvisa(elemento, post);  wa.update(D)
   D deve contenere: available (uova disponibili), contacts [{id,nome,tel}], waMsg (testo predefinito). */
(function () {
  const DEF = 'Ciao, se vuoi ci sono {uova} uova disponibili';
  const css = `
.wa h2{margin:0 0 4px}
.wa .sub{color:var(--muted);font-size:.86rem;margin:0 0 12px}
.wa textarea{width:100%;min-height:64px;resize:vertical;font:inherit;font-size:.95rem;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink)}
.wa .pv{margin:8px 0 2px;padding:10px 12px;border-radius:12px;background:color-mix(in srgb,#25d366 12%,var(--card));font-size:.92rem;white-space:pre-wrap}
.wa .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
.wa .lnk{background:none;border:0;padding:0;color:var(--brand);text-decoration:underline;cursor:pointer;font:inherit;font-size:.85rem}
.wa .ppl{display:grid;gap:8px;margin-top:14px}
.wa .p{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;padding:8px 10px;border:1px solid var(--line);border-radius:12px}
.wa .p b{display:block}.wa .p small{color:var(--muted)}
.wa .go{display:inline-flex;align-items:center;gap:6px;padding:9px 14px;border:0;border-radius:10px;background:#25d366;color:#0b2e17;font:700 .9rem Inter,sans-serif;cursor:pointer;white-space:nowrap}
.wa .go.sent{background:color-mix(in srgb,#25d366 35%,var(--card))}
.wa .x{border:0;background:none;color:var(--muted);font-size:1.3rem;cursor:pointer;padding:0 4px}
.wa .add{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;margin-top:12px}
.wa .add input{min-width:0;font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink)}
.wa .add button{padding:9px 14px;border:0;border-radius:10px;background:var(--brand);color:#fff;font:600 .9rem Inter,sans-serif;cursor:pointer}
@media (prefers-color-scheme:dark){.wa .add button{color:#13200c}}
@media (max-width:520px){.wa .add{grid-template-columns:1fr}}
.wa .empty{color:var(--muted);font-size:.9rem;margin:6px 0 0}
.wa .warn{color:var(--err);font-size:.86rem;margin:6px 0 0}`;

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = t => { let n = String(t || '').replace(/[^\d+]/g, '').replace(/^\+/, '').replace(/^00/, ''); if (/^3\d{8,9}$/.test(n)) n = '39' + n; return n; };
  const fill = (tpl, D, nome) => String(tpl || DEF)
    .replace(/\{uova\}/gi, D.available)
    .replace(/\{nome\}/gi, nome ? String(nome).split(' ')[0] : '')
    .replace(/\{link\}/gi, location.origin)
    .replace(/ +([,!.?;:])/g, '$1');

  window.OviAvvisa = function (el, post) {
    if (!document.getElementById('waCss')) { const s = document.createElement('style'); s.id = 'waCss'; s.textContent = css; document.head.appendChild(s); }
    let D = { available: 0, contacts: [], waMsg: DEF }, tpl = null;
    const sent = new Set();
    const toast = t => (window.toast ? window.toast(t) : alert(t));
    el.classList.add('wa');
    el.innerHTML = `
      <h2>📣 Avvisa su WhatsApp</h2>
      <p class="sub">Scegli la persona: si apre WhatsApp con il messaggio già scritto, poi premi invia.</p>
      <textarea maxlength="500" aria-label="Testo del messaggio"></textarea>
      <div class="row"><small style="color:var(--muted)">Scrivi <b>{uova}</b> dove va il numero (facoltativi: {nome}, {link})</small>
        <button type="button" class="lnk" data-wa="save" hidden>Salva come testo predefinito</button>
        <button type="button" class="lnk" data-wa="reset" hidden>Torna al predefinito</button></div>
      <div class="pv"></div>
      <p class="warn" hidden>Adesso non ci sono uova disponibili.</p>
      <div class="ppl"></div>
      <form class="add"><input name="nome" placeholder="Nome" maxlength="60" required><input name="tel" type="tel" placeholder="Telefono" maxlength="30" required><button>Aggiungi</button></form>`;
    const $ = s => el.querySelector(s), ta = $('textarea');

    function paint() {
      const t = tpl ?? D.waMsg ?? DEF;
      if (document.activeElement !== ta) ta.value = t;
      const changed = t !== (D.waMsg || DEF);
      $('[data-wa="save"]').hidden = !changed; $('[data-wa="reset"]').hidden = !changed;
      $('.pv').textContent = fill(t, D, (D.contacts[0] || {}).nome);
      $('.warn').hidden = D.available > 0;
      $('.ppl').innerHTML = D.contacts.map(c => `<div class="p"><span><b>${esc(c.nome)}</b><small>${esc(c.tel)}</small></span>
        <button type="button" class="go${sent.has(c.id) ? ' sent' : ''}" data-wago="${esc(c.id)}">${sent.has(c.id) ? '✓ Inviato' : 'WhatsApp'}</button>
        <button type="button" class="x" data-wadel="${esc(c.id)}" aria-label="Togli ${esc(c.nome)}">×</button></div>`).join('')
        || '<p class="empty">Nessuna persona in elenco: aggiungila qui sotto.</p>';
    }

    ta.oninput = () => { tpl = ta.value; paint(); };
    el.addEventListener('click', async e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.wago) {
        const c = D.contacts.find(x => x.id === b.dataset.wago); if (!c) return;
        const n = num(c.tel); if (!n) return toast('Numero non valido');
        window.open('https://wa.me/' + n + '?text=' + encodeURIComponent(fill(tpl ?? D.waMsg, D, c.nome)), '_blank');
        sent.add(c.id); paint();
      } else if (b.dataset.wadel) {
        const c = D.contacts.find(x => x.id === b.dataset.wadel);
        if (!c || !confirm('Togliere ' + c.nome + ' dall\'elenco?')) return;
        try { const j = await post({ action: 'contactDel', id: c.id }); if (!j.ok) throw new Error(j.error); D.contacts = j.contacts; paint(); } catch (x) { toast(x.message || 'Errore'); }
      } else if (b.dataset.wa === 'save') {
        if (!/\{uova\}/i.test(ta.value) && !confirm('Nel testo manca {uova}: il numero di uova non comparirà. Salvo lo stesso?')) return;
        try { const j = await post({ action: 'waMsg', testo: ta.value }); if (!j.ok) throw new Error(j.error); D.waMsg = j.waMsg; tpl = null; ta.blur(); paint(); toast('Testo salvato'); } catch (x) { toast(x.message || 'Errore'); }
      } else if (b.dataset.wa === 'reset') { tpl = null; ta.value = D.waMsg || DEF; paint(); }
    });
    $('.add').onsubmit = async e => {
      e.preventDefault(); const f = e.target;
      if (num(f.tel.value).length < 8) return toast('Controlla il numero di telefono');
      try { const j = await post({ action: 'contactSave', nome: f.nome.value.trim(), tel: f.tel.value.trim() }); if (!j.ok) throw new Error(j.error); D.contacts = j.contacts; f.reset(); paint(); toast('Aggiunto'); } catch (x) { toast(x.message || 'Errore'); }
    };
    return { update(d) { D = { available: d.available || 0, contacts: d.contacts || [], waMsg: d.waMsg || DEF }; el.hidden = false; paint(); } };
  };
})();
