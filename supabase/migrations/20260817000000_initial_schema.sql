-- Bingo Flip: initial schema.
--
-- Two or more teams race to claim squares on ONE shared lockout board. A few of those squares are
-- flip squares: claiming one turns the board over onto a second set of objectives. Ownership is not
-- part of what flips - a flip rewrites the unclaimed squares and nothing else - so there is exactly
-- one ownership grid per match and it survives every flip. See src/types/bingoFlip.ts.
--
-- Design notes:
--   * Players are anonymous (Supabase Anonymous Auth). Each browser gets a stable auth.uid() used to
--     prove "which team am I".
--   * There is no hidden information in this game. Battleship needed row-level security to keep ship
--     positions from opponents; a bingo board is public to everyone including spectators, so the
--     policies here are about who may WRITE, never about who may read.
--   * The board itself is not stored. Every client derives both faces from the room id, the square
--     set and the match seed (src/lib/challenges.ts), so the only per-match state is the claim log.
--   * Claims are resolved by claim_square(), a SECURITY DEFINER function. Lockout, the flip, and the
--     win are all decided in there, under one lock, for the same reason Battleship decided
--     elimination server-side: the client that just lost is the least likely to still be connected.

create extension if not exists pgcrypto;

-- --- rooms ---------------------------------------------------------------
create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  board_size int not null default 5 check (board_size between 3 and 12),
  status text not null default 'lobby' check (status in ('lobby','prep','battle','finished')),
  winner_team int,
  created_at timestamptz not null default now(),

  starting_seconds int not null default 10,
  prep_seconds int not null default 0,
  team_names jsonb,
  -- 9-digit seed players feed to the randomizer, rerolled on every return to the lobby. Also seeds
  -- the board deal and the flip-square placement, so a rematch in one room is a different board.
  seed text,
  square_set text,

  win_condition text not null default 'line' check (win_condition in ('line','majority')),
  flip_count int not null default 3 check (flip_count between 0 and 5),

  -- Lockout: a square belongs to whoever finishes it first, and nobody else can have it.
  --
  -- Off, every team can claim every square, and the teams are racing the clock and each other
  -- rather than denying each other - EldenBingo's GS_Lockout, which defaults on there too. The
  -- difference is enforced in claim_square() rather than by a constraint, because it is per-room and
  -- an index cannot read another table's column. That is safe here for the same reason lockout was
  -- always safe: every claim in a room serializes on the room lock.
  lockout boolean not null default true,

  -- When the match clock started. Every client's clock has to agree, so the instant must come from
  -- the database rather than from whoever pressed the button.
  --
  -- Battleship rode this in the attack log as a sentinel row with a negative cell index, because
  -- adding a column needed DDL it did not want. That trick is unavailable here and would be wrong
  -- anyway: `claims` carries a unique index on (room_id, cell_index), so a marker row would occupy a
  -- cell, and both countdown beats need anchoring off one instant regardless. Written once per match
  -- in the same statement that opens it, so it costs no extra realtime traffic.
  started_at timestamptz,

  -- Which cells flip the board, as cell indices.
  --
  -- The one part of the board that IS stored, because claim_square() has to know whether the square
  -- just taken turns the board over, and reimplementing the client's PRNG in plpgsql to re-derive it
  -- would be two copies of a shuffle that must agree forever. The client computes them
  -- (flipCellsFor) and writes them once at match start.
  --
  -- Storing them costs nothing in secrecy: flip squares are MARKED ON THE BOARD by design - that is
  -- what makes the race for them a race - so this column holds nothing a player cannot already see.
  -- It is frozen once the match leaves the lobby; see rooms_freeze_flip_cells.
  flip_cells int[] not null default '{}'
);

alter table rooms enable row level security;

create policy "rooms select" on rooms for select using (true);
create policy "rooms insert" on rooms for insert with check (true);
create policy "rooms update" on rooms for update using (true);

