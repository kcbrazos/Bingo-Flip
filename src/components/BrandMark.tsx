import type { ReactNode } from "react";
import "./BrandMark.css";

interface WordProps {
  /**
   * Cap height, as any CSS length. Everything else - tracking, the rule, the glow - is sized in em
   * from this, so one number scales the whole mark and the proportions cannot drift between the
   * places it appears.
   */
  size?: string;
  /**
   * Drops the rule and the glow for the places the mark is a bystander rather than the subject: a
   * loading message, the error panel's heading. The lettering stays gilt, just quieter.
   */
  quiet?: boolean;
  /**
   * True where the surrounding text already names the app, so the mark should not be read out a
   * second time. It is real text either way - this only hides it from the accessibility tree.
   */
  decorative?: boolean;
}

/**
 * The wordmark. Text, not art.
 *
 * It was a PNG, exported at two sizes by a build script, and it said "Elden Battleship" - so it had
 * to go regardless. Setting it rather than redrawing it is the better answer anyway: it is sharp at
 * every size and on every display without a second export, it costs no request, it is selectable and
 * searchable, and a screen reader gets the name from the heading instead of from an alt attribute
 * somebody has to remember to update.
 *
 * Cinzel is doing the work. It is already loaded for headings (see --font-display), and it is a
 * classical Roman capital in the Trajan line - which is the same lineage Elden Ring's own lettering
 * draws on. Wide tracking and small caps do the rest; the gilt gradient is lit from above, the way
 * struck metal is.
 */
export function BrandWord({ size = "2.6rem", quiet = false, decorative = false }: WordProps) {
  return (
    <span
      className={`brand-word${quiet ? " brand-word-quiet" : ""}`}
      style={{ fontSize: size }}
      aria-hidden={decorative || undefined}
    >
      {/* Two spans rather than one string: the gradient runs across the whole mark, but the words
          need their own tracking so "BINGO FLIP" reads as one object with a gap in it rather than
          as two words that happen to be adjacent. */}
      <span className="brand-word-a">Bingo</span>
      <span className="brand-word-b">Flip</span>
    </span>
  );
}

/**
 * What a screen shows while it's waiting on the server.
 *
 * These were a bare line of grey text, which is indistinguishable from a page that has finished
 * loading and simply has nothing on it - the complaint was always "it just says loading" rather
 * than "it's slow". The mark gives the wait a shape, and the pulse says the tab is still alive.
 */
export function LoadingScreen({ children }: { children: ReactNode }) {
  return (
    <div className="brand-loading">
      <BrandWord size="1.5rem" quiet decorative />
      {/* aria-live so a screen reader announces the wait when this replaces the previous screen;
          without it the swap is silent and the page just appears to stop responding. */}
      <p className="muted" aria-live="polite">
        {children}
      </p>
    </div>
  );
}
