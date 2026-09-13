import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useRoom } from "../hooks/useRoom";
import { activeTeams } from "../lib/teams";
import { cellVisuals, cellOwners } from "../lib/cellVisuals";
import { cellLabel, scoreFor } from "../lib/flipLogic";
import { facesForRoom } from "../lib/challenges";
import { feedEntries } from "../lib/claimFeed";
import {
  DEFAULT_BONUS_PER_BINGO,
  DEFAULT_WIN_CONDITION,
  FACE_LABELS,
  defaultTargetScore,
  type WinCondition,
} from "../types/bingoFlip";
import { teamName, teamHex } from "../lib/teamColors";
import { formatRoomCode } from "../lib/roomCode";
import { BoardGrid, type CellVisual } from "../components/BoardGrid";
import { useBoxSize } from "../hooks/useBoxSize";
import { SourceRow } from "../components/SourceRow";
import { SOURCE_SIZE, placeBoard } from "../lib/overlayBoardLayout";
import { squaresRevealed } from "../lib/overlayReveal";
import { useBattlePhaseName, useBattleClock } from "../hooks/useBattlePhase";
import { useFlipOdds } from "../hooks/useFlipOdds";
import { OddsPanel } from "../components/OddsPanel";
import { formatDuration } from "../lib/matchTime";
import { useCastScreens } from "../hooks/useCastScreens";
import { useCasterAux } from "../lib/castAux";
import {
  useCastPublisher,
  DEFAULT_VIEW,
  MIN_ZOOM,
  MAX_ZOOM,
  MIN_OPACITY,
  type CastView,
} from "../lib/overlayCast";
import type { BoardFace } from "../types/bingoFlip";
import "./CasterControl.css";
import "./OverlayBoard.css";
import "../components/BoardGrid.css";

/** On-screen size of the 1:1 monitor. The viewport inside it is always SOURCE_SIZE. */
const PREVIEW_PX = 420;

/**
 * How far the pointer may travel and still count as a click rather than a drag.
 *
 * The monitor is both a thing you drag and (while spotting) a thing you click, and a mouse never
 * stays perfectly still between press and release. Generous enough to absorb a hand on a trackpad,
 * small enough that a deliberate pan is never mistaken for a point.
 */
const CLICK_SLOP = 4;

/**
 * Which square is under a point on screen, asked of the DOM rather than computed.
 *
 * The arithmetic version of this is available and wrong: the rendered board is never exactly
 * `cells x cellSize` once the coordinate gutters, the grid gaps and the borders are counted, and
 * the monitor is additionally inside a `scale()` transform. `getBoundingClientRect` reports the
 * post-transform box the caster is actually looking at, so walking the cells and asking which one
 * contains the point is exact by construction.
 *
 * Deliberately not `elementFromPoint`: the cells sit under BoardGrid's own marker layer, and
 * hit-testing would make this depend on that layer's `pointer-events` staying `none`.
 */
function cellAtPoint(root: HTMLElement, x: number, y: number): number | null {
  for (const el of root.querySelectorAll<HTMLElement>("[data-cell]")) {
    const r = el.getBoundingClientRect();
    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) {
      const n = Number(el.dataset.cell);
      return Number.isInteger(n) ? n : null;
    }
  }
  return null;
}

/**
 * The aim pad, in reading order: glyph, x, y, and the key that does the same thing.
 *
 * Kept in keypad order rather than in any other arrangement, because the whole point is that the
 * button under the mouse and the key under the finger are in the same place.
 */
const PAD: Array<[string, number, number, string]> = [
  ["↖", -1, -1, "7"],
  ["↑", 0, -1, "8"],
  ["↗", 1, -1, "9"],
  ["←", -1, 0, "4"],
  ["•", 0, 0, "5"],
  ["->", 1, 0, "6"],
  ["↙", -1, 1, "1"],
  ["↓", 0, 1, "2"],
  ["↘", 1, 1, "3"],
];

/**
 * The caster's desk: drives the /overlay-board browser source live.
 *
 * Everything here is one screen on a second monitor, operated while talking. That shapes it more
 * than anything else does - the view buttons are large and always in the same place, nothing is
 * behind a menu, and the preview is aimed by dragging it, because a caster following the action
 * across a board is doing one continuous motion rather than a series of decisions.
 *
 * What it sends is framing and nothing else: zoom, centre, opacity, which team to isolate. The
 * browser source reads the board from the database itself, exactly as every other client does,
 * because there is nothing on a bingo board it would need this page's session to see. See
 * lib/overlayCast.ts.
 */