-- --- players -------------------------------------------------------------
create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  nickname text not null,
  team int,                                    -- null = spectator
  is_host boolean not null default false,
  joined_at timestamptz not null default now(),
  team_joined_at timestamptz,                  -- earliest on a team is its captain
  rejoin_code text default replace(gen_random_uuid()::text, '-', ''),
  unique (room_id, user_id)
);

alter table players enable row level security;

create policy "players select" on players for select using (true);
create policy "players insert" on players for insert with check (user_id = auth.uid());
create policy "players update own" on players for update using (user_id = auth.uid());
create policy "players delete own" on players for delete using (user_id = auth.uid());
create policy "players delete by host" on players for delete using (
  exists (
    select 1 from players host
    where host.room_id = players.room_id
      and host.user_id = auth.uid()
      and host.is_host = true
  )
);

-- --- team_ready ----------------------------------------------------------
create table if not exists team_ready (
  room_id uuid not null references rooms(id) on delete cascade,
  team int not null,
  ready boolean not null default false,
  primary key (room_id, team)
);

alter table team_ready enable row level security;

create policy "team_ready select" on team_ready for select using (true);
create policy "team_ready upsert own team" on team_ready for insert with check (
  exists (
    select 1 from players p
    where p.room_id = team_ready.room_id and p.user_id = auth.uid() and p.team = team_ready.team
  )
);
create policy "team_ready update own team" on team_ready for update using (
  exists (
    select 1 from players p
    where p.room_id = team_ready.room_id and p.user_id = auth.uid() and p.team = team_ready.team
  )
);
create policy "team_ready delete by host" on team_ready for delete using (
  exists (
    select 1 from players h
    where h.room_id = team_ready.room_id and h.user_id = auth.uid() and h.is_host = true
  )
);

-- --- claims --------------------------------------------------------------
-- The whole mutable state of a match: who took which square, and what the board was showing at the
-- time. One row per claimed cell, ever.
create table if not exists claims (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  cell_index int not null,
  team int not null,
  player_id uuid references players(id) on delete set null,
  -- Which face was showing when this landed. Recorded so the log reads correctly after the fact and
  -- a replay can redraw the board as it stood. Never read by win detection - see the header.
  face smallint not null default 0 check (face in (0,1)),
  -- True when this cell was a flip square, i.e. this claim turned the board over.
  flipped boolean not null default false,
  created_at timestamptz not null default now()
);

-- One claim per team per square, which is true in BOTH modes - a team cannot take the same square
-- twice whether or not anyone else may also hold it. Enforced by Postgres rather than by client
-- care: two crewmates clicking the same square together is the normal case in a close match, not an
-- edge one.
--
-- Lockout - at most one TEAM per square - is deliberately not expressed here. It is a per-room
-- setting, and an index cannot consult rooms.lockout, so claim_square() enforces it under the room
-- lock instead. The lock is what makes that airtight rather than merely likely: every claim in a
-- room is serialized on it, so two teams racing at one square cannot both look and both find it free.
create unique index if not exists claims_room_cell_team_uniq on claims (room_id, cell_index, team);
create index if not exists claims_room_cell_idx on claims (room_id, cell_index);
create index if not exists claims_room_created_idx on claims (room_id, created_at);

alter table claims enable row level security;

-- Readable by everyone: the board is public, and spectators and overlays are first-class here.
create policy "claims select" on claims for select using (true);

-- No INSERT policy at all. Every claim goes through claim_square(), which is SECURITY DEFINER and
-- therefore bypasses RLS - so a client cannot write a claim directly, cannot claim for another team,
-- and cannot claim without the flip and the win being evaluated in the same breath.
create policy "claims delete by host" on claims for delete using (
  exists (
    select 1 from players h
    where h.room_id = claims.room_id and h.user_id = auth.uid() and h.is_host = true
  )
);

alter table claims replica identity full;

