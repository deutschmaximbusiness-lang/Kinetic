'use strict';

/* =========================================================
   Kinetic – Gewichts- und Einnahme-Tracker (PWA, nur iPhone)
   Alle Daten bleiben lokal auf dem Gerät (IndexedDB).
   ========================================================= */

const PHASES = ['Vor Reta', 'Während Reta', 'Nach Reta', 'Vor Cut', 'Nach Cut', 'Bulk'];
const DEFAULT_STATE = {
  v: 1,
  onboarded: false,
  name: '',
  goal: 'lose',            // lose | gain | hold
  startWeight: null,
  targetWeight: null,
  doseTracking: true,
  schedule: 2,             // Einnahmen pro Woche
  compound: 'Retatrutid',
  weights: {},             // { 'YYYY-MM-DD': kg }
  doses: [],               // { id, date, mg, note }
  studies: [],             // { id, title, url, population, summary }
  notes: [],               // { id, date, text }
  compare: { before: null, after: null }
};

let S = structuredClone(DEFAULT_STATE);
let photos = [];           // { id, date, phase, blob, url }
const ui = { tab: 'heute', range: '12', phase: 'Alle', wissen: 'studien', sel: null, sheet: null, ob: { goal: 'lose', dose: true }, share: { photos: false, compound: false } };

/* ---------- Speicher (IndexedDB) ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('kinetic', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' });
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  store(name, mode) { return this.db.transaction(name, mode).objectStore(name); },
  wrap(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  get(k) { return this.wrap(this.store('kv', 'readonly').get(k)); },
  set(k, v) { return this.wrap(this.store('kv', 'readwrite').put(v, k)); },
  photos() { return this.wrap(this.store('photos', 'readonly').getAll()); },
  putPhoto(p) { return this.wrap(this.store('photos', 'readwrite').put(p)); },
  delPhoto(id) { return this.wrap(this.store('photos', 'readwrite').delete(id)); },
  clearPhotos() { return this.wrap(this.store('photos', 'readwrite').clear()); }
};
const save = () => DB.set('state', S).catch(() => toast('Speichern fehlgeschlagen'));

/* ---------- Helfer ---------- */
const DAY = 864e5;
const pad = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = () => iso(new Date());
const toDate = s => new Date(s + 'T12:00:00');
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY);
const addDays = (s, n) => { const d = toDate(s); d.setDate(d.getDate() + n); return iso(d); };
const weekStart = s => { const d = toDate(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); };
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.').trim()); return Number.isFinite(n) ? n : null; };
const f1 = n => n.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmg = n => n.toLocaleString('de-DE', { maximumFractionDigits: 2 });
const signed = n => (n > 0.04 ? '+' : n < -0.04 ? '−' : '±') + f1(Math.abs(n));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortDate = s => toDate(s).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
const longDate = s => toDate(s).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const val = id => document.getElementById(id)?.value ?? '';

function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1900);
}
function haptic() { try { navigator.vibrate?.(8); } catch (e) { /* iOS ignoriert das */ } }

/* ---------- Icons ---------- */
const I = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-8 9 8v10h-6v-6H9v6H3z"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l5-6 4 3 8-9"/><path d="M3 21h18"/></svg>',
  drop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/></svg>',
  cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="3"/><circle cx="12" cy="13.5" r="3.5"/><path d="M8 7l1.5-3h5L16 7"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2z"/><path d="M4 20a2 2 0 0 0 2 1h13v-3"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v13M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l4 4 10-10"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="16" height="16"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  eq: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 9h14M5 15h14"/></svg>',
  logo: '<svg viewBox="0 0 120 120" aria-hidden="true"><g transform="translate(14 0) skewX(-10)"><rect x="14" y="72" width="16" height="28" rx="4" fill="#fff" fill-opacity=".9"/><rect x="38" y="56" width="16" height="44" rx="4" fill="#fff" fill-opacity=".9"/><rect x="62" y="38" width="16" height="62" rx="4" fill="#fff" fill-opacity=".9"/><rect x="86" y="18" width="16" height="82" rx="4" fill="#3DDC97"/></g></svg>'
};
const brand = () => `<div class="brand">${I.logo}<span>kinetic<span class="lime">.</span></span></div>`;

/* ---------- Berechnungen ---------- */
function series() {
  const e = Object.entries(S.weights).map(([date, kg]) => ({ date, kg })).sort((a, b) => (a.date < b.date ? -1 : 1));
  e.forEach((p, i) => {
    let sum = 0, n = 0;
    for (let j = i; j >= 0; j--) { if (daysBetween(e[j].date, p.date) > 6) break; sum += e[j].kg; n++; }
    p.avg = sum / n;                       // 7-Tage-Schnitt
  });
  return e;
}
function metrics() {
  const e = series();
  if (!e.length) return null;
  const first = e[0], last = e[e.length - 1];
  const start = S.startWeight ?? first.kg;
  const cur = last.avg;
  const change = cur - start;
  const days = daysBetween(first.date, last.date);
  return {
    e, first, last, start, cur, change, days,
    pct: change / start * 100,
    perWeek: days >= 7 ? change / (days / 7) : null,
    toGoal: S.targetWeight != null ? S.targetWeight - cur : null
  };
}
function periodLabel(days) {
  if (days <= 0) return 'Tag 1';
  if (days < 14) return `${days} ${days === 1 ? 'Tag' : 'Tage'}`;
  return `${Math.round(days / 7)} Wochen`;
}

