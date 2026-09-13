-- Ask-to-pause, for the same reason Elden Battleship had one: a match can run twenty minutes, and a
-- crew needs a way to step away from it that does not mean quitting the room.
--
-- Modelled directly on team_ready rather than as a new table: pausing is exactly "every team agrees
-- to something before it happens", which is the readiness gate's whole shape. Reusing it means
-- pausing costs two new columns on `rooms` - already subscribed over realtime - and one RPC, instead
-- of a second table, a second channel and a second self-heal effect in useRoom.
--
-- Both directions need the same unanimity. One team pausing the room unilaterally would let it stall
-- a match it was about to lose; requiring everyone to ask is what makes it a break rather than a
-- weapon - and resuming asks the same question in reverse, so a team can hold the room paused past
-- the point its opponents are ready to continue.

alter table rooms add column if not exists paused_at timestamptz;

-- Teams that currently want the match paused. When this holds every active team, the host's client
-- flips paused_at on (see pauseMatch in lib/rooms.ts); when it stops holding all of them - anyone
-- withdrawing their vote is "I want to resume" - the host's client flips it off again and shifts
-- started_at forward by however long the room sat paused. See matchTime.ts for the clock side of
-- that: every phase is a function of started_at and the current instant, so sliding started_at
-- forward is the entire resume - nothing else about a match's timing needs to know pausing exists.
alter table rooms add column if not exists pause_votes int[] not null default '{}';

-- Only the host may flip paused_at (and, on resume, started_at) - the same restriction
-- guard_match_open already puts on opening, ending or resetting a match, for the same reason: those
-- are the columns every client's clock is anchored to, and letting any crew member move them is
-- letting any crew member reset everyone else's timer.
--
-- Replaces guard_match_open wholesale rather than adding a second trigger, so there is exactly one
-- place that decides who may move the columns a match's timing depends on.
create or replace function public.guard_match_open()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status is not distinct from old.status
     and new.started_at is not distinct from old.started_at
     and new.winner_team is not distinct from old.winner_team
     and new.paused_at is not distinct from old.paused_at then
    return new;
  end if;

  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  if public.is_admin() then
    return new;
  end if;

  if exists (
    select 1 from players p
     where p.room_id = new.id and p.user_id = auth.uid() and p.is_host
  ) then
    return new;
  end if;

  raise exception 'Only the host can open, end, reset or pause a match';
end;
$$;

-- --- request_pause ---------------------------------------------------------
-- Adds or withdraws the calling player's TEAM's vote to pause. Read-modify-write under the room lock
-- rather than a client-side array patch, so two teams voting within the same instant cannot lose one
-- of the votes to the other's overwrite - the same reason claim_square locks the room row.
--
-- Refused outside 'battle': there is no clock running in the lobby or the readiness gate for a pause
-- to freeze, and the votes would only have to be cleared again on the way into battle.
create or replace function public.request_pause(p_room_id uuid, p_team int, p_want boolean)
returns int[]
language plpgsql
security definer
set search_path = public
as $$
declare
  rm rooms%rowtype;
  v_votes int[];
begin
  select * into rm from rooms where id = p_room_id for update;
  if not found or rm.status <> 'battle' then return null; end if;

  if not exists (
    select 1 from players where room_id = p_room_id and user_id = auth.uid() and team = p_team
  ) then
    raise exception 'Not on that team';
  end if;

  if p_want then
    select array_agg(distinct t) into v_votes from unnest(rm.pause_votes || array[p_team]) t;
  else
    select coalesce(array_agg(t), '{}') into v_votes from unnest(rm.pause_votes) t where t <> p_team;
  end if;

  update rooms set pause_votes = v_votes where id = p_room_id;
  return v_votes;
end;
$$;

grant execute on function public.request_pause(uuid, int, boolean) to anon, authenticated;

-- claim_square / unclaim_square: refuse while paused, on top of the client already hiding the
-- controls for it. The client is the only thing keeping a click from firing in the first place, but
-- the database is what makes a paused board actually unclaimable rather than merely marked so.
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
  select * into rm from rooms where id = p_room_id for update;
  if not found then return null; end if;
  if rm.status <> 'battle' or rm.paused_at is not null then return null; end if;

  v_size  := rm.board_size;
  v_cells := v_size * v_size;
  if p_cell_index < 0 or p_cell_index >= v_cells then return null; end if;

  select * into me from players
   where room_id = p_room_id and user_id = auth.uid();
  if not found or me.team is null then return null; end if;

  select exists (select 1 from claims where room_id = p_room_id and cell_index = p_cell_index)
    into v_taken;

  if rm.lockout then
    if v_taken then
      select * into existing from claims where room_id = p_room_id and cell_index = p_cell_index;
      return existing.team;
    end if;
  else
    select * into existing from claims
     where room_id = p_room_id and cell_index = p_cell_index and team = me.team;
    if found then return me.team; end if;
  end if;

  select (count(*) % 2)::smallint into v_face
    from claims where room_id = p_room_id and flipped;

  v_flipped := p_cell_index = any (rm.flip_cells) and not v_taken;

  insert into claims (room_id, cell_index, team, player_id, face, flipped)
  values (p_room_id, p_cell_index, me.team, me.id, v_face, v_flipped);

  if rm.win_condition = 'majority' then
    select count(*) into v_held from claims
     where room_id = p_room_id and team = me.team;
    if v_held >= (v_cells / 2) + 1 then
      update rooms set status = 'finished', winner_team = me.team
       where id = p_room_id and status = 'battle';
    end if;
  else
    r := p_cell_index / v_size;
    c := p_cell_index % v_size;

    select count(*) into v_held from claims
     where room_id = p_room_id and team = me.team
       and cell_index >= r * v_size and cell_index < (r + 1) * v_size;
    v_line_win := v_held = v_size;

    if not v_line_win then
      select count(*) into v_held from claims
       where room_id = p_room_id and team = me.team and cell_index % v_size = c;
      v_line_win := v_held = v_size;
    end if;

    if not v_line_win and r = c then
      select count(*) into v_held from claims
       where room_id = p_room_id and team = me.team
         and cell_index / v_size = cell_index % v_size;
      v_line_win := v_held = v_size;
    end if;

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
  if not found or rm.status <> 'battle' or rm.paused_at is not null then return false; end if;

  select * into me from players where room_id = p_room_id and user_id = auth.uid();
  if not found or me.team is null then return false; end if;

  select * into existing from claims
   where room_id = p_room_id and cell_index = p_cell_index and team = me.team;
  if not found then return false; end if;

  delete from claims where id = existing.id;

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
