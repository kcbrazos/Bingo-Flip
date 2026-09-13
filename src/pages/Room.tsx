import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useRoom } from "../hooks/useRoom";
import { LobbyPhase } from "./room/LobbyPhase";
import { BattlePhase } from "./room/BattlePhase";
import { joinRoom, resetRoomToLobby, redeemRejoinCode, startBattle, pauseMatch, resumeMatch } from "../lib/rooms";
import { activeTeams } from "../lib/teams";
import { teamName, teamHex } from "../lib/teamColors";
import {
  getLastNickname,
  storeLastNickname,
  getStoredPlayerId,
  setActiveRoom,
  clearActiveRoom,
} from "../lib/playerSession";
import { Link } from "react-router-dom";
import { useAuthProfile, accountName, saveNickname } from "../hooks/useAuthProfile";
import { NICKNAME_MAX } from "../lib/profiles";
import { BoardGrid } from "../components/BoardGrid";
import { ClaimFeed } from "../components/ClaimFeed";
import { TeamBox } from "../components/TeamBox";
import { HostTakeover } from "../components/HostTakeover";
import { formatRoomCode } from "../lib/roomCode";
import { useMatchSfx } from "../hooks/useMatchSfx";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { TeamPicker } from "../components/TeamPicker";
import { LoadingScreen } from "../components/BrandMark";
import { BoardLegend } from "../components/BoardLegend";
import { facesForRoom } from "../lib/challenges";
import { archiveMatch } from "../lib/stats";
import { MatchClock } from "../components/MatchClock";
import { LeaveMatchButton } from "../components/LeaveMatchButton";
import { cellVisuals, cellOwners } from "../lib/cellVisuals";
import { useWatchingWith } from "../hooks/useWatchingWith";
import {
  completedLines,
  exhaustion,
  scoreFor,
  winningClaim,
  winningReason,
  cellLabel,
  type WinReason,
} from "../lib/flipLogic";
import {
  DEFAULT_BONUS_PER_BINGO,
  DEFAULT_WIN_CONDITION,
  FACE_LABELS,
  defaultTargetScore,
  type WinCondition,
} from "../types/bingoFlip";
import type { BoardFace, Claim, Room as RoomType, Player } from "../types/bingoFlip";
import "./Spectator.css";

