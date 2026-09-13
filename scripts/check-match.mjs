/**
 * Plays a whole match against a real database.
 *
 * The offline checks in check-flip.ts prove the RULES. This proves the SCHEMA: that claim_square()
 * actually enforces lockout under its room lock, that the flip parity survives a round trip, that
 * the win is decided by Postgres rather than by whoever asked last, and that a spectator cannot walk
 * into a live match and start playing.
 *
 * None of that can be established from the client. Every one of those guarantees is a policy, a
 * trigger or a lock, and the only way to know they hold is to try to break them.
 *
 * Runs against whatever SUPABASE_URL / SUPABASE_ANON_KEY point at, falling back to .env.local and
 * then to the local stack's well-known demo key:
 *
 *   npx supabase start
 *   node scripts/check-match.mjs
 *
 * It creates its own room and deletes it on the way out, so it is safe to point at a live project -
 * though it does occupy one of the fifteen room slots while it runs.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

function envFile(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
  );
}

const env = { ...envFile(".env.local"), ...process.env };
const URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL || "http://127.0.0.1:54321";
const KEY =
  env.SUPABASE_ANON_KEY ||
  env.VITE_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

let failures = 0;
function check(ok, what, detail) {
  if (ok) {
    console.log(`  ok    ${what}`);
    return;
  }
  failures++;
  console.error(`  FAIL  ${what}${detail ? ` :: ${detail}` : ""}`);
}

/** A fresh anonymous browser session. Each one is a different player. */
async function session(label) {
  const c = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.signInAnonymously();
  if (error) {
    throw new Error(
      `${label}: anonymous sign-in failed - ${error.message}. Turn it on under ` +
        "Authentication > Sign In / Providers > Anonymous."
    );
  }
  return { client: c, userId: data.user.id, label };
}

const code = "CHECK" + Math.random().toString(36).slice(2, 7).toUpperCase();
let roomId = null;
let openRoomId = null;
let ptsRoomId = null;
let outRoomId = null;
let drawRoomId = null;
let practiceRoomId = null;

