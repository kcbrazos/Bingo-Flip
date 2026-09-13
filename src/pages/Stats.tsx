import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { LoadingScreen } from "../components/BrandMark";
import { teamHex, teamName } from "../lib/teamColors";
import { formatRoomCode } from "../lib/roomCode";
import { formatDuration } from "../lib/matchTime";
import { squareSet } from "../lib/challenges";
import {
  archiveTotals,
  careerRows,
  fetchArchive,
  sortCareer,
  WIN_RATE_MINIMUM,
  type CareerSort,
  type MatchPlayer,
  type MatchResult,
} from "../lib/stats";
import "./Stats.css";

const COLUMNS: { key: CareerSort; label: string; title: string }[] = [
  { key: "wins", label: "Won", title: "Matches won" },
  { key: "matches", label: "Played", title: "Matches finished" },
  { key: "winRate", label: "Win rate", title: `Needs ${WIN_RATE_MINIMUM} matches to rank` },
  { key: "squares", label: "Squares", title: "Squares claimed across every match" },
  { key: "flips", label: "Flips", title: "Squares claimed that turned the board over" },
];

export function Stats() {
  const [matches, setMatches] = useState<MatchResult[] | null>(null);
  const [players, setPlayers] = useState<MatchPlayer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<CareerSort>("wins");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const archive = await fetchArchive();
        if (cancelled) return;
        setMatches(archive.matches);
        setPlayers(archive.players);
      } catch (e) {
        if (!cancelled) {
          setMatches([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const career = useMemo(() => sortCareer(careerRows(players), sort), [players, sort]);
  const totals = useMemo(() => archiveTotals(matches ?? []), [matches]);

  if (matches === null) return <LoadingScreen>Reading the records...</LoadingScreen>;

  if (error) {
    return (
      <div className="panel stack" style={{ width: "min(480px, 100%)", alignItems: "center", textAlign: "center" }}>
        <h2 style={{ margin: 0 }}>Couldn't read the records</h2>
        <p className="error-text" style={{ margin: 0 }}>{error}</p>
        <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
          If this project hasn't had the match-archive migration applied yet, that's the cause -
          see supabase/migrations.
        </p>
        <Link to="/">Return to the round table</Link>
      </div>
    );
  }

  /**
   * Nothing has been played yet.
   *
   * Said plainly rather than shown as an empty table. A leaderboard with headings and no rows reads
   * as broken; a sentence reads as new.
   */
  if (matches.length === 0) {
    return (
      <div className="panel stack" style={{ width: "min(480px, 100%)", alignItems: "center", textAlign: "center" }}>
        <h2 style={{ margin: 0 }}>No matches on record</h2>
        <p className="muted" style={{ margin: 0 }}>
          A match is filed the moment it finishes. Play one and it lands here.
        </p>
        <Link to="/">Return to the round table</Link>
      </div>
    );
  }

  return (
    <div className="stats stack">
      <header className="stack" style={{ gap: "0.2rem" }}>
        <h1 style={{ margin: 0 }}>Records</h1>
        <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
          Every finished match, and who has been winning them.
        </p>
      </header>

      {/* The four numbers worth knowing about the format itself, before anybody's record.
          `neverFlipped` is the one that says something: a flip board where the board never turned is
          a match nobody reached a flip square in, and if that number climbs there are too few of
          them or they are in the wrong places. */}
      <div className="stats-totals">
        <Totals label="Matches" value={String(totals.matches)} />
        <Totals label="Squares claimed" value={totals.squares.toLocaleString()} />
        <Totals label="Board turns" value={String(totals.flips)} />
        <Totals
          label="Median length"
          value={totals.medianSeconds === null ? "--:--" : formatDuration(totals.medianSeconds)}
        />
        <Totals
          label="Never flipped"
          value={`${totals.neverFlipped}`}
          hint={`${totals.neverFlipped} of ${totals.matches} matches ended without the board turning once`}
        />
      </div>

      <section className="stack" style={{ gap: "0.5rem" }}>
        <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Players</h2>
        <div className="stats-scroll">
          <table className="stats-table">
            <thead>
              <tr>
                <th className="stats-rank" scope="col">#</th>
                <th scope="col">Player</th>
                {COLUMNS.map((c) => (
                  <th key={c.key} scope="col" className="stats-num">
                    {/* The column headings are the sort control. A separate row of buttons above a
                        table that already has headings is two ways to say one thing. */}
                    <button
                      className={`stats-sort${sort === c.key ? " stats-sort-on" : ""}`}
                      onClick={() => setSort(c.key)}
                      title={c.title}
                      aria-pressed={sort === c.key}
                    >
                      {c.label}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {career.map((row, i) => {
                const ranked = row.matches >= WIN_RATE_MINIMUM;
                return (
                  <tr key={row.key}>
                    <td className="stats-rank">{i + 1}</td>
                    <td className="stats-name">{row.name}</td>
                    <td className="stats-num">{row.wins}</td>
                    <td className="stats-num">{row.matches}</td>
                    <td className="stats-num">
                      {ranked ? (
                        `${Math.round(row.winRate * 100)}%`
                      ) : (
                        // Shown as unranked rather than hidden: vanishing from a leaderboard you
                        // are on is worse than placing last on it.
                        <span className="muted" title={`Needs ${WIN_RATE_MINIMUM} matches`}>
                          &ndash;
                        </span>
                      )}
                    </td>
                    <td className="stats-num">{row.squares}</td>
                    <td className="stats-num">{row.flips}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack" style={{ gap: "0.5rem" }}>
        <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Recent matches</h2>
        <div className="stats-matches">
          {matches.slice(0, 25).map((m) => (
            <MatchRow key={m.id} match={m} players={players.filter((p) => p.match_id === m.id)} />
          ))}
        </div>
      </section>
    </div>
  );
}

function Totals({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stats-total" title={hint}>
      <span className="stats-total-value">{value}</span>
      <span className="stats-total-label">{label}</span>
    </div>
  );
}

function MatchRow({ match, players }: { match: MatchResult; players: MatchPlayer[] }) {
  const set = squareSet(match.square_set, match.custom_square_set);
  const when = new Date(match.finished_at).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="stats-match">
      <div className="stats-match-head">
        <strong
          style={{ color: match.winner_team !== null ? teamHex(match.winner_team) : "var(--text-dim)" }}
        >
          {match.winner_team !== null ? teamName(match.winner_team) : "No winner"}
        </strong>
        <span className="muted">
          {formatRoomCode(match.room_code)} &middot; {match.board_size}&times;{match.board_size}{" "}
          &middot; {set.label}
        </span>
        <span className="stats-match-when muted">{when}</span>
      </div>

      <div className="stats-match-line muted">
        {match.duration_seconds !== null && <span>{formatDuration(match.duration_seconds)}</span>}
        <span>{match.total_claims} squares</span>
        {/* The headline number for this format. Zero is worth saying out loud rather than leaving as
            an absent chip - it means nobody got to a flip square all match. */}
        <span className={match.total_flips === 0 ? "stats-noflip" : "stats-flip"}>
          {match.total_flips === 0
            ? "never flipped"
            : `${match.total_flips} flip${match.total_flips === 1 ? "" : "s"}`}
        </span>
        <span>{match.lockout ? "lockout" : "non-lockout"}</span>
        {/* Named in the format's own terms. "by points" alone is unreadable next to another match
            played at a different bonus - a 13 and a 13 can mean very different boards. */}
        <span>
          {match.win_condition === "line"
            ? "bingos win"
            : match.bonus_per_bingo === 0
              ? `first to ${match.target_score ?? "?"}`
              : `first to ${match.target_score ?? "?"}, bingo +${match.bonus_per_bingo}`}
        </span>
      </div>

      {players.length > 0 && (
        <div className="stats-match-players">
          {[...players]
            .sort((a, b) => b.squares - a.squares)
            .map((p) => (
              <span key={p.id} className={p.won ? "stats-won" : undefined} style={{ color: teamHex(p.team) }}>
                {p.nickname}
                <span className="muted"> {p.squares}</span>
              </span>
            ))}
        </div>
      )}
    </div>
  );
}
