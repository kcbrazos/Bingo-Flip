import { useEffect, useState } from "react";
import {
  useAdminStatus,
  listAdmins,
  grantAdmin,
  revokeAdmin,
  listRooms,
  deleteRoom,
  pruneRooms,
  type AdminRow,
  type LiveRoom,
} from "../lib/admin";
import { formatRoomCode } from "../lib/roomCode";
import { serverNow } from "../lib/serverTime";

/**
 * Room management, visible only to admins.
 *
 * Renders nothing at all for everyone else - including while the check is still in flight, so the
 * panel never flashes into view for an ordinary visitor. The real enforcement is RLS; this only
 * decides whether to offer controls that would otherwise fail.
 */
export function AdminPanel() {
  const { isAdmin, isOwner, loading } = useAdminStatus();
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [rooms, setRooms] = useState<LiveRoom[]>([]);
  const [grantName, setGrantName] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    listAdmins().then(setAdmins).catch(() => setAdmins([]));
    listRooms().then(setRooms).catch(() => setRooms([]));
  }, [isAdmin]);

  if (loading || !isAdmin) return null;

  async function refreshAdmins() {
    setAdmins(await listAdmins().catch(() => []));
  }

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    try {
      setNote(await fn());
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel stack" style={{ gap: "0.7rem", borderColor: "var(--danger)", width: "100%" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h3 style={{ margin: 0, color: "var(--danger)" }}>Admin</h3>
        <span className="muted" style={{ fontSize: "0.72rem" }}>
          {isOwner ? "Owner" : "Administrator"}
        </span>
      </div>

      {note && <div className="muted" style={{ fontSize: "0.78rem" }}>{note}</div>}

      {/* -- Live rooms -- */}
      <div className="stack" style={{ gap: "0.35rem" }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <strong style={{ fontSize: "0.82rem" }}>Live rooms ({rooms.length}/15)</strong>
          <button
            disabled={busy}
            style={{ fontSize: "0.7rem", padding: "0.2rem 0.5rem" }}
            onClick={() => void run(async () => {
              const n = await pruneRooms();
              setRooms(await listRooms().catch(() => []));
              return `Pruned ${n} stale room${n === 1 ? "" : "s"}.`;
            })}
          >
            Prune stale
          </button>
        </div>
        {rooms.length === 0 && <span className="muted" style={{ fontSize: "0.78rem" }}>No rooms open.</span>}
        {rooms.map((r) => (
          <div key={r.id} className="row" style={{ justifyContent: "space-between", gap: "0.5rem", fontSize: "0.78rem" }}>
            <span style={{ minWidth: 0, flex: 1 }}>
              <strong>{formatRoomCode(r.code)}</strong>
              <span className="muted">
                {" "}
                · {r.status} · {r.players} player{r.players === 1 ? "" : "s"} ·{" "}
                {/* serverNow, not Date.now: created_at is a Postgres timestamp, so a skewed PC
                    clock would otherwise report rooms as older or younger than they are. */}
                {Math.round((serverNow() - new Date(r.created_at).getTime()) / 60000)}m old
              </span>
            </span>
            <button
              className="danger"
              disabled={busy}
              style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", flex: "none" }}
              onClick={() => void run(async () => {
                await deleteRoom(r.id);
                setRooms(await listRooms().catch(() => []));
                return `Deleted room ${formatRoomCode(r.code)}.`;
              })}
            >
              Delete
            </button>
          </div>
        ))}
        <span className="muted" style={{ fontSize: "0.7rem" }}>
          Deleting a room removes its players and claim log with it. Use it on a stuck room that's
          holding one of the 15 slots.
        </span>
      </div>

      {/* -- Admins -- */}
      <div className="stack" style={{ gap: "0.35rem", borderTop: "1px solid var(--panel-border)", paddingTop: "0.6rem" }}>
        <strong style={{ fontSize: "0.82rem" }}>Administrators</strong>
        {admins.map((a) => (
          <div key={a.user_id} className="row" style={{ justifyContent: "space-between", gap: "0.5rem", fontSize: "0.78rem" }}>
            <span>
              {a.display_name ?? a.user_id.slice(0, 8)}
              {a.is_owner && <span className="badge">owner</span>}
            </span>
            {/* Owners can only be removed by another owner - the rule RLS enforces, mirrored here
                so the button isn't offered when the server would reject it. */}
            {(!a.is_owner || isOwner) && (
              <button
                disabled={busy}
                style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", flex: "none" }}
                onClick={() =>
                  void run(async () => {
                    await revokeAdmin(a.user_id);
                    await refreshAdmins();
                    return `Removed ${a.display_name ?? "that account"}.`;
                  })
                }
              >
                Revoke
              </button>
            )}
          </div>
        ))}

        <form
          className="row"
          style={{ gap: "0.4rem" }}
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const res = await grantAdmin(grantName);
              if (res.ok) {
                setGrantName("");
                await refreshAdmins();
              }
              return res.message;
            });
          }}
        >
          <input
            value={grantName}
            onChange={(e) => setGrantName(e.target.value)}
            placeholder="Twitch display name"
            style={{ flex: 1, minWidth: 0, fontSize: "0.78rem" }}
          />
          <button type="submit" disabled={busy} style={{ fontSize: "0.75rem", flex: "none" }}>
            Make admin
          </button>
        </form>
        <span className="muted" style={{ fontSize: "0.7rem" }}>
          They must have signed in with Twitch here at least once, so the grant can be pinned to
          their account rather than to a name.
        </span>
      </div>
    </div>
  );
}