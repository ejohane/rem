export interface EditorPluginContext {
  plainText: string;
  tags: string[];
  noteId: string | null;
}

export interface EditorPluginDefinition {
  id: string;
  title: string;
  render: (context: EditorPluginContext) => string;
}

function countWords(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }

  return normalized.split(/\s+/).length;
}

export const defaultEditorPlugins: EditorPluginDefinition[] = [
  {
    id: "word-count",
    title: "Word Count",
    render: (context) => `${countWords(context.plainText)} words`,
  },
  {
    id: "tag-snapshot",
    title: "Tag Snapshot",
    render: (context) => (context.tags.length > 0 ? context.tags.join(", ") : "(none)"),
  },
  {
    id: "target-handle",
    title: "Target Handle",
    render: (context) => context.noteId ?? "new note",
  },
];
