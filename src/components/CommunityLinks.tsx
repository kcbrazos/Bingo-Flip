/**
 * Off-site community links, pinned to the bottom of the menu screens.
 *
 * Shared rather than inlined because these appear on both the main menu and the lobby.
 *
 * Deliberately NOT rendered during placement or battle: a full-width link that navigates away
 * from a live match is a hazard, and nobody mid-game is shopping for a Discord invite or the
 * randomizer download.
 */
export function CommunityLinks() {
  return (
    <div className="stack" style={{ gap: "0.4rem" }}>
      <ExternalLink
        href="https://discord.gg/ignitesouls"
        // Discord "blurple" - the brand color, so it reads as a Discord link at a glance
        // rather than as another in-app button.
        background="#5865F2"
      >
        Join Ignite on Discord!
      </ExternalLink>
      <ExternalLink
        href="https://github.com/ignitesouls/AthenaRandomizer"
        // GitHub's own dark grey, for the same reason the Discord link borrows blurple - it
        // reads as "this goes to GitHub" before anyone parses the words.
        background="#24292e"
      >
        Bingo Flip uses Athena Randomizer - download it here
      </ExternalLink>
    </div>
  );
}

function ExternalLink({
  href,
  background,
  children,
}: {
  href: string;
  background: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      // Opens in a new tab: these navigate away from the app entirely, and losing a typed
      // nickname - or dropping out of a room you're sitting in - to a stray click would be a
      // needless annoyance. noreferrer alongside noopener since it's a third-party destination.
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "block",
        textAlign: "center",
        background,
        border: `1px solid ${background}`,
        borderRadius: "8px",
        color: "#fff",
        textDecoration: "none",
        padding: "0.5rem 0.7rem",
        fontSize: "0.85rem",
        fontWeight: 600,
      }}
    >
      {children}
    </a>
  );
}