-- --- flip cells are frozen once play starts -------------------------------
-- Moving flip_cells once a match is under way would retroactively change whether claims already
-- made had flipped the board. So the column is immutable for exactly as long as those claims mean
-- something, and no longer.
--
-- Both halves of that are load-bearing, and the first draft - "immutable once the room leaves the
-- lobby" - got both wrong, in ways nothing caught because every check wrote `status: 'battle'`
-- straight onto a lobby:
--
--   Setting them.  startBattle() writes the flip squares in the SAME statement that moves the room
--                  out of PREP, so the trigger refused the one write that is supposed to set them.
--                  The board could never be opened. 'prep' is still setup - claim_square() will not
--                  run in it - so there is nothing there to rewrite.
--   Clearing them. resetRoomToLobby() clears them in the same statement that sends a FINISHED room
--                  back to the lobby, and that was refused too, so "Play again" and the host's
--                  "End match" both failed outright.
--
-- What remains forbidden is the case the rule is actually about: moving them while the room stays
-- in a state where claims exist.
create or replace function public.rooms_freeze_flip_cells()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('battle', 'finished')
     and new.status <> 'lobby'
     and new.flip_cells is distinct from old.flip_cells then
    raise exception 'flip squares cannot move once the match has started'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists rooms_freeze_flip_cells_trg on rooms;
create trigger rooms_freeze_flip_cells_trg
  before update on rooms
  for each row
  execute function public.rooms_freeze_flip_cells();