/* ---------- Chart (SVG) ---------- */
function smoothPath(p) {
  if (p.length < 2) return '';
  let d = `M${p[0][0].toFixed(1)},${p[0][1].toFixed(1)}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}
let chartXs = [];
function chartSVG(e, { w = 390, h = 320, sel = null, mini = false, id = 'c' } = {}) {
  if (!e.length) return '<div class="empty">Noch keine Einträge</div>';
  const padL = mini ? 6 : 20, padR = mini ? 10 : 28, padT = mini ? 14 : 62, padB = mini ? 10 : 36;
  const t0 = toDate(e[0].date).getTime(), t1 = toDate(e[e.length - 1].date).getTime();
  const span = Math.max(t1 - t0, DAY);
  const target = S.targetWeight;
  const vals = e.flatMap(p => [p.kg, p.avg]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (!mini && target != null && target > lo - (hi - lo + 2) && target < hi + (hi - lo + 2)) { lo = Math.min(lo, target); hi = Math.max(hi, target); }
  const m = Math.max((hi - lo) * .12, .6); lo -= m; hi += m;
  const X = d => padL + (e.length === 1 ? (w - padL - padR) / 2 : (toDate(d).getTime() - t0) / span * (w - padL - padR));
  const Y = v => padT + (hi - v) / (hi - lo) * (h - padT - padB);
  const pts = e.map(p => [X(p.date), Y(p.avg)]);
  chartXs = pts.map(p => p[0]);
  const line = smoothPath(pts);
  const bottom = h - padB;
  const last = pts[pts.length - 1];
  const area = line ? `${line} L${last[0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z` : '';
  const r = e.length > 90 ? 1.8 : 2.6;
  const dots = e.map(p => `<circle cx="${X(p.date).toFixed(1)}" cy="${Y(p.kg).toFixed(1)}" r="${r}"/>`).join('');

  let goal = '';
  if (!mini && target != null && target > lo && target < hi) {
    const gy = Y(target).toFixed(1);
    goal = `<line x1="0" y1="${gy}" x2="${w}" y2="${gy}" stroke="#3DDC97" stroke-opacity=".45" stroke-dasharray="3 6"/>
      <text x="${padL}" y="${(+gy - 8).toFixed(1)}" font-size="11" font-weight="600" fill="#3DDC97" fill-opacity=".85">ZIEL ${esc(f1(target))} KG</text>`;
  }

  const i = sel == null ? e.length - 1 : sel;
  const sp = pts[i], se = e[i];
  let marker = `<circle cx="${sp[0].toFixed(1)}" cy="${sp[1].toFixed(1)}" r="${mini ? 9 : 12}" fill="#3DDC97" fill-opacity=".22"/><circle cx="${sp[0].toFixed(1)}" cy="${sp[1].toFixed(1)}" r="${mini ? 4.5 : 6}" fill="#3DDC97"/>`;
  if (!mini) {
    const txt = `${shortDate(se.date)} · ${f1(se.kg)} kg`;
    const pw = txt.length * 7.3 + 26, ph = 34;
    const px = Math.min(Math.max(sp[0] - pw / 2, 6), w - pw - 6);
    const py = Math.max(sp[1] - 66, 6);
    marker = `<line x1="${sp[0].toFixed(1)}" y1="${(py + ph).toFixed(1)}" x2="${sp[0].toFixed(1)}" y2="${sp[1].toFixed(1)}" stroke="#fff" stroke-opacity=".4" stroke-dasharray="2 4"/>` + marker +
      `<rect x="${px.toFixed(1)}" y="${py.toFixed(1)}" width="${pw.toFixed(1)}" height="${ph}" rx="17" fill="#fff"/>
       <text x="${(px + pw / 2).toFixed(1)}" y="${(py + 22).toFixed(1)}" text-anchor="middle" font-size="13" font-weight="700" fill="#0E1014">${esc(txt)}</text>`;
  }

  let axis = '';
  if (!mini && e.length > 1) {
    const n = 4;
    for (let k = 0; k < n; k++) {
      const t = t0 + span * k / (n - 1);
      const x = padL + (t - t0) / span * (w - padL - padR);
      const anchor = k === 0 ? 'start' : k === n - 1 ? 'end' : 'middle';
      axis += `<text x="${x.toFixed(1)}" y="${h - 10}" text-anchor="${anchor}">${esc(shortDate(iso(new Date(t))))}</text>`;
    }
  }

  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Gewichtsverlauf" font-family="-apple-system, BlinkMacSystemFont, Inter, sans-serif">
    <defs>
      <linearGradient id="${id}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3DDC97" stop-opacity=".28"/><stop offset="1" stop-color="#3DDC97" stop-opacity="0"/></linearGradient>
      <filter id="${id}g" x="-10%" y="-40%" width="120%" height="180%"><feGaussianBlur stdDeviation="7"/></filter>
    </defs>
    ${goal}
    ${area ? `<path d="${area}" fill="url(#${id}f)"/>` : ''}
    ${line ? `<path d="${line}" fill="none" stroke="#3DDC97" stroke-width="10" stroke-linecap="round" filter="url(#${id}g)" opacity=".6"/>` : ''}
    <g fill="#fff" fill-opacity=".3">${dots}</g>
    ${line ? `<path d="${line}" fill="none" stroke="#3DDC97" stroke-width="${mini ? 3 : 4}" stroke-linecap="round" stroke-linejoin="round"/>` : ''}
    ${marker}
    <g font-size="11" font-weight="500" fill="#98A1B0">${axis}</g>
  </svg>`;
}

/* ---------- Screens ---------- */
function screenOnboarding() {
  const g = ui.ob.goal;
  const opt = (k, ic, t, s) => `<button class="goal-opt ${g === k ? 'on' : ''}" data-a="ob-goal" data-v="${k}"><span class="ic">${ic}</span><span><b>${t}</b><small>${s}</small></span></button>`;
  return `<section class="screen">
    ${brand()}
    <div style="margin-top:14px"><div class="sub">Einrichtung</div><h1>Was ist dein Ziel?</h1></div>
    <div class="stack">
      ${opt('lose', I.down, 'Abnehmen', 'Gewicht und Körperfett senken')}
      ${opt('gain', I.up, 'Zunehmen', 'Masse und Muskeln aufbauen')}
      ${opt('hold', I.eq, 'Halten', 'Gewicht stabil im Blick behalten')}
    </div>
    <div class="grid2">
      <div class="field"><label for="ob-start">Aktuelles Gewicht (kg)</label><input id="ob-start" inputmode="decimal" placeholder="z. B. 85,0"></div>
      <div class="field"><label for="ob-target">Zielgewicht (kg)</label><input id="ob-target" inputmode="decimal" placeholder="optional"></div>
    </div>
    <div class="card tight">
      <div class="setting">
        <div><b>Retatrutid-Tracking</b><small>optional, nur für Forschungszwecke</small></div>
        <button class="switch ${ui.ob.dose ? 'on' : ''}" role="switch" aria-checked="${ui.ob.dose}" aria-label="Retatrutid-Tracking" data-a="ob-dose"></button>
      </div>
    </div>
    <p class="note">Alle Daten und Fotos bleiben nur auf diesem iPhone. Es gibt keinen Account und keinen Server.</p>
    <button class="btn" data-a="ob-done" style="margin-top:auto">Los geht's</button>
  </section>`;
}

function screenHeute() {
  const m = metrics();
  const t = today();
  const todayKg = S.weights[t];
  const lastKg = m ? m.last.kg : S.startWeight;
  const v = todayKg ?? lastKg;
  let doseCard = '';
  if (S.doseTracking) {
    const n = S.doses.filter(d => weekStart(d.date) === weekStart(t)).length;
    const pct = Math.min(100, n / S.schedule * 100);
    doseCard = `<button class="card stack" data-a="tab" data-v="einnahme" style="text-align:left">
      <div class="between"><b style="font-size:15px">Diese Woche</b><span class="lime" style="font-size:13px;font-weight:700">${n} von ${S.schedule} Einnahmen</span></div>
      <div class="progress"><i style="width:${pct}%"></i></div>
    </button>`;
  }
  const recent = m ? m.e.filter(p => p.date >= addDays(m.last.date, -83)) : [];
  const h = new Date().getHours();
  const greet = h < 5 ? 'Gute Nacht' : h < 11 ? 'Guten Morgen' : h < 17 ? 'Guten Tag' : h < 22 ? 'Guten Abend' : 'Gute Nacht';
  return `<section class="screen">
    <div class="top">
      ${brand()}
      <button class="icon-btn" data-a="settings" aria-label="Einstellungen">${I.gear}</button>
    </div>
    <div><div class="sub">${esc(longDate(t))}</div><h1>${greet}${S.name ? ', ' + esc(S.name) : ''}</h1></div>
    <div class="card glow stack">
      <div class="between"><span class="sub">Gewicht heute</span>${todayKg != null ? '<span class="lime" style="font-size:12px;font-weight:700">Gespeichert</span>' : ''}</div>
      <div class="weight-big"><input id="w-in" inputmode="decimal" value="${v != null ? esc(f1(v)) : ''}" placeholder="0,0" aria-label="Gewicht in kg"><span>kg</span></div>
      <div class="row">
        <button class="icon-btn" data-a="w-step" data-v="-0.1" aria-label="0,1 kg weniger" style="background:var(--bg);font-size:24px">−</button>
        <button class="icon-btn" data-a="w-step" data-v="0.1" aria-label="0,1 kg mehr" style="background:var(--bg);font-size:24px">+</button>
        <button class="btn" data-a="w-save" style="flex:1;height:44px;border-radius:14px">${todayKg != null ? 'Aktualisieren' : 'Speichern'}</button>
      </div>
    </div>
    ${m ? `<div class="stats3">
      <div class="stat"><b class="lime">${signed(m.change)} kg</b><span>seit Start</span></div>
      <div class="stat"><b class="lime">${signed(m.pct)} %</b><span>vom Start</span></div>
      <div class="stat"><b>${m.perWeek != null ? signed(m.perWeek) : '–'}</b><span>kg / Woche</span></div>
    </div>
    <button class="card stack" data-a="tab" data-v="chart" style="text-align:left;padding-bottom:10px">
      <div class="between"><b style="font-size:15px">Chart</b><span class="sub">7-Tage-Schnitt</span></div>
      <div class="mini-chart">${chartSVG(recent, { w: 350, h: 130, mini: true, id: 'm' })}</div>
    </button>` : '<div class="empty">Trag dein erstes Gewicht ein, dann erscheint hier dein Fortschritt.</div>'}
    ${doseCard}
    ${m ? `<button class="btn ghost" data-a="share">${I.share.replace('<svg', '<svg width="20" height="20"')} Share-Karte erstellen</button>` : ''}
  </section>`;
}

function screenChart() {
  const m = metrics();
  if (!m) return `<section class="screen"><div class="top"><h1>Chart</h1></div><div class="empty">Noch keine Einträge. Trag unter „Home" dein Gewicht ein.</div></section>`;
  const days = { '4': 27, '12': 83, 'all': 1e6 }[ui.range];
  const e = m.e.filter(p => daysBetween(p.date, m.last.date) <= days);
  const [n, dec] = signed(m.pct).split(',');
  const pill = (k, l) => `<button class="pill ${ui.range === k ? 'on' : ''}" data-a="range" data-v="${k}">${l}</button>`;
  return `<section class="screen">
    <div class="top">
      <h1>Chart</h1>
      <div class="row" style="gap:8px">
        <div class="pills">${pill('4', '4 W')}${pill('12', '12 W')}${pill('all', 'Alles')}</div>
        <button class="icon-btn" data-a="share" aria-label="Share-Karte erstellen">${I.share}</button>
      </div>
    </div>
    <div>
      <div class="hero"><span class="n">${n},${dec}</span><span class="p">%</span></div>
      <div class="row" style="margin-top:12px;align-items:baseline"><b style="font-size:22px;letter-spacing:-.5px">${signed(m.change)} kg</b><span class="sub">seit Start · ${esc(periodLabel(m.days))}</span></div>
    </div>
    <div class="chart-wrap" id="chart">${chartSVG(e, { sel: ui.sel != null && ui.sel < e.length ? ui.sel : null, id: 'b' })}</div>
    <div class="strip">
      <div><div class="label">Start</div><b>${f1(m.start)} kg</b></div>
      <div><div class="label">Ø / Woche</div><b>${m.perWeek != null ? signed(m.perWeek) + ' kg' : '–'}</b></div>
      <div><div class="label">${m.toGoal != null ? 'Bis Ziel' : 'Jetzt Ø'}</div><b class="lime">${m.toGoal != null ? f1(Math.abs(m.toGoal)) + ' kg' : f1(m.cur) + ' kg'}</b></div>
    </div>
    <button class="link-btn" data-a="entries" style="align-self:flex-start">Einträge bearbeiten</button>
  </section>`;
}

function screenEinnahme() {
  const t = today(), ws = weekStart(t);
  const week = S.doses.filter(d => weekStart(d.date) === ws).sort((a, b) => (a.date < b.date ? -1 : 1));
  const slots = [];
  const total = Math.max(S.schedule, week.length);
  let openShown = false;
  for (let i = 0; i < total; i++) {
    const d = week[i];
    if (d) {
      slots.push(`<div class="card tight"><div class="row">
        <span class="check done">${I.check}</span>
        <div style="flex:1;min-width:0"><b style="font-size:15px">${i + 1}. Einnahme · ${esc(toDate(d.date).toLocaleDateString('de-DE', { weekday: 'long' }))}</b>
        <div class="sub">${fmg(d.mg)} mg${d.note ? ' · ' + esc(d.note) : ''}</div></div>
        <button class="x-btn" data-a="dose-del" data-v="${d.id}" aria-label="Eintrag löschen">${I.x}</button>
      </div></div>`);
    } else if (!openShown) {
      openShown = true;
      const lastMg = S.doses.length ? S.doses[S.doses.length - 1].mg : null;
      slots.push(`<div class="card stack" style="border-color:#1F5C44">
        <div class="row"><span class="check"></span><div><b style="font-size:15px">${i + 1}. Einnahme</b><div class="sub">offen</div></div></div>
        <div class="grid2">
          <div class="field"><label for="dose-mg">Menge (mg)</label><input id="dose-mg" inputmode="decimal" placeholder="dein Eintrag" value="${lastMg != null ? esc(fmg(lastMg)) : ''}"></div>
          <div class="field"><label for="dose-date">Datum</label><input id="dose-date" type="date" value="${t}" max="${t}"></div>
        </div>
        <div class="field"><label for="dose-note">Notiz / Nebenwirkungen (optional)</label><input id="dose-note" placeholder="z. B. Übelkeit 3/10, Appetit niedrig"></div>
        <button class="btn" data-a="dose-add">Als genommen abhaken</button>
      </div>`);
    } else {
      slots.push(`<div class="card tight"><div class="row"><span class="check"></span><div><b style="font-size:15px">${i + 1}. Einnahme</b><div class="sub">offen</div></div></div></div>`);
    }
  }
  const bars = [];
  for (let k = 11; k >= 0; k--) {
    const w = addDays(ws, -7 * k);
    const c = S.doses.filter(d => weekStart(d.date) === w).length;
    bars.push(`<i class="${c >= S.schedule ? 'full' : c > 0 ? 'part' : ''}"></i>`);
  }
  const hist = [...S.doses].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 12);
  return `<section class="screen">
    <div class="top"><div><div class="sub">Woche ab ${esc(shortDate(ws))}</div><h1>${esc(S.compound)}</h1></div></div>
    <div class="seg">
      <button class="${S.schedule === 1 ? 'on' : ''}" data-a="sched" data-v="1">1× pro Woche</button>
      <button class="${S.schedule === 2 ? 'on' : ''}" data-a="sched" data-v="2">2× aufgeteilt</button>
    </div>
    ${slots.join('')}
    <div class="card stack">
      <div class="between"><b style="font-size:15px">Wochenziel</b><span class="lime" style="font-size:13px;font-weight:700">${week.length} von ${S.schedule}</span></div>
      <div class="progress"><i style="width:${Math.min(100, week.length / S.schedule * 100)}%"></i></div>
    </div>
    <div class="card stack">
      <b style="font-size:15px">Letzte 12 Wochen</b>
      <div class="weekbars">${bars.join('')}</div>
      <div class="sub">Lime: Wochenziel erreicht · Oliv: teilweise</div>
    </div>
    ${hist.length ? `<div class="card tight"><b style="font-size:15px">Verlauf</b>${hist.map(d => `<div class="list-row"><span class="muted">${esc(shortDate(d.date))}</span><span style="font-weight:600">${fmg(d.mg)} mg</span></div>`).join('')}</div>` : ''}
    <p class="note">Die App gibt keine Dosis vor. Du trägst nur ein, was du selbst genommen hast.</p>
  </section>`;
}

function screenFotos() {
  const list = photos.filter(p => ui.phase === 'Alle' || p.phase === ui.phase).sort((a, b) => (a.date < b.date ? 1 : -1));
  const [b, a] = comparePair();
  const chip = p => `<button class="chip ${ui.phase === p ? 'on' : ''}" data-a="phase" data-v="${esc(p)}">${esc(p)}</button>`;
  return `<section class="screen">
    <div class="top"><h1>Fotos</h1><button class="icon-btn" data-a="ph-add" aria-label="Foto hinzufügen">${I.plus}</button></div>
    <div class="chips">${chip('Alle')}${PHASES.map(chip).join('')}</div>
    ${b && a ? `<div class="card stack">
      <div class="between"><b style="font-size:15px">Vorher / Nachher</b><span class="sub">tippen zum Ändern</span></div>
      <div class="compare">
        <button class="ph" data-a="ph-open" data-v="${b.id}"><img src="${b.url}" alt="Vorher"><span>Vorher · ${esc(shortDate(b.date))}</span></button>
        <button class="ph" data-a="ph-open" data-v="${a.id}"><img src="${a.url}" alt="Nachher"><span class="after">Nachher · ${esc(shortDate(a.date))}</span></button>
      </div>
    </div>` : ''}
    <div class="photo-grid">
      <button class="ph add" data-a="ph-add">${I.plus}Foto</button>
      ${list.map(p => `<button class="ph" data-a="ph-open" data-v="${p.id}"><img src="${p.url}" alt="${esc(p.phase)}" loading="lazy"><span>${esc(shortDate(p.date))}</span></button>`).join('')}
    </div>
    ${!photos.length ? '<div class="empty">Mach am besten jede Woche ein Foto: gleicher Ort, gleiches Licht, gleiche Pose. Nur dann ist der Vergleich ehrlich.</div>' : ''}
  </section>`;
}

function screenWissen() {
  const w = ui.wissen;
  const studies = S.studies.map(s => `<div class="card stack study">
    <div class="between" style="align-items:flex-start"><h3>${esc(s.title)}</h3><button class="x-btn" data-a="study-del" data-v="${s.id}" aria-label="Studie löschen">${I.x}</button></div>
    ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener" class="row" style="gap:6px;font-size:14px;font-weight:600">${I.ext}Quelle öffnen</a>` : ''}
    ${s.population ? `<div><div class="label">Wer wurde untersucht</div><p style="margin-top:4px">${esc(s.population)}</p></div>` : ''}
    ${s.summary ? `<div><div class="label">Kurzfassung</div><p style="margin-top:4px">${esc(s.summary)}</p></div>` : ''}
  </div>`).join('');
  const notes = [...S.notes].sort((a, b) => (a.date < b.date ? 1 : -1)).map(n => `<div class="card stack study">
    <div class="between"><span class="sub">${esc(shortDate(n.date))}</span><button class="x-btn" data-a="note-del" data-v="${n.id}" aria-label="Notiz löschen">${I.x}</button></div>
    <p>${esc(n.text)}</p></div>`).join('');
  return `<section class="screen">
    <div class="top"><h1>Wissen</h1><button class="icon-btn" data-a="${w === 'studien' ? 'study-new' : 'note-new'}" aria-label="Hinzufügen">${I.plus}</button></div>
    <div class="seg">
      <button class="${w === 'studien' ? 'on' : ''}" data-a="wissen" data-v="studien">Studien</button>
      <button class="${w === 'notizen' ? 'on' : ''}" data-a="wissen" data-v="notizen">Meine Notizen</button>
    </div>
    ${w === 'studien'
      ? (studies || '<div class="empty">Noch keine Studien. Füg den Link hinzu, schreib dazu, wer untersucht wurde, und fass das Ergebnis in eigenen Worten zusammen.</div>')
      : (notes || '<div class="empty">Noch keine Notizen.</div>') + '<p class="note">Deine Notizen sind privat und liegen nur auf diesem iPhone.</p>'}
  </section>`;
}

/* ---------- Sheets ---------- */
function sheetHTML() {
  const s = ui.sheet;
  if (!s) return '';
  let body = '';
  if (s.type === 'settings') {
    const g = (k, l) => `<button class="${S.goal === k ? 'on' : ''}" data-a="set-goal" data-v="${k}">${l}</button>`;
    body = `<h2>Einstellungen</h2>
      <div class="seg">${g('lose', 'Abnehmen')}${g('gain', 'Zunehmen')}${g('hold', 'Halten')}</div>
      <div class="field"><label for="set-name">Dein Name (für die Begrüßung)</label><input id="set-name" value="${esc(S.name || '')}" placeholder="optional" autocomplete="given-name"></div>
      <div class="grid2">
        <div class="field"><label for="set-start">Startgewicht (kg)</label><input id="set-start" inputmode="decimal" value="${S.startWeight != null ? esc(f1(S.startWeight)) : ''}" placeholder="erster Eintrag"></div>
        <div class="field"><label for="set-target">Zielgewicht (kg)</label><input id="set-target" inputmode="decimal" value="${S.targetWeight != null ? esc(f1(S.targetWeight)) : ''}" placeholder="optional"></div>
      </div>
      <div class="card tight">
        <div class="setting"><div><b>Retatrutid-Tracking</b><small>optional, nur für Forschungszwecke</small></div>
          <button class="switch ${S.doseTracking ? 'on' : ''}" role="switch" aria-checked="${S.doseTracking}" aria-label="Retatrutid-Tracking" data-a="set-dose"></button></div>
      </div>
      <button class="btn" data-a="set-save">Speichern</button>
      <div class="card tight">
        <div class="setting"><div><b>Backup exportieren</b><small>Daten als Datei sichern (ohne Fotos)</small></div><button class="btn small ghost" data-a="export">Export</button></div>
        <div class="setting"><div><b>Backup importieren</b><small>ersetzt die aktuellen Daten</small></div><button class="btn small ghost" data-a="import">Import</button></div>
      </div>
      <button class="btn danger" data-a="reset">Alle Daten löschen</button>`;
  } else if (s.type === 'entries') {
    const e = series().reverse();
    body = `<h2>Einträge</h2>
      <div class="grid2">
        <div class="field"><label for="en-date">Datum</label><input id="en-date" type="date" value="${today()}" max="${today()}"></div>
        <div class="field"><label for="en-kg">Gewicht (kg)</label><input id="en-kg" inputmode="decimal" placeholder="0,0"></div>
      </div>
      <button class="btn" data-a="entry-add">Eintragen</button>
      <div class="card tight">${e.length ? e.map(p => `<div class="list-row"><span class="muted">${esc(shortDate(p.date))} ${esc(p.date.slice(0, 4))}</span><span style="font-weight:600">${f1(p.kg)} kg</span><button class="x-btn" data-a="entry-del" data-v="${p.date}" aria-label="Eintrag löschen">${I.x}</button></div>`).join('') : '<div class="empty">Keine Einträge</div>'}</div>`;
  } else if (s.type === 'ph-add') {
    const chip = p => `<button class="chip ${s.phase === p ? 'on' : ''}" data-a="ph-add-phase" data-v="${esc(p)}">${esc(p)}</button>`;
    body = `<h2>Foto hinzufügen</h2>
      <div class="field"><label>Phase</label><div class="chips">${PHASES.map(chip).join('')}</div></div>
      <div class="field"><label for="ph-date">Datum</label><input id="ph-date" type="date" value="${s.date || today()}" max="${today()}"></div>
      <button class="btn" data-a="ph-pick">${I.cam.replace('<svg', '<svg width="20" height="20"')} Foto aufnehmen oder wählen</button>
      <p class="note">Tipp: gleicher Ort, gleiches Licht, gleiche Pose, morgens nüchtern.</p>`;
  } else if (s.type === 'ph-view') {
    const p = photos.find(x => x.id === s.id);
    if (!p) { ui.sheet = null; return ''; }
    const [b, a] = comparePair();
    body = `<div class="viewer"><img src="${p.url}" alt="${esc(p.phase)}"></div>
      <div class="between"><div><b>${esc(p.phase)}</b><div class="sub">${esc(longDate(p.date))}</div></div></div>
      <div class="grid2">
        <button class="btn ${b && b.id === p.id ? '' : 'ghost'}" data-a="ph-before" data-v="${p.id}">Als Vorher</button>
        <button class="btn ${a && a.id === p.id ? '' : 'ghost'}" data-a="ph-after" data-v="${p.id}">Als Nachher</button>
      </div>
      <button class="btn danger" data-a="ph-del" data-v="${p.id}">Foto löschen</button>`;
  } else if (s.type === 'study') {
    body = `<h2>Studie hinzufügen</h2>
      <div class="field"><label for="st-title">Titel</label><input id="st-title" placeholder="z. B. Phase-2-Studie, NEJM 2023"></div>
      <div class="field"><label for="st-url">Link</label><input id="st-url" type="url" inputmode="url" placeholder="https://pubmed.ncbi.nlm.nih.gov/…"></div>
      <div class="field"><label for="st-pop">Wer wurde untersucht?</label><input id="st-pop" placeholder="z. B. Erwachsene mit Adipositas, BMI ≥ 30"></div>
      <div class="field"><label for="st-sum">Kurzfassung in eigenen Worten</label><textarea id="st-sum"></textarea></div>
      <button class="btn" data-a="study-save">Speichern</button>`;
  } else if (s.type === 'note') {
    body = `<h2>Notiz</h2>
      <div class="field"><label for="no-text">Text</label><textarea id="no-text" style="min-height:180px"></textarea></div>
      <button class="btn" data-a="note-save">Speichern</button>`;
  } else if (s.type === 'share') {
    const canPhotos = !!comparePair()[0];
    body = `<h2>Teilen</h2>
      ${s.img ? `<img class="share-preview" src="${s.img}" alt="Vorschau der Share-Karte">` : '<div class="empty">Karte wird erstellt …</div>'}
      <div class="card tight">
        <div class="setting"><div><b>Vorher/Nachher-Fotos</b><small>${canPhotos ? 'aus deinem Foto-Bereich' : 'erst 2 Fotos hinzufügen'}</small></div>
          <button class="switch ${ui.share.photos && canPhotos ? 'on' : ''}" role="switch" aria-checked="${ui.share.photos}" aria-label="Fotos auf Karte" data-a="share-photos" ${canPhotos ? '' : 'disabled'}></button></div>
        ${S.doseTracking ? `<div class="setting"><div><b>Wirkstoff auf Karte</b><small>Standard: aus</small></div>
          <button class="switch ${ui.share.compound ? 'on' : ''}" role="switch" aria-checked="${ui.share.compound}" aria-label="Wirkstoff auf Karte" data-a="share-compound"></button></div>` : ''}
      </div>
      <button class="btn" data-a="share-go" ${s.img ? '' : 'disabled'}>${I.share.replace('<svg', '<svg width="20" height="20"')} Teilen oder speichern</button>`;
  }
  return `<div class="sheet-bg" data-a="sheet-bg"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${body}</div></div>`;
}

/* ---------- Render ---------- */
function render() {
  const app = document.getElementById('app');
  if (!S.onboarded) {
    app.innerHTML = screenOnboarding();
    document.getElementById('tabs').innerHTML = '';
  } else {
    if (ui.tab === 'einnahme' && !S.doseTracking) ui.tab = 'heute';
    const map = { heute: screenHeute, chart: screenChart, einnahme: screenEinnahme, fotos: screenFotos, wissen: screenWissen };
    app.innerHTML = map[ui.tab]();
    const tabs = [['heute', 'Home', I.home], ['chart', 'Chart', I.chart], ...(S.doseTracking ? [['einnahme', 'Einnahme', I.drop]] : []), ['fotos', 'Fotos', I.cam], ['wissen', 'Wissen', I.book]];
    document.getElementById('tabs').innerHTML = tabs.map(([k, l, ic]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-a="tab" data-v="${k}" aria-current="${ui.tab === k ? 'page' : 'false'}">${ic}${l}</button>`).join('');
    if (ui.tab === 'chart') bindChart();
  }
  renderSheet();
}
function renderSheet() { document.getElementById('sheet').innerHTML = sheetHTML(); }

