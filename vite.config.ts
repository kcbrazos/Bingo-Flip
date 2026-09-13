import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * A human-comparable build identifier, baked in at compile time.
 *
 * GitHub Pages caches index.html hard, so after an upload some players keep running the previous
 * bundle until they hard-refresh - and a stale client desyncing mid-match is very difficult to
 * diagnose over voice chat. Printing this in the corner turns that into "read me your build
 * number". The timestamp is the primary signal because it changes on every build; the commit is
 * a bonus and is omitted rather than guessed if git isn't available (e.g. a CI zip export).
 */
function buildId(): string {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
    return `${stamp} · ${sha}`
  } catch {
    return stamp
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  // Relative, so the build does not care what the repository is called.
  //
  // GitHub Pages serves a project site from /<repo>/, and Elden Battleship hard-coded that prefix -
  // which meant renaming the repo, or guessing its name wrong, deployed a page that loaded and then
  // 404'd every script, sprite and sound. That presents as a silent blank screen rather than as an
  // error, and it is a miserable thing to debug from a bug report.
  //
  // './' emits asset URLs relative to index.html instead, so the same dist/ works at a project-site
  // subpath, at a user-site root, and opened off the filesystem. Safe here specifically because
  // HashRouter keeps all routing after the '#' - there are no server-side paths to resolve, which is
  // also why dropping dist/ into a repo through the web UI just works.
  base: './',
})
