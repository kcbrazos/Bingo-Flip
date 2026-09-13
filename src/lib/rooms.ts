import { supabase, ensureSignedIn } from "./supabase";
import { generateRoomCode, normalizeRoomCode, formatRoomCode, generateRejoinCode, generateSeed } from "./roomCode";
import { storePlayerId } from "./playerSession";
import { flipCellsFor } from "./flipLogic";
import { DEFAULT_FLIP_COUNT, DEFAULT_LOCKOUT, DEFAULT_WIN_CONDITION } from "../types/bingoFlip";
import type { Room, Player, WinCondition } from "../types/bingoFlip";
import type { StoredCustomSquareSet } from "./squareSets";

export interface RoomOptions {
  startingSeconds?: number;
  prepSeconds?: number;
  squareSet?: string;
  winCondition?: WinCondition;
  flipCount?: number;
  lockout?: boolean;
  bonusPerBingo?: number;
  targetScore?: number;
}

export async function createRoom(
  nickname: string,
  boardSize: number,
  options: RoomOptions = {}
): Promise<{ room: Room; player: Player }> {
  const userId = await ensureSignedIn();

  let room: Room | null = null;
  // Retry on the (rare) chance of a room-code collision.
  for (let attempt = 0; attempt < 5 && !room; attempt++) {
    // Pass the attempt so repeated collisions escalate to a numeric-suffixed code.
    const code = generateRoomCode(attempt);
    const payload: Record<string, unknown> = {
      code,
      board_size: boardSize,
      seed: generateSeed(),
      win_condition: options.winCondition ?? DEFAULT_WIN_CONDITION,
      flip_count: options.flipCount ?? DEFAULT_FLIP_COUNT,
      lockout: options.lockout ?? DEFAULT_LOCKOUT,
    };
    if (options.squareSet !== undefined) payload.square_set = options.squareSet;
    if (options.startingSeconds !== undefined) payload.starting_seconds = options.startingSeconds;
    if (options.prepSeconds !== undefined) payload.prep_seconds = options.prepSeconds;

    const { data, error } = await supabase.from("rooms").insert(payload).select().single();
    if (!error) {
      room = data as Room;
      break;
    }
    if (error.code === "23505") continue; // room-code collision, try another
    throw error;
  }
  if (!room) throw new Error("Could not allocate a room code, please try again.");

  const { data: player, error: playerError } = await supabase
    .from("players")
    .insert({ room_id: room.id, user_id: userId, nickname, is_host: true, team: null })
    .select()
    .single();
  if (playerError) throw playerError;

  storePlayerId(room.code, player.id);
  await ensureRejoinCode(player as Player);
  return { room, player: player as Player };
}

/**
 * Gives a player row a rejoin code if it doesn't have one yet.
 *
 * Assigned once and never rotated - a code that changed on every reconnect would be useless as
 * the thing you write down. Silently no-ops when the column is missing (migration not applied),
 * so joining a room never fails over a recovery convenience.
 */
async function ensureRejoinCode(player: Player): Promise<string | null> {
  if (player.rejoin_code) return player.rejoin_code;
  const code = generateRejoinCode();
  const { error } = await supabase.from("players").update({ rejoin_code: code }).eq("id", player.id);
  if (error) return null;
  player.rejoin_code = code;
  return code;
}

/**
 * Takes over an existing player row using its rejoin code, recovering the seat and the team that
 * belonged to it. Returns the player id, or null if the code doesn't match anything here.
 */
export async function redeemRejoinCode(roomCode: string, rejoinCode: string): Promise<string | null> {
  await ensureSignedIn();
  const { data, error } = await supabase.rpc("claim_player_slot", {
    p_room_code: normalizeRoomCode(roomCode),
    p_rejoin_code: rejoinCode.trim().toUpperCase(),
  });
  if (error) throw error;
  if (!data) return null;
  storePlayerId(normalizeRoomCode(roomCode), data as string);
  return data as string;
}

