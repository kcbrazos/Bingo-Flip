import { Suspense, lazy } from "react";
import { HashRouter, Routes, Route, useLocation } from "react-router-dom";
import { Home } from "./pages/Home";
import { TopBar } from "./components/TopBar";
import { BuildStamp } from "./components/BuildStamp";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LoadingScreen } from "./components/BrandMark";

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
const OVERLAY_ROUTES = ["/overlay/", "/overlay-board/", "/overlay-timer/", "/overlay-key/"];

function Chrome() {
  const { pathname } = useLocation();
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
