-- What survives a match.
--
-- Until now nothing did. A room holds its claim log until somebody starts the next match, and
-- resetRoomToLobby() deletes every row of it; the pruner takes idle rooms within the hour. So a
-- finished match left no trace at all, and there was nothing for a stats page to read.
--
-- Deliberately small. Elden Battleship archived four tables and built a record book, an almanac and
-- a per-square census on top of them - which is a lot of machinery to maintain for numbers nobody
-- had asked for yet. Two tables answer the questions people actually ask after a match: who won,
-- how long it took, and who has been doing well lately.
--
-- Both are denormalised and carry no foreign key to `players` or `rooms`, on purpose: those rows are
-- deleted when the room is cleared, and a record of a match that vanishes when the room does is not
-- a record.

-- --- one row per finished match -------------------------------------------
create table if not exists match_results (
  id uuid primary key default gen_random_uuid(),

  /**
   * What makes archiving idempotent.
   *
   * Every client sitting on the finished screen calls archive_match() when it mounts - there is no
   * single writer, because the one client guaranteed to be present is not knowable in advance. The
   * room code alone would collide across rematches in the same room, so the start instant goes in
   * too: one key per match, and the second caller's insert does nothing.
   */
  match_key text unique not null,

  room_code text not null,
  square_set text,
  board_size int not null,
  lockout boolean not null,
  win_condition text not null,
  flip_count int not null,
  seed text,

  winner_team int,
  -- Null where the room was ended by hand rather than won.
  started_at timestamptz,
  finished_at timestamptz not null default now(),
  duration_seconds int,

  total_claims int not null default 0,
  /** How many times the board actually turned over. At most flip_count; often fewer. */
  total_flips int not null default 0,
  /** Which face was showing at the end, so a recap can redraw the board as it stood. */
  final_face smallint not null default 0
);

create index if not exists match_results_finished_idx on match_results (finished_at desc);

alter table match_results enable row level security;

-- Public, like everything else about a match. A leaderboard nobody can read is not a leaderboard.
drop policy if exists "match_results select" on match_results;
create policy "match_results select" on match_results for select using (true);

-- No INSERT policy at all. archive_match() is SECURITY DEFINER and therefore bypasses RLS, which
-- means a client cannot write a result directly - cannot invent a match, cannot award itself a win.
-- Same arrangement as `claims`, and for the same reason.
drop policy if exists "match_results admin delete" on match_results;
create policy "match_results admin delete" on match_results for delete using (public.is_admin());

drop policy if exists "match_results admin update" on match_results;
create policy "match_results admin update" on match_results for update using (public.is_admin());

-- --- one row per player per finished match ---------------------------------
create table if not exists match_players (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references match_results(id) on delete cascade,

  /**
   * The auth uuid, which is the identity the Twitch login moves around.
   *
   * Not the player row's id: that row is deleted with the room. A player who signs in with Twitch on
   * a second device arrives under a fresh anonymous uuid, and the login function reassigns these
   * rows to it - see reclaim() in supabase/functions/twitch-login. That is only possible because
   * this column is a bare uuid with no foreign key behind it.
   */
  user_id uuid,

  /** Cached at archive time. The `players` row it came from does not outlive the room. */
  nickname text not null,
  team int not null,

  squares int not null default 0,
  /** Squares this player claimed that turned the board over. */
  flips int not null default 0,
  won boolean not null default false,

  unique (match_id, user_id)
);

create index if not exists match_players_user_idx on match_players (user_id);

alter table match_players enable row level security;

drop policy if exists "match_players select" on match_players;
create policy "match_players select" on match_players for select using (true);

drop policy if exists "match_players admin delete" on match_players;
create policy "match_players admin delete" on match_players for delete using (public.is_admin());

-- --- archive_match ---------------------------------------------------------
-- Files a finished match. Safe to call from every client, repeatedly.
--
-- Returns the match id, whether this call is the one that wrote it or the twentieth to find it
-- already there. Returns null for a room that is not finished, which is the ordinary case on every
-- other screen.
--
-- MUST be called before the room returns to the lobby. resetRoomToLobby() deletes the claim log,
-- and this reads it - so the finished screen archives on mount, which is the last moment the log is
-- guaranteed to exist and the first moment the result is final.
create or replace function public.archive_match(p_room_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  rm       rooms%rowtype;
  v_key    text;
  v_id     uuid;
  v_flips  int;
  v_total  int;
begin
  select * into rm from rooms where id = p_room_id;
  if not found or rm.status <> 'finished' then return null; end if;

  -- A room ended by hand before it ever opened has no start instant and no claims. There is nothing
  -- there worth a row in the record.
  if rm.started_at is null then return null; end if;

  v_key := rm.code || ':' || to_char(rm.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSZ');

  select id into v_id from match_results where match_key = v_key;
  if found then return v_id; end if;

  select count(*), count(*) filter (where flipped)
    into v_total, v_flips
    from claims where room_id = p_room_id;

  -- Nothing was claimed, so nothing happened. Recording it would put empty rows in front of the
  -- first real result on the stats page.
  if v_total = 0 then return null; end if;

  insert into match_results (
    match_key, room_code, square_set, board_size, lockout, win_condition, flip_count, seed,
    winner_team, started_at, finished_at, duration_seconds, total_claims, total_flips, final_face
  )
  values (
    v_key, rm.code, rm.square_set, rm.board_size, rm.lockout, rm.win_condition, rm.flip_count,
    rm.seed, rm.winner_team, rm.started_at, now(),
    greatest(0, extract(epoch from (now() - rm.started_at))::int),
    v_total, v_flips, (v_flips % 2)::smallint
  )
  -- Two clients can reach the insert between one another's lookup and write. The unique key on
  -- match_key is what actually settles it; this turns the loser's collision into a no-op.
  on conflict (match_key) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from match_results where match_key = v_key;
    return v_id;
  end if;

  -- Everyone who held a team, whether or not they claimed anything: turning up and being shut out is
  -- a result too, and a player whose squares were all taken from them would otherwise vanish from
  -- their own match.
  insert into match_players (match_id, user_id, nickname, team, squares, flips, won)
  select
    v_id,
    p.user_id,
    p.nickname,
    p.team,
    coalesce(c.squares, 0),
    coalesce(c.flips, 0),
    rm.winner_team is not null and p.team = rm.winner_team
  from players p
  left join (
    select player_id, count(*) as squares, count(*) filter (where flipped) as flips
      from claims
     where room_id = p_room_id
     group by player_id
  ) c on c.player_id = p.id
  where p.room_id = p_room_id and p.team is not null
  on conflict (match_id, user_id) do nothing;

  return v_id;
end;
$$;

grant execute on function public.archive_match(uuid) to anon, authenticated;
