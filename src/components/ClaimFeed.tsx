import { cellLabel } from "../lib/flipLogic";
import { teamHex } from "../lib/teamColors";
import { feedEntries } from "../lib/claimFeed";
import { matchStartedAt, formatDuration, matchTimings } from "../lib/matchTime";
import { FACE_LABELS } from "../types/bingoFlip";
import type { Challenge } from "../lib/challenges";
import type { Claim, Player, Room } from "../types/bingoFlip";

interface Props {
  claims: Claim[];
  players: Player[];
  boardSize: number;
  /** Both faces, so a line can name the objective as it read when the claim landed. */
  faces: readonly [Challenge[], Challenge[]];
  room?: Room | null;
  maxHeight?: number | string;
}

export function ClaimFeed({ claims, players, boardSize, faces, room, maxHeight = "100%" }: Props) {
  const entries = feedEntries(claims, players, faces);
  const startedAt = matchStartedAt(room, claims);
  const timings = matchTimings(room);

  // Claims can only land once MATCH begins, so this is elapsed MATCH time - matching the clock above
  // the board rather than raw time since the STARTING countdown first kicked off.
  function gameTimeAt(iso: string): string {
    if (!startedAt) return "--:--";
    const sinceAnchor = (new Date(iso).getTime() - new Date(startedAt).getTime()) / 1000;
    return formatDuration(sinceAnchor - timings.matchBeginsAt);
  }

  return (
    <div className="panel stack" style={{ width: "100%", flex: 1, minHeight: 0, gap: "0.4rem" }}>
      <h3 style={{ margin: 0 }}>Match Log</h3>
      {/* On the scroller below: flex + minHeight 0 alongside maxHeight, because a percentage
          max-height only resolves against a parent with a definite height - on its own it silently
          does nothing in a flex column. The flex pair is what holds it to the space left over. */}
      {entries.length === 0 ? (
        <span className="muted" style={{ fontSize: "0.8rem" }}>Nothing claimed yet.</span>
      ) : (
        <div
          className="stack"
          style={{ gap: "0.45rem", maxHeight, flex: 1, minHeight: 0, overflowY: "auto", fontSize: "0.82rem" }}
        >
          {entries.map((entry) => (
            <div key={entry.key} className="stack" style={{ gap: "0.05rem" }}>
              <div className="row" style={{ gap: "0.4rem", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ minWidth: 0, display: "flex", gap: "0.4rem", alignItems: "baseline" }}>
                  <span
                    className="muted"
                    style={{ fontSize: "0.68rem", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}
                  >
                    {gameTimeAt(entry.at)}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <strong style={{ color: teamHex(entry.team) }}>{entry.who}</strong>
                    <span className="muted"> took </span>
                    <strong>{entry.objective || cellLabel(entry.cellIndex, boardSize)}</strong>
                  </span>
                </span>
                {/* The turn is the loudest thing that can happen in a match, so it gets the outcome
                    column to itself. Everything else in the log is one square changing hands. */}
                {entry.flipped && (
                  <span
                    style={{
                      color: "var(--board-glow)",
                      whiteSpace: "nowrap",
                      fontWeight: 600,
                      letterSpacing: "0.08em",
                    }}
                  >
                    FLIPPED
                  </span>
                )}
              </div>
              <span className="muted" style={{ fontSize: "0.72rem" }}>
                {/* Which face it was taken on, because the same coordinate means two different
                    objectives across a match and the log is the record of which. */}
                {FACE_LABELS[entry.face]} · {cellLabel(entry.cellIndex, boardSize)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
