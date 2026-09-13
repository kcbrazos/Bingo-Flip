import type { RoomStatus } from "../types/bingoFlip";

/**
 * Whether a square's writing may be drawn yet.
 *
 * Nearly everything this rule used to be for is gone. Battleship kept its boards BLANK until the
 * shooting started, because a captain had to lay a fleet out on unlabelled water and commit before
 * learning which square was which - that was the whole shape of the placement decision - and the
 * overlay routes were handing it back by drawing the names from the moment a URL was pasted in.
 * There was a second reason too: the board was still being permuted against the fleets during the
 * clock's first window, so naming the squares across it meant showing a board mid-shuffle.
 *
 * Neither applies now. There is no placement, nothing is dealt against anybody's position, and the
 * preparation window exists SO THAT teams can read the board - both faces of it - before the race
 * opens. A rule that hid the board through preparation would be hiding it during the one phase
 * built for looking at it.
 *
 * So this holds only through the lobby, where there is no match to show, and opens from prep
 * onwards. It stays a function rather than becoming an inline status check because the overlay
 * routes, the caster's desk and the players' own key all have to agree about it, and one of them
 * quietly disagreeing is exactly the bug this was written to stop.
 *
 * The `phase` argument is kept and ignored. Callers pass the clock phase; nothing about the flip
 * board depends on it, and removing the parameter would mean touching every call site to delete an
 * argument that costs nothing.
 */
export function squaresRevealed(status: RoomStatus | undefined, _phase?: unknown): boolean {
  return status === "prep" || status === "battle" || status === "finished";
}
