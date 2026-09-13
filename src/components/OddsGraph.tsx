import { teamHex } from "../lib/teamColors";
import { oddsBands, type OddsPoint } from "../lib/flipOdds";

interface OddsGraphProps {
  teams: number[];
  points: OddsPoint[];
  /** Drawing box. The graph fills it exactly - the caller decides how big it is on screen. */
  width: number;
  height: number;
  /** Draw the halfway rule. Off on a very compact strip, where it is more ink than information. */
  rule?: boolean;
}

/**
 * The win-probability line: how the odds have moved across the match clock.
 *
 * -- Why it is a stacked band and not a line ---------------------------------------------------
 *
 * A single line means "one team's chance", which forces a choice of whose - and with three or more
 * teams there is no such team. A stack has no such problem: every team gets a band, the bands
 * always fill the height because the odds always sum to one, and the same drawing works unchanged
 * for two teams or five.
 *
 * -- Why it is drawn rather than animated -------------------------------------------------------
 *
 * Every point is a simulation of the match as it stood at that moment (see oddsTimeline), replayed
 * from the public claims log rather than accumulated as the match ran - so a source refreshed at
 * the thirty-minute mark draws the same shape as one open since the horn.
 *
 * The geometry lives in lib/flipOdds.oddsBands rather than here, so a stacking bug is something
 * that can be asserted rather than something that has to be eyeballed on a stream.
 */
export function OddsGraph({ teams, points, width, height, rule = true }: OddsGraphProps) {
  const bands = oddsBands(teams, points, width, height);
  if (bands.length === 0) return null;

  return (
    <svg
      className="odds-graph"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {bands.map(({ team, polygon }) => (
        <polygon
          key={team}
          points={polygon.map(([x, y]) => `${x},${y}`).join(" ")}
          fill={teamHex(team)}
          fillOpacity={0.85}
        />
      ))}

      {/* Where the odds are even. The eye needs somewhere to measure the swing from. */}
      {rule && (
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="rgba(255,255,255,0.5)"
          strokeWidth={1}
          strokeDasharray="4 4"
        />
      )}
    </svg>
  );
}
