import { useEffect, useMemo, useState } from "react";
import type { Player } from "../types/bingoFlip";
import { screensFromRoster, fetchScreenLogins, type CastScreen } from "../lib/castScreens";

/**
 * The casting scene's player boxes, resolved from a room's roster and kept current as it changes.
 *
 * Takes `players` from the caller's own useRoom rather than opening a subscription of its own -
 * the screen source is already watching the room for its own claim tally, and a parallel realtime
 * channel for the same rows would be duplicated egress. The Twitch logins are re-fetched only when
 * the roster's shape actually changes, which mid-match is never.
 */
export function useCastScreens(players: Player[]): CastScreen[] {
  const [logins, setLogins] = useState<Map<string, string | null>>(new Map());

  const rosterIds = useMemo(
    () => players.filter((p) => p.team !== null && p.team !== undefined).map((p) => p.user_id),
    [players]
  );

  /** Changes only when a player joins, leaves or swaps team - never on a claim landing. */
  const rosterKey = useMemo(() => [...rosterIds].sort().join("|"), [rosterIds]);

  useEffect(() => {
    let cancelled = false;
    void fetchScreenLogins(rosterKey ? rosterKey.split("|") : []).then((map) => {
      if (!cancelled) setLogins(map);
    });
    return () => {
      cancelled = true;
    };
  }, [rosterKey]);

  return useMemo(() => screensFromRoster(players, logins), [players, logins]);
}
