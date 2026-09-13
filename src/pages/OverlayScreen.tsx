import { useEffect, useMemo, useRef } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useRoom } from "../hooks/useRoom";
import { useCastScreens } from "../hooks/useCastScreens";
import { useScreenAux } from "../lib/castAux";
import { teamHex, teamName } from "../lib/teamColors";
import "./OverlayScreen.css";

/**
 * One player box in a casting scene: their muted Twitch stream, their name in the board font, and
 * a live count of squares they've personally claimed.
 *
 * -- One source per box, driven by `?slot=` --------------------------------------------------
 *
 * A casting scene lays down one of these per seat, all pointed at the same room code and told
 * apart only by `?slot=` - see lib/castScreens for what a slot indexes and why it's stable across
 * a match. Six separate sources rather than one grid page because a caster wants each box
 * independently refreshable when a stream hitches, which is what lib/castAux's resync is for.
 *
 * -- Why the tally is read straight from the public log -----------------------------------------
 *
 * `claims` carries `player_id` and is world-readable, so this needs no controller and no relay: it
 * watches the room like the desk does and counts the same rows the board itself is drawn from.
 *
 * -- The empty states -----------------------------------------------------------------------------
 *
 * A missing or out-of-range slot, and a token whose owner is between matches, both draw nothing at
 * all - the same rule every persistent source follows. A seat that IS filled by an account with no
 * linked Twitch draws the name plate and the tally over an empty frame: "player here, stream not
 * linked" is a real state and better said than hidden.
 */

interface TwitchQuality {
  group: string;
  height?: number;
}

interface TwitchPlaybackStats {
  /** Seconds the viewer is behind the broadcaster. Absent until playback is going. */
  hlsLatencyBroadcaster?: number;
}

interface TwitchPlayer {
  setQuality(group: string): void;
  getQualities(): TwitchQuality[];
  getPlaybackStats?(): TwitchPlaybackStats | null;
  addEventListener(event: string, listener: () => void): void;
  destroy?(): void;
}

interface TwitchNamespace {
  Player: {
    new (el: HTMLElement, options: Record<string, unknown>): TwitchPlayer;
    PLAYING: string;
    READY: string;
  };
}

const EMBED_SRC = "https://player.twitch.tv/js/embed/v1.js";

/** Load the Twitch embed API once for the whole document, however many boxes ask for it. */
let embedScript: Promise<void> | null = null;
function loadTwitchEmbed(): Promise<void> {
  if (embedScript) return embedScript;
  embedScript = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${EMBED_SRC}"]`);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = EMBED_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Twitch embed script failed to load"));
    document.head.appendChild(script);
  });
  return embedScript;
}

function twitch(): TwitchNamespace | null {
  return (window as unknown as { Twitch?: TwitchNamespace }).Twitch ?? null;
}

/**
 * Cap the player at a low-but-legible rung so several of these on one PC do not melt it.
 *
 * The highest rung at or below 480p, or failing that the lowest real rung. `auto` is left off the
 * table deliberately - it climbs to source on a good connection, which is exactly what a wall of
 * boxes cannot afford. Best-effort throughout: a throw here just leaves the stream on `auto`.
 */
function capQuality(player: TwitchPlayer): void {
  try {
    const rungs = player.getQualities().filter((q) => q.group && q.group !== "auto");
    if (rungs.length === 0) return;
    const withHeight = rungs.filter((q) => typeof q.height === "number");
    const sized = withHeight.length > 0 ? withHeight : rungs;
    const byHeight = [...sized].sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
    const capped = byHeight.filter((q) => (q.height ?? 9999) <= 480).pop() ?? byHeight[0];
    if (capped) player.setQuality(capped.group);
  } catch {
    /* quality control is a nice-to-have, not a reason to break the box */
  }
}

/** How often a box re-reads its own latency, for the desk's readout. Latency drifts slowly. */
const LATENCY_POLL_MS = 4000;

