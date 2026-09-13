-- Fixes a regression from 20260913040000_pause_match.sql, which restated claim_square in full to add
-- the paused_at guard and, in doing so, restated it off a copy of the function that predated both
-- 20260817040000_bingo_bonus_points.sql and 20260913000000_universal_majority.sql. Two things were
-- silently lost:
--
--   1. The `points` branch. The restated function checked `rm.win_condition = 'majority'` instead of
--      `= 'points'` - and 'majority' has not been a legal value since bingo_bonus_points.sql folded
--      it into 'points' and added the CHECK constraint that rules it out. So every room actually
--      playing 'points' has, since that migration, fallen straight into the `else` branch: a plain
--      completed line ends the match outright, target_score and bonus_per_bingo never consulted at
--      all. That is "set to Bingos score, match still ended on a single bingo."
--
--   2. The majority floor and the exhausted-board tie-break that universal_majority.sql added on top.
--      lib/flipLogic.ts's winnerAt() and lib/flipLogic.ts's exhaustion helper were never touched and
--      still assume both exist, so the client and the database have been deciding matches by two
--      different rules since pause_match.sql landed.
--
-- Restated again here, in full, as universal_majority.sql's body with pause_match.sql's guard
-- (`rm.paused_at is not null`) folded into the initial status check - nothing else changed.
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
  v_bonus    int;
  v_total    int;
  v_best     int;
  v_tied     int;
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

  -- --- did that reach a majority? ------------------------------------------
  -- Unconditional - see universal_majority.sql. Runs before the win_condition branch below so it
  -- takes precedence whenever a single claim satisfies both; that branch's own UPDATE is a no-op
  -- afterward, since every write here and below is guarded on status = 'battle'.
  select count(*) into v_held from claims where room_id = p_room_id and team = me.team;
  if v_held > v_cells / 2 then
    update rooms set status = 'finished', winner_team = me.team
     where id = p_room_id and status = 'battle';
  end if;

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
    -- old `majority` condition used to name.
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

  -- --- did the board run out? ---------------------------------------------
  -- Reached only on the claim that takes the last free square, and only under lockout. The count is
  -- one cheap indexed aggregate on every other claim, which is what keeps the tally below - the
  -- expensive part - off the hot path entirely.
  if rm.lockout then
    select count(*) into v_total from claims where room_id = p_room_id;

    if v_total >= v_cells then
      -- Bonus only where the room actually pays one. Under `line` a completed line would have ended
      -- the match already, so every team's line count here is zero and the bonus is moot - but
      -- reading bonus_per_bingo in a room that does not use it would still be wrong on its face.
      v_bonus := case when rm.win_condition = 'points' then coalesce(rm.bonus_per_bingo, 1) else 0 end;

      -- One pass for the whole board: squares per team, then each kind of line per team. The
      -- per-team shape is what the four `group by team, ...` clauses buy - the win branches above
      -- can ask about one team because they run on that team's own claim, and this cannot.
      with held as (
        select team, cell_index from claims where room_id = p_room_id
      ),
      sq as (select team, count(*)::int as squares from held group by team),
      rws as (select team, count(*)::int as n from (
                select team from held group by team, cell_index / v_size having count(*) = v_size
              ) t group by team),
      cls as (select team, count(*)::int as n from (
                select team from held group by team, cell_index % v_size having count(*) = v_size
              ) t group by team),
      dg1 as (select team, 1 as n from held
               where cell_index / v_size = cell_index % v_size
               group by team having count(*) = v_size),
      dg2 as (select team, 1 as n from held
               where (cell_index / v_size) + (cell_index % v_size) = v_size - 1
               group by team having count(*) = v_size),
      tally as (
        select sq.team,
               sq.squares
                 + (coalesce(rws.n, 0) + coalesce(cls.n, 0)
                    + coalesce(dg1.n, 0) + coalesce(dg2.n, 0)) * v_bonus as score
          from sq
          left join rws on rws.team = sq.team
          left join cls on cls.team = sq.team
          left join dg1 on dg1.team = sq.team
          left join dg2 on dg2.team = sq.team
      )
      -- The leader, and how many teams share that score. Both in one statement because a CTE does
      -- not outlive it, and `order by score desc, team` makes the pick deterministic even though the
      -- tie count is what actually decides whether it is used.
      select t.team, (select count(*) from tally t2 where t2.score = t.score)
        into v_best, v_tied
        from tally t
       order by t.score desc, t.team
       limit 1;

      -- Guarded on status so this cannot overwrite a win decided a few lines above: that update
      -- already moved the room to 'finished', and this one then matches nothing. A tie leaves
      -- winner_team null, which is exactly how the archive and the recap already read a draw.
      update rooms
         set status = 'finished',
             winner_team = case when v_tied = 1 then v_best else null end
       where id = p_room_id and status = 'battle';
    end if;
  end if;

  return me.team;
end;
$$;

grant execute on function public.claim_square(uuid, int) to anon, authenticated;
