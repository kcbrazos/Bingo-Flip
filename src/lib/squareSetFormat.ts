/**
 * The EldenBingo squareset file format, and how a battleship board is built from one.
 *
 * Deliberately free of imports - no JSON, no data - so the algorithm can be exercised directly
 * (see scripts/check-boards.ts) rather than only through a bundle. squareSets.ts binds the actual
 * files to it.
 */

/**
 * What a square is tinted by on the board. TWO vocabularies, one per squareset.
 *
 * The BOSS values (limgrave...dlc) are places. Coarser than the game's own region list, on purpose:
 * these are the groupings players actually plan around, so neighbours that are always travelled
 * together share one colour (Limgrave with Weeping, Caelid with Dragonbarrow, Altus with Leyndell
 * and Mt. Gelmir, the Mountaintops with the Snowfield, Farum Azula, the Haligtree and the Ashen
 * Capital). Seven colours stay tellable apart at cell size; fifteen would not.
 *
 * The OBJECTIVE values (prealtus...general) are ROUTES. A boss square names one place and colours by
 * it; an objective square names a goal, and what a team wants before committing to one is how far
 * into a run it sits and whether it's a trip of its own - so these are the gates of a run
 * (everything reachable before the Altus lift, everything behind it, the Mountaintops onward) plus
 * the DLC's sub-areas, which ARE separate trips in a way the base game's late regions aren't.
 *
 * The two are kept disjoint rather than sharing "mountaintops" or "dlc", even where they describe
 * the same mountains: the sets carry different palettes, and one shared key would repaint the boss
 * board as a side effect of colouring the objective one. Two vocabularies in a single union cost
 * nothing, because a legend only ever shows what the board in front of it actually contains.
 *
 * "general" is a real answer rather than a gap - "Complete 4 Caves in Different Regions" is
 * deliberately nowhere in particular - and "combined" is read off the (C) category instead of the
 * region file, since those squares hold two objectives that usually sit in two different places.
 */
export type Region =
  | "limgrave"
  | "liurnia"
  | "altus"
  | "caelid"
  | "mountaintops"
  | "underground"
  | "dlc"
  // Objectives set, from here down.
  | "prealtus"
  | "postaltus"
  | "snowfield"
  | "dlcgeneral"
  | "belurat"
  | "shadowkeep"
  | "rauh"
  | "dlcsouth"
  | "combined"
  | "general";

/**
 * Regions in roughly the order a run visits them, for the board's colour key.
 *
 * Not alphabetical on purpose - a legend that reads in progression order is scannable by anyone
 * who has played the game, where an alphabetical one is just a list. One block per squareset, since
 * no board ever mixes the two; the key filters this down to what it can actually see.
 */
export const REGION_ORDER: Region[] = [
  "limgrave",
  "liurnia",
  "caelid",
  "altus",
  "mountaintops",
  "underground",
  "dlc",
  "prealtus",
  "postaltus",
  "snowfield",
  "dlcgeneral",
  "belurat",
  "shadowkeep",
  "rauh",
  "dlcsouth",
  "combined",
  "general",
];

/** Lookup form of REGION_ORDER, so an unrecognized value in a data file is ignored rather than
 *  emitting a `.bg-region-<typo>` class that silently does nothing. */
const KNOWN_REGIONS = new Set<string>(REGION_ORDER);

/**
 * What to call each region in the legend.
 *
 * Names both halves where a colour covers two areas players think of separately, because the whole
 * job of the key is to answer "why is this square green" - and "Limgrave" alone doesn't explain a
 * green Weeping Peninsula square. The colours themselves live in BoardGrid.css as .bg-region-*,
 * and the legend reuses those classes rather than repeating the hex values here.
 */
export const REGION_LABELS: Record<Region, string> = {
  limgrave: "Limgrave / Weeping",
  liurnia: "Liurnia",
  caelid: "Caelid / Dragonbarrow",
  altus: "Altus / Leyndell / Gelmir",
  mountaintops: "Mountaintops / Snowfield",
  underground: "Underground",
  dlc: "DLC",

  prealtus: "Pre-Altus",
  postaltus: "Post-Altus",
  snowfield: "Mountaintops / Snowfield / Farum",
  dlcgeneral: "DLC (general)",
  belurat: "Belurat",
  shadowkeep: "Shadow Keep",
  rauh: "Rauh Base",
  dlcsouth: "Cerulean Coast / Jagged Peak",
  combined: "Combined (C)",
  general: "Anywhere",
};

