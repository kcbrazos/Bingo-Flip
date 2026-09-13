import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useRoom } from "../hooks/useRoom";
import { useBattleClock } from "../hooks/useBattlePhase";
import { useFlipOdds } from "../hooks/useFlipOdds";
import { formatDuration } from "../lib/matchTime";
import { OddsPanel } from "../components/OddsPanel";
import { readOpacity } from "../lib/overlayCast";
import { readTextSize } from "../lib/overlayText";
import "./Overlay.css";
import "./OverlayOdds.css";

/**
 * The odds source: each team's chance of winning, and how it got there.
 *
 * Its own browser source rather than a corner of the clock, for the same reason the clock is not
 * part of the board - the two want different treatment in a scene. This is a thing a caster brings
 * UP during a swing and takes back down, and it wants room for the history line that makes the
 * swing legible. A caster who wants it permanently attached to the clock has that too, as `?odds=1`
 * on the timer source.
 *
 * Entirely public data - the claims log and the room - so like the clock it needs no controller and
 * no credential, and follows the match on its own from the moment the URL is pasted in. See
 * lib/flipOdds for the model, and for how honest it is early versus late in a match.
 */
export function OverlayOdds() {
  const { code } = useParams<{ code: string }>();
  const [params] = useSearchParams();
  const state = useRoom(code);
  const phase = useBattleClock(state.claims, state.room);

  // ?graph=0 drops to the bar alone, for a caster who wants this very small.
  const showGraph = params.get("graph") !== "0";
  const { snapshot, timeline } = useFlipOdds(state.claims, state.room, state.players, showGraph);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("overlay-mode");
    document.body.classList.add("overlay-mode");
    return () => {
      root.classList.remove("overlay-mode");
      document.body.classList.remove("overlay-mode");
    };
  }, []);

  if (!state.room) return null;

  return (
    <div className="ovo">
      <OddsPanel
        snapshot={snapshot}
        points={timeline}
        elapsed={phase?.phase === "match" ? formatDuration(phase.matchElapsed) : "--:--"}
        showGraph={showGraph}
        opacity={readOpacity(params)}
        textSize={readTextSize(params)}
      />
    </div>
  );
}
