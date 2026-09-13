import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useRoom } from "../hooks/useRoom";
import { useBoxSize } from "../hooks/useBoxSize";
import { useBattleClock } from "../hooks/useBattlePhase";
import { activeTeams } from "../lib/teams";
import { formatDuration } from "../lib/matchTime";
import { teamName, teamHex } from "../lib/teamColors";
import { OverlayTeamStatus, OverlayFaceBadge } from "../components/OverlayTeamStatus";
import { squareCounts, completedLines } from "../lib/flipLogic";
import { cellOwners } from "../lib/cellVisuals";
import { fitScale } from "../lib/overlayFit";
import { readOpacity } from "../lib/overlayCast";
import { readTextSize } from "../lib/overlayText";
import { useFlipOdds } from "../hooks/useFlipOdds";
import { OddsPanel } from "../components/OddsPanel";
import "./Overlay.css";
import "./OverlayTimer.css";

// See MatchClock for why the label and the phase key differ.
const PHASE_LABEL = { starting: "Randomization", preparation: "Preparation", match: "Match" } as const;

/**
 * The scorebug: the match clock, with each team's squares drawn either side of it.
 *
 * Its own browser source rather than part of the board's, because the two want opposite treatment
 * in a scene. The board is big, moves, and gets pointed at; this is small, parked in a corner or
 * along the bottom, and never moves once placed. One source each means the caster can put them
 * where they like and hide one without losing the other.
 *
 * Entirely public data - the room and the claim log - so it needs no controller and no credential.
 * It follows the match on its own from the moment the URL is pasted in, which is the right
 * behaviour for the one element nobody should have to remember to drive.
 *
 * Teams are drawn as standing rather than as hulls, for the reason OverlayTeamStatus exists:
 * "they've lost the Carrier" is a better thing to read off a stream than a fraction when squares
 * are named things. Here they are not - twenty-five interchangeable cells - so what a viewer wants
 * is the race, which is a number and a bar. With more than two teams in the room they split evenly
 * around the clock rather than crowding one side.
 */
export function OverlayTimer() {
  const { code } = useParams<{ code: string }>();
  const [params] = useSearchParams();
  const state = useRoom(code);
  const phase = useBattleClock(state.claims, state.room);
  const [frameRef, frame] = useBoxSize<HTMLDivElement>();
  const [barRef, bar] = useBoxSize<HTMLDivElement>();
  /**
   * `?odds=1` folds the evaluation bar in under the clock - the caster's answer for a scorebug that
   * wants the win-probability reading permanently attached rather than brought up as its own source.
   * See pages/OverlayOdds for the standalone version, which also carries the history line this one
   * deliberately doesn't (a scorebug is a corner of the screen, not a place to read a graph).
   *
   * Called unconditionally, ahead of the room guard below - a hook cannot be called only sometimes,
   * so `enabled` is how this says "don't bother" without skipping the call. See useFlipOdds.
   */
  const showOdds = params.get("odds") === "1";
  const { snapshot: odds } = useFlipOdds(state.claims, state.room, state.players, false, showOdds);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("overlay-mode");
    document.body.classList.add("overlay-mode");
    return () => {
      root.classList.remove("overlay-mode");
      document.body.classList.remove("overlay-mode");
    };
  }, []);

  const room = state.room;
  if (!room) return null;

  const teams = activeTeams(state.players);
  // ?team=N marks the streamer's own team, same as the HUD overlay does.
  const rawTeam = params.get("team");
  const highlightTeam = rawTeam !== null && rawTeam !== "" ? Number(rawTeam) : null;
  // The standing cards are the point of this element, but a caster running it very small can drop
  // to the clock alone.
  const showTeams = params.get("teams") !== "0";
  // ?opacity= - the same setting the board takes, so a scene can be faded as one thing rather than
  // ending up with a ghost board under a solid scorebug. See readOpacity.
  const opacity = readOpacity(params);
  // ?text= - how far past its natural size the bar may be drawn to fill the source. See overlayText.
  const textSize = readTextSize(params);

  const cells = room.board_size * room.board_size;
  const counts = squareCounts(state.claims);
  const held = cellOwners(state.claims);
  const flipsLeft = (room.flip_cells ?? []).filter((c) => !held.has(c)).length;

  // Split around the clock: with two fleets that is one each, which is the case this is shaped for.
  const half = Math.ceil(teams.length / 2);
  const left = teams.slice(0, half);
  const right = teams.slice(half);

  const clock = phase
    ? phase.phase === "match"
      ? formatDuration(phase.matchElapsed)
      : `-${formatDuration(phase.countdown)}`
    : "--:--";

  const side = (group: number[]) =>
    group.map((t) => (
      <OverlayTeamStatus
        key={t}
        teamLabel={teamName(t)}
        colorHex={teamHex(t)}
        held={counts.get(t) ?? 0}
        cells={cells}
        lines={completedLines(state.claims, room.board_size, t).length}
        isMine={highlightTeam === t}
      />
    ));

  /**
   * Fill whatever source the streamer made, without them having to guess a size.
   *
   * The bar is laid out at its natural size and then scaled to fit, rather than being authored
   * against a fixed design width. That way one source works at 800px or 2400px, a four-fleet room
   * scales down instead of overflowing, and the recommended size in the control page is a
   * suggestion rather than a requirement.
   *
   * ResizeObserver reports LAYOUT size, which a transform doesn't affect - so measuring the bar
   * while scaling it cannot feed back into itself.
   *
   * See fitScale for why it leaves a margin rather than fitting exactly - the clock's plate has a
   * border on it too, and an exact fit is what clips it.
   *
   * The streamer's text size is the CEILING handed to that fit, not a multiplier applied after it:
   * the source is still the boundary, so asking for larger text on a bar that already fills its
   * source does nothing rather than pushing the clock's ends off the edge of the scene.
   */
  const scale = fitScale(bar, frame, 8, textSize);

  return (
    <div className="ovt" ref={frameRef}>
      {/* The measured, centred and scaled unit is this stack, not the bar alone - `?odds=1` adds a
          second row underneath, and the two have to grow and shrink together or the odds band
          would scale against a size fitScale never actually measured. */}
      <div className="ovt-stack" ref={barRef} style={{ transform: `translate(-50%, -50%) scale(${scale})`, opacity }}>
        <div className="ovt-bar">
          {showTeams && <div className="ovt-side ovt-left">{side(left)}</div>}

          <div className="ovt-clock">
            <span className="ovt-phase">{phase ? PHASE_LABEL[phase.phase] : "Match"}</span>
            <span className="ovt-time">{clock}</span>
            {/* Under the clock rather than beside a team, because the face belongs to the BOARD and
                not to anybody on it - and because a viewer glancing at a scorebug in the corner needs
                to know which board the numbers either side of it belong to. */}
            <OverlayFaceBadge face={state.face} flipsLeft={flipsLeft} />
          </div>

          {showTeams && <div className="ovt-side ovt-right">{side(right)}</div>}
        </div>

        {/* Opacity and scale already live on the stack, so the panel underneath takes neither -
            doubling either up would fade or shrink it twice. */}
        {showOdds && (
          <div className="ovt-odds">
            <OddsPanel snapshot={odds} points={[]} elapsed={clock} showGraph={false} />
          </div>
        )}
      </div>
    </div>
  );
}