/**
 * Squares that have been renamed, old name -> the name they carry now.
 *
 * `name` is a square's identity in `match_events`, so a rename would otherwise cut its history in
 * two: every match played before the rename says one thing and every match after says another, and
 * the Almanac - which groups on that string and nothing else - would show the same boss twice with
 * half its attempts each. Worse, its board reconstruction confirms a rebuilt board by checking that
 * the recorded names sit in the recorded cells, so a renamed square among a match's first shots
 * would make that whole board unidentifiable and cost it every never-fired square it could have
 * contributed.
 *
 * Folding old names into new is the cheaper half of the trade. It loses the ability to ask what a
 * square was called at the time, which nothing asks; it keeps the stats, which everything reads.
 *
 * Applied by canonicalSquareName at the point archived rows are read (see lib/profiles), so
 * nothing downstream has to know a rename ever happened.
 *
 * Entries live forever - the old rows they exist for never stop being old rows.
 *
 * An entry MISSING from here is silent: nothing errors, the square simply stops being the same
 * square. scripts/check-square-names.ts is what makes that audible - it reads every distinct name
 * the archive holds and reports the ones that no longer land on anything. Run it after any rename.
 */
export const RENAMED_SQUARES: Record<string, string> = {
  // Empty, and correctly so.
  //
  // Every entry here was a Bosses rename, and that set is gone. More to the point, nothing left in
  // the app stores a square NAME: the archive records who claimed how many squares and which cell
  // decided the match, never what was written on it. So there is no old name anywhere that needs
  // folding into a new one.
  //
  // Kept rather than deleted because the mechanism is sound and the day it is needed is the day a
  // set author renames a square that the archive HAS started recording - at which point the fix is
  // one line here, and check-square-names.ts already guards it against pointing at a square that
  // does not exist.
};
/** A recorded square name as it is spelled today. Anything not renamed passes straight through. */
export function canonicalSquareName<T extends string | null | undefined>(name: T): T {
  return (name == null ? name : RENAMED_SQUARES[name] ?? name) as T;
}

export interface Challenge {
  /**
   * The square's full name, and its identity. It is what every board draws and what a room's deal
   * is described in, so it must stay exactly as authored - shortening happens in `short`, never
   * here. Renaming one anyway means an entry in RENAMED_SQUARES, or its history before the rename
   * is orphaned.
   */
  name: string;
  /** What to print in the cell: `name` unless that's too long to read at board size. */
  short?: string;
  /** Extra detail shown on hover. Most objective squares don't have one. */
  tooltip?: string;
  /**
   * The finished hover text, `name` and `tooltip` already resolved into one line - see squareTitle,
   * which is the only thing that writes it, and challengesForRoom, which is where every board picks
   * it up. Optional because a Challenge read straight out of a set file hasn't been through either.
   */
  title?: string;
  /**
   * Which part of the map this square is in, if the set records it. Optional because only the boss
   * set is tagged - objective squares aren't tied to one place, so they keep the default colour.
   */
  region?: Region;
  /**
   * A literal colour for this square's name, when its set tints by keyword instead of by region.
   *
   * Two mechanisms because the sets genuinely disagree about what a colour means. The Objectives set
   * is tagged square by square with one of a fixed vocabulary, which earns a named class and a
   * legend. The community sets ship a keyword->colour list instead, with no names for the groups and
   * no closed set of values - so those resolve to a hex here and are applied inline. See
   * KeywordColor.
   */
  color?: string;
}

/**
 * The display form of a square's name.
 *
 * Boss names are 14 characters at the median and were what the board was built for; objective
 * squares run to 61 ("Complete 3 Tunnels or Precipice Dungeons in Different Regions") and were
 * being cut off mid-word in the cell. One edit is made: "and" between two halves of a goal becomes
 * an ampersand, which is what an ampersand is for.
 *
 * The trailing "(C)" STAYS. It marks a combined square - two objectives in one - and a team needs
 * to see that before committing to the square, so it is content rather than a category tag.
 *
 * Everything else is left alone. "Unique", "Both" and the numbers change what a square asks of you,
 * so an abbreviation that reads better and means something slightly different is worse than a
 * smaller font. The full name is always on hover.
 */
