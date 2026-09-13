import type { Claim } from "../types/bingoFlip";

/**
 * What one square is showing. The board draws the state; this says which state it is.
 *
 * Far fewer states than Battleship needed, because there is no hidden information to reveal: a
 * square is free, or it belongs to somebody. What CHANGES about a claimed square is whose it is, and
 * that is a separate map - see `cellOwners` - because a colour per team does not fit in an enum.
 */
export type CellVisual = "empty" | "claimed" | "contested";

/**
 * Every square's state, resolved in ONE pass over the claim log instead of one pass per square.
 *
 * Battleship answered this per cell, with an `attacks.filter(a => a.cell_index === index)` inside
 * the function BoardGrid calls once per square - a hundred squares times a couple of hundred rows,
 * plus a hundred throwaway arrays, on every render. One walk of the log turns the per-square
 * question into a map lookup, and that reasoning survives the rework unchanged.
 *
 * "contested" is reachable only under non-lockout, where several teams can hold one square. The
 * board draws it as a split rather than picking a winner, which is why this is not simply a
 * cell -> team map.
 */
export function cellVisuals(claims: readonly Claim[]): Map<number, CellVisual> {
  const owners = cellOwners(claims);
  const out = new Map<number, CellVisual>();
  for (const [cell, teams] of owners) {
    out.set(cell, teams.length > 1 ? "contested" : "claimed");
  }
  return out;
}

/**
 * Cell index -> the teams holding it, ascending, in one pass.
 *
 * Ascending so a shared square splits the same way on every client and on every re-render - an
 * order that followed the claim log would make the two halves swap places when a board re-read the
 * log in a different order, which reads as a flicker rather than as information.
 */
export function cellOwners(claims: readonly Claim[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const claim of claims) {
    if (claim.cell_index < 0) continue;
    const teams = out.get(claim.cell_index);
    if (!teams) out.set(claim.cell_index, [claim.team]);
    else if (!teams.includes(claim.team)) teams.push(claim.team);
  }
  for (const teams of out.values()) teams.sort((a, b) => a - b);
  return out;
}