function bindChart() {
  const wrap = document.getElementById('chart');
  if (!wrap) return;
  const pick = ev => {
    const svg = wrap.querySelector('svg');
    if (!svg || chartXs.length < 2) return;
    const r = svg.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width * 390;
    let best = 0;
    chartXs.forEach((cx, i) => { if (Math.abs(cx - x) < Math.abs(chartXs[best] - x)) best = i; });
    if (best !== ui.sel) {
      ui.sel = best;
      const m = metrics();
      const days = { '4': 27, '12': 83, 'all': 1e6 }[ui.range];
      const e = m.e.filter(p => daysBetween(p.date, m.last.date) <= days);
      wrap.innerHTML = chartSVG(e, { sel: best, id: 'b' });
    }
  };
  wrap.addEventListener('pointerdown', pick);
  wrap.addEventListener('pointermove', ev => { if (ev.buttons || ev.pointerType === 'touch') pick(ev); });
}

/* ---------- Fotos ---------- */
function comparePair() {
  if (photos.length < 2) return [null, null];
  const sorted = [...photos].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const b = photos.find(p => p.id === S.compare.before) || sorted[0];
  const a = photos.find(p => p.id === S.compare.after) || sorted[sorted.length - 1];
  return b.id === a.id ? [null, null] : [b, a];
}
function loadImg(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}
async function resizePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url);
    const max = 1600;
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, 'image/jpeg', .86));
  } finally { URL.revokeObjectURL(url); }
}

