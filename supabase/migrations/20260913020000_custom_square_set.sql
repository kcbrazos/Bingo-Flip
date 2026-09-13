-- A host's own squareset, uploaded instead of picked from the bundled four.
--
-- `rooms.square_set` stays a bare id string - it just gains one more legal value, the sentinel
-- CUSTOM_SQUARE_SET_ID ("custom") - and the upload itself lives in this new column as jsonb, since
-- a squareset is structured data and square_set was never meant to hold more than a lookup key.
--
-- No CHECK constraint on the shape: `rooms` has never validated square_set against the registry
-- either (an unrecognized id already just falls back to the default set client-side - see
-- squareSet() in src/lib/squareSets.ts), and the real gate is src/lib/customSquareSet.ts, which
-- every client re-runs on whatever it reads here rather than trusting the write that put it there.
-- A jsonb column can't express "array of objects with a string name" anyway; that check belongs in
-- application code, which already has to run it regardless (a JSON payload that merely PARSES is not
-- the same thing as one buildBingoBoard can safely deal from).

alter table rooms add column if not exists custom_square_set jsonb;

comment on column rooms.custom_square_set is
  'A host-uploaded squareset for this room, as { label, format, data } - see readStoredCustomSquareSet '
  'in src/lib/customSquareSet.ts. Only meaningful when square_set = ''custom''; null otherwise.';

-- Archived alongside every other room setting match_results already copies, so a match played on an
-- upload can still be replayed and named after the room itself is long pruned. Without this, the
-- Almanac would show every custom-set match under "Custom squares" with no way to tell them apart.
alter table match_results add column if not exists custom_square_set jsonb;

comment on column match_results.custom_square_set is
  'Copy of rooms.custom_square_set at archive time - see the note on that column.';

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
