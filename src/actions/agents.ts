/**
 * Reaching the agents — the default one, and the multiplexer that runs
 * several.
 *
 * Born empty; the agents slice fills it. An action here has to survive
 * being absent: the multiplexer is not installed on every machine, and
 * an adapter reports such an action unbound rather than dropping it, so
 * the keys viewer can say "not installed here" instead of going quiet.
 *
 * Neither entry names a host. `agent.launch` starts whichever host was
 * recorded as the Default agent, resolved at the moment it fires by
 * src/agent-launch.ts, because a chord that reached for `claude`
 * because it is usually there would be right on most machines and
 * wrong, silently, on exactly the machines where somebody bothered to
 * choose. `agent.multiplex` names herdr, which is not an agent but the
 * thing agents run inside.
 */

import type { SemanticAction } from "./types.ts";

/**
 * Everywhere with a display, WSL included — the same set the terminal
 * actions, the Panels and the terminal surfaces claim.
 *
 * `server` is absent from the list and not from the product: `red-dev
 * agents run` is a command and it hands the terminal over an SSH
 * connection exactly as it does here. What is missing on a server is
 * somewhere to press a key, which is all this list is about.
 */
const WITH_A_DISPLAY = ["desktop", "wsl", "windows"] as const;

export const AGENT_ACTIONS: readonly SemanticAction[] = [
  {
    id: "agent.launch",
    label: "Default agent",
    platforms: WITH_A_DISPLAY,
    // Starting a host opens a session; what the person then asks it to
    // do is theirs, and the host asks for each of those itself. That
    // last clause is the whole of ADR 0001's amendment of 2026-08-15:
    // red-dev never starts a host in bypass mode, so `mutates` here
    // would be describing a permission red-dev deliberately does not
    // hand over.
    mutates: false,
    privileged: false,
    // G for agent — A is the audio Panel and the letter this act is
    // named after is therefore already spent. Free in the family on
    // both hosts: GNOME's Ctrl+Alt takes the arrows, L, Tab, Esc,
    // Delete and the virtual terminals, Windows takes Delete, Tab and
    // the display drivers' arrows, and neither claims G.
    chord: "Ctrl+Alt+Shift+G",
  },
  {
    id: "agent.multiplex",
    label: "Agent multiplexer",
    platforms: ["desktop", "wsl"],
    mutates: false,
    privileged: false,
    // H for herdr, and free in the family on both hosts. `windows` is
    // absent from the platforms above for the reason the manifest gives
    // for skipping its RedSkills plugin there: herdr has no stable
    // Windows build. It runs inside WSL on that machine, and the `wsl`
    // entry is what says so — the action is not deleted from the list
    // on a Windows host, it is reported as not applying there, which is
    // ADR 0006's rule for exactly this case.
    chord: "Ctrl+Alt+Shift+H",
  },
];