export function Room() {
  const { code } = useParams<{ code: string }>();
  const state = useRoom(code);
  // Every sound the match makes - see hooks/useMatchSfx, which pages/OverlayAudio shares so a
  // caster's stream carries the identical cues on the identical triggers.
  useMatchSfx(state.room, state.claims, state.myPlayer?.team ?? null);

  // The match opens the instant every team has said it has read the board.
  //
  // Driven from here rather than from inside the prep screen, which is where the equivalent used to
  // live: that component only mounts for a player who is ON a team, so a host who chose to spectate
  // never ran it and the room sat in prep forever with everyone ready and nothing able to start. The
  // host is still the one who triggers it - a single writer keeps the flip squares unambiguous,
  // since startBattle is what writes them - they just no longer have to be holding a team to do it.
  //
  // startedRef guards against a second request from this client between the write and the status
  // actually flipping.
  const [hostError, setHostError] = useState<string | null>(null);
  const battleStartedRef = useRef(false);
  useEffect(() => {
    const room = state.room;
    if (!room || room.status !== "prep") {
      battleStartedRef.current = false; // so a rematch in this same room can start again
      return;
    }
    if (!state.myPlayer?.is_host || battleStartedRef.current) return;

    const teams = activeTeams(state.players);
    if (teams.length < 2) return;
    const ready = new Set(state.teamReady.filter((t) => t.ready).map((t) => t.team));
    if (!teams.every((t) => ready.has(t))) return;

    battleStartedRef.current = true;
    startBattle(room).catch((e) => {
      battleStartedRef.current = false;
      setHostError(e instanceof Error ? e.message : String(e));
    });
  }, [state.room, state.myPlayer, state.players, state.teamReady]);

  // Pausing and resuming both need every active team's agreement (see BattlePhase's PauseControl,
  // which is the only thing that ever writes `pause_votes`), and flipping `paused_at` itself is the
  // host's job alone - same division of labour as opening the match above, and for the same reason:
  // `paused_at` and, on resume, `started_at` are what every client's clock is anchored to, and
  // guard_match_open refuses that write from anyone but the host.
  const pausingRef = useRef(false);
  const resumingRef = useRef(false);
  useEffect(() => {
    const room = state.room;
    if (!room || room.status !== "battle" || !state.myPlayer?.is_host) {
      pausingRef.current = false;
      resumingRef.current = false;
      return;
    }

    const teams = activeTeams(state.players);
    const votes = new Set(room.pause_votes ?? []);
    const allWantPaused = teams.length > 0 && teams.every((t) => votes.has(t));

    if (!room.paused_at && allWantPaused) {
      if (!pausingRef.current) {
        pausingRef.current = true;
        pauseMatch(room.id).catch((e) => {
          pausingRef.current = false;
          setHostError(e instanceof Error ? e.message : String(e));
        });
      }
    } else {
      pausingRef.current = false;
    }

    if (room.paused_at && !allWantPaused) {
      if (!resumingRef.current) {
        resumingRef.current = true;
        resumeMatch(room).catch((e) => {
          resumingRef.current = false;
          setHostError(e instanceof Error ? e.message : String(e));
        });
      }
    } else {
      resumingRef.current = false;
    }
  }, [state.room, state.myPlayer, state.players]);

  // Remembers where you are so the top bar can offer a way back - and forgets it the moment the room
  // stops being somewhere you can return to, so the link never points at a room that's gone.
  const hasPlayer = Boolean(state.myPlayer);
  const roomGone = !state.loading && !state.error && !state.room;
  useEffect(() => {
    if (!code) return;
    if (hasPlayer) setActiveRoom(code);
    else if (roomGone) clearActiveRoom(code);
  }, [code, hasPlayer, roomGone]);

  // The connection banner has to sit alongside whichever phase is showing, so the phase choice
  // is resolved in here and rendered inside a single fragment below rather than early-returned.
  function renderPhase() {
  if (state.loading) return <LoadingScreen>Loading room...</LoadingScreen>;
  // A real failure - no network, a rejected read - as opposed to a room that simply isn't there,
  // which is the case below and no longer arrives here. Given a way out for the same reason that
  // one has: whatever went wrong, a dead end is not the answer to it.
  if (state.error) {
    return (
      <div className="panel stack" style={{ width: "min(420px, 100%)", alignItems: "center", textAlign: "center" }}>
        <h2 style={{ margin: 0 }}>Couldn't open this room</h2>
        <p className="error-text" style={{ margin: 0 }}>{state.error}</p>
        <Link to="/">Return to the round table</Link>
      </div>
    );
  }

  // Deleted by an admin, or swept up by the room pruner while this tab sat open. Previously a bare
  // line of red text with nowhere to go from it.
  if (!state.room) {
    return (
      <div className="panel stack" style={{ width: "min(420px, 100%)", alignItems: "center", textAlign: "center" }}>
        <h2 style={{ margin: 0 }}>This room is gone</h2>
        <p className="muted" style={{ margin: 0 }}>
          {code ? formatRoomCode(code) : "That room"} has been closed, deleted, or cleared away after
          sitting idle. Nothing here to rejoin.
        </p>
        <Link to="/">Return to the round table</Link>
      </div>
    );
  }

  if (!state.myPlayer) {
    // A stored player id for this room with no matching row means the seat is gone rather than
    // never taken: kicked by the host, or removed by an admin. Say so, then offer the join form
    // underneath - rejoining is usually what you want next, and silently showing a fresh join
    // screen made it look as though nothing had happened.
    const wasHere = Boolean(code && getStoredPlayerId(code));
    return (
      <div className="stack" style={{ width: "min(400px, 100%)", gap: "0.6rem" }}>
        {wasHere && (
          <div className="panel stack" style={{ gap: "0.4rem", borderColor: "var(--danger)" }}>
            <strong>You're no longer in this room</strong>
            <span className="muted" style={{ fontSize: "0.85rem" }}>
              The host or an admin removed you. You can join again below, or head back out.
            </span>
            <Link to="/" style={{ fontSize: "0.85rem" }}>
              Return to the round table
            </Link>
          </div>
        )}
        <JoinForm code={state.room.code} />
      </div>
    );
  }

  const { room, players, myPlayer, claims, face } = state;
  const teamsList = activeTeams(players);

  if (room.status === "lobby") {
    return (
      <LobbyPhase
        room={room}
        players={players}
        myPlayer={myPlayer}
        onlinePlayerIds={state.onlinePlayerIds}
      />
    );
  }

  // Spectators and players see THE SAME BOARD, which is the largest simplification the flip rework
  // brought to this page. Battleship had to build a separate spectating view with a mode switcher,
  // because a spectator was the only participant allowed to see every fleet at once and a player
  // could see only their own. Nothing on a bingo board is hidden from anybody, so the difference
  // between watching and playing is now exactly one thing: whether the squares can be clicked.
  if (room.status === "finished") {
    return (
      <FinishedView
        room={room}
        myTeam={myPlayer.team}
        myPlayerId={myPlayer.id}
        isHost={myPlayer.is_host}
        activeTeamsList={teamsList}
        players={players}
        claims={claims}
        face={face}
      />
    );
  }

  if (myPlayer.team === null) {
    return (
      <SpectatorView
        room={room}
        activeTeamsList={teamsList}
        claims={claims}
        face={face}
        players={players}
        onlinePlayerIds={state.onlinePlayerIds}
        myPlayer={myPlayer}
      />
    );
  }

  const myTeam = myPlayer.team;

  // Prep and battle are the same screen. The only difference is whether claiming is open, which
  // BattlePhase already decides from the clock rather than from the room status - so a team reading
  // both faces during preparation is looking at the board they will actually play on.
  if (room.status === "prep" || room.status === "battle") {
    return (
      <BattlePhase
        room={room}
        myTeam={myTeam}
        myPlayerId={myPlayer.id}
        players={players}
        activeTeamsList={teamsList}
        claims={claims}
        face={face}
        teamReady={state.teamReady}
        isHost={myPlayer.is_host}
        onlinePlayerIds={state.onlinePlayerIds}
        rejoinCode={myPlayer.rejoin_code}
      />
    );
  }

  return null;
  }

  return (
    <>
      <ConnectionBanner connection={state.connection} />
      {/* Rendered above the phase rather than inside it: the thing most likely to fail here is the
          automatic match start, and the host may well be spectating when it does. */}
      {hostError && <div className="error-text">{hostError}</div>}
      {renderPhase()}
    </>
  );
}

