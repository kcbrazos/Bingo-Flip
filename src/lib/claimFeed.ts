import { teamName } from "./teamColors";
import type { Challenge } from "./squareSets";
import type { Claim, Player } from "../types/bingoFlip";

/**
 * One line of the match log.
 *
 * Much simpler than Battleship's, and for a structural reason rather than a cosmetic one: a shot
 * there wrote one `attacks` row per opposing team, so the feed's first job was grouping rows back
 * into the single action a player had actually taken. A claim is one row for one action, so there is
 * nothing to reassemble.
 */
export interface FeedEntry {
  key: string;
  at: string;
  team: number;
  /** The player who took it, or the team's name where the claim was not attributed. */
  who: string;
  cellIndex: number;
  /** The objective as it read on the face that was showing when this landed. */
  objective: string;
  /** True when this claim turned the board over. */
  flipped: boolean;
  /** Which face was showing at the time. */
  face: number;
}

/**
 * The claim log as the feed prints it, newest first.
 *
 * Each entry names the objective from the face the claim was made on, not from the face currently
 * showing - a log that re-labelled its own history every time the board turned would be unreadable,
 * and "they took Radahn, then it flipped" is the whole reason the face is recorded per claim.
 */
export function feedEntries(
  claims: readonly Claim[],
  players: readonly Player[],
  faces: readonly [Challenge[], Challenge[]]
): FeedEntry[] {
  return claims
    .map((claim) => {
      const player = players.find((p) => p.id === claim.player_id);
      const cells = faces[claim.face] ?? faces[0];
      return {
        key: claim.id,
        at: claim.created_at,
        team: claim.team,
        who: player?.nickname ?? teamName(claim.team),
        cellIndex: claim.cell_index,
        objective: cells[claim.cell_index]?.short ?? cells[claim.cell_index]?.name ?? "",
        flipped: claim.flipped,
        face: claim.face,
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** Squares each team holds, for the roster. Derived from the public claim log. */
export function heldCountByTeam(claims: readonly Claim[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const claim of claims) counts.set(claim.team, (counts.get(claim.team) ?? 0) + 1);
  return counts;
}
