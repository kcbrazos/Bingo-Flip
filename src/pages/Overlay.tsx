import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useRoom } from "../hooks/useRoom";
import { activeTeams } from "../lib/teams";
import { cellLabel, scoreFor } from "../lib/flipLogic";
import { cellOwners } from "../lib/cellVisuals";
import { feedEntries } from "../lib/claimFeed";
import { facesForRoom } from "../lib/challenges";
import { formatDuration, matchTimings, matchStartedAt } from "../lib/matchTime";
import { useBattleClock, useBattlePhaseName } from "../hooks/useBattlePhase";
import { teamName, teamHex } from "../lib/teamColors";
import { OverlayGrid, type OverlayLayer } from "../components/OverlayGrid";
import { OverlayTeamStatus, OverlayFaceBadge } from "../components/OverlayTeamStatus";
import { squaresRevealed } from "../lib/overlayReveal";
import {
  DEFAULT_BONUS_PER_BINGO,
  DEFAULT_WIN_CONDITION,
  defaultTargetScore,
  type WinCondition,
} from "../types/bingoFlip";
import type { Claim, Room } from "../types/bingoFlip";
import "./Overlay.css";
import "../components/BoardGrid.css";

// See MatchClock for why the label and the phase key differ.
const PHASE_LABEL = { starting: "Randomization", preparation: "Preparation", match: "Match" } as const;

/**
 * Transparent stream overlay, designed to be dropped into OBS as a Browser Source.
 *
 * Reads nothing that is not public, which on a bingo board is everything: the room, the roster and
 * the claim log. That is not a restraint so much as a description - there is no hidden information
 * in this game to leak to a stream-sniper, which is the largest thing the flip rework simplified
 * here.
 *
 * It still matters that the data is public, though, because an OBS Browser Source is a separate
 * browser context with no saved session. It authenticates as a brand-new anonymous user who belongs
 * to no team, so anything gated behind team membership would come back empty. Everything this reads
 * is readable by that stranger, which is why the URL works the instant it is pasted in.
 */