/* ---------- Share-Karte (Canvas, 1080×1920) ---------- */
function rr(x, X, Y, w, h, r) {
  x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); x.arcTo(X + w, Y + h, X, Y + h, r);
  x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath();
}
function drawLogo(x, X, Y, size, { alpha = 1, mono = false } = {}) {
  x.save(); x.globalAlpha = alpha; x.translate(X, Y); x.scale(size / 120, size / 120); x.translate(14, 0);
  x.transform(1, 0, Math.tan(-10 * Math.PI / 180), 1, 0, 0);
  [[14, 72, 28], [38, 56, 44], [62, 38, 62], [86, 18, 82]].forEach(([bx, by, bh], i) => {
    x.fillStyle = mono ? '#fff' : i === 3 ? '#3DDC97' : 'rgba(255,255,255,.9)';
    rr(x, bx, by, 16, bh, 4); x.fill();
  });
  x.restore();
}
function drawCover(x, img, X, Y, w, h) {
  const k = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const sw = w / k, sh = h / k;
  x.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, X, Y, w, h);
}
function pillText(x, text, X, Y, { fill = null, stroke = null, color = '#fff', size = 38, padX = 28, h = 68, align = 'left' } = {}) {
  x.font = `700 ${size}px ${FONT}`;
  const w = x.measureText(text).width + padX * 2;
  const left = align === 'right' ? X - w : X;
  rr(x, left, Y, w, h, h / 2);
  if (fill) { x.fillStyle = fill; x.fill(); }
  if (stroke) { x.strokeStyle = stroke; x.lineWidth = 3; x.stroke(); }
  x.fillStyle = color; x.textBaseline = 'middle'; x.fillText(text, left + padX, Y + h / 2 + 2);
  return w;
}
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Inter, Arial, sans-serif';