export function shortLabel(name: string): string {
  return name
    .replace(/\s+and\s+/gi, " & ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A squareset as the community's set authors write them.
 *
 * Consumed exactly as exported - no reshaping, no build step - so a new set is a matter of dropping
 * the .json in beside this file and adding an entry to SQUARE_SETS. Anything else would mean
 * hand-editing files that live in someone else's tool.
 *
 * Beyond the three known keys, a square may carry arbitrary `"varName": ["a", "b"]` arrays, which
 * fill the matching `%varName%` placeholder in its name. That's how one entry becomes "Kill 4
 * Unique Demi-Human Bosses" in one room and "Kill 5" in the next.
 */
export interface BingoSquare {
  name: string;
  categories?: string[];
  /**
   * The same thing as `categories`, singular. Rookie Rumble writes it this way and its whole
   * category-limits map keys off it, so reading only the plural form left that set with no
   * exclusivity rules at all - every square eligible every time. Merged by categoriesOf().
   */
  category?: string;
  tooltip?: string;
  /**
   * Relative likelihood of being drawn, default 1.
   *
   * Used to choose BETWEEN variants rather than to make a square rare: the Scadu League set pairs
   * "Acquire Verdigris Discus" (0.3) with "Kill the Divine Bird Warrior by Verdigris Discus" (0.7)
   * under one category capped at 1, so exactly one of the two lands and the weights say which is
   * likelier. A plain shuffle would make that a coin flip.
   */
  weight?: number;
  /**
   * The set's OWN area grouping, for setRegionLimits. Nothing to do with Challenge.region, which is
   * a colour - this never reaches the board, it only decides what may share a card.
   */
  region?: string;
  [key: string]: unknown;
}

/**
 * A cap on how many squares may come from a group of the set's own regions.
 *
 * Scadu League caps its four end-game areas at four squares between them - not because any one of
 * them is over-represented, but because a card that sends you to Enir-Ilim AND the Abyssal Woods AND
 * the Fissure AND Metyr is a card you cannot finish. Per-category limits can't express it: the rule
 * is about the union, not any single member.
 */
export interface SetRegionLimit {
  name: string;
  regionNames: string[];
  regionLimit: number;
}

export interface BingoSquareSet {
  squares: BingoSquare[];
  /**
   * Maximum squares per category on one card. Two very different things share this map: bucket
   * quotas ("at most 11 DLC squares") and exclusivity rules ("at most 1 Metyr square", which is
   * there to stop two squares asking for the same trip). They are treated differently below -
   * see SCALE_EXEMPT_BELOW.
   */
  "category limits"?: Record<string, number>;
  /**
   * Minimum squares per category on one card - the floor to "category limits"' ceiling. Scadu League
   * asks for at least two LEGENDS (its remembrance bosses), because a card of errands with no boss
   * on it isn't the game that set is for.
   */
  "category minimums"?: Record<string, number>;
  setRegionLimits?: SetRegionLimit[];
}

/**
 * What a square asks you to GO AND DO, stripped of how it happens to be written.
 *
 * Square identity is not enough to keep a flip board's two faces apart. These sets carry the same
 * objective twice - once tagged combined, once not - as separate entries: "Kill Both Mimic Tear
 * Bosses" and "Kill Both Mimic Tear Bosses (C)" are two rows in the Incursion set, and seven such
 * pairs exist in it. They are distinct squares by every mechanical measure, so an exclusion keyed on
 * identity happily deals one to each face - and a player who flips onto the objective they just
 * finished has hit exactly the case the flip rule exists to prevent.
 *
 * Normalising away the combined marker, the drawn variables and the punctuation collapses those
 * pairs onto one key. Deliberately conservative: it catches squares that are the same sentence, not
 * squares that happen to send you to the same region, because deciding that two differently-worded
 * objectives are "really" one trip is the set author's call and not this function's.
 */
export function objectiveKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(c\)/g, "")
    // Both the unresolved template and the number it draws, so the key is the same whether it is
    // taken from a raw squareset entry ("Kill %n% Minor Hippos") or from a dealt cell ("Kill 3 Minor
    // Hippos"). The picker sees the first and the checks see the second; they must agree.
    //
    // Collapsing counts is right on its own terms too: flipping from "Complete 4 Caves" onto
    // "Complete 2 Caves" is the same errand at a discount, which is not a different board.
    .replace(/%[^%]*%/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/[^a-z]+/g, " ")
    .trim();
}

/**
 * How many genuinely different objectives a set can deal - the number that actually caps a flip
 * board, since both faces come out of one set and neither may repeat the other's errand.
 *
 * Lower than the raw square count wherever a set writes one objective twice: the Incursion set has
 * 196 squares but seven combined/uncombined pairs among them, so it can only field 189 distinct
 * trips. Using the raw count here is what let the DLC set be offered a 7x7 flip board it could not
 * actually fill.
 */
export function distinctObjectives(names: readonly string[]): number {
  return new Set(names.map(objectiveKey)).size;
}

/** Every category a square belongs to, however its author chose to write them. */
function categoriesOf(square: BingoSquare): string[] {
  const many = square.categories ?? [];
  return typeof square.category === "string" ? [...many, square.category] : many;
}

/**
 * One rule from a set's companion colour file: "any square mentioning this gets this colour".
 *
 * Capitalised keys because that is how the community tool writes them and these files are dropped
 * in verbatim, same as the squaresets themselves.
 *
 * There is no name for what a colour MEANS anywhere in the format - the author knows that Lime is
 * Limgrave and nobody wrote it down. A second companion file supplies those names so these sets can
 * carry a key like the region-tagged ones do; see colorLegend.
 */
export interface KeywordColor {
  Keyword: string;
  Color: string;
}