-- --- claim_square --------------------------------------------------------
-- Claim one square for the calling player's team.
--
-- Returns the team that holds the square afterwards - the caller's own on a successful claim, and
-- somebody else's when lockout is on and they got there first. Never raises for a lost race: losing
-- a square to an opponent is an ordinary outcome of this game, not an error.
--
-- Everything that has to be decided together is decided here under the room lock: whether the square
-- was available, which face it was claimed on, whether it flips the board, and whether it wins the
-- match. Deciding any of those in a client would mean two clients could reach different answers
-- about a match they are both in.
create or replace function public.claim_square(p_room_id uuid, p_cell_index int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  rm         rooms%rowtype;
  me         players%rowtype;
  existing   claims%rowtype;
  v_face     smallint;
  v_flipped  boolean;
  v_taken    boolean;
  v_cells    int;
  v_held     int;
  v_size     int;
  r          int;
  c          int;
  v_line_win boolean;
begin
  -- Serializes every claim in this room on one row. A bingo match makes a few claims a minute, so
  -- the contention costs nothing, and it is what lets lockout, the flip parity and win detection all
  -- read a consistent board. `rooms` is not in the realtime publication for this reason - locking it
  -- per claim is cheap only because nothing broadcasts on it.
  select * into rm from rooms where id = p_room_id for update;
  if not found then return null; end if;
  if rm.status <> 'battle' then return null; end if;

  v_size  := rm.board_size;
  v_cells := v_size * v_size;
  if p_cell_index < 0 or p_cell_index >= v_cells then return null; end if;

  select * into me from players
   where room_id = p_room_id and user_id = auth.uid();
  if not found or me.team is null then return null; end if;   -- spectators cannot claim

  -- Has anyone taken this square yet? Asked before the mode is consulted, because both the lockout
  -- check and the flip rule below need the answer. Under the room lock this cannot be stale.
  select exists (select 1 from claims where room_id = p_room_id and cell_index = p_cell_index)
    into v_taken;

  if rm.lockout then
    -- Lockout: first team to finish it owns it. Report who, rather than raising - losing a race is
    -- an ordinary outcome, and the caller wants to know who beat them to it.
    if v_taken then
      select * into existing from claims where room_id = p_room_id and cell_index = p_cell_index;
      return existing.team;
    end if;
  else
    -- Non-lockout: everyone may claim everything, so the only thing forbidden is claiming a square
    -- this team already holds. The unique index would refuse it anyway; catching it here keeps a
    -- double-click an ordinary no-op rather than a constraint violation surfacing in the client.
    select * into existing from claims
     where room_id = p_room_id and cell_index = p_cell_index and team = me.team;
    if found then return me.team; end if;
  end if;

  -- The face is the parity of the flips so far, not a stored column, so it can never drift out of
  -- step with the claims that caused it.
  select (count(*) % 2)::smallint into v_face
    from claims where room_id = p_room_id and flipped;

  -- Only the FIRST completion of a flip objective turns the board.
  --
  -- Under lockout this is the same thing as "is it a flip square", since nobody can be second. Under
  -- non-lockout it is the rule that keeps the board from strobing: four teams working through the
  -- same three flip squares would otherwise turn it a dozen times, which is noise rather than
  -- tactics. `flipped` therefore means "this claim turned the board", not "this square is a flip
  -- square" - which is what lets faceFromClaims stay a plain parity over the log.
  v_flipped := p_cell_index = any (rm.flip_cells) and not v_taken;

  insert into claims (room_id, cell_index, team, player_id, face, flipped)
  values (p_room_id, p_cell_index, me.team, me.id, v_face, v_flipped);

  -- --- did that win it? ---------------------------------------------------
  -- Phrased throughout as "how many cells of this line does MY TEAM hold", never as "who owns this
  -- cell". That is what makes one piece of logic serve both modes: under non-lockout a cell has no
  -- single owner, so any question of the second shape has no answer.
  --
  -- Reads ownership alone. A flip changes what the empty squares ask for and nothing about who has
  -- won, so neither branch below looks at `face`.
  --
  -- Under non-lockout more than one team can eventually satisfy the condition; the match ends the
  -- first time any of them does, because this runs on the claim that does it and the update is
  -- guarded on status still being 'battle'.
  if rm.win_condition = 'majority' then
    select count(*) into v_held from claims
     where room_id = p_room_id and team = me.team;
    -- Strictly more than half, so an even board needs a genuine majority rather than a shared half.
    if v_held >= (v_cells / 2) + 1 then
      update rooms set status = 'finished', winner_team = me.team
       where id = p_room_id and status = 'battle';
    end if;
  else
    -- Only lines through the cell just claimed can have been completed by it, so this checks that
    -- cell's row, its column, and whichever diagonals it lies on - never all 2N+2 lines.
    r := p_cell_index / v_size;
    c := p_cell_index % v_size;

    -- row
    select count(*) into v_held from claims
     where room_id = p_room_id and team = me.team
       and cell_index >= r * v_size and cell_index < (r + 1) * v_size;
    v_line_win := v_held = v_size;

    -- column
    if not v_line_win then
      select count(*) into v_held from claims
       where room_id = p_room_id and team = me.team and cell_index % v_size = c;
      v_line_win := v_held = v_size;
    end if;

    -- leading diagonal, only if the claimed cell is on it
    if not v_line_win and r = c then
      select count(*) into v_held from claims
       where room_id = p_room_id and team = me.team
         and cell_index / v_size = cell_index % v_size;
      v_line_win := v_held = v_size;
    end if;

    -- counter diagonal, likewise
    if not v_line_win and r + c = v_size - 1 then
      select count(*) into v_held from claims
       where room_id = p_room_id and team = me.team
         and (cell_index / v_size) + (cell_index % v_size) = v_size - 1;
      v_line_win := v_held = v_size;
    end if;

    if v_line_win then
      update rooms set status = 'finished', winner_team = me.team
       where id = p_room_id and status = 'battle';
    end if;
  end if;

  return me.team;
end;
$$;

grant execute on function public.claim_square(uuid, int) to anon, authenticated;

-- --- unclaim_square ------------------------------------------------------
-- Give a square back. EldenBingo lets a player un-mark a square they marked by mistake, and a
-- lockout board with no way back is unforgiving of a misclick.
--
-- Only the team that holds it may release it, and only while the match is live. A claim that flipped
-- the board takes the flip back with it, which falls out of faceFromClaims for free: the parity is
-- counted from the surviving rows, so removing a flip claim turns the board back.
create or replace function public.unclaim_square(p_room_id uuid, p_cell_index int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  rm       rooms%rowtype;
  me       players%rowtype;
  existing claims%rowtype;
begin
  select * into rm from rooms where id = p_room_id for update;
  if not found or rm.status <> 'battle' then return false; end if;

  select * into me from players where room_id = p_room_id and user_id = auth.uid();
  if not found or me.team is null then return false; end if;

  -- Scoped to this team's own claim from the start, rather than fetching whoever holds the square
  -- and then checking it was us. Under non-lockout there may be several claims on this cell and no
  -- single "whoever holds it" to fetch.
  select * into existing from claims
   where room_id = p_room_id and cell_index = p_cell_index and team = me.team;
  if not found then return false; end if;

  delete from claims where id = existing.id;

  -- If that was the claim that turned the board, and another team still holds this square, promote
  -- the oldest survivor so exactly one claim per flip cell carries `flipped`.
  --
  -- Reachable under non-lockout only, but it matters there: without it the board would turn back
  -- while the square stayed taken, and the face - a parity derived from this log - would disagree
  -- with the log it is derived from. Under lockout the delete removes the only claim on the cell,
  -- the update below matches nothing, and the board correctly turns back.
  if existing.flipped then
    update claims set flipped = true
     where id = (
       select id from claims
        where room_id = p_room_id and cell_index = p_cell_index
        order by created_at
        limit 1
     );
  end if;

  return true;
end;
$$;

grant execute on function public.unclaim_square(uuid, int) to anon, authenticated;

-- --- room housekeeping ---------------------------------------------------
-- Idle rooms are found from the timestamps already on their rows rather than via a last_activity_at
-- column maintained by triggers: touching `rooms` per claim would serialize claims on that row for a
-- second reason and broadcast a room UPDATE on every square taken.
create or replace function public.prune_stale_rooms()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  with activity as (
    select
      r.id,
      r.status,
      greatest(
        r.created_at,
        coalesce((select max(cl.created_at) from claims cl where cl.room_id = r.id), r.created_at),
        coalesce((select max(p.joined_at)   from players p where p.room_id = r.id), r.created_at)
      ) as last_active
    from rooms r
  ),
  dead as (
    delete from rooms r
    using activity act
    where act.id = r.id
      and act.last_active < case
            -- A finished match is already over, so it doesn't need the full idle window.
            when act.status = 'finished' then now() - interval '10 minutes'
            else now() - interval '1 hour'
          end
    returning 1
  )
  select count(*) into removed from dead;

  return removed;
end;
$$;

revoke all on function public.prune_stale_rooms() from public;

create or replace function public.enforce_room_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  max_rooms constant integer := 15;
  room_count integer;
begin
  perform public.prune_stale_rooms();

  select count(*) into room_count from rooms;

  if room_count >= max_rooms then
    -- check_violation (23514), NOT unique_violation (23505): createRoom() retries on 23505 for
    -- room-code collisions, and a capacity error must break out of that loop immediately.
    raise exception
      'All % game rooms are currently in use. Rooms are cleared automatically after an hour of inactivity - try again in a bit, or join an existing room with its code.',
      max_rooms
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists rooms_enforce_limit on rooms;
create trigger rooms_enforce_limit
  before insert on rooms
  for each row
  execute function public.enforce_room_limit();

-- --- realtime ------------------------------------------------------------
-- `claims`, `players` and `team_ready` broadcast; `rooms` deliberately does not carry the claim
-- traffic, but clients do need its status and winner, so it is published and simply never written
-- per claim except on the transition that ends the match.
alter publication supabase_realtime add table claims;
alter publication supabase_realtime add table players;
alter publication supabase_realtime add table team_ready;
alter publication supabase_realtime add table rooms;