function JoinForm({ code }: { code: string }) {
  const [nickname, setNickname] = useState(getLastNickname());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRejoin, setShowRejoin] = useState(false);
  const [rejoinCode, setRejoinCode] = useState("");

  // Same precedence as the Home page: a signed-in player's own nickname, then their Twitch name,
  // then whatever this browser last used. Arriving on a room link shouldn't hand you a different
  // name from the one the front page would have.
  const profile = useAuthProfile();
  const [touched, setTouched] = useState(false);
  const savedName = accountName(profile);
  useEffect(() => {
    if (!touched && savedName) setNickname(savedName.slice(0, NICKNAME_MAX));
  }, [savedName, touched]);

  async function handleRejoin() {
    if (!rejoinCode.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const playerId = await redeemRejoinCode(code, rejoinCode);
      if (!playerId) {
        setError("That rejoin code doesn't match anyone in this room.");
        setBusy(false);
        return;
      }
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }
  // Shared via the lobby's "Spectator link". Players join with team = null anyway, so this only
  // changes the framing - it tells the visitor what they're walking into rather than dropping
  // them on a team picker they didn't ask for.
  const spectating = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("spectate") === "1";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!nickname.trim()) return;
    setBusy(true);
    setError(null);
    try {
      storeLastNickname(nickname.trim());
      // Signed in? Then this is a rename, not just a name for this room - keep it on the account.
      // Failing to save it must not block the join, so the name they typed is used either way.
      if (profile?.isTwitch) await saveNickname(nickname.trim()).catch(() => {});
      await joinRoom(code, nickname.trim());
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="panel stack" style={{ width: "min(400px, 100%)" }}>
      <h2>{spectating ? `Spectate ${formatRoomCode(code)}` : `Join ${formatRoomCode(code)}`}</h2>
      {spectating && (
        <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
          You'll join as a spectator. Pick a team in the lobby if you'd rather play.
        </p>
      )}
      <input
        value={nickname}
        onChange={(e) => {
          setTouched(true);
          setNickname(e.target.value);
        }}
        placeholder="Nickname"
        maxLength={NICKNAME_MAX}
        autoFocus
      />
      {profile?.isTwitch && (
        <span className="muted" style={{ fontSize: "0.72rem", marginTop: "-0.35rem" }}>
          Your Twitch account keeps this name for next time.
        </span>
      )}
      {error && <div className="error-text">{error}</div>}
      <button type="submit" className="primary" disabled={busy}>
        {spectating ? "Spectate" : "Join"}
      </button>

      {showRejoin ? (
        <div className="stack" style={{ gap: "0.35rem" }}>
          <span className="muted" style={{ fontSize: "0.75rem" }}>
            Enter the rejoin code from your previous session to take that seat back.
          </span>
          <div className="row" style={{ gap: "0.4rem" }}>
            <input
              style={{ flex: 1, textTransform: "uppercase" }}
              value={rejoinCode}
              onChange={(e) => setRejoinCode(e.target.value)}
              placeholder="Rejoin code"
              maxLength={8}
            />
            <button type="button" disabled={busy} onClick={handleRejoin}>
              Rejoin
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowRejoin(true)}
          style={{ fontSize: "0.75rem", background: "none", border: "none", color: "var(--text-dim)" }}
        >
          Played here before? Use a rejoin code
        </button>
      )}
    </form>
  );
}

