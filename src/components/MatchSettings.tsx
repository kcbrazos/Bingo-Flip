import { useRef, useState } from "react";
import { updateRoomSettings } from "../lib/rooms";
import { formatDuration } from "../lib/matchTime";
import {
  squareSet,
  SQUARE_SET_LIST,
  DEFAULT_SQUARE_SET,
  canCarryFlipBoard,
  poolSize,
  CUSTOM_SQUARE_SET_ID,
  MAX_CUSTOM_UPLOAD_BYTES,
  validateCustomSquareSetPayload,
  readStoredCustomSquareSet,
} from "../lib/challenges";
import {
  BONUS_PER_BINGO,
  BOARD_SIZE_CHOICES,
  DEFAULT_BONUS_PER_BINGO,
  DEFAULT_FLIP_COUNT,
  DEFAULT_PRACTICE,
  DEFAULT_WIN_CONDITION,
  FLIP_COUNTS,
  LOCKOUT_MODES,
  PRACTICE_MODES,
  WIN_CONDITIONS,
  defaultTargetScore,
  minObjectivesForFlip,
  targetScoreChoices,
  type WinCondition,
} from "../types/bingoFlip";
import type { Room } from "../types/bingoFlip";

/**
 * Preparation lengths the host can pick, every minute from none up to ten.
 *
 * A dropdown rather than the four buttons this used to be: the buttons offered 0, 1, 4 and 10 and
 * nothing between, so a room that wanted three minutes had to take four. Eleven buttons would be a
 * second wrapping row in a panel that already has one.
 */
const PREP_MAX_MINUTES = 10;
const PREP_CHOICES = Array.from({ length: PREP_MAX_MINUTES + 1 }, (_, m) => m * 60);

/**
 * A prep length as it reads in the dropdown: a bare minute count, the unit living in the field
 * label. Clock faces down a list of whole minutes are all zeroes after the colon and harder to
 * scan than "0 1 2 3". A length that isn't a whole minute can only be one set by hand, so it
 * keeps the clock rather than being rounded into a lie.
 */
function prepLabel(seconds: number): string {
  return seconds % 60 === 0 ? String(seconds / 60) : formatDuration(seconds);
}

interface Props {
  room: Room;
  isHost: boolean;
  onError: (message: string | null) => void;
}

/**
 * The match settings, live in the lobby.
 *
 * They used to be set once on the front page, before the room existed - which meant nobody but the
 * creator ever saw them, and a wrong board size could only be fixed by abandoning the room and
 * re-inviting everyone. Here they are visible to the whole lobby and changeable until the match
 * starts, which is also the last moment changing them is safe: once the flip squares are written and
 * the board is dealt, moving any of this would change a match already under way.
 */