export async function joinRoom(code: string, nickname: string): Promise<{ room: Room; player: Player }> {
  const userId = await ensureSignedIn();

  // Normalized, not just uppercased: a code read aloud gets typed back as "salty kraken" or
  // "Salty-Kraken" just as often as the stored "SALTYKRAKEN", and all of those must resolve.
  const lookup = normalizeRoomCode(code);
  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select()
    .eq("code", lookup)
    .maybeSingle();
  if (roomError) throw roomError;
  if (!room) throw new Error(`No room found with code ${formatRoomCode(lookup)}`);

  // Look before writing. This used to be a blind upsert including `team: null, is_host: false`,
  // which meant re-entering a room you were already in silently reset your team choice and
  // stripped your host status - the exact situation this path exists to recover from. Rejoining
  // now only refreshes the nickname and leaves everything you'd already earned alone.
  const { data: existing } = await supabase
    .from("players")
    .select()
    .eq("room_id", room.id)
    .eq("user_id", userId)
    .maybeSingle();

  let player: Player;
  if (existing) {
    const { data: updated, error: updateErr } = await supabase
      .from("players")
      .update({ nickname })
      .eq("id", existing.id)
      .select()
      .single();
    if (updateErr) throw updateErr;
    player = updated as Player;
  } else {
    const { data: inserted, error: insertErr } = await supabase
      .from("players")
      .insert({ room_id: room.id, user_id: userId, nickname, team: null, is_host: false })
      .select()
      .single();
    if (insertErr) throw insertErr;
    player = inserted as Player;
  }

  storePlayerId(room.code, player.id);
  await ensureRejoinCode(player);
  return { room: room as Room, player };
}

/**
 * Moves a player onto a team (or to spectating).
 *
 * Stamps team_joined_at, which is what decides captaincy - earliest pick on a team runs it. Set
 * fresh on every change rather than only the first, so leaving a fleet and coming back puts you at
 * the back of the queue instead of letting you reclaim command by bouncing out and in.
 */
export async function setPlayerTeam(playerId: string, team: number | null): Promise<void> {
  const patch: Record<string, unknown> = { team, team_joined_at: team === null ? null : new Date().toISOString() };
  const { error } = await supabase.from("players").update(patch).eq("id", playerId);

  // Pre-migration projects don't have the column; the team change itself still matters.
  if (error && /team_joined_at/i.test(error.message)) {
    const { error: retry } = await supabase.from("players").update({ team }).eq("id", playerId);
    if (retry) throw retry;
    return;
  }
  if (error) throw error;
}

/**
 * Renames one team. Offered only to the host in the UI; RLS additionally requires the caller to
 * be a player in this room (it used to allow literally anyone - see the lock_down_writes migration).
 *
 * Read-modify-write on a jsonb array, so it reads the current value first rather than assuming
 * what's in local state. A blank name clears the override and the team falls back to its color
 * name, which is also how you undo a rename.
 */
export async function setTeamName(roomId: string, team: number, name: string): Promise<void> {
  const { data: room, error: readErr } = await supabase
    .from("rooms")
    .select("team_names")
    .eq("id", roomId)
    .single();
  if (readErr) throw readErr;

  const names: (string | null)[] = Array.isArray(room?.team_names) ? [...room.team_names] : [];
  // Pad rather than assign past the end: a sparse JS array serializes to nulls anyway, but going
  // through jsonb round-trips holes into `null` inconsistently across drivers.
  while (names.length <= team) names.push(null);
  const trimmed = name.trim().slice(0, 24);
  names[team] = trimmed.length > 0 ? trimmed : null;

  const { error } = await supabase.from("rooms").update({ team_names: names }).eq("id", roomId);
  if (error) throw error;
}

/**
 * Rolls a fresh randomizer seed for the room, on demand.
 *
 * Returning to the lobby now rolls one automatically (see resetRoomToLobby) - a second match on the
 * previous match's seed means replaying the same randomized world, which nobody wanted. This button
 * stays for rolling again within a lobby: the host reads the number out, somebody doesn't like it,
 * or a late joiner needs one before anyone has set their game up.
 */
export async function rerollSeed(roomId: string): Promise<string> {
  const seed = generateSeed();
  const { error } = await supabase.from("rooms").update({ seed }).eq("id", roomId);
  if (error) throw error;
  return seed;
}

export interface RoomSettings {
  board_size?: number;
  prep_seconds?: number;
  square_set?: string;
  /** Set alongside `square_set: CUSTOM_SQUARE_SET_ID`. See StoredCustomSquareSet. */
  custom_square_set?: StoredCustomSquareSet | null;
  win_condition?: WinCondition;
  flip_count?: number;
  lockout?: boolean;
  bonus_per_bingo?: number;
  target_score?: number;
  /** True when this match should never be archived. See PRACTICE_MODES. */
  practice?: boolean;
}

