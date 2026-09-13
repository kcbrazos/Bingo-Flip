import { useBoxSize } from "../hooks/useBoxSize";
import { fitScale } from "../lib/overlayFit";
import { formatDuration } from "../lib/matchTime";
import { teamName, teamHex } from "../lib/teamColors";
import { oddsLabel, oddsWorthShowing, type OddsPoint, type OddsSnapshot } from "../lib/flipOdds";
import { OddsGraph } from "./OddsGraph";
// The panel's styling lives with the source it was written for, same arrangement ClockBar uses for
// OverlayTimer.css.
import "../pages/OverlayOdds.css";

/**
 * The evaluation bar: each team's chance of winning, and the line that got them there.
 *
 * Its own component because two callers want the exact same reading - the standalone browser
 * source and the caster's own desk - and a second implementation would be a second opinion about
 * the one number on this page anybody will argue with. The argument should be about the model
 * (lib/flipOdds), not about which surface drew it.
 *
 * Fills whatever box it's given rather than being authored against a fixed width: laid out at its
 * natural size and scaled to fit, so it works in a 960px browser source and in a narrow rail alike.
 *
 * -- The one rule for measuring anything in here -------------------------------------------------
 *
 * This panel may measure the box it was GIVEN. It may never measure anything its own drawing can
 * change - `frame` takes its size from its parent and the plate inside it is absolutely positioned,
 * so nothing drawn here can feed back into what gets measured.
 */

const GRAPH_WIDTH = 880;
const GRAPH_HEIGHT = 150;
const MIN_WIDTH = 280;
const PLATE_CHROME = 42;

export function OddsPanel({
  snapshot,
  points,
  elapsed,
  showGraph,
  opacity = 1,
  textSize = 1,
}: {
  snapshot: OddsSnapshot | null;
  points: OddsPoint[];
  /** The match clock, already formatted - only the caller knows whether it is running. */
  elapsed: string;
  /** The history line under the bar. Off is not a lesser version - the bar alone is the whole
   * reading, and the line is the reasoning. */
  showGraph: boolean;
  opacity?: number;
  /** The CEILING on the fit, not a multiplier after it - see fitScale and lib/overlayText. */
  textSize?: number;
}) {
  const [frameRef, frame] = useBoxSize<HTMLDivElement>();
  const [panelRef, panel] = useBoxSize<HTMLDivElement>();

  const natural =
    frame.w > 0 ? Math.max(MIN_WIDTH, Math.min(GRAPH_WIDTH, frame.w - PLATE_CHROME)) : GRAPH_WIDTH;

  const scale = fitScale(panel, frame, 8, textSize);
  const ready = oddsWorthShowing(snapshot);

  return (
    <div className="ovo-fit" ref={frameRef}>
      {ready && (
        <div
          className="ovo-panel"
          ref={panelRef}
          style={{ transform: `translate(-50%, -50%) scale(${scale})`, opacity }}
        >
          <div className="ovo-head">
            <span className="ovo-title">Odds of Victory</span>
            {snapshot.decided && <span className="ovo-decided">Decided</span>}
          </div>

          {/* The bar is the number. Each team's slice IS its chance, so the reading is the width
              rather than the digits - which is what lets somebody glance at it mid-sentence. */}
          <div className="ovo-now" style={{ width: natural }}>
            {snapshot.teams.map((team, i) => (
              <div
                key={team}
                className={`ovo-seg${snapshot.odds[i] < 0.12 ? " ovo-seg-tight" : ""}`}
                style={{ flexGrow: Math.max(snapshot.odds[i], 0.008), background: teamHex(team) }}
              >
                <span className="ovo-seg-name">{teamName(team)}</span>
                <span className="ovo-seg-pct">{oddsLabel(snapshot.odds[i])}</span>
              </div>
            ))}
          </div>

          {showGraph && points.length > 1 && (
            <>
              <div className="ovo-graph" style={{ width: natural, height: GRAPH_HEIGHT }}>
                <OddsGraph teams={snapshot.teams} points={points} width={natural} height={GRAPH_HEIGHT} />
              </div>
              <div className="ovo-axis">
                <span>{formatDuration(points[0].seconds)}</span>
                <span className="ovo-axis-now">{elapsed}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
