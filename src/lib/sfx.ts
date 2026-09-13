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

/** 0-1. Defaults to 0.7 rather than full blast on a fresh browser. */
export function getVolume(): number {
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
    // Autoplay can be blocked before the first user gesture - not worth surfacing to the player.
  });
}
