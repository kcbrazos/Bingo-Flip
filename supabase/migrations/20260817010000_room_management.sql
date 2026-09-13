-- Room management: the clock, rejoining, hosting, captains and administrators.
--
-- Everything here is carried over from Elden Battleship, where each piece arrived as its own
-- migration over several months. None of it is about the game being played - it is about running a
-- room - so it survived the flip rework unchanged in purpose, and is collected into one file rather
-- than replayed as the sequence of fixes that produced it.
--
-- Two of them needed adapting rather than copying, and both for the same reason: the match-start
-- instant moved out of the attack log and onto `rooms.started_at`. Those are called out below.

-- --- the database's clock ------------------------------------------------
-- Every shared instant in a match is a Postgres timestamp. The match clock used to count from that
-- instant to the browser's own Date.now(), which subtracts a server clock from a client clock - so
-- each player's timer was wrong by however wrong their own PC clock was. An unsynced Windows clock
-- drifts minutes, and players in one room saw timers minutes apart.
--
-- It decided who could act, too: whether claiming is open comes from the same phase calculation, so
-- a fast clock opened the race early and a slow one held a team out after everyone else had begun.
-- A fairness bug, not a display one.
--
-- The client measures its own offset once, round-trip compensated, and adds it to every local
-- reading. now() is the transaction timestamp and exposes nothing else about the database. A
-- missing function is treated as "offset 0", so deploying the app before this degrades rather
-- than breaks.
create or replace function public.server_now() returns timestamptz
  language sql
  stable
  parallel safe
as $$ select now() $$;

grant execute on function public.server_now() to anon, authenticated;

comment on function public.server_now() is
  'Database clock for the shared match timer. Clients measure their own offset against this so every player counts from the same now(); see lib/serverTime.ts.';

