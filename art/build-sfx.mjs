/**
 * Synthesises the match sounds in public/sfx.
 *
 * Deliberately NOT wired into package.json - it runs when a sound is being redesigned and never
 * otherwise, and the committed audio is what ships. Run it from the repo root:
 *
 *   node art/build-sfx.mjs
 *
 * It shells out to ffmpeg to encode, writing each WAV next to its mp3 and removing it again - only
 * the mp3s are committed.
 *
 * -- Why these are synthesised rather than sampled --------------------------------------------
 *
 * A bingo board makes a LOT of noise: a square is claimed every few seconds for twenty minutes, and
 * the claim sound is heard perhaps forty times a match by every player and everyone watching the
 * stream. That rules out anything with a recorded room in it - reverb tails stack, and forty of
 * them is mud. Struck-metal partials decay to true silence, which is what lets the mark fire
 * repeatedly without ever accumulating.
 *
 * It also means every sound can be tuned to the same pitch centre (A = 220) so that two landing
 * close together are consonant rather than merely simultaneous.
 */
import { writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";

const RATE = 44100;

/* --- the synth ------------------------------------------------------------------------------ */

/**
 * One struck partial: a sine that starts at full and decays exponentially to nothing.
 *
 * `decay` is the time to -60dB, which is the number that actually describes how long a listener
 * hears it - amplitude-halving times are a poor guide once several partials overlap.
 */
function partial(buf, { freq, amp, decay, start = 0, detune = 0 }) {
  const from = Math.floor(start * RATE);
  const k = Math.log(1000) / decay; // e^(-k*decay) = 1/1000 = -60dB
  for (let i = from; i < buf.length; i++) {
    const t = (i - from) / RATE;
    const env = Math.exp(-k * t);
    if (env < 1e-4) break;
    buf[i] += amp * env * Math.sin(2 * Math.PI * (freq + detune) * t);
  }
}

/**
 * The strike itself: a very short burst of filtered noise.
 *
 * Without it a bell is a pure tone that fades in from nowhere, no matter how sharp the envelope -
 * the ear reads the transient, not the attack slope, as "something was hit". One-pole lowpass so it
 * is a wooden knock rather than a hiss.
 */
function strike(buf, { amp, decay, cutoff, start = 0, seed = 1 }) {
  const from = Math.floor(start * RATE);
  const k = Math.log(1000) / decay;
  // Deterministic noise, so rebuilding this file produces byte-identical audio.
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
  const a = Math.exp((-2 * Math.PI * cutoff) / RATE);
  let last = 0;
  for (let i = from; i < buf.length; i++) {
    const t = (i - from) / RATE;
    const env = Math.exp(-k * t);
    if (env < 1e-4) break;
    last = (1 - a) * rand() + a * last;
    buf[i] += amp * env * last;
  }
}

/**
 * A bell, as an inharmonic stack.
 *
 * The ratios are the ones that make struck metal sound like metal rather than like an organ: a flat
 * minor third above the fundamental, then partials that are not whole multiples of anything. Higher
 * partials decay faster, which is the other half of it - a bell gets darker as it rings out, and a
 * stack whose partials all decay together sounds synthetic no matter how the ratios are chosen.
 */
function bell(buf, { freq, amp, decay, start = 0 }) {
  const RATIOS = [
    [1.0, 1.0, 1.0],
    [2.0, 0.55, 0.72],
    [2.4, 0.38, 0.55],
    [3.0, 0.22, 0.42],
    [4.2, 0.14, 0.3],
    [5.4, 0.09, 0.22],
  ];
  for (const [r, a, d] of RATIOS) {
    partial(buf, { freq: freq * r, amp: amp * a, decay: decay * d, start });
  }
}

/** Fade the last 25ms to zero, so nothing ends on a click. */
function tail(buf) {
  const n = Math.min(buf.length, Math.floor(RATE * 0.025));
  for (let i = 0; i < n; i++) buf[buf.length - 1 - i] *= i / n;
}

/** Normalise to a fixed peak, so the three sounds sit at the same level relative to each other. */
function normalise(buf, peak) {
  let max = 0;
  for (const v of buf) max = Math.max(max, Math.abs(v));
  if (max === 0) return;
  const g = peak / max;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
}

function writeWav(path, buf) {
  const pcm = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) {
    // Soft clip rather than hard, so a stacked peak rounds over instead of tearing.
    const v = Math.tanh(buf[i]);
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([head, pcm]));
}

const seconds = (s) => new Float64Array(Math.floor(RATE * s));

/* --- the sounds ----------------------------------------------------------------------------- */

