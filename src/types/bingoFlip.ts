/**
 * Bingo Flip's domain model.
 *
 * The shape of a match, in one sentence: two or more teams race to claim squares on one shared
 * lockout board, and a handful of those squares flip the board onto a second set of objectives when
 * claimed. Ownership is not part of what flips - see FLIP RULE below, which is the decision the rest
 * of this file follows from.
 */
import type { Challenge } from "../lib/squareSetFormat";

/**
 * FLIP RULE. A flip rewrites the objectives on the UNCLAIMED squares and nothing else.
 *
 * There is one ownership grid for the whole match, and it survives every flip. Lines and the square
 * count are read off that single grid, so a flip never gives anything back: it changes what your
 * opponent's remaining work is, not what they have already done.
 *
 * The alternative - a separate ownership grid per face - was considered and rejected. It makes each
 * face its own lockout game, which means a team can sit one square from victory on a face the
 * opponent will simply never flip back to, and the match stops being a race.
 */
export type BoardFace = 0 | 1;

export const LIGHT: BoardFace = 0;
export const DARK: BoardFace = 1;

/** What a face is called on screen. Index by BoardFace. */
export const FACE_LABELS: readonly [string, string] = ["Light", "Dark"];

export type RoomStatus = "lobby" | "prep" | "battle" | "finished";

/**
 * How a match is won - which is really one question: do bingos WIN, or do they SCORE?
 *
 * `line` is bingo proper: the first full row, column or diagonal takes the match. `points` is the
 * format plenty of events actually run, where a completed line is worth a few extra points rather
 * than ending anything, and the first team to the target score wins.
 *
 * Both read the single ownership grid, so both are flip-agnostic by construction.
 */
export type WinCondition = "line" | "points";

/**
 * Whether a square belongs to whoever takes it first.
 *
 * Lockout is the default and the mode the flip was designed around: squares are finite, so a flip
 * that hardens your opponent's remaining work actually costs them something. EldenBingo defaults the
 * same way (GS_Lockout), and this is the mode tournaments run.
 *
 * Non-lockout makes the teams race in parallel instead of denying each other - everyone may claim
 * everything, and the winner is whoever completes the condition first. The flip means something
 * different there and is worth knowing before choosing it: since nobody can be denied a square, a
 * flip does not take work away from an opponent, it changes what is on offer for everyone at once.
 * Only the FIRST completion of a flip square turns the board, or four teams working the same three
 * flip squares would turn it a dozen times.
 */
export const LOCKOUT_MODES = {
  lockout: {
    label: "Lockout",
    blurb: "A square belongs to whoever finishes it first. Nobody else can have it.",
  },
  open: {
    label: "Non-lockout",
    blurb: "Every team can claim every square. First to the win condition takes it.",
  },
} as const;

export const DEFAULT_LOCKOUT = true;

/**
 * Whether this match is archived when it finishes.
 *
 * A room setting rather than a per-match choice made once, for the same reason board size and win
 * condition are: a crew warming up before a real set shouldn't have to remember to flip it back
 * before the match that counts, and a rematch in the same room keeps whatever the last one had.
 *
 * Practice skips archive_match() entirely - not "archives it, then hides it" - so a practice match
 * leaves no row in match_results at all. There is no separate mechanism for scrubbing a mislabeled
 * match after the fact; getting the setting right before the match ends is the only lever.
 */
export const PRACTICE_MODES = {
  counted: {
    label: "Counts",
    blurb: "Archived when it finishes - shows up in the Almanac and everyone's career stats.",
  },
  practice: {
    label: "Practice",
    blurb: "Never archived. Play it exactly like a real match without it touching anyone's record.",
  },
} as const;

export const DEFAULT_PRACTICE = false;

/**
 * Do bingos WIN, or do they SCORE? That is the whole question, and the two answers are the formats.
 *
 * A third condition, `majority`, used to sit beside these and is gone - folded into points, because
 * it was exactly points with a bonus of zero and the default target. Two names for one rule is a
 * difference people have to be told about. Setting the bonus to 0 gets it back.
 */