/** One swatch in a keyword-tinted set's key: the colour as the board draws it, and what to call it. */
export interface ColorLegendEntry {
  /** The board colour, post-legibility lift - i.e. exactly what Challenge.color holds. */
  hex: string;
  label: string;
}

/**
 * Keywords an unnamed colour names itself with.
 *
 * Three, and an ellipsis if there are more. A group nobody has named still has to answer "why is
 * this square red", and its own keywords answer it with examples - which on a group of one or two
 * ("Dancer of Ranah") is a better key entry than any name we could invent for it.
 */
const LEGEND_KEYWORDS = 3;

/**
 * The colour key for a set that tints by keyword.
 *
 * Grouped by the RESOLVED hex rather than by the authored string, because that is what a square
 * carries and so the only thing a board can be filtered against - and because one file can write
 * the same colour two ways ("Fuchsia" and "255, 0, 255"), which are one swatch, not two.
 *
 * In file order, which is the order the rules are matched in and therefore the order the author
 * thought in - the same reasoning as REGION_ORDER, one step removed.
 */
export function colorLegend(
  rules: KeywordColor[],
  /** Colour (as written in the rules file) -> what to call it. Missing or empty falls back. */
  names: Record<string, string> = {}
): ColorLegendEntry[] {
  const order: string[] = [];
  const groups = new Map<string, { name?: string; keywords: string[] }>();

  for (const rule of rules) {
    if (typeof rule?.Keyword !== "string" || rule.Keyword === "") continue;
    const hex = boardColor(rule.Color);
    if (!hex) continue;

    let group = groups.get(hex);
    if (!group) {
      group = { keywords: [] };
      groups.set(hex, group);
      order.push(hex);
    }
    // First non-empty name wins, so the two spellings of one colour don't have to both be named.
    if (!group.name) group.name = names[rule.Color.trim()] || undefined;
    group.keywords.push(rule.Keyword);
  }

  return order.map((hex) => {
    const group = groups.get(hex)!;
    const sample = group.keywords.slice(0, LEGEND_KEYWORDS).join(" / ");
    return {
      hex,
      label: group.name ?? (group.keywords.length > LEGEND_KEYWORDS ? `${sample}...` : sample),
    };
  });
}

