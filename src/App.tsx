import { Suspense, lazy, useEffect } from "react";
import { HashRouter, Routes, Route, useLocation } from "react-router-dom";
import { Home } from "./pages/Home";
import { TopBar } from "./components/TopBar";
import { BuildStamp } from "./components/BuildStamp";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LoadingScreen } from "./components/BrandMark";
import { primeAudio } from "./lib/sfx";

/**
 * Fetched on demand rather than baked into the bundle everything else loads.
 *
 * The home page is the one route almost every visitor lands on, and it is the one page that needs
 * none of the match machinery - no claim log, no board, no realtime channel. Loading the game with
 * it meant every first-time player downloaded and parsed the whole match UI before they had ever
 * seen whether the site was any good, and every OBS browser source on the streamer's PC did the
 * same on startup even when it only ever displays one of them.
 *
 * The game routes stay eagerly imported by intent: each is a page somebody is in the middle of a
 * match on, and none of them can afford to wait on a network round trip it didn't used to wait on.
 * Splitting them out does not lose that - a player navigating into a room has already committed to
 * the download, and the Suspense boundary renders the same loading mark the room itself shows
 * while it fetches.
 *
 * Admin and Stats are the opposite: read between matches, by almost nobody, and never by a player
 * claiming a square. The records page is here too, for the same reason.
 */
const Room = lazy(() => import("./pages/Room").then((m) => ({ default: m.Room })));
const Overlay = lazy(() => import("./pages/Overlay").then((m) => ({ default: m.Overlay })));
const OverlayBoard = lazy(() => import("./pages/OverlayBoard").then((m) => ({ default: m.OverlayBoard })));
const OverlayTimer = lazy(() => import("./pages/OverlayTimer").then((m) => ({ default: m.OverlayTimer })));
const OverlayKey = lazy(() => import("./pages/OverlayKey").then((m) => ({ default: m.OverlayKey })));
const OverlayAudio = lazy(() => import("./pages/OverlayAudio").then((m) => ({ default: m.OverlayAudio })));
const OverlayOdds = lazy(() => import("./pages/OverlayOdds").then((m) => ({ default: m.OverlayOdds })));
const OverlayScreen = lazy(() => import("./pages/OverlayScreen").then((m) => ({ default: m.OverlayScreen })));
const CasterControl = lazy(() => import("./pages/CasterControl").then((m) => ({ default: m.CasterControl })));
const Admin = lazy(() => import("./pages/Admin").then((m) => ({ default: m.Admin })));
const Stats = lazy(() => import("./pages/Stats").then((m) => ({ default: m.Stats })));

/**
 * Every route that is composited into OBS must show nothing but the match state, so they opt out
 * of the app-wide chrome entirely rather than hiding it with CSS.
 *
 * The caster's CONTROL page is deliberately not in this list - it is an ordinary page on a second
 * monitor, and wants the top bar like anything else.
 */
const OVERLAY_ROUTES = [
  "/overlay/",
  "/overlay-board/",
  "/overlay-timer/",
  "/overlay-key/",
  "/overlay-audio/",
  "/overlay-odds/",
  "/overlay-screen/",
];

/**
 * Unlocks match audio on the first click or key press anywhere in the app, rather than waiting for
 * one to land inside whichever handler happens to call playSfx() first.
 *
 * Every sound Room.tsx plays (useMatchSfx) fires from an effect reacting to a realtime row or a
 * countdown tick, never from inside a click handler directly - even "mark", for the player whose own
 * claim caused it, only lands once the round trip to Supabase resolves. Chrome autoplay tolerates
 * that fine once a page has seen any gesture at all, but Safari's policy is narrower: it wants the
 * gesture and the play() in the same call stack, and a click that only unlocked audio a tick later is
 * as good as no click at all. primeAudio()'s probe play, run synchronously inside this listener,
 * IS that gesture - Safari counts it and stays unlocked for every later, ungestured play() this page
 * makes, which is the same trick pages/OverlayAudio already uses for a source with no click of its
 * own to spend.
 *
 * Fires once and tears itself down; a page nobody has clicked has made no sound yet to be missing.
 */
function useUnlockAudioOnFirstGesture(): void {
  useEffect(() => {
    const unlock = () => {
      void primeAudio();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);
}

function Chrome() {
  const { pathname } = useLocation();
  useUnlockAudioOnFirstGesture();
  if (OVERLAY_ROUTES.some((prefix) => pathname.startsWith(prefix))) return null;
  return (
    <>
      <TopBar />
      <BuildStamp />
    </>
  );
}

function App() {
  return (
    <HashRouter>
      <Chrome />
      {/* Inside the router so the fallback can be styled like the rest of the app, but outside the
          routes so a throw anywhere in a page still lands on it rather than on a blank document. */}
      <ErrorBoundary>
        {/* The same loading mark the room and the stats pages already show while they fetch, so a
            lazy route arriving looks like the app loading rather than like a blank frame. */}
        <Suspense fallback={<LoadingScreen>Loading...</LoadingScreen>}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/room/:code" element={<Room />} />
          <Route path="/overlay/:code" element={<Overlay />} />
          {/* The caster's three browser sources, plus the page that drives the first of them.
              Only the board needs driving; the timer and the key follow the room on their own. */}
          <Route path="/overlay-board/:code" element={<OverlayBoard />} />
          <Route path="/overlay-timer/:code" element={<OverlayTimer />} />
          <Route path="/overlay-key/:code" element={<OverlayKey />} />
          <Route path="/overlay-audio/:code" element={<OverlayAudio />} />
          <Route path="/overlay-odds/:code" element={<OverlayOdds />} />
          <Route path="/overlay-screen/:code" element={<OverlayScreen />} />
          <Route path="/cast/:code" element={<CasterControl />} />
          <Route path="/stats" element={<Stats />} />
          {/* Guarded inside the page, not here - the route has to exist for everyone so that an
              admin following a link into a fresh tab lands on it before the session is checked. */}
          <Route path="/admin" element={<Admin />} />
        </Routes>
        </Suspense>
      </ErrorBoundary>
    </HashRouter>
  );
}

export default App;