/**
 * Changes the match settings on an existing room. Lobby only, and only offered to the host.
 *
 * These used to be fixed at creation from the front page, which meant getting the board size wrong
 * cost you the room and everyone in it. RLS allows any player in the room to write `rooms`, so the
 * host-only part is the UI's doing - the same arrangement as starting the match.
 *
 * Nothing downstream needs repairing when these change, unlike Battleship, where a board-size change
 * left every fleet row the wrong shape and each client had to heal its own. There are no per-team
 * rows here to invalidate: the board is derived from the room, and the claim log is empty until the
 * match starts.
 */
export async function updateRoomSettings(roomId: string, settings: RoomSettings): Promise<void> {
  const { error } = await supabase.from("rooms").update(settings).eq("id", roomId);
  if (error) throw error;
}

/**
 * Renames a player - yourself, or anyone in the room if you're the host.
 *
 * Checks the RETURNED ROWS, not just `error`. RLS makes an UPDATE with no matching policy affect
 * zero rows and report NO error, so a host renaming a crewmate with the "players update by host"
 * policy missing looked exactly like a success and silently did nothing - which is precisely how
 * this shipped. Same failure mode the attack-log delete in resetRoomToLobby guards against, and the
 * same reason the kick button was broken before "players delete by host" existed.
 */
export async function renamePlayer(playerId: string, nickname: string): Promise<void> {
  const { data, error } = await supabase
    .from("players")
    .update({ nickname })
    .eq("id", playerId)
    .select("id");
  if (error) throw error;
  if ((data ?? []).length === 0) {
    throw new Error(
      "The database refused that rename. If you're renaming someone else, the room needs the " +
        '"players update by host" policy - see ' +
        "supabase/migrations/20260817000000_initial_schema.sql."
    );
  }
}

/** Host-only: removes another player from the room. RLS enforces the caller is actually the host. */
export async function kickPlayer(playerId: string): Promise<void> {
  const { data, error } = await supabase.from("players").delete().eq("id", playerId).select("id");
  if (error) throw error;
  if ((data ?? []).length === 0) {
    throw new Error(
      "The database refused that kick - it removed nobody. The room needs the " +
        '"players delete by host" policy; see ' +
        "supabase/migrations/20260817000000_initial_schema.sql."
    );
  }
}

/**
 * Leaves the room for good, deleting the player row.
 *
 * Deleting rather than just navigating away matters: it's what lets ensure_room_host() notice
 * the room has lost its host and promote someone else. A host who merely closes the tab leaves
 * their row (and their hosting) behind, which is what the presence-gated takeover is for.
 */
export async function leaveRoom(playerId: string): Promise<void> {
  const { error } = await supabase.from("players").delete().eq("id", playerId);
  if (error) throw error;
}

/**
 * Takes over hosting. The UI only offers this when presence shows the current host offline.
 *
 * Can be legitimately refused, which is why the returned flag is checked rather than only the
 * error. Since the front page started publishing live battles, the room can be joined by people it
 * has never met, and hosting is the key to every other host-only lock - so the function now grants
 * it only to someone who was in the room before the match started (see the
 * spectators_cannot_disrupt migration). A stranger who walked in mid-battle gets `false`.
 */
export async function claimHost(playerId: string): Promise<void> {
  const { data, error } = await supabase.rpc("claim_room_host", { p_player_id: playerId });
  if (error) throw error;
  if (data === false) {
    throw new Error(
      "Only someone who was already in this room when the match started can take over hosting."
    );
  }
}

/**
 * Captain-only: hands command of the team to a teammate.
 *
 * Goes through an RPC rather than an update because it writes another player's row, which
 * "players update own" forbids from the browser. The function re-checks the caller is the current
 * captain and that the room is still in the lobby, so this is enforced, not merely unoffered.
 */
export async function handOverCaptaincy(targetPlayerId: string): Promise<void> {
  const { error } = await supabase.rpc("hand_over_captaincy", { p_target: targetPlayerId });
  if (!error) return;

  // PostgREST reports an unknown function as PGRST202. Worth naming, because the symptom before the
  // migration is run is a button that fails with "schema cache" and nothing that says why.
  if (error.code === "PGRST202" || /hand_over_captaincy/.test(error.message)) {
    throw new Error(
      "This room's database doesn't have the handover function yet - see " +
        "supabase/migrations/20260817010000_room_management.sql."
    );
  }
  throw error;
}

