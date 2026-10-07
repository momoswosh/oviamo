/**
 * OviAmo – motore su Cloudflare (Pages Function + database D1)
 * Indirizzo: /api   (GET ?action=info|report|area, POST con JSON)
 * Segreti da impostare in Cloudflare (Settings > Variables and Secrets):
 *   MASTER_KEY      = password del report
 *   TELEGRAM_TOKEN  = token del bot Telegram per gli avvisi (facoltativo)
 * La chat Telegram a cui scrivere si collega dal report (azione 'tgLink'): scrivi al bot, poi collega.
 */

const SITE = 'https://oviamo.boneggio.it';
const SATISPAY_PHONE = '+393931609967';
const TZ = 'Europe/Rome';
const PRICE_1 = 0.5;     // un uovo
const PRICE_6 = 3;       // confezione da 6
const DEFAULT_MSG = 'Al momento le uova sono finite. Appena le galline ne fanno altre vi avviseremo. Grazie!';

/* ---------- utilità ---------- */

const json = o => new Response(JSON.stringify(o), {
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }
});
const romeParts = () => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
const now_ = () => romeParts().slice(0, 16);          // yyyy-MM-dd HH:mm
const today_ = () => romeParts().slice(0, 10);        // yyyy-MM-dd
const newId = p => p + crypto.randomUUID().replace(/-/g, '').slice(0, 9);
const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dIt = ymd => new Date(ymd + 'T12:00:00Z').toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' });
// uova impegnate = solo le prenotazioni confermate (le richieste "in attesa" o "rifiutate" non contano)
const BOOKED = "(SELECT COALESCE(SUM(uova),0) FROM orders WHERE COALESCE(stato,'ok') = 'ok')";
const LOADED = '(SELECT COALESCE(SUM(uova),0) FROM loads)';
const REMIND_DAYS = 3;   // promemoria Telegram per le richieste da confermare
const WA_MSG = 'Ciao, se vuoi ci sono {uova} uova disponibili';   // testo predefinito "Avvisa su WhatsApp"
const all = async (db, sql, ...b) => (await db.prepare(sql).bind(...b).all()).results;

/* ---------- dati ---------- */

const orders_ = async db => (await all(db, 'SELECT * FROM orders ORDER BY data')).map(r => ({
  id: r.id, data: r.data, nome: r.nome, cognome: r.cognome, telefono: r.telefono || '',
  q1: r.q1, q6: r.q6, uova: r.uova, euro: r.euro, note: r.note || '',
  pagato: !!r.pagato, consegnato: !!r.consegnato, dataPag: r.data_pag || '', metodo: r.metodo || '', perIl: r.per_il || '',
  stato: r.stato || 'ok'
}));
const loads_ = db => all(db, 'SELECT id, data, uova, utente, note, ins FROM loads ORDER BY data, ins');
const costs_ = db => all(db, 'SELECT id, data, descr, euro, utente, ins, qta, unita FROM costs ORDER BY data, ins');
const hens_ = db => all(db, 'SELECT id, data, tot, prod, utente, note, ins FROM hens ORDER BY data, ins');
const users_ = db => all(db, 'SELECT tk, nome, ruolo, creato FROM users ORDER BY creato, nome');
async function userByToken(db, tk) {
  tk = String(tk || '');
  return tk.length >= 10 ? await db.prepare('SELECT tk, nome, ruolo FROM users WHERE tk = ?').bind(tk).first() : null;
}
async function available_(db) {
  const r = await db.prepare(`SELECT ${LOADED} - ${BOOKED} AS n`).first();
  return Math.max(0, r.n || 0);
}
async function settings_(db) {
  const s = {}; (await all(db, 'SELECT k, v FROM settings')).forEach(r => s[r.k] = r.v);
  return { open: s.open !== '0', msg: s.msg || '' };
}
const contacts_ = db => all(db, 'SELECT id, nome, tel FROM contacts ORDER BY nome COLLATE NOCASE');
async function waMsg_(db) {
  const r = await db.prepare("SELECT v FROM settings WHERE k = 'wa_msg'").first();
  return (r && r.v) || WA_MSG;
}

/* ---------- avvisi (Telegram) ---------- */

const tgApi = (env, method, body) => fetch('https://api.telegram.org/bot' + env.TELEGRAM_TOKEN + '/' + method, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
}).then(r => r.json());

