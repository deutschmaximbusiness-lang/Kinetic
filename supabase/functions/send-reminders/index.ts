// Kinetic · Push-Erinnerungen an Einnahme-Tagen.
// Wird alle 10 Minuten vom Zeitplan (pg_cron) aufgerufen.
// Zusätzlich: angemeldete Nutzer können sich eine Test-Benachrichtigung schicken ({ test: true }).
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Datum/Uhrzeit in der Zeitzone des Geräts
function localNow(tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
const isoDay = (d: string) => (new Date(d + "T12:00:00Z").getUTCDay() || 7);
const addDays = (d: string, n: number) => {
  const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10);
};

// Gleiche Logik wie in der App: Ist heute eine Einnahme fällig und noch offen?
function dueToday(state: any, today: string): boolean {
  if (!state || state.doseTracking === false) return false;
  const days: number[] = Array.isArray(state.doseDays) && state.doseDays.length ? state.doseDays : [1, 4];
  if (!days.includes(isoDay(today))) return false;
  const past = (state.doses || []).map((d: any) => d.date).filter((d: string) => d && d <= today).sort();
  const last = past[past.length - 1];
  if (!last) return true;
  if (last === today) return false;
  const cov = !days.includes(isoDay(last)) && days.includes(isoDay(addDays(last, 1))) ? addDays(last, 1) : last;
  return cov < today;
}
const toMin = (t: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : 9 * 60; };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: cfg } = await admin.rpc("push_config");
  const c = cfg?.[0];
  if (!c?.vapid_private) return json(500, { error: "config" });
  webpush.setVapidDetails("mailto:noreply@kinetic-app.de", c.vapid_public, c.vapid_private);

  let body: any = {};
  try { body = await req.json(); } catch { /* leer */ }

  const send = async (sub: any, payload: unknown) => {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 6 * 3600, urgency: "high" });
      return "ok";
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) { await admin.from("push_subscriptions").delete().eq("id", sub.id); return "gone"; }
      return "error " + (e?.statusCode || e?.message);
    }
  };

  // Test-Benachrichtigung für den angemeldeten Nutzer
  if (body.test) {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json(401, { error: "auth" });
    const { data: subs } = await admin.from("push_subscriptions").select("*").eq("user_id", u.user.id);
    const res = [];
    for (const s of subs || []) res.push(await send(s, { title: "Kinetic", body: "Erinnerungen sind aktiv. So sieht es an deinen Einnahme-Tagen aus.", url: "./?tab=einnahme" }));
    return json(200, { sent: res });
  }

  // Zeitplan
  if (req.headers.get("x-cron-secret") !== c.cron_secret) return json(401, { error: "forbidden" });
  const { data: subs } = await admin.from("push_subscriptions").select("*");
  if (!subs?.length) return json(200, { checked: 0 });
  const ids = [...new Set(subs.map((s) => s.user_id))];
  const { data: states } = await admin.from("user_state").select("user_id, state").in("user_id", ids);
  const byUser = new Map((states || []).map((s) => [s.user_id, s.state]));

  const out: unknown[] = [];
  for (const s of subs) {
    const st = byUser.get(s.user_id);
    const r = st?.remind;
    if (!r || !r.on) continue;
    const now = localNow(s.tz || "Europe/Berlin");
    if (s.last_sent === now.date) continue;                 // heute schon erinnert
    if (now.minutes < toMin(r.time)) continue;              // noch zu früh
    if (!dueToday(st, now.date)) continue;                  // heute nichts fällig oder schon erledigt
    if (body.dry) { out.push({ id: s.id, would_send: true }); continue; }
    const res = await send(s, { title: "Kinetic", body: "Heute ist Einnahme-Tag. Tippe zum Abhaken.", url: "./?tab=einnahme" });
    if (res === "ok") await admin.from("push_subscriptions").update({ last_sent: now.date }).eq("id", s.id);
    out.push({ id: s.id, res });
  }
  return json(200, { checked: subs.length, results: out });
});
