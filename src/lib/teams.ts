/**
 * Who is on which team, and who speaks for it.
 *
 * Lifted out of the old battleshipLogic, where these two sat among the ship maths despite having
 * nothing to do with it. They are about the roster, which every mode of this app has.
 */

/** Every team with at least one player on it, ascending. Spectators (team null) are not a team. */
export function activeTeams(players: { team: number | null }[]): number[] {
  const teams = new Set<number>();
  for (const p of players) {
    if (p.team !== null && p.team !== undefined) teams.add(p.team);
  }
  return [...teams].sort((a, b) => a - b);
}

/**
 * The captain of a team: whoever picked it first.
 *
 * Must match team_captain() in SQL exactly - same ordering, same tie-break - or the UI will offer
 * controls the database then refuses. Rows without a team_joined_at sort last, which puts anyone
 * predating that column behind players who have picked since.
 */
export function captainOf<T extends { id: string; team: number | null; team_joined_at?: string | null }>(
  players: T[],
  team: number
): T | null {
  const crew = players.filter((p) => p.team === team);
  if (crew.length === 0) return null;

  return [...crew].sort((a, b) => {
    const at = a.team_joined_at ?? null;
    const bt = b.team_joined_at ?? null;
    if (at !== bt) {
      if (at === null) return 1; // nulls last
      if (bt === null) return -1;
      return at.localeCompare(bt);
    }
    return a.id.localeCompare(b.id);
  })[0];
}
