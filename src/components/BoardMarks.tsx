/**
 * The two things a Bingo Flip square can carry on top of its name.
 *
 * All that survives of Battleship's HitMarkers, which drew hits, misses, wrecks and the whole
 * menagerie hiding in the water. A claim needs no marker - the square takes its team's colour, which
 * carries further across a board than any glyph - so what is left is the cross a player draws on a
 * square they have written off, and the mark that says a square turns the board over.
 */

/**
 * One X, drawn one way.
 *
 * There used to be two: a bold red cross the player made by hand, and a thin dashed grey one the
 * board suggested, on the theory that a deduction offered should never look like a decision taken.
 * The board makes no deductions any more - there is nothing hidden to deduce - so this is only ever
 * a player's own note, and it is drawn like one.
 */
export function RuledOutMark() {
  return (
    <svg viewBox="0 0 100 100" className="ruled-mark" aria-hidden="true">
      <line x1="18" y1="18" x2="82" y2="82" />
      <line x1="82" y1="18" x2="18" y2="82" />
    </svg>
  );
}

/**
 * A flip square, before anyone has taken it.
 *
 * The favicon's ring, at board scale - the same two arcs chasing each other, with the same blunt
 * heads breaking the circle. Deliberately the same mark rather than a second one that means the
 * same thing: this is the product's whole idea, and it should be one shape wherever it appears.
 *
 * It replaced a generic swap glyph - two horizontal arrows with U-turns - which was a tangle of
 * five strokes in a 30px box and an unreadable smudge in the 19px an 88px cell gives it. This
 * geometry was drawn for 16px first (see public/favicon.svg), which is why it survives being the
 * corner of a square that still has its objective to show underneath.
 *
 * Monochrome where the favicon is two-tone, and that is the one deliberate difference. The tab icon
 * sits on a fixed plate and can spend a colour on each arc; this one has to take the FACE's colour,
 * turning from Erdtree gold to Messmer's ember as the board does - so both arcs and both heads are
 * currentColor, and .flip-mark points that at --flip-mark.
 *
 * Always visible, never hidden until claimed: the race for these squares is the game, and a flip
 * nobody could see coming would feel arbitrary rather than earned.
 */
export function FlipMark() {
  return (
    <svg viewBox="0 0 64 64" className="flip-mark" aria-hidden="true">
      {/* Butt caps, not round: each arc runs into its own head, and a rounded end would bulge past
          the triangle's base. Both sweep clockwise, so the mark reads the same upside down - which
          is what a flip symbol ought to do. */}
      <g fill="none" stroke="currentColor" strokeWidth="9">
        <path d="M16 26.2 A17 17 0 0 1 48 26.2" />
        <path d="M48 37.8 A17 17 0 0 1 16 37.8" />
      </g>
      {/* Each head's outer corner sits at radius 24 against the ring's 21.5, so it breaks the
          circle. Sized to the stroke instead, they tuck inside the outline and the mark becomes a
          plain broken ring with the arrows gone. */}
      <path fill="currentColor" d="M51.1 34.7 L40.4 25.8 L53.5 21 Z" />
      <path fill="currentColor" d="M13 29.4 L23.6 38.2 L10.5 43 Z" />
    </svg>
  );
}
