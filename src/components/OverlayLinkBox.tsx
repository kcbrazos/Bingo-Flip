import { useState } from "react";
import { teamName } from "../lib/teamColors";
import { MIN_OPACITY } from "../lib/overlayCast";
import { TEXT_SIZE_OPTIONS } from "../lib/overlayText";
import { SourceRow } from "./SourceRow";

interface Props {
  roomCode: string;
  /** Marks this team as "yours" on the clock. Omit for spectators. */
  team?: number | null;
}

/**
 * The player's OBS sources: the same three the caster gets, plus a few decisions of their own.
 *
 * -- Why this used to be a form and isn't any more --
 *
 * It built one all-in-one HUD column and offered seven controls to shape it: which edge to hug,
 * whether to draw boards, one board or two, three cell sizes, boss names on or off, ships on or
 * off. Every one of those existed to make a 200px-wide strip carry a whole match, and most of them
 * were really the same question asked sideways - "is this readable?" - which the strip could only
 * ever answer no to.
 *
 * The three separate sources answer it properly: a full-size board that can be zoomed, a clock, and
 * a colour key, each placed where the streamer wants it. What survives of that form is only what a
 * streamer cannot settle by dragging a source around in OBS: whether their own ships go on stream,
 * and the two scene-wide settings below - how solid it all is, and how large the text is. The rest
 * of those seven controls were layout, and layout belongs in OBS.
 *
 * (The old column still exists at /overlay/:code with all its query parameters, for anyone running
 * one. It just isn't something anyone has to configure here to get started.)
 *
 * -- Why this is worth opening in the LOBBY ---------------------------------------------------
 *
 * A stream scene gets built before the match, not during it, so the fleet chooser has to work in a
 * lobby: one fleet in the room, or none picked yet, and it still has to let you say which board is
 * yours. It used to hide itself until two fleets had players, which meant the first person into the
 * room - usually the one streaming, who arrived early precisely to set up - was the one person who
 * couldn't. What they got instead was the all-fleets fallback, pointed at nobody in particular.
 *
 * And because the box is opened before you join a fleet as often as after, the board follows your
 * fleet until you overrule it. Opening this, then picking Blue, then finding your source still
 * aimed at "all" is a trap that only springs on stream.
 *
 * Built from window.location so the URLs stay correct on localhost, on GitHub Pages under its
 * /Elden-Battleship/ base, and anywhere else it gets hosted - hardcoding the deployed origin would
 * hand every local tester a link pointing at production.
 */
