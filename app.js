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
  schedule: 2,             // Einnahmen pro Woche (= Anzahl doseDays)
  doseDays: [1, 4],        // Einnahme-Tage, ISO: 1 = Mo … 7 = So
  remind: { on: false, time: '09:00' }, // Push-Erinnerung an Einnahme-Tagen
  mix: { mg: 10, ml: 1 },  // eigene Mischung: mg Wirkstoff in ml Wasser (für IU-Anzeige)
  compound: 'Retatrutid',
  weights: {},             // { 'YYYY-MM-DD': kg }
  doses: [],               // { id, date, mg, note }
  studies: [],             // { id, title, url, population, summary }
  notes: [],               // { id, date, text }
  compare: { before: null, after: null }
};

let S = structuredClone(DEFAULT_STATE);
let photos = [];           // { id, date, phase, blob, url }
const ui = { tab: 'heute', tf: 'D', phase: 'Alle', wissen: 'studien', sel: null, sheet: null, ob: { goal: 'lose', dose: true }, share: { photos: false, compound: false } };

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
// Im Demo-Modus wird nichts gespeichert, deine echten Daten bleiben unangetastet.
const save = () => {
  if (ui.demo) return Promise.resolve();
  S._t = Date.now();                    // Zeitstempel für den Abgleich mit dem Account
  Cloud.queue();
  return DB.set('state', S).catch(() => toast('Speichern fehlgeschlagen'));
};

/* ---------- Account & Sync (Supabase) ----------
   Ohne config.js-Werte läuft die App wie bisher nur lokal.
   Mit Account: Daten liegen lokal UND im Account. Jede Änderung wird kurz danach hochgeladen,
   beim Öffnen wird der neueste Stand geholt. Fotos bleiben immer nur auf dem Gerät. */
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* egal */ } };
const Cloud = {
  sb: null, user: null, timer: 0, busy: false,
  profile: (() => { try { return JSON.parse(lsGet('kinetic-profile') || 'null'); } catch (e) { return null; } })(),
  setProfile(p) { this.profile = p; lsSet('kinetic-profile', p ? JSON.stringify(p) : null); },
  contact: (() => { try { const v = JSON.parse(lsGet('kinetic-contact') || 'null'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } })(),
  async loadSettings() {
    const { data } = await this.sb.from('app_settings').select('key, value');
    const get = k => (data || []).find(x => x.key === k)?.value || null;
    this.contact = { wa: get('contact_whatsapp'), tg: get('contact_telegram') };
    lsSet('kinetic-contact', JSON.stringify(this.contact));
    if (ui.tab === 'einnahme' || ui.sheet?.type === 'settings') { ui.sheet ? renderSheet() : render(); }
  },
  async loadProfile() {
    const { data } = await this.sb.rpc('my_profile');
    if (data && data[0]) this.setProfile(data[0]);
  },
  get on() { return !!this.sb; },
  init() {
    const c = window.KINETIC_CONFIG || {};
    if (!c.supabaseUrl || !c.supabaseKey || !window.supabase) return;
    this.sb = window.supabase.createClient(c.supabaseUrl, c.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'kinetic-auth' }
    });
    this.sb.auth.onAuthStateChange((ev, session) => {
      if (ev === 'SIGNED_OUT') { this.user = null; render(); }
      else if (session?.user) this.user = session.user;
    });
  },
  async session() {
    // Gespeicherte Sitzung vorab merken: Bei langsamem oder fehlendem Netz bleibt man angemeldet,
    // statt den Login zu sehen. Nur wenn der Server die Sitzung wirklich ablehnt, muss man sich neu anmelden.
    let stored = null;
    try { stored = JSON.parse(lsGet('kinetic-auth') || 'null'); } catch (e) { /* egal */ }
    if (!navigator.onLine && stored?.user) { this.user = stored.user; return this.user; }   // offline: sofort rein
    let r = null;
    try {
      r = await Promise.race([this.sb.auth.getSession(), new Promise(res => setTimeout(() => res('timeout'), 6000))]);
    } catch (e) { r = { error: e }; }
    const netProblem = r === 'timeout' || /fetch|network|load failed|retryable/i.test(String(r?.error?.name || '') + String(r?.error?.message || ''));
    this.user = (r && r !== 'timeout' && r.data?.session?.user) || (netProblem && stored?.user) || null;
    return this.user;
  },
  // Änderung merken und gesammelt hochladen
  queue() {
    if (!this.user) return;
    lsSet('kinetic-dirty', '1');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.push(), 800);
  },
  async push() {
    if (!this.user || ui.demo) return;
    clearTimeout(this.timer);
    const { error } = await this.sb.from('user_state')
      .upsert({ user_id: this.user.id, state: S, updated_at: new Date().toISOString() });
    if (!error) lsSet('kinetic-dirty', null);
    return !error;
  },
  // Neuesten Stand holen. Lokal ungespeicherte Änderungen gewinnen, sonst der neuere Stand.
  async pull() {
    if (!this.user || ui.demo || this.busy) return;
    this.busy = true;
    try {
      const { data, error } = await this.sb.from('user_state').select('state').eq('user_id', this.user.id).maybeSingle();
      if (error) return;
      if (!data) { if (S.onboarded) await this.push(); return; }
      const rt = data.state?._t || 0, lt = S._t || 0;
      if (lsGet('kinetic-dirty') === '1' && lt >= rt) { await this.push(); return; }
      if (rt > lt || !S.onboarded) {
        S = { ...structuredClone(DEFAULT_STATE), ...data.state };
        if (!data.state.doseDays) S.doseDays = null;
        fixDays();
        await DB.set('state', S);
        lsSet('kinetic-dirty', null);
        safeRender();
      }
    } catch (e) { /* offline: später nochmal */ } finally { this.busy = false; }
  }
};
// Beim Zurückkehren in die App abgleichen, beim Verlassen sofort hochladen
document.addEventListener('visibilitychange', () => {
  if (!Cloud.user) return;
  if (document.visibilityState === 'visible') { Cloud.pull(); if (lib.state !== 'loading') { lib.state = 'idle'; loadLib(); } }
  else if (lsGet('kinetic-dirty') === '1') Cloud.push();
});
window.addEventListener('online', () => { if (Cloud.user) Cloud.pull(); });

/* ---------- Push-Erinnerungen ----------
   Auf dem iPhone nur in der App vom Home-Bildschirm (ab iOS 16.4). */
const VAPID_PUBLIC = 'BGOyMnv9WBs2SXqeaKajEjNostSv6_D1_WfXhFs-ZarZidwyf9M7jZENIRkvOXE17ykQ1MZjADGu0pLnVjjT9o4';
const isStandalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const isIOS = () => /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64u = s => { const p = '='.repeat((4 - s.length % 4) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); };
const Push = {
  // Gerät beim Server anmelden (Abo erstellen oder erneuern)
  async subscribe() {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(VAPID_PUBLIC) });
    const j = sub.toJSON();
    const { error } = await Cloud.sb.from('push_subscriptions').upsert({
      user_id: Cloud.user.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin'
    }, { onConflict: 'endpoint' });
    if (error) throw error;
    return sub;
  },
  // Dieses Gerät abmelden (beim Abmelden aus dem Account)
  async unsubscribe() {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) { await Cloud.sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe(); }
    } catch (e) { /* egal */ }
  },
  // Beim Start still erneuern, falls aktiv
  async refresh() {
    if (!Cloud.user || !S.remind?.on || !pushSupported() || Notification.permission !== 'granted') return;
    try { await this.subscribe(); } catch (e) { /* später nochmal */ }
  }
};

// Nach dem Anmelden: lokale Daten dem Account zuordnen
async function afterLogin(user) {
  const owner = await DB.get('owner');
  if (owner && owner !== user.id) {
    // anderer Account auf diesem Gerät: dessen lokale Daten nicht übernehmen
    S = structuredClone(DEFAULT_STATE); fixDays(); await DB.set('state', S);
    await DB.clearPhotos(); photos.forEach(p => URL.revokeObjectURL(p.url)); photos = [];
    lsSet('kinetic-dirty', null);
  } else if (!owner && S.onboarded) {
    lsSet('kinetic-dirty', '1');        // bisherige Daten auf diesem iPhone in den Account übernehmen
  }
  await DB.set('owner', user.id);
  lsSet('kinetic-uid', user.id);
  lib = { state: 'idle', items: [] };
  await Cloud.pull();
}

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

const OK_MSGS = /gespeichert|eingetragen|abgehakt|importiert|zurück/i;
let toastTimer = 0;
function toast(msg) {
  const ok = OK_MSGS.test(msg) && !/nicht|fehl/i.test(msg);
  document.querySelectorAll('.toast').forEach(t => t.remove());
  clearTimeout(toastTimer);
  const t = document.createElement('div');
  t.className = 'toast ' + (ok ? 'ok' : 'err');
  t.setAttribute('role', 'status');
  t.innerHTML = (ok
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke-width="2"/><path d="M8 12.5l2.6 2.6L16 9.6"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke-width="2"/><path d="M12 7v6M12 16.5v.5"/></svg>')
    + `<span>${esc(msg)}</span>`;
  document.body.appendChild(t);
  toastTimer = setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 1700);
}
function haptic() { try { navigator.vibrate?.(8); } catch (e) { /* iOS ignoriert das */ } }

/* ---------- Icons ---------- */
const I = {
  pin: '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M16 3a1 1 0 0 1 .7 1.7L15.4 6l2.6 5.2 1.3-.3a1 1 0 0 1 .9 1.7L16.4 16l4.3 4.3-1.4 1.4-4.3-4.3-3.6 3.8a1 1 0 0 1-1.7-.9l.3-1.3L4.8 16.4l-1.1 1.1-1.4-1.4L9 9.4 10.3 6.7 9 5.4A1 1 0 0 1 9.7 3.7z" transform="scale(.9) translate(1.3 1.3)"/></svg>',
  bell: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-8 9 8v10h-6v-6H9v6H3z"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l5-6 4 3 8-9"/><path d="M3 21h18"/></svg>',
  drop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/></svg>',
  cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="3"/><circle cx="12" cy="13.5" r="3.5"/><path d="M8 7l1.5-3h5L16 7"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2z"/><path d="M4 20a2 2 0 0 0 2 1h13v-3"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v13M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
  scale: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><path d="M8 9a5 5 0 0 1 8 0"/><path d="M12 9l1.5-2"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l4 4 10-10"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="16" height="16"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  eq: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 9h14M5 15h14"/></svg>',
  logo: '<svg viewBox="0 0 120 120" aria-hidden="true"><g transform="translate(14 0) skewX(-10)"><rect x="14" y="72" width="16" height="28" rx="4" fill="#fff" fill-opacity=".9"/><rect x="38" y="56" width="16" height="44" rx="4" fill="#fff" fill-opacity=".9"/><rect x="62" y="38" width="16" height="62" rx="4" fill="#fff" fill-opacity=".9"/><rect x="86" y="18" width="16" height="82" rx="4" fill="#3DDC97"/></g></svg>'
};
const brand = (big = false) => `<div class="brand${big ? ' big' : ''}">${I.logo}<span>kinetic<span class="lime">.</span></span></div>`;

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
let chartXs = [], chartPts = [];
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
    ${area ? `<path d="${area}" fill="url(#${id}f)"/>` : ''}
    ${line ? `<path d="${line}" fill="none" stroke="#3DDC97" stroke-width="10" stroke-linecap="round" filter="url(#${id}g)" opacity=".6"/>` : ''}
    <g fill="#fff" fill-opacity=".3">${dots}</g>
    ${line ? `<path d="${line}" fill="none" stroke="#3DDC97" stroke-width="${mini ? 3 : 4}" stroke-linecap="round" stroke-linejoin="round"/>` : ''}
    ${marker}
    <g font-size="11" font-weight="500" fill="#98A1B0">${axis}</g>
  </svg>`;
}

/* ---------- Screens ---------- */
function screenInstall() {
  const share = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
  const plus = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><path d="M12 8v8M8 12h8"/></svg>';
  const step = (n, ic, t, sub) => `<div class="inst-step"><span class="inst-n">${n}</span><div class="inst-t"><b>${t}</b><span>${sub}</span></div><span class="inst-ic">${ic}</span></div>`;
  return `<section class="screen auth install">
    <div class="auth-head"><div class="auth-logo">${I.logo}</div><div class="auth-name">kinetic<span>.</span></div><div class="sub">Installiere Kinetic auf deinem Home-Bildschirm. Das dauert 10 Sekunden.</div></div>
    <div class="card stack">
      ${step(1, share, 'Teilen antippen', 'Unten in Safari. Bei neueren iPhones zuerst auf ••• tippen.')}
      ${step(2, plus, '„Zum Home-Bildschirm“', 'Etwas runterscrollen, dann „Hinzufügen“.')}
      ${step(3, `<span class="inst-app">${I.logo}</span>`, 'Kinetic öffnen', 'Vom Home-Bildschirm, nicht aus Safari.')}
    </div>
    <p class="note" style="text-align:center">Nur so läuft Kinetic wie eine echte App: Vollbild, Erinnerungen und dein Login bleibt gespeichert.</p>
    <button class="inst-skip" data-a="inst-skip">Trotzdem im Browser öffnen</button>
    <div class="inst-arrow" aria-hidden="true">↓</div>
  </section>`;
}
function readAuth() {
  ui.auth = ui.auth || {};
  const g = id => document.getElementById(id);
  if (g('au-code')) ui.auth.code = g('au-code').value.trim();
  if (g('au-first')) ui.auth.first = g('au-first').value.trim();
  if (g('au-last')) ui.auth.last = g('au-last').value.trim();
}
function authMsg(e) {
  const m = String(e?.message || e || '');
  if (m === 'invalid') return 'Code oder Name stimmt nicht.';
  if (m === 'disabled') return 'Dieser Code ist gesperrt.';
  if (/invalid login credentials/i.test(m)) return 'Anmeldung fehlgeschlagen.';
  if (/database error saving new user|KINETIC_INVITE/i.test(m)) return 'Einladungscode ungültig oder schon benutzt.';
  if (/already registered|already been registered/i.test(m)) return 'Für diese E-Mail gibt es schon einen Account.';
  if (/email not confirmed/i.test(m)) return 'Bitte bestätige zuerst deine E-Mail.';
  if (/password/i.test(m) && /(short|least|weak)/i.test(m)) return 'Passwort zu schwach, bitte mindestens 8 Zeichen.';
  if (/rate limit|too many/i.test(m)) return 'Zu viele Versuche, bitte kurz warten.';
  if (/fetch|network|failed to/i.test(m)) return 'Keine Verbindung. Bist du online?';
  return 'Das hat nicht geklappt: ' + m;
}
const waLink = () => {
  const n = String(Cloud.contact?.wa || '').replace(/\D/g, '');
  return n ? `https://wa.me/${n}` : '';
};
const tgLink = () => {
  const u = String(Cloud.contact?.tg || '').replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '').trim();
  return /^[A-Za-z0-9_]{4,}$/.test(u) ? `https://t.me/${u}` : '';
};
const waIcon = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3z"/></svg>';
const tgIcon = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M21.4 4.2 2.9 11.3c-1.3.5-1.2 1.2-.2 1.5l4.7 1.5 1.8 5.6c.2.6.4.8.8.8s.6-.2.9-.5l2.3-2.2 4.8 3.5c.9.5 1.5.2 1.7-.8l3.1-14.7c.3-1.3-.5-1.9-1.4-1.5zM9.6 14.4l-.4 4.1-1.5-4.8 10.6-6.7-8.7 7.4z"/></svg>';
const msgIcon = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>';
const hasContact = () => !!(waLink() || tgLink());
const contactCard = () => hasContact() ? `<button class="card contact-card" data-a="contact">
    <span class="wa-ic">${msgIcon}</span>
    <span class="ct-txt"><b>Retatrutid leer?</b><span>Maxim per ${[waLink() && 'WhatsApp', tgLink() && 'Telegram'].filter(Boolean).join(' oder ')}</span></span>
    <span class="ct-go">›</span></button>` : '';

