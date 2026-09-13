import {
  squareSet,
  DEFAULT_SQUARE_SET,
  squareTitle,
  type Challenge,
  type SquareSetDef,
  type SquareSetId,
  type Region,
} from "./squareSets";
import {
  buildFlipBoard,
  buildFlatFlipBoard,
  distinctObjectives,
  type FlipFaces,
} from "./squareSetFormat";
import { rng, seedFrom } from "./seededRandom";
import { minObjectivesForFlip } from "../types/bingoFlip";

export type { Challenge, SquareSetId, Region, FlipFaces };
export { SQUARE_SETS, SQUARE_SET_LIST, DEFAULT_SQUARE_SET, squareSet } from "./squareSets";
export { rowSquareSet, busiestSquareSet } from "./squareSets";
export { REGION_ORDER, REGION_LABELS, colorKeyFor } from "./squareSets";
export type { SquareSetDef, ColorLegendEntry } from "./squareSets";
export {
  CUSTOM_SQUARE_SET_ID,
  MAX_CUSTOM_SQUARES,
  MAX_CUSTOM_UPLOAD_BYTES,
  validateCustomSquareSetPayload,
  readStoredCustomSquareSet,
  type StoredCustomSquareSet,
  type CustomSquareSetPayload,
} from "./squareSets";

/**
 * Both faces of a room's board, derived purely from the room id, its square set and its match seed.
 *
 * Deliberately not stored: every client seeds the same shuffle from the same public strings and
 * independently computes an identical pair of faces, so there is nothing to sync, nothing that can
 * drift between players, and no schema change needed to add or reorder squares. The claim log is the
 * only thing the database holds about a live match.
 *
 * The set id is seeded in alongside the room id, so switching sets in the lobby genuinely reshuffles
 * rather than dealing the same positions out of a different pack.
 *
 * Both faces come out of ONE set and share no square between them - see buildFlipBoard. A set must
 * therefore carry 2*count distinct objectives to deal a board at all - see canCarryFlipBoard.
 */
export function facesForRoom(
  roomId: string,
  count: number,
  setId: SquareSetId | null | undefined = DEFAULT_SQUARE_SET,
  /**
   * The room's current randomizer seed, rerolled every time the room returns to the lobby.
   *
   * Without it the board would be a pure function of the room id, so a second match in the same room
   * dealt the same squares in the same places and the rematch was the same board.
   */
  seed?: string | null,
  /** `room.custom_square_set`, as stored. Only read when `setId` is CUSTOM_SQUARE_SET_ID. */
  customSet?: unknown
): FlipFaces {
  const set = squareSet(setId, customSet);
  const base = `${roomId}:${set.id}`;
  const next = rng(seedFrom(seed ? `${base}:${seed}` : base));

  const faces =
    set.format === "bingo"
      ? buildFlipBoard(set.data, count, next, set.shortNames, set.regions, set.colors)
      : buildFlatFlipBoard(set.data, count, next);

  // Hover text is settled here rather than at the board, because how a square reads on hover depends
  // on which set it came from and this is the last point that knows. See squareTitle.
  const title = (cells: Challenge[]) => cells.map((c) => ({ ...c, title: squareTitle(c, set) }));
  return { light: title(faces.light), dark: title(faces.dark) };
}

/**
 * How many genuinely different objectives a set has to deal, whichever shape it is written in.
 *
 * Distinct OBJECTIVES rather than distinct squares, because that is what actually limits a flip
 * board: these sets write some errands twice, once tagged combined and once not, and the two faces
 * may not repeat one between them. See distinctObjectives.
 */
export function poolSize(set: SquareSetDef): number {
  const names = set.format === "bingo" ? set.data.squares.map((s) => s.name) : set.data.map((c) => c.name);
  return distinctObjectives(names);
}

/**
 * Whether this set can deal a flip board of this size without repeating an objective across the
 * two faces.
 *
 * Both faces come out of one set and share no objective, so a board needs 2*size*size distinct
 * trips. Every set clears that comfortably at 5x5; this is what lets MatchSettings warn instead when
 * the host picks a bigger board than their squareset was written for, because a set that comes up
 * short fails SILENTLY otherwise - buildBingoBoard cycles, and the board repeats itself across the
 * two faces, which is precisely what the flip cannot survive.
 *
 * Computed from the file rather than tabulated, so revising a squareset moves the answer with it.
 */
export function canCarryFlipBoard(
  setId: SquareSetId | null | undefined,
  boardSize: number,
  customSet?: unknown
): boolean {
  return poolSize(squareSet(setId, customSet)) >= minObjectivesForFlip(boardSize);
}
