import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, ensureSignedIn } from "../lib/supabase";
import { getStoredPlayerId, storePlayerId } from "../lib/playerSession";
import { normalizeRoomCode } from "../lib/roomCode";
import { resetOwnTeamState } from "../lib/rooms";
import { setTeamNameOverrides } from "../lib/teamColors";
import { faceFromClaims } from "../lib/flipLogic";
import type { BoardFace, Room, Player, Claim, TeamReady } from "../types/bingoFlip";

export interface RoomState {
  loading: boolean;
  error: string | null;
  room: Room | null;
  players: Player[];
  myPlayer: Player | null;
  /**
   * Every square taken so far, oldest first. The entire state of a live match.
   *
   * There is no per-team counterpart to this and nothing hidden behind RLS, which is the largest
   * simplification the flip rework brought: Battleship needed a private `fleets` row per team, a
   * spectator-only reveal policy and a post-match reveal policy, all so that opponents could not
   * read each other's ships. A bingo board has no hidden information at all.
   */
  claims: Claim[];
  /**
   * Which face the board is showing, derived from the claims rather than stored.
   *
   * Every flip claim turns the board once and flip squares are consumed, so this is the parity of
   * the flip claims - which means it cannot drift out of step with the log that caused it, and it
   * arrives over realtime for free with the claim that changed it.
   */
  face: BoardFace;
  teamReady: TeamReady[];
  /**
   * Player ids currently connected, via Realtime Presence. `players` rows persist whether or
   * not a tab is open, so this is the only way to tell who is actually here - which drives the
   * roster's live dots and the "host has gone dark" takeover prompt.
   */
  onlinePlayerIds: string[];
  /** Realtime channel health. "offline" means live updates have stopped arriving. */
  connection: "connecting" | "online" | "offline";
}

const initialState: RoomState = {
  loading: true,
  error: null,
  room: null,
  players: [],
  myPlayer: null,
  claims: [],
  face: 0,
  teamReady: [],
  onlinePlayerIds: [],
  connection: "connecting",
};

/**
 * Row-by-row shallow equality, used to decide whether a refetch is worth a render.
 *
 * Every table this compares is flat scalar columns, so a shallow compare is a real compare - and
 * it is the cheap half of what makes resync() safe to call speculatively. Without it, each
 * re-read would hand React four brand-new arrays and repaint the whole match screen: both boards,
 * every marker, the log and the rosters. With it, the overwhelmingly common "we missed nothing"
 * case costs four indexed selects and not a single render. That matters more here than almost
 * anywhere else in the app, because this hook sits at the very top of the match tree - the same
 * reason the battle clock was moved out of it (see hooks/useBattlePhase.ts).
 *
 * Positional, not keyed: both sides come from the same ordered query. Rows sharing a created_at
 * could in principle come back in a different order and be read as a change. The cost of that is one
 * wasted render on a resync, so it isn't worth a tiebreaker.
 */
function sameRows<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as Record<string, unknown>;
    const y = b[i] as Record<string, unknown>;
    const keys = Object.keys(x);
    if (keys.length !== Object.keys(y).length) return false;
    for (const key of keys) if (x[key] !== y[key]) return false;
  }
  return true;
}

/**
 * Puts the claim log in order and derives the face from it, in one place.
 *
 * Every path that changes `claims` goes through here, so the face can never be updated by one of
 * them and missed by another - which is the failure the derived-face design exists to make
 * impossible. Sorting is by created_at because the face is a parity over an ordered log and realtime
 * does not promise arrival order.
 */
function withClaims(prev: RoomState, rows: Claim[]): RoomState {
  const claims = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (sameRows(claims, prev.claims)) return prev;
  return { ...prev, claims, face: faceFromClaims(claims) };
}

/**
 * Upsert one claim into the log, keyed by id.
 *
 * The no-change case returns `prev` by identity: this hook sits at the very top of the match tree,
 * so handing React a new array for a row it already has would repaint the board, every marker, the
 * log and the rosters for nothing.
 */