export const WIN_CONDITIONS: Record<WinCondition, { label: string; blurb: string }> = {
  line: {
    label: "Bingos win",
    blurb: "The first full row, column or diagonal takes the match.",
  },
  points: {
    label: "Bingos score",
    blurb: "A square is a point and a bingo is worth more. First to the target wins.",
  },
};
export const DEFAULT_WIN_CONDITION: WinCondition = "line";

/**
 * What a completed line is worth under `points`.
 *
 * Zero, one or two. The ceiling is low on purpose: a bingo is five squares of work, so paying much
 * more than a couple of points for it makes chasing lines strictly better than taking squares and
 * the board stops being a board. Zero is a real choice rather than an off switch - it is the format
 * where lines are decoration and only the square count matters, which is what `majority` used to be.
 */
export const BONUS_PER_BINGO = [0, 1, 2] as const;

export const DEFAULT_BONUS_PER_BINGO = 1;

/**
 * The score that wins a points match, when the host has not set one.
 *
 * More than half the squares, which is the threshold `majority` used - so a points room left alone,
 * with the bonus at 0, plays exactly the rule that condition named. Cannot tie on an odd board.
 */
export function defaultTargetScore(boardSize: number): number {
  return Math.floor((boardSize * boardSize) / 2) + 1;
}

/**
 * The targets a host can pick from, for this board.
 *
 * Centred on the default and stopping short of the square count: a target at or above the number of
 * squares can only be reached with bonus points, so on a board whose bonus is 0 it would be a match
 * nobody can win. The bottom of the range is a quarter of the board, below which the first team to
 * find their feet takes it before anybody else has read the card.
 */
