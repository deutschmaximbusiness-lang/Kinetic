-- =====================================================================
-- Kinetic · Supabase-Setup
-- Einmal komplett im Supabase SQL Editor ausführen (New query → einfügen → Run).
-- =====================================================================

-- 1) Invite-Codes: nur wer einen gültigen Code hat, kann sich registrieren.
create table if not exists public.invite_codes (
  code        text primary key,
  note        text,                          -- z. B. für wen der Code ist
  created_at  timestamptz not null default now(),
  used_by     uuid,                          -- Account, der den Code benutzt hat
  used_email  text,
  used_at     timestamptz,
  disabled    boolean not null default false
);
alter table public.invite_codes enable row level security;
-- Keine Policies: Die App kann Codes weder lesen noch ändern. Nur du im SQL Editor.

-- 2) Daten pro Account (Gewicht, Einnahmen, Einstellungen). Fotos bleiben auf dem iPhone.
create table if not exists public.user_state (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  state       jsonb not null,
  updated_at  timestamptz not null default now()
);
alter table public.user_state enable row level security;

drop policy if exists "eigene Daten lesen"   on public.user_state;
drop policy if exists "eigene Daten anlegen" on public.user_state;
drop policy if exists "eigene Daten ändern"  on public.user_state;
drop policy if exists "eigene Daten löschen" on public.user_state;
create policy "eigene Daten lesen"   on public.user_state for select to authenticated using ((select auth.uid()) = user_id);
create policy "eigene Daten anlegen" on public.user_state for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "eigene Daten ändern"  on public.user_state for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "eigene Daten löschen" on public.user_state for delete to authenticated using ((select auth.uid()) = user_id);

-- 3) Registrierung nur mit gültigem, unbenutztem Code (prüft der Server, nicht die App).
create or replace function public.kinetic_check_invite()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  c text := upper(trim(coalesce(new.raw_user_meta_data ->> 'invite', '')));
begin
  update public.invite_codes
     set used_by = new.id, used_email = new.email, used_at = now()
   where code = c and used_by is null and not disabled;
  if not found then
    raise exception 'KINETIC_INVITE_INVALID';
  end if;
  return new;
end;
$$;

drop trigger if exists kinetic_check_invite on auth.users;
create trigger kinetic_check_invite
  before insert on auth.users
  for each row execute function public.kinetic_check_invite();

-- 4) Account selbst löschen (Button in der App). Löscht auch alle Daten (cascade).
create or replace function public.delete_account()
returns void
language sql
security definer
set search_path = public
as $$
  delete from auth.users where id = auth.uid();
$$;
revoke all on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;

-- 5) Codes erzeugen: select * from public.new_invite(3, 'für Tom');
create or replace function public.new_invite(n int default 1, for_whom text default null)
returns setof text
language plpgsql
set search_path = public
as $$
declare
  c text;
begin
  for i in 1..greatest(n, 1) loop
    c := 'KIN-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    insert into public.invite_codes(code, note) values (c, for_whom);
    return next c;
  end loop;
end;
$$;
revoke all on function public.new_invite(int, text) from public, anon, authenticated;

-- Erster Code für dich:
select * from public.new_invite(1, 'Maxim');
