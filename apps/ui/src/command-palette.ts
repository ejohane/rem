export function matchesCommandQuery(query: string, aliases: readonly string[]): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return true;
  }

  return aliases.some((alias) => alias.toLowerCase().includes(normalizedQuery));
}

const COMMAND_DEFINITIONS = [
  {
    id: "today",
    label: "Today",
    aliases: ["today", "open today's daily note"],
    shortcut: "↵",
  },
  {
    id: "add-note",
    label: "Add Note",
    aliases: ["add note", "create a new note", "new note"],
    shortcut: "↵",
  },
] as const;

export type CommandPaletteCommandId = (typeof COMMAND_DEFINITIONS)[number]["id"];

export type CommandPaletteNoteResult = {
  id: string;
  title: string;
  updatedAt: string;
  snippet: string;
};

export type CommandPaletteMatch =
  | {
      kind: "command";
      id: CommandPaletteCommandId;
      label: string;
      shortcut: string;
    }
  | {
      kind: "note";
      id: `note:${string}`;
      noteId: string;
      title: string;
      updatedAt: string;
      snippet: string;
    };

export type CommandPaletteSection = {
  id: "suggested" | "notes";
  label: string;
  items: CommandPaletteMatch[];
};

export function formatCommandPaletteNoteSnippet(snippet: string): string {
  const normalized = snippet.replaceAll("[", "").replaceAll("]", "").replace(/\s+/g, " ").trim();
  return normalized || "Open note";
}

export function buildCommandPaletteSections(
  query: string,
  noteResults: readonly CommandPaletteNoteResult[],
): CommandPaletteSection[] {
  const sections: CommandPaletteSection[] = [];
  const matchingCommands = COMMAND_DEFINITIONS.filter((command) =>
    matchesCommandQuery(query, command.aliases),
  ).map((command) => ({
    kind: "command" as const,
    id: command.id,
    label: command.label,
    shortcut: command.shortcut,
  }));

  if (matchingCommands.length > 0) {
    sections.push({
      id: "suggested",
      label: "Suggested",
      items: matchingCommands,
    });
  }

  if (query.trim().length > 0 && noteResults.length > 0) {
    sections.push({
      id: "notes",
      label: "Notes",
      items: noteResults.map((note) => ({
        kind: "note" as const,
        id: `note:${note.id}`,
        noteId: note.id,
        title: note.title,
        updatedAt: note.updatedAt,
        snippet: formatCommandPaletteNoteSnippet(note.snippet),
      })),
    });
  }

  return sections;
}

export function flattenCommandPaletteSections(
  sections: readonly CommandPaletteSection[],
): CommandPaletteMatch[] {
  return sections.flatMap((section) => section.items);
}

type CommandPaletteNavigationEvent = {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

export function isNextCommandShortcut(event: CommandPaletteNavigationEvent): boolean {
  if (
    event.key === "ArrowDown" &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey
  ) {
    return true;
  }

  return (
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "n"
  );
}

export function isPreviousCommandShortcut(event: CommandPaletteNavigationEvent): boolean {
  if (
    event.key === "ArrowUp" &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey
  ) {
    return true;
  }

  return (
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "p"
  );
}

export function getNextCommandIndex(currentIndex: number, commandCount: number): number {
  if (commandCount <= 0) {
    return 0;
  }

  return (currentIndex + 1) % commandCount;
}

export function getPreviousCommandIndex(currentIndex: number, commandCount: number): number {
  if (commandCount <= 0) {
    return 0;
  }

  return (currentIndex - 1 + commandCount) % commandCount;
}
