import { rng, seedFrom } from "./seededRandom";
import { linesFor, cellsByTeam, completedLines, exhaustion } from "./flipLogic";
import { DEFAULT_BONUS_PER_BINGO, defaultTargetScore, type Claim, type WinCondition } from "../types/bingoFlip";

/**
 * Each team's chance of winning, from where the match stands right now.
 *
 * -- Why this simulates rather than looks the answer up -----------------------------------------
 *
 * There is no archive of finished Bingo Flip matches large enough to bucket by board size, team
 * count and win condition and read a percentage off a table - and even a large one would have
 * nothing to say about a shape it has never seen (a fresh board size, say). So the odds are played
 * out instead: take the board as it stands, run the rest of the match a few thousand times, and
 * count who was left standing. That answers any board size and any team count without ever having
 * seen one before.
 *
 * -- Why it costs nothing --------------------------------------------------------------------
 *
 * Every input is already public: the `claims` log is world-readable (every overlay already
 * subscribes to it for the board and the clock), and team sizes come off `players`. Nothing here
 * needs a credential Bingo Flip doesn't already hand an anonymous overlay.
 *
 * -- What is a guess, and what isn't --------------------------------------------------------------
 *
 * The WIN CHECK is not a guess: every rollout is decided by the same `winnerAt`/`exhaustion` rules
 * the match itself runs on (folded in here as `checkWinner`/`resolveExhausted` for the reason below),
 * so the model can never disagree with the game about what winning means.
 *
 * The PACE model is a guess, and a cruder one than it could be. A team's pace is its own claim
 * history shrunk toward a flat prior (see `PRIOR_CLAIM_SECONDS`), the same shape Elden Battleship's
 * victory-odds model uses for a fleet's shot pace - but that model's prior and its hunt/cold split
 * were fitted against a 121-match archive of real games. Bingo Flip has no equivalent archive yet,
 * so `PRIOR_CLAIM_SECONDS` is a starting guess rather than a calibrated constant, and there is no
 * pace-UNCERTAINTY term (Battleship draws a fresh pace per rollout from how well it's known; this
 * draws only a flat 0.5x-1.5x jitter per claim). Worth revisiting once there are enough finished
 * matches to fit against - see the note there for exactly what to measure.
 *
 * A CLAIM ITSELF has no geometry: unlike a shot, there is no "cold vs hunting" distinction to make,
 * because nothing in this game rewards firing next to a known hit. So a team's next claim is a
 * uniformly random pick among the cells still open to it, which is the simplest honest model for
 * "which objective does this team finish next".
 */

/** Seconds one team typically takes between claims, before the match has said otherwise. Per
 * player - a duo claims roughly twice as often as a solo team. An un-calibrated starting guess;
 * see the module note above. */
export const PRIOR_CLAIM_SECONDS = 90;

/** How many of a team's own claims must pass before the match's evidence outweighs the prior. */
const PACE_PRIOR_WEIGHT = 4;

/** Rollouts for the live number. */
export const LIVE_ROLLOUTS = 10000;
/** Rollouts for one point on the history line - lower because the line is read as a shape. */
export const LINE_ROLLOUTS = 500;
/** How many points the history line samples, however long the match ran. */
export const LINE_POINTS = 60;

export interface TeamState {
  team: number;
  /** Squares this team currently holds. */
  squares: number;
  /** How many claims this team has made, ever - what the pace estimate is shrunk against. */
  claimsMade: number;
  /** Seconds between this team's own claims, its own record shrunk toward the prior. */
  pace: number;
  /** Players on this team, which is most of why one team outpaces another. */
  crew: number;
}

export interface OddsSnapshot {
  /** Team numbers, in the order `odds` is indexed. */
  teams: number[];
  /** Chance of victory, 0..1, one per team. */
  odds: number[];
  /** Rollouts that ended in a real draw - a full lockout board with a tied score. Usually 0. */
  draw: number;
  /** True once the real match already has a winner: the odds are a fact, not an estimate. */
  decided: boolean;
  /** What the odds were computed from, so a caller can show the reasoning if it wants to. */
  teamStates: TeamState[];
}

/** One point on the win-probability line. */
export interface OddsPoint {
  /** Seconds on the match clock. */
  seconds: number;
  /** Chance of victory per team, indexed exactly as OddsSnapshot.teams. */
  odds: number[];
}

