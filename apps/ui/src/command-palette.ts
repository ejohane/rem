export function matchesCommandQuery(query: string, aliases: readonly string[]): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return true;
  }

  return aliases.some((alias) => alias.toLowerCase().includes(normalizedQuery));
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