/** Marks a team ready (or not) in the lobby. Safe to call repeatedly. */
export async function setTeamReady(roomId: string, team: number, ready: boolean): Promise<void> {
  const { error } = await supabase
    .from("team_ready")
    .upsert({ room_id: roomId, team, ready }, { onConflict: "room_id,team" });
  if (error) throw error;
}

/**
 * Opens the match.
 *
 * Writes the flip squares, the start instant and the status in that order, so no client can enter
 * 'battle' and find a board with no flip squares on it or a clock with nothing to count from.
 *
 * The flip squares are computed HERE, in the host's browser, and written to the room. That is the
 * one part of the board that is stored rather than derived, because claim_square() has to know
 * whether the square just taken turns the board over, and re-deriving it would mean a second copy of
 * the client's PRNG living in plpgsql and agreeing with it forever. It costs nothing in secrecy:
 * flip squares are marked on the board by design, so this writes down something every player can
 * already see. The database freezes the column once the room leaves the lobby.
 */
export async function startBattle(room: Room): Promise<void> {
  const flipCells = flipCellsFor(
    room.id,
    room.board_size,
    room.flip_count ?? DEFAULT_FLIP_COUNT,
    room.seed
  );

  const patch: Record<string, unknown> = {
    flip_cells: flipCells,
    started_at: new Date().toISOString(),
    status: "battle",
    // Cleared rather than assumed empty: a rematch reuses this room row, and a match that ended
    // mid-pause (the host used "End match" instead of resuming first) would otherwise open the
    // next one already paused.
    paused_at: null,
    pause_votes: [],
  };
  const { error } = await supabase.from("rooms").update(patch).eq("id", room.id);

  // Pre-migration rooms don't have these columns yet; opening the match still matters more than
  // clearing a pause state that column's own absence proves can't exist. Same fallback shape as
  // setPlayerTeam's team_joined_at retry above.
  if (error && /paused_at|pause_votes/i.test(error.message)) {
    delete patch.paused_at;
    delete patch.pause_votes;
    const { error: retry } = await supabase.from("rooms").update(patch).eq("id", room.id);
    if (retry) throw retry;
    return;
  }
  if (error) throw error;
}

/**
 * Moves the room into the preparation phase, where both faces can be read but nothing claimed.
 *
 * Battleship's equivalent was the placement phase, and it had work to do in it. This one is a
 * reading beat: the ready flags are cleared so every team has to confirm they have looked at both
 * faces before the host can open the match.
 */
export async function beginPrepPhase(roomId: string): Promise<void> {
  const { error: roomErr } = await supabase.from("rooms").update({ status: "prep" }).eq("id", roomId);
  if (roomErr) throw roomErr;

  const { error: readyErr } = await supabase.from("team_ready").delete().eq("room_id", roomId);
  if (readyErr) throw readyErr;
}

/**
 * Asks (or un-asks) for the match to pause, on behalf of the calling player's team.
 *
 * A vote, not a command: pausing and resuming both need every active team to agree, the same
 * unanimity the readiness gate uses, so a request array is what's written to rather than a request
 * that immediately takes effect. Room.tsx watches this alongside the room and has the host flip
 * `paused_at` once the votes line up in either direction - see pauseMatch and resumeMatch below.
 *
 * Goes through an RPC rather than a plain update because two teams voting at once would otherwise
 * race a read-modify-write on the same array and one could silently overwrite the other's vote.
 */
export async function requestPause(roomId: string, team: number, want: boolean): Promise<void> {
  const { error } = await supabase.rpc("request_pause", {
    p_room_id: roomId,
    p_team: team,
    p_want: want,
  });
  if (error) throw error;
}

/**
 * Actually pauses the match. Called only once every active team's vote is in - see the effect in
 * Room.tsx - and only by the host's client, same as startBattle: `paused_at` is one of the columns
 * every client's clock is anchored to, and guard_match_open refuses this write from anyone else.
 */
export async function pauseMatch(roomId: string): Promise<void> {
  const { error } = await supabase.from("rooms").update({ paused_at: new Date().toISOString() }).eq("id", roomId);
  if (error) throw error;
}

/**
 * Un-pauses the match by sliding `started_at` forward by however long it sat paused.
 *
 * That's the entire resume: every phase is computed from `started_at` and the current instant (see
 * matchTime.ts), so a match that was 90 seconds into its preparation countdown when it paused is
 * still exactly 90 seconds in the moment it resumes, no matter how long the pause itself lasted.
 * `pause_votes` is cleared in the same statement so the next pause starts from nobody having asked.
 */
