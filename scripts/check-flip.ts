/**
 * Exercises the flip rules against the real squaresets.
 *
 * The questions worth asking of a flip board aren't "does it run" but: are the two faces genuinely
 * disjoint at every size a room can pick, does the same room id produce the same board and the same
 * flip squares on every client, are the flip squares spread rather than clustered, and does win
 * detection read ownership alone - the FLIP RULE - rather than anything about which face is up.
 *
 * Run with bare Node - src/lib/squareSetFormat.ts imports nothing, which is why it is a separate
 * module from the registry that binds the JSON:
 *
 *   node --experimental-strip-types scripts/check-flip.ts
 */
import { readFileSync } from 'node:fs'
import {
  buildFlipBoard,
  buildFlatFlipBoard,
  distinctObjectives,
  objectiveKey,
  type BingoSquareSet,
  type Challenge,
} from '../src/lib/squareSetFormat.ts'
import {
  cellsByTeam,
  completedLines,
  exhaustion,
  faceFromClaims,
  flipCellsFor,
  linesFor,
  ownershipFrom,
  scoreFor,
  squareCounts,
  winnerFrom,
  winningClaim,
  winningReason,
} from '../src/lib/flipLogic.ts'
import {
  MAX_CUSTOM_SQUARES,
  validateCustomSquareSetPayload,
  readStoredCustomSquareSet,
} from '../src/lib/customSquareSet.ts'
import { DEFAULT_BOARD_SIZE, minObjectivesForFlip, type Claim } from '../src/types/bingoFlip.ts'

function seedFrom(str: string): number {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^= h >>> 16) >>> 0
}