const A = 220;

/**
 * MARK - a square changed hands.
 *
 * The one that fires forty times a match, so it is built to be ignorable: 180ms, one bell, gone.
 * It says "that landed" and nothing else, and deliberately carries no sense of good or bad news -
 * the same sound plays whoever took the square, because the board already says whose it is in
 * colour and a sound that took sides would be wrong for half the room.
 *
 * Pitched high (A5) and decaying fast so it cuts through whatever else is happening without
 * needing volume to do it.
 */
{
  const buf = seconds(0.25);
  strike(buf, { amp: 0.5, decay: 0.012, cutoff: 2600, seed: 7 });
  bell(buf, { freq: A * 4, amp: 0.55, decay: 0.18 });
  bell(buf, { freq: A * 6, amp: 0.16, decay: 0.1 });
  tail(buf);
  normalise(buf, 0.72);
  writeWav("public/sfx/mark.wav", buf);
}

/**
 * BINGO - somebody completed a line.
 *
 * Has to be unmistakable against the mark, which is the sound it will always follow: the claim that
 * closes a line plays this INSTEAD of the mark, so the two never sound together and the difference
 * between them is the whole message. So it is three notes where the mark is one, rising, and it
 * rings for a second and a half where the mark is gone in a fifth of that.
 *
 * A major triad up (A, C#, E), the same A the mark is tuned to, arriving fast enough to read as one
 * gesture rather than as three events. The low octave underneath is what gives it weight - without
 * it the arpeggio is bright and thin and sounds like a notification.
 */
{
  const buf = seconds(1.6);
  const notes = [A * 2, A * 2 * 1.26, A * 2 * 1.5];
  notes.forEach((f, i) => {
    const at = i * 0.075;
    strike(buf, { amp: 0.3, decay: 0.01, cutoff: 3000, start: at, seed: 11 + i });
    bell(buf, { freq: f, amp: 0.5, decay: 1.0 + i * 0.25, start: at });
  });
  // The octave below the root, struck with the last note so the chord lands rather than trails off.
  bell(buf, { freq: A, amp: 0.3, decay: 1.5, start: 0.15 });
  tail(buf);
  normalise(buf, 0.82);
  writeWav("public/sfx/bingo.wav", buf);
}

/**
 * START - the board is open, go.
 *
 * Explicitly not a horn. A horn is a sustained buzz that gets louder, which is a warning: the right
 * sound for a ship about to be shot at and the wrong one for twenty-five objectives going live.
 * This is a struck bowl - a low swell that fades UP over half a second, then the strike over the
 * top, then a long ring out. The gesture is "the doors open", not "look out".
 *
 * Tuned a fifth below the mark so the first square claimed is consonant with the tail of this still
 * ringing, which on a fast opening is a real overlap rather than a theoretical one.
 */
{
  const buf = seconds(2.2);
  // The swell: two low partials faded in by hand, since everything else here decays from its onset.
  const fade = Math.floor(RATE * 0.55);
  for (let i = 0; i < buf.length; i++) {
    const t = i / RATE;
    const env = (i < fade ? i / fade : Math.exp(-Math.log(1000) * ((t - 0.55) / 1.7))) * 0.34;
    if (env < 1e-4) continue;
    buf[i] += env * (Math.sin(2 * Math.PI * (A / 2) * t) + 0.5 * Math.sin(2 * Math.PI * (A * 0.75) * t));
  }
  // The strike, landing on top of the swell at its peak rather than at the start.
  strike(buf, { amp: 0.42, decay: 0.03, cutoff: 1500, start: 0.5, seed: 23 });
  bell(buf, { freq: A * 1.5, amp: 0.6, decay: 1.7, start: 0.5 });
  bell(buf, { freq: A * 3, amp: 0.22, decay: 1.2, start: 0.5 });
  tail(buf);
  normalise(buf, 0.8);
  writeWav("public/sfx/start.wav", buf);
}

/* --- encode --------------------------------------------------------------------------------- */
// 96k mono VBR. These are short, narrow-band and mostly decaying sine partials, which is the
// easiest thing in the world for an encoder - the files land under 25KB each and the difference
// from the WAV is inaudible over a stream.
for (const name of ["mark", "bingo", "start"]) {
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-i", `public/sfx/${name}.wav`,
    "-codec:a", "libmp3lame", "-q:a", "6", "-ac", "1",
    `public/sfx/${name}.mp3`,
  ]);
  unlinkSync(`public/sfx/${name}.wav`);
  console.log(`wrote public/sfx/${name}.mp3`);
}