async function drawShare() {
  const m = metrics();
  const W = 1080, H = 1920;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#0E1014'; x.fillRect(0, 0, W, H);
  const [pb, pa] = comparePair();
  const usePhotos = ui.share.photos && pb && pa;

  if (usePhotos) {
    const [ib, ia] = await Promise.all([loadImg(pb.url), loadImg(pa.url)]);
    drawCover(x, ib, 0, 0, W / 2 - 3, H);
    drawCover(x, ia, W / 2 + 3, 0, W / 2 - 3, H);
    const g = x.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(14,16,20,.55)'); g.addColorStop(.14, 'rgba(14,16,20,0)');
    g.addColorStop(.5, 'rgba(14,16,20,0)'); g.addColorStop(.72, 'rgba(14,16,20,.9)'); g.addColorStop(1, '#0E1014');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
  } else {
    const g = x.createRadialGradient(W, 0, 0, W, 0, W * 1.15);
    g.addColorStop(0, 'rgba(61,220,151,.24)'); g.addColorStop(1, 'rgba(61,220,151,0)');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    drawLogo(x, W - 700, H - 1020, 1150, { alpha: .055, mono: true });
  }

  // Kopf: Logo + Name + Zeitraum
  drawLogo(x, 64, 96, 96);
  x.textBaseline = 'middle'; x.font = `800 60px ${FONT}`; x.fillStyle = '#fff';
  x.fillText('kinetic', 172, 146);
  x.fillStyle = '#3DDC97'; x.fillText('.', 172 + x.measureText('kinetic').width, 146);
  pillText(x, periodLabel(m.days), W - 64, 112, { stroke: 'rgba(255,255,255,.35)', align: 'right', fill: usePhotos ? 'rgba(14,16,20,.45)' : null });

  const [n, dec] = signed(m.pct).split(',');
  const heroY = usePhotos ? 1230 : 700;
  const heroSize = usePhotos ? 250 : 320;
  const kgY = heroY + (usePhotos ? 160 : 205), subY = kgY + (usePhotos ? 76 : 86);

  if (usePhotos) {
    pillText(x, 'VORHER', 64, 230, { fill: 'rgba(14,16,20,.7)', size: 30, h: 58 });
    pillText(x, 'NACHHER', W - 64, 230, { fill: '#3DDC97', color: '#07281B', size: 30, h: 58, align: 'right' });
  }

  // Hero-Zahl
  x.textBaseline = 'alphabetic'; x.fillStyle = '#3DDC97';
  x.font = `800 ${heroSize}px ${FONT}`;
  const heroTxt = `${n},${dec}`;
  x.fillText(heroTxt, 52, heroY);
  const hw = x.measureText(heroTxt).width;
  x.font = `800 ${Math.round(heroSize * .42)}px ${FONT}`;
  x.fillText('%', 52 + hw + 8, heroY - heroSize * .5);

  x.fillStyle = '#fff'; x.font = `800 ${usePhotos ? 92 : 112}px ${FONT}`;
  x.fillText(`${signed(m.change)} kg`, 60, kgY);
  x.fillStyle = '#A9B1BE'; x.font = `500 46px ${FONT}`;
  const sub = m.days <= 0 ? 'Tag 1' : `in ${periodLabel(m.days)}`;
  x.fillText(sub, 64, subY);
  if (ui.share.compound && S.doseTracking) {
    const sw = x.measureText(sub).width;
    pillText(x, `mit ${S.compound}`, 64 + sw + 24, subY - 46, { stroke: 'rgba(61,220,151,.6)', color: '#3DDC97', size: 32, h: 60, padX: 24 });
    x.textBaseline = 'alphabetic';
  }

  // Wochenbalken (nur ohne Fotos)
  if (!usePhotos) {
    const weeks = {};
    m.e.forEach(p => { weeks[weekStart(p.date)] = p.avg; });
    const v = Object.values(weeks).slice(-12);
    const lo = Math.min(...v), hi = Math.max(...v);
    const top = 1150, bh = 320, gap = 14, n2 = 12, off = n2 - v.length;
    const bw = (W - 128 - gap * (n2 - 1)) / n2;
    for (let i = 0; i < off; i++) {            // noch keine Daten: leere Plätze
      x.fillStyle = '#171A21'; rr(x, 64 + i * (bw + gap), top + bh - 40, bw, 40, 12); x.fill();
    }
    v.forEach((val, j) => {
      const i = off + j;
      const t = hi - lo < .05 ? .6 : .25 + .75 * (val - lo) / (hi - lo);
      const h = bh * t;
      x.fillStyle = i === n2 - 1 ? '#3DDC97' : '#262B35';
      rr(x, 64 + i * (bw + gap), top + bh - h, bw, h, Math.min(14, bw / 3)); x.fill();
    });
  }

  // Start / Jetzt
  const by = H - 300, bw2 = (W - 128 - 24) / 2, bhh = 190;
  rr(x, 64, by, bw2, bhh, 36); x.fillStyle = usePhotos ? 'rgba(23,23,27,.85)' : '#171A21'; x.fill();
  rr(x, 64 + bw2 + 24, by, bw2, bhh, 36); x.fillStyle = '#3DDC97'; x.fill();
  x.textBaseline = 'alphabetic';
  x.font = `600 30px ${FONT}`; x.fillStyle = '#98A1B0'; x.fillText('START', 104, by + 66);
  x.fillStyle = '#0F5A3C'; x.fillText('JETZT', 104 + bw2 + 24, by + 66);
  x.font = `800 64px ${FONT}`; x.fillStyle = '#fff'; x.fillText(`${f1(m.start)} kg`, 104, by + 148);
  x.fillStyle = '#07281B'; x.fillText(`${f1(m.cur)} kg`, 104 + bw2 + 24, by + 148);
  return c;
}
async function refreshShare() {
  ui.sheet = { type: 'share', img: null }; renderSheet();
  try {
    const c = await drawShare();
    ui.sheet.canvas = c;
    ui.sheet.img = c.toDataURL('image/jpeg', .85);
  } catch (e) { toast('Karte konnte nicht erstellt werden'); }
  if (ui.sheet && ui.sheet.type === 'share') renderSheet();
}