export function targetScoreChoices(boardSize: number): number[] {
  const cells = boardSize * boardSize;
  const low = Math.max(3, Math.round(cells * 0.25));
  const high = cells - 1;
  const step = Math.max(1, Math.round((high - low) / 8));
  const out: number[] = [];
  for (let n = low; n <= high; n += step) out.push(n);
  const fallback = defaultTargetScore(boardSize);
  if (!out.includes(fallback)) out.push(fallback);
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * What a new room starts on, before the host changes it. Not the only size any more - see
 * BOARD_SIZE_CHOICES.
 *
 * Flip was locked to 5x5 for a stretch: every square has to be readable at a glance on BOTH faces,
 * because the whole tactical question is what the unclaimed ones will become, and a set needs
 * 2*size*size distinct objectives to deal a board at all, which put the larger sizes out of reach of
 * three of the four sets. Both concerns are real - see MatchSettings' capacity warning, which is
 * where the second one now lives - but they are for the host weighing a size, not a rule the app
 * enforces. 5x5 stays the default because it is what those tradeoffs land on for most sets.
 */
export const DEFAULT_BOARD_SIZE = 5;

/**
 * The sizes a host can pick in the lobby.
 *
 * 2 through 20. The floor is where a "line" stops being one square with extra steps; nothing below
 * it is a different game so much as no game. The ceiling is not a technical limit - linesFor(), the
 * dealer and the overlays are all written against a board size and stay general however large it
 * gets - it is where a dropdown stops being faster to scan than to type into.
 */
export const BOARD_SIZE_CHOICES = Array.from({ length: 19 }, (_, i) => i + 2);

/**
 * What a set must carry to deal a flip board of this size at all: one face's worth twice over,
 * sharing nothing.
 *
 * A function of the size rather than a constant now that the size varies - MatchSettings computes
 * this per room to warn when the host's squareset is thin for the board they just picked, rather
 * than the fixed board this used to gate. A set that comes up short does not fail loudly on its
 * own: buildBingoBoard cycles, and the board quietly repeats itself across the two faces, which is
 * the one thing the flip cannot do - hence the warning existing at all.
 */
export function minObjectivesForFlip(size: number): number {
  return size * size * 2;
}

/**
 * How many squares flip the board.
 *
 * Three to five, as Uno Flip has a fixed few Flip cards in the deck rather than a rate. They are
 * CONSUMED: claiming one flips the board and then leaves an ordinary owned square behind, so a match
 * can flip at most FLIP_COUNT times and cannot ping-pong indefinitely. That is why there is no flip
 * cooldown anywhere in this model - the supply of flips is the limit, and a cooldown on top would
 * only add a rule players have to be told about.
 */
export const FLIP_COUNTS = [3, 4, 5] as const;

export const DEFAULT_FLIP_COUNT = 3;

export interface Room {
  id: string;
  code: string;
  board_size: number;
  status: RoomStatus;
  winner_team: number | null;
  created_at: string;
  /** Countdown lengths, configurable per room. */
  starting_seconds?: number;
  prep_seconds?: number;
  /** Sparse per-team name overrides. A null/blank entry keeps that team's colour name. */
  team_names?: (string | null)[] | null;
  /** 9-digit seed every player feeds to the Elden Ring randomizer so they get matching runs. */
  seed?: string | null;
  /** Which pool BOTH faces are dealt from - see lib/squareSets. Null means the default. */
  square_set?: string | null;
  /**
   * The host's own upload, when `square_set` is CUSTOM_SQUARE_SET_ID - see readStoredCustomSquareSet,
   * which is what actually knows how to read this rather than trusting its shape. Untyped here
   * because it is opaque JSON from the moment it leaves the browser to the moment it's validated
   * again on the way back in.
   */
  custom_square_set?: unknown | null;
  /** How many of the squares flip the board. Null on rooms predating the column; read as the default. */
  flip_count?: number | null;
  win_condition?: WinCondition | null;
  /** What a completed line is worth under `points`. Null reads as the default. */
  bonus_per_bingo?: number | null;
  /** The score that wins a points match. Null reads as defaultTargetScore(board_size). */
  target_score?: number | null;
  /** True when a square belongs to whoever takes it first. See LOCKOUT_MODES. */
  lockout?: boolean | null;
  /** True when this match is never archived, win or not. See PRACTICE_MODES. */
  practice?: boolean | null;
  /**
   * Which cells flip the board. Written once by the host at match start and frozen thereafter.
   *
   * The one part of the board that is stored rather than derived, because the database has to know
   * whether a claim turns the board over. No secret: flip squares are marked on the board by design.
   */
  flip_cells?: number[] | null;
  /** When the match clock started. Null in the lobby. Every client's clock reads this one instant. */
  started_at?: string | null;
  /**
   * When the match was actually paused. Null while running.
   *
   * Every phase is computed from `started_at` and the current instant (see matchTime.ts), so
   * pausing needs no separate "paused elapsed" bookkeeping: resuming just slides `started_at`
   * forward by however long this was set, and every client's clock is correct again for free.
   */
  paused_at?: string | null;
  /** Teams currently asking for the match to pause (or, while paused, still asking to stay that way). */
  pause_votes?: number[] | null;
}

export interface Player {
  id: string;
  room_id: string;
  user_id: string;
  nickname: string;
  team: number | null;
  is_host: boolean;
  joined_at: string;
  /** Bearer token for reclaiming this slot on another device. */
  rejoin_code?: string | null;
  /** When this player picked their current team. Earliest on a team is its captain. */
  team_joined_at?: string | null;
}

export interface TeamReady {
  room_id: string;
  team: number;
  ready: boolean;
}

/**
 * One square claimed by one team. The entire mutable state of a match.
 *
 * At most one row per (room_id, cell_index, team) - a team cannot take a square twice, in either
 * mode. Under lockout there is additionally at most one row per (room_id, cell_index), which
 * claim_square() enforces under the room lock rather than an index, since the mode is per-room.
 *
 * `face` records which face was showing when the claim landed, which is what makes the match log
 * readable after the fact ("they took Radahn, then it flipped") and what lets a replay redraw the
 * board as it stood. It is not read by win detection - see the FLIP RULE.
 */
export interface Claim {
  id: string;
  room_id: string;
  cell_index: number;
  team: number;
  player_id: string | null;
  face: BoardFace;
  /**
   * True when this claim TURNED THE BOARD - not merely that the cell is a flip square.
   *
   * The distinction only bites under non-lockout, where a second team completing the same flip
   * objective must not turn the board again. Recording the event rather than the property is what
   * lets faceFromClaims stay a plain parity over the log in both modes.
   */
  flipped: boolean;
  created_at: string;
}

/** A cell as the board draws it: its objective on each face, and whether it flips. */
export interface FlipCell {
  faces: readonly [Challenge, Challenge];
  isFlip: boolean;
}
