import { FlipMark } from "./BoardMarks";

/**
 * One team's hold on one square. Several under non-lockout, where the cell is banded between them.
 */
export interface OverlayLayer {
  team: number;
  teamLabel: string;
  colorHex: string;
}

interface Props {
  boardSize: number;
  /** Cell edge in px. Small by necessity - this is composited over gameplay footage. */
  cell: number;
  /**
   * The teams in the match, for the legend and for looking a colour up by team number.
   *
   * Where Battleship had one LAYER PER FLEET - each fleet's own grid of incoming shots, stacked into
   * bands when the caster asked for a combined view - there is one board here that everybody shares.
   * So these are participants rather than grids, and the banding that used to mean "several fleets'
   * boards at once" now means "several teams hold this square", which is only reachable with lockout
   * off and is the honest way to draw it.
   */
  layers: OverlayLayer[];
  /** Who holds each square, ascending. Build it with cellOwners. */
  owners: (cellIndex: number) => number[];
  /** Which squares turn the board over, and have not been taken yet. */
  isFlip?: (cellIndex: number) => boolean;
  /** The square most recently claimed, ringed so it can be tied to the name callout. */
  pulseCell?: number | null;
  label?: string;
  showCoords?: boolean;
  /** Objective name per cell. Only worth passing at large cell sizes - see NAME_MIN_CELL. */
  cellName?: (index: number) => string | null;
}

/**
 * Below this cell size, square names are not drawn at any size.
 *
 * The names average 13 characters and reach 25, so a cell fits about 11 characters per line whatever
 * the scale - meaning most names need two lines, and the font can only be about cell/6.5. Under a
 * 56px cell that lands below 8px, which a stream encoder turns to mush; the label would cost real
 * screen area and deliver nothing. Refusing to draw them is more honest than shrinking them to noise.
 */
export const NAME_MIN_CELL = 48;

export function OverlayGrid({
  boardSize,
  cell,
  layers,
  owners,
  isFlip,
  pulseCell,
  label,
  showCoords = true,
  cellName,
}: Props) {
  const gutter = showCoords ? Math.max(10, Math.round(cell * 0.62)) : 0;
  // Grid lines start after the coordinate gutter/header when those are drawn.
  const offset = showCoords ? 2 : 1;

  const colorOf = (team: number) => layers.find((l) => l.team === team)?.colorHex ?? "#888";

  const showNames = !!cellName && cell >= NAME_MIN_CELL;
  // Derived from the cell rather than fixed, so one knob (?cell=) scales the whole board coherently.
  const baseFont = Math.max(6, cell / 6.5);

  return (
    <div className="ov-grid-wrap">
      {label && <div className="ov-grid-label">{label}</div>}

      <div
        className="ov-grid"
        style={{
          gridTemplateColumns: showCoords
            ? `${gutter}px repeat(${boardSize}, ${cell}px)`
            : `repeat(${boardSize}, ${cell}px)`,
          gridTemplateRows: showCoords
            ? `${Math.round(cell * 0.5)}px repeat(${boardSize}, ${cell}px)`
            : `repeat(${boardSize}, ${cell}px)`,
        }}
      >
        {showCoords &&
          Array.from({ length: boardSize }, (_, c) => (
            <span key={`col${c}`} className="ov-grid-coord" style={{ gridRow: 1, gridColumn: c + offset }}>
              {String.fromCharCode(65 + c)}
            </span>
          ))}

        {showCoords &&
          Array.from({ length: boardSize }, (_, r) => (
            <span key={`row${r}`} className="ov-grid-coord" style={{ gridRow: r + offset, gridColumn: 1 }}>
              {r + 1}
            </span>
          ))}

        {Array.from({ length: boardSize * boardSize }, (_, index) => {
          const row = Math.floor(index / boardSize);
          const col = index % boardSize;
          const held = owners(index);
          return (
            <span
              key={index}
              className={`ov-grid-cell${pulseCell === index ? " ov-grid-cell-latest" : ""}${
                held.length === 0 && isFlip?.(index) ? " ov-grid-cell-flip" : ""
              }`}
              style={{ width: cell, height: cell, gridRow: row + offset, gridColumn: col + offset }}
            >
              {/* Bands sit behind everything as a background wash so the name stays on top of them.
                  One band is a plain fill; several is a square two teams both hold. */}
              {held.length > 0 && (
                <span className="ov-grid-bands">
                  {held.map((team) => (
                    <span
                      key={team}
                      style={{ height: cell / held.length, display: "block", background: colorOf(team) }}
                    />
                  ))}
                </span>
              )}

              {held.length === 0 && isFlip?.(index) && <FlipMark />}

              {/* Above the fill, not below it. A square that has just changed hands is exactly the
                  one people are discussing, so the colour goes behind the name rather than erasing
                  it. The shadow is what keeps it legible against a team colour. */}
              {showNames && cellName!(index) && (
                <span
                  className="ov-grid-name"
                  style={{ fontSize: `${fitFontSize(cellName!(index)!, cell, baseFont)}px` }}
                >
                  {cellName!(index)}
                </span>
              )}
            </span>
          );
        })}
      </div>

      {layers.length > 1 && (
        <div className="ov-grid-legend">
          {layers.map((l) => (
            <span key={l.team} className="ov-grid-legend-item">
              <span className="ov-grid-legend-band" style={{ background: l.colorHex }} />
              {l.teamLabel}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
/**
 * Shrinks a boss name until its LONGEST WORD fits across one cell, then stops.
 *
 * Sizing so the whole name fits on a single line would be unreadable - "Maliketh, the Black Blade"
 * is 25 characters, which lands around 4px even in a 56px cell. What actually looked broken was
 * mid-word breaking: at a fixed size "Dragonbarrow" and "Pumpkinhead" are wider than the square,
 * so `overflow-wrap: anywhere` guillotined them into "Dragonbarro / w". Fitting the longest word
 * keeps every word whole and lets the name wrap between words, which is how you'd read it anyway.
 *
 * 0.56em per character is a measured average for Segoe UI at 600 weight - proportional fonts have
 * no exact answer, so this errs slightly small rather than risking a word that still clips.
 *
 * Width alone stopped being enough once squares could hold objectives rather than boss names. The
 * longest word in "Complete 3 Tunnels or Precipice Dungeons in Different Regions" is nine letters,
 * so the width rule is perfectly happy - and then the name needs six lines in a cell that holds
 * four. The second constraint below fits the text by AREA, which is what actually runs out.
 */
function fitFontSize(name: string, cell: number, baseFont: number): number {
  const longestWord = Math.max(1, ...name.split(/\s+/).map((w) => w.length));
  const usable = cell - 4; // the 2px horizontal padding on .ov-grid-name, both sides
  const byWidth = usable / (longestWord * 0.56);

  // Characters per line is usable/(0.56F) and each line costs 1.1F in height, so the text needs
  // about 0.62 * chars * F² of area. The 1.25 is slack for the ragged right edge word wrap leaves.
  const byArea = Math.sqrt((usable * (cell - 2)) / (0.77 * Math.max(1, name.length)));

  // Never scale UP past the base size - a short name like "Adan" shouldn't become a billboard.
  // The 5px floor is where a stream encoder gives up regardless.
  return Math.max(5, Math.min(baseFont, byWidth, byArea));
}