/* ---------- Aktionen ---------- */
const A = {
  tab(el) { ui.tab = el.dataset.v; ui.sel = null; ui.sheet = null; render(); window.scrollTo(0, 0); },
  'sheet-bg'(el, ev) { if (ev.target === el) { ui.sheet = null; renderSheet(); } },

  // Onboarding
  'ob-goal'(el) { readOb(); ui.ob.goal = el.dataset.v; render(); writeOb(); },
  'ob-dose'() { readOb(); ui.ob.dose = !ui.ob.dose; render(); writeOb(); },
  'ob-done'() {
    readOb();
    const start = num(ui.ob.start), target = num(ui.ob.target);
    if (start == null || start < 25 || start > 350) { toast('Bitte dein aktuelles Gewicht eintragen'); return; }
    Object.assign(S, { onboarded: true, goal: ui.ob.goal, startWeight: start, targetWeight: target, doseTracking: ui.ob.dose });
    S.weights[today()] = start;
    save(); ui.tab = 'heute'; render();
  },

  // Gewicht
  'w-step'(el) {
    const i = document.getElementById('w-in');
    const v = num(i.value) ?? (metrics()?.last.kg ?? 70);
    i.value = f1(Math.round((v + parseFloat(el.dataset.v)) * 10) / 10); haptic();
  },
  'w-save'() {
    const v = num(val('w-in'));
    if (v == null || v < 25 || v > 350) { toast('Ungültiges Gewicht'); return; }
    S.weights[today()] = Math.round(v * 10) / 10; save(); haptic(); toast('Gewicht gespeichert'); render();
  },
  entries() { ui.sheet = { type: 'entries' }; renderSheet(); },
  'entry-add'() {
    const d = val('en-date'), v = num(val('en-kg'));
    if (!d || d > today()) { toast('Ungültiges Datum'); return; }
    if (v == null || v < 25 || v > 350) { toast('Ungültiges Gewicht'); return; }
    S.weights[d] = Math.round(v * 10) / 10; save(); toast('Eingetragen'); ui.sel = null; render();
  },
  'entry-del'(el) { if (!confirm('Eintrag löschen?')) return; delete S.weights[el.dataset.v]; save(); ui.sel = null; render(); },
  range(el) { ui.range = el.dataset.v; ui.sel = null; render(); },

  // Einnahme
  sched(el) { S.schedule = +el.dataset.v; save(); render(); },
  'dose-add'() {
    const mg = num(val('dose-mg')), date = val('dose-date') || today();
    if (mg == null || mg <= 0) { toast('Bitte Menge in mg eintragen'); return; }
    if (date > today()) { toast('Datum liegt in der Zukunft'); return; }
    S.doses.push({ id: uid(), date, mg, note: val('dose-note').trim() });
    S.doses.sort((a, b) => (a.date < b.date ? -1 : 1));
    save(); haptic(); toast('Abgehakt'); render();
  },
  'dose-del'(el) { if (!confirm('Einnahme löschen?')) return; S.doses = S.doses.filter(d => d.id !== el.dataset.v); save(); render(); },

  // Fotos
  phase(el) { ui.phase = el.dataset.v; render(); },
  'ph-add'() { ui.sheet = { type: 'ph-add', phase: ui.phase !== 'Alle' ? ui.phase : (S.doseTracking ? 'Während Reta' : 'Vor Cut') }; renderSheet(); },
  'ph-add-phase'(el) { ui.sheet.date = val('ph-date'); ui.sheet.phase = el.dataset.v; renderSheet(); },
  'ph-pick'() { ui.sheet.date = val('ph-date') || today(); document.getElementById('ph-file').click(); },
  'ph-open'(el) { ui.sheet = { type: 'ph-view', id: el.dataset.v }; renderSheet(); },
  'ph-before'(el) { S.compare.before = el.dataset.v; save(); render(); },
  'ph-after'(el) { S.compare.after = el.dataset.v; save(); render(); },
  async 'ph-del'(el) {
    if (!confirm('Foto löschen?')) return;
    const id = el.dataset.v;
    await DB.delPhoto(id);
    const p = photos.find(q => q.id === id); if (p) URL.revokeObjectURL(p.url);
    photos = photos.filter(q => q.id !== id);
    ui.sheet = null; render();
  },

  // Wissen
  wissen(el) { ui.wissen = el.dataset.v; render(); },
  'study-new'() { ui.sheet = { type: 'study' }; renderSheet(); },
  'study-save'() {
    const title = val('st-title').trim();
    if (!title) { toast('Titel fehlt'); return; }
    let url = val('st-url').trim();
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    S.studies.unshift({ id: uid(), title, url, population: val('st-pop').trim(), summary: val('st-sum').trim() });
    save(); ui.sheet = null; render();
  },
  'study-del'(el) { if (!confirm('Studie löschen?')) return; S.studies = S.studies.filter(s => s.id !== el.dataset.v); save(); render(); },
  'note-new'() { ui.sheet = { type: 'note' }; renderSheet(); },
  'note-save'() {
    const text = val('no-text').trim();
    if (!text) { toast('Notiz ist leer'); return; }
    S.notes.push({ id: uid(), date: today(), text }); save(); ui.sheet = null; render();
  },
  'note-del'(el) { if (!confirm('Notiz löschen?')) return; S.notes = S.notes.filter(n => n.id !== el.dataset.v); save(); render(); },

  // Teilen
  share() { refreshShare(); },
  'share-photos'() { ui.share.photos = !ui.share.photos; refreshShare(); },
  'share-compound'() { ui.share.compound = !ui.share.compound; refreshShare(); },
  async 'share-go'() {
    const c = ui.sheet?.canvas; if (!c) return;
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    const file = new File([blob], 'kinetic.png', { type: 'image/png' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'kinetic.png'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  },

  // Einstellungen
  settings() { ui.sheet = { type: 'settings' }; renderSheet(); },
  'set-goal'(el) { readSettings(); S.goal = el.dataset.v; save(); renderSheet(); writeSettings(); },
  'set-dose'() { readSettings(); S.doseTracking = !S.doseTracking; save(); render(); writeSettings(); },
  'set-save'() {
    const s = num(val('set-start')), t = num(val('set-target'));
    S.startWeight = s; S.targetWeight = t; S.name = val('set-name').trim().slice(0, 24); save(); ui.sheet = null; toast('Gespeichert'); render();
  },
  export() {
    const blob = new Blob([JSON.stringify({ app: 'kinetic', exported: new Date().toISOString(), state: S }, null, 2)], { type: 'application/json' });
    const file = new File([blob], `kinetic-backup-${today()}.json`, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file] }).catch(() => {}); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
  },
  import() { document.getElementById('import-file').click(); },
  async reset() {
    if (!confirm('Wirklich alle Daten und Fotos löschen? Das lässt sich nicht rückgängig machen.')) return;
    S = structuredClone(DEFAULT_STATE); await save(); await DB.clearPhotos();
    photos.forEach(p => URL.revokeObjectURL(p.url)); photos = [];
    ui.sheet = null; render();
  }
};