function screenAuth() {
  const a = ui.auth || (ui.auth = {});
  return `<section class="screen auth">
    <div class="auth-head"><div class="auth-logo">${I.logo}</div><div class="auth-name">kinetic<span>.</span></div><div class="sub">Melde dich mit deinem Einladungscode an.</div></div>
    <div class="stack">
      <div class="field"><label for="au-code">Einladungscode</label><input id="au-code" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="KIN-XXXXXXXX" value="${esc(a.code || '')}"></div>
      <div class="grid2">
        <div class="field"><label for="au-first">Vorname</label><input id="au-first" autocomplete="given-name" autocapitalize="words" value="${esc(a.first || '')}"></div>
        <div class="field"><label for="au-last">Nachname</label><input id="au-last" autocomplete="family-name" autocapitalize="words" value="${esc(a.last || '')}"></div>
      </div>
      <button class="consent ${a.ok ? 'on' : ''}" data-a="auth-consent" role="checkbox" aria-checked="${!!a.ok}"><span class="cb">${I.check}</span><span>Ich willige ein, dass mein Gewicht, meine Einnahmen und Einstellungen in meinem Account gespeichert werden (Server in der EU). Fotos bleiben nur auf meinem iPhone. Ich kann meinen Account jederzeit in den Einstellungen löschen.</span></button>
      <div class="auth-err" id="au-err" role="alert"></div>
      <button class="btn" data-a="auth-go">Anmelden</button>
    </div>
    <p class="note" style="text-align:center">Kinetic ist nur auf Einladung. Den Code bekommst du von Maxim.</p>
  </section>`;
}

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
    <p class="note">${Cloud.user ? 'Deine Daten werden in deinem Account gespeichert. Fotos bleiben nur auf diesem iPhone.' : 'Alle Daten und Fotos bleiben nur auf diesem iPhone.'}</p>
    <button class="btn" data-a="ob-done" style="margin-top:auto">Los geht's</button>
  </section>`;
}

function screenHeute() {
  const m = metrics();
  const t = today();
  const todayKg = S.weights[t];
  const lastKg = m ? m.last.kg : S.startWeight;
  const v = todayKg ?? lastKg;
  // Reta diese Woche
  let doseCard = '';
  if (S.doseTracking) {
    const n = S.doses.filter(d => weekStart(d.date) === weekStart(t)).length;
    const pct = Math.min(100, n / S.schedule * 100);
    const lastDose = S.doses.length ? S.doses[S.doses.length - 1] : null;
    const done = n >= S.schedule, st = doseStatus();
    doseCard = `<button class="card stack" data-a="tab" data-v="einnahme" style="text-align:left">
      <div class="between"><b style="font-size:15px">Reta diese Woche</b><span class="dstat ${st.kind}">${esc(st.text)}</span></div>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <div class="sub">${n} von ${S.schedule} diese Woche · ${S.doseDays.map(d => WD[d - 1]).join(' + ')}</div>
      <div class="sub">${lastDose ? `Letzte Einnahme: ${esc(toDate(lastDose.date).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' }))} · ${mgIu(lastDose.mg)}` : 'Noch keine Einnahme eingetragen'}</div>
    </button>`;
  }

  // Ziel-Fortschritt
  let goal = '';
  if (m && S.targetWeight != null && Math.abs(m.start - S.targetWeight) > .05) {
    const p = Math.max(0, Math.min(1, (m.start - m.cur) / (m.start - S.targetWeight)));
    goal = `<div class="stack" style="gap:8px;margin-top:4px">
      <div class="between"><span class="sub">Zum Ziel ${f1(S.targetWeight)} kg</span><span style="font-size:13px;font-weight:700">${Math.round(p * 100)} % · noch ${f1(Math.abs(S.targetWeight - m.cur))} kg</span></div>
      <div class="progress"><i style="width:${p * 100}%"></i></div>
    </div>`;
  }

  // Vergleich mit dem letzten Eintrag vor heute
  const prev = m ? [...m.e].reverse().find(p => p.date < t) : null;
  let delta = '';
  if (prev && v != null) {
    const d = v - prev.kg;
    const good = S.goal === 'gain' ? d > 0.04 : S.goal === 'lose' ? d < -0.04 : Math.abs(d) <= .3;
    delta = `<div class="weigh-delta"><span class="${good ? 'lime' : ''}" style="font-weight:700">${signed(d)} kg</span><span class="sub">zum ${daysBetween(prev.date, t) === 1 ? 'Vortag' : esc(shortDate(prev.date))} (${f1(prev.kg)} kg)</span></div>`;
  }
  // Tage in Folge eingetragen
  let streak = 0;
  for (let d = S.weights[t] != null ? t : addDays(t, -1); S.weights[d] != null; d = addDays(d, -1)) streak++;

  const [n0, d0] = m ? signed(m.pct).split(',') : ['±0', '0'];
  let dueBanner = '';
  if (S.doseTracking) {
    const ds = doseStatus();
    if (ds.kind === 'due' || ds.kind === 'late') {
      const lastMg = S.doses.length ? S.doses[S.doses.length - 1].mg : null;
      dueBanner = `<button class="due-banner ${ds.kind}" data-a="tab" data-v="einnahme">
        <span class="due-ic">${I.drop}</span>
        <span class="due-txt"><b>${ds.kind === 'due' ? 'Heute ist Einnahme-Tag' : 'Einnahme noch offen'}</b><span>${ds.kind === 'due' ? esc(S.compound) + (lastMg != null ? ' · zuletzt ' + mgIu(lastMg) : '') : esc(ds.text)}</span></span>
        <span class="due-go">Abhaken</span>
      </button>`;
    }
  }
  return `<section class="screen">
    <div class="top" style="margin-bottom:0">
      ${brand(true)}
      <button class="icon-btn" data-a="settings" aria-label="Einstellungen">${I.gear}</button>
    </div>
    <div class="sub" style="margin:-4px 0 4px">${esc(longDate(t))}</div>
    ${dueBanner}

    ${m ? `<div class="card glow stack" style="padding-bottom:12px">
      <div class="between"><span class="label">Dein Verlauf</span><span class="sub">${esc(periodLabel(m.days))}</span></div>
      <div class="row" style="align-items:flex-end;gap:14px">
        <div class="hero hero-sm"><span class="n">${n0},${d0}</span><span class="p">%</span></div>
        <b style="font-size:20px;letter-spacing:-.5px;margin-bottom:4px">${signed(m.change)} kg</b>
      </div>
      ${m.e.length > 1 ? chartBlock(m, 'hchart') : '<div class="empty" style="padding:26px 10px">Ab dem 2. Eintrag siehst du hier deine Kurve.</div>'}
      ${goal}
    </div>
    <div class="stats3">
      <div class="stat"><b>${f1(m.cur)}</b><span>Ø 7 Tage</span></div>
      <div class="stat"><b>${m.perWeek != null ? signed(m.perWeek) : '–'}</b><span>kg / Woche</span></div>
      <div class="stat streak ${streak >= 3 ? 'hot' : ''} ${streak === 0 ? 'cold' : ''}">
        <div class="streak-top">
        <span class="flame" aria-hidden="true"><svg viewBox="0 0 24 24"><defs>
          <linearGradient id="fl1" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#FF5A1F"/><stop offset=".55" stop-color="#FF9F1C"/><stop offset="1" stop-color="#FFD25A"/></linearGradient>
          <linearGradient id="fl2" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#FFE7A3"/><stop offset="1" stop-color="#FFF8E1"/></linearGradient></defs>
          <path class="fo" fill="url(#fl1)" d="M12 1.5c.9 3.3 4.9 5.6 5.6 10.1.7 4.6-2.4 8.9-5.6 8.9s-6.5-3-5.7-7.6c.4-2.4 1.8-3.9 2.9-5 .1 1.7.9 3 2.1 3.4-.6-3.6.2-6.9.7-9.8z"/>
          <path class="fi" fill="url(#fl2)" d="M12.1 11.2c.8 1.6 2.6 2.7 2.6 4.8a2.7 2.7 0 0 1-5.4.1c0-1.4.8-2.3 1.5-2.9.1.9.5 1.4 1 1.6-.2-1.3-.1-2.5.3-3.6z"/></svg></span>
        <b>${streak}</b></div>
        <span>${streak === 0 ? 'Streak starten' : (streak === 1 ? 'Tag' : 'Tage') + ' Streak'}</span>
      </div>
    </div>` : ''}

    <div class="card weigh stack">
      <div class="between">
        <div class="row" style="gap:10px"><span class="weigh-ic">${I.scale}</span><div><b style="font-size:16px">Gewicht heute</b><div class="sub">${esc(toDate(t).toLocaleDateString('de-DE', { weekday: 'long' }))}</div></div></div>
        ${todayKg != null ? `<span class="status-chip on">${I.check}Gespeichert</span>` : '<span class="status-chip">Noch offen</span>'}
      </div>
      <div class="weigh-main">
        <button class="step" data-a="w-step" data-v="-0.1" aria-label="0,1 kg weniger">−</button>
        <div class="weigh-val"><input id="w-in" inputmode="decimal" value="${v != null ? esc(f1(v)) : ''}" placeholder="0,0" aria-label="Gewicht in kg"><span>kg</span></div>
        <button class="step" data-a="w-step" data-v="0.1" aria-label="0,1 kg mehr">+</button>
      </div>
      ${delta}
      <button class="btn" data-a="w-save">${todayKg != null ? 'Gewicht ändern' : 'Gewicht speichern'}</button>
    </div>
    ${newLibCard()}
    ${doseCard}
    ${m ? `<button class="btn ghost" data-a="share">${I.share.replace('<svg', '<svg width="20" height="20"')} Share-Karte erstellen</button>` : ''}
  </section>`;
}

/* ---------- Backup-Erinnerung ---------- */
function backupAgo() {
  if (!S.lastBackup) return 'nie';
  const d = daysBetween(iso(new Date(S.lastBackup)), today());
  return d === 0 ? 'heute' : d === 1 ? 'gestern' : `vor ${d} Tagen`;
}
function backupCard() {
  if (ui.demo || !S.onboarded) return '';
  const hasData = Object.keys(S.weights).length > 1 || S.doses.length || photos.length;
  if (!hasData) return '';
  const days = S.lastBackup ? daysBetween(iso(new Date(S.lastBackup)), today()) : null;
  if (days != null && days < 7) return '';
  return `<div class="card backup-card">
    <div class="row" style="gap:12px;align-items:flex-start">
      <span class="bk-ic">${I.share}</span>
      <div style="flex:1;min-width:0"><b style="font-size:15px">Daten sichern</b>
        <div class="sub" style="margin-top:2px">Deine Daten liegen nur auf diesem iPhone. Letztes Backup: ${esc(backupAgo())}.</div></div>
    </div>
    <button class="btn small" data-a="export" style="width:100%;margin-top:12px;height:44px">Jetzt sichern</button>
  </div>`;
}

/* ---------- Chart-Seite ---------- */
/* Zeitraster: Täglich, Wöchentlich, Monatlich */
function tfSeries(m) {
  if (ui.tf === 'W' || ui.tf === 'M') {
    const g = {};
    m.e.forEach(p => { const k = ui.tf === 'W' ? weekStart(p.date) : p.date.slice(0, 7) + '-01'; (g[k] ||= []).push(p.kg); });
    return Object.keys(g).sort().map(k => ({ date: k, kg: g[k].reduce((s, v) => s + v, 0) / g[k].length, n: g[k].length }));
  }
  return m.e.map(p => ({ date: p.date, kg: p.kg }));
}
function tfSeg() {
  const b = (k, l) => `<button class="${ui.tf === k ? 'on' : ''}" data-a="tf" data-v="${k}">${l}</button>`;
  return `<div class="seg seg-sm">${b('D', 'Täglich')}${b('W', 'Wöchentlich')}${b('M', 'Monatlich')}</div>`;
}
function isoWeek(s) {
  const d = toDate(s); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - w1) / DAY - 3 + ((w1.getDay() + 6) % 7)) / 7);
}
const goodDir = d => S.goal === 'gain' ? d > 0.04 : S.goal === 'lose' ? d < -0.04 : Math.abs(d) <= .3;
const startWeight = m => S.startWeight ?? m.e[0].kg;

// Großer Chart: Linie durch die Werte, kg-Skala, Daten unten, Startgewicht als Linie
function bigChartSVG(e, sel, start) {
  const w = 390, h = 290, padL = 42, padR = 18, padT = 14, padB = 26;
  const t0 = toDate(e[0].date).getTime(), t1 = toDate(e[e.length - 1].date).getTime();
  const span = Math.max(t1 - t0, DAY);
  let lo = Math.min(...e.map(p => p.kg), start), hi = Math.max(...e.map(p => p.kg), start);
  const raw = (hi - lo) / 4 || .5;
  const step = [.2, .5, 1, 2, 2.5, 5, 10].find(s => s >= raw) || 10;
  lo = Math.floor((lo - step * .15) / step) * step; hi = Math.ceil((hi + step * .15) / step) * step;
  const X = d => padL + (e.length === 1 ? (w - padL - padR) / 2 : (toDate(d).getTime() - t0) / span * (w - padL - padR));
  const Y = v => padT + (hi - v) / (hi - lo) * (h - padT - padB);
  const plotB = h - padB;
  const lab = d => ui.tf === 'M' ? toDate(d).toLocaleDateString('de-DE', { month: 'short' }) : shortDate(d);

  let grid = '';
  for (let v = lo; v <= hi + 1e-6; v += step) {
    const y = Y(v).toFixed(1);
    grid += `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="#262B35" stroke-dasharray="2 4"/>
      <text x="${padL - 8}" y="${(+y + 3.5).toFixed(1)}" text-anchor="end">${esc(f1(v))}</text>`;
  }
  let axis = '';
  if (e.length === 1) axis = `<text x="${X(e[0].date).toFixed(1)}" y="${plotB + 17}" text-anchor="middle">${esc(lab(e[0].date))}</text>`;
  else {
    const nx = Math.min(4, e.length);
    for (let k = 0; k < nx; k++) {
      const idx = Math.round(k * (e.length - 1) / (nx - 1));
      axis += `<text x="${X(e[idx].date).toFixed(1)}" y="${plotB + 17}" text-anchor="${k === 0 ? 'start' : k === nx - 1 ? 'end' : 'middle'}">${esc(lab(e[idx].date))}</text>`;
    }
  }
  const sy = Y(start).toFixed(1);
  const startLine = `<line x1="${padL}" y1="${sy}" x2="${w - padR}" y2="${sy}" stroke="#fff" stroke-opacity=".28" stroke-dasharray="4 4"/>
    <text x="${w - padR}" y="${(+sy - 6).toFixed(1)}" text-anchor="end" fill="#C9CED6" font-weight="600">Start ${esc(f1(start))} kg</text>`;

  const pts = e.map(p => [X(p.date), Y(p.kg)]);
  chartXs = pts.map(p => p[0]);
  chartPts = pts;
  const line = pts.length > 1 ? 'M' + pts.map(q => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join(' L') : '';
  const last = pts[pts.length - 1];
  const area = line ? `${line} L${last[0].toFixed(1)},${plotB} L${pts[0][0].toFixed(1)},${plotB} Z` : '';
  const dots = e.length <= 45 ? e.map((p, k) => `<circle cx="${pts[k][0].toFixed(1)}" cy="${pts[k][1].toFixed(1)}" r="2.6"/>`).join('') : '';
  const i = sel == null || sel >= e.length ? e.length - 1 : sel;
  const sp = pts[i], sx = sp[0].toFixed(1);
  const marker = `<line class="mk-l" x1="${sx}" y1="${padT}" x2="${sx}" y2="${plotB}" stroke="#fff" stroke-opacity=".35" stroke-dasharray="2 3"/>
    <circle class="mk-h" cx="${sx}" cy="${sp[1].toFixed(1)}" r="11" fill="#3DDC97" fill-opacity=".22"/><circle class="mk-c" cx="${sx}" cy="${sp[1].toFixed(1)}" r="5.5" fill="#3DDC97" stroke="#0E1014" stroke-width="2"/>`;
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Gewichtsverlauf" font-family="-apple-system, BlinkMacSystemFont, Inter, sans-serif">
    <defs>
      <linearGradient id="bf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3DDC97" stop-opacity=".24"/><stop offset="1" stop-color="#3DDC97" stop-opacity="0"/></linearGradient>
      <filter id="bg2" x="-10%" y="-40%" width="120%" height="180%"><feGaussianBlur stdDeviation="6"/></filter>
    </defs>
    <g font-size="10" font-weight="500" fill="#98A1B0">${grid}${axis}</g>
    <g font-size="10">${startLine}</g>
    ${area ? `<path d="${area}" fill="url(#bf)"/>` : ''}
    ${line ? `<path d="${line}" fill="none" stroke="#3DDC97" stroke-width="6" stroke-linejoin="round" filter="url(#bg2)" opacity=".35"/>` : ''}
    ${line ? `<path d="${line}" fill="none" stroke="#3DDC97" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>` : ''}
    <g fill="#3DDC97">${dots}</g>
    ${marker}
  </svg>`;
}
function chartInfo(e, sel) {
  const i = sel == null || sel >= e.length ? e.length - 1 : sel;
  const p = e[i];
  let when;
  if (ui.tf === 'W') when = `KW ${isoWeek(p.date)} · ${shortDate(p.date)} – ${shortDate(addDays(p.date, 6))}`;
  else if (ui.tf === 'M') when = toDate(p.date).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  else when = toDate(p.date).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  return `<div class="ci-date">${esc(when)}</div>
    <div class="ci-vals"><div><b style="font-size:20px">${ui.tf === 'D' ? '' : 'Ø '}${f1(p.kg)} kg</b></div></div>`;
}
function chartBlock(m, id) {
  const e = tfSeries(m);
  const sel = ui.sel != null && ui.sel < e.length ? ui.sel : null;
  return `${tfSeg()}
      <div class="chart-info" id="${id}-info">${chartInfo(e, sel)}</div>
      <div class="chart-wrap tight" id="${id}">${bigChartSVG(e, sel, startWeight(m))}</div>`;
}

