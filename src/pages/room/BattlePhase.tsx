import { useEffect, useMemo, useRef, useState } from "react";
import { BoardGrid } from "../../components/BoardGrid";
import { CanvasPanel } from "../../components/CanvasPanel";
import { MatchClock } from "../../components/MatchClock";
import { MatchDock } from "../../components/MatchDock";
import { MatchInfoBox } from "../../components/MatchInfoBox";
import { OverlayLinkBox } from "../../components/OverlayLinkBox";
import { EndMatchButton } from "../../components/EndMatchButton";
import { LeaveMatchButton } from "../../components/LeaveMatchButton";
import { HostTakeover } from "../../components/HostTakeover";
import { ClaimFeed } from "../../components/ClaimFeed";
import { TeamBox } from "../../components/TeamBox";
import { claimSquare, setTeamReady, unclaimSquare } from "../../lib/rooms";
import { facesForRoom } from "../../lib/challenges";
import { cellVisuals, cellOwners } from "../../lib/cellVisuals";
import { scoreFor, squareCounts } from "../../lib/flipLogic";
import { teamHex, teamName } from "../../lib/teamColors";
import { useBattlePhaseName } from "../../hooks/useBattlePhase";
import { useMatchLayout } from "../../hooks/useMatchLayout";
import { usePencilMarks } from "../../hooks/usePencilMarks";
import { PANEL_TITLES, type PanelBox, type PanelId } from "../../lib/matchLayout";
import {
  DEFAULT_BONUS_PER_BINGO,
  DEFAULT_WIN_CONDITION,
  FACE_LABELS,
  defaultTargetScore,
  type WinCondition,
} from "../../types/bingoFlip";
import type { BoardFace, Claim, Player, Room, TeamReady } from "../../types/bingoFlip";

interface Props {
  room: Room;
  myTeam: number;
  myPlayerId: string;
  players: Player[];
  activeTeamsList: number[];
  claims: Claim[];
  /** Which face is showing, derived from the claim log by useRoom. */
  face: BoardFace;
  teamReady: TeamReady[];
  isHost: boolean;
  /** Presence, so a host who drops mid-match doesn't strand the room. See HostTakeover. */
  onlinePlayerIds: string[];
  rejoinCode?: string | null;
}