/**
 * One read-only board, plus the roster and the log.
 *
 * Shared by the spectator's view and the post-match recap, because at that point they are the same
 * thing: a board nobody can click, with the state of the match written on it.
 *
 * `data-face` is what turns it over - the face tokens are re-pointed by that attribute (see
 * index.css), so every colour follows the flip without a component knowing which face is up.
 */
function WatchBoard({
  room,
  claims,
  face,
  players,
  activeTeamsList,
  highlight,
}: {
  room: RoomType;
  claims: Claim[];
  face: BoardFace;
  players: Player[];
  activeTeamsList: number[];
  /** Cells to ring, for the line that won it. */
  highlight?: readonly number[];
}) {
  const boardSize = room.board_size;
  const cells = boardSize * boardSize;

  // A points match is decided by a number that is nowhere on the board, so a watcher who cannot see
  // it cannot follow the match at all - which is the whole job of this view. The players' own roster
  // has shown it all along (see BattlePhase); this is the same arithmetic, from the same function.
  const winCondition = (room.win_condition ?? DEFAULT_WIN_CONDITION) as WinCondition;
  const bonusPerBingo = room.bonus_per_bingo ?? DEFAULT_BONUS_PER_BINGO;
  const targetScore = room.target_score ?? defaultTargetScore(boardSize);

  const faces = useMemo(
    () => facesForRoom(room.id, cells, room.square_set, room.seed, room.custom_square_set),
    [room.id, cells, room.square_set, room.seed, room.custom_square_set]
  );
  const challenges = face === 0 ? faces.light : faces.dark;

  // See the matching note in BattlePhase: a 5x5 board has room enough to skip the shortener.
  const useShortNames = boardSize > 5;

  const visuals = useMemo(() => cellVisuals(claims), [claims]);
  const owners = useMemo(() => cellOwners(claims), [claims]);
  const flipCells = useMemo(() => new Set(room.flip_cells ?? []), [room.flip_cells]);
  const ringed = useMemo(() => new Set(highlight ?? []), [highlight]);

  return (
    <div className="row" style={{ alignItems: "flex-start", gap: "1rem", width: "100%" }}>
      <div style={{ flex: 1, minWidth: 0 }} data-face={face}>
        <BoardGrid
          boardSize={boardSize}
          cellVisual={(i) => visuals.get(i) ?? "empty"}
          cellOwners={owners}
          flipCells={flipCells}
          disabled
          cellText={(i) => {
            const c = challenges[i];
            return c ? { label: useShortNames ? c.short ?? c.name : c.name, title: c.title ?? c.name } : null;
          }}
          cellTint={(i) => {
            const c = challenges[i];
            return c ? { region: c.region, color: c.color } : null;
          }}
          // The winning line, drawn with the same ring the board already uses for attribution.
          ringedBy={
            ringed.size > 0
              ? new Map([...ringed].map((i) => [i, ["var(--accent-bright)"]]))
              : undefined
          }
          maxVh={74}
          maxVw={62}
        />
        <BoardLegend challenges={challenges} setId={room.square_set} inline />
      </div>

      <div className="stack" style={{ width: "18rem", gap: "0.6rem" }}>
        <MatchClock claims={claims} room={room} maxVh={34} maxVw={26} />
        {activeTeamsList.map((team) => {
          const scored = scoreFor(claims, boardSize, team, bonusPerBingo);
          return (
            <TeamBox
              key={team}
              team={team}
              players={players}
              held={scored.squares}
              cells={cells}
              lines={scored.lines}
              score={winCondition === "points" ? scored.score : undefined}
              target={winCondition === "points" ? targetScore : undefined}
            />
          );
        })}
        <ClaimFeed
          claims={claims}
          players={players}
          boardSize={boardSize}
          faces={[faces.light, faces.dark]}
          room={room}
          maxHeight={320}
        />
      </div>
    </div>
  );
}