export function MatchSettings({ room, isHost, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const boardSize = room.board_size;
  const prepSeconds = room.prep_seconds ?? 240;
  const lockout = room.lockout ?? true;
  const practice = room.practice ?? DEFAULT_PRACTICE;
  const winCondition = (room.win_condition ?? DEFAULT_WIN_CONDITION) as WinCondition;
  const flipCount = room.flip_count ?? DEFAULT_FLIP_COUNT;
  const bonusPerBingo = room.bonus_per_bingo ?? DEFAULT_BONUS_PER_BINGO;
  const targetScore = room.target_score ?? defaultTargetScore(boardSize);

  // A room carrying a length this menu can't offer - set before the choices changed, or by hand -
  // keeps it as an extra entry rather than having the dropdown render blank and silently rewrite it
  // to whatever sits at the top of the list.
  const prepChoices = PREP_CHOICES.includes(prepSeconds)
    ? PREP_CHOICES
    : [...PREP_CHOICES, prepSeconds].sort((a, b) => a - b);
  const set = squareSet(room.square_set ?? DEFAULT_SQUARE_SET, room.custom_square_set);
  const fitsBoard = canCarryFlipBoard(set.id, boardSize, room.custom_square_set);

  // Every set is offered regardless of size - a set thin for the chosen board gets a warning below
  // rather than being hidden, since a host who wants a huge non-repeating board on a small squareset
  // is a call for them to make, not one this menu should make for them.
  const sets = SQUARE_SET_LIST;

  // The host's own upload, if this room has one - kept even while a bundled set is selected, so
  // switching to Ringus and back to a custom upload doesn't mean re-picking the file.
  const customUpload = readStoredCustomSquareSet(room.custom_square_set);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function apply(patch: Parameters<typeof updateRoomSettings>[1]) {
    setBusy(true);
    onError(null);
    try {
      await updateRoomSettings(room.id, patch);
    } catch (e) {
      // Supabase/PostgREST errors are plain objects with a `message`, not an Error, so the usual
      // `instanceof Error` check misses them and prints "[object Object]" - most visible here since
      // this is the one settings panel whose values the database itself can still reject (a board
      // size check constraint, most concretely), where every other setting in this form is already
      // constrained to values the schema accepts.
      const message =
        e instanceof Error
          ? e.message
          : e && typeof e === "object" && "message" in e && typeof e.message === "string"
            ? e.message
            : String(e);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Reads and validates a host's uploaded squareset, then makes it the room's set.
   *
   * Validated here, before it ever reaches `apply()`, because a malformed file failing at the
   * database is a confusing error about a check constraint nobody wrote by hand; failing here is a
   * plain sentence about what's wrong with the JSON. It is re-validated again anyway on every read
   * (readStoredCustomSquareSet) - this is for a fast, specific error message, not the only gate.
   */
  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Cleared immediately so re-picking the same filename after fixing it still fires onChange.
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;

    onError(null);
    if (file.size > MAX_CUSTOM_UPLOAD_BYTES) {
      onError(`That file is ${Math.round(file.size / 1024)} KB - the limit is ${Math.round(MAX_CUSTOM_UPLOAD_BYTES / 1024)} KB.`);
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      onError("That file isn't valid JSON.");
      return;
    }

    const result = validateCustomSquareSetPayload(raw);
    if (!result.ok) {
      onError(result.error);
      return;
    }

    const label = file.name.replace(/\.json$/i, "").trim().slice(0, 60) || "Custom squares";
    await apply({
      square_set: CUSTOM_SQUARE_SET_ID,
      custom_square_set: { label, ...result.payload },
    });
  }

  const summary = `${set.label} · ${
    lockout ? "lockout" : "non-lockout"
  } · ${WIN_CONDITIONS[winCondition].label.toLowerCase()} · ${flipCount} flips · ${formatDuration(
    prepSeconds
  )} prep${practice ? " · practice, won't count" : ""}`;

  // Everyone sees the settings; only the host gets the buttons. A spectator or a player who
  // wandered in deserves to know what they're about to play without having to ask.
  if (!isHost) {
    return (
      <div className="panel row" style={{ gap: "0.5rem", alignItems: "baseline" }}>
        <span className="muted" style={{ fontSize: "0.78rem" }}>Match settings</span>
        <span style={{ fontSize: "0.82rem" }}>{summary}</span>
      </div>
    );
  }

  return (
    <div className="panel stack" style={{ gap: "0.55rem" }}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} style={{ fontSize: "0.82rem" }}>
        {open ? "▾" : "▸"} Match settings
        <span className="muted"> - {summary}</span>
      </button>

      {open && (
        <div className="stack" style={{ gap: "0.6rem", paddingLeft: "0.2rem" }}>
          <Field label="Board size">
            <select
              value={boardSize}
              disabled={busy}
              onChange={(e) => void apply({ board_size: Number(e.target.value) })}
            >
              {BOARD_SIZE_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n}x{n}
                </option>
              ))}
            </select>
          </Field>
          {!fitsBoard && (
            <span style={{ fontSize: "0.72rem", marginTop: "-0.35rem", color: "var(--accent)" }}>
              {set.label} only has {poolSize(set)} distinct objectives, and both faces of a {boardSize}x
              {boardSize} board need {minObjectivesForFlip(boardSize)} between them - so some will
              repeat across the two faces. Pick a smaller board or a different set to avoid that.
            </span>
          )}

          <Field label="Squares belong to">
            <Choice active={lockout} busy={busy} onClick={() => void apply({ lockout: true })}>
              {LOCKOUT_MODES.lockout.label}
            </Choice>
            <Choice active={!lockout} busy={busy} onClick={() => void apply({ lockout: false })}>
              {LOCKOUT_MODES.open.label}
            </Choice>
          </Field>
          <span className="muted" style={{ fontSize: "0.72rem", marginTop: "-0.35rem" }}>
            {lockout ? LOCKOUT_MODES.lockout.blurb : LOCKOUT_MODES.open.blurb}
          </span>

          <Field label="Bingos">
            {(Object.keys(WIN_CONDITIONS) as WinCondition[]).map((k) => (
              <Choice
                key={k}
                active={winCondition === k}
                busy={busy}
                onClick={() => void apply({ win_condition: k })}
              >
                {WIN_CONDITIONS[k].label}
              </Choice>
            ))}
          </Field>
          <span className="muted" style={{ fontSize: "0.72rem", marginTop: "-0.35rem" }}>
            {WIN_CONDITIONS[winCondition].blurb}
          </span>

          {/* Only under points. Under `line` a bingo ends the match, so there is nothing for it to be
              worth and no target to reach - showing either would be offering a setting that does
              nothing, which is worse than not offering it. */}
          {winCondition === "points" && (
            <>
              <Field label="A bingo is worth">
                {BONUS_PER_BINGO.map((n) => (
                  <Choice
                    key={n}
                    active={bonusPerBingo === n}
                    busy={busy}
                    onClick={() => void apply({ bonus_per_bingo: n })}
                  >
                    {n === 0 ? "nothing" : `${n} point${n === 1 ? "" : "s"}`}
                  </Choice>
                ))}
              </Field>
              <span className="muted" style={{ fontSize: "0.72rem", marginTop: "-0.35rem" }}>
                {bonusPerBingo === 0
                  ? "Lines are decoration. Only the square count decides it."
                  : `A square is a point; a completed row, column or diagonal is worth ${bonusPerBingo} more.`}
              </span>

              <Field label={`First to ${targetScore} points`}>
                {targetScoreChoices(boardSize).map((n) => (
                  <Choice
                    key={n}
                    active={targetScore === n}
                    busy={busy}
                    onClick={() => void apply({ target_score: n })}
                  >
                    {n}
                  </Choice>
                ))}
              </Field>
              <span className="muted" style={{ fontSize: "0.72rem", marginTop: "-0.35rem" }}>
                {/* The number worth knowing when picking a target: what the board can pay out. A
                    target above the square count is only reachable on bonus points, so on a board
                    with the bonus at zero it would be a match nobody can win. */}
                {boardSize * boardSize} squares on the board
                {bonusPerBingo > 0
                  ? `, plus ${bonusPerBingo} a bingo`
                  : " - and bingos pay nothing, so that is the ceiling"}
                .
              </span>
            </>
          )}

          {/* Flip squares are consumed, so this is also the most times a match can turn over. */}
          <Field label="Flip squares">
            {FLIP_COUNTS.map((n) => (
              <Choice
                key={n}
                active={flipCount === n}
                busy={busy}
                onClick={() => void apply({ flip_count: n })}
              >
                {n}
              </Choice>
            ))}
          </Field>
          <span className="muted" style={{ fontSize: "0.72rem", marginTop: "-0.35rem" }}>
            Marked on the board. Claiming one turns it onto the other face; each can only do that
            once, so the board turns at most {flipCount} time{flipCount === 1 ? "" : "s"}.
          </span>

          <Field label="Squares">
            {sets.map((s) => (
              <Choice
                key={s.id}
                active={set.id === s.id}
                busy={busy}
                onClick={() => void apply({ square_set: s.id })}
              >
                {s.label}
              </Choice>
            ))}
            {/* Only once a room has one - there is nothing to switch back to before that. Kept in
                `custom_square_set` independently of `square_set`, so leaving it for a bundled set
                and coming back doesn't mean uploading the file again. */}
            {customUpload && (
              <Choice
                active={set.id === CUSTOM_SQUARE_SET_ID}
                busy={busy}
                onClick={() => void apply({ square_set: CUSTOM_SQUARE_SET_ID })}
              >
                {customUpload.label}
              </Choice>
            )}
          </Field>
          <span className="muted" style={{ fontSize: "0.72rem", marginTop: "-0.35rem" }}>
            {set.blurb}
          </span>

          <Field label="Or upload your own (.json)">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={(e) => void handleUpload(e)}
            />
          </Field>
          <span className="muted" style={{ fontSize: "0.72rem", marginTop: "-0.35rem" }}>
            Either shape the bundled sets use: a plain list of {"{ name, tooltip }"}, or an object
            with a "squares" array and optional category limits. Uploading picks it for the room
            immediately, the same as clicking one of the buttons above.
          </span>

          <Field label="Reading time before claiming opens (minutes)">
            <select
              value={prepSeconds}
              disabled={busy}
              onChange={(e) => void apply({ prep_seconds: Number(e.target.value) })}
            >
              {prepChoices.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {prepLabel(seconds)}
                  {seconds === 0 ? " - none" : ""}
                </option>
              ))}
            </select>
          </Field>

          <Field label="This match">
            <Choice active={!practice} busy={busy} onClick={() => void apply({ practice: false })}>
              {PRACTICE_MODES.counted.label}
            </Choice>
            <Choice active={practice} busy={busy} onClick={() => void apply({ practice: true })}>
              {PRACTICE_MODES.practice.label}
            </Choice>
          </Field>
          <span className="muted" style={{ fontSize: "0.72rem", marginTop: "-0.35rem" }}>
            {practice ? PRACTICE_MODES.practice.blurb : PRACTICE_MODES.counted.blurb}
          </span>

          {/* Only when the set comfortably covers this board - the warning above already covers the
              case where it doesn't, and saying both would just be saying the same thing twice. What
              is worth saying here is why the two faces never repeat an objective, because that is
              the rule a player notices and wonders about. */}
          {fitsBoard && (
            <span className="muted" style={{ fontSize: "0.72rem" }}>
              Both faces come out of {set.label} and share no objective, so this board needs{" "}
              {minObjectivesForFlip(boardSize)} different ones. Nothing you have already done comes
              back when it turns.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="stack" style={{ gap: "0.25rem" }}>
      <span className="muted" style={{ fontSize: "0.78rem" }}>{label}</span>
      {/* Wraps: eleven target-score buttons don't fit one row on a narrow window. */}
      <div className="row" style={{ gap: "0.35rem", flexWrap: "wrap" }}>{children}</div>
    </label>
  );
}

function Choice({
  active,
  busy,
  onClick,
  children,
}: {
  active: boolean;
  busy: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      disabled={busy}
      onClick={onClick}
      aria-pressed={active}
      // minWidth keeps a wrapped row from stretching three buttons across the whole panel while
      // the rest sit underneath.
      style={{ flex: "1 0 4rem", minWidth: "4rem", borderColor: active ? "var(--accent)" : undefined }}
    >
      {children}
    </button>
  );
}