export function BattlePhase({
  room,
  myTeam,
  myPlayerId,
  players,
  activeTeamsList,
  claims,
  face,
  teamReady,
  isHost,
  onlinePlayerIds,
  rejoinCode,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  /**
   * Every cell this browser has sent a claim for, from the moment the click is accepted.
   *
   * The claim log can't do this job alone: there is a window of a few hundred milliseconds between
   * the RPC being sent and the row arriving over realtime where a second click on the same square
   * passes every check. Under lockout the database refuses the second one anyway - that is what the
   * room lock is for - but the board would flash as though it had worked.
   *
   * Entries are removed only when the call actually FAILED, so a square that couldn't be claimed can
   * be tried again.
   */
  const inFlight = useRef(new Set<number>());

  const boardSize = room.board_size;
  const cells = boardSize * boardSize;
  const lockout = room.lockout ?? true;
  const winCondition = (room.win_condition ?? DEFAULT_WIN_CONDITION) as WinCondition;
  const bonusPerBingo = room.bonus_per_bingo ?? DEFAULT_BONUS_PER_BINGO;
  const targetScore = room.target_score ?? defaultTargetScore(boardSize);

  // Both faces, dealt from the room exactly as every other client deals them. Only the showing face
  // is drawn, but both are computed together - they come out of one seeded pass and splitting that
  // across two renders would mean dealing the board twice to show half of it.
  const faces = useMemo(
    () => facesForRoom(room.id, cells, room.square_set, room.seed, room.custom_square_set),
    [room.id, cells, room.square_set, room.seed, room.custom_square_set]
  );

  const flipCells = useMemo(() => new Set(room.flip_cells ?? []), [room.flip_cells]);

  // One walk of the claim log for the whole board, rather than one filter per square. See cellVisuals.
  const visuals = useMemo(() => cellVisuals(claims), [claims]);
  const owners = useMemo(() => cellOwners(claims), [claims]);
  const counts = useMemo(() => squareCounts(claims), [claims]);

  // Claiming only opens once MATCH begins - STARTING/PREPARATION are a countdown buffer first, and
  // on a flip board that buffer is where a team reads BOTH faces and works out which one it would
  // rather be racing on.
  //
  // The NAME, not the clock: all this component wants is the boolean below, and taking the ticking
  // variant would re-render the board every second to re-derive a value that changes twice a match.
  const phase = useBattlePhaseName(claims, room);
  const canClaim = phase === "match" && room.status === "battle";

  /**
   * Turning the board over by hand, while nothing can be claimed.
   *
   * The whole point of the buffer before a match is to read BOTH faces and decide which one you
   * would rather be racing on - and until this existed there was no way to see the other one. A
   * player could be told the board flips and never look at what it flips to.
   *
   * Null means "whatever the match says", so the preview cannot get stuck: the moment claiming opens
   * the board snaps back to the real face, and it cannot be raised again.
   */
  const [preview, setPreview] = useState<BoardFace | null>(null);
  useEffect(() => {
    if (canClaim) setPreview(null);
  }, [canClaim]);
  const shownFace: BoardFace = !canClaim && preview !== null ? preview : face;
  const previewing = shownFace !== face;
  const challenges = shownFace === 0 ? faces.light : faces.dark;

  const { marks, toggle: toggleMark, clear: clearMarks } = usePencilMarks(room.code);

  // Announce the turn. The board changing under you is the loudest thing that happens in a match and
  // it needs saying in words too - the colours alone leave "did I miss something?" on a stream, and
  // a player mid-click has no idea why the square they were reading is now a different square.
  const lastFace = useRef<BoardFace | null>(null);
  useEffect(() => {
    const previous = lastFace.current;
    // Recorded BEFORE the early return, not after it. Updating it only on the quiet path left it
    // pinned to the face the match opened on, so the first flip announced itself, the flip back
    // compared equal and said nothing, and from then on only turns onto the dark side were ever
    // called - on the one event in a match that most needs saying out loud.
    lastFace.current = face;
    if (previous === null || previous === face) return;

    setToast(`The board turned - ${FACE_LABELS[face]} side`);
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [face]);

  async function handleClaim(index: number) {
    if (!canClaim) return;
    if (inFlight.current.has(index)) return;

    const holders = owners.get(index) ?? [];
    // Already ours: this is the un-claim, for the misclick. Under non-lockout somebody else holding
    // it is irrelevant - we are only ever releasing our own.
    if (holders.includes(myTeam)) {
      inFlight.current.add(index);
      try {
        await unclaimSquare(room.id, index);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        inFlight.current.delete(index);
      }
      return;
    }
    if (lockout && holders.length > 0) return;

    inFlight.current.add(index);
    try {
      const owner = await claimSquare(room.id, index);
      // Losing a square to an opponent who finished the same objective a moment earlier is an
      // ordinary outcome, not an error - so it is said plainly rather than thrown.
      if (owner !== null && owner !== myTeam) {
        setToast(`${teamName(owner)} got there first`);
        setTimeout(() => setToast(null), 2600);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current.delete(index);
    }
  }

  const {
    layout,
    setPanel,
    setStack,
    reset: resetLayout,
    enabled: canvasOn,
    setEnabled: setCanvasOn,
    locked,
    setLocked,
  } = useMatchLayout();

  // Canvas pixel size, so stored fractions can be resolved and drag deltas converted back into
  // fractions. Measured rather than assumed: the panel boxes have to keep meaning the same thing
  // when the window is resized mid-match, which is the whole reason they aren't stored in pixels.
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 1, h: 1 });

  useEffect(() => {
    const el = canvasRef.current;
    if (!canvasOn || !el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      // Guard against 0 - a drag delta divided by a zero canvas is Infinity, which would fling a
      // panel to the clamp boundary on the first pointermove after a hidden/remounted canvas.
      setCanvasSize({ w: Math.max(1, width), h: Math.max(1, height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvasOn]);

  /**
   * Everything a CanvasPanel needs that is the same for all of them, keyed off the panel's id.
   *
   * Four panels' worth of box/canvas/onChange/locked/onRestack wiring repeated inline is four places
   * to forget one of them - which in the case of `locked` means a panel that stays draggable after
   * the player locked the layout, and in the case of `onRestack` a panel that silently can't be
   * raised.
   */
  const panelProps = (id: PanelId) => ({
    title: PANEL_TITLES[id],
    box: layout[id],
    canvas: canvasSize,
    onChange: (b: PanelBox) => setPanel(id, b),
    locked,
    onRestack: (to: "front" | "back") => setStack(id, to),
  });

  /**
   * The board, shared by both layouts so the two can't drift apart.
   *
   * `data-face` is what turns it over: the face tokens are re-pointed by that attribute (see
   * index.css), so every colour on the board follows the flip without a single component knowing
   * which face is up. Set here, on the board and nothing above it, because a flip that also
   * restyled the roster and the clock would read as a page navigation rather than as the board
   * turning.
   */
  const board = (fill: boolean) => (
    <div data-face={shownFace} style={fill ? { width: "100%", height: "100%" } : undefined}>
      <BoardGrid
        boardSize={boardSize}
        cellVisual={(i) => visuals.get(i) ?? "empty"}
        cellOwners={owners}
        flipCells={flipCells}
        onCellClick={handleClaim}
        disabled={!canClaim}
        markedCells={marks}
        onToggleMark={toggleMark}
        cellText={(i) => {
          const c = challenges[i];
          return c ? { label: c.short ?? c.name, title: c.title ?? c.name } : null;
        }}
        cellTint={(i) => {
          const c = challenges[i];
          return c ? { region: c.region, color: c.color } : null;
        }}
        fill={fill}
        maxVh={fill ? undefined : 74}
        maxVw={fill ? undefined : 62}
      />
    </div>
  );

  const teamBoxes = activeTeamsList.map((team) => {
    const scored = scoreFor(claims, boardSize, team, bonusPerBingo);
    return (
      <TeamBox
        key={team}
        team={team}
        players={players}
        held={counts.get(team) ?? 0}
        cells={cells}
        lines={scored.lines}
        // Under `line` a bingo ends the match, so there is no score to show and the roster stays a
        // square count. Under `points` the score is the only number that decides anything, and it
        // has to be the same arithmetic claim_square() runs - see scoreFor.
        score={winCondition === "points" ? scored.score : undefined}
        target={winCondition === "points" ? targetScore : undefined}
        isMine={team === myTeam}
        myPlayerId={myPlayerId}
      />
    );
  });

  const sidebar = (
    <>
      <MatchClock claims={claims} room={room} maxVh={34} maxVw={26} />
      <div className="stack" style={{ gap: "0.6rem" }}>{teamBoxes}</div>
      <ClaimFeed
        claims={claims}
        players={players}
        boardSize={boardSize}
        faces={[faces.light, faces.dark]}
        room={room}
        maxHeight={260}
      />
      <OverlayLinkBox roomCode={room.code} team={myTeam} />
      {isHost && <EndMatchButton roomId={room.id} activeTeamsList={activeTeamsList} />}
      <LeaveMatchButton playerId={myPlayerId} roomCode={room.code} />
      {/* Last item in the right-hand column, so it sits bottom-right of the match screen -
          in view for the whole game, which is the point (see MatchInfoBox). */}
      <MatchInfoBox roomCode={room.code} seed={room.seed} rejoinCode={rejoinCode} />
    </>
  );

  const flipsLeft = [...flipCells].filter((c) => !owners.has(c)).length;


  return (
    <div className="stack" style={{ alignItems: "center", width: "100%" }}>
      {/* Fixed, not in flow - a toast appearing must never shove the board around mid-game. */}
      {toast && (
        <div
          className="panel"
          style={{
            position: "fixed",
            top: "0.75rem",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 20,
            borderColor: "var(--board-glow)",
          }}
        >
          {toast}
        </div>
      )}
      {error && <div className="error-text">{error}</div>}

      <HostTakeover players={players} onlinePlayerIds={onlinePlayerIds} myPlayerId={myPlayerId} />

      {/* The readiness gate. Only while the room is in `prep`, which is the one phase that does not
          advance on a clock - it waits for every team to say it is here. */}
      {room.status === "prep" && (
        <ReadyGate
          roomId={room.id}
          myTeam={myTeam}
          teams={activeTeamsList}
          teamReady={teamReady}
          isHost={isHost}
        />
      )}


      {/* What face is up and how many turns are left in the board. Both are public and both change
          how you play the next thirty seconds, so they sit above the canvas rather than inside a
          panel somebody may have dragged off-screen. */}
      <div
        className="row"
        style={{ gap: "0.6rem", alignItems: "baseline", fontSize: "0.85rem" }}
        data-face={shownFace}
      >
        <strong style={{ color: "var(--board-glow)", letterSpacing: "0.08em" }}>
          {FACE_LABELS[shownFace]} side
        </strong>

        {/* Only while claiming is shut. Turning the board by hand mid-race would show a player
            objectives that are not on the table, which is a way to misread the board rather than to
            read it. */}
        {!canClaim && (
          <button
            onClick={() => setPreview(previewing ? null : ((face === 0 ? 1 : 0) as BoardFace))}
            aria-pressed={previewing}
            style={{
              fontSize: "0.72rem",
              padding: "0.15rem 0.5rem",
              borderColor: previewing ? "var(--accent)" : undefined,
            }}
            title="Read the objectives on the other side of the board before the race opens"
          >
            {previewing ? "Back to the live board" : `Look at the ${FACE_LABELS[face === 0 ? 1 : 0]} side`}
          </button>
        )}
        {previewing && <span className="badge">preview - not the live board</span>}
        <span className="muted">
          {flipsLeft === 0
            ? "no flip squares left - this board is settled"
            : `${flipsLeft} flip square${flipsLeft === 1 ? "" : "s"} left`}
        </span>
        <span className="muted">
          {lockout ? "lockout" : "non-lockout"} ·{" "}
          {winCondition === "line"
            ? "bingos win"
            : bonusPerBingo === 0
              ? `first to ${targetScore}`
              : `first to ${targetScore}, bingo +${bonusPerBingo}`}
          {" "}· {defaultTargetScore(boardSize)}+ squares wins outright either way
          {room.practice ? " · practice, won't count" : ""}
        </span>
      </div>

      <div className="row" style={{ gap: "0.4rem", alignSelf: "flex-end", marginBottom: "-0.4rem" }}>
        <button
          onClick={() => setCanvasOn(!canvasOn)}
          style={{ fontSize: "0.72rem", padding: "0.15rem 0.5rem" }}
          title="Drag panels by their title bar; resize from the bottom-right corner"
        >
          {canvasOn ? "Fixed layout" : "Move / resize panels"}
        </button>
        {canvasOn && (
          <>
            {/* The whole point of arranging panels is to stop having to arrange them. Locking is
                what makes a layout something you set once rather than something you defend from
                every stray drag for the rest of the match. */}
            <button
              onClick={() => setLocked(!locked)}
              style={{
                fontSize: "0.72rem",
                padding: "0.15rem 0.5rem",
                borderColor: locked ? "var(--accent)" : undefined,
              }}
              title={
                locked
                  ? "Panels are frozen. Unlock to move, resize or restack them."
                  : "Freeze every panel where it is, so nothing moves by accident."
              }
              aria-pressed={locked}
            >
              {locked ? "Locked" : "Lock layout"}
            </button>
            <button onClick={resetLayout} style={{ fontSize: "0.72rem", padding: "0.15rem 0.5rem" }}>
              Reset layout
            </button>
          </>
        )}
      </div>

      {canvasOn ? (
        <div className="match-canvas-wrap">
          <div className="match-canvas" ref={canvasRef}>
            <CanvasPanel {...panelProps("board")} flush>
              {board(true)}
            </CanvasPanel>
            <CanvasPanel {...panelProps("clock")}>
              <MatchClock claims={claims} room={room} maxVh={34} maxVw={26} />
            </CanvasPanel>
            <CanvasPanel {...panelProps("log")} flush>
              <ClaimFeed
                claims={claims}
                players={players}
                boardSize={boardSize}
                faces={[faces.light, faces.dark]}
                room={room}
                maxHeight="100%"
              />
            </CanvasPanel>
            <CanvasPanel {...panelProps("roster")}>
              <div className="stack" style={{ gap: "0.6rem" }}>{teamBoxes}</div>
            </CanvasPanel>
          </div>

          {/* Everything you refer to rather than watch, on one line across the bottom. */}
          <MatchDock
            challenges={challenges}
            squareSet={room.square_set}
            roomId={room.id}
            roomCode={room.code}
            seed={room.seed}
            rejoinCode={rejoinCode}
            myTeam={myTeam}
            myPlayerId={myPlayerId}
            activeTeamsList={activeTeamsList}
            isHost={isHost}
            markCount={marks.size}
            onClearMarks={clearMarks}
          />
        </div>
      ) : (
        <div className="row" style={{ alignItems: "flex-start", gap: "1rem", width: "100%" }}>
          <div style={{ flex: 1, minWidth: 0 }}>{board(false)}</div>
          <div className="stack" style={{ width: "18rem", gap: "0.6rem" }}>
            {sidebar}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The gate between the lobby and the match: every team says it is here, and the board opens.
 *
 * This is the control the `prep` status exists for, and for a while it did not exist at all -
 * beginPrepPhase() cleared the ready flags, Room.tsx waited for every team to raise one, and nothing
 * anywhere could raise one. A room that left the lobby stayed in prep forever, which is to say no
 * match could be started through the app at all. The database checks never caught it because they
 * write `status: 'battle'` directly and skip this phase entirely.
 *
 * Any member of a team may raise or lower its flag, rather than only its captain. The policy on
 * `team_ready` is written that way (see the initial schema), and the alternative strands a team
 * whose captain has walked away from the keyboard - the exact situation this screen is full of.
 */
function ReadyGate({
  roomId,
  myTeam,
  teams,
  teamReady,
  isHost,
}: {
  roomId: string;
  myTeam: number;
  teams: number[];
  teamReady: TeamReady[];
  isHost: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = new Set(teamReady.filter((t) => t.ready).map((t) => t.team));
  const mine = ready.has(myTeam);
  const waitingOn = teams.filter((t) => !ready.has(t));

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      await setTeamReady(roomId, myTeam, !mine);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel stack" style={{ width: "min(560px, 100%)", gap: "0.5rem" }}>
      <strong>Read the board</strong>
      <span className="muted" style={{ fontSize: "0.85rem" }}>
        Nothing can be claimed yet. Look at both sides, work out which one you would rather be racing
        on, then say your team is ready. The match opens by itself once every team has.
      </span>

      <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
        {teams.map((t) => (
          <span key={t} className="row" style={{ gap: "0.3rem", alignItems: "center" }}>
            <span aria-hidden style={{ color: ready.has(t) ? "var(--accent)" : "var(--text-dim)" }}>
              {ready.has(t) ? "✓" : "○"}
            </span>
            <span style={{ color: teamHex(t), fontSize: "0.85rem" }}>{teamName(t)}</span>
          </span>
        ))}
      </div>

      <button className={mine ? undefined : "primary"} disabled={busy} onClick={() => void toggle()}>
        {mine ? "Not ready after all" : `${teamName(myTeam)} is ready`}
      </button>

      {/* Two teams is the floor Room.tsx will start on, and a team can empty out during prep when
          its only player leaves - so this is reachable from a lobby that was perfectly valid. */}
      {teams.length < 2 && (
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          There is only one team left in the room. The match cannot open until a second one has a
          player on it.
        </span>
      )}

      {teams.length >= 2 && waitingOn.length > 0 && (
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          Waiting on {waitingOn.map((t) => teamName(t)).join(", ")}.
        </span>
      )}

      {/* The host is the one client that actually opens the match (see Room.tsx), so if they have
          shut the tab nothing happens no matter how ready everyone is. Worth saying to the host
          rather than to the room, which can already see a takeover prompt when they go dark. */}
      {isHost && waitingOn.length === 0 && teams.length >= 2 && (
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          Everyone is ready - opening the board...
        </span>
      )}

      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
