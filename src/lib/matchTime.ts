import type { Claim } from "../types/bingoFlip";

/**
 * When the match clock started, read from the room so every player's clock agrees.
 *
 * Battleship kept this as a sentinel row in the attack log, because `rooms` had no per-match
 * timestamp and adding one needed DDL. Bingo Flip has `rooms.started_at` instead - the sentinel is
 * not available here, since `claims` carries a unique index on (room_id, cell_index) and a marker
 * row would occupy a square.
 *
 * Falls back to the earliest claim, which covers the window between a host opening the match and the
 * room row arriving over realtime, and null when there is nothing to anchor to yet.
 */
export function matchStartedAt(
  room: { started_at?: string | null } | null | undefined,
  claims: readonly Claim[] = []
): string | null {
  if (room?.started_at) return room.started_at;
  if (claims.length === 0) return null;
  return claims.reduce(
    (earliest, c) => (c.created_at < earliest ? c.created_at : earliest),
    claims[0].created_at
  );
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * A match opens with a countdown, not straight into the race: STARTING is a short "get ready" beat
 * (the horn plays right as it begins - see Room.tsx's status-change effect), PREPARATION is a longer
 * buffer to read BOTH faces of the board before claims are allowed, then MATCH is the race itself.
 * All three are time windows measured from rooms.started_at.
 *
 * Preparation matters more here than it did in Battleship. A flip board asks a team to plan against
 * objectives that are not currently on the table, so the buffer is where they work out which face
 * they would rather be racing on - and therefore whether they want to reach a flip square first or
 * keep the opponent off one.
 */
export const DEFAULT_STARTING_SECONDS = 10;
export const DEFAULT_PREPARATION_SECONDS = 4 * 60;

export interface MatchTimings {
  starting: number;
  preparation: number;
  /** Seconds from the start instant until claiming opens. */
  matchBeginsAt: number;
}

/**
 * Countdown lengths for a room. The columns are optional in the type because rooms created
 * before the qol_batch migration don't have them - those fall back to the original constants
 * rather than collapsing to a zero-length countdown.
 */
export function matchTimings(room?: { starting_seconds?: number; prep_seconds?: number } | null): MatchTimings {
  const starting = room?.starting_seconds ?? DEFAULT_STARTING_SECONDS;
  const preparation = room?.prep_seconds ?? DEFAULT_PREPARATION_SECONDS;
  return { starting, preparation, matchBeginsAt: starting + preparation };
}

export type BattlePhaseName = "starting" | "preparation" | "match";

export interface BattlePhaseInfo {
  phase: BattlePhaseName;
  /** Seconds left in the STARTING/PREPARATION countdown; 0 once MATCH begins. */
  countdown: number;
  /** Seconds elapsed since MATCH itself began; 0 before that. */
  matchElapsed: number;
}

/**
 * The instant a phase calculation should treat as "now".
 *
 * While a room is paused every phase freezes exactly where it stood: the countdown stops ticking
 * down and the match clock stops ticking up, because both are plain functions of `started_at` and
 * this value. Resuming doesn't need to unfreeze anything here - it slides `started_at` itself
 * forward (see pauseMatch/resumeMatch in lib/rooms.ts), so the very next tick after a resume already
 * reads the correct elapsed time without this function's help.
 */
export function effectiveNow(room: { paused_at?: string | null } | null | undefined, nowMs: number): number {
  return room?.paused_at ? new Date(room.paused_at).getTime() : nowMs;
}

export function battlePhaseAt(
  startedAt: string | null,
  nowMs: number,
  timings: MatchTimings
): BattlePhaseInfo | null {
  if (!startedAt) return null;
  const elapsed = (nowMs - new Date(startedAt).getTime()) / 1000;

  if (elapsed < timings.starting) {
    return { phase: "starting", countdown: timings.starting - elapsed, matchElapsed: 0 };
  }
  if (elapsed < timings.matchBeginsAt) {
    return { phase: "preparation", countdown: timings.matchBeginsAt - elapsed, matchElapsed: 0 };
  }
  return { phase: "match", countdown: 0, matchElapsed: elapsed - timings.matchBeginsAt };
}