async function telegram(env, db, text) {
  if (!env.TELEGRAM_TOKEN) return false;
  const c = await db.prepare("SELECT v FROM settings WHERE k = 'tg_chat'").first();
  if (!c || !c.v) return false;
  try {
    let r = await tgApi(env, 'sendMessage', { chat_id: c.v, text, disable_web_page_preview: true });
    const nuovo = r.parameters && r.parameters.migrate_to_chat_id;   // il gruppo è diventato "supergruppo": nuovo id
    if (!r.ok && nuovo) {
      await db.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('tg_chat', ?)").bind(String(nuovo)).run();
      r = await tgApi(env, 'sendMessage', { chat_id: nuovo, text, disable_web_page_preview: true });
    }
    return r.ok;
  }
  catch (err) { return false; }
}

/** Promemoria: richieste in attesa con data entro REMIND_DAYS giorni (controllo al massimo una volta l'ora) */
async function remind_(env, db) {
  if (!env.TELEGRAM_TOKEN) return;
  const now = Date.now(), last = await db.prepare("SELECT v FROM settings WHERE k = 'last_remind'").first();
  if (last && now - (+last.v || 0) < 3600e3) return;
  await db.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('last_remind', ?)").bind(String(now)).run();
  const L = await all(db, "SELECT id, nome, cognome, telefono, uova, per_il FROM orders WHERE stato = 'attesa' AND COALESCE(ricordato,0) = 0 AND per_il <> '' AND per_il <= ? ORDER BY per_il", addDays(today_(), REMIND_DAYS));
  if (!L.length) return;
  const ok = await telegram(env, db, '⏰ OviAmo – richieste da confermare\n' +
    L.map(o => '• ' + dIt(o.per_il) + ': ' + o.nome + ' ' + o.cognome + ', ' + o.uova + ' uova' + (o.telefono ? ' (' + o.telefono + ')' : '')).join('\n') +
    '\nUova disponibili ora: ' + await available_(db) + '\n' + SITE + '/report.html');
  if (ok) await db.prepare(`UPDATE orders SET ricordato = 1 WHERE id IN (${L.map(() => '?').join(',')})`).bind(...L.map(o => o.id)).run();
}

/** Collega la chat: prende l'ultima persona che ha scritto al bot e le manda una conferma */
async function tgLink_(db, env) {
  if (!env.TELEGRAM_TOKEN) return json({ ok: false, error: 'Manca il segreto TELEGRAM_TOKEN su Cloudflare' });
  const up = await tgApi(env, 'getUpdates', { limit: 100 });
  if (!up.ok) return json({ ok: false, error: 'Telegram: ' + (up.description || 'token non valido') });
  const msgs = (up.result || []).map(u => u.message || u.edited_message || u.my_chat_member).filter(m => m && m.chat && !(m.new_chat_member && m.new_chat_member.status === 'left'));
  if (!msgs.length) return json({ ok: false, error: 'Scrivi prima un messaggio al bot su Telegram (es. "ciao"), poi riprova.' });
  const chat = msgs[msgs.length - 1].chat;
  await db.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('tg_chat', ?)").bind(String(chat.id)).run();
  const sent = await tgApi(env, 'sendMessage', { chat_id: chat.id, text: '🥚 OviAmo collegato! ' + (chat.type === 'private' ? 'Qui riceverai' : 'In questo gruppo arriverà') + ' un messaggio per ogni nuova prenotazione e richiesta.' });
  return json({ ok: !!sent.ok, chat: chat.first_name || chat.title || '', error: sent.ok ? undefined : sent.description });
}

/* ---------- GET ---------- */