function SpectatorView({
  room,
  activeTeamsList,
  claims,
  face,
  players,
  onlinePlayerIds,
  myPlayer,
}: {
  room: RoomType;
  activeTeamsList: number[];
  claims: Claim[];
  face: BoardFace;
  players: Player[];
  onlinePlayerIds: string[];
  myPlayer: Player;
}) {
  const flipsLeft = useMemo(() => {
    const held = cellOwners(claims);
    return (room.flip_cells ?? []).filter((c) => !held.has(c)).length;
  }, [room.flip_cells, claims]);

  const [watchTeam, setWatchTeam] = useWatchingWith(room.code);
  // A team that left the room (its last player quit or switched off it) is not a team you can
  // watch WITH any more - fall back to neutral rather than leaving the view stuck locked to a
  // side nobody is actually playing.
  const neutral = watchTeam === null || !activeTeamsList.includes(watchTeam);
  useEffect(() => {
    if (watchTeam !== null && !activeTeamsList.includes(watchTeam)) setWatchTeam(null);
  }, [watchTeam, activeTeamsList, setWatchTeam]);

  /**
   * Free look at either face - see useWatchingWith. Reset the instant an affiliation is declared:
   * from there this view shows exactly what that team sees, which is the live face and nothing
   * else, the same restriction BattlePhase puts on an actual player.
   */
  const [previewFace, setPreviewFace] = useState<BoardFace | null>(null);
  useEffect(() => {
    if (!neutral) setPreviewFace(null);
  }, [neutral]);
  const shownFace: BoardFace = neutral && previewFace !== null ? previewFace : face;
  const peeking = shownFace !== face;

  return (
    <div className="stack" style={{ alignItems: "center", width: "100%", gap: "0.8rem" }}>
      <HostTakeover players={players} onlinePlayerIds={onlinePlayerIds} myPlayerId={myPlayer.id} />

      <div
        className="row"
        style={{ gap: "0.6rem", alignItems: "baseline", fontSize: "0.85rem", flexWrap: "wrap" }}
        data-face={shownFace}
      >
        <span className="badge">watching</span>
        <strong style={{ color: "var(--board-glow)", letterSpacing: "0.08em" }}>
          {FACE_LABELS[shownFace]} side
        </strong>
        <span className="muted">
          {flipsLeft} flip square{flipsLeft === 1 ? "" : "s"} left
        </span>

        {/* Nothing on a bingo board is hidden, so a spectator riding on nobody's result may freely
            read ahead - the same peek the caster desk already offers on stream. Withdrawn the
            moment an affiliation is declared below. */}
        {neutral && (
          <div className="row" style={{ gap: "0.25rem" }} title="Look at a face's objectives without changing the match">
            {(["live", 0, 1] as const).map((f) => {
              const active = f === "live" ? previewFace === null : previewFace === f;
              return (
                <button
                  key={String(f)}
                  className={active ? "primary" : undefined}
                  style={{ fontSize: "0.72rem", padding: "0.1rem 0.45rem" }}
                  onClick={() => setPreviewFace(f === "live" ? null : (f as BoardFace))}
                >
                  {f === "live" ? "Live" : FACE_LABELS[f]}
                </button>
              );
            })}
          </div>
        )}
        {peeking && (
          <span className="muted" style={{ fontSize: "0.75rem" }}>
            peeking - really on {FACE_LABELS[face]}
          </span>
        )}
      </div>

      {/* Declaring a side is what gives up the peek above - see useWatchingWith for why. */}
      <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap", alignItems: "center", justifyContent: "center" }}>
        <span className="muted" style={{ fontSize: "0.75rem" }}>
          Watching with:
        </span>
        <button
          className={neutral ? "primary" : undefined}
          style={{ fontSize: "0.72rem", padding: "0.1rem 0.5rem" }}
          onClick={() => setWatchTeam(null)}
        >
          Neutral
        </button>
        {activeTeamsList.map((t) => (
          <button
            key={t}
            className={watchTeam === t ? "primary" : undefined}
            style={{
              fontSize: "0.72rem",
              padding: "0.1rem 0.5rem",
              borderColor: watchTeam === t ? teamHex(t) : undefined,
              color: watchTeam === t ? teamHex(t) : undefined,
            }}
            onClick={() => setWatchTeam(t)}
            title={`See only what ${teamName(t)} sees - no reading ahead on the other face`}
          >
            {teamName(t)}
          </button>
        ))}
      </div>
      {!neutral && (
        <span className="muted" style={{ fontSize: "0.75rem", textAlign: "center" }}>
          Watching with {teamName(watchTeam)} - seeing only the live face, same as they do.
        </span>
      )}

      <WatchBoard
        room={room}
        claims={claims}
        face={shownFace}
        players={players}
        activeTeamsList={activeTeamsList}
      />

      <div className="stack" style={{ width: "min(320px, 100%)" }}>
        {myPlayer.is_host && <PlayAgainButton room={room} activeTeamsList={activeTeamsList} />}
        <LeaveMatchButton playerId={myPlayer.id} roomCode={room.code} spectating />
      </div>
    </div>
  );
}

