import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useRoom } from "../hooks/useRoom";
import { useBoxSize } from "../hooks/useBoxSize";
import { activeTeams } from "../lib/teams";
import { cellVisuals, cellOwners } from "../lib/cellVisuals";
import { facesForRoom } from "../lib/challenges";
import { teamHex } from "../lib/teamColors";
import { BoardGrid, type CellVisual } from "../components/BoardGrid";
import {
  useCastReceiver,
  DEFAULT_VIEW,
  STALE_AFTER_MS,
  MIN_ZOOM,
  MAX_ZOOM,
  readOpacity,
  type CastView,
} from "../lib/overlayCast";
import { readTextSize, OVERLAY_MAX_FONT } from "../lib/overlayText";
import { squaresRevealed } from "../lib/overlayReveal";
import { useBattlePhaseName } from "../hooks/useBattlePhase";
import { SOURCE_SIZE, placeBoard } from "../lib/overlayBoardLayout";
import "./Overlay.css";
import "./OverlayBoard.css";

/**
 * A view fixed by the URL, for a source with nobody driving it.
 *
 * The caster's board is aimed live from their control page, which is the right model for one person
 * running a broadcast. A PLAYER streaming their own match has no second monitor and no desk - they
 * want one board, framed once, that then looks after itself. So the same source can be pinned by
 * query string instead:
 *
 *     ?team=2            just that team's board
 *     ?zoom=1.4&cx=.3&cy=.5   framed on part of it, held there
 *     ?names=0 ?coords=0
 *     ?opacity=0.5       see-through, so gameplay reads underneath it
 *     ?text=1.5          square names and coordinates drawn half again as large
 *     ?pin=1             every team, but still pinned - see below
 *
 * `pin` exists because "all teams, unattended" and "whatever the caster is doing" would otherwise
 * be the same URL (no parameters at all), and they are opposite intentions.
 *
 * A pinned source deliberately IGNORES the cast channel. Both kinds of source can be pointed at the
 * same room at once - a caster running board control while a player streams their own team - and a
 * URL that states what it wants must not be quietly repainted by somebody else's controller.
 *
 * Returns null when the URL asks for nothing, which is what puts the source back under the
 * caster's control.
 */