/** The named colours the community files actually use. Everything else arrives as "r, g, b". */
const NAMED_COLORS: Record<string, [number, number, number]> = {
  red: [255, 0, 0],
  lime: [0, 255, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  fuchsia: [255, 0, 255],
  magenta: [255, 0, 255],
  aqua: [0, 255, 255],
  cyan: [0, 255, 255],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  white: [255, 255, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
};

function parseColor(color: string): [number, number, number] | null {
  const named = NAMED_COLORS[color.trim().toLowerCase()];
  if (named) return named;
  const parts = color.split(",").map((p) => Number(p.trim()));
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) {
    return [parts[0], parts[1], parts[2]];
  }
  return null;
}

/** The board cell these names are drawn on, and the reason the authored colours can't be used raw. */
const CELL_LUMINANCE = 0.0101; // #0a1c28

/**
 * Contrast a square's name has to reach against the cell behind it.
 *
 * 4.5 is the WCAG threshold for body text. These names ARE body text at board size, and they sit on
 * near-black rather than on the light background the desktop tool drew them on - where saturated
 * Blue reads fine and here it manages 2.4:1, which is not legible at all.
 */
const MIN_CONTRAST = 4.5;

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance([r, g, b]: [number, number, number]): number {
  return (
    0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
  );
}

function contrast(rgb: [number, number, number]): number {
  return (luminance(rgb) + 0.05) / (CELL_LUMINANCE + 0.05);
}

/**
 * Lifts an authored colour until it is legible on the board, keeping its hue.
 *
 * Mixes toward white rather than rebuilding through HSL, which keeps the operation monotone and
 * cheap, and lands somewhere a reader still calls by the original name: Blue stays blue, it just
 * stops being invisible. Nothing already above the threshold is touched at all, so a file that was
 * authored with a dark background in mind passes through exactly as written.
 *
 * The step is deliberately small. Two colours in one file can be near neighbours (Scadu League has
 * both "Blue" and "128, 128, 255"), and lifting in coarse jumps would land them on top of each
 * other; the check-boards script reports any pair that ends up indistinguishable anyway.
 */
function legibleOnCell(rgb: [number, number, number]): [number, number, number] {
  let out = rgb;
  for (let step = 0; step < 100 && contrast(out) < MIN_CONTRAST; step++) {
    const t = (step + 1) / 100;
    out = [
      Math.round(rgb[0] + (255 - rgb[0]) * t),
      Math.round(rgb[1] + (255 - rgb[1]) * t),
      Math.round(rgb[2] + (255 - rgb[2]) * t),
    ];
  }
  return out;
}

const hex = (n: number) => n.toString(16).padStart(2, "0");

/** An authored colour as a hex string the board can use, or null if the file said something odd. */
export function boardColor(color: string): string | null {
  const rgb = parseColor(color);
  if (!rgb) return null;
  const [r, g, b] = legibleOnCell(rgb);
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * The colour for a square, by the first rule whose keyword its name contains.
 *
 * FIRST, not longest or last: the files are ordered, and the order is carrying meaning. Rookie
 * Rumble lists "+0 Weapon only" above "Limgrave" precisely so "Kill Limgrave Tree Sentinel with a
 * +0 weapon only" comes out as a challenge square rather than a Limgrave one.
 *
 * Matched against the RESOLVED name, so a square whose text is drawn from a %variable% is coloured
 * by what it actually ended up saying.
 */
function colorFor(name: string, rules: KeywordColor[]): string | undefined {
  const haystack = name.toLowerCase();
  for (const rule of rules) {
    if (typeof rule?.Keyword !== "string" || rule.Keyword === "") continue;
    if (haystack.includes(rule.Keyword.toLowerCase())) return boardColor(rule.Color) ?? undefined;
  }
  return undefined;
}

/** Squaresets are authored for a 5x5 bingo card; battleship boards are 64 to 144 squares. */
const CARD_SIZE = 25;

/**
 * Limits below this are exclusivity rules, not quotas, and are NOT scaled up with the board.
 *
 * `"metyr": 1` exists to stop "Kill Metyr" and "Dupe a DLC Remembrance at a Finger Ruin" both
 * landing on one card - two squares that want the same trip. Multiplying that by four because the
 * board is four times bigger would reintroduce exactly what the set author wrote it to prevent,
 * whereas `"dlcSquare": 11` is a proportion and does have to grow or a 100-square board can't fill.
 */
const SCALE_EXEMPT_BELOW = 4;

/**
 * Share of the board aimed at combined ("(C)") squares - the two-objectives-in-one entries.
 *
 * A plain shuffle lands them at their share of the pool, which for the Incursion set is 28 of 196,
 * or 14%. These rooms run three players to a fleet, so leaning on the harder squares is the point;
 * this pushes them to about the third of the card the set author's own quota implies (8 of 25).
 * Capped by how many the set actually has, so it degrades quietly on a set with few or none.
 */
const COMBINED_SHARE = 1 / 3;

const COMBINED_CATEGORY = "combinedSquare";

/**
 * Fills `%name%` placeholders from the square's own arrays of options.
 *
 * Returns a function rather than a string because each placeholder must be drawn ONCE per square
 * and then reused: the same square's name and short form have to agree ("Kill 4 Demi-Humans" on the
 * board, "Kill 4" in the log, never 4 and 5), and a name mentioning %demiNum% twice must say the
 * same number both times.
 */
function makeResolver(square: BingoSquare, next: () => number): (text: string) => string {
  const drawn: Record<string, string> = {};
  const combined = categoriesOf(square).includes(COMBINED_CATEGORY);

  return (text: string) =>
    text.replace(/%(\w+)%/g, (whole, key: string) => {
      if (drawn[key] === undefined) {
        const options = square[key];
        if (!Array.isArray(options) || options.length === 0) return whole;
        const pool = combined ? atLeastThree(options) : options;
        drawn[key] = String(pool[Math.floor(next() * pool.length)]);
      }
      return drawn[key];
    });
}

/**
 * Raises a combined square's counts to at least three.
 *
 * Applies to the numbers written into the square's text, where trimming the variable options can't
 * reach: "Acquire 2 Unique Exultation Talismans (C)" asks for two of a possible three while also
 * being half of a combined square, which is lighter than the (C) leads a team to expect.
 *
 * Digits inside brackets are left alone - "Bell Bearings [1]" is the item's name, not a count.
 */
function raiseCountsToThree(text: string): string {
  return text.replace(/(?<!\[)\b[12]\b(?!\])/g, "3");
}

/**
 * Trims a variable's options to 3 and above, for combined squares only.
 *
 * A combined square is already two objectives in one, so "kill 2 of X" alongside a second goal is a
 * lighter square than the (C) marker promises - these rooms run three to a fleet and a combined
 * square should be worth the trip. Left alone when the options aren't numbers (%killagod% offers
 * two phrases, not a count) or when nothing in the list reaches 3, since inventing a value the set
 * author didn't write would be worse than an easy square.
 */
function atLeastThree(options: unknown[]): unknown[] {
  const numeric = options.every((o) => Number.isFinite(Number(o)));
  if (!numeric) return options;
  const big = options.filter((o) => Number(o) >= 3);
  return big.length > 0 ? big : options;
}

function shuffled<T>(items: T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Shuffle that respects `weight`, used only by sets that carry weights.
 *
 * Efraimidis-Spirakis: give each item the key u^(1/w) for a uniform u and sort descending, which
 * yields a permutation where the chance of being first is exactly w/Σw, and the same again for
 * second among the rest. That is the property the weights are for - which of two mutually exclusive
 * variants gets there first - and it costs one draw per item.
 *
 * A set with no weights anywhere keeps the plain Fisher-Yates above, and this is why: the two
 * consume `next()` a different number of times, so routing the existing sets through here would
 * re-deal every live board and leave the Almanac unable to reconstruct a single archived one.
 */
function weightShuffled(items: BingoSquare[], next: () => number): BingoSquare[] {
  return items
    .map((item) => {
      const w = typeof item.weight === "number" && item.weight > 0 ? item.weight : 1;
      // next() can return exactly 0, and 0^(1/w) is 0 for every w - which would rank an item last
      // regardless of its weight. Nudging off zero keeps the ordering meaningful.
      return { item, key: Math.pow(next() || Number.EPSILON, 1 / w) };
    })
    .sort((a, b) => b.key - a.key)
    .map((x) => x.item);
}

/**
 * Picks `count` squares from a squareset, honoring its category limits.
 *
 * Four passes, in order:
 *   1. Any "category minimums" the set declares - hard floors, so they go first or a later pass
 *      fills the board past them.
 *   2. Combined squares up to the COMBINED_SHARE target - taken next because they're the scarce,
 *      interesting ones and a later pass would rarely reach them.
 *   3. Everything else.
 *   4. If the board still isn't full, whatever is left with the exclusivity rules ignored.
 *
 * Pass 4 exists because these sets are written for 25 squares and cannot always fill 100 while
 * every "at most one of these" rule holds: the Incursion set runs out at about 90. Bending the
 * rules late and only as far as needed beats either leaving holes in the board or scaling the
 * exclusivity rules away from the start.
 *
 * Deterministic for a given `next`, which is what lets every client build an identical board from
 * the room id alone without storing anything.
 */
function pickSquares(
  set: BingoSquareSet,
  count: number,
  next: () => number,
  relax: boolean,
  /**
   * Squares this deal may not use, by identity.
   *
   * How a flip board keeps its two faces distinct: the dark face is dealt with the light face's
   * squares excluded, so no objective appears on both. Dealing each face separately - rather than
   * taking one 2N deal and cutting it in half - is what keeps every rule the set author wrote for a
   * 25-square card meaningful on each face, most of all "category minimums". A halved double deal
   * scales a floor of two LEGENDS to four across the pair and then splits at random, which lands 4/0
   * often enough to matter; a face with no boss on it is not the game the set is for.
   */
  exclude?: ReadonlySet<BingoSquare>,
  /**
   * Objectives this deal may not repeat, as objectiveKey() values.
   *
   * Separate from `exclude` because it catches a different thing: not "this square is taken" but
   * "this trip is taken, under whatever name". The dark face is dealt with the light face's keys, so
   * the two faces cannot ask for the same errand twice.
   */
  excludeKeys?: ReadonlySet<string>
): BingoSquare[] {
  const remaining: Record<string, number> = {};
  for (const [category, limit] of Object.entries(set["category limits"] ?? {})) {
    remaining[category] =
      limit < SCALE_EXEMPT_BELOW ? limit : Math.max(limit, Math.ceil((limit * count) / CARD_SIZE));
  }

  // Region caps and minimums are both proportions of a card - "four of your twenty-five" - so both
  // scale with the board unconditionally. There is no exclusivity reading of either the way there is
  // for a limit of 1, which is why neither consults SCALE_EXEMPT_BELOW.
  const scale = (n: number) => Math.max(n, Math.ceil((n * count) / CARD_SIZE));

  const regionCaps = (set.setRegionLimits ?? []).map((rule) => ({
    members: new Set(rule.regionNames),
    left: scale(rule.regionLimit),
  }));

  // Seeded with the exclusions rather than checked separately, so they are honoured by the relax
  // pass too - that pass bends the set's exclusivity rules to fill a big board, and letting it bend
  // this one as well would put the same square on both faces, which is the one thing it cannot be.
  const used = new Set<BingoSquare>(exclude);
  const picked: BingoSquare[] = [];

  // Seeded with the caller's keys and then grown as squares are taken, so one deal never asks for
  // the same trip twice either - a single card carrying both spellings of one objective is the same
  // fault as a flip board carrying one on each face.
  const usedKeys = new Set<string>(excludeKeys);

  function take(square: BingoSquare, enforceLimits: boolean): void {
    if (used.has(square)) return;
    // Checked ahead of the limits and never relaxed. The relax pass exists to bend the set author's
    // exclusivity rules so a big board can fill; dealing one objective twice is not a rule of theirs
    // to bend, and a repeated errand is worse than a board that cycles.
    const key = objectiveKey(square.name);
    if (usedKeys.has(key)) return;
    const capped = categoriesOf(square).filter((c) => remaining[c] !== undefined);
    if (enforceLimits && capped.some((c) => remaining[c] <= 0)) return;

    const region = typeof square.region === "string" ? square.region : null;
    const caps = region ? regionCaps.filter((r) => r.members.has(region)) : [];
    if (enforceLimits && caps.some((r) => r.left <= 0)) return;

    for (const c of capped) remaining[c]--;
    for (const r of caps) r.left--;
    used.add(square);
    usedKeys.add(key);
    picked.push(square);
  }

  // Weighted only where a set actually declares weights - see weightShuffled for why that matters.
  const pool = set.squares.some((s) => typeof s.weight === "number")
    ? weightShuffled(set.squares, next)
    : shuffled(set.squares, next);

  for (const [category, min] of Object.entries(set["category minimums"] ?? {})) {
    let owed = scale(min);
    for (const square of pool) {
      if (owed <= 0 || picked.length >= count) break;
      if (!categoriesOf(square).includes(category)) continue;
      const before = picked.length;
      take(square, true);
      if (picked.length > before) owed--;
    }
  }

  const combined = pool.filter((s) => categoriesOf(s).includes(COMBINED_CATEGORY));

  const combinedTarget = Math.min(Math.round(count * COMBINED_SHARE), combined.length);
  for (const square of combined) {
    if (picked.length >= combinedTarget) break;
    take(square, true);
  }
  for (const square of pool) {
    if (picked.length >= count) break;
    take(square, true);
  }
  if (relax) {
    for (const square of pool) {
      if (picked.length >= count) break;
      take(square, false);
    }
  }
  return picked;
}

/**
 * How many of `count` cells this set can fill with every exclusivity rule intact.
 *
 * The lobby uses the shortfall to warn that a board is bigger than the set can cleanly cover. Uses
 * a fixed seed: it's a property of the set and the board size, not of any one room, and a figure
 * that wobbled per room would be a worse thing to show than an approximate one.
 */
export function strictFill(set: BingoSquareSet, count: number): number {
  return pickSquares(set, count, mulberry32(0x5eed), false).length;
}

/** Standalone copy of the app's PRNG, so this module keeps its no-imports property. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deals a squareset onto a board.
 *
 * Note the second shuffle. pickSquares() deliberately takes combined squares FIRST so the scarce
 * ones aren't crowded out - but the picked array is then laid onto cells in order, which put every
 * (C) square in the opening rows: on a 5x5, all eight of them filled A1-E1 and A2-C2. Selecting in
 * one order and placing in another is the whole point, so the order is broken here rather than in
 * the picking, where it does a job.
 */
export function buildBingoBoard(
  set: BingoSquareSet,
  count: number,
  next: () => number,
  /**
   * Short display forms, keyed by the square's name as written in the set file - `%variables%`
   * still in place, since that's the stable key. Supplied separately rather than added to the
   * squareset so the set file stays a verbatim copy of its author's, and a new version of it can
   * be dropped in without these having to be re-applied.
   */
  shortNames: Record<string, string> = {},
  /**
   * Where each square sends you, keyed on the raw name for the same reason as `shortNames`. Values
   * are checked against KNOWN_REGIONS rather than trusted, since these files are hand-maintained.
   */
  regions: Record<string, string> = {},
  /**
   * The set's keyword->colour rules, for sets that tint that way instead of by region. A set never
   * uses both: `regions` names a closed vocabulary with a legend, these are loose hexes.
   */
  colors: KeywordColor[] = []
): Challenge[] {
  return renderCells(shuffled(pickSquares(set, count, next, true), next), count, next, shortNames, regions, colors);
}

/**
 * Resolves picked squares onto cells: variables drawn, short forms chosen, colours settled.
 *
 * Split out of buildBingoBoard so a flip board can run it once per face over two separate picks.
 */
function renderCells(
  picked: BingoSquare[],
  count: number,
  next: () => number,
  shortNames: Record<string, string>,
  regions: Record<string, string>,
  colors: KeywordColor[]
): Challenge[] {
  // Repeats are only reachable if the set has fewer squares than the board has cells. Names are
  // resolved per cell, so a repeated square can still read differently in its two places.
  const out: Challenge[] = [];
  for (let i = 0; i < count; i++) {
    const square = picked.length > 0 ? (picked[i] ?? picked[i % picked.length]) : null;
    if (!square) break;
    const resolve = makeResolver(square, next);
    const isCombined = categoriesOf(square).includes(COMBINED_CATEGORY);
    // Combined squares carry two objectives, so their counts are floored at three - in the drawn
    // variables (see atLeastThree) and in the written text alike. Applied to the name and the short
    // form identically, or the board and the match log would disagree about what was asked.
    const bump = isCombined ? raiseCountsToThree : (text: string) => text;

    /**
     * Combined squares take their own colour and ignore the region file.
     *
     * They're the one bucket the set tags as neither base game nor DLC, and the pairing is the
     * point - "Kill Rykard and Messmer" is a trip to Mt. Gelmir AND a trip to the Shadow Keep, so
     * either colour on its own would tell a team something untrue about what they're committing to.
     */
    const authoredRegion = regions[square.name];
    const region = isCombined
      ? "combined"
      : typeof authoredRegion === "string" && KNOWN_REGIONS.has(authoredRegion)
        ? (authoredRegion as Region)
        : undefined;

    const name = bump(resolve(square.name));
    // A written short form always wins over the regex: either from the square itself, or from the
    // companion file keyed on the raw name. Both go through the same resolver, so "Kill %n%" and
    // its short form always report the same number.
    const authored =
      typeof square.short === "string"
        ? square.short
        : (shortNames[square.name] ?? null);
    out.push({
      name,
      short: authored !== null ? bump(resolve(authored)) : shortLabel(name),
      tooltip: square.tooltip,
      region,
      color: colors.length > 0 ? colorFor(name, colors) : undefined,
    });
  }
  return out;
}

/** Picks `count` squares from a plain `{ name, tooltip }` list, cycling if it runs short. */
export function buildFlatBoard(list: Challenge[], count: number, next: () => number): Challenge[] {
  if (list.length === 0) return [];
  const pool = shuffled(list, next);
  const out: Challenge[] = [];
  for (let i = 0; i < count; i++) out.push(pool[i % pool.length]);
  return out;
}

/** A flip board's two faces. `light` is what a match opens on; `dark` is what the flip squares reveal. */
export interface FlipFaces {
  light: Challenge[];
  dark: Challenge[];
}

/**
 * Deals both faces of a flip board from one squareset.
 *
 * The two faces share no square. That is the whole requirement the flip rests on - flipping onto an
 * objective you have already read is not a different board - and it means a set needs 2*count
 * squares before it can carry a flip board at all. See flipBoardSizes() for what each set can take.
 *
 * Each face is dealt in its own right, at `count`, so the set's category limits and minimums mean on
 * each face exactly what their author wrote them to mean on a card. The dark face draws second, from
 * the pool the light face left; where that pool is too thin for the set's exclusivity rules to hold,
 * the relax pass bends them, as it already does on any board bigger than the set was written for.
 */
export function buildFlipBoard(
  set: BingoSquareSet,
  count: number,
  next: () => number,
  shortNames: Record<string, string> = {},
  regions: Record<string, string> = {},
  colors: KeywordColor[] = []
): FlipFaces {
  const lightPick = pickSquares(set, count, next, true);
  // Excluded by identity AND by objective, because these sets write some objectives twice - once
  // tagged combined, once not - as separate squares. Identity alone deals one to each face.
  const darkPick = pickSquares(
    set,
    count,
    next,
    true,
    new Set(lightPick),
    new Set(lightPick.map((s) => objectiveKey(s.name)))
  );
  return {
    light: renderCells(shuffled(lightPick, next), count, next, shortNames, regions, colors),
    dark: renderCells(shuffled(darkPick, next), count, next, shortNames, regions, colors),
  };
}

/**
 * The flat-list equivalent: one shuffle, cut in two.
 *
 * A flat set declares no categories, limits or minimums - there is nothing per face to honour - so
 * the two halves of a single shuffle are the honest reading of the file, and the cut guarantees the
 * faces are disjoint. Runs short rather than cycling if the list cannot cover both faces; the caller
 * is expected to have capped the board size first.
 */
export function buildFlatFlipBoard(list: Challenge[], count: number, next: () => number): FlipFaces {
  // Deduplicated by objective before the cut, for the same reason the squareset dealer is: a flat
  // list can carry one errand under two spellings just as easily, and the cut alone would not notice.
  const seen = new Set<string>();
  const pool = shuffled(list, next).filter((c) => {
    const key = objectiveKey(c.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { light: pool.slice(0, count), dark: pool.slice(count, count * 2) };
}

/**
 * The largest flip board this many squares can carry: the biggest N with 2*N*N squares to spare.
 *
 * Half the pool per face, so a set covers a flip board one or two sizes smaller than the plain board
 * it could fill. Kept here beside the dealer rather than written down as a table per set, so adding
 * or trimming a squareset's .json moves its cap with it.
 */
export function maxFlipBoardSize(poolSize: number, sizes: readonly number[]): number {
  let best = sizes[0];
  for (const n of sizes) if (2 * n * n <= poolSize) best = n;
  return best;
}
