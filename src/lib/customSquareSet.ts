/**
 * A host's own squareset, uploaded as a .json file instead of picked from the bundled sets.
 *
 * The bundled sets (squareSets.ts) are trusted at build time - nothing here validates them, because
 * they never change without a human reading a diff first. An upload has no such gate: it lands in
 * `rooms.custom_square_set` where any client in the room, including the one that never opened the
 * file, will build a board from it. A malformed upload is therefore not the uploader's problem alone
 * - it is the whole room's board generation crashing on every screen at once. Every entry point here
 * re-checks the shape rather than trusting an earlier check ran, for exactly that reason: the stored
 * row could have been written by a different version of this code, or by hand.
 *
 * Deliberately independent of squareSetFormat.ts's "no imports" rule - that rule exists so
 * scripts/check-flip.ts can run the DEALING logic under bare Node, and this module is never on that
 * path. Importing its types here (Challenge, BingoSquareSet, BingoSquare, SetRegionLimit) is exactly
 * the point: this file's whole job is to answer "is this JSON shaped like one of those".
 */
import type { BingoSquare, BingoSquareSet, Challenge, SetRegionLimit } from "./squareSetFormat";

/** The `square_set` value a room carries while playing a host's upload rather than a bundled set. */
export const CUSTOM_SQUARE_SET_ID = "custom";

/**
 * A cap on square count, not a design opinion about how big a squareset "should" be.
 *
 * Every bundled set is comfortably under 200. This is here so an upload can't make board generation
 * slow (pickSquares is quadratic-ish in the category-limit passes) or make the `rooms` row itself
 * unreasonably large - it is replicated to every client in the room over Realtime on every settings
 * change.
 */
export const MAX_CUSTOM_SQUARES = 2000;

/** A cap on the uploaded file itself, checked before it is even read, let alone parsed. */
export const MAX_CUSTOM_UPLOAD_BYTES = 1_000_000;

/** The validated payload, tagged by which of the two known shapes it matched. */
export type CustomSquareSetPayload =
  | { format: "flat"; data: Challenge[] }
  | { format: "bingo"; data: BingoSquareSet };

/**
 * What actually lives in `rooms.custom_square_set` - the payload plus a name to show in the lobby.
 *
 * A discriminated union over `format`, same shape as CustomSquareSetPayload plus `label`, so
 * `stored.format === "bingo"` narrows `stored.data` to BingoSquareSet at every call site without a
 * cast.
 */
export type StoredCustomSquareSet = { label: string } & CustomSquareSetPayload;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown, maxLen = 300): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= maxLen;
}

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };

function fail(error: string): Err {
  return { ok: false, error };
}

function validateFlatSquares(list: unknown[]): Ok<{ data: Challenge[] }> | Err {
  if (list.length === 0) return fail("The list has no squares in it.");
  if (list.length > MAX_CUSTOM_SQUARES) {
    return fail(`Too many squares (${list.length}) - the limit is ${MAX_CUSTOM_SQUARES}.`);
  }
  const data: Challenge[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!isPlainObject(item)) return fail(`Entry ${i + 1} isn't an object.`);
    if (!isNonEmptyString(item.name)) return fail(`Entry ${i + 1} needs a non-empty "name" string.`);
    if (item.tooltip !== undefined && typeof item.tooltip !== "string") {
      return fail(`Entry ${i + 1}: "tooltip" must be a string.`);
    }
    data.push({ name: item.name, tooltip: typeof item.tooltip === "string" ? item.tooltip : undefined });
  }
  return { ok: true, data };
}

/** `"category limits"` / `"category minimums"`: both a map of category name to a non-negative number. */
function validateCategoryNumberMap(
  value: unknown,
  field: string
): Ok<{ map: Record<string, number> | undefined }> | Err {
  if (value === undefined) return { ok: true, map: undefined };
  if (!isPlainObject(value)) return fail(`"${field}" must be an object mapping category names to numbers.`);
  const map: Record<string, number> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return fail(`"${field}.${key}" must be a non-negative number.`);
    }
    map[key] = v;
  }
  return { ok: true, map };
}

function validateSetRegionLimits(value: unknown): Ok<{ limits: SetRegionLimit[] | undefined }> | Err {
  if (value === undefined) return { ok: true, limits: undefined };
  if (!Array.isArray(value)) return fail('"setRegionLimits" must be an array.');
  const limits: SetRegionLimit[] = [];
  for (let i = 0; i < value.length; i++) {
    const rule = value[i];
    if (
      !isPlainObject(rule) ||
      !isNonEmptyString(rule.name) ||
      !Array.isArray(rule.regionNames) ||
      rule.regionNames.length === 0 ||
      !rule.regionNames.every((r) => typeof r === "string") ||
      typeof rule.regionLimit !== "number" ||
      !Number.isFinite(rule.regionLimit)
    ) {
      return fail(`"setRegionLimits[${i}]" must be { name, regionNames: string[], regionLimit: number }.`);
    }
    limits.push({ name: rule.name, regionNames: rule.regionNames as string[], regionLimit: rule.regionLimit });
  }
  return { ok: true, limits };
}