function screenChart() {
  const m = metrics();
  if (!m) return `<section class="screen"><div class="top"><h1>Chart</h1></div><div class="empty">Noch keine Einträge. Trag unter „Home" dein Gewicht ein.</div></section>`;
  const kgs = m.e.map(p => p.kg);

  // Historie (alle Einträge, neueste zuerst, nach Monat gruppiert)
  const all = [...m.e].reverse();
  const shown = ui.histAll ? all : all.slice(0, 21);
  let hist = '', month = '';
  const doseOn = {};
  S.doses.forEach(d => { doseOn[d.date] = (doseOn[d.date] ? doseOn[d.date] + ' + ' : '') + fmg(d.mg) + ' mg'; });
  shown.forEach(p => {
    const mo = toDate(p.date).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    if (mo !== month) { month = mo; hist += `<div class="h-month">${esc(mo)}</div>`; }
    const idx = m.e.findIndex(q => q.date === p.date);
    const prev = idx > 0 ? m.e[idx - 1] : null;
    const d = prev ? p.kg - prev.kg : null;
    hist += `<div class="h-row ${S.doseTracking ? 'with-mg' : ''}">
      <div class="h-date"><b>${esc(toDate(p.date).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' }))}</b><span>${esc(toDate(p.date).toLocaleDateString('de-DE', { weekday: 'short' }))}</span></div>
      <b class="h-kg">${f1(p.kg)} kg</b>
      <span class="h-d ${d != null && goodDir(d) ? 'lime' : ''}">${d != null ? signed(d) : '–'}</span>
      ${S.doseTracking ? `<span class="h-mg">${doseOn[p.date] ? esc(doseOn[p.date]) : ''}</span>` : ''}
      <button class="x-btn" data-a="entry-del" data-v="${p.date}" aria-label="Eintrag vom ${esc(shortDate(p.date))} löschen">${I.x}</button>
    </div>`;
  });

  return `<section class="screen">
    <div class="top">
      <h1>Chart</h1>
      <button class="icon-btn" data-a="share" aria-label="Share-Karte erstellen">${I.share}</button>
    </div>

    <div class="card glow stack" style="gap:10px;padding:16px 14px 12px">
      ${chartBlock(m, 'chart')}
    </div>

    <div class="grid2">
      <div class="stat"><span>Seit Start</span><b class="${goodDir(m.change) ? 'lime' : ''}">${signed(m.change)} kg</b></div>
      <div class="stat"><span>Ø pro Woche</span><b>${m.perWeek != null ? signed(m.perWeek) + ' kg' : '–'}</b></div>
      <div class="stat"><span>Tiefster / höchster Wert</span><b>${f1(Math.min(...kgs))} / ${f1(Math.max(...kgs))}</b></div>
      <div class="stat"><span>${m.toGoal != null ? 'Noch bis Ziel' : 'Seit Start gesamt'}</span><b class="lime">${m.toGoal != null ? f1(Math.abs(m.toGoal)) + ' kg' : signed(m.change) + ' kg'}</b></div>
    </div>

    <div class="card tight">
      <div class="between"><b style="font-size:15px">Historie</b><button class="btn small ghost" data-a="entries" style="height:36px">${I.plus.replace('<svg', '<svg width="16" height="16"')} Nachtragen</button></div>
      <div class="h-row h-head ${S.doseTracking ? 'with-mg' : ''}"><span>Datum</span><span>Gewicht</span><span style="text-align:right">Δ</span>${S.doseTracking ? '<span style="text-align:right">Reta</span>' : ''}<span></span></div>
      ${hist}
      ${all.length > shown.length ? `<button class="link-btn" data-a="hist-all" style="width:100%;justify-content:center">Alle ${all.length} Einträge anzeigen</button>` : ''}
    </div>
  </section>`;
}

