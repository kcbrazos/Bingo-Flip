import { useMemo, useRef } from "react";
import { activeTeams } from "../lib/teams";
import { matchStartedAt } from "../lib/matchTime";
import { DEFAULT_LOCKOUT, DEFAULT_WIN_CONDITION, type Claim, type Player, type Room } from "../types/bingoFlip";
import { flipOdds, oddsTimeline, type OddsPoint, type OddsSnapshot } from "../lib/flipOdds";

export interface FlipOddsRead {
  snapshot: OddsSnapshot | null;
  timeline: OddsPoint[];
}

const EMPTY: FlipOddsRead = { snapshot: null, timeline: [] };

/**
 * Each team's chance of winning, recomputed only when a claim actually lands.
 *
 * `claims` is a fresh array on every realtime message the room receives - a player joining, a team
 * being renamed. The model behind this is a Monte Carlo simulation of ten thousand matches, not an
 * arithmetic expression, so memoising on the array's identity would re-roll all ten thousand every
 * time anything in the room twitched. Keyed on the CLAIM COUNT instead, it runs once per claim -
 * see the `key` below for exactly what else can move the number.
 *
 * @param withTimeline whether to replay the whole match for the history line - costs one simulation
 * per sampled point, so a surface that only prints the current number should say no.
 * @param enabled whether to run the model at all. A hook can't be called conditionally, so a
 * surface the number can be switched off on (an odds panel a caster has collapsed) says so here
 * instead, and the cost of being off is zero.
 */
export function useFlipOdds(
  claims: Claim[],
  room: Room | null | undefined,
  players: Player[],
  withTimeline = false,
  enabled = true
): FlipOddsRead {
  const teams = activeTeams(players);
  const crews = teams.map((t) => players.reduce((n, p) => (p.team === t ? n + 1 : n), 0)).join(",");

  const key = [
    room?.id ?? "",
    room?.board_size ?? 0,
    room?.lockout ?? DEFAULT_LOCKOUT ? 1 : 0,
    room?.win_condition ?? DEFAULT_WIN_CONDITION,
    room?.bonus_per_bingo ?? "",
    room?.target_score ?? "",
    claims.length,
    teams.join(","),
    crews,
    withTimeline ? 1 : 0,
    enabled ? 1 : 0,
  ].join("|");

  // Read inside the memo, never compared by it - see the note above.
  const latest = useRef({ claims, room, players, teams });
  latest.current = { claims, room, players, teams };

  return useMemo(() => {
    const { claims: log, room: current, players: roster, teams: activeTeamsNow } = latest.current;
    if (!enabled) return EMPTY;
    if (!current || activeTeamsNow.length < 2) return EMPTY;

    const lockout = current.lockout ?? DEFAULT_LOCKOUT;
    const condition = current.win_condition ?? DEFAULT_WIN_CONDITION;

    const snapshot = flipOdds(
      log,
      activeTeamsNow,
      roster,
      current.board_size,
      lockout,
      condition,
      current.bonus_per_bingo,
      current.target_score
    );

    const timeline = withTimeline
      ? oddsTimeline(
          log,
          activeTeamsNow,
          roster,
          current.board_size,
          lockout,
          condition,
          current.bonus_per_bingo,
          current.target_score,
          matchStartedAt(current, log)
        )
      : [];

    return { snapshot, timeline };
    // `key` IS the dependency - see the note above on why the inputs are read through a ref instead.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, withTimeline, enabled]);
}