function validateBingoSquares(obj: Record<string, unknown>): Ok<{ data: BingoSquareSet }> | Err {
  const rawSquares = obj.squares;
  if (!Array.isArray(rawSquares)) return fail('Expected a "squares" array.');
  if (rawSquares.length === 0) return fail("The squares array is empty.");
  if (rawSquares.length > MAX_CUSTOM_SQUARES) {
    return fail(`Too many squares (${rawSquares.length}) - the limit is ${MAX_CUSTOM_SQUARES}.`);
  }

  const squares: BingoSquare[] = [];
  for (let i = 0; i < rawSquares.length; i++) {
    const item = rawSquares[i];
    if (!isPlainObject(item)) return fail(`Square ${i + 1} isn't an object.`);
    if (!isNonEmptyString(item.name)) return fail(`Square ${i + 1} needs a non-empty "name" string.`);
    if (item.categories !== undefined) {
      if (!Array.isArray(item.categories) || !item.categories.every((c) => typeof c === "string")) {
        return fail(`Square ${i + 1}: "categories" must be an array of strings.`);
      }
    }
    if (item.category !== undefined && typeof item.category !== "string") {
      return fail(`Square ${i + 1}: "category" must be a string.`);
    }
    if (item.tooltip !== undefined && typeof item.tooltip !== "string") {
      return fail(`Square ${i + 1}: "tooltip" must be a string.`);
    }
    if (
      item.weight !== undefined &&
      (typeof item.weight !== "number" || !Number.isFinite(item.weight) || item.weight <= 0)
    ) {
      return fail(`Square ${i + 1}: "weight" must be a positive number.`);
    }
    if (item.region !== undefined && typeof item.region !== "string") {
      return fail(`Square ${i + 1}: "region" must be a string.`);
    }
    // Everything else passes through untouched - that's the format's own %variable% extension point
    // (see BingoSquare), and it isn't this validator's job to know every set author's variable names.
    squares.push(item as BingoSquare);
  }

  const limits = validateCategoryNumberMap(obj["category limits"], "category limits");
  if (!limits.ok) return limits;
  const minimums = validateCategoryNumberMap(obj["category minimums"], "category minimums");
  if (!minimums.ok) return minimums;
  const regionLimits = validateSetRegionLimits(obj.setRegionLimits);
  if (!regionLimits.ok) return regionLimits;

  const data: BingoSquareSet = { squares };
  if (limits.map) data["category limits"] = limits.map;
  if (minimums.map) data["category minimums"] = minimums.map;
  if (regionLimits.limits) data.setRegionLimits = regionLimits.limits;
  return { ok: true, data };
}

/**
 * Checks that `raw` is shaped like one of the two formats squareSets.ts already knows: a bare array
 * (flat, like Ringus) or an object carrying a `squares` array (bingo, like the other three).
 *
 * Used twice: once on the freshly-parsed upload, and again - unconditionally, not as a fallback - on
 * whatever is read back out of `rooms.custom_square_set`, since that row can outlive the code that
 * wrote it and nothing else stands between it and every client's board generation.
 */
export function validateCustomSquareSetPayload(raw: unknown): Ok<{ payload: CustomSquareSetPayload }> | Err {
  if (Array.isArray(raw)) {
    const result = validateFlatSquares(raw);
    return result.ok ? { ok: true, payload: { format: "flat", data: result.data } } : result;
  }
  if (isPlainObject(raw) && Array.isArray(raw.squares)) {
    const result = validateBingoSquares(raw);
    return result.ok ? { ok: true, payload: { format: "bingo", data: result.data } } : result;
  }
  return fail('The file must be a JSON array of squares, or an object with a "squares" array.');
}

/**
 * Reads `rooms.custom_square_set` back into a usable set, or null if it is missing, was written by
 * something that skipped validation, or has since been corrupted some other way.
 *
 * squareSet() falls back to the default set on null exactly as it already does for any other
 * unrecognized `square_set` id - a room that somehow lost its upload plays the default rather than
 * showing nobody anything.
 */
export function readStoredCustomSquareSet(raw: unknown): StoredCustomSquareSet | null {
  if (!isPlainObject(raw) || !isNonEmptyString(raw.label, 60)) return null;
  const result = validateCustomSquareSetPayload(raw.data);
  if (!result.ok || result.payload.format !== raw.format) return null;
  return { label: raw.label, ...result.payload };
}