function FinishedView({
  room,
  myTeam,
  myPlayerId,
  isHost,
  activeTeamsList,
  players,
  claims,
  face,
}: {
  room: RoomType;
  /** Null for a spectator, who gets the same recap as everyone else. */
  myTeam: number | null;
  myPlayerId: string;
  isHost: boolean;
  activeTeamsList: number[];
  players: Player[];
  claims: Claim[];
  face: BoardFace;
}) {
  const [error, setError] = useState<string | null>(null);
  const winCondition = (room.win_condition ?? DEFAULT_WIN_CONDITION) as WinCondition;

  /**
   * File the match the moment this screen mounts - unless it was played as practice, in which case
   * there is nothing to file. archive_match() also refuses a practice room on its own (see the
   * migration), so this check is redundant rather than load-bearing; it exists anyway to skip a
   * pointless round trip on every client instead of relying on the database to say no.
   *
   * This is the last point the claim log is guaranteed to exist - "Play again" deletes it - and the
   * first point the result is final, so there is no other window to do it in.
   *
   * Every client on this screen calls it, rather than a nominated one. The client guaranteed to be
   * here is not knowable in advance: the host may have shut their tab the moment they lost.
   * archive_match() is idempotent on a key built from the room code and the start instant, so the
   * extra callers do one indexed lookup each and write nothing.
   */
  const filed = useRef<string | null>(null);
  useEffect(() => {
    if (filed.current === room.id) return;
    filed.current = room.id;
    if (room.practice) return;
    void archiveMatch(room.id);
  }, [room.id, room.practice]);
  const won = myTeam !== null && room.winner_team === myTeam;

  // The square that actually decided it, replayed off the log rather than taken as "the last claim":
  // under non-lockout the log keeps running past the winning claim while other teams' clicks land.
  const bonusPerBingo = room.bonus_per_bingo ?? DEFAULT_BONUS_PER_BINGO;
  const targetScore = room.target_score ?? defaultTargetScore(room.board_size);
  /**
   * The claim that ended it.
   *
   * Usually the one that met the condition. On a board that simply ran out there is no such claim -
   * nobody met anything - and the last square taken is what ended the match, so that is what gets
   * named. Both cases are a square on the board, which is the only answer the recap is asked for.
   */
  const ran = useMemo(
    () => exhaustion(claims, room.board_size, room.lockout ?? true, winCondition, bonusPerBingo),
    [claims, room.board_size, room.lockout, winCondition, bonusPerBingo]
  );
  const decider = useMemo(() => {
    const won = winningClaim(claims, room.board_size, winCondition, { bonusPerBingo, targetScore });
    if (won) return won;
    return ran.full ? (claims[claims.length - 1] ?? null) : null;
  }, [claims, room.board_size, winCondition, bonusPerBingo, targetScore, ran.full]);
  // Why it ended - a completed line, a points target, or a majority - independent of `winCondition`
  // now that majority can win regardless of which format the room chose. Null on a board that ran out,
  // where nothing was actually met.
  const reason = useMemo(
    () => winningReason(claims, room.board_size, winCondition, { bonusPerBingo, targetScore }),
    [claims, room.board_size, winCondition, bonusPerBingo, targetScore]
  );
  /**
   * What to ring on the board: the line that won it, or the square that did.
   *
   * Anchored to the deciding claim rather than to "a line the winner happens to hold". Two things
   * make the simpler version wrong. Under non-lockout the log keeps running past the winning claim,
   * so the winner can complete further lines AFTER the match was already decided, and the first one
   * in list order may be one of those. And under `points` (or a majority win) nothing was closed by a
   * line at all - ringing one would point at something that did not decide the match.
   */
  const winningCells = useMemo(() => {
    if (!decider) return [];
    // A board that ran out was decided by the tally, not by any one square, so ringing a line would
    // point at something that won nothing.
    if (reason !== "line" || ran.full) return [decider.cell_index];
    const through = completedLines(claims, room.board_size, decider.team).filter((line) =>
      line.includes(decider.cell_index)
    );
    return through[0] ?? [decider.cell_index];
  }, [claims, room.board_size, decider, reason, ran.full]);
  // Zero bonus under `line`, matching claim_square: that format pays nothing for a line, so
  // counting one here would print a total the database never computed.
  const winnerScore =
    room.winner_team === null
      ? null
      : scoreFor(claims, room.board_size, room.winner_team, winCondition === "points" ? bonusPerBingo : 0)
          .score;

  return (
    <div className="stack" style={{ alignItems: "center", width: "100%", gap: "0.9rem" }}>
      <p className="muted" style={{ margin: 0, fontSize: "1.05rem" }}>
        {room.winner_team === null
          ? // A drawn board and an abandoned one both arrive here with no winner, and they are not
            // remotely the same thing to have been in. The board being full is what tells them apart.
            ran.drawn
            ? "The board ran out level. Nobody takes it."
            : "The match ended with nobody home."
          : won
            ? verdict(null, reason, winnerScore, targetScore, ran.full)
            : verdict(teamName(room.winner_team), reason, winnerScore, targetScore, ran.full)}
      </p>

      {/* The deciding square, named. On a board of twenty-five objectives "Red won" leaves everyone
          scrolling the log to find out how, and the answer is one line. */}
      {decider && (
        <p style={{ margin: 0, fontSize: "0.9rem", color: teamHex(decider.team) }}>
          {cellLabel(decider.cell_index, room.board_size)} on the {FACE_LABELS[decider.face]} side
          {ran.full ? " was the last square left." : " closed it."}
        </p>
      )}

      {/* The one place a practice match needs to say so out loud - by now archive_match() has
          already been skipped (or not), so this is purely informational, not a warning about to
          happen. */}
      {room.practice && (
        <p className="muted" style={{ margin: 0, fontSize: "0.8rem" }}>
          Practice match - not added to the Almanac or anyone's career stats.
        </p>
      )}

      <WatchBoard
        room={room}
        claims={claims}
        face={face}
        players={players}
        activeTeamsList={activeTeamsList}
        highlight={winningCells}
      />

      {/* Switching sides is allowed here as well as in the lobby, so a team can reshuffle without
          having to wait on the host resetting the room first - and without the only window being a
          lobby that reappears for a few seconds before the next match starts. */}
      <div style={{ width: "min(560px, 100%)" }}>
        <TeamPicker
          playerId={myPlayerId}
          currentTeam={myTeam}
          players={players}
          onError={setError}
        />
      </div>

      {error && <div className="error-text">{error}</div>}
      {/* Host only, deliberately. Starting the next match clears the claim log, and that right is not
          handed to the room at large - see the "claims delete by host" policy. A team whose host has
          gone dark isn't stuck: presence exposes a "Become host" takeover. */}
      <div className="stack" style={{ width: "min(320px, 100%)", gap: "0.4rem" }}>
        {isHost ? (
          <PlayAgainButton room={room} activeTeamsList={activeTeamsList} />
        ) : (
          <p className="muted" style={{ textAlign: "center", margin: 0 }}>
            Waiting for the host to start a new match...
          </p>
        )}
        {/* Between matches is the natural moment to bow out, so the way out lives here rather than
            only in the lobby everyone passes through in seconds. */}
        <LeaveMatchButton playerId={myPlayerId} roomCode={room.code} inMatch={false} label="Leave room" />
      </div>
    </div>
  );
}

