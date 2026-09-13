-- Practice matches - played exactly like a real one, never archived.
--
-- A room setting, not a one-off choice at match start, for the same reason board size and win
-- condition are: a crew warming up shouldn't have to remember to flip it back before the match that
-- counts, and "Play again" in the same room keeps whatever the last one had.
--
-- Enforced here, not just in the client: archive_match() now refuses a practice room outright, the
-- same way it already refuses a room that isn't finished or never started. The client also skips
-- calling it at all when the room is marked practice (see Room.tsx), but that is an optimisation
-- against a pointless round trip - this guard is what actually keeps a practice match out of
-- match_results, since archive_match() is SECURITY DEFINER and callable directly by anyone in the
-- room regardless of what the UI does.

alter table rooms add column if not exists practice boolean not null default false;

comment on column rooms.practice is
  'True when this match is never archived, win or not - see PRACTICE_MODES and archive_match().';

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
  if rm.started_at is null then return null; end if;
  if rm.practice then return null; end if;

  v_key := rm.code || ':' || to_char(rm.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSZ');

  select id into v_id from match_results where match_key = v_key;
  if found then return v_id; end if;

  select count(*), count(*) filter (where flipped)
    into v_total, v_flips
    from claims where room_id = p_room_id;

  if v_total = 0 then return null; end if;

  insert into match_results (
    match_key, room_code, square_set, custom_square_set, board_size, lockout, win_condition,
    flip_count, seed,
    bonus_per_bingo, target_score,
    winner_team, started_at, finished_at, duration_seconds, total_claims, total_flips, final_face
  )
  values (
    v_key, rm.code, rm.square_set, rm.custom_square_set, rm.board_size, rm.lockout, rm.win_condition,
    rm.flip_count, rm.seed,
    case when rm.win_condition = 'points' then rm.bonus_per_bingo else 0 end,
    case when rm.win_condition = 'points'
         then coalesce(rm.target_score, (rm.board_size * rm.board_size / 2) + 1)
         else null end,
    rm.winner_team, rm.started_at, now(),
    greatest(0, extract(epoch from (now() - rm.started_at))::int),
    v_total, v_flips, (v_flips % 2)::smallint
  )
  on conflict (match_key) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from match_results where match_key = v_key;
    return v_id;
  end if;

  insert into match_players (match_id, user_id, nickname, team, squares, flips, won)
  select
    v_id, p.user_id, p.nickname, p.team,
    coalesce(c.squares, 0), coalesce(c.flips, 0),
    rm.winner_team is not null and p.team = rm.winner_team
  from players p
  left join (
    select player_id, count(*) as squares, count(*) filter (where flipped) as flips
      from claims where room_id = p_room_id group by player_id
  ) c on c.player_id = p.id
  where p.room_id = p_room_id and p.team is not null
  on conflict (match_id, user_id) do nothing;

  return v_id;
end;
$$;

grant execute on function public.archive_match(uuid) to anon, authenticated;
