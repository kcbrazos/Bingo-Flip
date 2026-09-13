import { useEffect, useState } from "react";
import { supabase, isSupabaseConfigured } from "./supabase";

export interface AdminRow {
  user_id: string;
  display_name: string | null;
  is_owner: boolean;
  granted_at: string;
}

export interface AdminStatus {
  isAdmin: boolean;
  isOwner: boolean;
  loading: boolean;
}

/**
 * Whether the signed-in account may manage the room books.
 *
 * Asks the database rather than inferring anything client-side. Nothing here is a security
 * boundary - RLS is - so a tampered response only ever reveals buttons whose actions the server
 * would still refuse. It exists to avoid showing controls that would fail.
 *
 * `enabled` skips the pair of round trips entirely, for callers that already know the answer is no.
 * The top bar uses it: admin rights hang off a Twitch account, so an anonymous visitor asking is
 * two guaranteed `false`s on every page of the site. Answers `false, done` rather than staying in
 * `loading` forever, so a caller can render its "not for you" state without special-casing this.
 */
export function useAdminStatus(enabled = true): AdminStatus {
  const [status, setStatus] = useState<AdminStatus>({ isAdmin: false, isOwner: false, loading: true });

  useEffect(() => {
    if (!isSupabaseConfigured || !enabled) {
      setStatus({ isAdmin: false, isOwner: false, loading: false });
      return;
    }
    let cancelled = false;

    async function check() {
      const [{ data: admin }, { data: owner }] = await Promise.all([
        supabase.rpc("is_admin"),
        supabase.rpc("is_owner"),
      ]);
      if (!cancelled) setStatus({ isAdmin: !!admin, isOwner: !!owner, loading: false });
    }

    void check();
    // Re-checked on sign-in/out: the answer is a property of the session, and without this the
    // panel would stay hidden until a reload after logging in.
    const { data: sub } = supabase.auth.onAuthStateChange(() => void check());
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [enabled]);

  return status;
}

export async function listAdmins(): Promise<AdminRow[]> {
  const { data, error } = await supabase
    .from("admins")
    .select("user_id, display_name, is_owner, granted_at")
    .order("is_owner", { ascending: false })
    .order("granted_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as AdminRow[];
}

/**
 * Grants admin by Twitch display name.
 *
 * Resolved through `profiles`, which means the person must have signed in with Twitch at least
 * once. That's a feature rather than a limitation: it proves the account exists and pins the grant
 * to a real user id instead of a name someone could later claim.
 */
export async function grantAdmin(displayName: string): Promise<{ ok: boolean; message: string }> {
  const name = displayName.trim();
  if (!name) return { ok: false, message: "Enter a Twitch display name." };

  const { data: matches, error: lookupErr } = await supabase
    .from("profiles")
    .select("id, display_name")
    .ilike("display_name", name)
    .limit(2);
  if (lookupErr) return { ok: false, message: lookupErr.message };

  if (!matches || matches.length === 0) {
    return { ok: false, message: `No Twitch account called "${name}" has signed in yet. Ask them to log in once first.` };
  }
  if (matches.length > 1) {
    return { ok: false, message: `More than one account matches "${name}".` };
  }

  const { error } = await supabase.from("admins").insert({
    user_id: matches[0].id,
    display_name: matches[0].display_name,
    is_owner: false,
    granted_by: (await supabase.auth.getUser()).data.user?.id ?? null,
  });
  if (error) {
    // 23505 is the primary-key clash, i.e. they already had it. Not worth an error.
    if (error.code === "23505") return { ok: false, message: `${matches[0].display_name} is already an admin.` };
    return { ok: false, message: error.message };
  }
  return { ok: true, message: `${matches[0].display_name} is now an admin.` };
}

export async function revokeAdmin(userId: string): Promise<void> {
  const { error } = await supabase.from("admins").delete().eq("user_id", userId);
  if (error) throw error;
}

export interface LiveRoom {
  id: string;
  code: string;
  status: string;
  created_at: string;
  players: number;
}

/** Live rooms with their occupancy, for the admin's room list. */
export async function listRooms(): Promise<LiveRoom[]> {
  const { data: rooms, error } = await supabase
    .from("rooms")
    .select("id, code, status, created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;

  const { data: players } = await supabase.from("players").select("room_id");
  const counts = new Map<string, number>();
  for (const p of players ?? []) counts.set(p.room_id, (counts.get(p.room_id) ?? 0) + 1);

  return (rooms ?? []).map((r) => ({ ...r, players: counts.get(r.id) ?? 0 }) as LiveRoom);
}

/** Deletes a room. Cascades to its players and team_ready rows. */
export async function deleteRoom(id: string): Promise<void> {
  const { error } = await supabase.from("rooms").delete().eq("id", id);
  if (error) throw error;
  const { data: left } = await supabase.from("rooms").select("id").eq("id", id);
  if ((left ?? []).length > 0) throw new Error("The room wasn't deleted - check you're still an admin.");
}

/** Runs the stale-room sweep on demand rather than waiting for the next room creation. */
export async function pruneRooms(): Promise<number> {
  const { data, error } = await supabase.rpc("admin_prune_rooms");
  if (error) throw error;
  return (data as number) ?? 0;
}

export async function renamePlayerAsAdmin(playerId: string, nickname: string): Promise<void> {
  const { error } = await supabase.from("players").update({ nickname }).eq("id", playerId);
  if (error) throw error;
}

export async function kickPlayerAsAdmin(playerId: string): Promise<void> {
  const { error } = await supabase.from("players").delete().eq("id", playerId);
  if (error) throw error;
}