/**
 * A team's seconds-per-claim, its own record shrunk toward what a team that size normally does.
 *
 * Measured between the team's FIRST and LAST claim, not from the start of the match - the clock
 * before a team's opening claim is however long it took them to read the board, which is not their
 * claiming pace. A team with one claim has no gap to measure and rides entirely on the prior.
 */
function paceFor(claimTimes: number[], crew: number): number {
  const prior = PRIOR_CLAIM_SECONDS / Math.max(1, crew);
  if (claimTimes.length < 2) return prior;

  const first = claimTimes[0];
  const last = claimTimes[claimTimes.length - 1];
  const seconds = Math.max(0, (last - first) / 1000);
  const gaps = claimTimes.length - 1;

  return (seconds + PACE_PRIOR_WEIGHT * prior) / (gaps + PACE_PRIOR_WEIGHT);
}

/** Every team's standing, read from the public claims log and the roster. */
export function teamStates(claims: readonly Claim[], teams: number[], players: readonly { team: number | null }[]): TeamState[] {
  const held = cellsByTeam(claims);

  const crew = new Map<number, number>();
  for (const p of players) {
    if (p.team === null || p.team === undefined) continue;
    crew.set(p.team, (crew.get(p.team) ?? 0) + 1);
  }

  const claimTimes = new Map<number, number[]>();
  for (const c of claims) {
    const at = new Date(c.created_at).getTime();
    const times = claimTimes.get(c.team);
    if (times) times.push(at);
    else claimTimes.set(c.team, [at]);
  }

  return teams.map((team) => {
    const times = (claimTimes.get(team) ?? []).sort((a, b) => a - b);
    const size = crew.get(team) ?? 1;
    return {
      team,
      squares: held.get(team)?.size ?? 0,
      claimsMade: times.length,
      pace: paceFor(times, size),
      crew: size,
    };
  });
}

/** Every line through each cell, cached per board size - what makes an incremental win check cheap. */
const LINES_THROUGH_CACHE = new Map<number, number[][][]>();
function linesThroughEachCell(boardSize: number): number[][][] {
  const hit = LINES_THROUGH_CACHE.get(boardSize);
  if (hit) return hit;
  const lines = linesFor(boardSize);
  const byCell: number[][][] = Array.from({ length: boardSize * boardSize }, () => []);
  for (const line of lines) for (const cell of line) byCell[cell].push(line);
  LINES_THROUGH_CACHE.set(boardSize, byCell);
  return byCell;
}

/** A normal-ish jitter, standard deviation ~1 - see the note on `normal` in Elden Battleship's
 * victory-odds model. Three uniforms rather than Box-Muller: this sits in a rollout's innermost
 * loop, and a log/cos per claim per rollout is real time on a live stream. */
function jitter(random: () => number): number {
  return 0.5 + random();
}

/**
 * Plays the rest of the match out once, and says who was left holding the board.
 *
 * Every team claims on its own clock rather than in turns - whichever team's next claim lands
 * soonest fires it, so a two-player team genuinely claims faster than a solo one. A claim is a
 * uniformly random pick among the cells still open to that team (unclaimed, under lockout; not
 * already its own, otherwise - see the FLIP RULE, which is why a team can never reclaim a cell).
 *
 * The win check after each simulated claim is the same rule `winnerAt` runs on the real log -
 * majority first, then the room's condition - just carried forward incrementally rather than
 * rescanning the whole log every step, which is what makes 10,000 of these affordable. See
 * `checkWinner` below for the one place that rule is written.
 *
 * @returns the winning index into `states`, or -1 for a real draw (a full lockout board, tied).
 */
