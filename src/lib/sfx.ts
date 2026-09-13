const base = import.meta.env.BASE_URL;
const cache = new Map<string, HTMLAudioElement>();

/**
 * Five sounds, tuned to one pitch centre so two landing together are consonant rather than merely
 * simultaneous. Three of them are struck metal, built rather than recorded - see art/build-sfx.mjs
 * for why, and for what each one is trying to say.
 *
 * They fall into two groups, and the split is the whole design: MARK and BINGO are about a square,
 * and fire constantly; START, VICTORY and DEFEAT are about the match, and fire once each.
 */
const FILES = {
  /**
   * A square changed hands - anybody's square, either team's.
   *
   * The board is the only thing in this app that changes without the player doing anything, and
   * under lockout the change that matters most is an opponent taking a square out from under you
   * while you are reading a different one. This is what makes that audible.
   *
   * Deliberately the SAME sound whoever claimed it. The board already says whose it is in colour,
   * and a sound that took sides would be wrong for half the room - and flatly wrong on a stream,
   * where the listener has no side at all.
   */
  mark: "sfx/mark.mp3",
  /**
   * Somebody completed a line.
   *
   * Plays INSTEAD of the mark on the claim that closes it, never alongside - the two sounds exist
   * to be told apart, and layering them would blur the one moment they are there to distinguish.
   * Suppressed when that same claim ends the match, where victory or defeat says it better.
   */
  bingo: "sfx/bingo.mp3",
  /**
   * Claiming is open.
   *
   * Once per match, when the preparation countdown runs out - not when the room opens. Preparation
   * is when a team reads both faces and decides which one it would rather be racing on, and this is
   * what says that thinking time is over.
   */
  start: "sfx/start.mp3",
  /**
   * The match is over and you took it.
   *
   * Plays once, on the moment the room flips to `finished`, and only for someone who watched it
   * happen - see the effect in pages/Room. Loading a finished room's page later is a recap, not a
   * result, and a fanfare over a recap is just noise.
   */
  victory: "sfx/victory.mp3",
  /**
   * The other side of the same moment: somebody else took it, or nobody did.
   *
   * A match that ends with no winner takes this rather than the fanfare. Nobody won it, and the
   * losing team hearing a fanfare would read as the game congratulating them.
   */
  defeat: "sfx/defeat.mp3",
} as const;

export type SfxName = keyof typeof FILES;

const VOLUME_KEY = "bf_sfx_volume";

/**
 * A page's answer about the level, beating the stored one.
 *
 * Only pages/OverlayAudio sets this, and the reason a slider in the top bar doesn't reach here on
 * its own: every overlay route deliberately renders no chrome, so the volume slider doesn't exist
 * on that page, and the storage it reads belongs to a browser nobody is sitting at. A streamer's
 * only way to say "quieter" is the URL they paste into OBS - `?vol=` - so that is what this carries.
 *
 * In memory only, never written to storage. OBS runs every browser source out of one shared
 * profile, so persisting it would let one source's `?vol=` silently redefine the default for every
 * other source pointed at this site.
 */
let volumeOverride: number | null = null;

export function setVolumeOverride(v: number | null): void {
  volumeOverride = v === null || !Number.isFinite(v) ? null : Math.min(1, Math.max(0, v));
}

/** 0-1. Defaults to 0.7 rather than full blast on a fresh browser. */
export function getVolume(): number {
  if (volumeOverride !== null) return volumeOverride;
  const stored = localStorage.getItem(VOLUME_KEY);
  if (stored === null) return 0.7;
  const n = Number(stored);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.7;
}

export function setVolume(v: number): void {
  const clamped = Math.min(1, Math.max(0, v));
  localStorage.setItem(VOLUME_KEY, String(clamped));
  // Nothing to update on the cached elements: they are only ever templates now, and every clone
  // reads the level at the moment it plays.
}

/**
 * Plays a sound effect, layering rather than interrupting.
 *
 * The cache holds one element per sound purely as a preloaded TEMPLATE, and playback happens on a
 * clone of it. Playing the cached element directly meant two effects of the same kind arriving
 * close together shared one HTMLAudioElement, and the second `currentTime = 0` restarted the first
 * instead of sounding alongside it - so two of them was heard as one.
 *
 * That matters more now than it did, because `mark` is the sound of a square changing hands and
 * squares change hands in flurries: two teams finishing objectives seconds apart is the ordinary
 * shape of a race, and it has to be audible as two.
 */
export function playSfx(name: SfxName): void {
  const volume = getVolume();
  if (volume === 0) return;

  let template = cache.get(name);
  if (!template) {
    template = new Audio(base + FILES[name]);
    template.preload = "auto";
    cache.set(name, template);
  }

  const audio = template.cloneNode() as HTMLAudioElement;
  audio.volume = volume;
  void audio.play().catch(() => {
    // Autoplay can be blocked before the first user gesture - not worth surfacing to the player,
    // who will hear the next sound the moment they click anything. It IS worth surfacing to a
    // browser source nobody is going to click, which is what the handler below is for.
    blockedHandler?.();
  });
}

/**
 * Told when a sound was refused, for a page that has no listener to click anything.
 *
 * Deliberately a single handler rather than a subscriber list: the only page that wants this is the
 * audio browser source (pages/OverlayAudio), and one page can only be mounted once. A second caller
 * replacing the first is the correct outcome, not a leak.
 *
 * Nothing else registers one, which is why an ordinary player still sees no error for a blocked
 * sound - they are about to click something, and then it works.
 */
let blockedHandler: (() => void) | null = null;

export function onAudioBlocked(fn: (() => void) | null): void {
  blockedHandler = fn;
}

/**
 * Asks the browser whether it will let this page make a noise, without making one.
 *
 * Plays the shortest file here at zero volume and immediately stops it. A page that waits to find
 * out the ordinary way learns it on the first square that changes hands, having already swallowed
 * that cue - which on a stream means the failure is discovered by the audience, in the form of
 * nothing.
 *
 * Also serves as the click handler when a real gesture arrives: the gesture is what lifts the
 * policy, so simply asking again after one is the whole of the recovery.
 *
 * Resolves true when sound is allowed. Never rejects - a refusal is an answer, not a fault.
 */
export function primeAudio(): Promise<boolean> {
  const probe = new Audio(base + FILES.mark);
  probe.volume = 0;
  return probe
    .play()
    .then(() => {
      probe.pause();
      probe.currentTime = 0;
      return true;
    })
    .catch(() => false);
}