// Eingaben vor dem Neurendern sichern
function readOb() { ui.ob.start = val('ob-start'); ui.ob.target = val('ob-target'); }
function writeOb() { const s = document.getElementById('ob-start'), t = document.getElementById('ob-target'); if (s) s.value = ui.ob.start || ''; if (t) t.value = ui.ob.target || ''; }
let setCache = {};
function readSettings() { setCache = { s: val('set-start'), t: val('set-target'), n: val('set-name') }; }
function writeSettings() {
  [['set-start', 's'], ['set-target', 't'], ['set-name', 'n']].forEach(([id, k]) => { const el = document.getElementById(id); if (el && setCache[k] != null) el.value = setCache[k]; });
}

document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-a]');
  if (!el || el.disabled) return;
  const fn = A[el.dataset.a];
  if (fn) fn(el, ev);
});

document.getElementById('ph-file').addEventListener('change', async ev => {
  const file = ev.target.files[0]; ev.target.value = '';
  if (!file) return;
  try {
    const blob = await resizePhoto(file);
    const p = { id: uid(), date: ui.sheet?.date || today(), phase: ui.sheet?.phase || 'Während Reta', blob };
    await DB.putPhoto(p);
    photos.push({ ...p, url: URL.createObjectURL(blob) });
    ui.sheet = null; ui.phase = 'Alle'; toast('Foto gespeichert'); render();
  } catch (e) { toast('Foto konnte nicht gespeichert werden'); }
});

document.getElementById('import-file').addEventListener('change', async ev => {
  const file = ev.target.files[0]; ev.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'kinetic' || !data.state || typeof data.state.weights !== 'object') throw new Error('format');
    if (!confirm('Backup importieren? Die aktuellen Daten werden ersetzt (Fotos bleiben).')) return;
    S = { ...structuredClone(DEFAULT_STATE), ...data.state };
    await save(); ui.sheet = null; toast('Backup importiert'); render();
  } catch (e) { toast('Datei ist kein Kinetic-Backup'); }
});

/* ---------- Start ---------- */
(async function init() {
  try {
    await DB.open();
    const saved = await DB.get('state');
    if (saved) S = { ...structuredClone(DEFAULT_STATE), ...saved };
    photos = (await DB.photos()).map(p => ({ ...p, url: URL.createObjectURL(p.blob) }));
    navigator.storage?.persist?.().catch(() => {});
  } catch (e) {
    document.getElementById('app').innerHTML = '<section class="screen"><div class="empty">Speicher nicht verfügbar. Öffne Kinetic nicht im privaten Modus.</div></section>';
    return;
  }
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
