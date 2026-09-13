import { useEffect, useState } from "react";

/**
 * A spectator's self-declared team affiliation for one room, persisted locally.
 *
 * Purely a privacy switch on THIS browser's own view. A spectator with nothing riding on either
 * team can freely flip between both faces - see the peek control on SpectatorView, the same
 * feature the caster desk already offers, safe because nothing on a bingo board is secret once a
 * match is over the objectives on it. Declaring an affiliation gives that up: the board locks to
 * the live face only, exactly what a player on that team sees, so a friend, coach or teammate
 * watching alongside a team cannot read ahead on a face that team hasn't opened yet and relay it
 * back over voice chat.
 *
 * Nobody unaffiliated has anything to gain from lying about it, and nothing here enforces it
 * against someone who does - this is for the spectator who wants to watch fair, not a policy
 * against the ones who don't. Never sent to the server: it changes nothing about the match, only
 * what this one browser draws.
 */
export function useWatchingWith(roomCode: string | undefined) {
  const storageKey = roomCode ? `bf_watchwith_${roomCode}` : null;

  const [team, setTeam] = useState<number | null>(() => {
    if (!storageKey) return null;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === null) return null;
      const n = Number(raw);
      return Number.isInteger(n) ? n : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (!storageKey) return;
    try {
      if (team === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, String(team));
    } catch {
      // Private-mode / quota failures aren't worth surfacing over a viewing preference.
    }
  }, [storageKey, team]);

  return [team, setTeam] as const;
}