export function Overlay() {
  const { code } = useParams<{ code: string }>();
  const [params] = useSearchParams();
  const state = useRoom(code);

  // The app shell paints a background and centers content; a stream overlay must be transparent
  // and flush to the corner, so opt this route out of both while it's mounted.
  //
  // Tagged on <html> as well as <body> because the background color is declared on :root - with
  // body alone, the browser canvas kept painting navy and the overlay filled its OBS source with
  // an opaque rectangle. See the matching selectors in Overlay.css.
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
  // Drives the reveal gate below: names hold until the board has finished being dealt.
  const battlePhase = useBattlePhaseName(state.claims, room);
  const startedAt = matchStartedAt(room, state.claims);
  const timings = matchTimings(room);

  /**
   * There is no spoiler mode any more.
   *
   * ?key= used to hand this source the owner's own ship positions through the overlay_fleet RPC -
   * the one credential that let an anonymous overlay session read behind RLS. A bingo board hides
   * nothing from anybody, so there is no spoiler to opt into and no credential to check. The
   * parameter is still accepted and ignored, so a scene collection built for the old source keeps
   * working rather than erroring on an unknown one.
   */

  if (!room) return null;

  const teams = activeTeams(state.players);
  const faces = facesForRoom(
    room.id,
    room.board_size * room.board_size,
    room.square_set,
    room.seed,
    room.custom_square_set
  );
  const challenges = state.face === 0 ? faces.light : faces.dark;
  const owners = cellOwners(state.claims);

  // A points match is decided by a number the grid does not contain, so a scorebug that does not
  // carry it is showing a viewer the wrong race entirely. Same arithmetic as the players own roster.
  const winCondition = (room.win_condition ?? DEFAULT_WIN_CONDITION) as WinCondition;
  const bonusPerBingo = room.bonus_per_bingo ?? DEFAULT_BONUS_PER_BINGO;
  const targetScore = room.target_score ?? defaultTargetScore(room.board_size);
  const flipsLeft = (room.flip_cells ?? []).filter((c) => !owners.has(c)).length;

  // ?team=N marks the streamer's own team so viewers can tell at a glance which side they're on.
  const rawTeam = params.get("team");
  const highlightTeam = rawTeam !== null && rawTeam !== "" ? Number(rawTeam) : null;

  const showLog = params.get("log") !== "0";
  const logLimit = Number(params.get("logLimit") ?? 6) || 6;

  // Boards are opt-in so existing overlay URLs keep behaving exactly as they did.
  const showGrids = params.get("grids") === "1";
  // ?layout= is read no longer. It chose between a grid per fleet and all of them composited onto
  // one; there is a single shared board now, so both settings describe the same picture. Left
  // unparsed rather than removed from the docs, so an existing URL carrying it is simply ignored.
  // Ceiling raised well past the old 48 specifically so boss names become possible: they need a
  // 56px cell to survive a stream encoder, which is a 572px board.
  const cellPx = Math.min(96, Math.max(8, Number(params.get("cell") ?? 20) || 20));
  // Opt-in AND phase-gated: the squares stay blank until the match starts, so this column can't be
  // read as a placement cheat sheet either. See lib/overlayReveal.ts.
  const showNames = params.get("names") === "1" && squaresRevealed(room.status, battlePhase);
  const showCoords = params.get("coords") !== "0";
  // Which edge of the browser source the column hugs. Only matters when the source is wider than
  // the overlay itself, which it usually is once you've sized it to a screen edge.
  const side = params.get("side") === "right" ? "right" : "left";

  const showFocus = params.get("focus") !== "0";

  // feedEntries sorts newest first, so [0] is the square that just changed hands.
  const allEntries = feedEntries(state.claims, state.players, [faces.light, faces.dark]);
  const entries = allEntries.slice(0, logLimit);
  const latest = allEntries[0] ?? null;

  /**
   * One layer per team, and one board rather than one board per team.
   *
   * Battleship drew a grid PER FLEET, because each fleet had its own private water and a square meant
   * something different on each. There is one board here that everyone plays on, so the stacked and
   * composited layouts collapse into the same picture and `?single=` has nothing left to choose
   * between. The teams are still layers because that is what colours the bands on a shared square.
   */
  const layers: OverlayLayer[] = teams.map((t) => ({
    team: t,
    teamLabel: highlightTeam === t ? `${teamName(t)} - you` : teamName(t),
    colorHex: teamHex(t),
  }));

  function gameTimeAt(iso: string): string {
    if (!startedAt) return "--:--";
    const since = (new Date(iso).getTime() - new Date(startedAt).getTime()) / 1000;
    return formatDuration(since - timings.matchBeginsAt);
  }

  return (
    <div className={`ov ov-${side}`} data-face={state.face}>
      <OverlayClock claims={state.claims} room={room} />

      {/* The objective names live HERE rather than on the board.
          A hundred names cannot be rendered into a 200px-wide grid at any font size that survives a
          stream encoder, so instead of shrinking them to mush, the one that matters right now gets
          the whole width and the display face. The ring on the board ties it back to its square, and
          the log underneath keeps the last few. */}
      {showFocus && latest && (
        <div className="ov-card ov-focus">
          <div className="ov-focus-head">
            <span className="ov-focus-coord">{cellLabel(latest.cellIndex, room.board_size)}</span>
            {/* The turn is the only outcome worth its own word. Everything else in this log is one
                square changing hands, which the colour beside it already says. */}
            {latest.flipped && (
              <span className="ov-focus-outcome" style={{ color: "var(--board-glow)" }}>
                FLIPPED
              </span>
            )}
          </div>
          <div className="ov-focus-name">{latest.objective || `Square ${latest.cellIndex}`}</div>
          <div className="ov-focus-who" style={{ color: teamHex(latest.team) }}>
            {latest.who}
          </div>
        </div>
      )}

      {/* Which face is up, and how many turns the board has left in it. Both are public, both change
          how the next thirty seconds go, and neither is derivable from a grid of colours. */}
      <div className="ov-card">
        <OverlayFaceBadge face={state.face} flipsLeft={flipsLeft} />
      </div>

      <div className="ov-card ov-teams">
        {teams.map((t) => {
          const scored = scoreFor(state.claims, room.board_size, t, bonusPerBingo);
          return (
            <OverlayTeamStatus
              key={t}
              teamLabel={teamName(t)}
              colorHex={teamHex(t)}
              held={scored.squares}
              cells={room.board_size * room.board_size}
              lines={scored.lines}
              score={winCondition === "points" ? scored.score : undefined}
              target={winCondition === "points" ? targetScore : undefined}
              isMine={highlightTeam === t}
            />
          );
        })}
      </div>

      {/* One board, always. `?single=` used to choose between a grid per fleet and all of them
          composited; there is one shared board now, so both layouts are the same picture and the
          parameter is accepted and ignored. */}
      {showGrids && layers.length > 0 && (
        <div className="ov-card">
          <OverlayGrid
            boardSize={room.board_size}
            cell={cellPx}
            layers={layers}
            owners={(i) => owners.get(i) ?? []}
            isFlip={(i) => (room.flip_cells ?? []).includes(i)}
            pulseCell={showFocus && latest ? latest.cellIndex : null}
            showCoords={showCoords}
            cellName={showNames ? (i) => challenges[i]?.short ?? challenges[i]?.name ?? null : undefined}
          />
        </div>
      )}

      {showLog && entries.length > 0 && (
        <div className="ov-card ov-log">
          {entries.map((entry) => (
            <div className="ov-log-row" key={entry.key}>
              <span className="ov-log-time">{gameTimeAt(entry.at)}</span>
              <span className="ov-log-who" style={{ color: teamHex(entry.team) }}>
                {entry.who}
              </span>
              <span className="ov-log-target">{entry.objective || `#${entry.cellIndex}`}</span>
              {entry.flipped && (
                <span className="ov-log-outcome" style={{ color: "var(--board-glow)" }}>
                  FLIPPED
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


/**
 * The clock card, as its own component purely so that the tick stops here.
 *
 * `useBattleClock` re-renders whatever calls it once a second, and this used to be called by the
 * Overlay page itself - which meant that every second, on the streamer's machine, an OBS browser
 * source rebuilt the room's whole challenge list, regrouped the entire attack log into shots, re-ran
 * the deep-water reveal and recomputed a result layer for every fleet, before re-rendering every
 * board on the overlay. All of it to move two digits.
 *
 * Nothing else on the page read `phase`, so lifting the card out is a pure structural move: the same
 * markup lands in the same slot, and the parent now re-renders only when match data actually changes.
 * Same trick, same reason, as MatchClock on the player's screen - see useBattlePhase.
 */
function OverlayClock({ claims, room }: { claims: Claim[]; room: Room | null }) {
  const phase = useBattleClock(claims, room);
  const clock = phase
    ? phase.phase === "match"
      ? formatDuration(phase.matchElapsed)
      : `-${formatDuration(phase.countdown)}`
    : "--:--";

  return (
    <div className="ov-card ov-clock">
      <span className="ov-phase">{phase ? PHASE_LABEL[phase.phase] : "Match"}</span>
      <span className="ov-time">{clock}</span>
    </div>
  );
}