export async function resumeMatch(room: Room): Promise<void> {
  if (!room.paused_at || !room.started_at) return;
  const pausedMs = Date.now() - new Date(room.paused_at).getTime();
  const shiftedStart = new Date(new Date(room.started_at).getTime() + Math.max(0, pausedMs)).toISOString();

  const { error } = await supabase
    .from("rooms")
    .update({ started_at: shiftedStart, paused_at: null, pause_votes: [] })
    .eq("id", room.id);
  if (error) throw error;
}

/**
 * Claims one square for the calling player's team.
 *
 * Returns the team that owns the square afterwards, which is NOT necessarily the caller's: losing a
 * square to an opponent who finished the same objective a moment earlier is an ordinary outcome of
 * lockout, not an error, and the caller is told who got it rather than thrown at.
 *
 * Everything that has to be decided together - lockout, which face this landed on, whether the
 * square flips the board, whether it wins the match - is decided inside claim_square() under the
 * room lock. There is deliberately no INSERT policy on `claims`, so this RPC is the only way in.
 */
export async function claimSquare(roomId: string, cellIndex: number): Promise<number | null> {
  const { data, error } = await supabase.rpc("claim_square", {
    p_room_id: roomId,
    p_cell_index: cellIndex,
  });
  if (error) throw error;
  return (data ?? null) as number | null;
}

/**
 * Gives a square back, for the misclick that EldenBingo's un-mark exists to undo.
 *
 * Only the team holding it may release it. A claim that flipped the board takes the flip with it,
 * which needs no special handling: the face is the parity of the surviving flip claims, so removing
 * one turns the board back on its own.
 */
export async function unclaimSquare(roomId: string, cellIndex: number): Promise<boolean> {
  const { data, error } = await supabase.rpc("unclaim_square", {
    p_room_id: roomId,
    p_cell_index: cellIndex,
  });
  if (error) throw error;
  return data === true;
}

/**
 * Resets a team's OWN ready row. Called by each client for its own team when it sees the room drop
 * back to 'lobby' - deliberately not done centrally by the host, because RLS scopes `team_ready`
 * writes to the owning team, and a host-driven loop silently wrote zero rows for every team but
 * their own.
 */
export async function resetOwnTeamState(room: Room, team: number): Promise<void> {
  // Update rather than delete: the per-team update policy exists, a delete policy may not.
  const { error } = await supabase
    .from("team_ready")
    .upsert({ room_id: room.id, team, ready: false }, { onConflict: "room_id,team" });
  if (error) throw error;
}

export async function resetRoomToLobby(roomId: string, activeTeamsList: number[] = []): Promise<void> {
  // Deliberately does NOT archive first. A match abandoned part-way through isn't a result, and
  // recording it would pollute records with half-played games - so ending early bins the whole
  // thing. Archiving happens only when a match actually reaches its conclusion.

  // Clear the claim log first, so no square from the last match survives onto the next board.
  //
  // This must check the RETURNED ROWS, not just `error`: Postgres RLS makes a DELETE with no
  // matching policy affect zero rows and report NO error at all. Checking only `error` made a
  // completely blocked delete look like a success, which is why Battleship's "End match" appeared to
  // work and left the previous match's hits on the board.
  const { data: before } = await supabase.from("claims").select("id").eq("room_id", roomId).limit(1);
  const hadClaims = (before ?? []).length > 0;

  const { data: deleted, error: claimsErr } = await supabase
    .from("claims")
    .delete()
    .eq("room_id", roomId)
    .select("id");
  if (claimsErr) throw claimsErr;

  if (hadClaims && (deleted ?? []).length === 0) {
    throw new Error(
      "Can't clear the previous match's squares: the database is rejecting the delete. Only the " +
        'host may clear a claim log - see the "claims delete by host" policy in ' +
        "supabase/migrations/20260817000000_initial_schema.sql."
    );
  }

  // Best-effort: clear the ready flag for any team we're allowed to write. Each client also
  // self-heals on seeing 'lobby', so teams we can't touch here clean themselves up.
  for (const team of activeTeamsList) {
    await supabase
      .from("team_ready")
      .update({ ready: false })
      .eq("room_id", roomId)
      .eq("team", team);
  }

  // A fresh seed for the next match, rolled in the same write as the status flip so there is no
  // moment where the lobby is open on the match everyone has just played. Both routes back to the
  // lobby come through here - "Play again" off the report, and the host's "End match" - and both
  // mean the next game, so both get a new world.
  //
  // The flip squares are cleared in the same breath, and must be: they are frozen while the room is
  // out of the lobby, and the next match's are a different set (they are seeded off the new seed).
  // Clearing them here is what lets startBattle write them again.
  const roomPatch: Record<string, unknown> = {
    status: "lobby",
    winner_team: null,
    seed: generateSeed(),
    flip_cells: [],
    started_at: null,
    paused_at: null,
    pause_votes: [],
  };
  const { error: roomErr } = await supabase.from("rooms").update(roomPatch).eq("id", roomId);

  // Pre-migration rooms don't have these columns - see the matching fallback in startBattle.
  if (roomErr && /paused_at|pause_votes/i.test(roomErr.message)) {
    delete roomPatch.paused_at;
    delete roomPatch.pause_votes;
    const { error: retry } = await supabase.from("rooms").update(roomPatch).eq("id", roomId);
    if (retry) throw retry;
    return;
  }
  if (roomErr) throw roomErr;
}