/**
 * Sends the room back to the lobby for another match. Host only.
 *
 * Shared by the player's recap and the spectating host's, which is the whole reason it's its own
 * component - a host who isn't on a fleet sees the spectator's finished screen, and that screen
 * previously had no way to start the next game.
 */
function PlayAgainButton({ room, activeTeamsList }: { room: RoomType; activeTeamsList: number[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePlayAgain() {
    setBusy(true);
    setError(null);
    try {
      await resetRoomToLobby(room.id, activeTeamsList);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <>
      <button className="primary" disabled={busy} onClick={() => void handlePlayAgain()}>
        {busy ? "Starting..." : "Play again"}
      </button>
      {error && <div className="error-text">{error}</div>}
    </>
  );
}

/**
 * How the recap says who won, in the format's own words.
 *
 * "took it by points" is true and tells nobody anything. Under points the score IS the result, so it
 * goes in the sentence; under `line` the sentence is about a bingo, because that is what ended it.
 *
 * @param name the winner's team name, or null for the reader's own team.
 */
function verdict(
  name: string | null,
  /** Null only on a board that ran out, where nothing was actually met. */
  reason: WinReason | null,
  score: number | null,
  target: number,
  /** True when the board filled up and the score decided it rather than the condition. */
  ranOut = false
): string {
  const who = name ?? "You";
  const tally = score === null ? `${target}` : `${score}`;

  // A board that ran out was not won the way the format says it is won, and saying it was would be
  // a lie about the match everyone just played - under `line` most of all, where nobody got a bingo.
  if (ranOut) {
    return name === null
      ? `The board ran out. You took it on ${tally}.`
      : `The board ran out. ${who} took it on ${tally}.`;
  }
  if (reason === "majority") {
    return name === null ? "You took the majority of the board." : `${who} took the majority of the board.`;
  }
  if (reason === "line") {
    return name === null ? "You closed the bingo first." : `${who} closed the bingo first.`;
  }
  return name === null ? `You reached ${tally} points.` : `${who} reached ${tally} points.`;
}