function pinnedView(params: URLSearchParams): CastView | null {
  // `text` is deliberately NOT in this list. Every other parameter here says what the board is
  // looking at, which is the thing a controller would otherwise be deciding; text size says how big
  // it is drawn, which no controller sends and nobody else has an opinion about. Including it would
  // mean a caster who typed ?text= onto their own source had silently pinned it and lost their
  // control page - a setting about legibility must not be able to disconnect anything.
  const keys = ["pin", "team", "zoom", "cx", "cy", "names", "coords", "opacity"];
  if (!keys.some((k) => params.get(k) !== null)) return null;

  const num = (key: string, fallback: number, lo: number, hi: number) => {
    const raw = params.get(key);
    if (raw === null || raw === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };

  const team = params.get("team");
  const teamNum = team !== null && team !== "" ? Number(team) : NaN;

  return {
    ...DEFAULT_VIEW,
    // ?team=N pins the source to one team; anything else shows every team. This read "results"
    // before that mode was dropped - it meant the same board, so the behaviour is unchanged.
    mode: Number.isInteger(teamNum) ? teamNum : "all",
    zoom: num("zoom", 1, MIN_ZOOM, MAX_ZOOM),
    cx: num("cx", 0.5, 0, 1),
    cy: num("cy", 0.5, 0, 1),
    names: params.get("names") !== "0",
    coords: params.get("coords") !== "0",
    opacity: readOpacity(params),
    visible: true,
  };
}

/**
 * The board on its own, as an OBS Browser Source, driven live by a caster's control page.
 *
 * -- Why this draws the REAL board ------------------------------------------------------------
 *
 * Built on BoardGrid - the same component the players are looking at - rather than on OverlayGrid.
 * OverlayGrid is very good at what it was written for: a 12px-a-cell grid tucked in the corner of a
 * streamer's own HUD, where a colour band is all that can survive and square names are refused
 * outright below 48px because they'd be mush. Every one of those decisions is wrong for a caster's
 * main stage, which is a full-size board somebody is pointing at and reading out.
 *
 * Using the players' own board means the stream shows exactly what they see: names fitted per
 * square rather than at one shared size, tinted by region or keyword the same way, the same flip
 * marks and the same ownership rings. A viewer looking at the stream and a player looking
 * at their screen are looking at the same object, which is the whole job.
 *
 * -- Zoom is cell size, not a scale transform -------------------------------------------------
 *
 * The board is genuinely rendered larger and then panned inside the frame, rather than being drawn
 * small and blown up. Transform-scaled text is resampled and a stream encoder finishes it off.
 * BoardGrid sizes itself from maxVh/maxVw, so a zoom is just a bigger number handed to it, and its
 * own per-square fitting recalculates at the new size.
 *
 * The offsets are MEASURED. The rendered board is never exactly `boardSize * cell` - coordinate
 * gutters, gaps and borders all land inside it - and computing it was what put the board in the
 * corner with half of it cropped in the first version.
 */

export function OverlayBoard() {
  const { code } = useParams<{ code: string }>();
  const [params] = useSearchParams();
  const debug = params.get("debug") === "1";
  /**
   * How large the names are drawn, over what the squares would choose - see lib/overlayText.
   *
   * Read straight from the URL rather than off the cast view, so it works the same on a player's
   * pinned source and on a caster-driven one. It is the only thing about this board that both kinds
   * of source configure the same way, which is the point: it is about the audience, not the match.
   */
  const textSize = readTextSize(params);
  const state = useRoom(code);
  /**
   * A URL-pinned source doesn't join the cast channel at all.
   *
   * Not merely ignoring the frames: not subscribing means a player's own board source can't be
   * repainted by a caster who happens to be running board control on the same room, and doesn't
   * announce itself or report its size to somebody else's desk. useCastReceiver already treats a
   * missing code as "nothing to subscribe to", so passing undefined is the whole mechanism.
   */
  const pinned = pinnedView(params);
  const { message: cast, report } = useCastReceiver(pinned ? undefined : code);

  /**
   * There is no private view to fetch any more.
   *
   * This is where a pinned source read its owner's squares with ?key=, through the overlay_fleet
   * RPC - the one credential that let an anonymous overlay session see behind RLS. Nothing on a
   * bingo board is hidden from anybody, so the key, the RPC and the whole "show my team" toggle have
   * no subject. ?key= is still accepted in the URL and ignored, so a scene collection built for the
   * old source keeps working rather than erroring on an unknown parameter.
   */
  const [frameRef, frame] = useBoxSize<HTMLDivElement>();
  const [stageRef, stage] = useBoxSize<HTMLDivElement>();

  // Same transparency opt-out the other overlay makes - see the note there about :root.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("overlay-mode");
    document.body.classList.add("overlay-mode");
    return () => {
      root.classList.remove("overlay-mode");
      document.body.classList.remove("overlay-mode");
    };
  }, []);

  // Tell the controller how big this source is, so its preview rectangle means something. Re-sent
  // whenever a frame arrives as well as on resize: the first report can easily be made before the
  // channel finishes subscribing, and the size never changes again to trigger a retry.
  useEffect(() => {
    if (frame.w > 0 && frame.h > 0) report({ w: frame.w, h: frame.h });
  }, [frame.w, frame.h, report, cast?.at]);

  const room = state.room;
  // Drives the reveal gate below: names hold until the board has finished being dealt.
  const battlePhase = useBattlePhaseName(state.claims, room);
  if (!room) return null;

  // A URL that pins the view outranks the channel entirely - see pinnedView. Nothing is "stale"
  // in that case either: there is no controller to have gone quiet.
  const view: CastView = pinned ?? cast?.view ?? DEFAULT_VIEW;
  const stale = !pinned && cast !== null && Date.now() - cast.at > STALE_AFTER_MS;
  if (!view.visible) return null;

  const boardSize = room.board_size;
  // Names hold until the board has finished being dealt, exactly as the players' own board does -
  // see lib/overlayReveal.ts. A viewer must not be able to read the squares off a source while the
  // match is still being set up.
  const revealed = squaresRevealed(room.status, battlePhase);
  const teams = activeTeams(state.players);
  const faces = facesForRoom(room.id, boardSize * boardSize, room.square_set, room.seed, room.custom_square_set);
  const challenges = state.face === 0 ? faces.light : faces.dark;
  const shown = typeof view.mode === "number" ? teams.filter((t) => t === view.mode) : teams;

  /**
   * The claims this source is showing.
   *
   * `view.mode` narrows to one team where the caster has picked one, which is the only thing left of
   * what used to be a whole reveal protocol: Battleship's desk pushed each fleet's SHIP POSITIONS
   * down the cast channel, because that was the one thing a spectating overlay could not read for
   * itself. Nothing here is unreadable, so the channel now carries framing - zoom, centre, opacity,
   * which team to isolate - and nothing that could leak.
   */
  const relevant = shown.length === teams.length
    ? state.claims
    : state.claims.filter((c) => shown.includes(c.team));

  const visuals = cellVisuals(relevant);
  const owners = cellOwners(relevant);
  const cellVisual = (index: number): CellVisual => visuals.get(index) ?? "empty";

  // Whose square each one is, as a ring in that team's colour - drawn on top of the fill so a
  // square held by two teams under non-lockout still says who, at broadcast distance.
  const ringedBy = new Map(
    [...owners].map(([cell, ts]) => [cell, ts.map(teamHex)] as [number, string[]])
  );

  const flipCells = new Set((room.flip_cells ?? []).filter((c) => !owners.has(c)));

  // Square as big as the shorter side of the source, then multiplied by the zoom. A board is
  // square, so a wide source simply leaves margin either side at 1x - see the size note on the
  // control page.
  const fit = frame.w > 0 ? Math.min(frame.w, frame.h) : SOURCE_SIZE;
  const boardPx = Math.round(fit * view.zoom);

  return (
    <div
      className={`ovb-frame ovb-board${view.coords ? "" : " ovb-no-coords"}`}
      ref={frameRef}
      // Board size as a CSS variable so the stylesheet can recompute the cell font from the real
      // board size - BoardGrid's own figure is capped at 1600px. See OverlayBoard.css.
      // --ovb-text carries the same multiplier the names get to the COORDINATE labels, which are
      // plain CSS rather than fitted per square and so can't take it as a prop.
      style={{ ["--ovb-cells" as string]: boardSize, ["--ovb-text" as string]: textSize }}
    >
      {/* Opacity lives on the STAGE, not the frame: the stale badge and the debug readout are
          diagnostics about the source itself, and fading them along with the board would make a
          frozen board hardest to notice exactly when it has been left faint and forgotten.
          `?? 1` because a frame from a controller predating this field carries no opacity at all. */}
      {/* data-face is what turns the stream board over. The face tokens are re-pointed by this
          attribute (see index.css), so the whole board goes from Erdtree gold to Shadow ember on a
          flip without the source being told anything - it derives the face from the claim log like
          every other client. A caster does not have to drive it, and cannot forget to. */}
      <div
        className="ovb-stage"
        ref={stageRef}
        data-face={state.face}
        style={{
          left: placeBoard(stage.w, frame.w, view.cx),
          top: placeBoard(stage.h, frame.h, view.cy),
          opacity: view.opacity ?? 1,
        }}
      >
        <BoardGrid
          boardSize={boardSize}
          cellVisual={cellVisual}
          cellOwners={owners}
          flipCells={flipCells}
          // Who fired at each square, in that fleet's colour. Always on: a composited board that
          // cannot say whose shot a square was is only half a board, and it is not a setting anybody
          // would want to reach for mid-match. See attackerTeamsByCell.
          ringedBy={ringedBy}

          // All four edges: a viewer can't point at the screen, and on a zoomed board the top-left
          // labels are often outside the frame entirely.
          coordEdges="all"
          // Both bounds the same, because BoardGrid resolves min(maxVh, maxVw, 1600px) to a square.
          maxVh={`${boardPx}px`}
          maxVw={`${boardPx}px`}
          // Legibility for a viewer, not for the person at the keyboard - see the two notes above.
          textBoost={textSize}
          maxCellFont={OVERLAY_MAX_FONT}
          cellText={
            view.names && revealed
              ? (i) => {
                  const c = challenges[i];
                  if (!c) return null;
                  // Region and colour included so the stream tints squares exactly as the players'
                  // own boards do - the key along the bottom of their screen reads true here too.
                  return { label: c.short ?? c.name, region: c.region, color: c.color };
                }
              : undefined
          }
        />
      </div>

      {/* Deliberately visible ON STREAM rather than only in the control page. A frozen board that
          looks live is the failure that actually costs a caster something, and the person who can
          fix it is the one looking at the stream. */}
      {stale && <div className="ovb-stale">board control disconnected</div>}

      {/*
        ?debug=1 - the numbers this layout is actually built from.
        Sizing here depends on measurements only the browser can make, and reasoning about them from
        the outside has been wrong repeatedly. `frame` is the source, `board` is what the grid really
        rendered as, `want` is what was asked for: if frame isn't the source's real pixel size, or
        board doesn't track want, that says which end is broken without another round of guessing.
      */}
      {debug && (
        <div className="ovb-debug">
          frame {Math.round(frame.w)}x{Math.round(frame.h)} · board {Math.round(stage.w)}x
          {Math.round(stage.h)} · want {boardPx} · zoom {view.zoom.toFixed(2)} · offset{" "}
          {Math.round(placeBoard(stage.w, frame.w, view.cx))},{Math.round(placeBoard(stage.h, frame.h, view.cy))} ·
          centre {view.cx.toFixed(2)},{view.cy.toFixed(2)}
        </div>
      )}
    </div>
  );
}
