// Kinetic · Login mit Einladungscode + Vor- und Nachname (ohne E-Mail, ohne Passwort).
// Ablauf: Code und Name prüfen → beim ersten Mal Account anlegen → Sitzung zurückgeben.
// Der Code ist damit das Passwort. Gesperrte Codes kommen nicht rein.
import { createClient } from "jsr:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Namen vergleichen: Groß/klein, Leerzeichen und Umlaut-Schreibweise egal
const norm = (s: unknown) =>
  String(s ?? "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");

const randomPw = () => {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "method" });

  let body: { code?: string; first?: string; last?: string };
  try { body = await req.json(); } catch { return json(400, { error: "bad_request" }); }

  const code = String(body.code ?? "").toUpperCase().replace(/\s+/g, "");
  if (!code || !norm(body.first) || !norm(body.last)) return json(400, { error: "missing" });

  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: c, error: cErr } = await admin.from("invite_codes")
    .select("code, first_name, last_name, used_by, disabled, is_admin").eq("code", code).maybeSingle();
  if (cErr) return json(500, { error: "db" });

  const ok = c && !c.disabled && norm(c.first_name) === norm(body.first) && norm(c.last_name) === norm(body.last);
  if (!ok) {
    await new Promise((r) => setTimeout(r, 700)); // Raten bremsen
    return json(401, { error: c?.disabled ? "disabled" : "invalid" });
  }

  const pw = randomPw();
  let email: string | null = null;
  let uid: string | null = c.used_by;

  // Bestehender Account: neues Zufallspasswort setzen (laufende Sitzungen auf anderen Geräten bleiben)
  if (uid) {
    const { data: u, error } = await admin.auth.admin.updateUserById(uid, { password: pw });
    if (error || !u?.user) uid = null;
    else email = u.user.email ?? null;
  }

  // Erstes Mal (oder Account wurde gelöscht): Account anlegen
  if (!uid) {
    await admin.from("invite_codes").update({ used_by: null, used_email: null, used_at: null }).eq("code", code);
    email = `${code.toLowerCase()}@nutzer.kinetic-app.de`;
    const { data: nu, error } = await admin.auth.admin.createUser({
      email, password: pw, email_confirm: true,
      user_metadata: { invite: code, first_name: c.first_name, last_name: c.last_name },
    });
    if (error || !nu?.user) return json(500, { error: "create_failed", detail: error?.message });
    uid = nu.user.id;
  }

  const pub = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: s, error: sErr } = await pub.auth.signInWithPassword({ email: email!, password: pw });
  if (sErr || !s?.session) return json(500, { error: "signin_failed", detail: sErr?.message });

  await admin.from("invite_codes").update({ last_login: new Date().toISOString() }).eq("code", code);

  return json(200, {
    access_token: s.session.access_token,
    refresh_token: s.session.refresh_token,
    profile: { code, first_name: c.first_name, last_name: c.last_name, is_admin: c.is_admin },
  });
});
