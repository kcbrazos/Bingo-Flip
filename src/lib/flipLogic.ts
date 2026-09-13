/**
 * The rules of a flip match: where the flip squares sit, which face is showing, and who has won.
 *
 * Every function here is pure and derives from things every client already has - the room id, the
 * match seed, the claim log - so no client has to be told any of it and none of them can disagree.
 * That is the same property the board itself has (see challenges.ts) and it is worth keeping: the
 * only thing the database holds about a match in progress is who claimed which square.
 */
import type { BoardFace, Claim, WinCondition } from "../types/bingoFlip";

/**
 * The scoring fallbacks, restated here rather than imported.
 *
 * Same reason as the PRNG below: this module has no runtime imports, because scripts/check-flip.ts
 * runs these rules under bare Node and types/bingoFlip.ts is reached by an extensionless path the
 * bundler resolves and Node does not. A type-only import is erased and costs nothing; a VALUE import
 * would break the checks that exist to keep this file honest.
 *
 * Kept identical to DEFAULT_BONUS_PER_BINGO and defaultTargetScore in types/bingoFlip.ts, which is
 * where the UI reads them from - and to claim_square()'s points branch, which is the one that
 * actually decides a match. If one changes, all three must.
 */
const DEFAULT_BONUS_PER_BINGO = 1;

function defaultTargetScore(boardSize: number): number {
  return Math.floor((boardSize * boardSize) / 2) + 1;
}

/**
 * Standalone copies of the app's PRNG, so this module imports nothing at runtime.
 *
 * The same property squareSetFormat.ts keeps, and for the same reason: scripts/check-flip.ts runs
 * these rules under bare Node, which cannot resolve the extensionless imports the bundler is happy
 * with. Kept identical to lib/seededRandom.ts - if one ever changes, both must.
 */
