// ---------------------------------------------------------------------------
// ChatEngine — parses user input and dispatches actions
//
// Supports:
//   /open <panel>     — open a floating panel
//   /close <panel>    — close a specific panel
//   /close all        — close all panels
//   /help             — show available commands
//   /list             — list all available panels
//   /minimize <panel> — minimize a panel
//   <natural text>    — keyword match to open a panel
// ---------------------------------------------------------------------------

import { usePanelStore } from "../spatial/PanelStore.js";
import { useSpatialChatStore } from "./ChatStore.js";
import { panelRegistry, findPanelByKeyword, panelIds } from "../spatial/PanelRegistry.js";

export interface ChatResult {
  response: string;
  panelId?: string;
}

function openPanelByName(name: string): ChatResult {
  const entry = findPanelByKeyword(name);
  if (!entry) {
    return { response: `No panel found matching "${name}". Type /list to see all panels.` };
  }

  usePanelStore.getState().openPanel(entry.id, entry.title, entry.component);
  return { response: `Opened ${entry.title}`, panelId: entry.id };
}

function closePanelByName(name: string): ChatResult {
  if (name.toLowerCase().trim() === "all") {
    usePanelStore.getState().closeAll();
    return { response: "Closed all panels." };
  }

  const entry = findPanelByKeyword(name);
  if (!entry) {
    return { response: `No panel found matching "${name}".` };
  }

  const panels = usePanelStore.getState().panels;
  if (!panels.has(entry.id)) {
    return { response: `${entry.title} is not currently open.` };
  }

  usePanelStore.getState().closePanel(entry.id);
  return { response: `Closed ${entry.title}`, panelId: entry.id };
}

function showHelp(): ChatResult {
  const helpText = [
    "**Available commands:**",
    "",
    "  /open <panel>     Open a floating panel",
    "  /close <panel>    Close a panel",
    "  /close all        Close all panels",
    "  /minimize <panel> Minimize a panel",
    "  /list             List all available panels",
    "  /clear            Clear chat history",
    "  /help             Show this help",
    "",
    "Or just type a panel name (e.g., 'jobs', 'revenue', 'sensors').",
  ].join("\n");

  return { response: helpText };
}

function listPanels(): ChatResult {
  const ids = panelIds();
  const lines = ids.map((id) => {
    const entry = panelRegistry[id];
    return `  ${id} — ${entry.title}`;
  });
  return { response: `**Available panels (${ids.length}):**\n\n${lines.join("\n")}` };
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export function processInput(input: string): ChatResult {
  const trimmed = input.trim();
  if (!trimmed) return { response: "" };

  // Slash commands
  if (trimmed.startsWith("/")) {
    const parts = trimmed.slice(1).split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const arg = parts.slice(1).join(" ");

    switch (cmd) {
      case "open":
        if (!arg) return { response: "Usage: /open <panel name>" };
        return openPanelByName(arg);

      case "close":
        if (!arg) return { response: "Usage: /close <panel name> or /close all" };
        return closePanelByName(arg);

      case "minimize": {
        if (!arg) return { response: "Usage: /minimize <panel name>" };
        const entry = findPanelByKeyword(arg);
        if (!entry) return { response: `No panel found matching "${arg}".` };
        usePanelStore.getState().minimizePanel(entry.id);
        return { response: `Minimized ${entry.title}`, panelId: entry.id };
      }

      case "help":
        return showHelp();

      case "list":
        return listPanels();

      case "clear":
        useSpatialChatStore.getState().clearMessages();
        return { response: "Chat cleared." };

      default:
        return { response: `Unknown command: /${cmd}. Type /help for available commands.` };
    }
  }

  // Natural language: try to match a panel
  const match = findPanelByKeyword(trimmed);
  if (match) {
    usePanelStore.getState().openPanel(match.id, match.title, match.component);
    return { response: `Opened ${match.title}`, panelId: match.id };
  }

  // Common phrases
  const lower = trimmed.toLowerCase();
  if (lower.includes("show me") || lower.includes("open")) {
    const rest = lower.replace(/show me|open/g, "").trim();
    if (rest) {
      const match2 = findPanelByKeyword(rest);
      if (match2) {
        usePanelStore.getState().openPanel(match2.id, match2.title, match2.component);
        return { response: `Opened ${match2.title}`, panelId: match2.id };
      }
    }
  }

  return {
    response: `I didn't find a panel matching "${trimmed}". Type /list to see all available panels, or /help for commands.`,
  };
}