// Gewichtsveränderung seit der ersten Einnahme und je Dosis-Phase
function doseImpact() {
  const m = metrics();
  if (!m || !S.doses.length) return null;
  const e = m.e;
  const at = d => { let p = null; for (const q of e) { if (q.date <= d) p = q; else break; } return (p || e[0]).avg; };
  const ds = [...S.doses].sort((a, b) => (a.date < b.date ? -1 : 1));
  const t = today();
  const start = ds[0].date;
  const w0 = at(start), w1 = m.cur, days = Math.max(0, daysBetween(start, t));
  // zusammenhängende Phasen gleicher Menge
  const phases = [];
  ds.forEach(d => { const last = phases[phases.length - 1]; if (!last || last.mg !== d.mg) phases.push({ mg: d.mg, from: d.date }); });
  phases.forEach((p, i) => {
    p.to = i + 1 < phases.length ? phases[i + 1].from : t;
    p.days = Math.max(1, daysBetween(p.from, p.to));
    p.delta = at(p.to) - at(p.from);
    p.perWeek = p.days >= 7 ? p.delta / (p.days / 7) : null;
  });
  return { start, days, delta: w1 - w0, pct: (w1 - w0) / w0 * 100, perWeek: days >= 7 ? (w1 - w0) / (days / 7) : null, phases };
}
function impactCard() {
  const r = doseImpact();
  if (!r) return `<div class="card stack"><span class="label">Seit erster Einnahme</span><div class="sub">Sobald du eine Einnahme und dein Gewicht einträgst, siehst du hier, wie sich dein Gewicht seitdem verändert hat.</div></div>`;
  const [n, d] = signed(r.delta).split(',');
  return `<div class="card glow stack">
    <div class="between"><span class="label">Seit 1. Einnahme</span><span class="sub">${esc(periodLabel(r.days))} · seit ${esc(shortDate(r.start))}</span></div>
    <div class="row" style="align-items:flex-end;gap:14px">
      <div class="hero hero-sm"><span class="n">${n},${d}</span><span class="p">kg</span></div>
      <div style="margin-bottom:6px"><b style="font-size:18px">${signed(r.pct)} %</b><div class="sub">${r.perWeek != null ? signed(r.perWeek) + ' kg / Woche' : 'noch unter 1 Woche'}</div></div>
    </div>
  </div>`;
}

// IU = Einheiten auf einer U-100-Spritze (100 IU = 1 ml). Hängt von der eigenen Mischung ab.
const iuPerMg = () => (S.mix && S.mix.mg > 0 && S.mix.ml > 0) ? 100 * S.mix.ml / S.mix.mg : null;
const fiu = n => (Math.round(n * 10) / 10).toLocaleString('de-DE', { maximumFractionDigits: 1 });
const iu = mg => { const k = iuPerMg(); return k && mg != null ? fiu(mg * k) : null; };
const mgIu = mg => fmg(mg) + ' mg' + (iu(mg) ? ' · ' + iu(mg) + ' IU' : '');
const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const isoDay = d => toDate(d).getDay() || 7;
const wdLong = d => toDate(d).toLocaleDateString('de-DE', { weekday: 'long' });
function fixDays() {
  if (!Array.isArray(S.doseDays) || !S.doseDays.length) S.doseDays = S.schedule === 1 ? [1] : [1, 4];
  S.doseDays = [...new Set(S.doseDays)].sort((a, b) => a - b);
  S.schedule = S.doseDays.length;
  if (!S.mix || !(S.mix.mg > 0) || !(S.mix.ml > 0)) S.mix = { mg: 10, ml: 1 };
}
// Status der Einnahme: fällig, überfällig, erledigt oder nächster Termin
function doseStatus() {
  const t = today(), plan = d => S.doseDays.includes(isoDay(d));
  const past = S.doses.filter(d => d.date <= t).map(d => d.date).sort();
  const last = past[past.length - 1];
  if (last === t) return { kind: 'done', text: 'Heute erledigt' };
  // Der letzte Eintrag deckt seinen Plantag ab (auch 1 Tag zu früh genommen)
  let from = t;
  if (last) { const cov = !plan(last) && plan(addDays(last, 1)) ? addDays(last, 1) : last; from = addDays(cov, 1); }
  let n = from;
  while (!plan(n)) n = addDays(n, 1);
  if (n === t) return { kind: 'due', text: 'Heute fällig' };
  if (n < t) return { kind: 'late', text: `Offen seit ${wdLong(n)}` };
  const diff = daysBetween(t, n);
  return { kind: 'next', text: diff === 1 ? 'Nächste: morgen' : `Nächste: ${wdLong(n)}`, date: n };
}

