/* OviAmo – grafico vendite (pagate) / costi, per anno, mese o periodo.
   Uso: OviChart(elemento, {sales:[{data,euro,uova}], costs:[{data,euro}], loads:[{data,uova}]}) */
(function(){
const MESI = ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'];
const MESI_L = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
const eur = n => (n||0).toLocaleString('it-IT',{style:'currency',currency:'EUR'});
const eur0 = n => Math.round(n).toLocaleString('it-IT') + ' €';
const pad = n => String(n).padStart(2,'0');
const iso = d => d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());

const CSS = `
.oc-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.oc-seg{display:inline-flex;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.oc-seg button{border:0;background:transparent;color:var(--ink);padding:8px 12px;font:500 .88rem Inter,sans-serif;cursor:pointer}
.oc-seg button.on{background:var(--brand);color:#fff}
.oc-bar select,.oc-bar input{width:auto;padding:7px 9px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);font:inherit;font-size:.9rem}
.oc-k{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
@media (max-width:560px){.oc-k{grid-template-columns:repeat(2,1fr)}}
.oc-k div{background:var(--bg);border-radius:12px;padding:8px 10px}
.oc-k small{display:block;color:var(--muted);font-size:.75rem}
.oc-k b{font-family:Fraunces,Georgia,serif;font-size:1.25rem;font-variant-numeric:tabular-nums}
.oc-h small i{font-style:normal;opacity:.75}
.oc-k .pos{color:var(--brand)}.oc-k .neg{color:var(--err)}
.oc-svg{width:100%;height:auto;display:block}
.oc-leg{display:flex;gap:14px;flex-wrap:wrap;font-size:.82rem;color:var(--muted);margin-top:6px}
.oc-leg i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.oc-empty{color:var(--muted);text-align:center;padding:30px 0}`;

window.OviChart = function(el, data){
  if (!document.getElementById('oc-css')){ const s=document.createElement('style'); s.id='oc-css'; s.textContent=CSS; document.head.appendChild(s); }
  const D = { sales: data.sales||[], costs: data.costs||[], loads: data.loads||[], hens: data.hens||[] };
  const all = [...D.sales, ...D.costs, ...D.loads].map(x=>String(x.data||'').slice(0,10)).filter(Boolean);
  const now = new Date(), thisY = now.getFullYear();
  const years = [...new Set(all.map(d=>+d.slice(0,4)).concat(thisY))].sort((a,b)=>b-a);
  const st = { mode:'anno', y:thisY, m:now.getMonth()+1, from:iso(new Date(thisY,0,1)), to:iso(now) };

  el.innerHTML = `
    <div class="oc-bar">
      <div class="oc-seg"><button data-m="anno" class="on">Anno</button><button data-m="mese">Mese</button><button data-m="periodo">Periodo</button></div>
      <select class="oc-y" aria-label="Anno">${years.map(y=>`<option>${y}</option>`).join('')}</select>
      <select class="oc-m" aria-label="Mese" hidden>${MESI_L.map((m,i)=>`<option value="${i+1}">${m}</option>`).join('')}</select>
      <span class="oc-p" hidden><input type="date" class="oc-from" aria-label="Dal"> → <input type="date" class="oc-to" aria-label="Al"></span>
    </div>
    <div class="oc-k"></div>
    <div class="oc-k oc-h"></div>
    <div class="oc-plot"></div>
    <div class="oc-leg"><span><i style="background:var(--brand-2)"></i>Vendite incassate</span><span><i style="background:#d9822b"></i>Costi</span><span><i style="background:var(--yolk);height:3px"></i>Margine cumulato</span></div>`;
  const q = s => el.querySelector(s);
  q('.oc-y').value = st.y; q('.oc-m').value = st.m; q('.oc-from').value = st.from; q('.oc-to').value = st.to;
  q('.oc-seg').onclick = e => { const b=e.target.closest('button'); if(!b) return; st.mode=b.dataset.m;
    el.querySelectorAll('.oc-seg button').forEach(x=>x.classList.toggle('on',x===b)); draw(); };
  q('.oc-y').onchange = e => { st.y=+e.target.value; draw(); };
  q('.oc-m').onchange = e => { st.m=+e.target.value; draw(); };
  q('.oc-from').onchange = e => { st.from=e.target.value; draw(); };
  q('.oc-to').onchange = e => { st.to=e.target.value; draw(); };

  function range(){
    if (st.mode==='anno') return [st.y+'-01-01', st.y+'-12-31', 'mese'];
    if (st.mode==='mese'){ const last=new Date(st.y,st.m,0).getDate(); return [`${st.y}-${pad(st.m)}-01`, `${st.y}-${pad(st.m)}-${pad(last)}`, 'giorno']; }
    let a=st.from||'2000-01-01', b=st.to||iso(now); if (a>b) [a,b]=[b,a];
    const days = (new Date(b)-new Date(a))/864e5;
    return [a, b, days>92 ? 'mese' : days>31 ? 'settimana' : 'giorno'];
  }
  function buckets(a, b, unit){
    const out=[]; let d=new Date(a+'T12:00:00'); const end=new Date(b+'T12:00:00');
    if (unit==='mese'){ d.setDate(1); while(d<=end){ out.push({k:d.getFullYear()+'-'+pad(d.getMonth()+1), l:MESI[d.getMonth()]+(st.mode==='periodo'?" '"+String(d.getFullYear()).slice(2):'')}); d.setMonth(d.getMonth()+1); } }
    else if (unit==='settimana'){ while(d<=end){ const s=iso(d); out.push({k:s, l:d.getDate()+'/'+(d.getMonth()+1)}); d.setDate(d.getDate()+7); } }
    else { while(d<=end){ out.push({k:iso(d), l:String(d.getDate())}); d.setDate(d.getDate()+1); } }
    return out;
  }
  function keyOf(date, unit, B){
    if (unit==='mese') return date.slice(0,7);
    if (unit==='giorno') return date;
    let k=null; for (const b of B){ if (b.k<=date) k=b.k; else break; } return k;
  }

  function draw(){
    q('.oc-y').hidden = st.mode==='periodo'; q('.oc-m').hidden = st.mode!=='mese'; q('.oc-p').hidden = st.mode!=='periodo';
    const [a,b,unit] = range();
    const inR = x => { const d=String(x.data||'').slice(0,10); return d>=a && d<=b; };
    const S = D.sales.filter(inR), C = D.costs.filter(inR), L = D.loads.filter(inR);
    const sum = (l,f) => l.reduce((t,x)=>t+(+x[f]||0),0);
    const vs = sum(S,'euro'), vc = sum(C,'euro'), m = vs-vc;
    q('.oc-k').innerHTML = `
      <div><small>Vendite incassate</small><b>${eur(vs)}</b></div>
      <div><small>Costi</small><b>${eur(vc)}</b></div>
      <div><small>Margine</small><b class="${m>=0?'pos':'neg'}">${eur(m)}</b></div>
      <div><small>Uova vendute / raccolte</small><b>${sum(S,'uova')} / ${sum(L,'uova')}</b></div>`;

    // galline: media giornaliera nel periodo (ogni aggiornamento vale fino al successivo)
    const HN = [...D.hens].sort((x,y)=>String(x.data).localeCompare(String(y.data)));
    let nd=0, sT=0, sP=0;
    const end = b < iso(now) ? b : iso(now);
    if (HN.length && a <= end) {
      let d = new Date(a+'T12:00:00'), j = -1;
      const e = new Date(end+'T12:00:00');
      while (d <= e) { const k = iso(d); while (j+1 < HN.length && String(HN[j+1].data).slice(0,10) <= k) j++;
        if (j >= 0) { nd++; sT += +HN[j].tot||0; sP += +HN[j].prod||0; } d.setDate(d.getDate()+1); }
    }
    const raccolte = sum(L,'uova'), gt = nd ? sT/nd : 0, gp = nd ? sP/nd : 0;
    const f1 = n => n.toLocaleString('it-IT',{maximumFractionDigits:1});
    const per = (x,y) => y ? eur(x/y) : '–';
    q('.oc-h').hidden = !nd && !raccolte;
    q('.oc-h').innerHTML = nd || raccolte ? `
      <div><small>Galline <i>(media)</i></small><b>${nd?f1(gt)+' / '+f1(gp):'–'}</b><small>totali / in produzione</small></div>
      <div><small>Costo per gallina</small><b>${per(vc,gt)}</b><small>in produzione: ${per(vc,gp)}</small></div>
      <div><small>Uova per gallina in produzione</small><b>${gp?f1(raccolte/gp):'–'}</b><small>nel periodo</small></div>
      <div><small>Costo per uovo raccolto</small><b>${per(vc,raccolte)}</b><small>margine per uovo venduto: ${per(m,sum(S,'uova'))}</small></div>` : '';

    const B = buckets(a,b,unit), idx = {}; B.forEach((x,i)=>{ idx[x.k]=i; x.s=0; x.c=0; });
    S.forEach(x=>{ const k=keyOf(String(x.data).slice(0,10),unit,B); if(k in idx) B[idx[k]].s += +x.euro||0; });
    C.forEach(x=>{ const k=keyOf(String(x.data).slice(0,10),unit,B); if(k in idx) B[idx[k]].c += +x.euro||0; });
    if (!S.length && !C.length){ q('.oc-plot').innerHTML = '<div class="oc-empty">Nessun dato in questo periodo.</div>'; return; }

    const todayK = keyOf(iso(now), unit, B);
    let cum=0; B.forEach(x=>{ cum += x.s-x.c; x.cum = (todayK==null || x.k<=todayK) ? cum : null; });
    const LC = B.filter(x=>x.cum!=null);
    const W = Math.max(320, Math.min(900, el.clientWidth||640)), H = W<500 ? 230 : 260, l=48, r=10, t=12, bt=28, pw=W-l-r, ph=H-t-bt;
    const hi = Math.max(1, ...B.map(x=>Math.max(x.s,x.c)), ...LC.map(x=>x.cum)), lo = Math.min(0, ...LC.map(x=>x.cum));
    const nice = v => { const p=Math.pow(10,Math.floor(Math.log10(v||1))), f=v/p; return (f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10)*p; };
    let step = nice((hi-lo)/4), top = Math.ceil(hi/step)*step, bot = Math.floor(lo/step)*step;
    const nt = Math.round((top-bot)/step);
    const y = v => t + ph - (v-bot)/(top-bot)*ph;
    const bw = pw/B.length, gw = Math.max(2, Math.min(18, bw*.36));
    let g = '';
    for (let i=0;i<=nt;i++){ const v=bot+step*i; g += `<line x1="${l}" x2="${W-r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${l-6}" y="${y(v)+4}" text-anchor="end" font-size="11" fill="var(--muted)">${eur0(v)}</text>`; }
    if (bot<0) g += `<line x1="${l}" x2="${W-r}" y1="${y(0)}" y2="${y(0)}" stroke="var(--muted)"/>`;
    const every = Math.ceil(B.length/Math.max(4, Math.floor(pw/42)));
    B.forEach((x,i)=>{
      const cx = l + bw*i + bw/2;
      const tip = `${x.l}: vendite ${eur(x.s)}, costi ${eur(x.c)}`;
      if (x.s) g += `<rect x="${cx-gw-1}" y="${y(x.s)}" width="${gw}" height="${y(0)-y(x.s)}" rx="2" fill="var(--brand-2)"><title>${tip}</title></rect>`;
      if (x.c) g += `<rect x="${cx+1}" y="${y(x.c)}" width="${gw}" height="${y(0)-y(x.c)}" rx="2" fill="#d9822b"><title>${tip}</title></rect>`;
      if (i%every===0) g += `<text x="${cx}" y="${H-8}" text-anchor="middle" font-size="11" fill="var(--muted)">${x.l}</text>`;
    });
    g += `<polyline fill="none" stroke="var(--yolk)" stroke-width="2.5" stroke-linejoin="round" points="${B.map((x,i)=>x.cum==null?'':`${l+bw*i+bw/2},${y(x.cum)}`).join(' ')}"/>`;
    q('.oc-plot').innerHTML = `<svg class="oc-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Grafico vendite e costi">${g}</svg>`;
  }
  let rw; addEventListener('resize', () => { clearTimeout(rw); rw = setTimeout(draw, 200); });
  draw();
  return { update(d){ Object.assign(D, d); draw(); } };
};
})();