/** The muted Twitch embed, filling its box. Rebuilt on a channel change or a resync (via `key`). */
function TwitchStream({ channel, onLatency }: { channel: string; onLatency: (ms: number | null) => void }) {
  const holderRef = useRef<HTMLDivElement>(null);
  const onLatencyRef = useRef(onLatency);
  onLatencyRef.current = onLatency;

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    let disposed = false;
    let player: TwitchPlayer | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

    void loadTwitchEmbed()
      .then(() => {
        const T = twitch();
        if (disposed || !T) return;
        player = new T.Player(holder, {
          channel,
          // Whatever host this page is served from IS the correct embed parent - the deployed
          // Pages domain in a browser source, `localhost` in dev. Nothing to hardcode.
          parent: [window.location.hostname],
          muted: true,
          autoplay: true,
          controls: false,
          width: "100%",
          height: "100%",
        });
        const cap = () => player && capQuality(player);
        player.addEventListener(T.Player.PLAYING, cap);
        player.addEventListener(T.Player.READY, cap);

        poll = setInterval(() => {
          try {
            const stats = player?.getPlaybackStats?.();
            const secs = stats?.hlsLatencyBroadcaster;
            onLatencyRef.current(typeof secs === "number" && secs > 0 ? secs * 1000 : null);
          } catch {
            onLatencyRef.current(null);
          }
        }, LATENCY_POLL_MS);
      })
      .catch(() => {
        /* no embed script, no stream - the name plate still stands */
      });

    return () => {
      disposed = true;
      if (poll) clearInterval(poll);
      onLatencyRef.current(null);
      try {
        player?.destroy?.();
      } catch {
        /* */
      }
      holder.innerHTML = "";
    };
  }, [channel]);

  return <div className="ovs-stream" ref={holderRef} />;
}

export function OverlayScreen() {
  const { code } = useParams<{ code: string }>();
  const [params] = useSearchParams();
  const state = useRoom(code);

  const slotRaw = params.get("slot");
  const slot = slotRaw !== null && slotRaw !== "" ? Number(slotRaw) : NaN;
  const slotKey = Number.isInteger(slot) ? slot : -1;

  const screens = useCastScreens(state.players);
  const screen = Number.isInteger(slot) ? (screens.find((s) => s.slot === slot) ?? null) : null;

  /** This box's own latency to its broadcaster, in ms, published to the desk by useScreenAux. */
  const latencyRef = useRef<number | null>(null);
  const resyncNonce = useScreenAux(code, slotKey, () => latencyRef.current);

  const claimed = useMemo(() => {
    if (!screen) return 0;
    let n = 0;
    for (const c of state.claims) if (c.player_id === screen.playerId) n++;
    return n;
  }, [state.claims, screen]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("overlay-mode");
    document.body.classList.add("overlay-mode");
    return () => {
      root.classList.remove("overlay-mode");
      document.body.classList.remove("overlay-mode");
    };
  }, []);

  // Nothing to draw is the right picture on a stream: an unfilled slot, or a source that has
  // outlived the match it was pointed at. Never the last match's box.
  if (!screen) return null;

  const label = screen.name ?? teamName(screen.team);
  const accent = teamHex(screen.team);

  return (
    <div className="ovs" style={{ ["--ovs-accent" as string]: accent }}>
      {screen.twitchLogin ? (
        <TwitchStream
          key={`${screen.twitchLogin}:${resyncNonce}`}
          channel={screen.twitchLogin}
          onLatency={(ms) => {
            latencyRef.current = ms;
          }}
        />
      ) : (
        <div className="ovs-stream ovs-stream-empty" />
      )}

      <div className="ovs-plate">
        <span className="ovs-name">{label}</span>
        <span className="ovs-stats">
          <span className="ovs-stat">{claimed} claimed</span>
        </span>
      </div>
    </div>
  );
}
