import { supabase } from "./supabase";

/** One finished match, as the archive stores it. */
export interface MatchResult {
  id: string;
  match_key: string;
  room_code: string;
  square_set: string | null;
  /** The upload itself, when `square_set` is CUSTOM_SQUARE_SET_ID. See StoredCustomSquareSet. */
  custom_square_set?: unknown | null;
  board_size: number;
  lockout: boolean;
  win_condition: string;
  flip_count: number;
  /** What a completed line was worth. 0 under the line condition, where bingos end the match. */
  bonus_per_bingo: number;
  /** The score that won it, under points. Null under the line condition. */
  target_score: number | null;
  seed: string | null;
  winner_team: number | null;
  started_at: string | null;
  finished_at: string;
  duration_seconds: number | null;
  total_claims: number;
  total_flips: number;
  final_face: number;
}

/** One player's part in one finished match. */
export interface MatchPlayer {
  id: string;
  match_id: string;
  user_id: string | null;
  nickname: string;
  team: number;
  squares: number;
  flips: number;
  won: boolean;
}

/**
 * Files a finished match, from whichever client happens to be looking at it.
 *
 * Called by every client on the finished screen rather than by a nominated one, because the client
 * guaranteed to be present is not knowable in advance - the host may have closed their tab the
 * moment they lost. `archive_match()` is idempotent on a key built from the room code and the start
 * instant, so the extra callers cost one indexed lookup each and write nothing.
 *
 * Best-effort by design. A match that fails to file is a missing row on a stats page; a recap screen
 * that throws over it is a player unable to see who won.
 */
export async function archiveMatch(roomId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("archive_match", { p_room_id: roomId });
  if (error) {
    console.warn("This match was not recorded.", error.message);
    return null;
  }
  return (data ?? null) as string | null;
}

/** A player's record across every match they have finished. */
export interface CareerRow {
  /** The durable identity. Null for matches played before anyone signed in - see `key`. */
  userId: string | null;
  /**
   * What to group on.
   *
   * The auth uuid where there is one, and the nickname otherwise. An anonymous player who never
   * signs in has a uuid that changes when they clear their cache, so grouping on it alone would
   * scatter them across rows; grouping a signed-in player on their name instead would merge two
   * people who picked the same one. Neither is perfect and the uuid is the better half, so it wins
   * wherever it exists.
   */
  key: string;
  name: string;
  matches: number;
  wins: number;
  squares: number;
  flips: number;
  /** Wins as a share of matches, 0-1. */
  winRate: number;
}

/**
 * Rolls the archive up per player, newest name winning.
 *
 * Aggregated in the browser rather than by a view, because the whole table is small - a busy season
 * is a few thousand rows - and a view would have to be migrated every time somebody wants a column
 * the page does not show yet.
 */
export function careerRows(players: readonly MatchPlayer[]): CareerRow[] {
  const byKey = new Map<string, CareerRow>();

  for (const p of players) {
    const key = p.user_id ?? `name:${p.nickname.toLowerCase()}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        userId: p.user_id,
        key,
        name: p.nickname,
        matches: 0,
        wins: 0,
        squares: 0,
        flips: 0,
        winRate: 0,
      };
      byKey.set(key, row);
    }
    row.matches++;
    if (p.won) row.wins++;
    row.squares += p.squares;
    row.flips += p.flips;
  }

  for (const row of byKey.values()) {
    row.winRate = row.matches > 0 ? row.wins / row.matches : 0;
  }

  return [...byKey.values()];
}

export type CareerSort = "wins" | "matches" | "squares" | "flips" | "winRate";

/**
 * Sorts a career table, with ties broken the same way every time.
 *
 * Win rate needs a floor or the table opens with somebody who played once and won once. Three is low
 * enough to include anyone who turned up to an event and high enough that the top of the table is a
 * record rather than an accident; below it, players sort under everyone who qualifies rather than
 * being hidden, because vanishing from a leaderboard you are on is worse than placing last on it.
 */
export const WIN_RATE_MINIMUM = 3;

export function sortCareer(rows: readonly CareerRow[], by: CareerSort): CareerRow[] {
  const value = (r: CareerRow) => {
    if (by !== "winRate") return r[by];
    return r.matches >= WIN_RATE_MINIMUM ? r.winRate : -1;
  };
  return [...rows].sort((a, b) => {
    const diff = value(b) - value(a);
    if (diff !== 0) return diff;
    // Matches, then name: a stable order so the table does not reshuffle between reads.
    if (b.matches !== a.matches) return b.matches - a.matches;
    return a.name.localeCompare(b.name);
  });
}

/** The archive, newest first. One read each; the tables are small enough to roll up client-side. */
export async function fetchArchive(limit = 500): Promise<{
  matches: MatchResult[];
  players: MatchPlayer[];
}> {
  const { data: matches, error: matchErr } = await supabase
    .from("match_results")
    .select()
    .order("finished_at", { ascending: false })
    .limit(limit);
  if (matchErr) throw matchErr;

  const ids = (matches ?? []).map((m) => m.id);
  if (ids.length === 0) return { matches: [], players: [] };

  const { data: players, error: playerErr } = await supabase
    .from("match_players")
    .select()
    .in("match_id", ids);
  if (playerErr) throw playerErr;

  return { matches: (matches ?? []) as MatchResult[], players: (players ?? []) as MatchPlayer[] };
}

/** Totals across everything archived, for the line above the table. */
export interface ArchiveTotals {
  matches: number;
  squares: number;
  flips: number;
  /** Matches where the board never turned, which is the interesting failure of a flip board. */
  neverFlipped: number;
  medianSeconds: number | null;
}

export function archiveTotals(matches: readonly MatchResult[]): ArchiveTotals {
  const durations = matches
    .map((m) => m.duration_seconds)
    .filter((d): d is number => typeof d === "number" && d > 0)
    .sort((a, b) => a - b);

  return {
    matches: matches.length,
    squares: matches.reduce((n, m) => n + m.total_claims, 0),
    flips: matches.reduce((n, m) => n + m.total_flips, 0),
    neverFlipped: matches.filter((m) => m.total_flips === 0).length,
    // Median rather than mean: one room left open over lunch drags an average into uselessness.
    medianSeconds: durations.length > 0 ? durations[Math.floor(durations.length / 2)] : null,
  };
}