function rng(seed: number): () => number {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let failures = 0
function check(ok: boolean, what: string): void {
  if (!ok) {
    failures++
    console.error(`  FAIL  ${what}`)
  }
}

const read = (f: string) => JSON.parse(readFileSync(new URL(`../src/data/${f}`, import.meta.url), 'utf8'))

const SETS: Array<{ id: string; format: 'flat' | 'bingo'; file: string }> = [
  { id: 'ringus', format: 'flat', file: 'ringusSquares.json' },
  { id: 'objectives', format: 'bingo', file: 'incursionSquares.json' },
  { id: 'objectives-base', format: 'bingo', file: 'rookieRumbleSquares.json' },
  { id: 'objectives-dlc', format: 'bingo', file: 'scaduLeagueSquares.json' },
]

// --- the two faces share nothing, on every set that can be played -----------
console.log('faces are disjoint, and every cell is filled:')
for (const def of SETS) {
  const data = read(def.file)
  const pool = distinctObjectives((def.format === 'flat' ? data : data.squares).map((s: { name: string }) => s.name))
  const count = DEFAULT_BOARD_SIZE * DEFAULT_BOARD_SIZE
  const needed = minObjectivesForFlip(DEFAULT_BOARD_SIZE)

  // A set that cannot carry two disjoint faces at the default size has no business in the registry -
  // a host can pick a smaller board for a thin set, but the registry itself should clear the size
  // everyone gets by default. This is the check that catches a set added later that comes up short,
  // because coming up short is SILENT: the dealer cycles, and the board quietly repeats itself
  // across the faces.
  check(pool >= needed, `${def.id}: only ${pool} distinct objectives, needs ${needed}`)

  for (let trial = 0; trial < 40; trial++) {
    const next = rng(seedFrom(`room-${trial}:${def.id}:seed-${trial}`))
    const faces =
      def.format === 'bingo'
        ? buildFlipBoard(data as BingoSquareSet, count, next)
        : buildFlatFlipBoard(data as Challenge[], count, next)

    check(faces.light.length === count, `${def.id}: light face full`)
    check(faces.dark.length === count, `${def.id}: dark face full`)

    // Distinct BETWEEN faces is the requirement the flip rests on: flipping onto an objective you
    // have already read is not a different board.
    const lit = new Set(faces.light.map((c) => c.name))
    const overlap = faces.dark.filter((c) => lit.has(c.name))
    check(overlap.length === 0, `${def.id}: faces overlap on ${overlap[0]?.name}`)

    // ...and distinct by OBJECTIVE, not merely by square. These sets carry the same errand twice as
    // separate entries - "Kill Both Mimic Tear Bosses" and the same line tagged (C) - which are
    // different squares by every mechanical measure and the same trip to the player. Seven such
    // pairs exist in the Incursion set alone, so an exclusion keyed on identity put one on each face
    // and the check above saw nothing wrong with it.
    const litKeys = new Set(faces.light.map((c) => objectiveKey(c.name)))
    const echo = faces.dark.filter((c) => litKeys.has(objectiveKey(c.name)))
    check(echo.length === 0, `${def.id}: faces repeat the objective "${echo[0]?.name}"`)

    // The same fault within one face: a card that asks for the same trip in two of its squares.
    for (const [label, cells] of [['light', faces.light], ['dark', faces.dark]] as const) {
      const keys = cells.map((c) => objectiveKey(c.name))
      check(
        new Set(keys).size === keys.length,
        `${def.id}: ${label} face repeats an objective within itself`
      )
    }
  }
  console.log(`  ${def.id.padEnd(16)} ${String(pool).padStart(3)} distinct objectives (needs ${needed})`)
}

// --- the deal is reproducible from public strings alone ---------------------
{
  const data = read('incursionSquares.json') as BingoSquareSet
  const deal = () => buildFlipBoard(data, 25, rng(seedFrom('room-abc:objectives:12345')))
  const a = deal()
  const b = deal()
  check(
    JSON.stringify(a) === JSON.stringify(b),
    'same room id + set + seed deals an identical pair of faces'
  )

  const other = buildFlipBoard(data, 25, rng(seedFrom('room-abc:objectives:99999')))
  check(
    JSON.stringify(a) !== JSON.stringify(other),
    'a rematch (new seed) deals a different board'
  )
}

// --- flip squares ----------------------------------------------------------
console.log('flip squares:')
{
  const n = DEFAULT_BOARD_SIZE
  for (const flips of [3, 4, 5]) {
    // Across many seeds, not one: flip placement is seeded per room, so a single seed proves only
    // that one board came out right.
    for (let trial = 0; trial < 200; trial++) {
      const cells = flipCellsFor(`room-${trial}`, n, flips, `${trial}`)
      check(cells.length === flips, `x${flips}: got ${cells.length} flip squares`)
      check(new Set(cells).size === cells.length, `x${flips}: flip squares are distinct`)
      check(
        cells.every((c) => c >= 0 && c < n * n),
        `x${flips}: flip squares are on the board`
      )
    }
  }

  /**
   * How often the spread rule has to be bent on a 5x5.
   *
   * The placer prefers cells no closer than a king's move apart, because two flip squares side by
   * side are effectively one - claim either and the board turns. A 5x5 has room for three that way
   * and is tight for five, so the rule is a preference with a fallback rather than a guarantee, and
   * this measures how often the fallback actually fires. It is reported rather than asserted: the
   * number is a property of the board size, and the right response to it going up is to look at it,
   * not to fail a build.
   */
  for (const flips of [3, 4, 5]) {
    let bent = 0
    const TRIALS = 500
    for (let trial = 0; trial < TRIALS; trial++) {
      const cells = flipCellsFor(`spread-${trial}`, n, flips, `${trial}`)
      let touching = 0
      for (let i = 0; i < cells.length; i++) {
        for (let j = i + 1; j < cells.length; j++) {
          const dr = Math.abs(Math.floor(cells[i] / n) - Math.floor(cells[j] / n))
          const dc = Math.abs((cells[i] % n) - (cells[j] % n))
          if (Math.max(dr, dc) < 2) touching++
        }
      }
      if (touching > 0) bent++
    }
    console.log(
      `  ${flips} flip squares: spread honoured on ${TRIALS - bent} of ${TRIALS} boards` +
        (bent > 0 ? ` (${Math.round((bent / TRIALS) * 100)}% have a touching pair)` : '')
    )
  }

  const again = flipCellsFor('room-abc', 5, 3, '12345')
  check(
    JSON.stringify(again) === JSON.stringify(flipCellsFor('room-abc', 5, 3, '12345')),
    'flip squares are reproducible from room id + seed'
  )
  check(
    JSON.stringify(again) !== JSON.stringify(flipCellsFor('room-abc', 5, 3, '99999')),
    'a rematch moves the flip squares'
  )
  console.log(`  5x5 x3 -> ${flipCellsFor('room-abc', 5, 3, '12345').join(', ')}`)
}

// --- the face is the parity of the flips ------------------------------------
{
  let id = 0
  const claim = (cell: number, team: number, flipped: boolean): Claim => ({
    id: `c${id++}`,
    room_id: 'r',
    cell_index: cell,
    team,
    player_id: null,
    face: 0,
    flipped,
    created_at: new Date(Date.now() + id * 1000).toISOString(),
  })

  check(faceFromClaims([]) === 0, 'a fresh board shows the light face')
  check(faceFromClaims([claim(1, 0, false)]) === 0, 'an ordinary claim does not flip')
  check(faceFromClaims([claim(1, 0, true)]) === 1, 'a flip claim turns the board')
  check(faceFromClaims([claim(1, 0, true), claim(2, 1, true)]) === 0, 'two flips turn it back')
  check(
    faceFromClaims([claim(1, 0, true), claim(2, 1, false), claim(3, 0, true), claim(4, 1, true)]) === 1,
    'the face is the parity of the flip claims, whatever else happened'
  )

  // --- THE FLIP RULE: the winner is read off ownership, never off the face ---
  // A full top row for team 0 on a 5x5, with one of those claims having flipped the board. The
  // board is showing the dark face at the end; the line still wins.
  const line: Claim[] = [
    claim(0, 0, false),
    claim(1, 0, true),
    claim(2, 0, false),
    claim(3, 0, false),
    claim(4, 0, false),
  ]
  check(faceFromClaims(line) === 1, 'that sequence does leave the dark face showing')
  check(winnerFrom(line, 5, 'line') === 0, 'a completed row wins regardless of which face is up')
  check(completedLines(line, 5, 0).length === 1, 'the winning row is reported for highlighting')
  check(winnerFrom(line.slice(0, 4), 5, 'line') === null, 'four of five is not a line')

  // A line broken by an opponent's square is not a line - lockout is the whole game.
  const broken = [claim(0, 0, false), claim(1, 1, false), claim(2, 0, false), claim(3, 0, false), claim(4, 0, false)]
  check(winnerFrom(broken, 5, 'line') === null, 'an opponent in the row denies the line')

  // Columns and both diagonals.
  const col = [0, 5, 10, 15, 20].map((c) => claim(c, 1, false))
  check(winnerFrom(col, 5, 'line') === 1, 'a completed column wins')
  const down = [0, 6, 12, 18, 24].map((c) => claim(c, 1, false))
  check(winnerFrom(down, 5, 'line') === 1, 'the leading diagonal wins')
  const up = [4, 8, 12, 16, 20].map((c) => claim(c, 1, false))
  check(winnerFrom(up, 5, 'line') === 1, 'the counter diagonal wins')

  check(linesFor(5).length === 12, '5x5 has 5 rows + 5 columns + 2 diagonals')
  check(linesFor(6).length === 14, '6x6 has 6 rows + 6 columns + 2 diagonals')

  // --- majority: an unconditional floor under BOTH formats, not just `points` ----
  // A team holding more than half the board wins outright even under `line`, where nothing else
  // would ever notice a team that never completes a row, column or diagonal. A subset of a
  // line-free set is line-free too, so trimming the exhaustion fixture's old 14-cell team down to
  // 13 line-free cells leaves majority as the only thing that can end this match.
  const majorityCells = [0, 1, 3, 4, 5, 7, 9, 11, 13, 15, 17, 19, 21].map((c) => claim(c, 1, false))
  check(winnerFrom(majorityCells.slice(0, 12), 5, 'line') === null, 'twelve of twenty-five, line-free, is still live')
  check(winnerFrom(majorityCells, 5, 'line') === 1, 'the thirteenth line-free square wins it anyway')
  check(winningReason(majorityCells, 5, 'line') === 'majority', 'and the reason recorded is majority, not a line')

  // --- points: bingos score rather than win ---------------------------------
  // With the bonus at 0 this is exactly the rule the old `majority` condition named, which is why
  // that condition was folded in rather than kept beside it: strictly more than half the board.
  const noBonus = { bonusPerBingo: 0 }
  const twelve = Array.from({ length: 12 }, (_, i) => claim(i, 0, false))
  check(winnerFrom(twelve, 5, 'points', noBonus) === null, 'bonus 0: 12 of 25 does not reach the target')
  check(
    winnerFrom([...twelve, claim(12, 0, false)], 5, 'points', noBonus) === 0,
    'bonus 0: 13 of 25 does'
  )
  // On an even board a shared half is not enough either.
  const eighteen = Array.from({ length: 18 }, (_, i) => claim(i, 0, false))
  check(winnerFrom(eighteen, 6, 'points', noBonus) === null, 'bonus 0: 18 of 36 is a shared half')
  check(
    winnerFrom([...eighteen, claim(18, 0, false)], 6, 'points', noBonus) === 0,
    'bonus 0: 19 of 36 wins it'
  )

  // A bingo is worth points and does NOT end the match. The top row plus four more squares is nine
  // squares and one line: at bonus 2 that scores 11, still short of the default target of 13.
  const rowPlusFour = [
    ...[0, 1, 2, 3, 4].map((c) => claim(c, 0, false)),
    ...[5, 6, 7, 8].map((c) => claim(c, 0, false)),
  ]
  check(
    winnerFrom(rowPlusFour, 5, 'points', { bonusPerBingo: 2 }) === null,
    'a completed line does not end a points match'
  )
  const scored = scoreFor(rowPlusFour, 5, 0, 2)
  check(
    scored.squares === 9 && scored.lines === 1 && scored.score === 11,
    'and scores as squares plus bonus per line',
    `${scored.squares} squares, ${scored.lines} lines, ${scored.score} points`
  )
  // The same position under `line` is over the moment the row closes.
  check(winnerFrom(rowPlusFour, 5, 'line') === 0, 'the same position under `line` ended five claims ago')

  // The bonus is what carries a team over. Eleven squares laid out as the top two rows plus one is
  // 11 points at bonus 0, and 13 at bonus 2 - because two of those rows are complete lines... which
  // on a 5x5 they are not, so this uses an explicit target instead to isolate the bonus itself.
  const elevenFlat = Array.from({ length: 11 }, (_, i) => claim(i, 0, false))
  check(
    winnerFrom(elevenFlat, 5, 'points', { bonusPerBingo: 0, targetScore: 13 }) === null,
    'bonus 0: eleven squares is eleven points'
  )
  check(
    winnerFrom(elevenFlat, 5, 'points', { bonusPerBingo: 2, targetScore: 13 }) === 0,
    'bonus 2: the same eleven squares carry two complete rows and score 15'
  )

  const owner = ownershipFrom(line, 5)
  check(owner[0] === 0 && owner[5] === null, 'ownership maps claimed cells and leaves the rest null')

  // --- NON-LOCKOUT ---------------------------------------------------------
  // Every team may hold every square, so the rules have to stop asking who owns a cell. These are
  // the shapes that are only reachable with lockout off.
  {
    // Both teams hold the whole top row. Team 0 completed it first, so team 0 won - "who has a line
    // now" would report whichever the iteration reached first, which is the bug this guards.
    const shared: Claim[] = [
      claim(0, 0, false), claim(1, 0, false), claim(2, 0, false), claim(3, 0, false), claim(4, 0, false),
      claim(0, 1, false), claim(1, 1, false), claim(2, 1, false), claim(3, 1, false), claim(4, 1, false),
    ]
    check(winnerFrom(shared, 5, 'line') === 0, 'the team that completed the line FIRST wins it')
    check(winningClaim(shared, 5, 'line')?.team === 0, 'the winning claim is the one that closed it')
    check(
      completedLines(shared, 5, 1).length === 1,
      'the second team still has a completed line, it just did not win'
    )

    // Interleaved, so team 1 closes the row before team 0 does.
    const raced: Claim[] = [
      claim(0, 0, false), claim(0, 1, false),
      claim(1, 0, false), claim(1, 1, false),
      claim(2, 0, false), claim(2, 1, false),
      claim(3, 0, false), claim(3, 1, false),
      claim(4, 1, false), claim(4, 0, false),
    ]
    check(winnerFrom(raced, 5, 'line') === 1, 'interleaved, the team that closed first still wins')

    // Square counts are per team and unaffected by a square being shared.
    const counts = squareCounts(shared)
    check(counts.get(0) === 5 && counts.get(1) === 5, 'both teams are credited for a shared square')

    // Majority, non-lockout: both can pass the threshold, first past it takes the match.
    const bulk: Claim[] = []
    for (let i = 0; i < 13; i++) bulk.push(claim(i, 0, false))
    for (let i = 0; i < 13; i++) bulk.push(claim(i, 1, false))
    check(
      winnerFrom(bulk, 5, 'points', { bonusPerBingo: 0 }) === 0,
      'non-lockout points: first team past the target wins'
    )

    check(cellsByTeam(shared).get(0)?.size === 5, 'cellsByTeam reports each team separately')
  }

  // --- a board that runs out ----------------------------------------------
  // Must agree with claim_square()'s exhaustion branch, which is what the database checks pin from
  // the other side. Both fillings are the checkerboard with its two diagonals broken - line-free,
  // and line-free at every point along the way, since a subset of a line-free set is line-free too.
  // Also kept under 13 per team (majority on a 5x5), or the universal majority rule would decide the
  // match before the board ever finished filling - which is genuinely what should happen now, but
  // is not the exhaustion path this block exists to test. A third team siphons off the difference.
  {
    const fill = (assignment: number[]) => assignment.map((team, cell) => claim(cell, team, false))

    const lopsided = [1,1,0,1,1, 1,0,1,0,1, 0,1,0,1,0, 1,0,1,0,1, 0,2,0,2,0]
    const full = fill(lopsided)
    check(winnerFrom(full, 5, 'line') === null, 'a full board can genuinely contain no bingo or majority')

    const ran = exhaustion(full, 5, true, 'line', 1)
    check(ran.full, 'exhaustion notices every square is gone')
    check(ran.team === 1 && !ran.drawn, 'and hands it to the team holding the most', `team ${ran.team}`)

    // 12 / 12 / 1: the top two are level, so nobody takes it.
    const level = [2,0,0,1,1, 1,0,1,0,1, 0,1,0,1,0, 1,0,1,0,1, 0,1,0,1,0]
    const tied = exhaustion(fill(level), 5, true, 'line', 1)
    check(tied.full && tied.drawn && tied.team === null, 'a level board is a draw, not a coin toss')

    // One square short is still a live match, which is the distinction the whole thing turns on.
    const almost = exhaustion(full.slice(0, 24), 5, true, 'line', 1)
    check(!almost.full && almost.team === null, 'one square short is not a finished board')

    // Non-lockout never reaches the rule: nobody can be denied a square, so a "full" board there
    // means every team holding all of them, long after any reachable condition was met.
    check(!exhaustion(full, 5, false, 'line', 1).full, 'non-lockout is never called exhausted')
  }

  // --- the flip under non-lockout -----------------------------------------
  // Only the FIRST completion of a flip square turns the board. claim_square() decides this and
  // records it as `flipped`, so a second team finishing the same objective carries flipped: false -
  // which is exactly what keeps the parity honest without the parity knowing about modes.
  {
    const first = claim(7, 0, true)
    const second = claim(7, 1, false) // same square, second team, did NOT turn the board
    check(faceFromClaims([first, second]) === 1, 'a repeat claim on a flip square does not re-flip')

    const third = claim(12, 1, true) // a DIFFERENT flip square does turn it back
    check(faceFromClaims([first, second, third]) === 0, 'a different flip square still turns it')
  }

  // --- custom squareset uploads --------------------------------------------
  // The one place a squareset's shape is checked at RUNTIME rather than trusted at build time - see
  // the note at the top of customSquareSet.ts for why an upload can't get the same free pass the
  // bundled files do.
  {
    const flatOk = validateCustomSquareSetPayload([{ name: 'Kill a sheep' }, { name: 'Pet a dog', tooltip: 'Gently' }])
    check(flatOk.ok && flatOk.payload.format === 'flat' && flatOk.payload.data.length === 2, 'a plain list of squares validates as flat')

    const bingoOk = validateCustomSquareSetPayload({
      squares: [{ name: 'Kill Margit', category: 'margit' }, { name: 'Kill Godrick', category: 'godrick' }],
      'category limits': { margit: 1 },
    })
    check(
      bingoOk.ok && bingoOk.payload.format === 'bingo' && bingoOk.payload.data.squares.length === 2,
      'an object with a squares array validates as bingo'
    )

    check(!validateCustomSquareSetPayload('just a string').ok, 'a bare string is neither shape')
    check(!validateCustomSquareSetPayload({ notSquares: [] }).ok, 'an object with no squares array is rejected')
    check(!validateCustomSquareSetPayload([]).ok, 'an empty list is rejected')
    check(!validateCustomSquareSetPayload([{ tooltip: 'no name here' }]).ok, 'an entry with no name is rejected')
    check(!validateCustomSquareSetPayload([{ name: '   ' }]).ok, 'a blank name is rejected')
    check(
      !validateCustomSquareSetPayload({ squares: [{ name: 'x' }], 'category limits': { x: -1 } }).ok,
      'a negative category limit is rejected'
    )
    check(
      !validateCustomSquareSetPayload({ squares: [{ name: 'x' }], setRegionLimits: [{ name: 'r' }] }).ok,
      'a malformed setRegionLimits entry is rejected'
    )

    const tooMany = Array.from({ length: MAX_CUSTOM_SQUARES + 1 }, (_, i) => ({ name: `Square ${i}` }))
    check(!validateCustomSquareSetPayload(tooMany).ok, `more than ${MAX_CUSTOM_SQUARES} squares is rejected`)

    // Round trip through storage: what a client writes is what a client - any client - reads back.
    const stored = readStoredCustomSquareSet({ label: 'My Set', ...(flatOk.ok ? flatOk.payload : { format: 'flat', data: [] }) })
    check(stored?.label === 'My Set' && stored.format === 'flat', 'a valid stored payload reads back intact')

    check(readStoredCustomSquareSet(null) === null, 'a null column reads back as no custom set')
    check(
      readStoredCustomSquareSet({ label: 'x', format: 'bingo', data: ['not', 'bingo', 'shaped'] }) === null,
      'a wrapper whose declared format disagrees with its data is rejected'
    )
    check(
      readStoredCustomSquareSet({ label: '', format: 'flat', data: [{ name: 'x' }] }) === null,
      'a blank label is rejected even when the payload is fine'
    )
  }
}

console.log(failures === 0 ? '\nall flip checks passed' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
