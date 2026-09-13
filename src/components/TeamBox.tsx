import { teamName, teamHex } from "../lib/teamColors";
import type { Player } from "../types/bingoFlip";

interface Props {
  team: number;
  players: Player[];
  /** Squares this team holds. Omit to hide the progress line entirely (the lobby has nothing to show). */
  held?: number;
  /** Cells on the board, so the count reads as a share of it rather than as a bare number. */
  cells?: number;
  /** How many completed lines this team has. */
  lines?: number;
  /**
   * This team's score, under the points condition only.
   *
   * Omitted under `line`, where a bingo ends the match rather than scoring, and the roster is a
   * square count. Passing it there would put a number on screen that decides nothing.
   */
  score?: number;
  /** The score that wins, so the roster reads as progress rather than as a bare number. */
  target?: number;
  isMine?: boolean;
  myPlayerId?: string;
}

export function TeamBox({ team, players, held, cells, lines, score, target, isMine, myPlayerId }: Props) {
  const members = players.filter((p) => p.team === team);

  return (
    <div
      className="panel stack"
      style={{ width: "100%", gap: "0.4rem", borderColor: isMine ? teamHex(team) : undefined }}
    >
      <div className="row" style={{ justifyContent: "space-between", gap: "0.4rem" }}>
        <h3 style={{ color: teamHex(team), margin: 0, fontSize: "0.95rem" }}>
          {teamName(team)}
          {isMine && <span className="badge" style={{ marginLeft: "0.35rem" }}>you</span>}
        </h3>
        {/* Squares held, not hulls afloat. The number that used to live here counted down as a fleet
            was destroyed; this one counts up as a team gets closer to winning, which is the thing
            anybody glancing at a roster mid-match actually wants to know.

            Under points the SCORE takes that slot instead, because it is the number that decides the
            match - a team can be behind on squares and ahead on the board. The square count is still
            shown, underneath, since it is what the board itself displays. */}
        {score !== undefined ? (
          <span style={{ fontSize: "0.95rem", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
            {score}
            {target ? <span className="muted" style={{ fontWeight: 400 }}>/{target}</span> : null}
          </span>
        ) : (
          held !== undefined && (
            <span
              className="muted"
              style={{ fontSize: "0.75rem", fontVariantNumeric: "tabular-nums" }}
            >
              {held}
              {cells ? `/${cells}` : ""}
            </span>
          )
        )}
      </div>

      <div className="stack" style={{ gap: "0.1rem", fontSize: "0.8rem" }}>
        {members.length === 0 && <span className="muted">empty</span>}
        {members.map((p) => (
          <span key={p.id}>
            {p.nickname}
            {p.is_host && <span className="badge" style={{ marginLeft: "0.3rem" }}>host</span>}
            {p.id === myPlayerId && !isMine && <span className="badge" style={{ marginLeft: "0.3rem" }}>you</span>}
          </span>
        ))}
      </div>

      {/* Under `line` a completed line ends the match, so this only ever reads 0 and never shows.
          Under points it is the thing worth watching: lines are where the bonus comes from, and a
          team two squares from closing one is about to jump. Hidden at zero rather than shown as
          "0 bingos", which would be noise on every roster for most of every match.

          The square count moves here when the score has taken the slot above it. */}
      {((lines !== undefined && lines > 0) || score !== undefined) && (
        <span style={{ fontSize: "0.75rem", color: teamHex(team) }}>
          {score !== undefined && held !== undefined && (
            <span className="muted">
              {held} square{held === 1 ? "" : "s"}
              {lines ? " · " : ""}
            </span>
          )}
          {lines ? `${lines} bingo${lines === 1 ? "" : "s"}` : ""}
        </span>
      )}
    </div>
  );
}