function seedFrom(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Which cells flip the board, for this room and this match.
 *
 * Derived, not stored, for the reason above - and seeded off the match seed as well as the room id,
 * so a rematch in the same room moves them. Without the seed a room's flip squares would sit in the
 * same three places every match, which anybody playing a set of matches would learn by the third.
 *
 * Spread deliberately rather than dropped at random. Two flip squares side by side are effectively
 * one - claim either and the board turns - and three in a corner make a whole quadrant the only part
 * of the board worth contesting. So the pick prefers cells no closer than SPREAD to one already
 * taken, and only relaxes that when the board is too small or too crowded to honour it.
 */
export function flipCellsFor(
  roomId: string,
  boardSize: number,
  flipCount: number,
  seed?: string | null
): number[] {
  const cells = boardSize * boardSize;
  const wanted = Math.max(0, Math.min(flipCount, cells));
  const next = rng(seedFrom(seed ? `${roomId}:flip:${seed}` : `${roomId}:flip`));

  // Chebyshev distance, so "no closer than 2" means no shared edge and no shared corner.
  const SPREAD = 2;
  const far = (a: number, b: number): boolean => {
    const dr = Math.abs(Math.floor(a / boardSize) - Math.floor(b / boardSize));
    const dc = Math.abs((a % boardSize) - (b % boardSize));
    return Math.max(dr, dc) >= SPREAD;
  };

  const order: number[] = [];
  for (let i = 0; i < cells; i++) order.push(i);
  // Fisher-Yates on the cell list, so the candidate order is a property of the seed alone.
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const picked: number[] = [];
  for (const cell of order) {
    if (picked.length >= wanted) break;
    if (picked.every((p) => far(p, cell))) picked.push(cell);
  }
  // A 5x5 asked for five well-spread cells can genuinely run out. Fill the shortfall with whatever
  // is left, in the same seeded order, rather than returning fewer flip squares than the host chose.
  for (const cell of order) {
    if (picked.length >= wanted) break;
    if (!picked.includes(cell)) picked.push(cell);
  }
  return picked.sort((a, b) => a - b);
}

/**
 * Which face is showing, given the claims so far.
 *
 * Every claim on a flip square turns the board once, and flip squares are consumed - a claimed one
 * is an ordinary owned square - so the face is simply the parity of the flip claims. Derived from
 * the log rather than stored as a column, which means the face can never drift out of step with the
 * claims that caused it, and a replay gets the face at any point by counting a prefix.
 */
export function faceFromClaims(claims: readonly Claim[]): BoardFace {
  let flips = 0;
  for (const claim of claims) if (claim.flipped) flips++;
  return (flips % 2) as BoardFace;
}

/**
 * Every winning line on a board of this size: each row, each column, both diagonals.
 *
 * Cached because a board's lines never change and win detection runs on every claim, for every
 * client, for every team.
 */
const LINE_CACHE = new Map<number, number[][]>();

export function linesFor(boardSize: number): number[][] {
  const hit = LINE_CACHE.get(boardSize);
  if (hit) return hit;

  const lines: number[][] = [];
  for (let r = 0; r < boardSize; r++) {
    const row: number[] = [];
    for (let c = 0; c < boardSize; c++) row.push(r * boardSize + c);
    lines.push(row);
  }
  for (let c = 0; c < boardSize; c++) {
    const col: number[] = [];
    for (let r = 0; r < boardSize; r++) col.push(r * boardSize + c);
    lines.push(col);
  }
  const down: number[] = [];
  const up: number[] = [];
  for (let i = 0; i < boardSize; i++) {
    down.push(i * boardSize + i);
    up.push(i * boardSize + (boardSize - 1 - i));
  }
  lines.push(down, up);

  LINE_CACHE.set(boardSize, lines);
  return lines;
}

/**
 * A cell's coordinate, as the log and the caster's desk name it: A1 through to the far corner.
 *
 * Columns are lettered and rows numbered, which is the convention the bingo scene already reads and
 * the one Battleship used before it. Carried over from battleshipLogic, which is otherwise gone.
 */
export function cellLabel(cellIndex: number, boardSize: number): string {
  const row = Math.floor(cellIndex / boardSize) + 1;
  const col = String.fromCharCode(65 + (cellIndex % boardSize));
  return `${col}${row}`;
}

/**
 * The cells each team holds, keyed by team. The one grid the FLIP RULE says survives a flip.
 *
 * The general form, and the one every rule below is written against, because it is the only shape
 * that describes both modes. Under non-lockout a cell can be held by several teams at once, so
 * "who owns this cell" is a question with no answer and anything phrased that way silently picks a
 * winner. Asking instead "which cells does THIS team hold" has the same answer in both modes.
 */
export function cellsByTeam(claims: readonly Claim[]): Map<number, Set<number>> {
  const held = new Map<number, Set<number>>();
  for (const claim of claims) {
    let mine = held.get(claim.team);
    if (!mine) {
      mine = new Set<number>();
      held.set(claim.team, mine);
    }
    mine.add(claim.cell_index);
  }
  return held;
}

/**
 * Cell index -> owning team, for LOCKOUT ROOMS ONLY.
 *
 * Kept because a lockout board draws one colour per square and this is the natural shape for it.
 * Under non-lockout it is not merely imprecise but wrong - it would report the last claimer as the
 * owner and hide every other team's hold on that square - so callers must branch on the mode and use
 * cellsByTeam() when it is off. Nothing in the rules below uses this.
 */
export function ownershipFrom(claims: readonly Claim[], boardSize: number): (number | null)[] {
  const owner: (number | null)[] = new Array(boardSize * boardSize).fill(null);
  for (const claim of claims) {
    if (claim.cell_index >= 0 && claim.cell_index < owner.length) owner[claim.cell_index] = claim.team;
  }
  return owner;
}

/**
 * How many squares each team holds, keyed by team number.
 *
 * Correct in both modes without a branch: a team can claim a square at most once (the unique index
 * on (room_id, cell_index, team) says so), and under non-lockout another team's claim on the same
 * square is simply another team's row.
 */
export function squareCounts(claims: readonly Claim[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const [team, cells] of cellsByTeam(claims)) counts.set(team, cells.size);
  return counts;
}

/** The cells making up a team's completed lines, for highlighting. Empty when it has none. */
export function completedLines(
  claims: readonly Claim[],
  boardSize: number,
  team: number
): number[][] {
  const mine = cellsByTeam(claims).get(team);
  if (!mine) return [];
  return linesFor(boardSize).filter((line) => line.every((cell) => mine.has(cell)));
}

/** Why a match ended: a completed line, a points target reached, or a majority of the board held. */
export type WinReason = "line" | "points" | "majority";

/**
 * The claim that won the match, who won it, and why - or null while it is still live.
 *
 * Scans the log forward and stops at the first claim that satisfies a condition, rather than asking
 * who satisfies it now. Under lockout the two agree. Under non-lockout they do not: nobody denies
 * anybody a square, so several teams can eventually complete a line, and "who has one" would report
 * whichever team the iteration order reached first. Who got there FIRST is the actual rule, and only
 * the ordered log knows it.
 *
 * Majority is checked ahead of `condition` and regardless of it: strictly more than half the board
 * wins outright, bingo line or not - a rule that used to be its own `WinCondition` (see
 * defaultTargetScore's history in types/bingoFlip.ts) and is now a floor under both formats instead
 * of a third mode to pick. It shares that function's threshold, so a `points` room left at the
 * default target already agrees with it exactly; a custom target only matters when it is lower.
 *
 * Reads the cells held alone, never the face - a flip changes what the empty squares ask for and
 * nothing about who has won.
 */
export function winnerAt(
  claims: readonly Claim[],
  boardSize: number,
  condition: WinCondition,
  /** Only read under `points`. Defaults match the database's, so the two cannot disagree. */
  scoring?: { bonusPerBingo?: number | null; targetScore?: number | null }
): { team: number; claim: Claim; reason: WinReason } | null {
  const lines = linesFor(boardSize);
  const held = new Map<number, Set<number>>();

  const bonus = scoring?.bonusPerBingo ?? DEFAULT_BONUS_PER_BINGO;
  const target = scoring?.targetScore ?? defaultTargetScore(boardSize);
  const majority = defaultTargetScore(boardSize);

  for (const claim of claims) {
    let mine = held.get(claim.team);
    if (!mine) {
      mine = new Set<number>();
      held.set(claim.team, mine);
    }
    if (mine.has(claim.cell_index)) continue;
    mine.add(claim.cell_index);

    if (mine.size >= majority) return { team: claim.team, claim, reason: "majority" };

    if (condition === "points") {
      // The whole board every time, not just lines through this cell: the bonus is part of a running
      // total rather than a finish line, so a line completed three claims ago still counts now.
      const completed = lines.filter((line) => line.every((cell) => mine.has(cell))).length;
      if (mine.size + completed * bonus >= target) return { team: claim.team, claim, reason: "points" };
      continue;
    }

    // Only lines through the cell just claimed can have been completed by it.
    for (const line of lines) {
      if (!line.includes(claim.cell_index)) continue;
      if (line.every((cell) => mine.has(cell))) return { team: claim.team, claim, reason: "line" };
    }
  }
  return null;
}

/**
 * A team's score: a point a square, plus the bonus for every completed line.
 *
 * Must agree with claim_square()'s points branch exactly. The database decides the match; this is
 * what the board and the roster draw while it is running, and a scoreboard that disagrees with the
 * result is worse than no scoreboard.
 */
export function scoreFor(
  claims: readonly Claim[],
  boardSize: number,
  team: number,
  bonusPerBingo: number | null | undefined
): { squares: number; lines: number; score: number } {
  const mine = cellsByTeam(claims).get(team);
  const squares = mine?.size ?? 0;
  const lines = mine ? linesFor(boardSize).filter((l) => l.every((c) => mine.has(c))).length : 0;
  const bonus = bonusPerBingo ?? DEFAULT_BONUS_PER_BINGO;
  return { squares, lines, score: squares + lines * bonus };
}

/**
 * How a lockout board that ran out was decided: on the score, with a tie at the top a real draw.
 *
 * Must agree with claim_square()'s exhaustion branch exactly - it is the fourth place the scoring
 * lives, and the only one a player reads off the recap. It leans on scoreFor() rather than
 * restating the arithmetic, which is what keeps that true.
 *
 * `full` is the question the caller usually wants answered first, and it is deliberately part of
 * the result rather than a second function: "there is no winner" and "there is no winner YET" are
 * different sentences, and only the board being full tells them apart.
 */
export function exhaustion(
  claims: readonly Claim[],
  boardSize: number,
  lockout: boolean,
  condition: WinCondition,
  bonusPerBingo?: number | null
): { full: boolean; team: number | null; drawn: boolean } {
  const cells = boardSize * boardSize;
  // Under non-lockout "full" would mean every team holding all 25, by which point any reachable
  // condition has long since been met - so the question is only ever asked of a lockout board.
  const taken = new Set<number>();
  for (const claim of claims) taken.add(claim.cell_index);
  if (!lockout || taken.size < cells) return { full: false, team: null, drawn: false };

  // No bonus under `line`: a completed line would have ended the match already, so every count here
  // is zero - and reading the setting in a room that does not pay one would be wrong on its face.
  const bonus = condition === "points" ? (bonusPerBingo ?? DEFAULT_BONUS_PER_BINGO) : 0;

  let best = -1;
  let team: number | null = null;
  let tied = 0;
  for (const t of cellsByTeam(claims).keys()) {
    const { score } = scoreFor(claims, boardSize, t, bonus);
    if (score > best) {
      best = score;
      team = t;
      tied = 1;
    } else if (score === best) {
      tied++;
    }
  }

  return tied === 1 ? { full: true, team, drawn: false } : { full: true, team: null, drawn: true };
}

/** The winning team, or null while the match is still live. */
export function winnerFrom(
  claims: readonly Claim[],
  boardSize: number,
  condition: WinCondition,
  scoring?: { bonusPerBingo?: number | null; targetScore?: number | null }
): number | null {
  return winnerAt(claims, boardSize, condition, scoring)?.team ?? null;
}

/** The claim that won it, so a finished match can report the square that decided it. */
export function winningClaim(
  claims: readonly Claim[],
  boardSize: number,
  condition: WinCondition,
  scoring?: { bonusPerBingo?: number | null; targetScore?: number | null }
): Claim | null {
  return winnerAt(claims, boardSize, condition, scoring)?.claim ?? null;
}

/** Why the match ended, so the recap can say "closed the bingo" versus "took the majority". */
export function winningReason(
  claims: readonly Claim[],
  boardSize: number,
  condition: WinCondition,
  scoring?: { bonusPerBingo?: number | null; targetScore?: number | null }
): WinReason | null {
  return winnerAt(claims, boardSize, condition, scoring)?.reason ?? null;
}