function screenEinnahme() {
  const t = today(), ws = weekStart(t), st = doseStatus();
  const week = S.doses.filter(d => weekStart(d.date) === ws).sort((a, b) => (a.date < b.date ? -1 : 1));
  const slots = [];
  const total = Math.max(S.schedule, week.length);
  let openShown = false;
  const slotDay = i => { const d = S.doseDays[i]; return d ? 'geplant ' + ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'][d - 1] : 'offen'; };
  for (let i = 0; i < total; i++) {
    const d = week[i];
    if (d) {
      slots.push(`<div class="card tight"><div class="row">
        <span class="check done">${I.check}</span>
        <div style="flex:1;min-width:0"><b style="font-size:15px">${i + 1}. Einnahme · ${esc(toDate(d.date).toLocaleDateString('de-DE', { weekday: 'long' }))}</b>
        <div class="sub">${mgIu(d.mg)}${d.note ? ' · ' + esc(d.note) : ''}</div></div>
        <button class="x-btn" data-a="dose-del" data-v="${d.id}" aria-label="Eintrag löschen">${I.x}</button>
      </div></div>`);
    } else if (!openShown) {
      openShown = true;
      const lastMg = S.doses.length ? S.doses[S.doses.length - 1].mg : null;
      slots.push(`<div class="card stack" style="border-color:#1F5C44">
        <div class="row"><span class="check"></span><div><b style="font-size:15px">${i + 1}. Einnahme</b><div class="sub">${esc(slotDay(i))}</div></div></div>
        <div class="grid2">
          <div class="field"><label for="dose-mg">Menge (mg)</label><input id="dose-mg" inputmode="decimal" placeholder="dein Eintrag" value="${lastMg != null ? esc(fmg(lastMg)) : ''}"><span class="iu-live" id="dose-iu">${lastMg != null && iu(lastMg) ? '= ' + iu(lastMg) + ' IU' : ''}</span></div>
          <div class="field"><label for="dose-date">Datum</label><input id="dose-date" type="date" value="${t}" max="${t}"></div>
        </div>
        <button class="mix-line" data-a="mix">${iuPerMg() ? `1 mg = ${fiu(iuPerMg())} IU · 2 mg = ${fiu(2 * iuPerMg())} IU` : 'Mischung eintragen, um IU zu sehen'}<span>ändern</span></button>
        <div class="field"><label for="dose-note">Notiz / Nebenwirkungen (optional)</label><input id="dose-note" placeholder="z. B. Übelkeit 3/10, Appetit niedrig"></div>
        <button class="btn" data-a="dose-add">Als genommen abhaken</button>
      </div>`);
    } else {
      slots.push(`<div class="card tight"><div class="row"><span class="check"></span><div><b style="font-size:15px">${i + 1}. Einnahme</b><div class="sub">${esc(slotDay(i))}</div></div></div></div>`);
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
    ${impactCard()}
    <div class="card stack">
      <div class="between"><b style="font-size:15px">Einnahme-Tage</b><span class="dstat ${st.kind}">${esc(st.text)}</span></div>
      <div class="days">${WD.map((w, i) => `<button class="${S.doseDays.includes(i + 1) ? 'on' : ''}" data-a="day" data-v="${i + 1}" aria-pressed="${S.doseDays.includes(i + 1)}">${w}</button>`).join('')}</div>
      ${Cloud.on ? `<button class="remind-row" data-a="remind"><span class="rm-ic">${I.bell}</span><span class="rm-txt">Erinnerung</span><span class="rm-val ${S.remind?.on ? 'on' : ''}">${S.remind?.on ? esc(S.remind.time) + ' Uhr' : 'Aus'}</span><span class="ct-go">›</span></button>` : ''}
    </div>
    ${slots.join('')}
    <div class="card stack">
      <div class="between"><b style="font-size:15px">Wochenziel</b><span class="lime" style="font-size:13px;font-weight:700">${week.length} von ${S.schedule}</span></div>
      <div class="progress"><i style="width:${Math.min(100, week.length / S.schedule * 100)}%"></i></div>
    </div>
    ${contactCard()}
    <div class="card stack">
      <b style="font-size:15px">Letzte 12 Wochen</b>
      <div class="weekbars">${bars.join('')}</div>
      <div class="sub">Hellgrün: Wochenziel erreicht · Dunkelgrün: teilweise</div>
    </div>
    ${hist.length ? `<div class="card tight"><div class="between"><b style="font-size:15px">Verlauf</b><button class="conv" data-a="mix">${iuPerMg() ? `1 mg = ${fiu(iuPerMg())} IU` : 'IU einrichten'}</button></div>${hist.map(d => `<div class="list-row hist-row"><div class="lr-main"><span class="muted">${esc(shortDate(d.date))}</span><span style="font-weight:600">${fmg(d.mg)} mg${iu(d.mg) ? ` <span class="muted">= ${iu(d.mg)} IU</span>` : ''}</span></div>${d.note ? `<div class="lr-note">${esc(d.note)}</div>` : ''}</div>`).join('')}</div>` : ''}
    <p class="note">Die App gibt keine Dosis vor. Du trägst nur ein, was du selbst genommen hast.</p>
  </section>`;
}

function screenFotos() {
  const list = [...photos].sort((a, b) => (a.date < b.date ? 1 : -1));
  const [b, a] = comparePair();
  return `<section class="screen">
    <div class="top"><h1>Fotos</h1><button class="icon-btn" data-a="ph-add" aria-label="Foto hinzufügen">${I.plus}</button></div>
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

/* ---------- Retatrutid: Texte und Studien (nur lesen) ----------
   Inhalte kommen aus content/retatrutid.md im Repo. Nur Maxim pflegt die Datei,
   alle Nutzer sehen denselben Stand. */
let lib = { state: 'idle', items: [] };
function parseLib(md) {
  md = md.replace(/<!--[\s\S]*?-->/g, '');
  return md.split(/^\s*---\s*$/m).map(block => {
    const lines = block.trim().split('\n');
    if (!lines[0] || !lines[0].startsWith('#')) return null;
    const it = { title: lines[0].replace(/^#+\s*/, '').trim(), type: 'text', date: '', link: '', who: '', body: '' };
    let i = 1;
    for (; i < lines.length; i++) {
      const m = /^\s*(typ|datum|link|untersucht)\s*:\s*(.*)$/i.exec(lines[i]);
      if (!m) break;
      const k = m[1].toLowerCase(), v = m[2].trim();
      if (k === 'typ') it.type = /stud/i.test(v) ? 'study' : 'text';
      if (k === 'datum') it.date = v;
      if (k === 'link') it.link = /^https?:\/\//i.test(v) ? v : (v ? 'https://' + v : '');
      if (k === 'untersucht') it.who = v;
    }
    it.body = lines.slice(i).join('\n').trim();
    it.id = 'l' + Math.abs([...it.title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7));
    return it;
  }).filter(Boolean);
}
async function loadLib() {
  if (lib.state === 'loading') return;
  lib.state = 'loading';
  try {
    if (Cloud.user) {
      const { data, error } = await Cloud.sb.from('library').select('id, type, title, date, link, population, body, pinned')
        .eq('published', true).order('pinned', { ascending: false }).order('date', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false });
      if (error) throw error;
      const items = data.map(x => ({ id: 'l' + x.id, title: x.title, type: x.type === 'studie' ? 'study' : 'text', date: x.date || '',
        link: x.link ? (/^https?:\/\//i.test(x.link) ? x.link : 'https://' + x.link) : '', who: x.population || '', body: x.body || '', pinned: !!x.pinned }));
      items.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));   // Angepinntes immer oben
      lsSet('kinetic-lib', JSON.stringify(items));
      lib = { state: 'ok', items };
    } else {
      const r = await fetch('content/retatrutid.md', { cache: 'no-cache' });
      if (!r.ok) throw new Error(r.status);
      lib = { state: 'ok', items: parseLib(await r.text()) };
    }
  } catch (e) {
    let cached = null; try { cached = JSON.parse(lsGet('kinetic-lib') || 'null'); } catch (x) { /* egal */ }
    lib = cached ? { state: 'ok', items: cached } : { state: 'error', items: lib.items };
  }
  // Beim ersten Mal alles als gelesen merken (neue Nutzer sehen kein „Neu“ für alte Inhalte)
  if (lib.state === 'ok' && !Array.isArray(S.libSeen) && !ui.demo) { S.libSeen = lib.items.map(i => i.id); save(); }
  if (ui.tab === 'wissen' && unseen().length) markLibSeen();
  if (ui.tab === 'wissen' || ui.tab === 'heute') safeRender();
}
// Neue, noch nicht angesehene Inhalte
const unseen = () => Array.isArray(S.libSeen) ? lib.items.filter(i => !S.libSeen.includes(i.id)) : [];
function markLibSeen(ids) {
  const add = ids || lib.items.map(i => i.id);
  const before = (S.libSeen || []).length;
  S.libSeen = [...new Set([...(S.libSeen || []), ...add])];
  if (S.libSeen.length !== before && !ui.demo) save();
}
// Text sicher anzeigen: Absätze, Aufzählungen, **fett**, Links klickbar
function richText(t) {
  const inline = x => esc(x)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  return t.split(/\n\s*\n/).map(par => {
    const ls = par.split('\n');
    if (ls.every(l => /^\s*[-•]\s+/.test(l))) return `<ul>${ls.map(l => `<li>${inline(l.replace(/^\s*[-•]\s+/, ''))}</li>`).join('')}</ul>`;
    return `<p>${ls.map(inline).join('<br>')}</p>`;
  }).join('');
}
const libDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) ? toDate(d).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' }) : d;

function newLibCard() {
  const n = unseen();
  if (!n.length) return '';
  const it = n[0];
  return `<button class="card new-lib" data-a="lib-new" data-v="${it.id}">
    <span class="nl-ic">${I.book}</span>
    <span class="nl-txt"><span class="nl-kick">Neu in Studies${n.length > 1 ? ` · ${n.length}` : ''}</span><b>${esc(it.title)}</b></span>
    <span class="ct-go">›</span></button>`;
}
function screenWissen() {
  if (lib.state === 'idle') loadLib();
  const f = ui.libFilter || 'all';
  const items = lib.items.filter(it => f === 'all' || it.type === f);
  const seg = (k, l) => `<button class="${f === k ? 'on' : ''}" data-a="lib-filter" data-v="${k}">${l}</button>`;
  let body;
  if (lib.state === 'loading' && !lib.items.length) body = '<div class="empty">Lädt …</div>';
  else if (lib.state === 'error' && !lib.items.length) body = '<div class="empty">Inhalte konnten nicht geladen werden. Prüf deine Internetverbindung.</div>';
  else if (!items.length) body = `<div class="empty">${lib.items.length ? 'In dieser Kategorie gibt es noch nichts.' : 'Hier erscheinen bald Texte und Studien.'}</div>`;
  else body = items.map(it => {
    const preview = it.body.replace(/\*\*/g, '').replace(/\s+/g, ' ').slice(0, 140);
    return `<button class="card lib-item${it.pinned ? ' pinned' : ''}" data-a="lib-open" data-v="${it.id}">
      <div class="row" style="gap:8px">${it.pinned ? `<span class="lib-pin">${I.pin} Angepinnt</span>` : ''}<span class="lib-type ${it.type}">${it.type === 'study' ? 'Studie' : 'Text'}</span>${it.date ? `<span class="sub">${esc(libDate(it.date))}</span>` : ''}</div>
      <h3>${esc(it.title)}</h3>
      ${it.who ? `<div class="lib-who">${esc(it.who)}</div>` : ''}
      ${preview ? `<p>${esc(preview)}${it.body.length > 140 ? ' …' : ''}</p>` : ''}
      <span class="lib-more">${it.body ? 'Weiterlesen' : 'Öffnen'}${it.link ? ' · mit Quelle' : ''}</span>
    </button>`;
  }).join('');
  return `<section class="screen">
    <div class="top"><div><div class="sub">Texte & Studien</div><h1>Peptide Studies</h1></div></div>
    <div class="seg">${seg('all', 'Alle')}${seg('text', 'Texte')}${seg('study', 'Studien')}</div>
    ${body}
    <p class="note">Nur zur Information. Kein Ersatz für ärztlichen Rat und keine Dosierungsempfehlung.</p>
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
        <div class="setting"><div><b>Backup sichern</b><small>${S.lastBackup ? 'Letztes: ' + esc(backupAgo()) : 'Noch nie gesichert'} · inkl. Fotos</small></div><button class="btn small ghost" data-a="export">Sichern</button></div>
        <div class="setting"><div><b>Backup wiederherstellen</b><small>ersetzt die aktuellen Daten</small></div><button class="btn small ghost" data-a="import">Laden</button></div>
      </div>
      ${!Cloud.on || Cloud.profile?.is_admin || ui.demo ? `<div class="card tight">
        <div class="setting"><div><b>Demo-Daten (Test)</b><small>12 Wochen Beispieldaten anzeigen. Deine echten Daten bleiben unverändert.</small></div>
          <button class="switch ${ui.demo ? 'on' : ''}" role="switch" aria-checked="${!!ui.demo}" aria-label="Demo-Daten" data-a="demo"></button></div>
      </div>` : ''}
      ${contactCard()}
      ${Cloud.user ? `<div class="card tight">
        <div class="setting"><div><b>${Cloud.profile ? esc(Cloud.profile.first_name + ' ' + Cloud.profile.last_name) : 'Account'}</b><small>${Cloud.profile ? esc(Cloud.profile.code) + ' · ' : ''}${lsGet('kinetic-dirty') === '1' ? 'wird synchronisiert …' : 'gespeichert'}</small></div><button class="btn small ghost" data-a="logout">Abmelden</button></div>
      </div>` : ''}
      ${ui.demo ? '' : '<button class="btn danger" data-a="reset">Alle Daten löschen</button>'}
      ${Cloud.user && !ui.demo ? '<button class="btn danger" data-a="delete-account">Account löschen</button>' : ''}`;
  } else if (s.type === 'remind') {
    const on = !!S.remind?.on;
    const block = !pushSupported() || (isIOS() && !isStandalone())
      ? 'Erinnerungen funktionieren auf dem iPhone nur in der App vom Home-Bildschirm (ab iOS 16.4), nicht in Safari.'
      : (Notification.permission === 'denied' ? 'Mitteilungen sind für Kinetic blockiert. Erlaube sie in den iPhone-Einstellungen → Mitteilungen → Kinetic.' : '');
    body = `<div class="ct-head"><span class="ct-big">${I.bell}</span><h2>Erinnerung</h2><p class="sub">Push-Benachrichtigung an deinen Einnahme-Tagen (${S.doseDays.map(d => WD[d - 1]).join(' + ')}), nur solange die Einnahme noch offen ist.</p></div>
      <div class="card tight">
        <div class="setting"><div><b>Erinnern</b><small>${on ? 'aktiv' : 'aus'}</small></div>
          <button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" aria-label="Erinnerung" data-a="remind-toggle" ${block ? 'disabled' : ''}></button></div>
        <div class="setting"><div><b>Uhrzeit</b><small>an Einnahme-Tagen</small></div>
          <input type="time" id="rm-time" class="time-in" value="${esc(S.remind?.time || '09:00')}" step="300"></div>
      </div>
      ${block ? `<p class="note warn-note">${block}</p>` : ''}
      ${on && !block ? '<button class="btn ghost" data-a="remind-test">Test-Benachrichtigung senden</button>' : ''}
      <p class="note">Auf dem Sperrbildschirm steht nur „Heute ist Einnahme-Tag“, kein Wirkstoff.</p>`;
  } else if (s.type === 'contact') {
    const row = (href, cls, ic, t, sub) => href ? `<a class="ct-row ${cls}" href="${esc(href)}" target="_blank" rel="noopener">
        <span class="ct-ic">${ic}</span><span class="ct-txt"><b>${t}</b><span>${sub}</span></span><span class="ct-go">›</span></a>` : '';
    body = `<div class="ct-head"><span class="ct-big">${msgIcon}</span><h2>Retatrutid leer?</h2><p class="sub">Schreib Maxim direkt, er meldet sich bei dir.</p></div>
      <div class="stack">
        ${row(waLink(), 'wa', waIcon, 'WhatsApp', 'Chat öffnen')}
        ${row(tgLink(), 'tg', tgIcon, 'Telegram', '@' + esc(String(Cloud.contact?.tg || '').replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '')))}
      </div>`;
  } else if (s.type === 'mix') {
    const k = iuPerMg();
    body = `<h2>Deine Mischung</h2>
      <div class="grid2">
        <div class="field"><label for="mix-mg">Wirkstoff (mg)</label><input id="mix-mg" inputmode="decimal" placeholder="z. B. 10" value="${S.mix?.mg ? esc(fmg(S.mix.mg)) : ''}"></div>
        <div class="field"><label for="mix-ml">Wasser dazu (ml)</label><input id="mix-ml" inputmode="decimal" placeholder="z. B. 1" value="${S.mix?.ml ? esc(fmg(S.mix.ml)) : ''}"></div>
      </div>
      <div class="mix-prev" id="mix-prev">${k ? `1 mg = ${fiu(k)} IU · 2 mg = ${fiu(2 * k)} IU` : 'Trag beide Werte ein'}</div>
      <button class="btn" data-a="mix-save">Speichern</button>
      <p class="note">IU = Striche auf einer U-100-Insulinspritze (100 IU = 1 ml). Wie viele IU 1 mg sind, hängt nur davon ab, wie viel Wasser du ins Fläschchen gibst. Beispiel: 10 mg in 1 ml → 1 mg = 10 IU. 10 mg in 2 ml → 1 mg = 20 IU. Neues Fläschchen anders gemischt? Hier anpassen.</p>`;
  } else if (s.type === 'entries') {
    body = `<h2>Eintrag nachtragen</h2>
      <div class="grid2">
        <div class="field"><label for="en-date">Datum</label><input id="en-date" type="date" value="${addDays(today(), -1)}" max="${today()}"></div>
        <div class="field"><label for="en-kg">Gewicht (kg)</label><input id="en-kg" inputmode="decimal" placeholder="0,0"></div>
      </div>
      <button class="btn" data-a="entry-add">Eintragen</button>
      <p class="note">Gibt es für den Tag schon einen Eintrag, wird er ersetzt.</p>`;
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
    const isB = b && b.id === p.id, isA = a && a.id === p.id;
    body = `<div class="viewer"><img src="${p.url}" alt="${esc(p.phase)}"></div>
      <div class="pv-meta">
        <div><b style="font-size:16px">${esc(p.phase)}</b><div class="sub">${esc(longDate(p.date))}</div></div>
        <button class="pv-del" data-a="ph-del" data-v="${p.id}" aria-label="Foto löschen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg></button>
      </div>
      <div class="field"><label>Im Vergleich verwenden als</label>
        <div class="pv-role">
          <button class="${isB ? 'on' : ''}" data-a="ph-before" data-v="${p.id}">${isB ? I.check : ''}Vorher</button>
          <button class="${isA ? 'on' : ''}" data-a="ph-after" data-v="${p.id}">${isA ? I.check : ''}Nachher</button>
        </div>
      </div>`;
  } else if (s.type === 'lib') {
    const it = lib.items.find(x => x.id === s.id);
    if (!it) { ui.sheet = null; return ''; }
    body = `<div class="row" style="gap:8px"><span class="lib-type ${it.type}">${it.type === 'study' ? 'Studie' : 'Text'}</span>${it.date ? `<span class="sub">${esc(libDate(it.date))}</span>` : ''}</div>
      <h2 style="margin-top:-4px">${esc(it.title)}</h2>
      ${it.who ? `<div class="lib-box"><div class="label">Wer wurde untersucht</div><div>${esc(it.who)}</div></div>` : ''}
      ${it.body ? `<div class="reader">${richText(it.body)}</div>` : ''}
      ${it.link ? `<a class="btn ghost" href="${esc(it.link)}" target="_blank" rel="noopener">${I.ext} Quelle öffnen</a>` : ''}`;
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
        <button class="setting row-btn" data-a="share-photos" ${canPhotos ? '' : 'disabled'} role="switch" aria-checked="${!!(ui.share.photos && canPhotos)}"><div><b>Vorher/Nachher-Fotos</b><small>${canPhotos ? 'aus deinem Foto-Bereich' : 'erst 2 Fotos hinzufügen'}</small></div>
          <span class="switch ${ui.share.photos && canPhotos ? 'on' : ''}"></span></button>
        ${S.doseTracking ? `<button class="setting row-btn" data-a="share-compound" role="switch" aria-checked="${!!ui.share.compound}"><div><b>Wirkstoff auf Karte</b><small>Standard: aus</small></div>
          <span class="switch ${ui.share.compound ? 'on' : ''}"></span></button>` : ''}
      </div>
      <button class="btn" data-a="share-go" ${s.img ? '' : 'disabled'}>${I.share.replace('<svg', '<svg width="20" height="20"')} Teilen oder speichern</button>`;
  }
  return `<div class="sheet-bg" data-a="sheet-bg"><div class="sheet" role="dialog" aria-modal="true"><div class="grab-zone"><div class="grab"></div></div>${body}</div></div>`;
}

/* ---------- Render ---------- */
// Neu zeichnen, aber nie mitten im Tippen oder bei offenem Fenster (sonst springt alles / Eingabe weg)
let renderPending = false;
function safeRender() {
  const typing = document.activeElement?.matches?.('input, textarea');
  if (ui.sheet || typing) { renderPending = true; return; }
  renderPending = false; render();
}
document.addEventListener('focusout', () => setTimeout(() => { if (renderPending && !ui.sheet) safeRender(); }, 50));

function render() {
  const app = document.getElementById('app');
  if (isIOS() && !isStandalone() && !ui.instSkip && !Cloud.user) {
    app.innerHTML = screenInstall();
    document.getElementById('tabs').innerHTML = '';
  } else if (Cloud.on && !Cloud.user && !ui.offline) {
    app.innerHTML = screenAuth();
    document.getElementById('tabs').innerHTML = '';
  } else if (!S.onboarded) {
    app.innerHTML = screenOnboarding();
    document.getElementById('tabs').innerHTML = '';
  } else {
    if (ui.tab === 'einnahme' && !S.doseTracking) ui.tab = 'heute';
    const map = { heute: screenHeute, chart: screenChart, einnahme: screenEinnahme, fotos: screenFotos, wissen: screenWissen };
    app.innerHTML = map[ui.tab]();
    if (ui.dir) { app.firstElementChild?.classList.add('in-' + ui.dir); ui.dir = null; }
    if (ui.demo) app.firstElementChild?.insertAdjacentHTML('afterbegin', '<button class="demo-pill" data-a="demo">Demo-Daten aktiv · beenden</button>');
    const tabs = tabList();
    const newCount = unseen().length;
    document.getElementById('tabs').innerHTML = tabs.map(([k, l, ic]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-a="tab" data-v="${k}" aria-current="${ui.tab === k ? 'page' : 'false'}">${k === 'wissen' && newCount ? `<span class="tab-dot" aria-label="${newCount} neu"></span>` : ''}${ic}${l}</button>`).join('');
    if (ui.tab === 'chart') bindChart('chart', true);
    if (ui.tab === 'heute') bindChart('hchart', false);
  }
  renderSheet();
}
// Ist dasselbe Fenster schon offen, wird es nur aktualisiert: ohne erneute Einblend-Animation und an derselben Scroll-Position.
let openSheetType = null;
function renderSheet() {
  const host = document.getElementById('sheet');
  const same = ui.sheet && openSheetType === ui.sheet.type && host.querySelector('.sheet');
  const scroll = same ? host.querySelector('.sheet').scrollTop : 0;
  host.innerHTML = sheetHTML();
  openSheetType = ui.sheet ? ui.sheet.type : null;
  if (same) {
    host.querySelector('.sheet-bg')?.classList.add('stay');
    const sh = host.querySelector('.sheet'); if (sh) sh.scrollTop = scroll;
  }
  bindSheetDrag();
}

function tabList() {
  return [['heute', 'Home', I.home], ['chart', 'Chart', I.chart], ...(S.doseTracking ? [['einnahme', 'Einnahme', I.drop]] : []), ['fotos', 'Fotos', I.cam], ['wissen', 'Studies', I.book]];
}
function goTab(key) {
  if (key === ui.tab) { document.getElementById('app').scrollTo({ top: 0, behavior: 'smooth' }); return; }
  const keys = tabList().map(t => t[0]);
  ui.dir = keys.indexOf(key) > keys.indexOf(ui.tab) ? 'right' : 'left';
  ui.tab = key; ui.sel = null; ui.sheet = null;
  if (key === 'wissen' && unseen().length) markLibSeen();
  render();
  document.getElementById('app').scrollTop = 0;
}

/* Eigener Bestätigungs-Dialog statt des grauen Browser-Fensters */
function askConfirm({ title, text = '', ok = 'Löschen', cancel = 'Abbrechen', danger = true }) {
  return new Promise(resolve => {
    document.querySelector('.cf-bg')?.remove();
    const bg = document.createElement('div');
    bg.className = 'cf-bg';
    bg.innerHTML = `<div class="cf" role="alertdialog" aria-modal="true" aria-labelledby="cf-t">
      <div class="cf-ic ${danger ? 'danger' : ''}">${danger
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>'}</div>
      <h3 id="cf-t">${esc(title)}</h3>
      ${text ? `<p>${esc(text)}</p>` : ''}
      <div class="cf-btns">
        <button class="btn ghost" data-cf="0">${esc(cancel)}</button>
        <button class="btn ${danger ? 'cf-danger' : ''}" data-cf="1">${esc(ok)}</button>
      </div>
    </div>`;
    const done = v => {
      bg.classList.add('out');
      setTimeout(() => bg.remove(), 220);
      resolve(v);
    };
    bg.addEventListener('click', e => {
      e.stopPropagation();
      const b = e.target.closest('[data-cf]');
      if (b) { haptic(); done(b.dataset.cf === '1'); }
      else if (e.target === bg) done(false);
    });
    document.body.appendChild(bg);
    bg.querySelector('[data-cf="1"]').focus({ preventScroll: true });
  });
}

/* Schalter: erst sanft umschalten, dann Inhalt aktualisieren */
function flipSwitch(el, then) {
  el.classList.toggle('on');
  el.setAttribute('aria-checked', el.classList.contains('on'));
  haptic();
  setTimeout(then, 200);
}

/* Sheets mit dem Finger nach unten wegwischen */
let sheetClosing = false;
function closeSheet(animated = true) {
  const bg = document.querySelector('.sheet-bg'), sh = document.querySelector('.sheet');
  document.activeElement?.blur?.();                 // Tastatur zu, bevor das Fenster geht
  if (!animated || !sh) { sheetClosing = false; ui.sheet = null; renderSheet(); return; }
  if (sheetClosing) return;                         // doppeltes Schließen verhindern
  sheetClosing = true;
  sh.classList.remove('dragging'); sh.classList.add('snap');
  sh.style.transform = 'translateY(100%)';
  bg.style.background = ''; bg.classList.add('closing');
  setTimeout(() => { sheetClosing = false; ui.sheet = null; renderSheet(); if (renderPending) safeRender(); }, 300);
}
function bindSheetDrag() {
  const sh = document.querySelector('.sheet'), bg = document.querySelector('.sheet-bg');
  if (!sh) return;
  // Ablauf pro Berührung: erst abwarten, wohin der Finger geht.
  // 'tap' = noch unklar (Antippen bleibt Antippen), 'scroll' = Inhalt scrollen, 'drag' = Fenster nach unten ziehen.
  // Öffnungs-Animation nur einmal: danach fest abschalten, sonst startet sie nach dem Zurückschnappen neu
  const done = () => sh.classList.add('opened');
  if (getComputedStyle(sh).animationName === 'none') done(); else sh.addEventListener('animationend', done, { once: true });
  const SLOP = 8;
  let mode = null, x0 = 0, y0 = 0, t0 = 0, yDrag = 0, dy = 0, lastY = 0, lastT = 0, vel = 0, h = 1;
  sh.addEventListener('touchstart', e => {
    if (sheetClosing) { mode = null; return; }
    if (e.touches.length > 1) { mode = 'scroll'; return; }
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY; dy = 0; vel = 0; lastY = y0; lastT = t0 = Date.now();
    mode = e.target.closest('input, textarea, select') ? 'scroll' : 'tap';
  }, { passive: true });
  sh.addEventListener('touchmove', e => {
    if (mode === 'scroll' || mode == null) return;
    const t = e.touches[0];
    const mx = t.clientX - x0, my = t.clientY - y0;
    if (mode === 'tap') {
      if (Math.abs(mx) < SLOP && Math.abs(my) < SLOP) return;            // Zittern beim Antippen ignorieren
      const fromGrab = !!e.target.closest('.grab-zone');
      if (my > 0 && my > Math.abs(mx) && (sh.scrollTop <= 0 || fromGrab)) {
        mode = 'drag'; yDrag = y0 + SLOP; h = sh.offsetHeight || 1;   // ohne Sprung weiterziehen
        sh.classList.remove('snap'); sh.classList.add('dragging');
      } else { mode = 'scroll'; return; }
    }
    // mode === 'drag': Fenster folgt dem Finger, Hintergrund wird mit hell
    if (e.cancelable) e.preventDefault();
    const now = Date.now();
    vel = (t.clientY - lastY) / Math.max(1, now - lastT); lastY = t.clientY; lastT = now;
    const raw = t.clientY - yDrag;
    dy = raw >= 0 ? raw : raw / 4;                  // nach oben nur leicht nachgeben
    sh.style.transform = `translateY(${Math.max(dy, -14)}px)`;
    if (bg) bg.style.background = `rgba(0,0,0,${(.55 * (1 - Math.max(0, dy) / h)).toFixed(3)})`;
  }, { passive: false });
  const end = () => {
    if (mode !== 'drag') { mode = null; return; }
    mode = null; sh.classList.remove('dragging');
    const now = Date.now();
    if (now - lastT > 90) vel = 0;                  // Finger stand still → kein Schwung
    const flick = now - t0 < 260 && lastY - y0 > 30; // kurzer schneller Wisch nach unten
    if (dy > Math.min(130, h * .3) || (vel > .45 && dy > 20) || flick) { closeSheet(); return; }
    sh.classList.add('snap'); sh.style.transform = '';
    if (bg) { bg.style.transition = 'background .3s'; bg.style.background = ''; }
    setTimeout(() => { sh.classList.remove('snap'); if (bg) bg.style.transition = ''; }, 320);
  };
  sh.addEventListener('touchend', end);
  sh.addEventListener('touchcancel', end);
}

// Fingerfahren: Der Chart wird nur einmal gezeichnet, beim Bewegen werden nur Markierung und Infozeile verschoben.
// lock = true: Seite scrollt nicht, solange der Finger auf dem Chart liegt (Chart-Seite).
function bindChart(id, lock) {
  const wrap = document.getElementById(id);
  if (!wrap) return;
  const svg = wrap.querySelector('svg');
  if (!svg || chartXs.length < 2) return;
  const xs = chartXs.slice(), pts = chartPts.slice();
  const e = tfSeries(metrics());
  const info = document.getElementById(id + '-info');
  const mkL = svg.querySelector('.mk-l'), mkH = svg.querySelector('.mk-h'), mkC = svg.querySelector('.mk-c');
  let rect = null, raf = 0, lastX = 0;
  const update = () => {
    raf = 0;
    const x = (lastX - rect.left) / rect.width * 390;
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] < x) lo = mid; else hi = mid; }
    const best = Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
    if (best === ui.sel) return;
    ui.sel = best;
    const [px, py] = pts[best];
    mkL.setAttribute('x1', px); mkL.setAttribute('x2', px);
    mkH.setAttribute('cx', px); mkH.setAttribute('cy', py);
    mkC.setAttribute('cx', px); mkC.setAttribute('cy', py);
    if (info) info.innerHTML = chartInfo(e, best);
  };
  const move = x => { lastX = x; if (!raf) raf = requestAnimationFrame(update); };
  let sx = 0, sy = 0, horiz = lock;
  wrap.addEventListener('touchstart', ev => {
    rect = svg.getBoundingClientRect(); sx = ev.touches[0].clientX; sy = ev.touches[0].clientY; horiz = lock;
    if (lock) move(sx);
  }, { passive: true });
  wrap.addEventListener('touchmove', ev => {
    const t = ev.touches[0];
    if (!horiz && Math.abs(t.clientX - sx) > 8 && Math.abs(t.clientX - sx) > Math.abs(t.clientY - sy)) horiz = true;
    if (!horiz) return;                 // senkrecht: normal scrollen lassen
    if (ev.cancelable) ev.preventDefault();
    move(t.clientX);
  }, { passive: false });
  wrap.addEventListener('mousedown', ev => { rect = svg.getBoundingClientRect(); move(ev.clientX); });
  wrap.addEventListener('mousemove', ev => { if (ev.buttons) move(ev.clientX); });
}

/* ---------- Fotos ---------- */
function comparePair() {
  if (photos.length < 2) return [null, null];
  const sorted = [...photos].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let b = photos.find(p => p.id === S.compare.before) || sorted[0];
  let a = photos.find(p => p.id === S.compare.after) || sorted[sorted.length - 1];
  // gleiches Foto für beide gewählt: das andere automatisch passend ersetzen
  if (b.id === a.id) {
    if (S.compare.before === b.id) a = [...sorted].reverse().find(p => p.id !== b.id);
    else b = sorted.find(p => p.id !== a.id);
  }
  return b && a ? [b, a] : [null, null];
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

// Bilder für die Karte zwischenspeichern, damit Regler flüssig reagieren
const imgCache = new Map();
function loadImgCached(src) { if (!imgCache.has(src)) imgCache.set(src, loadImg(src)); return imgCache.get(src); }
// Ausschnitt je Foto: z = Zoom (1 = ganzes Foto sichtbar), x/y = Verschiebung -1 … 1
function shareCrop() {
  const [b, a] = comparePair();
  const key = (b && b.id) + '|' + (a && a.id);
  if (!ui.share.crop || ui.share.crop.key !== key) ui.share.crop = { key, b: { z: 1, x: 0, y: 0 }, a: { z: 1, x: 0, y: 0 } };
  return ui.share.crop;
}
// Foto in einen abgerundeten Rahmen: ganzes Foto sichtbar, Rand mit unscharfer Version gefüllt
function drawSlot(x, img, X, Y, w, h, c) {
  x.save(); rr(x, X, Y, w, h, 34); x.clip();
  const t = document.createElement('canvas'); t.width = 18; t.height = 26;
  drawCover(t.getContext('2d'), img, 0, 0, 18, 26);
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(t, X - 20, Y - 20, w + 40, h + 40);
  x.fillStyle = 'rgba(14,16,20,.5)'; x.fillRect(X, Y, w, h);
  const k = Math.min(w / img.naturalWidth, h / img.naturalHeight) * c.z;
  const dw = img.naturalWidth * k, dh = img.naturalHeight * k;
  const mx = Math.max(0, (dw - w) / 2), my = Math.max(0, (dh - h) / 2);
  x.drawImage(img, X + (w - dw) / 2 - c.x * mx, Y + (h - dh) / 2 - c.y * my, dw, dh);
  x.restore();
  x.save(); rr(x, X, Y, w, h, 34); x.strokeStyle = 'rgba(255,255,255,.1)'; x.lineWidth = 2; x.stroke(); x.restore();
}

async function drawShare() {
  const m = metrics();
  const W = 1080, H = 1920;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#0E1014'; x.fillRect(0, 0, W, H);
  const [pb, pa] = comparePair();
  const usePhotos = ui.share.photos && pb && pa;

  if (usePhotos) {
    const g = x.createRadialGradient(W, 0, 0, W, 0, W * 1.15);
    g.addColorStop(0, 'rgba(61,220,151,.2)'); g.addColorStop(1, 'rgba(61,220,151,0)');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    const [ib, ia] = await Promise.all([loadImgCached(pb.url), loadImgCached(pa.url)]);
    const cr = shareCrop();
    const sw = (W - 128 - 20) / 2, sh = 700, sy = 236;
    drawSlot(x, ib, 64, sy, sw, sh, cr.b);
    drawSlot(x, ia, 64 + sw + 20, sy, sw, sh, cr.a);
    pillText(x, `VORHER · ${shortDate(pb.date).toUpperCase()}`, 84, sy + sh - 82, { fill: 'rgba(14,16,20,.78)', size: 26, h: 56, padX: 22 });
    pillText(x, `NACHHER · ${shortDate(pa.date).toUpperCase()}`, 64 + sw + 40, sy + sh - 82, { fill: '#3DDC97', color: '#07281B', size: 26, h: 56, padX: 22 });
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
  const heroY = usePhotos ? 1200 : 700;
  const heroSize = usePhotos ? 220 : 320;
  const kgY = heroY + (usePhotos ? 135 : 205), subY = kgY + (usePhotos ? 74 : 86);

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
  rr(x, 64, by, bw2, bhh, 36); x.fillStyle = '#171A21'; x.fill();
  rr(x, 64 + bw2 + 24, by, bw2, bhh, 36); x.fillStyle = '#3DDC97'; x.fill();
  x.textBaseline = 'alphabetic';
  x.font = `600 30px ${FONT}`; x.fillStyle = '#98A1B0'; x.fillText('START', 104, by + 66);
  x.fillStyle = '#0F5A3C'; x.fillText('JETZT', 104 + bw2 + 24, by + 66);
  x.font = `800 64px ${FONT}`; x.fillStyle = '#fff'; x.fillText(`${f1(m.start)} kg`, 104, by + 148);
  x.fillStyle = '#07281B'; x.fillText(`${f1(m.cur)} kg`, 104 + bw2 + 24, by + 148);
  return c;
}
// Schalter-Zeile: sofort umschalten, Karte kurz danach neu zeichnen (schnelles Tippen = nur 1x zeichnen)
let shareTimer = 0;
function toggleRow(el, on) {
  el.querySelector('.switch')?.classList.toggle('on', on);
  el.setAttribute('aria-checked', on);
  haptic();
  document.querySelector('.share-preview')?.classList.add('updating');
  clearTimeout(shareTimer);
  shareTimer = setTimeout(refreshShare, 180);
}
let shareRun = 0;
async function refreshShare() {
  const run = ++shareRun;
  const open = ui.sheet && ui.sheet.type === 'share';
  if (open) document.querySelector('.share-preview')?.classList.add('updating');
  let c = null;
  try { c = await drawShare(); } catch (e) { toast('Karte konnte nicht erstellt werden'); return; }
  if (run !== shareRun) return;            // inzwischen nochmal umgeschaltet → nur das Neueste zählt
  const img = c.toDataURL('image/jpeg', .85);
  if (open) {
    // nur das Bild tauschen, Fenster bleibt stehen
    ui.sheet.canvas = c; ui.sheet.img = img;
    const pv = document.querySelector('.share-preview');
    if (pv) { pv.src = img; pv.classList.remove('updating'); } else renderSheet();
  } else {
    // erst wenn die Karte fertig ist, gleitet das Fenster einmal hoch
    ui.sheet = { type: 'share', canvas: c, img }; renderSheet();
  }
}

/* ---------- Aktionen ---------- */
const A = {
  tab(el) { goTab(el.dataset.v); },
  'sheet-bg'(el, ev) { if (ev.target === el) closeSheet(); },

  // Onboarding
  'ob-goal'(el) { readOb(); ui.ob.goal = el.dataset.v; render(); writeOb(); },
  'ob-dose'(el) { ui.ob.dose = !ui.ob.dose; el.classList.toggle('on'); el.setAttribute('aria-checked', ui.ob.dose); haptic(); },
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
    S.weights[d] = Math.round(v * 10) / 10; save(); toast('Eingetragen'); ui.sel = null;
    closeSheet(); setTimeout(render, 240);
  },
  'hist-all'() { ui.histAll = true; render();
  },
  async 'entry-del'(el) { if (!(await askConfirm({ title: 'Eintrag löschen?', text: `Gewicht vom ${shortDate(el.dataset.v)} wird entfernt.` }))) return; delete S.weights[el.dataset.v]; save(); ui.sel = null; render(); },
  tf(el) { ui.tf = el.dataset.v; ui.sel = null; render(); },

  // Einnahme
  day(el) {
    const v = +el.dataset.v, on = S.doseDays.includes(v);
    if (on && S.doseDays.length === 1) { toast('Mindestens ein Tag', 'err'); return; }
    S.doseDays = on ? S.doseDays.filter(x => x !== v) : [...S.doseDays, v];
    fixDays(); haptic(); save(); render();
  },
  mix() { ui.sheet = { type: 'mix' }; renderSheet(); },
  contact() { haptic(); ui.sheet = { type: 'contact' }; renderSheet(); },
  remind() { haptic(); ui.sheet = { type: 'remind' }; renderSheet(); },
  async 'remind-toggle'(el) {
    if (el.disabled || el.dataset.busy) return;
    const turnOn = !S.remind?.on;
    if (turnOn) {
      el.dataset.busy = '1';
      try {
        const perm = await Notification.requestPermission();   // muss direkt aus dem Tippen kommen
        if (perm !== 'granted') { delete el.dataset.busy; toast('Mitteilungen nicht erlaubt', 'err'); renderSheet(); return; }
        flipSwitch(el, () => {});
        await Push.subscribe();
        S.remind = { ...(S.remind || {}), on: true, time: S.remind?.time || '09:00' }; await save();
        toast('Erinnerung aktiv'); render(); renderSheet();
      } catch (e) {
        delete el.dataset.busy; toast('Hat nicht geklappt: ' + (e.message || e), 'err'); renderSheet();
      }
    } else {
      S.remind = { ...(S.remind || {}), on: false }; await save();
      flipSwitch(el, () => { render(); renderSheet(); });
    }
  },
  async 'remind-test'(el) {
    el.disabled = true;
    try {
      await Push.subscribe();
      const { data } = await Cloud.sb.auth.getSession();
      const c = window.KINETIC_CONFIG;
      const r = await fetch(c.supabaseUrl + '/functions/v1/send-reminders', {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: c.supabaseKey, Authorization: 'Bearer ' + data.session.access_token },
        body: JSON.stringify({ test: true })
      });
      const d = await r.json().catch(() => ({}));
      toast(r.ok && (d.sent || []).includes('ok') ? 'Gesendet, kommt gleich' : 'Senden fehlgeschlagen', r.ok ? 'ok' : 'err');
    } catch (e) { toast('Senden fehlgeschlagen', 'err'); }
    setTimeout(() => { el.disabled = false; }, 3000);
  },
  'mix-save'() {
    const mg = num(val('mix-mg')), ml = num(val('mix-ml'));
    if (!(mg > 0) || !(ml > 0)) { toast('Bitte mg und ml eintragen', 'err'); return; }
    S.mix = { mg, ml }; save(); haptic(); closeSheet(); toast('Gespeichert'); render();
  },
  'dose-add'() {
    const mg = num(val('dose-mg')), date = val('dose-date') || today();
    if (mg == null || mg <= 0) { toast('Bitte Menge in mg eintragen'); return; }
    if (date > today()) { toast('Datum liegt in der Zukunft'); return; }
    S.doses.push({ id: uid(), date, mg, note: val('dose-note').trim() });
    S.doses.sort((a, b) => (a.date < b.date ? -1 : 1));
    save(); haptic(); toast('Abgehakt'); render();
  },
  async 'dose-del'(el) { if (!(await askConfirm({ title: 'Einnahme löschen?', text: 'Der Eintrag wird aus deinem Verlauf entfernt.' }))) return; S.doses = S.doses.filter(d => d.id !== el.dataset.v); save(); render(); },

  // Fotos
  phase(el) { ui.phase = el.dataset.v; render(); },
  'ph-add'() { ui.sheet = { type: 'ph-add', phase: ui.phase !== 'Alle' ? ui.phase : (S.doseTracking ? 'Während Reta' : 'Vor Cut') }; renderSheet(); },
  'ph-add-phase'(el) { ui.sheet.date = val('ph-date'); ui.sheet.phase = el.dataset.v; renderSheet(); },
  'ph-pick'() { ui.sheet.date = val('ph-date') || today(); document.getElementById('ph-file').click(); },
  'ph-open'(el) { ui.sheet = { type: 'ph-view', id: el.dataset.v }; renderSheet(); },
  'ph-before'(el) { S.compare.before = el.dataset.v; if (S.compare.after === el.dataset.v) S.compare.after = null; save(); render(); },
  'ph-after'(el) { S.compare.after = el.dataset.v; if (S.compare.before === el.dataset.v) S.compare.before = null; save(); render(); },
  async 'ph-del'(el) {
    if (!(await askConfirm({ title: 'Foto löschen?', text: 'Das Foto wird von diesem iPhone entfernt.' }))) return;
    const id = el.dataset.v;
    if (!ui.demo) await DB.delPhoto(id);
    const p = photos.find(q => q.id === id); if (p) URL.revokeObjectURL(p.url);
    photos = photos.filter(q => q.id !== id);
    ui.sheet = null; render();
  },

  // Wissen
  wissen(el) { ui.wissen = el.dataset.v; render(); },
  'lib-filter'(el) { ui.libFilter = el.dataset.v; render(); },
  'lib-open'(el) { ui.sheet = { type: 'lib', id: el.dataset.v }; renderSheet(); },
  'lib-new'(el) { markLibSeen([el.dataset.v]); ui.sheet = { type: 'lib', id: el.dataset.v }; renderSheet(); render(); },
  'study-new'() { ui.sheet = { type: 'study' }; renderSheet(); },
  'study-save'() {
    const title = val('st-title').trim();
    if (!title) { toast('Titel fehlt'); return; }
    let url = val('st-url').trim();
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    S.studies.unshift({ id: uid(), title, url, population: val('st-pop').trim(), summary: val('st-sum').trim() });
    save(); ui.sheet = null; render();
  },
  async 'study-del'(el) { if (!(await askConfirm({ title: 'Studie löschen?' }))) return; S.studies = S.studies.filter(s => s.id !== el.dataset.v); save(); render(); },
  'note-new'() { ui.sheet = { type: 'note' }; renderSheet(); },
  'note-save'() {
    const text = val('no-text').trim();
    if (!text) { toast('Notiz ist leer'); return; }
    S.notes.push({ id: uid(), date: today(), text }); save(); ui.sheet = null; render();
  },
  async 'note-del'(el) { if (!(await askConfirm({ title: 'Notiz löschen?' }))) return; S.notes = S.notes.filter(n => n.id !== el.dataset.v); save(); render(); },

  // Teilen
  share() { refreshShare(); },
  'share-photos'(el) { ui.share.photos = !ui.share.photos; toggleRow(el, ui.share.photos); },
  'share-compound'(el) { ui.share.compound = !ui.share.compound; toggleRow(el, ui.share.compound); },
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

  // Login / Registrierung
  'inst-skip'() { ui.instSkip = true; render(); },
  'auth-consent'(el) { readAuth(); ui.auth.ok = !ui.auth.ok; el.classList.toggle('on', ui.auth.ok); el.setAttribute('aria-checked', ui.auth.ok); haptic(); },
  async 'auth-go'(el) {
    readAuth();
    const a = ui.auth;
    const err = m => { const e = document.getElementById('au-err'); if (e) e.textContent = m; haptic(); };
    if (!a.code) return err('Bitte deinen Einladungscode eingeben.');
    if (!a.first || !a.last) return err('Bitte Vor- und Nachname eingeben.');
    if (!a.ok) return err('Bitte bestätige die Einwilligung.');
    document.activeElement?.blur();          // Tastatur schließen, bevor etwas passiert
    el.disabled = true; el.classList.add('loading'); err('');
    const label = el.innerHTML; el.innerHTML = '<span class="spin"></span>Anmelden …';
    try {
      const c = window.KINETIC_CONFIG;
      const r = await fetch(c.supabaseUrl + '/functions/v1/kinetic-login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: c.supabaseKey },
        body: JSON.stringify({ code: a.code, first: a.first, last: a.last })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ('Fehler ' + r.status));
      const { data, error } = await Cloud.sb.auth.setSession({ access_token: d.access_token, refresh_token: d.refresh_token });
      if (error) throw error;
      Cloud.user = data.session.user;
      Cloud.setProfile(d.profile);
      await afterLogin(Cloud.user);
      Cloud.loadSettings().catch(() => {});
      // sanfter Übergang: Login ausblenden, App einblenden
      document.querySelector('.screen.auth')?.classList.add('leaving');
      await new Promise(r => setTimeout(r, 260));
      ui.auth = null; ui.tab = 'heute'; render();
      setTimeout(() => loadLib(), 600);
      document.getElementById('app').firstElementChild?.classList.add('app-in');
      toast('Hallo ' + d.profile.first_name);
    } catch (e) {
      el.disabled = false; el.classList.remove('loading'); el.innerHTML = label;
      err(authMsg(e));
    }
  },
  async logout() {
    if (!(await askConfirm({ title: 'Abmelden?', text: 'Deine Daten bleiben in deinem Account gespeichert. Zum Anmelden brauchst du wieder deinen Code und deinen Namen. Fotos bleiben auf diesem iPhone, solange du dich wieder mit diesem Account anmeldest.', ok: 'Abmelden', danger: false }))) return;
    if (lsGet('kinetic-dirty') === '1' && !(await Cloud.push())) { toast('Erst mit Internet verbinden, sonst gehen Änderungen verloren', 'err'); return; }
    ui.sheet = null; renderSheet();
    await Push.unsubscribe();
    await Cloud.sb.auth.signOut().catch(() => {});
    Cloud.user = null; Cloud.setProfile(null); ui.auth = {}; render();
  },
  async 'delete-account'() {
    if (!(await askConfirm({ title: 'Account löschen?', text: 'Dein Account, alle gespeicherten Daten im Account UND alle Daten und Fotos auf diesem iPhone werden endgültig gelöscht. Das lässt sich nicht rückgängig machen. Zum Abmelden nimm stattdessen „Abmelden“.', ok: 'Endgültig löschen' }))) return;
    const { error } = await Cloud.sb.rpc('delete_account');
    if (error) { toast('Löschen fehlgeschlagen, bist du online?', 'err'); return; }
    await Cloud.sb.auth.signOut().catch(() => {});
    S = structuredClone(DEFAULT_STATE); fixDays(); await DB.set('state', S); await DB.set('owner', null);
    await DB.clearPhotos(); photos.forEach(p => URL.revokeObjectURL(p.url)); photos = [];
    lsSet('kinetic-dirty', null); lsSet('kinetic-uid', null);
    Cloud.user = null; Cloud.setProfile(null); ui.sheet = null; ui.auth = {}; render();
    toast('Account gelöscht');
  },
  'set-goal'(el) { readSettings(); S.goal = el.dataset.v; save(); renderSheet(); writeSettings(); },
  'set-dose'(el) { readSettings(); S.doseTracking = !S.doseTracking; save(); flipSwitch(el, () => { render(); writeSettings(); }); },
  'set-save'() {
    const s = num(val('set-start')), t = num(val('set-target'));
    S.startWeight = s; S.targetWeight = t; save(); ui.sheet = null; toast('Gespeichert'); render();
  },
  async export() {
    if (ui.demo) { toast('Erst Demo-Modus beenden'); return; }
    toast('Backup wird erstellt …');
    const toData = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
    const pics = [];
    for (const p of photos) pics.push({ id: p.id, date: p.date, phase: p.phase, data: await toData(p.blob) });
    const blob = new Blob([JSON.stringify({ app: 'kinetic', v: 2, exported: new Date().toISOString(), state: S, photos: pics })], { type: 'application/json' });
    const file = new File([blob], `kinetic-backup-${today()}.json`, { type: 'application/json' });
    const done = () => { S.lastBackup = new Date().toISOString(); save(); toast('Backup gespeichert'); render(); };
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); done(); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
    done();
  },
  import() { if (ui.demo) { toast('Erst Demo-Modus beenden'); return; } document.getElementById('import-file').click(); },
  async demo(el) {
    const go = async () => {
      if (ui.demo) exitDemo(); else await enterDemo();
      ui.tab = 'heute';
      if (ui.sheet) { closeSheet(); setTimeout(render, 240); } else render();
    };
    if (el.classList.contains('switch')) flipSwitch(el, go); else go();
  },
  async reset() {
    if (ui.demo) return;
    if (!(await askConfirm({ title: 'Alle Daten löschen?', text: 'Gewicht, Einnahmen, Fotos und Notizen werden entfernt. Das lässt sich nicht rückgängig machen.', ok: 'Alles löschen' }))) return;
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
    if (!ui.demo) await DB.putPhoto(p);
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
    const nPics = Array.isArray(data.photos) ? data.photos.length : 0;
    if (!(await askConfirm({ title: 'Backup importieren?', text: `Deine aktuellen Daten werden durch das Backup ersetzt${nPics ? ` (inkl. ${nPics} Fotos)` : ''}.`, ok: 'Importieren', danger: false }))) return;
    S = { ...structuredClone(DEFAULT_STATE), ...data.state };
    if (!data.state.doseDays) S.doseDays = null;
    fixDays();
    if (nPics) {
      await DB.clearPhotos(); photos.forEach(p => URL.revokeObjectURL(p.url)); photos = [];
      for (const p of data.photos) {
        const blob = await (await fetch(p.data)).blob();
        const rec = { id: p.id, date: p.date, phase: p.phase, blob };
        await DB.putPhoto(rec); photos.push({ ...rec, url: URL.createObjectURL(blob) });
      }
    }
    await save(); ui.sheet = null; toast('Backup importiert'); render();
  } catch (e) { toast('Datei ist kein Kinetic-Backup'); }
});

