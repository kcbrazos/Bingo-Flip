import type { PanelLayout } from "./panelLayout";

/**
 * The match screen's four panels. The box maths they share with the spectator canvas lives in
 * ./panelLayout; this file is only what is specific to a player's own match view.
 *
 * Four, where Battleship had five. Its "Your fleet" panel showed the grid only you could see - your
 * ships, and the shots landing on them. There is no such grid here: every team reads the same board,
 * and there is nothing on it another player is not allowed to see. Dropping it gives the width back
 * to the board, which is the one thing anybody is actually reading.
 */
export type PanelId = "board" | "roster" | "log" | "clock";

export type MatchLayout = PanelLayout<PanelId>;

export const PANEL_TITLES: Record<PanelId, string> = {
  board: "Board",
  roster: "Teams",
  log: "Match log",
  clock: "Clock",
};

/** Every panel, in the order they're listed anywhere they need listing. */
export const PANEL_IDS: PanelId[] = ["board", "clock", "log", "roster"];

/**
 * The starting arrangement.
 *
 * Four panels, and only four: the regions key, the room codes, the overlay link and the host's
 * buttons all live in the bar below the canvas (see MatchDock), because a column of cards you look
 * at twice a match was spending roughly a roster's worth of width on nothing.
 *
 * That width goes to the board, now at 68%. It was 62% when it shared the middle column with the
 * fleet panel, and 52% before the controls column moved into the dock. The board carries both faces'
 * worth of objective text in the same squares, so it wants every pixel the screen can spare - a
 * square that has to hold "Death Rite Bird: Charos + Consecrated" is the constraint here.
 */
export const DEFAULT_LAYOUT: MatchLayout = {
  board: { x: 0.0, y: 0.0, w: 0.68, h: 1.0, z: 1 },
  clock: { x: 0.69, y: 0.0, w: 0.15, h: 0.16, z: 2 },
  log: { x: 0.69, y: 0.17, w: 0.15, h: 0.83, z: 3 },
  roster: { x: 0.85, y: 0.0, w: 0.15, h: 1.0, z: 4 },
};

export type { PanelBox } from "./panelLayout";
