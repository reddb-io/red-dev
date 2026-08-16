/**
 * Panels — a red-dev terminal surface over one host subsystem: network
 * and DNS first, then audio, power and bluetooth.
 *
 * Worth knowing before reading the entries: a Panel that needs rights
 * asks inline, at the moment the operator changes something, so the
 * action that *opens* a Panel is never privileged — `privileged` on
 * these entries describes opening, not everything the Panel can go on to
 * do. `mutates` is false for the same reason. A test in
 * src/panel-network.test.ts holds both against every `panel.` entry, so
 * the rule survives the next Panel being added by somebody who has not
 * read this paragraph.
 */

import type { SemanticAction } from "./types.ts";

/**
 * Everywhere with a display, WSL included — the same set the terminal
 * actions claim, and for the same reason: this list is about a chord,
 * and a chord needs somewhere to be pressed. `server` is absent from it
 * and not from the product; `red-dev panel network` is a command, and it
 * answers on a headless machine over SSH exactly as it does here.
 */
const WITH_A_DISPLAY = ["desktop", "wsl", "windows"] as const;

export const PANEL_ACTIONS: readonly SemanticAction[] = [
  {
    id: "panel.network",
    label: "Network panel",
    platforms: WITH_A_DISPLAY,
    // Opening it reads the machine and changes nothing. Switching DNS
    // from inside it does both, and asks for itself when it does.
    mutates: false,
    privileged: false,
    // N for network. Free on both hosts: GNOME's Ctrl+Alt family spends
    // the arrows on workspaces and takes L, Tab, Esc and Delete;
    // Windows takes Delete, Tab and the arrows. Omarchy binds its
    // network panel to Super+Ctrl+W, which ADR 0006 leaves to the host.
    chord: "Ctrl+Alt+N",
  },
  {
    id: "panel.audio",
    label: "Audio panel",
    platforms: WITH_A_DISPLAY,
    // Opening it lists what the machine plays and hears. Switching from
    // inside it needs nothing on Ubuntu — the sound server belongs to
    // the session — and on Windows it opens the host's own Sound page,
    // because nothing Microsoft ships can set the default device.
    mutates: false,
    privileged: false,
    // A for audio, and free in the family on both hosts.
    chord: "Ctrl+Alt+A",
  },
  {
    id: "panel.power",
    label: "Power panel",
    platforms: WITH_A_DISPLAY,
    mutates: false,
    privileged: false,
    // P for power. Neither host claims it, and the one thing that might
    // — GNOME's print-screen family — lives on Print, not on P.
    chord: "Ctrl+Alt+P",
  },
];