/* ---------- Demo-Modus (nur zum Testen, später entfernen) ---------- */
let REAL = null;
function makeDemoState() {
  const s = structuredClone(DEFAULT_STATE);
  const t = today();
  Object.assign(s, { onboarded: true, goal: 'lose', startWeight: 85.0, targetWeight: 75.0, doseTracking: true, schedule: 2, doseDays: [1, 4] });
  let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  for (let i = 83; i >= 0; i--) {
    if (i > 0 && rnd() < .12) continue;                     // ein paar vergessene Tage
    const trend = 85 - (83 - i) * 0.098 - Math.max(0, 40 - i) * 0.01;
    s.weights[addDays(t, -i)] = Math.round((trend + (rnd() - .5) * .9) * 10) / 10;
  }
  const ws = weekStart(t);
  for (let k = 11; k >= 0; k--) {
    const mg = k > 8 ? 1 : k > 4 ? 2 : 4;
    const notes = ['', '', 'Appetit deutlich weniger', 'leichte Übelkeit 2/10', '', 'schlecht geschlafen'];
    [0, 3].forEach((off, j) => {
      const d = addDays(ws, -7 * k + off);
      if (d > t || (k === 0 && j === 1)) return;
      s.doses.push({ id: 'demo' + k + j, date: d, mg, note: notes[(k + j) % notes.length] });
    });
  }
  s.studies = [
    { id: 'ds1', title: 'Beispiel: Phase-2-Studie (Platzhalter)', url: 'https://pubmed.ncbi.nlm.nih.gov/', population: 'Erwachsene mit Übergewicht (Platzhalter)', summary: 'Hier steht später deine eigene Zusammenfassung der Studie.' },
    { id: 'ds2', title: 'Beispiel: Übersichtsarbeit (Platzhalter)', url: '', population: '', summary: 'Zweiter Beispiel-Eintrag.' }
  ];
  s.notes = [
    { id: 'dn1', date: addDays(t, -20), text: 'Woche 9: Hunger abends deutlich geringer. Training läuft normal.' },
    { id: 'dn2', date: addDays(t, -3), text: 'Wasser getrunken: zu wenig. Morgen mehr.' }
  ];
  return s;
}
async function makeDemoPhoto(id, date, phase, wide) {
  const c = document.createElement('canvas'); c.width = 600; c.height = 800;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 800); g.addColorStop(0, '#2B313B'); g.addColorStop(1, '#14171C');
  x.fillStyle = g; x.fillRect(0, 0, 600, 800);
  x.fillStyle = '#5B6573';
  x.beginPath(); x.arc(300, 170, 62, 0, 7); x.fill();
  x.beginPath(); x.ellipse(300, 470, wide, 230, 0, 0, 7); x.fill();
  x.fillStyle = 'rgba(255,255,255,.5)'; x.font = '600 28px -apple-system, sans-serif'; x.textAlign = 'center';
  x.fillText('Demo-Foto', 300, 760);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', .8));
  return { id, date, phase, blob, url: URL.createObjectURL(blob) };
}
async function enterDemo() {
  REAL = { S, photos };
  S = makeDemoState();
  const t = today();
  photos = await Promise.all([
    makeDemoPhoto('dp1', addDays(t, -83), 'Vor Reta', 170),
    makeDemoPhoto('dp2', addDays(t, -56), 'Während Reta', 155),
    makeDemoPhoto('dp3', addDays(t, -28), 'Während Reta', 140),
    makeDemoPhoto('dp4', t, 'Während Reta', 128)
  ]);
  ui.demo = true;
  try { localStorage.setItem('kinetic-demo', '1'); } catch (e) { /* egal */ }
}
function exitDemo() {
  photos.forEach(p => URL.revokeObjectURL(p.url));
  S = REAL.S; photos = REAL.photos; REAL = null; ui.demo = false;
  try { localStorage.removeItem('kinetic-demo'); } catch (e) { /* egal */ }
  toast('Demo beendet, deine Daten sind zurück');
}