/** A battle in progress, as the front page's "Current battles" list needs it. */
export interface LiveBattle {
  code: string;
  /** How many people are in the room at all - crews and spectators alike. */
  players: number;
  /** Teams with at least one player on them, which is what "2 teams" on the card means. */
  teams: number;
  /** When the room was opened. Not when the match started - see fetchLiveBattles. */
  created_at: string;
}

/**
 * Every match currently being fought, for the front page.
 *
 * Deliberately `status = 'battle'` and nothing else. A lobby is somebody's room being arranged and
 * a room in prep is a match that has not opened yet - neither is a thing to walk in on, and
 * listing them would turn the front page into a directory of rooms to gatecrash. 'finished' is out
 * for the opposite reason: it's over, and the recap is already in "Recent battles" below.
 *
 * Two reads rather than a join, exactly as listRooms() does it for the admin: PostgREST can only
 * aggregate through a foreign-table select, and the counting is cheaper here than the round trip
 * saved. Rooms cap at 15 (see the room-limit migration) so both reads are small by construction.
 *
 * Every column read here is already world-readable ("rooms select" / "players select" are both
 * `using (true)`), so this publishes no fact a room code didn't already expose. What it does change
 * is that the codes themselves are now public - which is what the spectators_cannot_disrupt
 * migration exists to make safe.
 */
export async function fetchLiveBattles(): Promise<LiveBattle[]> {
  const { data: rooms, error } = await supabase
    .from("rooms")
    .select("id, code, created_at")
    .eq("status", "battle")
    .order("created_at", { ascending: false });
  if (error || !rooms || rooms.length === 0) return [];

  const ids = rooms.map((r) => r.id);
  const { data: players } = await supabase.from("players").select("room_id, team").in("room_id", ids);

  const heads = new Map<string, number>();
  const crews = new Map<string, Set<number>>();
  for (const p of players ?? []) {
    heads.set(p.room_id, (heads.get(p.room_id) ?? 0) + 1);
    if (p.team === null) continue;
    const teams = crews.get(p.room_id) ?? new Set<number>();
    teams.add(p.team);
    crews.set(p.room_id, teams);
  }

  return rooms.map((r) => ({
    code: r.code,
    players: heads.get(r.id) ?? 0,
    teams: crews.get(r.id)?.size ?? 0,
    created_at: r.created_at,
  }));
}

/**
 * Is this room still there, and what is it doing?
 *
 * Null means gone - pruned after its idle hour, deleted by an admin, or never existed. Used by the
 * top bar to decide whether the way back to "your" room is worth offering, which it previously
 * assumed on the strength of a localStorage key that nothing ever refuted.
 *
 * Swallows read failures as `undefined`, which is deliberately NOT null: an offline browser or a
 * blocked read is not evidence that the room is gone, and treating it as such would pull the link
 * out from under someone whose match is fine and whose wifi isn't.
 */
export async function lookupRoom(code: string): Promise<{ code: string; status: string } | null | undefined> {
  const { data, error } = await supabase
    .from("rooms")
    .select("code, status")
    .eq("code", normalizeRoomCode(code))
    .maybeSingle();
  if (error) return undefined;
  return data ?? null;
}

export type { Room, Player };