function withClaim(prev: RoomState, row: Claim): RoomState {
  const idx = prev.claims.findIndex((c) => c.id === row.id);
  if (idx >= 0 && sameRows([prev.claims[idx]], [row])) return prev;
  const claims = [...prev.claims];
  if (idx >= 0) claims[idx] = row;
  else claims.push(row);
  return withClaims(prev, claims);
}

/** Drops a released square from the log. Un-claiming turns the board back if that claim flipped it. */
function withoutClaim(prev: RoomState, id: string): RoomState {
  const claims = prev.claims.filter((c) => c.id !== id);
  if (claims.length === prev.claims.length) return prev;
  return withClaims(prev, claims);
}

export function useRoom(code: string | undefined) {
  const [state, setState] = useState<RoomState>(initialState);

  /**
   * The room's authoritative re-read, published for the visibility handler further down.
   *
   * A ref because resync() closes over both the room id and the subscription effect's `cancelled`
   * flag, so it can't be lifted out of that effect without dragging both along with it.
   */
  const resyncRef = useRef<(() => Promise<void>) | null>(null);

  const patch = useCallback((partial: Partial<RoomState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  // Initial load + realtime subscriptions
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    const channels: ReturnType<typeof supabase.channel>[] = [];

    (async () => {
      try {
        const userId = await ensureSignedIn();

        // Normalized so a hand-typed or shared-with-spaces URL still resolves to the room.
        const lookup = normalizeRoomCode(code);
        const { data: room, error: roomErr } = await supabase
          .from("rooms")
          .select()
          .eq("code", lookup)
          .maybeSingle();
        if (roomErr) throw roomErr;
        // A code that matches nothing is NOT an error - it's the ordinary end of a room's life.
        // Rooms are pruned an hour after they go quiet, so every stale link, every bookmark and
        // every "back to the room" in the top bar eventually lands here.
        //
        // This used to throw, which sent the page down the `state.error` branch: a bare line of red
        // text with no way out of it. The room-gone panel the page already had (see Room.tsx) was
        // unreachable for the entire case it was written for, and Room's roomGone check - the thing
        // that forgets the room so the top bar stops offering it - could never fire either, so the
        // dead link survived every visit. `error` is left for the failures that really are failures:
        // no network, no database, a rejected read.
        if (!room) {
          if (!cancelled) patch({ loading: false, error: null, room: null });
          return;
        }
        if (cancelled) return;

        const { data: players, error: playersErr } = await supabase
          .from("players")
          .select()
          .eq("room_id", room.id);
        if (playersErr) throw playersErr;

        // Match on user_id first, falling back to the stored player id. The auth session is the
        // real identity; the localStorage id is just a cache. Relying on the cache alone meant
        // that clearing it (while the auth session survived) dropped you back to the join form
        // as a stranger, even though your row - and your team - were sitting right there.
        const storedId = getStoredPlayerId(room.code);
        const myPlayer =
          (players ?? []).find((p) => p.user_id === userId) ??
          (players ?? []).find((p) => p.id === storedId) ??
          null;
        if (myPlayer) storePlayerId(room.code, myPlayer.id);

        const { data: claims, error: claimsErr } = await supabase
          .from("claims")
          .select()
          .eq("room_id", room.id)
          .order("created_at", { ascending: true });
        if (claimsErr) throw claimsErr;

        const { data: teamReady, error: teamReadyErr } = await supabase
          .from("team_ready")
          .select()
          .eq("room_id", room.id);
        if (teamReadyErr) throw teamReadyErr;

        if (cancelled) return;
        const loaded = (claims as Claim[]) ?? [];
        patch({
          loading: false,
          error: null,
          room: room as Room,
          players: (players as Player[]) ?? [],
          myPlayer,
          claims: loaded,
          face: faceFromClaims(loaded),
          teamReady: (teamReady as TeamReady[]) ?? [],
        });

        const roomId = room.id;

        /**
         * Claims arriving from realtime.
         *
         * Registered for INSERT and UPDATE both, rather than once for "*", so that DELETE can have a
         * handler of its own: a deleted row arrives as payload.old, and a shared handler reading
         * payload.new would be handed `{}`.
         *
         * `claims` carries replica identity full for that reason - without it the old row comes back
         * as the primary key alone, the room filter has nothing to match, and releasing a square
         * leaves it shown as taken on every other client. If it was the flip claim, they are left on
         * the wrong face too, since the face is a parity over this log.
         */
        const onClaimChange = (payload: { new: unknown }) => {
          setState((prev) => withClaim(prev, payload.new as Claim));
        };

        const onClaimDelete = (payload: { old: unknown }) => {
          const row = payload.old as { id?: string };
          if (row?.id) setState((prev) => withoutClaim(prev, row.id as string));
        };

        /**
         * Re-reads everything the realtime channel may have missed.
         *
         * Defined before the channel that calls it, and deliberately cheap to call on spec:
         * overlapping calls collapse into the one already in flight, and a read that finds nothing
         * new returns the previous arrays by identity so React bails out of the render entirely.
         * Both properties exist so that the callers below can be blunt about when to re-read
         * rather than clever, because every "clever" gate is a way to stay stale.
         */
        let inFlight: Promise<void> | null = null;

        function resync(): Promise<void> {
          inFlight ??= readEverything().finally(() => {
            inFlight = null;
          });
          return inFlight;
        }

        async function readEverything() {
          const [{ data: freshPlayers }, { data: freshClaims }, { data: freshReady }, { data: freshRoom }] =
            await Promise.all([
              supabase.from("players").select().eq("room_id", roomId),
              supabase.from("claims").select().eq("room_id", roomId).order("created_at", { ascending: true }),
              supabase.from("team_ready").select().eq("room_id", roomId),
              supabase.from("rooms").select().eq("id", roomId).maybeSingle(),
            ]);
          if (cancelled) return;
          setState((prev) => {
            const room = (freshRoom as Room) ?? prev.room;
            const players = (freshPlayers as Player[]) ?? prev.players;
            const claims = (freshClaims as Claim[]) ?? prev.claims;
            const teamReady = (freshReady as TeamReady[]) ?? prev.teamReady;

            // Stringified rather than shallow-compared: `rooms` carries flip_cells and team_names,
            // which come back as fresh arrays every read and would report a change on every pass.
            // It's one small object, only on a resync.
            const roomSame = JSON.stringify(room) === JSON.stringify(prev.room);
            const playersSame = sameRows(players, prev.players);
            const claimsSame = sameRows(claims, prev.claims);
            const readySame = sameRows(teamReady, prev.teamReady);
            if (roomSame && playersSame && claimsSame && readySame) return prev;

            return {
              ...prev,
              room: roomSame ? prev.room : room,
              players: playersSame ? prev.players : players,
              claims: claimsSame ? prev.claims : claims,
              face: claimsSame ? prev.face : faceFromClaims(claims),
              teamReady: readySame ? prev.teamReady : teamReady,
            };
          });
        }

        resyncRef.current = resync;

        channels.push(
          supabase
            .channel(`room-${roomId}`)
            // UPDATE only: a room is never inserted while we're already watching it, and on DELETE
            // payload.new is {} - so "*" meant the pruner could quietly replace the entire room
            // object with an empty one.
            .on(
              "postgres_changes",
              { event: "UPDATE", schema: "public", table: "rooms", filter: `id=eq.${roomId}` },
              (payload) => {
                const next = payload.new as Room;
                setState((prev) => {
                  // Returning to the lobby is also how a client learns the claim log was wiped.
                  // resetRoomToLobby() deletes every claim row in one statement, and the deletes do
                  // arrive one by one - but this must not WAIT for them: they race the status
                  // update, and a client that applied the status first would open the next match
                  // with the last one's squares still on the board until they trickled in.
                  //
                  // The face goes back to light with it, for free: it is a parity over this log.
                  const returnedToLobby = prev.room?.status !== "lobby" && next.status === "lobby";
                  return returnedToLobby
                    ? { ...prev, room: next, claims: [], face: 0 as BoardFace }
                    : { ...prev, room: next };
                });
              }
            )
            .on(
              "postgres_changes",
              { event: "*", schema: "public", table: "players", filter: `room_id=eq.${roomId}` },
              (payload) => {
                setState((prev) => {
                  const players = [...prev.players];
                  const storedId = getStoredPlayerId(prev.room?.code ?? code);
                  let myPlayer = prev.myPlayer;

                  if (payload.eventType === "DELETE") {
                    const removedId = (payload.old as Player).id;
                    const idx = players.findIndex((p) => p.id === removedId);
                    if (idx >= 0) players.splice(idx, 1);
                    // Was it my own row? (e.g. kicked by the host) - clear it rather than
                    // keeping a stale reference to a player row that no longer exists.
                    if (removedId === storedId) myPlayer = null;
                  } else {
                    const row = payload.new as Player;
                    const idx = players.findIndex((p) => p.id === row.id);
                    if (idx >= 0) players[idx] = row;
                    else players.push(row);
                    if (row.id === storedId) myPlayer = row;
                  }

                  return { ...prev, players, myPlayer };
                });
              }
            )
            // Claims are the whole match, so this is where the message bill lives. All three events
            // are needed:
            //
            // INSERT - a square taken.
            // DELETE - a square released.
            // UPDATE - the one edit a claim can receive. When a team releases a flip square that
            //          another team also holds, unclaim_square() promotes the oldest surviving claim
            //          to carry `flipped`, so that exactly one claim per flip cell turns the board.
            //          That is an UPDATE, and without it every other client counts one flip fewer
            //          than the database does and draws the WRONG FACE for the rest of the match.
            //          Reachable under non-lockout only, and rare there, so it costs next to nothing.
            //
            // Every one of them is filtered to this room, DELETE included - which works only because
            // `claims` carries replica identity full (see the initial schema), so the old row the
            // filter is matched against still has its room_id on it. Unfiltered, every browser in
            // every room received every other room's deletes.
            .on(
              "postgres_changes",
              { event: "INSERT", schema: "public", table: "claims", filter: `room_id=eq.${roomId}` },
              onClaimChange
            )
            .on(
              "postgres_changes",
              { event: "UPDATE", schema: "public", table: "claims", filter: `room_id=eq.${roomId}` },
              onClaimChange
            )
            .on(
              "postgres_changes",
              { event: "DELETE", schema: "public", table: "claims", filter: `room_id=eq.${roomId}` },
              onClaimDelete
            )
            .on(
              "postgres_changes",
              { event: "*", schema: "public", table: "team_ready", filter: `room_id=eq.${roomId}` },
              (payload) => {
                setState((prev) => {
                  if (payload.eventType === "DELETE") {
                    const removed = payload.old as TeamReady;
                    return { ...prev, teamReady: prev.teamReady.filter((t) => t.team !== removed.team) };
                  }
                  const teamReady = [...prev.teamReady];
                  const row = payload.new as TeamReady;
                  const idx = teamReady.findIndex((t) => t.team === row.team);
                  if (idx >= 0) teamReady[idx] = row;
                  else teamReady.push(row);
                  return { ...prev, teamReady };
                });
              }
            )
            .subscribe((status) => {
              // A dropped channel used to be completely silent: the board simply stopped
              // updating and players assumed the game had frozen. Surface it, and re-read
              // everything on recovery, because any change that happened while we were away
              // was never replayed to us.
              if (cancelled) return;
              if (status === "SUBSCRIBED") {
                // Re-read on EVERY join, including the first one, and not only when we'd first
                // noticed going offline.
                //
                // The offline gate went first: it assumed a lost connection always announces
                // itself, and it doesn't - phoenix skips the error callback for a channel that is
                // already errored or closed, so a socket that dies quietly and comes back leaves
                // `connection` on "online" and every row that landed in the gap stays missing
                // until the page is reloaded.
                //
                // The FIRST-join gate went next, and it was the same mistake one step earlier. It
                // assumed the initial read above already held everything, but that read runs
                // before the websocket has even connected, so anything committed between the
                // select and the channel joining is lost permanently - there is no replay. That
                // window is where a shot gets stranded on "...": the row is read while it is still
                // pending and the UPDATE that settles it arrives during the handshake. Auto-fire
                // is what made that routine rather than theoretical, because the edge function
                // inserts and resolves back to back, so the two are milliseconds apart instead of
                // however long a human takes to answer.
                //
                // resync() no-ops when nothing changed, so being blunt here is close to free.
                void resync();
                setState((prev) => (prev.connection === "online" ? prev : { ...prev, connection: "online" }));
              } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
                setState((prev) => (prev.connection === "offline" ? prev : { ...prev, connection: "offline" }));
              }
            })
        );

      } catch (e) {
        if (!cancelled) patch({ loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();

    return () => {
      cancelled = true;
      resyncRef.current = null;
      channels.forEach((c) => supabase.removeChannel(c));
    };
  }, [code, patch]);

  /**
   * Re-read the room whenever the tab comes back to the foreground.
   *
   * -- Why a backgrounded tab goes stale in the first place -----------------------------------
   *
   * Supabase stops refreshing the access token while the tab is hidden - auth-js does this
   * deliberately, so that several tabs can't race each other through a rotating refresh token.
   * The access token lasts an hour (supabase/config.toml, jwt_expiry). Realtime validates that
   * token per channel, so a tab left hidden long enough loses its channel, and the rejoin that
   * follows presents the same expired token and fails just as well. The board freezes, and no
   * amount of waiting fixes it: the only thing that restarts the token ticker is the tab
   * becoming visible again.
   *
   * A player claiming squares is looking at the page, so for them this is rare. The tabs that do sit
   * hidden for an hour are the ones with nothing to click: a spectator, a caster with the room open
   * on a second monitor, an OBS source behind another scene. Those are exactly the tabs whose whole
   * job is to be correct at the moment somebody finally looks at them.
   *
   * -- Why this is enough --------------------------------------------------------------------
   *
   * A plain PostgREST read is itself what un-sticks the token: supabase-js resolves the session
   * before every request and refreshes it if it has expired, which emits TOKEN_REFRESHED, which
   * hands realtime the new token and lets the channel rejoin. So re-reading here repairs the
   * data AND the connection, without reaching into auth-js's own visibility handling to countermand
   * it - which would put the rotating-refresh-token race back on the table.
   *
   * Nothing is fetched while hidden. Nobody is looking, the claim log accumulates in the database
   * either way, and polling a background tab is exactly the cost this is supposed to avoid.
   */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void resyncRef.current?.();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);


  // Resync everything whenever the match changes phase.
  //
  // Realtime DELETEs are subscribed for un-claiming, but the mass delete at the end of a match
  // deliberately is not (see the claims channel above), so re-read the authoritative state on each
  // phase change - it happens a handful of times per match.
  const lastStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const room = state.room;
    if (!room) return;
    if (lastStatusRef.current === room.status) return;
    lastStatusRef.current = room.status;

    let cancelled = false;
    (async () => {
      const [{ data: claims }, { data: teamReady }] = await Promise.all([
        supabase.from("claims").select().eq("room_id", room.id).order("created_at", { ascending: true }),
        supabase.from("team_ready").select().eq("room_id", room.id),
      ]);
      if (cancelled) return;
      const rows = (claims as Claim[]) ?? [];
      patch({
        claims: rows,
        face: faceFromClaims(rows),
        teamReady: (teamReady as TeamReady[]) ?? [],
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [state.room, patch]);

  // Self-heal on match reset. RLS scopes `team_ready` writes to the owning team, so the host
  // physically cannot clear everyone else's flag - each client clears its own as soon as it sees the
  // room back in 'lobby' still holding a stale ready.
  //
  // Battleship had far more to heal here: a board-size or fleet change left every fleet row the
  // wrong shape, and a stale ship_hits_remaining meant a hull that never finished sinking. None of
  // that exists now. The board is derived from the room, so changing its size changes nothing that
  // needs repairing, and the claim log is empty in the lobby by construction.
  const resettingRef = useRef(false);
  useEffect(() => {
    const room = state.room;
    const team = state.myPlayer?.team;
    if (!room || team === null || team === undefined) return;
    if (room.status !== "lobby") return;

    const mine = state.teamReady.find((t) => t.team === team);
    if (!mine?.ready) return; // already clean
    if (resettingRef.current) return;

    resettingRef.current = true;
    (async () => {
      try {
        await resetOwnTeamState(room, team);
      } catch {
        // Nothing actionable for the player here; the lobby still works.
      } finally {
        resettingRef.current = false;
      }
    })();
  }, [state.room, state.teamReady, state.myPlayer?.team]);

  // There is deliberately NO client-side win detection here.
  //
  // Battleship needed two effects at this point: one driving resolve_attack() for every pending
  // shot, and one that watched for the last fleet standing and wrote the result. Both are gone.
  // claim_square() settles lockout, the flip and the win in a single statement under the room lock,
  // so the winner is decided once, by Postgres, at the moment the deciding square is taken - and it
  // arrives here as an ordinary room UPDATE like any other.
  //
  // That also removes the reason the old version was so careful about WHO ran it. There is no longer
  // a client that has to notice something on another client's behalf, so a team closing its tab
  // cannot strand a match, and two clients cannot race to declare different winners.

  // Realtime Presence: announce ourselves and track who else is actually connected.
  const myPlayerId = state.myPlayer?.id;
  const roomId = state.room?.id;
  useEffect(() => {
    if (!roomId || !myPlayerId) return;

    const channel = supabase.channel(`presence-${roomId}`, {
      config: { presence: { key: myPlayerId } },
    });

    const syncOnline = () => {
      const ids = Object.keys(channel.presenceState());
      setState((prev) =>
        // Skip the update when membership is unchanged - presence fires sync events liberally,
        // and a fresh array identity each time would re-render the whole room for nothing.
        prev.onlinePlayerIds.length === ids.length && ids.every((id) => prev.onlinePlayerIds.includes(id))
          ? prev
          : { ...prev, onlinePlayerIds: ids }
      );
    };

    channel
      .on("presence", { event: "sync" }, syncOnline)
      .on("presence", { event: "join" }, syncOnline)
      .on("presence", { event: "leave" }, syncOnline)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void channel.track({ online_at: new Date().toISOString() });
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [roomId, myPlayerId]);

  // If the room has no host at all (the previous one was kicked, left, or their row was pruned),
  // promote the longest-tenured player. Without this the room is permanently unmanageable: no
  // one can start placement, kick, end the match, or play again. Deterministic server-side
  // ordering makes concurrent callers pick the same winner, so racing is harmless.
  useEffect(() => {
    if (!roomId) return;
    if (state.players.length === 0) return;
    if (state.players.some((p) => p.is_host)) return;
    void supabase.rpc("ensure_room_host", { p_room_id: roomId });
  }, [roomId, state.players]);

  // Publish this room's custom team names before anything downstream renders.
  //
  // Deliberately during render rather than in an effect: teamName() reads a module registry (see
  // lib/teamColors.ts for why it isn't threaded through props), and an effect fires only AFTER
  // children have already rendered - so a rename would display the stale name until some unrelated
  // state change forced another pass. This runs above every consumer in the tree and is a pure
  // function of state.room, so it produces the same result on every re-render.
  setTeamNameOverrides(state.room?.team_names);

  // Clear on unmount so leaving a room doesn't leak its names onto the home page's match history
  // or the leaderboard, which have no room of their own to override them.
  useEffect(() => () => setTeamNameOverrides(null), []);

  return state;
}