export function OverlayLinkBox({ roomCode, team }: Props) {
  const [open, setOpen] = useState(false);
  /** How solid the whole scene is on stream. One setting, written into all three sources. */
  const [opacity, setOpacity] = useState(1);
  /**
   * How large the text is on stream. One setting, written into all three sources - same reasoning as
   * the transparency slider below it, spelled out in lib/overlayText.
   */
  const [textSize, setTextSize] = useState(1);

  const myTeam = team !== null && team !== undefined ? team : null;

  /**
   * Two decisions used to live here and are gone, because neither has an answer any more.
   *
   * "Which fleet's board goes on stream?" assumed a board per fleet - yours showing what had been
   * done TO you, an opponent's showing your own shots landing. There is one board now and everyone
   * plays on it, so there is nothing to point the source at. (A caster can still isolate a single
   * team's claims from the control page; that is a commentary tool, not a setup question.)
   *
   * "Show my ships on stream?" attached the player's rejoin code to the URL as a credential, so the
   * source could read its own fleet from behind RLS. Nothing on a bingo board is hidden, so there is
   * no spoiler to opt into and no credential to attach - which also means this box no longer puts a
   * bearer token in an OBS config, and no longer needs the rejoin code at all.
   */

  const base = `${window.location.origin}${window.location.pathname}`;

  /**
   * The two settings every source shares, appended last.
   *
   * Only written when they are actually doing something - a URL full of defaults is harder to read,
   * and harder to hand-edit afterwards, which is the escape hatch for anyone who wants one source to
   * differ from the other two.
   */
  const withScene = (q: URLSearchParams) => {
    if (opacity < 1) q.set("opacity", opacity.toFixed(2));
    if (textSize !== 1) q.set("text", String(textSize));
    return q.toString();
  };

  const boardQuery = new URLSearchParams();
  // Always pinned, never aimed. `pin=1` rather than an empty query is what keeps a player's own
  // source off the cast channel: a board source with no parameters at all is the CASTER's, waiting
  // to be aimed from a control page, and a player's should never repaint because somebody else is
  // running board control on the same room. See pinnedView.
  boardQuery.set("pin", "1");

  const clockQuery = new URLSearchParams();
  if (myTeam !== null) clockQuery.set("team", String(myTeam));

  const boardUrl = `${base}#/overlay-board/${roomCode}?${withScene(boardQuery)}`;
  const clockQs = withScene(clockQuery);
  const clockUrl = `${base}#/overlay-timer/${roomCode}${clockQs ? `?${clockQs}` : ""}`;
  const keyQs = withScene(new URLSearchParams());
  const keyUrl = `${base}#/overlay-key/${roomCode}${keyQs ? `?${keyQs}` : ""}`;

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ fontSize: "0.8rem" }} title="Get stream overlay URLs for OBS">
        Stream overlay
      </button>
    );
  }

  return (
    <div className="panel stack" style={{ gap: "0.5rem", padding: "0.6rem" }}>
      <div className="row" style={{ justifyContent: "space-between", gap: "0.4rem" }}>
        <strong style={{ fontSize: "0.82rem" }}>OBS sources</strong>
        <button onClick={() => setOpen(false)} style={{ padding: "0.1rem 0.4rem", fontSize: "0.75rem" }}>
          Close
        </button>
      </div>

      <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
        Add each as a <strong>Browser Source</strong> in OBS at the size shown, and tick{" "}
        <em>Shutdown source when not visible</em>. Backgrounds are transparent.
      </span>

      {/*
        Text size, offered as named steps rather than a slider.

        A slider is right for transparency, where every value in the range is as good as its
        neighbour and what you want is the one that looks right over YOUR footage. Legibility isn't
        like that: the question behind it is "who is watching, and on what", and the answers are a
        handful of distinct situations rather than a continuum. Named steps say what each one is for
        - which is the part a streamer setting up a scene at 3am actually needs - and land on round
        numbers that stay round in the URL.

        Deliberately in the box rather than only in the URL: this is the setting most likely to be
        wrong on the first try and most likely to need changing between one stream and the next.
      */}
      <div className="stack" style={{ gap: "0.25rem" }}>
        <div className="row" style={{ justifyContent: "space-between", gap: "0.4rem" }}>
          <span style={{ fontSize: "0.78rem" }}>Text size</span>
          <span className="muted" style={{ fontSize: "0.72rem" }}>
            {TEXT_SIZE_OPTIONS.find((o) => o.value === textSize)?.note ?? `${textSize}x`}
          </span>
        </div>
        <div className="row" style={{ gap: "0.3rem", flexWrap: "wrap" }}>
          {TEXT_SIZE_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => setTextSize(o.value)}
              title={o.note}
              aria-pressed={textSize === o.value}
              style={{
                fontSize: "0.74rem",
                borderColor: textSize === o.value ? "var(--accent)" : undefined,
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
        <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
          Square names, coordinates, the clock and the key, all together. Nothing here can overflow a
          square or push the key off the edge - a size a source has no room for simply draws as large
          as it fits, so the clock and key need a taller browser source before the biggest steps show.
        </span>
      </div>

      {/*
        One slider for the whole scene rather than one per source.
        These three are dropped into a single layer over the same gameplay, and a board at half
        strength under a solid scorebug looks like a mistake rather than a choice. Anyone who really
        does want them to differ can still edit ?opacity= on the one URL afterwards - the sources
        read the parameter, they just aren't asked about it separately here.
      */}
      <div className="stack" style={{ gap: "0.25rem" }}>
        <div className="row" style={{ justifyContent: "space-between", gap: "0.4rem" }}>
          <span style={{ fontSize: "0.78rem" }}>Overlay transparency</span>
          <span className="muted" style={{ fontSize: "0.72rem" }}>
            {opacity >= 1 ? "solid" : `${Math.round(opacity * 100)}%`}
          </span>
        </div>
        <input
          type="range"
          min={MIN_OPACITY}
          max={1}
          step={0.05}
          value={opacity}
          onChange={(e) => setOpacity(Number(e.target.value))}
          aria-label="Overlay transparency"
          style={{ width: "100%" }}
        />
        <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
          Fades all three sources so your gameplay reads through them. {Math.round(MIN_OPACITY * 100)}% is the
          floor - below that "hidden" is the honest word, and OBS can already do that.
        </span>
      </div>

      <SourceRow
        label="Board"
        url={boardUrl}
        size="1000 x 1000"
        note="the shared board, both faces"
      />

      <SourceRow
        label="Clock"
        url={clockUrl}
        size="1200 x 200"
        note={
          myTeam !== null
            ? `the clock, every team's squares, and which face is up - ${teamName(myTeam)} marked as yours`
            : "the clock, every team's squares, and which face is up"
        }
      />

      <SourceRow
        label="Key"
        url={keyUrl}
        size="1920 x 90"
        note="a thin strip for the bottom edge - add ?plate=0 for no backing"
      />

      {/* Said here because the alternative is a streamer discovering it live and assuming their
          source is broken. See lib/overlayReveal.ts. */}
      <span className="muted" style={{ fontSize: "0.68rem", lineHeight: 1.35 }}>
        These stay blank while the room is in the lobby and come up when the host opens the match, so
        a scene built early shows an empty frame rather than a broken one.
      </span>
    </div>
  );
}
