import { fetchProfiles } from "./profiles";
import type { Player } from "../types/bingoFlip";

/**
 * The player-stream boxes in a casting scene: which Twitch channel belongs in each, and whose name
 * sits over it.
 *
 * -- Why this reads the roster rather than being handed it -------------------------------------
 *
 * A caster generates one `/overlay-screen/:code?slot=N` source per seat, and the boxes have to
 * survive a sub taking a vacated seat mid-tournament without the caster re-copying URLs - so each
 * one resolves its player live: the room names the seats, and a seat's `slot` (its index once the
 * players are put in a stable order) is what one screen source is pinned to.
 *
 * -- Why the Twitch login is a plain profiles read -----------------------------------------------
 *
 * `profiles` is world-readable already (see the room_management migration's "profiles select"
 * policy), and an OBS browser source is an anonymous session that needs no more than anon has
 * here. A login is not a credential, and the player is about to be on the same stream this scene
 * is being built for.
 */

/** One resolved box. `twitchLogin` is null when that seat's account never signed in with Twitch. */
export interface CastScreen {
  /** Index into the roster in stable order - what a screen source's `?slot=` points at. */
  slot: number;
  /** `players.id` of the seat, so a caller can match it to its own per-player stats. */
  playerId: string;
  team: number;
  name: string | null;
  twitchLogin: string | null;
}

/**
 * The roster in the order the boxes are numbered: by team, then by who sat down first.
 *
 * A spectator holds no team and is not a screen. The order is stable across a match so a refreshed
 * source lands back on the same player, and a sub taking a vacated seat inherits its slot - the box
 * stays where it is on screen and the face inside it changes.
 */
export function screensFromRoster(players: Player[], logins: Map<string, string | null>): CastScreen[] {
  return players
    .filter((p) => p.team !== null && p.team !== undefined)
    .slice()
    .sort((a, b) => (a.team as number) - (b.team as number) || a.joined_at.localeCompare(b.joined_at))
    .map((p, i) => ({
      slot: i,
      playerId: p.id,
      team: p.team as number,
      name: p.nickname || null,
      twitchLogin: logins.get(p.user_id) ?? null,
    }));
}

/**
 * Twitch logins for a set of accounts, keyed by auth id.
 *
 * A missing row or an account that never linked Twitch both land at `null` for that id rather than
 * at a throw - a box with no channel draws a name plate over an empty frame, which is a perfectly
 * good "seat filled, stream not linked" and far better than a source that errored out mid-broadcast.
 */
export async function fetchScreenLogins(userIds: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const profiles = await fetchProfiles(unique);
  return new Map(unique.map((id) => [id, profiles.get(id)?.twitch_login ?? null]));
}