export function CasterControl() {
  const { code } = useParams<{ code: string }>();
  const state = useRoom(code);
  const { publish, ready } = useCastPublisher(code);

  const [view, setView] = useState<CastView>({ ...DEFAULT_VIEW, names: true });
  const [stageRef, stage] = useBoxSize<HTMLDivElement>();
  /** Where the gesture started, and the centre it started from. Null when nothing is being dragged. */
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  // Only to suppress the board's own glide while a drag is live - see .cast-dragging.
  const [dragging, setDragging] = useState(false);
  /**
   * Point-at-a-square mode: the monitor stops being only a thing you drag and starts being a thing
   * you click. A mode rather than a modifier because a caster is doing this one-handed while
   * talking - "hold this key and click" is two things to remember under load. Armed, a CLICK
   * spotlights and a DRAG still pans - see the pointer handlers, which tell them apart by distance
   * travelled.
   */
  const [spotting, setSpotting] = useState(false);
  /** Where the pointer went down, so a click can be told from a drag. Null between gestures. */
  const downAt = useRef<{ x: number; y: number } | null>(null);

  const room = state.room;
  // Drives the reveal gate below: names hold until the board has finished being dealt.
  const battlePhase = useBattlePhaseName(state.claims, room);
  const matchClock = useBattleClock(state.claims, room);
  const teams = useMemo(() => activeTeams(state.players), [state.players]);
  // The desk's own read of lib/flipOdds - with the history line, since this is the one screen with
  // room to show it and a reason to want it. See components/OddsPanel and pages/OverlayOdds for the
  // standalone source this shares its model with.
  const { snapshot: odds, timeline: oddsTimeline } = useFlipOdds(state.claims, room, state.players, true);
  /** The player-stream boxes and how far behind each is running - see lib/castAux. */
  const aux = useCasterAux(code);
  const screens = useCastScreens(state.players);

  /**
   * Nothing goes down the wire but framing.
   *
   * A bingo board hides nothing, so the cast channel now carries zoom, centre, opacity and which
   * team to isolate - and there is nothing on it that could leak if it went to the wrong place.
   */
  useEffect(() => {
    publish({ view });
  }, [publish, view]);

  /**
   * Moves the frame, in whole steps or fine nudges. Shared by the keyboard and the on-screen pad.
   *
   * A JUMP is a quarter of everything the zoom can reach: FOUR presses cross from one edge to the
   * opposite one, two from the middle to an edge, at any zoom. `1 - 1/zoom` is that whole pannable
   * span - at 2x the frame holds half the board, so the centre point ranges over the other half -
   * and the step is a quarter of it. At 1x the span is zero and nothing moves, correctly: the whole
   * board is already in frame.
   *
   * It was /8 first, on the reading that four presses meant centre-to-corner. That put a press at
   * an eighth of the pannable range - about two thirds of one square at 2x - which does not read as
   * a step at all. You had to hold the key down to see anything happen, which is the definition of
   * a nudge, and the arrows are already the nudge.
   *
   * A NUDGE is 6% of the FRAME, for following something that shifted a square or two. Measured
   * against the frame so it moves the same visible distance at every zoom; as a flat fraction of
   * the board it was a crawl at 1.2x and a lurch at 2x.
   */
  const panBy = useCallback((dx: number, dy: number, mode: "jump" | "nudge") => {
    setView((v) => {
      const step = mode === "jump" ? (1 - 1 / v.zoom) / 4 : 0.06 / v.zoom;
      return {
        ...v,
        cx: Math.min(1, Math.max(0, v.cx + dx * step)),
        cy: Math.min(1, Math.max(0, v.cy + dy * step)),
      };
    });
  }, []);

  const recentre = useCallback(() => setView((v) => ({ ...v, cx: 0.5, cy: 0.5 })), []);

  /**
   * Two keyboards' worth of aiming, for two different jobs.
   *
   * ARROWS nudge: 6% of the frame, for following something that moved a square or two.
   *
   * NUMBER KEYS step: in all eight directions, laid out the way a keypad is - 8 up, 2 down, 4/6
   * across, 7/9/1/3 diagonal, 5 back to the middle. The keypad stops being a set of directions and
   * becomes a map of the board, which is worth a great deal to somebody aiming it without looking
   * down. Distances are panBy's; see there.
   *
   * BOTH the numpad and the number ROW, by design. The keypad shape is what makes this good, but
   * plenty of casters are on a laptop or a tenkeyless board and have no numpad at all - and nothing
   * else on this page wants the digits, so there is no reason to make owning one a requirement. The
   * on-screen pad beside the zoom does the same job for a mouse.
   *
   * Matched on `e.code`, not `e.key`. With NumLock off the numpad reports Home/PageUp/ArrowLeft and
   * a caster is not going to check their NumLock light mid-match; `code` is the physical key
   * either way. It also means the top row works on layouts where those digits need a modifier.
   *
   * Ignored while typing in the URL boxes.
   */
  useEffect(() => {
    /** Unit vectors, x then y, screen-style (y grows downward). */
    const ARROWS: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const KEYPAD: Record<string, [number, number]> = {
      "7": [-1, -1],
      "8": [0, -1],
      "9": [1, -1],
      "4": [-1, 0],
      "6": [1, 0],
      "1": [-1, 1],
      "2": [0, 1],
      "3": [1, 1],
    };
    /** "Numpad7" and "Digit7" both mean 7 here; anything else means nothing. */
    const digitOf = (code: string) =>
      code.startsWith("Numpad") ? code.slice(6) : code.startsWith("Digit") ? code.slice(5) : "";

    /**
     * Is the caster typing, or merely focused on something?
     *
     * This used to bail on ANY input element, which quietly broke the whole keyboard: setting the
     * zoom leaves focus on the slider, so every key pressed after touching it was swallowed - and
     * setting the zoom is precisely what you do immediately before wanting to aim. Only a field
     * that eats text should block the aiming keys; a range slider or a checkbox should not.
     */
    function isTyping(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      if (!el) return false;
      if (el.isContentEditable) return true;
      if (el.tagName === "TEXTAREA") return true;
      if (el.tagName !== "INPUT") return false;
      const type = (el as HTMLInputElement).type;
      return !["range", "checkbox", "radio", "button", "submit", "reset", "color"].includes(type);
    }

    function onKey(e: KeyboardEvent) {
      if (isTyping(e.target)) return;

      const digit = digitOf(e.code);

      // The middle key means the middle of the board. Nothing else it could sensibly do, and it
      // saves reaching for the Fit button when the zoom itself is fine.
      if (digit === "5") {
        e.preventDefault();
        recentre();
        return;
      }

      const jump = KEYPAD[digit];
      const nudge = ARROWS[e.key];
      if (!jump && !nudge) return;
      e.preventDefault();

      const [dx, dy] = jump ?? nudge;
      panBy(dx, dy, jump ? "jump" : "nudge");
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panBy, recentre]);

  if (!room) {
    return (
      <div className="panel stack" style={{ width: "min(460px, 100%)" }}>
        <h2 style={{ margin: 0 }}>No such room</h2>
        <p className="muted" style={{ margin: 0 }}>
          {code ? formatRoomCode(code) : "That room"} isn't open. The control page follows a live
          room, so there's nothing to drive yet.
        </p>
        <Link to="/">Return to the round table</Link>
      </div>
    );
  }

  const boardSize = room.board_size;
  const faces = facesForRoom(room.id, boardSize * boardSize, room.square_set, room.seed, room.custom_square_set);
  // A peek outranks the match's real face for which NAMES the monitor (and the driven source) show -
  // see `previewFace` on CastView. Ownership is untouched: a peek changes what an unclaimed square is
  // called, never who holds it.
  const shownFace = view.previewFace ?? state.face;
  const challenges = shownFace === 0 ? faces.light : faces.dark;
  const peeking = view.previewFace !== null && view.previewFace !== state.face;
  /** Whether the squares may be named yet - see lib/overlayReveal.ts. */
  const revealed = squaresRevealed(room.status, battlePhase);

  const shownTeams = typeof view.mode === "number" ? teams.filter((t) => t === view.mode) : teams;

  // Exactly the derivation the source makes - the monitor and the board it is driving have to read a
  // square the same way, or the caster is aiming something other than what goes out.
  const relevant =
    shownTeams.length === teams.length
      ? state.claims
      : state.claims.filter((c) => shownTeams.includes(c.team));
  const visuals = cellVisuals(relevant);
  const owners = cellOwners(relevant);
  const cellVisual = (index: number): CellVisual => visuals.get(index) ?? "empty";
  const ringedBy = new Map(
    [...owners].map(([cell, ts]) => [cell, ts.map(teamHex)] as [number, string[]])
  );
  const flipCells = new Set((room.flip_cells ?? []).filter((c) => !owners.has(c)));
  const winCondition = (room.win_condition ?? DEFAULT_WIN_CONDITION) as WinCondition;
  const bonusPerBingo = room.bonus_per_bingo ?? DEFAULT_BONUS_PER_BINGO;
  const targetScore = room.target_score ?? defaultTargetScore(room.board_size);
  const flipsLeft = flipCells.size;
  const recent = feedEntries(state.claims, state.players, [faces.light, faces.dark]).slice(0, 8);

  // Identical to the source's own sizing, because the monitor IS the source at display scale.
  const boardPx = Math.round(SOURCE_SIZE * view.zoom);

  /**
   * Panning, as grabbing the picture and sliding it.
   *
   * -- Why this replaced "centre on the point under the cursor" --
   *
   * The old version read the pointer's position and made THAT board point the new centre. Held
   * still, it should have been a no-op; in fact it was a feedback loop, because centring on a point
   * moves the board, which puts a different point under the same stationary cursor, which becomes
   * the next centre. At 2x a cursor parked a quarter of the way across walked the view to the far
   * edge in three or four moves - each one a visible jump, and the reason panning read as snapping
   * between quadrants rather than sliding.
   *
   * Measuring the pointer's TRAVEL instead has no such loop: the delta is against a fixed origin
   * captured at pointerdown, so the same cursor position always means the same view. It is also 1:1
   * in board pixels - move the mouse an inch, the board moves an inch - which is the property that
   * makes a pan feel like dragging rather than steering.
   *
   * Direction: the board follows the cursor (drag right, the board goes right and you see what was
   * off to the left), which is what every map does and what "grab" implies.
   */
  function panTo(e: { clientX: number; clientY: number }) {
    const start = drag.current;
    if (!start || stage.w <= 0 || stage.h <= 0) return;
    // Preview px -> the source's logical px -> a fraction of the whole board.
    const scale = PREVIEW_PX / SOURCE_SIZE;
    const dx = (e.clientX - start.x) / scale / stage.w;
    const dy = (e.clientY - start.y) / scale / stage.h;
    setView((v) => ({
      ...v,
      cx: Math.min(1, Math.max(0, start.cx - dx)),
      cy: Math.min(1, Math.max(0, start.cy - dy)),
    }));
  }

  const set = (patch: Partial<CastView>) => setView((v) => ({ ...v, ...patch }));

  const origin = `${window.location.origin}${import.meta.env.BASE_URL}`;
  const boardUrl = `${origin}#/overlay-board/${room.code}`;
  const timerUrl = `${origin}#/overlay-timer/${room.code}`;
  const keyUrl = `${origin}#/overlay-key/${room.code}`;
  // No team on the caster's copy: with none, the closing sting is the spectator's - somebody was
  // left standing, which is the interesting fact from the desk. See pages/OverlayAudio.
  const audioUrl = `${origin}#/overlay-audio/${room.code}`;
  const oddsUrl = `${origin}#/overlay-odds/${room.code}`;

  // The square under the crosshair, for the readout. Clamped the same way the pan is.
  const framed = (c: number) => Math.min(boardSize - 1, Math.max(0, Math.floor(c * boardSize)));
  const centreCell = framed(view.cy) * boardSize + framed(view.cx);
  const zoomed = view.zoom > 1;

  return (
    <div className="cast">
      <div className="cast-head">
        <h2 style={{ margin: 0 }}>Board control - {formatRoomCode(room.code)}</h2>
        <span className={`cast-status${ready ? " cast-status-live" : ""}`}>
          {ready ? "connected" : "connecting..."}
        </span>
        {/* The monitor below is a true 1:1 of a 1000x1000 source, so there is nothing left to
            report back and nothing to be out of step with. */}
        <span className="cast-status">
          monitor {SOURCE_SIZE}x{SOURCE_SIZE}
        </span>
        <Link to={`/room/${room.code}`} style={{ fontSize: "0.85rem" }}>
          Back to the room
        </Link>
      </div>

      {/* The face, and how many turns the board has left in it. The one piece of match state a
          caster genuinely cannot read off the board in front of them at a glance, and the one most
          likely to be the next thing they have to say out loud. */}
      <div className="panel row" style={{ gap: "0.9rem", alignItems: "baseline", fontSize: "0.9rem" }} data-face={shownFace}>
        <strong style={{ color: "var(--board-glow)", letterSpacing: "0.1em" }}>
          {FACE_LABELS[shownFace]} side
        </strong>
        <span className="muted">
          {flipsLeft === 0 ? "board is settled" : `${flipsLeft} flip square${flipsLeft === 1 ? "" : "s"} left`}
        </span>
        {/* Peek: look at the other face's objectives without touching the match. Nothing on a
            bingo board is hidden, so this is safe to leave on stream - see `previewFace`. It only
            ever changes which NAMES the unclaimed squares show; ownership never moves. */}
        <div className="row" style={{ gap: "0.25rem" }} title="Look at a face's objectives without changing the match">
          {(["live", 0, 1] as const).map((f) => {
            const active = f === "live" ? view.previewFace === null : view.previewFace === f;
            return (
              <button
                key={String(f)}
                className={active ? "primary" : ""}
                style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem" }}
                onClick={() => set({ previewFace: f === "live" ? null : (f as BoardFace) })}
              >
                {f === "live" ? "Live" : FACE_LABELS[f]}
              </button>
            );
          })}
        </div>
        {peeking && (
          <span className="muted" style={{ fontSize: "0.78rem" }}>
            peeking - the match is still on {FACE_LABELS[state.face]}
          </span>
        )}
        {/* The number a caster calls out. Under points that is the score against the target, not
            the square count - a team can be behind on squares and ahead on the board, and the desk
            saying the wrong one is how a cast ends up narrating the wrong race. */}
        {teams.map((t) => {
          const scored = scoreFor(state.claims, room.board_size, t, bonusPerBingo);
          return (
            <span key={t} style={{ color: teamHex(t) }}>
              {teamName(t)}{" "}
              {winCondition === "points" ? `${scored.score}/${targetScore}` : scored.squares}
            </span>
          );
        })}
      </div>

      <div className="cast-body">
        {/* Pinned to the monitor's own width, from the same constant that sizes it. Without this the
            column is as wide as its WIDEST child - and one of those children is a line of text that
            changes with every square the crosshair crosses, so panning made this column breathe in
            and out and shoved the controls beside it back and forth. See .cast-hint. */}
        <div className="cast-preview-wrap" style={{ width: PREVIEW_PX }}>
          {/* Drag to slide the stream view around; the wheel zooms. Both act on the same point
              under the cursor, so following the action is one gesture rather than a set of decisions. */}
          <div
            className={`cast-preview${dragging ? " cast-dragging" : ""}${spotting ? " cast-spotting" : ""}`}
            style={{ width: PREVIEW_PX, height: PREVIEW_PX }}
            onPointerDown={(e) => {
              downAt.current = { x: e.clientX, y: e.clientY };
              drag.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy };
              setDragging(true);
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!drag.current) return;
              // While spotting, hold the view still until the gesture has committed to being a
              // drag - otherwise the jitter between press and release on a click pans the board a
              // pixel or two, and "point at D3" also nudges the stream.
              if (spotting && downAt.current) {
                const dx = Math.abs(e.clientX - downAt.current.x);
                const dy = Math.abs(e.clientY - downAt.current.y);
                if (dx <= CLICK_SLOP && dy <= CLICK_SLOP) return;
              }
              panTo(e);
            }}
            onPointerUp={(e) => {
              const from = downAt.current;
              const root = e.currentTarget;
              drag.current = null;
              downAt.current = null;
              setDragging(false);
              root.releasePointerCapture(e.pointerId);
              if (!spotting || !from) return;
              if (Math.abs(e.clientX - from.x) > CLICK_SLOP || Math.abs(e.clientY - from.y) > CLICK_SLOP) return;
              const cell = cellAtPoint(root, e.clientX, e.clientY);
              setView((v) => {
                // Clicking the lit square again puts the light out - the gesture everyone tries
                // first, and the only way to clear it without reaching for another control.
                const lit = v.spot?.length === 1 && v.spot[0] === cell;
                return { ...v, spot: cell === null || lit ? null : [cell], spotColor: null };
              });
            }}
            onPointerCancel={() => {
              drag.current = null;
              downAt.current = null;
              setDragging(false);
            }}
            onWheel={(e) => {
              // 0.1 a notch over a range that is now only 1x to 2x - a quarter-step would be a
              // quarter of the whole range, which is a jump rather than a zoom.
              const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom + (e.deltaY < 0 ? 0.1 : -0.1)));
              set({ zoom: Math.round(next * 100) / 100 });
            }}
            title="Drag to slide the stream view · wheel to zoom · 1-9 to step (4 presses edge to edge) · arrows to nudge"
          >
            {/*
              A 1:1 monitor, not a diagram of one.

              This viewport is exactly the source's 1000x1000, laid out by the same code, and then
              scaled down purely for display. So what a caster drags is literally the broadcast
              frame - no predicted rectangle, no reported source aspect, no second calculation to
              drift out of step with the first. Every one of those existed only to approximate the
              thing we can just show.
            */}
            <div
              className={`ovb-board cast-viewport${view.coords ? "" : " ovb-no-coords"}`}
              style={{
                width: SOURCE_SIZE,
                height: SOURCE_SIZE,
                transform: `scale(${PREVIEW_PX / SOURCE_SIZE})`,
                ["--ovb-cells" as string]: boardSize,
              }}
            >
              <div
                className="ovb-stage"
                ref={stageRef}
                style={{
                  left: placeBoard(stage.w, SOURCE_SIZE, view.cx),
                  top: placeBoard(stage.h, SOURCE_SIZE, view.cy),
                  // The monitor has to show the fade too, or the caster is judging legibility
                  // against a board that is more solid than the one on stream.
                  opacity: view.opacity,
                }}
              >
                <BoardGrid
                  boardSize={boardSize}
                  cellVisual={cellVisual}
                  cellOwners={owners}
                  flipCells={flipCells}
                  ringedBy={ringedBy}
                  spotCells={view.spot ? new Set(view.spot) : undefined}
                  spotColor={view.spotColor ?? undefined}
                  // Matches the source exactly - the monitor has to BE the frame, not resemble it.
                  coordEdges="all"
                  maxVh={`${boardPx}px`}
                  maxVw={`${boardPx}px`}
                  cellText={
                    // The monitor has to BE the frame, and the source itself holds the names back
                    // until the match starts - so this does too, or the desk shows a board the
                    // stream isn't. It also keeps /cast from being a way round that rule: the page
                    // is linked publicly from the spectator bar. See lib/overlayReveal.ts.
                    view.names && revealed
                      ? (i) => {
                          const c = challenges[i];
                          if (!c) return null;
                          return { label: c.short ?? c.name, region: c.region, color: c.color };
                        }
                      : undefined
                  }
                />
              </div>
            </div>

            {/*
              What "Hide board" looks like from the desk.

              It used to look like nothing at all: the button changed, the monitor didn't, and the
              only way to know the board had left the stream was to go and look at the stream. A
              board hidden and then forgotten is a scene with a hole in it, so the monitor says so
              plainly.
            */}
            {!view.visible && <div className="cast-hidden-veil">Hidden on stream</div>}
          </div>
          <span className="muted cast-hint">
            Drag to slide · wheel to zoom · <strong>1-9</strong> (numpad or top row) step in 8
            directions, 4 presses edge to edge, 5 recentres · arrows nudge. On stream:{" "}
            <strong>
              {zoomed ? `${view.zoom.toFixed(1)}x around ${cellLabel(centreCell, boardSize)}` : "the whole board"}
            </strong>
            {/* The square under the crosshair, named in full - a caster reads this out, and the
                board itself only ever shows the shortened form. */}
            {zoomed && challenges[centreCell] && <> - {challenges[centreCell].name}</>}
          </span>
        </div>

        <div className="cast-panel">
          <section>
            <h3>View</h3>
            <div className="cast-buttons">
              {/* Two buttons became one. "Results only" meant "shots but no ship positions" - the
                  safe setting for a board that would otherwise leak a fleet's layout on stream - and
                  with nothing hidden on a bingo board it named the identical picture to "All". */}
              <button
                className={view.mode === "all" ? "primary" : ""}
                onClick={() => set({ mode: "all" })}
                title="Every team's squares on the one board"
              >
                All teams
              </button>
              {teams.map((t) => (
                <button
                  key={t}
                  className={view.mode === t ? "primary" : ""}
                  onClick={() => set({ mode: t })}
                  style={{ color: teamHex(t) }}
                  title={`Only ${teamName(t)}'s squares`}
                >
                  {teamName(t)}
                </button>
              ))}
            </div>
            {/* The warning that lived here said "ships are on stream during a live match - your
                call, just don't leave it up over a break". There are no ships and nothing on this
                board is a spoiler, so there is nothing left to caution anybody about. */}
          </section>

          {/*
            The spotlight: what the caster is pointing at. A stream viewer cannot follow a finger
            on a monitor, so "the one at D4" otherwise has no picture attached to it.
          */}
          <section>
            <h3>Spotlight</h3>
            <label className="cast-check">
              <input type="checkbox" checked={spotting} onChange={(e) => setSpotting(e.target.checked)} />
              <span>Click the board to point at a square</span>
            </label>
            <div className="cast-buttons">
              <button
                disabled={!view.spot?.length}
                onClick={() => set({ spot: null, spotColor: null })}
                title="Put the light out"
              >
                Clear spotlight
              </button>
              {view.spot?.length === 1 && challenges[view.spot[0]] && (
                <span className="muted" style={{ fontSize: "0.82rem", alignSelf: "center" }}>
                  {cellLabel(view.spot[0], boardSize)} - {challenges[view.spot[0]].name}
                </span>
              )}
            </div>
            <p className="cast-note muted">
              With this on, a click points and a drag still pans. Click the lit square again to
              clear it.
            </p>
          </section>

          <section>
            <h3>Zoom</h3>
            <div className="cast-row">
              <input
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={0.1}
                value={view.zoom}
                onChange={(e) => set({ zoom: Number(e.target.value) })}
              />
              <span className="cast-zoom-value">{view.zoom.toFixed(1)}x</span>
              <button onClick={() => set({ zoom: 1, cx: 0.5, cy: 0.5 })} title="Show the whole board">
                Fit
              </button>
            </div>

            {/*
              The keypad, on screen.

              Laid out exactly as the keys are, so it doubles as the documentation for them - and it
              means aiming doesn't depend on owning a numpad, which a laptop or a tenkeyless board
              doesn't have. Disabled at 1x rather than hidden: at that zoom the whole board is in
              frame and there is genuinely nowhere to pan, and a control that greys out says that
              far better than one that silently does nothing.
            */}
            <div className="cast-pad" role="group" aria-label="Aim the stream view">
              {PAD.map(([label, dx, dy, key]) => (
                <button
                  key={key}
                  className="cast-pad-key"
                  disabled={view.zoom <= MIN_ZOOM}
                  onClick={() => (dx === 0 && dy === 0 ? recentre() : panBy(dx, dy, "jump"))}
                  title={
                    view.zoom <= MIN_ZOOM
                      ? "Zoom in first - at 1x the whole board is already in frame"
                      : `${dx === 0 && dy === 0 ? "Recentre" : "Step"} - keyboard ${key}`
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          {/*
            Square names and coordinates used to be toggles here and are now simply always on.
            Neither was a decision anybody wanted to make mid-match: the names are the entire reason
            the zoom exists, and the coordinates are how a caster says where something is. Turning
            either off leaves a board that can only be talked about by pointing at it, which is the
            one thing a stream cannot do. (Both remain as ?names=0 / ?coords=0 on a pinned source,
            for a player running the board very small - see pinnedView.)
          */}
          {/* The last few squares to change hands, with the turns called out.
              This is the panel that gives a caster a reason to look up - and the flip is the thing
              they most need telling about, because a board that turns while they are mid-sentence
              has just rewritten every objective they were about to name. The records panel that
              used to sit here returns with the stats layer. */}
          {recent.length > 0 && (
            <section>
              <h3>Just claimed</h3>
              <div className="stack" style={{ gap: "0.15rem", fontSize: "0.82rem" }}>
                {recent.map((entry) => (
                  <div key={entry.key} className="row" style={{ gap: "0.4rem", alignItems: "baseline" }}>
                    <span className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {cellLabel(entry.cellIndex, boardSize)}
                    </span>
                    <strong style={{ color: teamHex(entry.team) }}>{entry.who}</strong>
                    <span style={{ minWidth: 0 }}>{entry.objective}</span>
                    {entry.flipped && (
                      <span style={{ color: "var(--board-glow)", marginLeft: "auto", fontWeight: 600 }}>
                        FLIPPED
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <h3>Board</h3>
            <div className="cast-buttons">
              <button
                className={view.visible ? "" : "danger"}
                onClick={() => set({ visible: !view.visible })}
                title="Blank the board source without removing it from the scene"
              >
                {view.visible ? "Hide board" : "Board hidden"}
              </button>
            </div>
          </section>

          {/*
            Fading the board is the middle setting between "up" and "gone", and it is the one that
            gets used: a caster wants to leave the board on screen through a boss fight rather than
            pulling it in and out every thirty seconds, and at half strength the squares still read
            while the fight underneath stays watchable. Hiding it outright is still there for the
            moments that need the screen back completely.
          */}
          <section>
            <h3>Transparency</h3>
            <div className="cast-row">
              <input
                type="range"
                min={MIN_OPACITY}
                max={1}
                step={0.05}
                value={view.opacity}
                onChange={(e) => set({ opacity: Number(e.target.value) })}
                title="How solid the board is on stream"
              />
              <span className="cast-zoom-value">{Math.round(view.opacity * 100)}%</span>
              <button onClick={() => set({ opacity: 1 })} title="Back to a solid board">
                Solid
              </button>
            </div>
            <p className="cast-note muted">
              The monitor above shows the same fade. It sits on this page's background rather than
              on gameplay, so judge it generously - footage underneath is busier than this is.
            </p>
          </section>

          {/*
            The evaluation bar, live on the desk - see lib/flipOdds. A caster reads this to decide
            whether a swing is worth calling out loud, without having to bring the standalone
            source up on a monitor of their own to check.
          */}
          <section>
            <h3>Odds</h3>
            <div style={{ width: "100%", height: "220px", position: "relative" }}>
              <OddsPanel
                snapshot={odds}
                points={oddsTimeline}
                elapsed={matchClock?.phase === "match" ? formatDuration(matchClock.matchElapsed) : "--:--"}
                showGraph
              />
            </div>
            <p className="cast-note muted">
              Each team's chance of winning from here, replayed the same way for everyone watching -
              see the standalone Odds source below to bring it up on stream.
            </p>
          </section>

          {/*
            The player streams: a box per seat, and a way to kick one that's drifted. See
            lib/castAux for the resync/latency channel and pages/OverlayScreen for the box itself.
          */}
          {screens.length > 0 && (
            <section>
              <h3>Player streams</h3>
              <div className="cast-buttons">
                <button onClick={() => aux.resync()} title="Reload every player stream at once">
                  Resync all
                </button>
              </div>
              <div className="cast-screens">
                {screens.map((s) => {
                  const ms = aux.latencies.get(s.slot);
                  return (
                    <div className="cast-screen-row" key={s.slot}>
                      <span className="cast-screen-name" style={{ color: teamHex(s.team) }}>
                        {s.name ?? teamName(s.team)}
                      </span>
                      <span className="cast-screen-lat">
                        {ms === undefined ? "-" : `${(ms / 1000).toFixed(1)}s behind`}
                      </span>
                      <button className="cast-screen-resync" onClick={() => aux.resync(s.slot)} title="Reload just this stream">
                        resync
                      </button>
                    </div>
                  );
                })}
              </div>
              <p className="cast-note muted">
                Latency is read from each box every few seconds - a seat with no linked Twitch shows
                a name plate and no reading. If one stream drifts on its own, add a{" "}
                <strong>Render Delay</strong> filter to that Screen source in OBS to nudge it back.
              </p>
            </section>
          )}

          <section>
            <h3>Browser sources</h3>
            <p className="muted cast-note">
              Add each as a Browser Source in OBS. The board follows this page; the timer and the
              colour key run on their own and need nothing.
            </p>
            <SourceRow label="Board" url={boardUrl} size="1000 x 1000" note="square - the board fits the shorter side" />
            <SourceRow
        label="Clock"
        url={timerUrl}
        size="1200 x 200"
        note="the clock, every team's squares, and which face is up"
      />
            {/* Sized for the full width of a 1080p canvas, because that is where it goes - a strip
                along the bottom edge. It scales down to whatever it's given, so the number is a
                starting point rather than a requirement. */}
            <SourceRow
              label="Key"
              url={keyUrl}
              size="1920 x 90"
              note="a thin strip for the bottom edge - add ?plate=0 for no backing"
            />
            {/* Nothing to look at and nothing to aim, so it takes no frame from this page at all -
                it reads the room directly, exactly as the clock and the key do. */}
            <SourceRow
              label="Audio"
              url={audioUrl}
              size="100 x 100"
              note="the match's sound - no picture. Tick 'Control audio via OBS' for its own fader"
            />
            <SourceRow
              label="Odds"
              url={oddsUrl}
              size="960 x 320"
              note="each team's chance of winning and the line that got them there - bring it up on a swing"
            />
            {screens.map((s) => (
              <SourceRow
                key={s.slot}
                label={`Stream - ${s.name ?? teamName(s.team)}`}
                url={`${origin}#/overlay-screen/${room.code}?slot=${s.slot}`}
                size="640 x 360"
                note="that player's muted Twitch stream, capped at 480p - size and place per seat"
              />
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}
