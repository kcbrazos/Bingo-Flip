-- Bingos either WIN, or they are worth points. Those are the two formats.
--
-- The schema shipped with three win conditions - line, majority - and a majority match simply did
-- not care about bingos at all. That is not how these events are actually run: plenty of formats
-- play to a score where completing a line is worth a few extra points rather than ending the match,
-- which is EldenBingo's GS_BonusPerBingo. There was no way to express it.
--
-- So the question a host is asked is now the binary one: do bingos win, or do they score?
--
--   line   - the first completed row, column or diagonal takes the match. Unchanged.
--   points - a square is a point, a completed line is worth `bonus_per_bingo` more, and the first
--            team to `target_score` wins.
--
-- `majority` is GONE, folded into points rather than kept beside it: it was exactly points with a
-- bonus of zero and a target of half the board plus one, and two names for one rule is a setting
-- people have to be told the difference between. Choosing a bonus of 0 gets it back, and the target
-- still defaults to that same half-plus-one - so the old behaviour is the default behaviour.

alter table rooms add column if not exists bonus_per_bingo int not null default 1;
alter table rooms add column if not exists target_score int;

alter table rooms drop constraint if exists rooms_bonus_per_bingo_check;
alter table rooms add constraint rooms_bonus_per_bingo_check
  check (bonus_per_bingo between 0 and 2);

comment on column rooms.bonus_per_bingo is
  'Extra points a completed line is worth under the points condition. 0 makes lines worth nothing, which is the old majority rule.';

comment on column rooms.target_score is
  'Score that wins a points match. Null reads as (cells / 2) + 1, which is the majority threshold.';

-- Any room still carrying the old name becomes the format it always was. There should be none -
-- nothing has been played yet - but a constraint that fails on deploy because of one forgotten row
-- is a miserable way to find that out.
update rooms set win_condition = 'points' where win_condition = 'majority';

alter table rooms drop constraint if exists rooms_win_condition_check;
alter table rooms add constraint rooms_win_condition_check
  check (win_condition in ('line', 'points'));

-- --- claim_square, with scoring ------------------------------------------
-- Restated in full because create-or-replace cannot patch a function body. Everything outside the
-- win branch is unchanged from the initial schema; the comments there still apply.
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
  v_lines    int;
  v_score    int;
  v_target   int;
  r          int;
  c          int;
  v_line_win boolean;
begin
  select * into rm from rooms where id = p_room_id for update;
  if not found then return null; end if;
  if rm.status <> 'battle' then return null; end if;

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

  -- --- did that win it? ---------------------------------------------------
  -- Phrased throughout as "how many cells of this line does MY TEAM hold", never as "who owns this
  -- cell". That is what makes one piece of logic serve both lockout modes: under non-lockout a cell
  -- has no single owner, so any question of the second shape has no answer.
  --
  -- Reads ownership alone. A flip changes what the empty squares ask for and nothing about who has
  -- won, so neither branch below looks at `face`.
  if rm.win_condition = 'points' then
    select count(*) into v_held from claims
     where room_id = p_room_id and team = me.team;

    -- Every completed line this team holds, in four subqueries rather than the 2N+2 separate counts
    -- the line branch below can get away with. That branch only has to look at lines through the
    -- square just claimed, because only those can have been completed by it. A score has to be the
    -- whole board every time, since the bonus is part of a running total rather than a finish line.
    select
      (select count(*) from (
         select 1 from claims where room_id = p_room_id and team = me.team
          group by cell_index / v_size having count(*) = v_size) rows_done)
    + (select count(*) from (
         select 1 from claims where room_id = p_room_id and team = me.team
          group by cell_index % v_size having count(*) = v_size) cols_done)
    + (case when (select count(*) from claims
                   where room_id = p_room_id and team = me.team
                     and cell_index / v_size = cell_index % v_size) = v_size then 1 else 0 end)
    + (case when (select count(*) from claims
                   where room_id = p_room_id and team = me.team
                     and (cell_index / v_size) + (cell_index % v_size) = v_size - 1) = v_size
            then 1 else 0 end)
      into v_lines;

    v_score  := v_held + (v_lines * rm.bonus_per_bingo);
    -- Null target reads as the majority threshold, so a points room left alone plays the rule the
    -- `majority` condition used to name.
    v_target := coalesce(rm.target_score, (v_cells / 2) + 1);

    if v_score >= v_target then
      update rooms set status = 'finished', winner_team = me.team
       where id = p_room_id and status = 'battle';
    end if;
  else
    -- Only lines through the cell just claimed can have been completed by it, so this checks that
    -- cell's row, its column, and whichever diagonals it lies on - never all 2N+2 lines.
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

grant execute on function public.claim_square(uuid, int) to anon, authenticated;

-- --- the archive records the format it was played under --------------------
alter table match_results add column if not exists bonus_per_bingo int not null default 0;
alter table match_results add column if not exists target_score int;

comment on column match_results.bonus_per_bingo is
  'What a completed line was worth in this match. 0 under the line condition, where lines win outright rather than scoring.';

-- archive_match restated so the record carries the scoring settings. Without them a points match
-- files as "won by points" with no way to know whether a line was worth two or nothing, which makes
-- every score on the records page unreadable next to every other.
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
    match_key, room_code, square_set, board_size, lockout, win_condition, flip_count, seed,
    bonus_per_bingo, target_score,
    winner_team, started_at, finished_at, duration_seconds, total_claims, total_flips, final_face
  )
  values (
    v_key, rm.code, rm.square_set, rm.board_size, rm.lockout, rm.win_condition, rm.flip_count,
    rm.seed,
    -- Recorded as zero under `line`, where a bingo does not score at all - it ends the match. A
    -- stored 1 there would read as "lines were worth a point", which was never true.
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
