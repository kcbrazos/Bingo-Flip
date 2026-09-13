import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useRoom } from "../hooks/useRoom";
import { useMatchSfx } from "../hooks/useMatchSfx";
import { setVolumeOverride, onAudioBlocked, primeAudio } from "../lib/sfx";
import "./OverlayAudio.css";

/**
 * The board, as sound and nothing else - an OBS Browser Source with no picture in it.
 *
 * -- Why this is a source rather than a setting on the others ---------------------------------
 *
 * Every other overlay is silent, and the only place the game makes a noise is a page with a player
 * or a spectator sitting in front of it (pages/Room, via useMatchSfx). So a stream carried the
 * match's pictures and none of its sound - a line closing, the horn that opens claiming, the
 * fanfare at the end - and all of that reached viewers as a square quietly changing colour.
 *
 * Bolting the audio onto the board source instead would have tied the two together in exactly the
 * ways a scene needs them apart. A caster wants the board on one monitor's scene and the sound
 * riding under a camera scene; a player wants the audio at a level that sits below their own voice,
 * which is a fader, not a URL. Its own source means OBS's own mixer does that job - tick "Control
 * audio via OBS" in the source's properties and it gets a channel, a fader and a mute button like
 * anything else. It also means the sound is not tied to a picture being VISIBLE: a scene that hides
 * the board during a break can keep the room audible, and one that shows the board over gameplay
 * footage can mute it, without either decision moving the other.
 *
 * -- One source, both audiences ---------------------------------------------------------------
 *
 * There is no caster version and player version of this - it plays every team's claims to whoever
 * is listening, which is what the board source already draws (nothing on a bingo board is hidden).
 * `?team=N` is therefore not a filter. It settles exactly one thing - which sting plays at the end -
 * and a source with no team gets the caster's answer to that: somebody being left standing is the
 * interesting fact, so the fanfare plays, except on a draw.
 */
export function OverlayAudio() {
  const { code } = useParams<{ code: string }>();
  const [params] = useSearchParams();
  const state = useRoom(code);

  /**
   * How loud, from the URL - because in an OBS Browser Source there is no other way to say it.
   *
   * The app's own volume slider lives in the top bar, which every overlay route deliberately
   * doesn't render, and it stores its answer in a browser nobody is sitting at. See setVolumeOverride.
   */
  const vol = params.get("vol");
  useEffect(() => {
    setVolumeOverride(vol !== null && vol !== "" ? Number(vol) : null);
    return () => setVolumeOverride(null);
  }, [vol]);

  /**
   * Whether the browser will let us make a noise at all.
   *
   * OBS normally starts its browser with autoplay allowed, so this is usually settled before
   * anything happens. But it is a per-install setting a streamer can have turned off, and the
   * failure mode without this check is the worst kind: a source that looks connected, reports no
   * error, and is simply mute for a whole match. So the page asks up front, at zero volume, and
   * says so on screen if the answer is no.
   */
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    void primeAudio().then((ok) => setBlocked(!ok));
    // A later rejection counts too: the probe can pass on a source that is then reloaded into a
    // stricter policy, and the badge should tell the truth about the sound that just didn't play.
    onAudioBlocked(() => setBlocked(true));
    return () => onAudioBlocked(null);
  }, []);

  const unblock = () => {
    void primeAudio().then((ok) => setBlocked(!ok));
  };

  /**
   * `?team=N` picks the fanfare/sting - the only thing it does on this page. Without one, this is a
   * caster's source and reads pages/Room's own spectator rule: somebody being left standing is the
   * interesting fact.
   */
  const rawTeam = params.get("team");
  const myTeam = rawTeam !== null && rawTeam !== "" && Number.isInteger(Number(rawTeam)) ? Number(rawTeam) : null;

  // Every hook above this line runs whether the room has loaded yet or not - useRoom returns before
  // state.room resolves, and useMatchSfx has to run every render regardless, the same rule every
  // page here follows for its own hooks.
  useMatchSfx(state.room, state.claims, myTeam);

  /**
   * Nothing on screen, unless something is wrong.
   *
   * A source with no picture is the whole point, and OBS will happily size it 1x1. The badge is the
   * exception, on the same grounds the board source shows its own disconnected warning on stream: a
   * silent audio source looks identical to a working one, and the person who can fix it is the one
   * looking at the preview.
   */
  return blocked ? (
    <button type="button" className="ova-blocked" onClick={unblock}>
      Match audio is blocked - right-click this source in OBS, choose Interact, and click here once.
    </button>
  ) : null;
}
