type ShortcutEvent = {
  metaKey: boolean;
  ctrlKey: boolean;
  key: string;
};

function hasMetaOrCtrl(event: ShortcutEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

export function isSidebarToggleShortcut(event: ShortcutEvent): boolean {
  return hasMetaOrCtrl(event) && event.key === "\\";
}

export function isCommandPaletteShortcut(event: ShortcutEvent): boolean {
  return hasMetaOrCtrl(event) && event.key.toLowerCase() === "k";
}