/* ---------- Start ---------- */
const splashStart = Date.now();
function hideSplash() {
  const sp = document.getElementById('splash');
  if (!sp) return;
  setTimeout(() => { sp.classList.add('out'); setTimeout(() => sp.remove(), 400); }, Math.max(0, 900 - (Date.now() - splashStart)));
}
(async function init() {
  try {
    Cloud.init();
    await DB.open();
    const saved = await DB.get('state');
    if (saved) { S = { ...structuredClone(DEFAULT_STATE), ...saved }; if (!saved.doseDays) S.doseDays = null; }
    fixDays();
    photos = (await DB.photos()).map(p => ({ ...p, url: URL.createObjectURL(p.blob) }));
    navigator.storage?.persist?.().catch(() => {});
    let demo = false; try { demo = localStorage.getItem('kinetic-demo') === '1'; } catch (e) { /* egal */ }
    if (demo) await enterDemo();
    const qp = new URLSearchParams(location.search).get('tab');
    if (qp && ['heute', 'chart', 'einnahme', 'fotos', 'wissen'].includes(qp)) { ui.tab = qp; history.replaceState(null, '', location.pathname); }
    if (Cloud.on) {
      const owner = await DB.get('owner');
      if (await Cloud.session()) {
        if (owner && owner !== Cloud.user.id) await afterLogin(Cloud.user); else { if (!owner) await DB.set('owner', Cloud.user.id); Cloud.pull(); }
        if (!Cloud.profile) Cloud.loadProfile().catch(() => {});
        Cloud.loadSettings().catch(() => {});
        setTimeout(() => Push.refresh(), 1500);
        setTimeout(() => loadLib(), 800);
      } else if (!navigator.onLine && owner && lsGet('kinetic-uid') === owner) {
        ui.offline = true;              // offline und schon angemeldet gewesen: lokal weiterarbeiten
      }
    }
  } catch (e) {
    document.getElementById('app').innerHTML = '<section class="screen"><div class="empty">Speicher nicht verfügbar. Öffne Kinetic nicht im privaten Modus.</div></section>';
    hideSplash();
    return;
  }
  render();
  hideSplash();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();

// Mitteilung angetippt, App war schon offen → zu Einnahme springen
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.type === 'goto' && Cloud.user) goTab(e.data.tab); });

// Uhrzeit der Erinnerung speichern
document.addEventListener('change', e => {
  if (e.target.id !== 'rm-time' || !e.target.value) return;
  S.remind = { ...(S.remind || { on: false }), time: e.target.value };
  save(); render(); toast('Erinnerung um ' + e.target.value + ' Uhr');
});

// Live-Umrechnung mg → IU beim Tippen
document.addEventListener('input', e => {
  const id = e.target.id;
  if (id === 'dose-mg') {
    const out = document.getElementById('dose-iu'); const v = iu(num(e.target.value));
    if (out) out.textContent = v ? '= ' + v + ' IU' : '';
  } else if (id === 'mix-mg' || id === 'mix-ml') {
    const mg = num(val('mix-mg')), ml = num(val('mix-ml')), out = document.getElementById('mix-prev');
    if (out) out.textContent = mg > 0 && ml > 0 ? `1 mg = ${fiu(100 * ml / mg)} IU · 2 mg = ${fiu(200 * ml / mg)} IU` : 'Trag beide Werte ein';
  }
});
