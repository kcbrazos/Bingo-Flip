import { FACE_LABELS, type BoardFace } from "../types/bingoFlip";

interface Props {
  teamLabel: string;
  colorHex: string;
  /** Squares this team holds. */
  held: number;
  /** Cells on the board, so the number reads as a share rather than as a bare count. */
  cells: number;
  /** Completed lines. Shown only once there is one, which under `line` ends the match anyway. */
  lines: number;
  /**
   * This team's score and the score that wins, under the points condition only.
   *
   * Both or neither. When they are here they replace the square count as the headline AND as what
   * the bar measures - see below.
   */
  score?: number;
  target?: number;
  isMine?: boolean;
}

/**
 * One team's standing, for the scorebug.
 *
 * Battleship drew hulls here as silhouettes, because "they've lost the Carrier" is a better thing to
 * read off a stream than "3/5" - the fleet was a set of named things and losing a specific one was
 * the news. Squares are not named things: twenty-five of them are interchangeable as far as a
 * scorebug is concerned, and what a viewer wants is the race. So this is a number and a bar.
 *
 * The bar is the half that carries at a glance. A viewer who never reads the digits still sees which
 * team is further along, which is the entire job of a scorebug.
 *
 * Which is why the bar has to measure the race that is actually being run. Under points it fills
 * toward the TARGET, not toward the board: a team on nine squares of twenty-five with two bingos is
 * a third of the way along the board and most of the way to a target of eleven, and a bar drawn the
 * first way tells a viewer the opposite of what is happening.
 */
export function OverlayTeamStatus({ teamLabel, colorHex, held, cells, lines, score, target, isMine }: Props) {
  const scoring = score !== undefined && target !== undefined && target > 0;
  const share = scoring
    ? Math.min(1, score / target)
    : cells > 0
      ? Math.min(1, held / cells)
      : 0;

  return (
    <div className={`ov-team${isMine ? " ov-team-mine" : ""}`}>
      <div className="ov-team-head">
        <span className="ov-team-name" style={{ color: colorHex }}>
          {teamLabel}
        </span>
        <span className="ov-team-count" style={{ fontVariantNumeric: "tabular-nums" }}>
          {scoring ? `${score}/${target}` : held}
        </span>
      </div>
      <div className="ov-team-bar" aria-hidden>
        <span style={{ width: `${share * 100}%`, background: colorHex }} />
      </div>
      {/* Under points the square count moves down here, because the headline is the score - but it
          is still worth showing, since it is what the board itself displays and a caster reading off
          the grid needs the two to agree. */}
      {(lines > 0 || scoring) && (
        <span className="ov-team-lines" style={{ color: colorHex }}>
          {scoring ? `${held} square${held === 1 ? "" : "s"}` : ""}
          {scoring && lines > 0 ? " · " : ""}
          {lines > 0 ? `${lines} line${lines === 1 ? "" : "s"}` : ""}
        </span>
      )}
    </div>
  );
}

/**
 * Which face the board is showing, for the scorebug.
 *
 * Worth its own element on a stream in a way it is not in the app: a player watching the board turn
 * has the whole board in front of them, and a viewer may be looking at a scorebug in the corner
 * while the caster talks over a replay. Reading "Shadow" there is how they know which board the
 * numbers beside it belong to.
 */
export function OverlayFaceBadge({ face, flipsLeft }: { face: BoardFace; flipsLeft: number }) {
  return (
    <div className="ov-face" data-face={face}>
      <span className="ov-face-name">{FACE_LABELS[face]}</span>
      <span className="ov-face-left">
        {flipsLeft} flip{flipsLeft === 1 ? "" : "s"} left
      </span>
    </div>
  );
}