export async function onRequestGet({ request, env, waitUntil }) {
  const db = env.DB, p = Object.fromEntries(new URL(request.url).searchParams);
  waitUntil(remind_(env, db).catch(() => {}));
  if (p.action === 'info') {
    const s = await settings_(db), left = await available_(db);
    return json({ ok: true, open: s.open && left > 0, closedByHand: !s.open, available: left, msg: s.msg || DEFAULT_MSG, price1: PRICE_1, price6: PRICE_6, minData: addDays(today_(), 1) });
  }
  if (p.action === 'report') {
    if (!env.MASTER_KEY || p.key !== env.MASTER_KEY) return json({ ok: false, error: 'Password errata' });
    const [orders, loads, costs, hens, users, settings, available, contacts, waMsg] = await Promise.all([orders_(db), loads_(db), costs_(db), hens_(db), users_(db), settings_(db), available_(db), contacts_(db), waMsg_(db)]);
    return json({ ok: true, orders, loads, costs, hens, users, settings, available, contacts, waMsg });
  }
  if (p.action === 'area') {
    const u = await userByToken(db, p.t);
    if (!u) return json({ ok: false, error: 'Link non valido. Chiedi un nuovo link a chi gestisce OviAmo.' });
    const out = { ok: true, nome: u.nome, ruolo: u.ruolo, available: await available_(db), contacts: await contacts_(db), waMsg: await waMsg_(db) };
    const loads = await loads_(db);
    if (u.ruolo === 'intermedio') {
      out.loads = loads; out.costs = await costs_(db); out.hens = await hens_(db);
      const ord = await orders_(db);
      out.orders = ord;
      out.sales = ord.filter(o => o.pagato).map(o => ({ data: o.dataPag || o.data.slice(0, 10), euro: o.euro, uova: o.uova }));
    } else {
      out.loads = loads.filter(l => l.utente === u.nome);
    }
    return json(out);
  }
  return json({ ok: true, service: 'oviamo' });
}

/* ---------- POST ---------- */