function rollout(
  boardSize: number,
  lockout: boolean,
  condition: WinCondition,
  bonusPerBingo: number,
  targetScore: number,
  linesByCell: number[][][],
  states: TeamState[],
  startMine: Map<number, Set<number>>,
  startCompletedLines: Map<number, number>,
  random: () => number
): number {
  const cells = boardSize * boardSize;
  const majority = defaultTargetScore(boardSize);
  const n = states.length;

  const mine: Set<number>[] = states.map((s) => new Set(startMine.get(s.team)));
  const completed = states.map((s) => startCompletedLines.get(s.team) ?? 0);
  const clock = new Float64Array(n);
  for (let i = 0; i < n; i++) clock[i] = states[i].pace * random();

  // Shared pool under lockout; each team tracks its own remaining pool otherwise (a team can
  // reclaim any cell it hasn't already claimed itself, whoever else holds it).
  const taken = lockout ? new Set<number>([...mine].flatMap((m) => [...m])) : null;

  /** Whether this claim wins outright, updating `completed` first if the room pays a bingo bonus. */
  function checkWinner(team: number, cell: number): boolean {
    const held = mine[team];
    if (held.size >= majority) return true;

    if (condition === "points") {
      for (const line of linesByCell[cell]) {
        if (line.every((c) => held.has(c))) completed[team]++;
      }
      return held.size + completed[team] * bonusPerBingo >= targetScore;
    }

    for (const line of linesByCell[cell]) {
      if (line.every((c) => held.has(c))) return true;
    }
    return false;
  }

  // Bounded rather than open-ended: under non-lockout every team eventually claims every cell,
  // which some win condition will have fired well before - but a safety net costs nothing and
  // guarantees this loop terminates even for a pathological room setting.
  const cap = lockout ? cells : cells * n;
  for (let step = 0; step < cap; step++) {
    let s = -1;
    let soonest = Infinity;
    for (let i = 0; i < n; i++) {
      const remaining = lockout ? cells - (taken?.size ?? 0) : cells - mine[i].size;
      if (remaining <= 0) continue;
      if (clock[i] < soonest) {
        soonest = clock[i];
        s = i;
      }
    }
    if (s < 0) break; // nobody has anywhere left to claim

    clock[s] += states[s].pace * jitter(random);

    // A uniformly random open cell - see the module note on why a claim has no geometry to weight.
    const openCount = lockout ? cells - (taken?.size ?? 0) : cells - mine[s].size;
    let pick = Math.floor(random() * openCount);
    let cell = -1;
    for (let c = 0; c < cells; c++) {
      const open = lockout ? !taken!.has(c) : !mine[s].has(c);
      if (!open) continue;
      if (pick === 0) {
        cell = c;
        break;
      }
      pick--;
    }
    if (cell < 0) continue; // rounding at the very last open cell; try again next tick

    mine[s].add(cell);
    if (taken) taken.add(cell);

    if (checkWinner(states[s].team, cell)) return s;
  }

  // Nobody reached the condition - only reachable under lockout, once the board is full (see the
  // cap above). Tie-broken exactly as a live match is: highest score, or a real draw.
  if (!lockout) return -1;
  const bestIdx = ((): number => {
    let best = -1;
    let at = -1;
    let tied = 0;
    for (let i = 0; i < n; i++) {
      const score = mine[i].size + (condition === "points" ? completed[i] * bonusPerBingo : 0);
      if (score > best) {
        best = score;
        at = i;
        tied = 1;
      } else if (score === best) {
        tied++;
      }
    }
    return tied === 1 ? at : -1;
  })();
  return bestIdx;
}

/**
 * Each team's chance of winning from the given standing.
 *
 * Seeded from the state itself, not from Math.random, so every viewer's browser lands on the same
 * percentage: the desk and a browser source open side by side must not disagree by a point because
 * they rolled different dice.
 */
export function flipOdds(
  claims: readonly Claim[],
  teams: number[],
  players: readonly { team: number | null }[],
  boardSize: number,
  lockout: boolean,
  condition: WinCondition,
  bonusPerBingo: number | null | undefined,
  targetScore: number | null | undefined,
  rollouts = LIVE_ROLLOUTS
): OddsSnapshot {
  const states = teamStates(claims, teams, players);
  const bonus = bonusPerBingo ?? DEFAULT_BONUS_PER_BINGO;
  const target = targetScore ?? defaultTargetScore(boardSize);

  // Over before it's asked: an exhausted lockout board already has its answer, real or drawn.
  if (lockout) {
    const done = exhaustion(claims, boardSize, lockout, condition, bonus);
    if (done.full) {
      return {
        teams,
        odds: teams.map((t) => (done.team === t ? 1 : 0)),
        draw: done.drawn ? 1 : 0,
        decided: true,
        teamStates: states,
      };
    }
  }

  const held = cellsByTeam(claims);
  const startMine = new Map(teams.map((t) => [t, held.get(t) ?? new Set<number>()]));
  const startCompletedLines = new Map(teams.map((t) => [t, completedLines(claims, boardSize, t).length]));
  const linesByCell = linesThroughEachCell(boardSize);

  const key = states.map((s) => `${s.team}:${s.squares}:${s.claimsMade}:${Math.round(s.pace)}`).join("|");
  const random = rng(seedFrom(`flip-odds:${boardSize}:${condition}:${key}`));

  const wins = new Array<number>(teams.length).fill(0);
  let draws = 0;
  for (let i = 0; i < rollouts; i++) {
    const w = rollout(boardSize, lockout, condition, bonus, target, linesByCell, states, startMine, startCompletedLines, random);
    if (w >= 0) wins[w]++;
    else draws++;
  }

  return {
    teams,
    odds: wins.map((w) => w / rollouts),
    draw: draws / rollouts,
    decided: false,
    teamStates: states,
  };
}