try {
  console.log(`Playing a match at ${URL}\n`);

  // --- seats ---------------------------------------------------------------
  const host = await session("host");
  const rival = await session("rival");
  const watcher = await session("watcher");

  const { data: room, error: roomErr } = await host.client
    .from("rooms")
    .insert({
      code,
      board_size: 5,
      seed: "284915330",
      win_condition: "line",
      flip_count: 3,
      lockout: true,
    })
    .select()
    .single();
  if (roomErr) throw new Error(`room insert: ${roomErr.message}`);
  roomId = room.id;
  console.log(`  ok    room ${code} created`);

  const seat = async (s, nickname, isHost, inRoom) => {
    const { data, error } = await s.client
      .from("players")
      .insert({ room_id: inRoom ?? roomId, user_id: s.userId, nickname, is_host: isHost })
      .select()
      .single();
    if (error) throw new Error(`${s.label} join: ${error.message}`);
    return data;
  };
  const hostPlayer = await seat(host, "Host", true);
  const rivalPlayer = await seat(rival, "Rival", false);
  const watcherPlayer = await seat(watcher, "Watcher", false);

  const pickTeam = async (s, player, t) => {
    const { error } = await s.client
      .from("players")
      .update({ team: t, team_joined_at: new Date().toISOString() })
      .eq("id", player.id);
    if (error) throw new Error(`${s.label} team: ${error.message}`);
  };
  await pickTeam(host, hostPlayer, 0);
  await pickTeam(rival, rivalPlayer, 1);
  console.log("  ok    three players seated, two on teams, one spectating\n");

  // --- the readiness gate ---------------------------------------------------
  // The lobby -> prep -> battle path, walked the way the app walks it, because for a while the app
  // could not walk it at all: beginPrepPhase() cleared every ready flag, Room.tsx waited for all of
  // them to come back, and no screen anywhere could raise one. A room that left the lobby stayed in
  // prep forever. These checks existed in no form, because everything below opens the match by
  // writing `status: 'battle'` directly and skips the gate entirely.
  const { error: prepErr } = await host.client
    .from("rooms")
    .update({ status: "prep" })
    .eq("id", roomId);
  check(!prepErr, "the host moves the room into prep", prepErr?.message);

  const { error: clearErr } = await host.client.from("team_ready").delete().eq("room_id", roomId);
  check(!clearErr, "and the host may clear the previous match's ready flags", clearErr?.message);

  // Exactly the write the ready button makes - same table, same onConflict target.
  const markReady = (s, team, ready) =>
    s.client.from("team_ready").upsert({ room_id: roomId, team, ready }, { onConflict: "room_id,team" });

  const { error: readyErr } = await markReady(host, 0, true);
  check(!readyErr, "a player marks their own team ready", readyErr?.message);

  const { error: foreignErr } = await markReady(rival, 0, false);
  check(!!foreignErr, "but cannot un-ready another team", foreignErr ? "" : "the write was allowed");

  const { error: spectatorReadyErr } = await markReady(watcher, 1, true);
  check(
    !!spectatorReadyErr,
    "and a spectator cannot ready a team at all",
    spectatorReadyErr ? "" : "the write was allowed"
  );

  await markReady(rival, 1, true);
  const { data: readyRows } = await host.client
    .from("team_ready")
    .select("team, ready")
    .eq("room_id", roomId);
  const readySet = new Set((readyRows ?? []).filter((r) => r.ready).map((r) => r.team));
  check(
    readySet.has(0) && readySet.has(1),
    "both teams read as ready, which is what opens the board",
    `got ${[...readySet].join(",") || "none"}`
  );

  const { error: unreadyErr } = await markReady(host, 0, false);
  check(!unreadyErr, "and a team can take it back before the board opens", unreadyErr?.message);
  await markReady(host, 0, true);

  // --- opening the match ----------------------------------------------------
  const flipCells = [4, 5, 7];

  const { error: notHostErr } = await rival.client
    .from("rooms")
    .update({ status: "battle", started_at: new Date().toISOString() })
    .eq("id", roomId);
  check(!!notHostErr, "a non-host cannot open the match", notHostErr ? "" : "the update was allowed");

  const { error: openErr } = await host.client
    .from("rooms")
    .update({ flip_cells: flipCells, started_at: new Date().toISOString(), status: "battle" })
    .eq("id", roomId);
  check(!openErr, "the host opens the match", openErr?.message);

  const { error: freezeErr } = await host.client
    .from("rooms")
    .update({ flip_cells: [1, 2, 3] })
    .eq("id", roomId);
  check(!!freezeErr, "flip squares are frozen once the match starts", freezeErr ? "" : "they moved");

  // --- spectators may watch and nothing else --------------------------------
  const { error: sneakErr } = await watcher.client
    .from("players")
    .update({ team: 1 })
    .eq("id", watcherPlayer.id);
  check(!!sneakErr, "a spectator cannot join a team mid-match", sneakErr ? "" : "they joined");

  const { data: spectatorClaim } = await watcher.client.rpc("claim_square", {
    p_room_id: roomId,
    p_cell_index: 24,
  });
  check(spectatorClaim === null, "a spectator claiming gets nothing back", `got ${spectatorClaim}`);

  // --- lockout ---------------------------------------------------------------
  const claim = async (s, cell) => {
    const { data, error } = await s.client.rpc("claim_square", {
      p_room_id: roomId,
      p_cell_index: cell,
    });
    if (error) throw new Error(`${s.label} claim ${cell}: ${error.message}`);
    return data;
  };

  check((await claim(host, 0)) === 0, "the host claims A1");
  const contested = await claim(rival, 0);
  check(contested === 0, "a lost race reports who won it rather than throwing", `got ${contested}`);

  const { data: rows0 } = await host.client
    .from("claims")
    .select()
    .eq("room_id", roomId)
    .eq("cell_index", 0);
  check(rows0.length === 1, "and leaves exactly one claim row on that square", `${rows0.length} rows`);

  // --- the flip ---------------------------------------------------------------
  const faceNow = async () => {
    const { data } = await host.client.from("claims").select("flipped").eq("room_id", roomId);
    return data.filter((c) => c.flipped).length % 2;
  };
  check((await faceNow()) === 0, "the board opens on the light face");

  await claim(rival, 5); // a flip square
  const { data: flipRow } = await host.client
    .from("claims")
    .select()
    .eq("room_id", roomId)
    .eq("cell_index", 5)
    .single();
  check(flipRow.flipped === true, "claiming a flip square records that it turned the board");
  check(flipRow.face === 0, "and records the face it was claimed ON, not the one it produced", `face ${flipRow.face}`);
  check((await faceNow()) === 1, "the board is now showing the dark face");

  await claim(host, 7); // a second flip square
  check((await faceNow()) === 0, "a second flip square turns it back");

  // --- un-claiming --------------------------------------------------------------
  const { data: released } = await host.client.rpc("unclaim_square", {
    p_room_id: roomId,
    p_cell_index: 7,
  });
  check(released === true, "a team can release its own square");
  check((await faceNow()) === 1, "releasing the claim that flipped the board turns it back");

  const { data: notYours } = await rival.client.rpc("unclaim_square", {
    p_room_id: roomId,
    p_cell_index: 0,
  });
  check(notYours === false, "a team cannot release a square another team holds", `got ${notYours}`);

  // --- winning --------------------------------------------------------------------
  // Team 0 already holds cell 0. The top row is 0..4, and 4 is a flip square - so this also proves a
  // flip square counts toward a line like any other square does.
  for (const cell of [1, 2, 3, 4]) await claim(host, cell);

  const { data: finished } = await host.client.from("rooms").select().eq("id", roomId).single();
  check(finished.status === "finished", "completing a row ends the match", `status ${finished.status}`);
  check(finished.winner_team === 0, "and names the team that completed it", `winner ${finished.winner_team}`);

  const { data: tooLate } = await rival.client.rpc("claim_square", {
    p_room_id: roomId,
    p_cell_index: 20,
  });
  check(tooLate === null, "no further claims land once the match is finished", `got ${tooLate}`);

  // --- non-lockout ------------------------------------------------------------------
  // Its own room, because the mode is fixed for a match. The branches this exercises in
  // claim_square() are not reached at all by everything above.
  console.log("");
  const openCode = code + "B";
  const { data: openRoom, error: openRoomErr } = await host.client
    .from("rooms")
    .insert({
      code: openCode,
      board_size: 5,
      seed: "284915330",
      win_condition: "line",
      flip_count: 3,
      lockout: false,
    })
    .select()
    .single();
  if (openRoomErr) throw new Error(`non-lockout room: ${openRoomErr.message}`);
  openRoomId = openRoom.id;

  const hostSeat2 = await seat(host, "Host", true, openRoomId);
  const rivalSeat2 = await seat(rival, "Rival", false, openRoomId);
  await pickTeam(host, hostSeat2, 0);
  await pickTeam(rival, rivalSeat2, 1);
  await host.client
    .from("rooms")
    .update({ flip_cells: flipCells, started_at: new Date().toISOString(), status: "battle" })
    .eq("id", openRoomId);

  const openClaim = async (s, cell) => {
    const { data, error } = await s.client.rpc("claim_square", {
      p_room_id: openRoomId,
      p_cell_index: cell,
    });
    if (error) throw new Error(`${s.label} open-claim ${cell}: ${error.message}`);
    return data;
  };

  check((await openClaim(host, 0)) === 0, "non-lockout: team 0 takes A1");
  check((await openClaim(rival, 0)) === 1, "non-lockout: team 1 takes the SAME square", "it was refused");

  const { data: shared } = await host.client
    .from("claims")
    .select()
    .eq("room_id", openRoomId)
    .eq("cell_index", 0);
  check(shared.length === 2, "and both claims stand side by side", `${shared.length} rows`);
  check(
    shared.filter((c) => c.flipped).length === 0,
    "neither is marked as having flipped the board - A1 is not a flip square"
  );

  check((await openClaim(host, 0)) === 0, "a team claiming its own square again is a no-op, not an error");
  const { data: stillTwo } = await host.client
    .from("claims")
    .select("id")
    .eq("room_id", openRoomId)
    .eq("cell_index", 0);
  check(stillTwo.length === 2, "and does not add a third row", `${stillTwo.length} rows`);

  // The rule that keeps a non-lockout board from strobing: only the FIRST completion of a flip
  // square turns it over.
  await openClaim(host, 5);
  await openClaim(rival, 5);
  const { data: flipRows } = await host.client
    .from("claims")
    .select()
    .eq("room_id", openRoomId)
    .eq("cell_index", 5);
  check(flipRows.length === 2, "non-lockout: both teams complete the same flip objective");
  check(
    flipRows.filter((c) => c.flipped).length === 1,
    "but only the first completion turned the board",
    `${flipRows.filter((c) => c.flipped).length} of them flipped`
  );

  // Both teams race the same row. Team 1 closes it first, so team 1 wins it - even though team 0
  // also ends up holding a complete row.
  for (const cell of [1, 2, 3]) {
    await openClaim(host, cell);
    await openClaim(rival, cell);
  }
  await openClaim(rival, 4);
  const { data: openFinished } = await host.client
    .from("rooms")
    .select()
    .eq("id", openRoomId)
    .single();
  check(
    openFinished.status === "finished" && openFinished.winner_team === 1,
    "non-lockout: the team that CLOSED the row first wins it",
    `status ${openFinished.status}, winner ${openFinished.winner_team}`
  );

  // --- the archive ------------------------------------------------------------------
  // Filed from the client that happens to be on the finished screen, which is every client on it.
  console.log("");
  const { data: filedId, error: fileErr } = await host.client.rpc("archive_match", {
    p_room_id: roomId,
  });
  check(!fileErr && !!filedId, "a finished match files itself", fileErr?.message);

  const { data: again } = await rival.client.rpc("archive_match", { p_room_id: roomId });
  check(again === filedId, "a second client filing it gets the same match back, not a duplicate", `got ${again}`);

  const { data: results } = await host.client
    .from("match_results")
    .select()
    .eq("id", filedId)
    .single();
  check(results.winner_team === 0, "the record names the winner", `winner ${results.winner_team}`);
  // Two: cell 5 turned it, cell 7 turned it and was then released, and cell 4 - which closed the
  // winning row - is itself a flip square and turned it on the way past. That last one is the point
  // worth recording: a flip square is an ordinary square that also flips, so it counts toward a line
  // exactly like any other.
  check(results.total_flips === 2, "and how many times the board actually turned", `${results.total_flips}`);
  check(results.lockout === true, "and which mode it was played under");
  check(typeof results.duration_seconds === "number", "and how long it took");

  const { data: filedPlayers } = await host.client
    .from("match_players")
    .select()
    .eq("match_id", filedId);
  check(filedPlayers.length === 2, "both teams are recorded, the spectator is not", `${filedPlayers.length} rows`);
  const winnerRow = filedPlayers.find((p) => p.team === 0);
  check(winnerRow?.won === true, "the winning player is marked as having won");
  check(winnerRow?.squares === 5, "with the squares they actually claimed", `${winnerRow?.squares}`);

  // A client cannot write a result directly - no INSERT policy, same as claims.
  const { error: forgeErr } = await rival.client
    .from("match_results")
    .insert({ match_key: "forged", room_code: "FORGED", board_size: 5, lockout: true, win_condition: "line", flip_count: 3 });
  check(!!forgeErr, "a client cannot forge a match result", forgeErr ? "" : "the insert was allowed");

  // --- play again -------------------------------------------------------------------
  // resetRoomToLobby(), written out. It was refused outright by the flip-square freeze until this
  // ran: the clear and the status change travel in ONE statement, and the trigger judged it on the
  // status the room was leaving. "Play again" and the host's "End match" were both dead, and this
  // was the only path in the app that had no check on it at all.
  const { error: wipeErr } = await host.client.from("claims").delete().eq("room_id", roomId).select("id");
  check(!wipeErr, "the host clears the finished match's claims", wipeErr?.message);

  const { error: backErr } = await host.client
    .from("rooms")
    .update({ status: "lobby", winner_team: null, seed: "100000001", flip_cells: [], started_at: null })
    .eq("id", roomId);
  check(!backErr, "and sends the room back to the lobby, flip squares cleared", backErr?.message);

  const { data: relobbied } = await host.client.from("rooms").select().eq("id", roomId).single();
  check(relobbied.status === "lobby", "the room is in the lobby again", `status ${relobbied.status}`);
  check((relobbied.flip_cells ?? []).length === 0, "with no flip squares held over from last time");
  check(relobbied.winner_team === null, "and no winner");

  const { count: leftovers } = await host.client
    .from("claims")
    .select("id", { count: "exact", head: true })
    .eq("room_id", roomId);
  check(leftovers === 0, "and not one square from the last match", `${leftovers} left`);

  // The next match's flip squares can be written, which is the whole point of clearing them.
  const { error: rearmErr } = await host.client
    .from("rooms")
    .update({ flip_cells: [2, 8, 16], started_at: new Date().toISOString(), status: "battle" })
    .eq("id", roomId);
  check(!rearmErr, "and a second match can be opened in the same room", rearmErr?.message);

  // --- points: bingos score rather than win ------------------------------------------
  console.log("");
  const ptsCode = code + "P";
  const { data: ptsRoom, error: ptsErr } = await host.client
    .from("rooms")
    .insert({
      code: ptsCode,
      board_size: 5,
      seed: "284915330",
      win_condition: "points",
      bonus_per_bingo: 2,
      // Nine squares plus one completed line at 2 a bingo is 11, so this is reachable only WITH the
      // bonus - which is the whole point of the format, and what the check below turns on.
      target_score: 11,
      flip_count: 3,
      lockout: true,
    })
    .select()
    .single();
  if (ptsErr) throw new Error(`points room: ${ptsErr.message}`);
  ptsRoomId = ptsRoom.id;

  const hostSeat3 = await seat(host, "Host", true, ptsRoomId);
  const rivalSeat3 = await seat(rival, "Rival", false, ptsRoomId);
  await pickTeam(host, hostSeat3, 0);
  await pickTeam(rival, rivalSeat3, 1);
  await host.client
    .from("rooms")
    .update({ flip_cells: flipCells, started_at: new Date().toISOString(), status: "battle" })
    .eq("id", ptsRoomId);

  const ptsClaim = async (s, cell) => {
    const { data, error } = await s.client.rpc("claim_square", {
      p_room_id: ptsRoomId,
      p_cell_index: cell,
    });
    if (error) throw new Error(`${s.label} points-claim ${cell}: ${error.message}`);
    return data;
  };

  // The top row: five squares and one completed line. Under `line` this would already be over.
  for (const cell of [0, 1, 2, 3, 4]) await ptsClaim(host, cell);
  const { data: midway } = await host.client.from("rooms").select().eq("id", ptsRoomId).single();
  check(midway.status === "battle", "a completed bingo does NOT end a points match", `status ${midway.status}`);

  // 5 squares + 1 bingo x 2 = 7. Four more squares takes it to 9 + 2 = 11, which is the target.
  for (const cell of [5, 6, 7] ) await ptsClaim(host, cell);
  const { data: nearly } = await host.client.from("rooms").select().eq("id", ptsRoomId).single();
  check(nearly.status === "battle", "eight squares and one bingo is 10, still short of 11", `status ${nearly.status}`);

  await ptsClaim(host, 8);
  const { data: scored } = await host.client.from("rooms").select().eq("id", ptsRoomId).single();
  check(
    scored.status === "finished" && scored.winner_team === 0,
    "the ninth square takes the score to 11 and wins it",
    `status ${scored.status}, winner ${scored.winner_team}`
  );

  const { data: ptsFiled } = await host.client.rpc("archive_match", { p_room_id: ptsRoomId });
  const { data: ptsRecord } = await host.client
    .from("match_results")
    .select()
    .eq("id", ptsFiled)
    .single();
  check(ptsRecord.bonus_per_bingo === 2, "the record keeps what a bingo was worth", `${ptsRecord.bonus_per_bingo}`);
  check(ptsRecord.target_score === 11, "and the target it was played to", `${ptsRecord.target_score}`);

  // --- a board that runs out ---------------------------------------------------------
  // Lockout, all twenty-five squares gone, nobody with a bingo. The match used to stay open here
  // with no legal move left in it; it is now decided on the tally, and a level board is a draw.
  //
  // Both fillings below are a checkerboard with its two diagonals broken, which is what makes them
  // line-free - and line-free at every point along the way, since a subset of a line-free set is
  // line-free too. Also kept under 13 per team (majority on a 5x5): the universal majority rule
  // added since would otherwise end the match the moment a team crossed it, which is a real result
  // but not the exhaustion path this block exists to exercise.
  console.log("");

  /** Plays a whole board out, one claim per cell, in the team order given. */
  async function playOut(roomCode, assignment, seats) {
    const { data: rm, error } = await host.client
      .from("rooms")
      .insert({ code: roomCode, board_size: 5, seed: "284915330", win_condition: "line", flip_count: 3, lockout: true })
      .select()
      .single();
    if (error) throw new Error(`${roomCode}: ${error.message}`);

    for (const [s, team] of seats) await pickTeam(s, await seat(s, s.label, s === host, rm.id), team);
    await host.client
      .from("rooms")
      .update({ flip_cells: flipCells, started_at: new Date().toISOString(), status: "battle" })
      .eq("id", rm.id);

    const bySeat = new Map(seats.map(([s, team]) => [team, s]));
    for (let cell = 0; cell < assignment.length; cell++) {
      const s = bySeat.get(assignment[cell]);
      await s.client.rpc("claim_square", { p_room_id: rm.id, p_cell_index: cell });
    }
    const { data: after } = await host.client.from("rooms").select().eq("id", rm.id).single();
    return { id: rm.id, after };
  }

  // 11 squares to team 0, 12 to team 1, 2 to a third team - kept under the 13-square majority line so
  // this genuinely runs to exhaustion. Team 1 takes it on the count.
  const fullBoard = [1,1,0,1,1, 1,0,1,0,1, 0,1,0,1,0, 1,0,1,0,1, 0,2,0,2,0];
  const run = await playOut(code + "X", fullBoard, [[host, 0], [rival, 1], [watcher, 2]]);
  outRoomId = run.id;
  check(run.after.status === "finished", "a full board with no bingo ends the match", `status ${run.after.status}`);
  check(run.after.winner_team === 1, "and gives it to the team holding the most squares", `winner ${run.after.winner_team}`);

  const { data: outFiled } = await host.client.rpc("archive_match", { p_room_id: outRoomId });
  const { data: outRecord } = await host.client.from("match_results").select().eq("id", outFiled).single();
  check(outRecord.winner_team === 1, "the record keeps that winner", `${outRecord.winner_team}`);

  // 12 / 12 / 1. The top two are level, so nobody takes it.
  const levelBoard = [2,0,0,1,1, 1,0,1,0,1, 0,1,0,1,0, 1,0,1,0,1, 0,1,0,1,0];
  const draw = await playOut(code + "D", levelBoard, [[host, 0], [rival, 1], [watcher, 2]]);
  drawRoomId = draw.id;
  check(draw.after.status === "finished", "a level board ends the match too", `status ${draw.after.status}`);
  check(draw.after.winner_team === null, "and is a draw rather than a coin toss", `winner ${draw.after.winner_team}`);

  const { data: drawFiled } = await host.client.rpc("archive_match", { p_room_id: drawRoomId });
  const { data: drawRecord } = await host.client.from("match_results").select().eq("id", drawFiled).single();
  check(drawRecord.winner_team === null, "and the record files it with no winner", `${drawRecord.winner_team}`);
  const { data: drawPlayers } = await host.client.from("match_players").select().eq("match_id", drawFiled);
  check(
    (drawPlayers ?? []).every((p) => p.won === false),
    "with nobody marked as having won it",
    `${(drawPlayers ?? []).filter((p) => p.won).length} marked`
  );

  // --- a practice match is never archived ---------------------------------
  // Plays exactly like the very first room in this file - same win path, same claim_square() - so
  // the only thing under test is that archive_match() refuses it and nothing lands in match_results.
  console.log("");
  const practiceCode = code + "PR";
  const { data: practiceRoom, error: practiceErr } = await host.client
    .from("rooms")
    .insert({
      code: practiceCode,
      board_size: 5,
      seed: "284915330",
      win_condition: "line",
      flip_count: 3,
      lockout: true,
      practice: true,
    })
    .select()
    .single();
  if (practiceErr) throw new Error(`practice room: ${practiceErr.message}`);
  practiceRoomId = practiceRoom.id;

  const hostSeat4 = await seat(host, "Host", true, practiceRoomId);
  const rivalSeat4 = await seat(rival, "Rival", false, practiceRoomId);
  await pickTeam(host, hostSeat4, 0);
  await pickTeam(rival, rivalSeat4, 1);
  await host.client
    .from("rooms")
    .update({ flip_cells: flipCells, started_at: new Date().toISOString(), status: "battle" })
    .eq("id", practiceRoomId);

  for (const cell of [0, 1, 2, 3, 4]) {
    await host.client.rpc("claim_square", { p_room_id: practiceRoomId, p_cell_index: cell });
  }
  const { data: practiceAfter } = await host.client.from("rooms").select().eq("id", practiceRoomId).single();
  check(
    practiceAfter.status === "finished" && practiceAfter.winner_team === 0,
    "a practice match still plays and decides a winner normally",
    `status ${practiceAfter.status}, winner ${practiceAfter.winner_team}`
  );

  const { data: practiceFiled } = await host.client.rpc("archive_match", { p_room_id: practiceRoomId });
  check(practiceFiled === null, "but archive_match refuses to file it", `returned ${practiceFiled}`);

  const { count: practiceCount } = await host.client
    .from("match_results")
    .select("id", { count: "exact", head: true })
    .eq("room_code", practiceCode);
  check((practiceCount ?? 0) === 0, "and no match_results row exists for it", `${practiceCount} row(s)`);

  console.log(failures === 0 ? "\nall match checks passed" : `\n${failures} FAILED`);
} catch (err) {
  failures++;
  console.error(`\nthrew: ${err.message}`);
} finally {
  const made = [roomId, openRoomId, ptsRoomId, outRoomId, drawRoomId, practiceRoomId].filter(Boolean);
  if (made.length > 0) {
    const secret = env.SUPABASE_SERVICE_ROLE_KEY || env.SERVICE_ROLE_KEY;
    if (secret) {
      const admin = createClient(URL, secret, { auth: { persistSession: false } });
      await admin.from("rooms").delete().in("id", made);
      console.log(`\ncleaned up ${made.length} room${made.length === 1 ? "" : "s"}`);
    } else {
      // Not a failure. The rooms are idle from this moment and the pruner takes them within the
      // hour; saying so is better than demanding a secret key for a check that does not need one.
      console.log(`\n${made.length} room(s) left behind - no service role key to clean up with; the pruner will take them`);
    }
  }
}

process.exit(failures === 0 ? 0 : 1);
