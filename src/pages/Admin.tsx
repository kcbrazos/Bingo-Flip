import { Link } from "react-router-dom";
import { LoadingScreen } from "../components/BrandMark";
import { AdminPanel } from "../components/AdminPanel";
import { useAdminStatus } from "../lib/admin";

/**
 * The admin's own page.
 *
 * These controls used to hang off the bottom of the Leaderboard, which put record deletion, room
 * pruning and the grant list underneath a table nobody scrolls to the end of - and made the
 * leaderboard two pages wearing one URL depending on who was looking at it. They have a door in
 * the top bar now, and the room book is just a room book again.
 */
export function Admin() {
  const { isAdmin, loading } = useAdminStatus();

  // The status check is a round trip, so without this the page would show "nothing here" for a
  // moment to an admin who is in fact an admin.
  if (loading) return <LoadingScreen>Checking...</LoadingScreen>;

  /**
   * Anyone can type this URL, so it needs an answer for people who aren't admins. Deliberately not
   * a redirect: bouncing them somewhere else implies the page doesn't exist, and the honest answer
   * is that it does and isn't theirs. Nothing is protected by this - RLS is - it only avoids
   * offering controls the server would refuse.
   */
  if (!isAdmin) {
    return (
      <div className="panel stack" style={{ alignItems: "center", textAlign: "center" }}>
        <p className="muted" style={{ margin: 0 }}>
          Nothing here for you - these controls are for administrators.
        </p>
        <Link to="/">Back to the round table</Link>
      </div>
    );
  }

  return (
    <div className="stack" style={{ width: "min(860px, 100%)" }}>
      <div style={{ textAlign: "center" }}>
        <h1>Admin</h1>
        <p className="muted">Live rooms and administrators.</p>
      </div>
      <AdminPanel />
    </div>
  );
}