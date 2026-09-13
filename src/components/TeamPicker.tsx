import { useState } from "react";
import { setPlayerTeam } from "../lib/rooms";
import { TEAM_COLORS, teamName, teamHex } from "../lib/teamColors";
import type { Player } from "../types/bingoFlip";

interface Props {
  playerId: string;
  currentTeam: number | null;
  players: Player[];
  onError?: (message: string | null) => void;
}

/**
 * "Your team" picker, shared by the lobby and the post-match screen.
 *
 * Shown on both because those are precisely the two moments switching sides is legitimate. It is
 * deliberately absent from prep and battle, and the database enforces the same rule via a
 * trigger - the UI hiding a control was never actually preventing anything.
 */
export function TeamPicker({ playerId, currentTeam, players, onError }: Props) {
  const [busy, setBusy] = useState(false);

  // Every color is selectable from the start; teams with nobody in them are just marked as such.
  const allTeams = TEAM_COLORS.map((_, i) => i);

  async function change(value: number) {
    setBusy(true);
    onError?.(null);
    try {
      // One write, where Battleship needed two: picking a team there also had to create that team's
      // fleet row. There is nothing per-team to create here - a team exists because a player is on
      // it, and its squares are rows in the shared claim log.
      await setPlayerTeam(playerId, value === -1 ? null : value);
    } catch (e) {
      // The trigger's message is written to be shown as-is ("Teams are locked once a match has
      // started"), so surface it rather than inventing wording for a case that shouldn't be
      // reachable through this component anyway.
      onError?.(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel row" style={{ justifyContent: "center", gap: "0.75rem" }}>
      <span className="muted">Your team:</span>
      <select value={currentTeam ?? -1} disabled={busy} onChange={(e) => void change(Number(e.target.value))}>
        <option value={-1}>Spectator</option>
        {allTeams.map((t) => (
          <option key={t} value={t}>
            {teamName(t)}
            {players.some((p) => p.team === t) ? "" : " (empty)"}
          </option>
        ))}
      </select>
      <span
        aria-hidden
        style={{
          width: "1.1rem",
          height: "1.1rem",
          borderRadius: "50%",
          background: currentTeam !== null ? teamHex(currentTeam) : "var(--text-dim)",
          border: "1px solid var(--panel-border)",
        }}
      />
    </div>
  );
}