-- --- rejoining -----------------------------------------------------------
-- Takes over an existing player row using its rejoin code, recovering the team that belonged to it.
-- Returns the player id, or null when the code matches nothing in that room.
create or replace function public.claim_player_slot(p_room_code text, p_rejoin_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id   uuid;
  v_room uuid;
begin
  if p_rejoin_code is null or length(trim(p_rejoin_code)) = 0 then
    return null;
  end if;

  select p.id, p.room_id into v_id, v_room
    from players p
    join rooms r on r.id = p.room_id
   where upper(r.code) = upper(p_room_code)
     and upper(p.rejoin_code) = upper(trim(p_rejoin_code))
   limit 1;

  if v_id is null then return null; end if;

  -- players has unique (room_id, user_id): if this browser already holds a different slot in the
  -- same room, taking over would violate it. Drop the throwaway row being abandoned - it is the
  -- identity being replaced, not one anybody is still using.
  delete from players
   where room_id = v_room
     and user_id = auth.uid()
     and id <> v_id;

  update players set user_id = auth.uid() where id = v_id;
  return v_id;
end;
$$;

grant execute on function public.claim_player_slot(text, text) to anon, authenticated;

-- --- hosting -------------------------------------------------------------
-- Promotes a new host when a room has none.
--
-- A host who closed their tab used to leave the room permanently unmanageable - nobody could start
-- the match, kick, end it or play again - and it sat there burning one of the fifteen room slots
-- until the pruner took it. Deterministic ordering makes this safely idempotent: two clients racing
-- pick the same winner.
create or replace function public.ensure_room_host(p_room_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  perform 1 from players where room_id = p_room_id and is_host limit 1;
  if found then return null; end if;

  select id into v_id from players
   where room_id = p_room_id
   order by joined_at asc, id asc
   limit 1;
  if v_id is null then return null; end if;

  update players set is_host = true where id = v_id;
  return v_id;
end;
$$;

grant execute on function public.ensure_room_host(uuid) to anon, authenticated;

-- Lets a room member take over hosting when the current host has gone dark but their row remains.
--
-- ADAPTED: the "did you arrive after the match started" test read the match-start marker out of the
-- attack log, which no longer exists - `claims` carries a unique index on (room_id, cell_index), so
-- a marker row would occupy a square. It reads rooms.started_at instead, which is the same instant
-- by a shorter route. `players.joined_at` is this schema's column name; the original said
-- created_at.
--
-- The test itself is unchanged and still earns its place: the front page publishes live matches, so
-- a room can be walked into by someone it has never met, and hosting is the key to every other
-- host-only lock.
create or replace function public.claim_room_host(p_player_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room    uuid;
  v_joined  timestamptz;
  v_started timestamptz;
begin
  select room_id, joined_at into v_room, v_joined
    from players
   where id = p_player_id and user_id = auth.uid();
  if v_room is null then return false; end if;

  select started_at into v_started from rooms where id = v_room;

  if v_started is not null
     and v_joined > v_started
     and not public.is_admin()
     and exists (select 1 from players where room_id = v_room and is_host)
  then
    return false;
  end if;

  update players set is_host = false where room_id = v_room and is_host;
  update players set is_host = true  where id = p_player_id;
  return true;
end;
$$;

grant execute on function public.claim_room_host(uuid) to anon, authenticated;

-- --- captains ------------------------------------------------------------
-- The captain of a team: whoever picked it first.
--
-- Must match captainOf() in src/lib/teams.ts exactly - same ordering, same tie-break - or the UI
-- offers controls the database then refuses. Rows without a team_joined_at sort last, which puts
-- anyone predating that column behind players who have picked since.
create or replace function public.team_captain(p_room uuid, p_team int)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from players
   where room_id = p_room and team = p_team
   order by team_joined_at asc nulls last, id asc
   limit 1;
$$;

grant execute on function public.team_captain(uuid, int) to anon, authenticated;

-- Hands command of a team to a crewmate. Goes through an RPC rather than an update because it
-- writes another player's row, which "players update own" forbids from the browser.
create or replace function public.hand_over_captaincy(p_target uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room  uuid;
  v_team  int;
  v_first timestamptz;
begin
  select room_id, team into v_room, v_team
    from players
   where id = p_target;

  if v_room is null then
    raise exception 'No such player';
  end if;
  if v_team is null then
    raise exception 'That player is spectating, not on your team';
  end if;

  -- Lobby only. Once the match is open the board is live under the current captain's hands, and
  -- moving the controls then would strand whatever they were in the middle of.
  if not exists (select 1 from rooms r where r.id = v_room and r.status = 'lobby') then
    raise exception 'Command can only change hands in the lobby';
  end if;

  if not public.is_admin()
     and not exists (
       select 1 from players p
        where p.id = public.team_captain(v_room, v_team)
          and p.user_id = auth.uid()
     )
  then
    raise exception 'Only the team captain can hand over command';
  end if;

  select min(team_joined_at) into v_first
    from players
   where room_id = v_room and team = v_team;

  -- Strictly earlier than the current earliest, so team_captain()'s id tie-break never comes into
  -- it. coalesce covers a team whose members all predate the team_joined_at column: those rows sort
  -- last, so any real timestamp beats them.
  update players
     set team_joined_at = coalesce(v_first, now()) - interval '1 millisecond'
   where id = p_target;

  return true;
end;
$$;

grant execute on function public.hand_over_captaincy(uuid) to anon, authenticated;

-- --- administrators ------------------------------------------------------
-- Two tiers, because "can clear a room" and "can appoint people who can" are different powers:
--
--   owner - the account that runs the site. Can do everything, and is the only tier that can
--           appoint or remove another owner. Seeded by hand and never grantable from the app.
--   admin - ordinary administration, and can grant or revoke ordinary admin.
--
-- The distinction exists so appointing someone cannot backfire: an admin who turns out to be
-- careless can be removed by the owner, and cannot pre-emptively remove the owner.
create table if not exists admins (
  user_id      uuid primary key,
  -- Cached at grant time so the roster still reads sensibly if a profile row is ever removed.
  display_name text,
  is_owner     boolean not null default false,
  granted_by   uuid,
  granted_at   timestamptz not null default now()
);

alter table admins enable row level security;

-- SECURITY DEFINER is load-bearing, not decoration. The policies on `admins` below call these, and
-- those calls read `admins` - if they ran under the caller's rights, evaluating the policy would
-- re-trigger the policy and recurse forever. Running as the owner skips RLS and breaks the cycle.
-- STABLE so Postgres evaluates them once per statement rather than once per row.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from admins a where a.user_id = auth.uid());
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from admins a where a.user_id = auth.uid() and a.is_owner);
$$;

grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.is_owner() to anon, authenticated;

-- Your own row is always visible - that is how the app answers "am I an admin?" without publishing
-- the roster to everyone. Admins additionally see the whole list, because they manage it.
drop policy if exists "admins select" on admins;
create policy "admins select" on admins for select
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "admins insert" on admins;
create policy "admins insert" on admins for insert
  with check (public.is_admin() and (not is_owner or public.is_owner()));

drop policy if exists "admins delete" on admins;
create policy "admins delete" on admins for delete
  using (public.is_admin() and (not is_owner or public.is_owner()));

-- --- operational ---------------------------------------------------------
-- Clears idle rooms on demand, for an admin who needs a slot back now rather than at the next
-- insert. Same sweep enforce_room_limit() runs automatically; this is the manual handle on it.
create or replace function public.admin_prune_rooms()
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrators only' using errcode = 'insufficient_privilege';
  end if;
  return public.prune_stale_rooms();
end;
$$;

grant execute on function public.admin_prune_rooms() to anon, authenticated;

-- --- profiles ------------------------------------------------------------
-- A signed-in identity, so a name follows a player between rooms and devices.
--
-- Optional in every sense: the app runs on anonymous auth, and a player who never signs in has no
-- row here and loses nothing but the convenience of not retyping their nickname. Signing in with
-- Twitch fills display_name and avatar_url; `nickname` is the player's own override on top.
--
-- Public SELECT on purpose. A display name is shown next to every square that player claims, so it
-- is already on everyone's screen - putting it behind a policy would protect nothing while breaking
-- the roster.
create table if not exists profiles (
  id           uuid primary key,
  twitch_id    text unique,
  display_name text not null,
  nickname     text,
  avatar_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint profiles_nickname_length
    check (nickname is null or (btrim(nickname) <> '' and char_length(nickname) between 1 and 20))
);

comment on column profiles.nickname is
  'Player-chosen display override. Null falls back to display_name (the Twitch name). Written only by its owner, via the "profiles update own" policy.';

alter table profiles enable row level security;

drop policy if exists "profiles select" on profiles;
create policy "profiles select" on profiles for select using (true);

drop policy if exists "profiles insert own" on profiles;
create policy "profiles insert own" on profiles for insert with check (id = auth.uid());

drop policy if exists "profiles update own" on profiles;
create policy "profiles update own" on profiles for update using (id = auth.uid());