export async function onRequestPost({ request, env, waitUntil }) {
  const db = env.DB, ctx = { waitUntil };
  try {
    const d = JSON.parse(await request.text() || '{}');
    if (!d.action) return await order_(db, env, ctx, d);

    const master = !!env.MASTER_KEY && d.key === env.MASTER_KEY;
    const u = master ? { nome: 'Master', ruolo: 'master' } : await userByToken(db, d.t);
    if (!u) return json({ ok: false, error: 'Accesso non valido' });
    const canCost = master || u.ruolo === 'intermedio';

    switch (d.action) {
      case 'load': return await addLoad_(db, d, u);
      case 'cost': if (!canCost) break; return await addCost_(db, d, u);
      case 'delLoad': return await delEntry_(db, 'loads', d.id, u, master);
      case 'delCost': if (!canCost) break; return await delEntry_(db, 'costs', d.id, u, master);
      case 'hens': if (!canCost) break; return await addHens_(db, d, u);
      case 'delHens': if (!canCost) break; return await delEntry_(db, 'hens', d.id, u, master);
      case 'flag': if (!canCost) break; return await flag_(db, d);
      case 'contactSave': return await contactSave_(db, d);
      case 'contactDel': await db.prepare('DELETE FROM contacts WHERE id = ?').bind(String(d.id)).run(); return json({ ok: true, contacts: await contacts_(db) });
      case 'waMsg': {
        const t = clean(d.testo, 500);
        await db.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('wa_msg', ?)").bind(t).run();
        return json({ ok: true, waMsg: t || WA_MSG });
      }
    }
    if (!master) return json({ ok: false, error: 'Operazione non consentita' });
    switch (d.action) {
      case 'delOrders': return await delOrders_(db, d);
      case 'settings': return await saveSettings_(db, d);
      case 'userSave': return await userSave_(db, d);
      case 'decide': return await decide_(db, d);
      case 'tgLink': return await tgLink_(db, env);
      case 'tgTest': return json({ ok: await telegram(env, db, '🥚 OviAmo: messaggio di prova.') });
      case 'userDelete': await db.prepare('DELETE FROM users WHERE tk = ?').bind(String(d.tk)).run(); return json({ ok: true, users: await users_(db) });
    }
    return json({ ok: false, error: 'Azione sconosciuta' });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

export function onRequestOptions() {
  return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
}

async function order_(db, env, ctx, d) {
  const rid = d.rid ? 'rid:' + String(d.rid).slice(0, 64) : '';
  if (rid) {   // stesso invio ripetuto: restituisco la risposta di prima
    const prev = await db.prepare('SELECT res FROM idem WHERE rid = ?').bind(rid).first();
    if (prev) return json(JSON.parse(prev.res));
  }
  const s = await settings_(db), left = await available_(db);
  if (d.tipo === 'data') return await request_(db, env, d, rid);
  if (!s.open || left <= 0) return json({ ok: false, closed: true, error: s.msg || DEFAULT_MSG });

  const nome = clean(d.nome, 60), cognome = clean(d.cognome, 60);
  if (!nome || !cognome) return json({ ok: false, error: 'Nome e cognome obbligatori' });
  const q1 = Math.max(0, Math.min(99, parseInt(d.q1, 10) || 0));
  const q6 = Math.max(0, Math.min(50, parseInt(d.q6, 10) || 0));
  const uova = q1 + 6 * q6;
  if (!uova) return json({ ok: false, error: 'Scegli almeno un uovo' });
  if (uova > left) return json({ ok: false, error: 'Sono rimaste solo ' + left + ' uova disponibili.' });
  const euro = Math.round((q1 * PRICE_1 + q6 * PRICE_6) * 100) / 100;
  const perIl = '';   // le prenotazioni "subito" non hanno data: per una data si usa la richiesta
  const telefono = clean(d.telefono, 30), note = clean(d.note, 500);

  // inserisce solo se le uova bastano ancora (evita di prenotare due volte le stesse)
  const r = await db.prepare(`INSERT INTO orders (id, data, nome, cognome, telefono, q1, q6, uova, euro, note, per_il)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE ${LOADED} - ${BOOKED} >= ?`)
    .bind(newId('p'), now_(), nome, cognome, telefono, q1, q6, uova, euro, note, perIl, uova).run();
  if (!r.meta.changes) {
    const l2 = await available_(db);
    return json({ ok: false, error: l2 > 0 ? 'Sono rimaste solo ' + l2 + ' uova disponibili.' : (s.msg || DEFAULT_MSG), closed: l2 <= 0 });
  }
  const res = { ok: true, uova, euro, left: left - uova, satispay: SATISPAY_PHONE, perIl };
  if (rid) await db.prepare('INSERT OR REPLACE INTO idem (rid, res, ts) VALUES (?, ?, ?)').bind(rid, JSON.stringify(res), Date.now()).run();

  await telegram(env, db, '🥚 OviAmo – nuova prenotazione\n' + nome + ' ' + cognome + ': ' + (uova === 1 ? '1 uovo' : uova + ' uova') + '\n' +
    (q6 ? q6 + ' confezioni da 6' + (q1 ? ' + ' + q1 + ' singole' : '') : q1 + ' singole') +
    ' · ' + euro.toFixed(2).replace('.', ',') + ' €' +
    (perIl ? '\nPer il: ' + perIl.split('-').reverse().join('/') : '') +
    (telefono ? '\nTel: ' + telefono : '') +
    (note ? '\nNote: ' + note : '') +
    '\nUova ancora disponibili: ' + (left - uova) + '\n' + SITE + '/report.html');
  return json(res);
}

/** Richiesta per una data futura: non impegna le uova, resta "in attesa" finché il gestore non conferma */
async function request_(db, env, d, rid) {
  const nome = clean(d.nome, 60), cognome = clean(d.cognome, 60), telefono = clean(d.telefono, 30), note = clean(d.note, 500);
  if (!nome || !cognome) return json({ ok: false, error: 'Nome e cognome obbligatori' });
  if (telefono.replace(/\D/g, '').length < 6) return json({ ok: false, error: 'Per le richieste con data serve il telefono: ti scriviamo per la conferma.' });
  const minData = addDays(today_(), 1);
  if (!isDate(d.perIl) || d.perIl < minData) return json({ ok: false, error: 'Scegli una data da domani in poi.' });
  if (d.perIl > addDays(today_(), 90)) return json({ ok: false, error: 'Puoi chiedere al massimo per i prossimi 3 mesi.' });
  const q1 = Math.max(0, Math.min(99, parseInt(d.q1, 10) || 0));
  const q6 = Math.max(0, Math.min(50, parseInt(d.q6, 10) || 0));
  const uova = q1 + 6 * q6;
  if (!uova) return json({ ok: false, error: 'Scegli almeno un uovo' });
  const euro = Math.round((q1 * PRICE_1 + q6 * PRICE_6) * 100) / 100;
  await db.prepare(`INSERT INTO orders (id, data, nome, cognome, telefono, q1, q6, uova, euro, note, per_il, stato) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'attesa')`)
    .bind(newId('p'), now_(), nome, cognome, telefono, q1, q6, uova, euro, note, d.perIl).run();
  const res = { ok: true, richiesta: true, uova, euro, perIl: d.perIl };
  if (rid) await db.prepare('INSERT OR REPLACE INTO idem (rid, res, ts) VALUES (?, ?, ?)').bind(rid, JSON.stringify(res), Date.now()).run();
  await telegram(env, db, '📅 OviAmo – nuova richiesta da confermare\n' + nome + ' ' + cognome + ': ' + (uova === 1 ? '1 uovo' : uova + ' uova') +
    ' per ' + dIt(d.perIl) + '\nTel: ' + telefono + (note ? '\nNote: ' + note : '') +
    '\nUova disponibili ora: ' + await available_(db) + '\n' + SITE + '/report.html');
  return json(res);
}

/** Conferma (stato 'ok', impegna le uova se bastano), rifiuta o rimette in attesa una richiesta */
async function decide_(db, d) {
  const id = String(d.id || ''), v = d.value;
  if (!['ok', 'rifiutata', 'attesa'].includes(v)) return json({ ok: false, error: 'Valore non valido' });
  let r;
  if (v === 'ok') {
    r = await db.prepare(`UPDATE orders SET stato = 'ok' WHERE id = ? AND stato <> 'ok' AND ${LOADED} - ${BOOKED} >= uova`).bind(id).run();
    if (!r.meta.changes) {
      const o = await db.prepare('SELECT uova, stato FROM orders WHERE id = ?').bind(id).first();
      if (!o) return json({ ok: false, error: 'Richiesta non trovata' });
      if (o.stato === 'ok') return json({ ok: true, already: true });
      return json({ ok: false, error: 'Uova insufficienti: ne servono ' + o.uova + ', disponibili ' + await available_(db) + '. Carica prima le uova.' });
    }
  } else {
    r = await db.prepare('UPDATE orders SET stato = ? WHERE id = ?').bind(v, id).run();
    if (!r.meta.changes) return json({ ok: false, error: 'Richiesta non trovata' });
  }
  return json({ ok: true, available: await available_(db) });
}

async function addLoad_(db, d, u) {
  const n = parseInt(d.uova, 10) || 0;
  if (!n || (n < 0 && u.ruolo !== 'master')) return json({ ok: false, error: 'Numero di uova non valido' });
  if (Math.abs(n) > 5000) return json({ ok: false, error: 'Numero troppo grande' });
  const data = isDate(d.data) ? d.data : today_();
  await db.prepare('INSERT INTO loads (id, data, uova, utente, note, ins) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(newId('c'), data, n, u.nome, clean(d.note, 200), now_()).run();
  return json({ ok: true, available: await available_(db) });
}

async function addCost_(db, d, u) {
  const imp = Math.round((parseFloat(String(d.importo).replace(',', '.')) || 0) * 100) / 100;
  const descr = clean(d.descr, 120);
  if (!imp || imp < 0) return json({ ok: false, error: 'Importo non valido' });
  if (!descr) return json({ ok: false, error: 'Scrivi una descrizione (es. mangime 25 kg)' });
  const data = isDate(d.data) ? d.data : today_();
  const qta = Math.round((parseFloat(String(d.qta || '').replace(',', '.')) || 0) * 1000) / 1000;
  if (qta < 0 || qta > 100000) return json({ ok: false, error: 'Quantità non valida' });
  const unita = qta ? (['kg', 'pz', 'l'].indexOf(d.unita) >= 0 ? d.unita : 'kg') : '';
  await db.prepare('INSERT INTO costs (id, data, descr, euro, utente, ins, qta, unita) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(newId('k'), data, descr, imp, u.nome, now_(), qta, unita).run();
  return json({ ok: true });
}

async function addHens_(db, d, u) {
  const tot = parseInt(d.tot, 10), prod = parseInt(d.prod, 10);
  if (!(tot >= 0) || !(prod >= 0) || tot > 10000) return json({ ok: false, error: 'Numero di galline non valido' });
  if (prod > tot) return json({ ok: false, error: 'Le galline in produzione non possono essere più del totale' });
  const data = isDate(d.data) ? d.data : today_();
  await db.prepare('INSERT INTO hens (id, data, tot, prod, utente, note, ins) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(newId('g'), data, tot, prod, u.nome, clean(d.note, 200), now_()).run();
  return json({ ok: true, hens: await hens_(db) });
}

/** Cancella un carico, un costo o un dato galline: il master tutto, gli altri solo quello che hanno inserito loro */
async function delEntry_(db, table, id, u, master) {
  if (!master) {
    const it = await db.prepare(`SELECT utente FROM ${table} WHERE id = ?`).bind(String(id)).first();
    if (!it || it.utente !== u.nome) return json({ ok: false, error: 'Puoi cancellare solo quello che hai inserito tu' });
  }
  const r = await db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(String(id)).run();
  return json({ ok: r.meta.changes > 0, available: await available_(db) });
}

async function flag_(db, d) {
  const field = d.field === 'pagato' ? 'pagato' : d.field === 'consegnato' ? 'consegnato' : '';
  if (!field) return json({ ok: false, error: 'Campo non valido' });
  const ids = (d.ids || []).map(String);
  if (!ids.length) return json({ ok: true, updated: 0 });
  const v = d.value === true ? 1 : 0, marks = ids.map(() => '?').join(',');
  let r;
  if (field === 'pagato') {
    const metodo = d.metodo === 'satispay' || d.metodo === 'contanti' ? d.metodo : '';
    r = await db.prepare(`UPDATE orders SET pagato = ?, data_pag = ?, metodo = ? WHERE id IN (${marks})`)
      .bind(v, v ? today_() : '', v ? metodo : '', ...ids).run();
  } else {
    r = await db.prepare(`UPDATE orders SET consegnato = ? WHERE id IN (${marks})`).bind(v, ...ids).run();
  }
  return json({ ok: true, updated: r.meta.changes });
}

async function delOrders_(db, d) {
  const ids = (d.ids || []).map(String);
  if (!ids.length) return json({ ok: true, deleted: 0 });
  const r = await db.prepare(`DELETE FROM orders WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
  return json({ ok: true, deleted: r.meta.changes });
}

async function saveSettings_(db, d) {
  const st = [];
  if ('open' in d) st.push(db.prepare('INSERT OR REPLACE INTO settings (k, v) VALUES (?, ?)').bind('open', d.open ? '1' : '0'));
  if ('msg' in d) st.push(db.prepare('INSERT OR REPLACE INTO settings (k, v) VALUES (?, ?)').bind('msg', clean(d.msg, 300)));
  if (st.length) await db.batch(st);
  return json({ ok: true, settings: await settings_(db) });
}

/** Aggiunge o modifica un utente: d.tk vuoto = nuovo; d.nome, d.ruolo ('intermedio'|'caricatore') */
async function userSave_(db, d) {
  const nome = clean(d.nome, 60), ruolo = d.ruolo === 'intermedio' ? 'intermedio' : 'caricatore';
  if (!nome) return json({ ok: false, error: 'Nome obbligatorio' });
  const list = await users_(db);
  if (list.some(x => x.nome.toLowerCase() === nome.toLowerCase() && x.tk !== d.tk)) return json({ ok: false, error: 'Esiste già un utente con questo nome' });
  if (d.tk) {
    const r = await db.prepare('UPDATE users SET nome = ?, ruolo = ? WHERE tk = ?').bind(nome, ruolo, String(d.tk)).run();
    if (!r.meta.changes) return json({ ok: false, error: 'Utente non trovato' });
  } else {
    await db.prepare('INSERT INTO users (tk, nome, ruolo, creato) VALUES (?, ?, ?, ?)')
      .bind(crypto.randomUUID().replace(/-/g, '').slice(0, 16), nome, ruolo, today_()).run();
  }
  return json({ ok: true, users: await users_(db) });
}

/** Rubrica "Avvisa su WhatsApp": aggiunge (o aggiorna, se d.id) una persona */
async function contactSave_(db, d) {
  const nome = clean(d.nome, 60), tel = clean(d.tel, 30);
  if (!nome) return json({ ok: false, error: 'Scrivi il nome' });
  if (tel.replace(/\D/g, '').length < 8) return json({ ok: false, error: 'Controlla il numero di telefono' });
  if (d.id) await db.prepare('UPDATE contacts SET nome = ?, tel = ? WHERE id = ?').bind(nome, tel, String(d.id)).run();
  else await db.prepare('INSERT INTO contacts (id, nome, tel) VALUES (?, ?, ?)').bind(newId('r'), nome, tel).run();
  return json({ ok: true, contacts: await contacts_(db) });
}
