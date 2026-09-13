/**
 * Composes art/og-card.svg: the favicon's ring over the wordmark, with every glyph baked to a
 * path so the file renders identically anywhere, with or without Cinzel installed.
 *
 * Deliberately NOT wired into package.json. It runs perhaps once a year - only if the card's
 * wording changes - and its two dependencies exist purely to read a font file, which is no reason
 * for every clone of this repo to install them. Run it from the repo root with:
 *
 *   npm i --no-save wawoff2 opentype.js
 *   node art/build-og-card.mjs
 *   npx sharp-cli -i art/og-card.svg -o public/og-card.png resize 1200 630
 *
 * The SVG it writes is self-contained, so small edits (a colour, a position) are better made in
 * the SVG directly - this is only needed when the LETTERING changes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as wawoff2 from "wawoff2";
import opentype from "opentype.js";

const ttf = await wawoff2.decompress(readFileSync("src/assets/fonts/cinzel-latin.woff2"));
// Buffer.from() on a Uint8Array copies into a POOLED ArrayBuffer at a nonzero byteOffset, so
// .buffer.slice(0) hands opentype the pool from the wrong origin - it parses, and emits NaN
// coordinates in scattered glyphs. Slice at the view's own offset.
const font = opentype.parse(ttf.buffer.slice(ttf.byteOffset, ttf.byteOffset + ttf.byteLength));

const EM = 100;

function layout(text, trackEm) {
  const track = trackEm * EM;
  let x = 0;
  const parts = [];
  const glyphs = font.stringToGlyphs(text);
  glyphs.forEach((g, i) => {
    // Round before handing x over: opentype.js's toPathData emits NaN coordinates when the pen
    // position carries float dust (76.80000000000001), and the glyph silently loses contours.
    if (text[i] !== " ") parts.push(g.getPath(Math.round(x * 100) / 100, 0, EM).toPathData(2));
    x += (g.advanceWidth / font.unitsPerEm) * EM + track;
    if (i < glyphs.length - 1) x += (font.getKerningValue(g, glyphs[i + 1]) / font.unitsPerEm) * EM;
  });
  return { d: parts.join(" "), width: x - track };
}

const W = 1200, H = 630;

const bingo = layout("Bingo", 0.14);
const flip = layout("Flip", 0.14);
const GAP = 0.34 * EM;                      // .brand-word-b's margin-left
const wordW = bingo.width + GAP + flip.width;
const wordScale = 700 / wordW;              // target painted width
const wordX = (W - 700) / 2;
const wordBase = 408;                       // baseline

const tag = layout("Some squares turn the board over", 0.22);
const tagScale = 232 / EM * 0.1;            // ~23px em
const tagW = tag.width * tagScale;

const ringScale = 2.5;                      // favicon's 64 grid -> 160px
const ringX = W / 2 - 32 * ringScale;
const ringY = 118;

const svg = `<!--
  Link-unfurl card, 1200x630 - the size Discord, Twitter and Slack all crop toward.

  Every letter here is an outline, not text. Cinzel is vendored into the app as a woff2, which a
  standalone renderer has no way to load, so the glyphs were converted once (wawoff2 -> opentype.js)
  and baked in. The file therefore renders the same in every tool, and nothing about it can drift
  when someone's machine lacks the font.

  Painted on an opaque plate rather than shipped transparent: an unfurl lands on whatever background
  the client uses, and gilt lettering with a glow disappears against a light one.

  Re-render after editing with:
    npx sharp-cli -i art/og-card.svg -o public/og-card.png resize 1200 630
-->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Bingo Flip">
  <defs>
    <!-- The page's own ground: lit from above, black at the foot. -->
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#17251b"/>
      <stop offset="1" stop-color="#0b1410"/>
    </linearGradient>
    <!-- A soft lift behind the mark, so the plate isn't a flat rectangle. -->
    <radialGradient id="lift" cx="0.5" cy="0.3" r="0.62">
      <stop offset="0" stop-color="#2b4230" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#2b4230" stop-opacity="0"/>
    </radialGradient>
    <!-- The wordmark's gilt, stop for stop from .brand-word in BrandMark.css: bright where struck
         metal catches the light, bronze at the feet, warming toward the ember the board flips to. -->
    <!-- userSpaceOnUse resolves in the coordinate system in force where the gradient is REFERENCED,
         which for the wordmark is the glyphs' own space - baseline at 0, cap line at -70. Stating
         it in page coordinates paints the whole word from the first stop. -->
    <linearGradient id="gilt" gradientUnits="userSpaceOnUse" x1="0" y1="-70" x2="0" y2="0">
      <stop offset="0" stop-color="#fbf0cd"/>
      <stop offset="0.26" stop-color="#f2d98a"/>
      <stop offset="0.58" stop-color="#d9b45b"/>
      <stop offset="0.84" stop-color="#b8823a"/>
      <stop offset="1" stop-color="#9c5f2a"/>
    </linearGradient>
    <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#d9b45b" stop-opacity="0"/>
      <stop offset="0.22" stop-color="#d9b45b"/>
      <stop offset="0.5" stop-color="#f2d98a"/>
      <stop offset="0.78" stop-color="#d9b45b"/>
      <stop offset="1" stop-color="#d9b45b" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#ground)"/>
  <rect width="${W}" height="${H}" fill="url(#lift)"/>

  <!-- The favicon's ring, without its plate: two arcs chasing each other, gold over the top and
       ember under the bottom, each ending in a head that breaks the circle. -->
  <g transform="translate(${ringX.toFixed(1)} ${ringY}) scale(${ringScale})">
    <g fill="none" stroke-width="9">
      <path d="M16.0 26.2 A17 17 0 0 1 48.0 26.2" stroke="#f2d98a"/>
      <path d="M48.0 37.8 A17 17 0 0 1 16.0 37.8" stroke="#e0521f"/>
    </g>
    <path d="M51.1 34.7 L40.4 25.8 L53.5 21.0 Z" fill="#f2d98a"/>
    <path d="M13.0 29.4 L23.6 38.2 L10.5 43.0 Z" fill="#e0521f"/>
  </g>

  <!-- The wordmark. The stroke is not an outline: Cinzel is a variable font and these outlines come
       off its 400 default, while the site sets 700, so a hairline of the same paint carries the
       stems back up to the weight the page shows. -->
  <g fill="url(#gilt)" stroke="url(#gilt)" stroke-width="${(3 / wordScale).toFixed(2)}" stroke-linejoin="round"
     transform="translate(${wordX.toFixed(1)} ${wordBase}) scale(${wordScale.toFixed(4)})">
    <path d="${bingo.d}"/>
    <g transform="translate(${(bingo.width + GAP).toFixed(1)} 0)"><path d="${flip.d}"/></g>
  </g>

  <!-- The hairline the mark sits on, fading at both ends so it reads as struck into the page. -->
  <rect x="${wordX.toFixed(1)}" y="${wordBase + 30}" width="700" height="1.5" fill="url(#rule)" opacity="0.7"/>

  <g fill="#c9b48a" opacity="0.82" transform="translate(${((W - tagW) / 2).toFixed(1)} 500) scale(${tagScale.toFixed(4)})">
    <path d="${tag.d}"/>
  </g>
</svg>
`;

writeFileSync("art/og-card.svg", svg);
console.log(`word ${wordW.toFixed(0)}u -> scale ${wordScale.toFixed(3)}, tag ${tagW.toFixed(0)}px`);
