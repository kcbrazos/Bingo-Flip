import { useEffect, useRef } from "react";
import { useBattlePhaseName } from "./useBattlePhase";
import { cellsByTeam, completedLines } from "../lib/flipLogic";
import { playSfx } from "../lib/sfx";
import type { Claim, Room } from "../types/bingoFlip";

/**
 * Every sound the match itself makes, in one hook rather than one page.
 *
 * Lifted out of pages/Room verbatim so that pages/OverlayAudio - an OBS browser source with no
 * picture, added so a caster's stream carries the board's sound - can make the exact same noises a
 * player's own tab does, on the exact same triggers, without a second copy of this logic drifting
 * out of step with the first. See the note there for why the audio can't simply ride on the board
 * source instead.
 *
 * `myTeam` decides only the fanfare/sting split at the end - see the effect below. A page with no
 * team of its own (a spectator, or this hook's caster caller) reads "somebody was left standing" as
 * the fanfare and a draw as the sting, which is pages/Room's own rule for that case.
 */
export function useMatchSfx(room: Room | null | undefined, claims: Claim[], myTeam?: number | null): void {
  const battlePhase = useBattlePhaseName(claims, room);
  const prevPhase = useRef<string | null>(null);

  // Fanfare or fail sting, once, on the moment somebody takes it.
  //
  // Gated on having seen a previous status, so opening a link to a match that finished an hour ago
  // is a silent recap.
  const prevStatusForResult = useRef<string | null>(null);
  useEffect(() => {
    const status = room?.status ?? null;
    if (status === "finished" && prevStatusForResult.current !== null && prevStatusForResult.current !== "finished") {
      const winner = room?.winner_team ?? null;
      const lost = winner === null || (myTeam !== null && myTeam !== undefined && winner !== myTeam);
      playSfx(lost ? "defeat" : "victory");
    }
    prevStatusForResult.current = status;
  }, [room?.status, room?.winner_team, myTeam]);

  // Claiming is open. Gated on having seen a previous phase, so loading the page into a match that
  // is already running doesn't sound the opening at somebody who just arrived twenty minutes late.
  //
  // Only here, and not also when the room turns to `battle`: that is the START of the countdown,
  // and there is nothing to do for the next few minutes but read. One match, one opening.
  useEffect(() => {
    if (battlePhase === "match" && prevPhase.current !== null && prevPhase.current !== "match") {
      playSfx("start");
    }
    prevPhase.current = battlePhase;
  }, [battlePhase]);

  /**
   * A square changed hands, or a line closed.
   *
   * Driven off claim IDS rather than off the array's length, because the log both grows and shrinks -
   * releasing a square deletes a row - and a length that went 8, 7, 8 would otherwise sound the
   * re-claim as nothing at all while sounding the release as a claim.
   *
   * The first pass only RECORDS what is already there. Opening a room mid-match reads a board with
   * twenty claims on it, and every one of them is news to this browser and history to everybody
   * else; playing them would be a burst of twenty chimes for events that happened before you
   * arrived. `seeded` is what tells the two apart.
   */
  const heard = useRef<Set<string>>(new Set());
  const seeded = useRef(false);
  const lineCounts = useRef<Map<number, number>>(new Map());
  useEffect(() => {
    if (!room) return;

    // Re-arm on the way out of a match, so the next one in this room starts from silence rather
    // than from the last match's log - which "Play again" has already deleted underneath us.
    if (room.status === "lobby" || room.status === "prep") {
      heard.current = new Set();
      lineCounts.current = new Map();
      seeded.current = false;
      return;
    }

    const fresh = claims.filter((c) => !heard.current.has(c.id));
    const wasSeeded = seeded.current;
    heard.current = new Set(claims.map((c) => c.id));

    // Lines are counted per team every pass rather than derived from the new claims, because a
    // RELEASED square can take a line back down - and a count that only ever went up would sound
    // the same line twice when it was rebuilt.
    const lines = new Map<number, number>();
    for (const team of cellsByTeam(claims).keys()) {
      lines.set(team, completedLines(claims, room.board_size, team).length);
    }
    const closed = [...lines].some(([team, n]) => n > (lineCounts.current.get(team) ?? 0));
    lineCounts.current = lines;

    if (!wasSeeded) {
      seeded.current = true;
      return;
    }
    if (fresh.length === 0) return;

    // A bingo replaces the mark rather than stacking on it, and the end of the match replaces both:
    // victory and defeat are already sounding, and a chime under a fanfare is just mud.
    if (room.status === "finished") return;
    playSfx(closed ? "bingo" : "mark");
  }, [claims, room]);
}
