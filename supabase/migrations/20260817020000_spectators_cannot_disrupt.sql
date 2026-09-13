-- A spectator may READ everything about a match and CHANGE nothing about it.
--
-- Carried over from Elden Battleship, where this arrived once the front page started publishing
-- every live room's code. Until then a room code was a shared secret - not much of one, it was read
-- aloud on stream, but the write policies were written assuming everyone holding one had been let in
-- on purpose, and "any player in the room" stood in for "somebody the room trusts". A published
-- list of live matches ends that: a stranger can walk into one with two clicks. Which is the point,
-- and it means the stand-in has to be replaced with the real thing wherever it carried weight.
--
-- fetchLiveBattles() still publishes that list here, so the same exposure exists and the same rules
-- are needed. The initial schema shipped without them; this is that omission fixed.
--
-- Nothing here narrows what anyone can SEE. Every read policy is left exactly as it was.

-- ===========================================================================
--  1. Rooms: a spectator may not end, reset, rename or resize a match
-- ===========================================================================
-- The initial schema's "rooms update" was `using (true)` - which is: set status='finished' with a
-- winner of your choosing, roll the seed mid-match, rename both teams, or resize the board out from
-- under a board in play.
--
-- Scoped to people with a stake in the match: anyone holding a team, plus the host, who runs the
-- room whether or not they are playing (Room.tsx supports a host who is spectating, and they keep
-- every host power).
drop policy if exists "rooms update" on rooms;
create policy "rooms update by crew" on rooms for update using (
  exists (
    select 1 from players p
     where p.room_id = rooms.id
       and p.user_id = auth.uid()
       and (p.team is not null or p.is_host)
  )
  or public.is_admin()
);

-- ===========================================================================
--  2. Opening a match is the host's alone
-- ===========================================================================
-- startBattle() writes flip_cells, started_at and status in one statement, and Room.tsx only calls
-- it from the host's client. Left to the policy above, any crew member could do it - reopen a
-- finished match, or move started_at and reset every player's clock mid-race, which also decides
-- who may claim.
--
-- A trigger rather than a policy because RLS cannot compare the old row to the new one: USING sees
-- the row as it was, WITH CHECK sees it as it will be, and neither can say "this column did not
-- change".
--
-- Invoker, not definer: inside a SECURITY DEFINER function current_user is the owner, so the escape
-- below would pass for every caller alive and the guard would wave through what it exists to stop.
-- That escape is what lets claim_square() write status and winner_team, which is the whole point of
-- deciding the win in there.
create or replace function public.guard_match_open()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status is not distinct from old.status
     and new.started_at is not distinct from old.started_at
     and new.winner_team is not distinct from old.winner_team then
    return new;
  end if;

  -- PostgREST switches to service_role for service-key requests; postgres/supabase_admin cover the
  -- SQL editor, later migrations, and the SECURITY DEFINER functions that settle a match.
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

  raise exception 'Only the host can open, end or reset a match';
end;
$$;

drop trigger if exists rooms_guard_match_open on rooms;
create trigger rooms_guard_match_open
  before update on rooms
  for each row execute function public.guard_match_open();

-- ===========================================================================
--  3. Players: you cannot walk into a match and take a team
-- ===========================================================================
-- The one that matters most, and the least obvious. "players update own" lets you write your own
-- row, and `team` is a column on it - so a spectator could simply PATCH themselves onto a team
-- mid-match. That is not cosmetic: being on a team is what claim_square() checks before it will
-- claim anything, and what team_ready keys off. One PATCH and a stranger is playing.
--
-- The UI only offers the team picker in the lobby and on the post-match screen, so this forbids
-- nothing anybody can currently do by hand - it stops it being possible by URL.
--
-- ADAPTED: the statuses are lobby / prep / battle / finished now. Prep is grouped with battle
-- rather than with the lobby even though nothing has been claimed yet, because the host opens the
-- match the moment every team has marked itself ready - and a team that empties out after marking
-- ready would hold that transition open with nobody left in it.
create or replace function public.guard_player_team()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_status text;
begin
  if new.team is not distinct from old.team then
    return new;
  end if;

  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  select status into v_status from rooms where id = new.room_id;

  -- Lobby: teams are being picked. Finished: the recap is up and teams reshuffle for the next match
  -- (Room.tsx's FinishedView offers the picker there deliberately, so a rematch doesn't have to wait
  -- on the host resetting the room).
  if v_status in ('lobby', 'finished') then
    return new;
  end if;

  if public.is_admin() then
    return new;
  end if;

  raise exception 'Teams are settled once a match is under way';
end;
$$;

drop trigger if exists players_guard_team on players;
create trigger players_guard_team
  before update on players
  for each row execute function public.guard_player_team();

-- claim_player_slot() (rejoin codes) is untouched by this: it takes over an existing row by writing
-- user_id, and that row already holds the team it is being handed back. The team does not change,
-- so the trigger returns on its first line. Rejoining mid-match still works.