/**
 * The whole match's odds, sampled across the clock - the line under the number.
 *
 * Replayed from the log rather than accumulated as the match runs, so a source dropped into a
 * scene mid-match draws the same line as one that has been open all along.
 */
export function oddsTimeline(
  claims: readonly Claim[],
  teams: number[],
  players: readonly { team: number | null }[],
  boardSize: number,
  lockout: boolean,
  condition: WinCondition,
  bonusPerBingo: number | null | undefined,
  targetScore: number | null | undefined,
  startedAt: string | null | undefined,
  points = LINE_POINTS,
  rollouts = LINE_ROLLOUTS
): OddsPoint[] {
  if (!startedAt) return [];
  const startMs = new Date(startedAt).getTime();

  const instants = [...new Set(claims.map((c) => new Date(c.created_at).getTime()))].sort((a, b) => a - b);
  if (instants.length === 0) return [];

  const step = Math.max(1, Math.ceil(instants.length / points));
  const sampled: number[] = [];
  for (let i = 0; i < instants.length; i += step) sampled.push(instants[i]);
  if (sampled[sampled.length - 1] !== instants[instants.length - 1]) {
    sampled.push(instants[instants.length - 1]);
  }

  return sampled.map((at) => {
    const upto = claims.filter((c) => new Date(c.created_at).getTime() <= at);
    const snap = flipOdds(upto, teams, players, boardSize, lockout, condition, bonusPerBingo, targetScore, rollouts);
    return { seconds: Math.max(0, (at - startMs) / 1000), odds: snap.odds };
  });
}

/** "71%" - odds as a whole percent, which is all the precision a stream can read. */
export function oddsLabel(odds: number): string {
  return `${Math.round(odds * 100)}%`;
}

/**
 * The history line's geometry: one filled band per team, stacked to fill the box.
 *
 * Pure, and separate from whatever draws it, so a stacking bug is something that can be asserted
 * rather than something that has to be eyeballed on a stream. Bands are walked as a running
 * cumulative total so neighbours share an edge exactly instead of meeting at two independently
 * rounded numbers. SVG's y axis runs downward, so a band's top edge is `height - cumulative *
 * height`: team 0 sits along the bottom and the stack grows upward.
 */
export function oddsBands(
  teams: number[],
  points: OddsPoint[],
  width: number,
  height: number
): { team: number; polygon: [number, number][] }[] {
  if (points.length < 2 || width <= 0 || height <= 0) return [];

  const start = points[0].seconds;
  const span = points[points.length - 1].seconds - start || 1;
  const x = (seconds: number) => ((seconds - start) / span) * width;

  const tops = points.map((p) => {
    const cumulative: number[] = [];
    let sum = 0;
    for (let t = 0; t < teams.length; t++) {
      sum += p.odds[t] ?? 0;
      cumulative[t] = sum;
    }
    return cumulative;
  });

  return teams.map((team, t) => {
    const upper: [number, number][] = points.map((p, i) => [x(p.seconds), height - tops[i][t] * height]);
    const lower: [number, number][] = points
      .map((p, i): [number, number] => [x(p.seconds), height - (t === 0 ? 0 : tops[i][t - 1]) * height])
      .reverse();
    return { team, polygon: [...upper, ...lower] };
  });
}

/**
 * Whether a snapshot has anything honest to say yet.
 *
 * At least two teams and one claim between them. Before that the model has nothing but team sizes
 * to go on, and a confident 50/50 bar at the top of a match is the single most misleading thing any
 * surface here could show.
 */
export function oddsWorthShowing(snapshot: OddsSnapshot | null): snapshot is OddsSnapshot {
  return snapshot !== null && !snapshot.teamStates.every((s) => s.claimsMade === 0);
}
