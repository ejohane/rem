import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import {
  $createListNode,
  $isListItemNode,
  $isListNode,
  ListItemNode,
  ListNode,
} from "@lexical/list";
import { TRANSFORMERS } from "@lexical/markdown";
import { AutoFocusPlugin } from "@lexical/react/LexicalAutoFocusPlugin";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  KEY_TAB_COMMAND,
  type LexicalNode,
} from "lexical";
import { CalendarDays, FileText, Menu, Plus, RefreshCw, Search, Settings } from "lucide-react";

import { WikiLinksPlugin } from "./WikiLinkPlugin";
import {
  type CommandPaletteMatch,
  type CommandPaletteNoteResult,
  buildCommandPaletteSections,
  flattenCommandPaletteSections,
  getNextCommandIndex,
  getPreviousCommandIndex,
  isNextCommandShortcut,
  isPreviousCommandShortcut,
} from "./command-palette";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { buildDailyTitleDateAliases } from "./daily-note-search";
import { buildDailyNoteRequestPayload, resolveClientTimeZone } from "./daily-notes";
import { isCommandPaletteShortcut, isSidebarToggleShortcut } from "./keyboard-shortcuts";
import {
  type LexicalStateLike,
  lexicalStateToPlainText,
  parseTags,
  plainTextToLexicalState,
} from "./lexical";
import type { CanonicalNoteRecord } from "./proposals";

const API_BASE_URL = import.meta.env.VITE_REM_API_BASE_URL ?? "http://127.0.0.1:8787";
const AUTOSAVE_DELAY_MS = 1200;
const COMMAND_NOTE_SEARCH_LIMIT = 8;
const COMMAND_NOTE_SEARCH_DEBOUNCE_MS = 180;
const EDITOR_THEME = {
  text: {
    strikethrough: "lexical-text-strikethrough",
    underline: "lexical-text-underline",
    underlineStrikethrough: "lexical-text-underline-strikethrough",
  },
};

type SaveState =
  | { kind: "idle"; message: string }
  | { kind: "saving"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

type SaveIndicator = {
  tone: "idle" | "saving" | "success" | "error";
  label: string;
};

type ThemePreference = "dark" | "light" | "system";

type SaveNoteResponse = {
  noteId: string;
  created: boolean;
  meta: {
    title: string;
    updatedAt: string;
  };
};

type NoteSavePayload = {
  key: string;
  body: {
    title: string;
    noteType: "note";
    lexicalState: LexicalStateLike;
    tags: string[];
  };
};

type NoteSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

type NoteEventRecord = {
  timestamp: string;
  entity: {
    kind: "note";
    id: string;
  };
  payload: {
    title?: unknown;
  };
};

type CanonicalNoteResponse = {
  noteId: string;
  lexicalState: CanonicalNoteRecord["lexicalState"];
  meta: {
    title: string;
    tags: string[];
  };
};

type DailyNoteResponse = {
  noteId: string;
  created: boolean;
  title: string;
  dateKey: string;
  shortDate: string;
  timezone: string;
};

type StoreRootConfigResponse = {
  schemaVersion: string;
  configPath: string;
  defaultStoreRoot: string;
  configuredStoreRoot: string | null;
  effectiveStoreRoot: string;
  source: "runtime" | "env" | "config" | "default";
};

export function formatSavedAt(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatModifiedAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function isThemePreference(value: string): value is ThemePreference {
  return value === "dark" || value === "light" || value === "system";
}

export function formatStoreRootMessage(config: StoreRootConfigResponse): string {
  if (config.source === "runtime") {
    return `Using ${config.effectiveStoreRoot} (changed in this app session).`;
  }

  if (config.source === "env") {
    return `Using ${config.effectiveStoreRoot} from REM_STORE_ROOT.`;
  }

  if (config.source === "config") {
    return `Using ${config.effectiveStoreRoot} from ${config.configPath}.`;
  }

  return `Using default store root ${config.defaultStoreRoot}.`;
}

export function createNoteSavePayload(
  rawTitle: string,
  lexicalState: LexicalStateLike,
  tags: string[],
): NoteSavePayload | null {
  const normalizedTitle = rawTitle.trim();
  const normalizedBody = lexicalStateToPlainText(lexicalState).trim();

  if (!normalizedTitle && !normalizedBody) {
    return null;
  }

  const body = {
    title: normalizedTitle || "Untitled Note",
    noteType: "note" as const,
    lexicalState,
    tags,
  };

  return {
    body,
    key: JSON.stringify(body),
  };
}

function ListTabIndentationPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    function indentListItem(listItem: ListItemNode): void {
      const previousSibling = listItem.getPreviousSibling();
      if (!$isListItemNode(previousSibling)) {
        return;
      }

      const parentList = listItem.getParent();
      if (!$isListNode(parentList)) {
        return;
      }

      const previousLastChild = previousSibling.getLastChild();
      let nestedList: ListNode;
      if (
        $isListNode(previousLastChild) &&
        previousLastChild.getListType() === parentList.getListType()
      ) {
        nestedList = previousLastChild;
      } else {
        nestedList = $createListNode(parentList.getListType());
        previousSibling.append(nestedList);
      }

      nestedList.append(listItem);
    }

    function outdentListItem(listItem: ListItemNode): void {
      const parentList = listItem.getParent();
      if (!$isListNode(parentList)) {
        return;
      }

      const parentListItem = parentList.getParent();
      if (!$isListItemNode(parentListItem)) {
        return;
      }

      const grandParentList = parentListItem.getParent();
      if (!$isListNode(grandParentList)) {
        return;
      }

      parentListItem.insertAfter(listItem);

      if (parentList.getChildrenSize() === 0) {
        parentList.remove();
      }

      if (parentListItem.getChildrenSize() === 0) {
        parentListItem.remove();
      }
    }

    return editor.registerCommand<KeyboardEvent>(
      KEY_TAB_COMMAND,
      (event) => {
        let handled = false;
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
            return;
          }

          let currentNode: LexicalNode | null = selection.anchor.getNode();
          let activeListItem: ListItemNode | null = null;
          while (currentNode !== null) {
            if ($isListItemNode(currentNode)) {
              activeListItem = currentNode;
              break;
            }
            currentNode = currentNode.getParent();
          }

          if (activeListItem === null) {
            return;
          }

          handled = true;
          event.preventDefault();
          if (event.shiftKey) {
            outdentListItem(activeListItem);
            return;
          }

          indentListItem(activeListItem);
        });

        return handled;
      },
      COMMAND_PRIORITY_EDITOR,
    );
  }, [editor]);

  return null;
}

function EditorSurface(props: {
  editorKey: number;
  initialState: LexicalStateLike;
  onStateChange: (state: LexicalStateLike) => void;
  notes: NoteSummary[];
  onOpenLinkedNote: (noteId: string) => Promise<void>;
  onCreateLinkedNote: (title: string) => Promise<NoteSummary | null>;
}): React.JSX.Element {
  if (typeof window === "undefined") {
    return <div className="editor-fallback">Lexical editor loads in the browser.</div>;
  }

  return (
    <LexicalComposer
      key={props.editorKey}
      initialConfig={{
        namespace: `rem-editor-${props.editorKey}`,
        onError: (error) => {
          throw error;
        },
        editorState: JSON.stringify(props.initialState),
        nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, CodeNode],
        theme: EDITOR_THEME,
      }}
    >
      <div className="lexical-shell">
        <RichTextPlugin
          contentEditable={<ContentEditable className="lexical-editor" aria-label="Note editor" />}
          placeholder={<div className="lexical-placeholder">Start typing...</div>}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <ListPlugin />
        <ListTabIndentationPlugin />
        <AutoFocusPlugin />
        <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
        <WikiLinksPlugin
          notes={props.notes}
          onOpenNote={props.onOpenLinkedNote}
          onCreateNote={props.onCreateLinkedNote}
        />
        <OnChangePlugin
          onChange={(editorState) => {
            props.onStateChange(editorState.toJSON() as unknown as LexicalStateLike);
          }}
        />
      </div>
    </LexicalComposer>
  );
}

export function App() {
  const defaultEditorState = useMemo(() => plainTextToLexicalState(""), []);

  const [noteId, setNoteId] = useState<string | null>(null);
  const [title, setTitle] = useState("Untitled Note");
  const [tagsInput, setTagsInput] = useState("daily, scratchpad");
  const [editorSeed, setEditorSeed] = useState(0);
  const [editorInitialState, setEditorInitialState] =
    useState<LexicalStateLike>(defaultEditorState);
  const [editorState, setEditorState] = useState<LexicalStateLike>(defaultEditorState);
  const [saveState, setSaveState] = useState<SaveState>({
    kind: "idle",
    message: "Autosave on. Waiting for edits.",
  });
  const [lastSavedKey, setLastSavedKey] = useState<string | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [notesQuery, setNotesQuery] = useState("");
  const [notesState, setNotesState] = useState<SaveState>({
    kind: "idle",
    message: "Loading notes...",
  });
  const [activePage, setActivePage] = useState<"editor" | "settings">("editor");
  const [team, setTeam] = useState("Core");
  const [themePreference, setThemePreference] = useState<ThemePreference>("dark");
  const [storeRootInput, setStoreRootInput] = useState("");
  const [storeRootConfig, setStoreRootConfig] = useState<StoreRootConfigResponse | null>(null);
  const [storeRootState, setStoreRootState] = useState<SaveState>({
    kind: "idle",
    message: "Loading store root...",
  });
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [commandNoteResults, setCommandNoteResults] = useState<CommandPaletteNoteResult[]>([]);
  const [commandNoteSearchState, setCommandNoteSearchState] = useState<SaveState>({
    kind: "idle",
    message: "Type to search notes.",
  });
  const [commandState, setCommandState] = useState<SaveState>({
    kind: "idle",
    message: "Ready.",
  });

  const noteIdRef = useRef<string | null>(null);
  const isSavingRef = useRef(false);
  const queuedAutosaveRef = useRef(false);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestPayloadRef = useRef<NoteSavePayload | null>(null);
  const hasOpenedInitialDailyNoteRef = useRef(false);
  const commandSearchInputRef = useRef<HTMLInputElement | null>(null);
  const commandItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const lastFocusedElementBeforeCommandPaletteRef = useRef<HTMLElement | null>(null);
  const lastEditorSelectionRangeBeforeCommandPaletteRef = useRef<Range | null>(null);

  const parsedTags = useMemo(() => parseTags(tagsInput), [tagsInput]);

  const dayStamp = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(new Date()),
    [],
  );

  const currentSavePayload = useMemo<NoteSavePayload | null>(() => {
    return createNoteSavePayload(title, editorState, parsedTags);
  }, [title, editorState, parsedTags]);

  const hasUnsavedChanges =
    currentSavePayload !== null && currentSavePayload.key !== (lastSavedKey ?? null);

  const filteredNotes = useMemo(() => {
    const normalizedQuery = notesQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return notes;
    }

    return notes.filter(
      (note) =>
        note.title.toLowerCase().includes(normalizedQuery) ||
        note.id.toLowerCase().includes(normalizedQuery) ||
        buildDailyTitleDateAliases(note.title).some((alias) =>
          alias.toLowerCase().includes(normalizedQuery),
        ),
    );
  }, [notes, notesQuery]);

  const commandPaletteSections = useMemo(
    () => buildCommandPaletteSections(commandQuery, commandNoteResults),
    [commandNoteResults, commandQuery],
  );
  const commandPaletteItems = useMemo(
    () => flattenCommandPaletteSections(commandPaletteSections),
    [commandPaletteSections],
  );
  const commandPaletteSectionsWithIndices = useMemo(() => {
    let nextIndex = 0;
    return commandPaletteSections.map((section) => ({
      ...section,
      items: section.items.map((item) => ({
        item,
        index: nextIndex++,
      })),
    }));
  }, [commandPaletteSections]);

  const saveIndicator = useMemo<SaveIndicator>(() => {
    if (saveState.kind === "error") {
      return { tone: "error", label: "Save failed" };
    }

    if (saveState.kind === "saving") {
      return { tone: "saving", label: "Saving" };
    }

    if (hasUnsavedChanges) {
      return { tone: "idle", label: "Unsaved" };
    }

    if (saveState.kind === "success") {
      return { tone: "success", label: "Saved" };
    }

    return { tone: "idle", label: "Waiting for edits" };
  }, [hasUnsavedChanges, saveState.kind]);

  const upsertNoteSummary = useCallback((summary: NoteSummary): void => {
    setNotes((current) => {
      const next = [summary, ...current.filter((item) => item.id !== summary.id)];
      next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return next;
    });
  }, []);

  useEffect(() => {
    noteIdRef.current = noteId;
  }, [noteId]);

  useEffect(() => {
    latestPayloadRef.current = currentSavePayload;
  }, [currentSavePayload]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const storedTeam = window.localStorage.getItem("rem.team");
    if (storedTeam?.trim()) {
      setTeam(storedTeam.trim());
    }

    const storedTheme = window.localStorage.getItem("rem.theme");
    if (storedTheme && isThemePreference(storedTheme)) {
      setThemePreference(storedTheme);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem("rem.team", team.trim() || "Core");
  }, [team]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem("rem.theme", themePreference);

    const root = window.document.documentElement;
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");

    const applyTheme = (): void => {
      const resolvedTheme =
        themePreference === "system" ? (colorScheme.matches ? "dark" : "light") : themePreference;
      root.dataset.theme = resolvedTheme;
    };

    applyTheme();

    if (themePreference !== "system") {
      return;
    }

    const onColorSchemeChange = (): void => {
      applyTheme();
    };

    colorScheme.addEventListener("change", onColorSchemeChange);

    return () => {
      colorScheme.removeEventListener("change", onColorSchemeChange);
    };
  }, [themePreference]);

  const refreshStoreRootConfig = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`${API_BASE_URL}/config`);
      if (!response.ok) {
        throw new Error(`Failed loading settings (${response.status})`);
      }

      const payload = (await response.json()) as StoreRootConfigResponse;
      setStoreRootConfig(payload);
      setStoreRootInput(payload.configuredStoreRoot ?? "");
      setStoreRootState({
        kind: "idle",
        message: formatStoreRootMessage(payload),
      });
    } catch (error) {
      setStoreRootState({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed loading settings.",
      });
    }
  }, []);

  const refreshNotes = useCallback(async (): Promise<void> => {
    setNotesState({ kind: "saving", message: "Loading notes..." });

    try {
      const response = await fetch(`${API_BASE_URL}/events?entityKind=note&limit=1000`);
      if (!response.ok) {
        throw new Error(`Failed loading notes (${response.status})`);
      }

      const payload = (await response.json()) as NoteEventRecord[];
      const byId = new Map<string, NoteSummary>();

      for (const event of payload) {
        if (byId.has(event.entity.id)) {
          continue;
        }

        const rawTitle = event.payload.title;
        const nextTitle =
          typeof rawTitle === "string" && rawTitle.trim().length > 0
            ? rawTitle.trim()
            : "(untitled)";

        byId.set(event.entity.id, {
          id: event.entity.id,
          title: nextTitle,
          updatedAt: event.timestamp,
        });
      }

      const summaries = [...byId.values()].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
      setNotes(summaries);
      setNotesState({
        kind: "success",
        message: summaries.length === 0 ? "No notes yet." : `Loaded ${summaries.length} notes.`,
      });
    } catch (error) {
      setNotesState({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed loading notes.",
      });
    }
  }, []);

  const restoreFocusAfterCommandPaletteClose = useCallback((): void => {
    if (typeof window === "undefined") {
      return;
    }

    const previouslyFocusedElement = lastFocusedElementBeforeCommandPaletteRef.current;
    const previouslySelectedEditorRange = lastEditorSelectionRangeBeforeCommandPaletteRef.current;
    window.requestAnimationFrame(() => {
      const fallbackEditor = window.document.querySelector<HTMLElement>(".lexical-editor");
      const targetElement =
        previouslyFocusedElement !== null && window.document.contains(previouslyFocusedElement)
          ? previouslyFocusedElement
          : fallbackEditor;
      targetElement?.focus();

      if (
        previouslySelectedEditorRange !== null &&
        window.document.contains(previouslySelectedEditorRange.startContainer) &&
        window.document.contains(previouslySelectedEditorRange.endContainer)
      ) {
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(previouslySelectedEditorRange);
      }
    });
  }, []);

  const closeCommandPalette = useCallback((): void => {
    setIsCommandPaletteOpen(false);
    restoreFocusAfterCommandPaletteClose();
  }, [restoreFocusAfterCommandPaletteClose]);

  const openCommandPalette = useCallback((): void => {
    if (typeof window !== "undefined") {
      const currentActiveElement = window.document.activeElement;
      if (
        currentActiveElement instanceof HTMLElement &&
        currentActiveElement !== window.document.body
      ) {
        lastFocusedElementBeforeCommandPaletteRef.current = currentActiveElement;
      }

      const selection = window.getSelection();
      const editorElement = window.document.querySelector<HTMLElement>(".lexical-editor");
      if (
        selection !== null &&
        selection.rangeCount > 0 &&
        editorElement !== null &&
        selection.anchorNode !== null &&
        selection.focusNode !== null &&
        editorElement.contains(selection.anchorNode) &&
        editorElement.contains(selection.focusNode)
      ) {
        lastEditorSelectionRangeBeforeCommandPaletteRef.current = selection
          .getRangeAt(0)
          .cloneRange();
      } else {
        lastEditorSelectionRangeBeforeCommandPaletteRef.current = null;
      }
    }

    setCommandQuery("");
    setCommandNoteResults([]);
    setCommandNoteSearchState({
      kind: "idle",
      message: "Type to search notes.",
    });
    setCommandState({
      kind: "idle",
      message: "Ready.",
    });
    setActiveCommandIndex(0);
    commandItemRefs.current = [];
    setIsCommandPaletteOpen(true);
  }, []);

  const applyStoreRootConfig = useCallback(
    async (nextStoreRoot: string): Promise<void> => {
      setStoreRootState({
        kind: "saving",
        message: "Updating store root...",
      });

      try {
        const response = await fetch(`${API_BASE_URL}/config`, {
          method: "PUT",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            storeRoot: nextStoreRoot,
          }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(
            payload?.error?.message ?? `Failed updating store root (${response.status})`,
          );
        }

        const payload = (await response.json()) as StoreRootConfigResponse;
        setStoreRootConfig(payload);
        setStoreRootInput(payload.configuredStoreRoot ?? "");
        setStoreRootState({
          kind: "success",
          message: formatStoreRootMessage(payload),
        });
        await refreshNotes();
      } catch (error) {
        setStoreRootState({
          kind: "error",
          message: error instanceof Error ? error.message : "Failed updating store root.",
        });
      }
    },
    [refreshNotes],
  );

  const saveStoreRootConfig = useCallback(async (): Promise<void> => {
    await applyStoreRootConfig(storeRootInput);
  }, [applyStoreRootConfig, storeRootInput]);

  const resetStoreRootConfig = useCallback(async (): Promise<void> => {
    await applyStoreRootConfig("");
  }, [applyStoreRootConfig]);

  useEffect(() => {
    void refreshStoreRootConfig();
  }, [refreshStoreRootConfig]);

  useEffect(() => {
    void refreshNotes();
  }, [refreshNotes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isSidebarToggleShortcut(event)) {
        event.preventDefault();
        setIsPanelOpen((current) => !current);
      }

      if (isCommandPaletteShortcut(event)) {
        event.preventDefault();
        openCommandPalette();
      }

      if (event.key === "Escape" && isCommandPaletteOpen) {
        event.preventDefault();
        closeCommandPalette();
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setIsPanelOpen(false);
        if (
          typeof window !== "undefined" &&
          window.document.activeElement === window.document.body &&
          lastFocusedElementBeforeCommandPaletteRef.current !== null
        ) {
          restoreFocusAfterCommandPaletteClose();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    closeCommandPalette,
    isCommandPaletteOpen,
    openCommandPalette,
    restoreFocusAfterCommandPaletteClose,
  ]);

  useEffect(() => {
    if (!isCommandPaletteOpen) {
      return;
    }

    commandSearchInputRef.current?.focus();
    commandSearchInputRef.current?.select();
  }, [isCommandPaletteOpen]);

  const openNote = useCallback(async (targetNoteId: string): Promise<void> => {
    setNotesState({
      kind: "saving",
      message: `Loading note ${targetNoteId.slice(0, 8)}...`,
    });

    try {
      const response = await fetch(`${API_BASE_URL}/notes/${targetNoteId}`);
      if (!response.ok) {
        throw new Error(`Failed loading note (${response.status})`);
      }

      const payload = (await response.json()) as CanonicalNoteResponse;
      const nextLexicalState = payload.lexicalState as LexicalStateLike;
      const nextTitle = payload.meta.title || "Untitled Note";
      const nextTags = payload.meta.tags ?? [];

      setNoteId(payload.noteId);
      setTitle(nextTitle);
      setTagsInput(nextTags.join(", "));
      setEditorInitialState(nextLexicalState);
      setEditorState(nextLexicalState);
      setEditorSeed((current) => current + 1);
      setActivePage("editor");

      const loadedPayload = createNoteSavePayload(nextTitle, nextLexicalState, nextTags);
      setLastSavedKey(loadedPayload?.key ?? null);
      setSaveState({
        kind: "success",
        message: `Loaded note ${payload.noteId.slice(0, 8)}.`,
      });
      setNotesState({
        kind: "success",
        message: `Opened ${payload.noteId.slice(0, 8)}.`,
      });
    } catch (error) {
      setNotesState({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed loading note.",
      });
    }
  }, []);

  useEffect(() => {
    if (!isCommandPaletteOpen) {
      return;
    }

    const normalizedQuery = commandQuery.trim();
    if (!normalizedQuery) {
      setCommandNoteResults([]);
      setCommandNoteSearchState({
        kind: "idle",
        message: "Type to search notes.",
      });
      return;
    }

    const controller = new AbortController();
    setCommandNoteResults([]);
    setCommandNoteSearchState({
      kind: "saving",
      message: "Searching notes...",
    });
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const params = new URLSearchParams({
            q: normalizedQuery,
            limit: COMMAND_NOTE_SEARCH_LIMIT.toString(),
          });
          const response = await fetch(`${API_BASE_URL}/search?${params.toString()}`, {
            signal: controller.signal,
          });

          if (!response.ok) {
            throw new Error(`Failed searching notes (${response.status})`);
          }

          const payload = (await response.json()) as CommandPaletteNoteResult[];
          if (controller.signal.aborted) {
            return;
          }

          setCommandNoteResults(payload);
          setCommandNoteSearchState({
            kind: "success",
            message: payload.length === 0 ? "No notes found." : `Found ${payload.length} notes.`,
          });
        } catch (error) {
          if (controller.signal.aborted) {
            return;
          }

          setCommandNoteResults([]);
          setCommandNoteSearchState({
            kind: "error",
            message: error instanceof Error ? error.message : "Failed searching notes.",
          });
        }
      })();
    }, COMMAND_NOTE_SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [commandQuery, isCommandPaletteOpen]);

  const createWikiLinkedNote = useCallback(
    async (rawTitle: string): Promise<NoteSummary | null> => {
      const normalizedTitle = rawTitle.replace(/\s+/g, " ").trim();
      if (!normalizedTitle) {
        return null;
      }

      const existing = notes.find(
        (note) => note.title.trim().toLowerCase() === normalizedTitle.toLowerCase(),
      );
      if (existing) {
        return existing;
      }

      try {
        const response = await fetch(`${API_BASE_URL}/notes`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            title: normalizedTitle,
            noteType: "note",
            lexicalState: plainTextToLexicalState(""),
            tags: [],
          }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(payload?.error?.message ?? `Failed creating note (${response.status})`);
        }

        const payload = (await response.json()) as SaveNoteResponse;
        const createdSummary: NoteSummary = {
          id: payload.noteId,
          title: payload.meta.title || normalizedTitle,
          updatedAt: payload.meta.updatedAt,
        };
        upsertNoteSummary(createdSummary);

        return createdSummary;
      } catch (error) {
        setNotesState({
          kind: "error",
          message: error instanceof Error ? error.message : "Failed creating linked note.",
        });
        return null;
      }
    },
    [notes, upsertNoteSummary],
  );

  const createNewNote = useCallback(async (): Promise<void> => {
    setCommandState({
      kind: "saving",
      message: "Creating a new note...",
    });

    const nextTitle = "Untitled Note";
    const nextLexicalState = plainTextToLexicalState("");
    const nextTags: string[] = [];

    try {
      const response = await fetch(`${API_BASE_URL}/notes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: nextTitle,
          noteType: "note",
          lexicalState: nextLexicalState,
          tags: nextTags,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(payload?.error?.message ?? `Failed creating note (${response.status})`);
      }

      const payload = (await response.json()) as SaveNoteResponse;
      await openNote(payload.noteId);
      await refreshNotes();

      setCommandState({
        kind: "success",
        message: `Created ${payload.meta.title}.`,
      });
      closeCommandPalette();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed creating note.";
      setNotesState({
        kind: "error",
        message,
      });
      setCommandState({
        kind: "error",
        message,
      });
    }
  }, [closeCommandPalette, openNote, refreshNotes]);

  const openTodayNote = useCallback(
    async (origin: "startup" | "command"): Promise<void> => {
      if (origin === "command") {
        setCommandState({
          kind: "saving",
          message: "Opening today's daily note...",
        });
      }

      try {
        const timeZone = resolveClientTimeZone();
        const response = await fetch(`${API_BASE_URL}/daily-notes/today`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(buildDailyNoteRequestPayload(timeZone)),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(
            payload?.error?.message ?? `Failed opening daily note (${response.status})`,
          );
        }

        const payload = (await response.json()) as DailyNoteResponse;
        await openNote(payload.noteId);
        await refreshNotes();

        if (origin === "command") {
          setCommandState({
            kind: "success",
            message: `Opened ${payload.title}.`,
          });
          closeCommandPalette();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed opening daily note.";
        setNotesState({
          kind: "error",
          message,
        });
        if (origin === "command") {
          setCommandState({
            kind: "error",
            message,
          });
        }
      }
    },
    [closeCommandPalette, openNote, refreshNotes],
  );

  const selectCommandPaletteItem = useCallback(
    (item: CommandPaletteMatch): void => {
      if (item.kind === "command") {
        if (item.id === "today") {
          void openTodayNote("command");
          return;
        }

        void createNewNote();
        return;
      }

      closeCommandPalette();
      void openNote(item.noteId);
    },
    [closeCommandPalette, createNewNote, openNote, openTodayNote],
  );

  useEffect(() => {
    if (!isCommandPaletteOpen) {
      return;
    }

    if (commandPaletteItems.length === 0) {
      if (activeCommandIndex !== 0) {
        setActiveCommandIndex(0);
      }
      return;
    }

    if (activeCommandIndex >= commandPaletteItems.length) {
      setActiveCommandIndex(commandPaletteItems.length - 1);
    }
  }, [activeCommandIndex, commandPaletteItems.length, isCommandPaletteOpen]);

  const selectedCommandIndex =
    commandPaletteItems.length === 0
      ? 0
      : Math.min(activeCommandIndex, commandPaletteItems.length - 1);
  const selectedCommand = commandPaletteItems[selectedCommandIndex] ?? null;
  const displayedCommandPaletteState =
    commandState.kind !== "idle" ||
    commandNoteSearchState.kind === "saving" ||
    commandNoteSearchState.kind === "error"
      ? commandState.kind !== "idle"
        ? commandState
        : commandNoteSearchState
      : commandState;

  useEffect(() => {
    if (!isCommandPaletteOpen || commandPaletteItems.length === 0) {
      return;
    }

    commandItemRefs.current[selectedCommandIndex]?.scrollIntoView({
      block: "nearest",
    });
  }, [commandPaletteItems.length, isCommandPaletteOpen, selectedCommandIndex]);

  useEffect(() => {
    if (hasOpenedInitialDailyNoteRef.current) {
      return;
    }

    hasOpenedInitialDailyNoteRef.current = true;
    void openTodayNote("startup");
  }, [openTodayNote]);

  const saveNote = useCallback(
    async (origin: "auto" | "manual"): Promise<void> => {
      const payload = latestPayloadRef.current;

      if (!payload) {
        if (origin === "manual") {
          setSaveState({
            kind: "error",
            message: "Add a title or note content before saving.",
          });
        }
        return;
      }

      if (origin === "manual" && payload.key === lastSavedKey) {
        setSaveState({ kind: "success", message: "Already saved." });
        return;
      }

      if (isSavingRef.current) {
        queuedAutosaveRef.current = true;
        return;
      }

      isSavingRef.current = true;
      setSaveState({
        kind: "saving",
        message: origin === "auto" ? "Autosaving..." : "Saving through Core...",
      });

      try {
        const isUpdate = Boolean(noteIdRef.current);
        const response = await fetch(
          isUpdate ? `${API_BASE_URL}/notes/${noteIdRef.current}` : `${API_BASE_URL}/notes`,
          {
            method: isUpdate ? "PUT" : "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify(payload.body),
          },
        );

        if (!response.ok) {
          throw new Error(`Save failed with status ${response.status}`);
        }

        const responsePayload = (await response.json()) as SaveNoteResponse;
        noteIdRef.current = responsePayload.noteId;
        setNoteId(responsePayload.noteId);
        setLastSavedKey(payload.key);
        upsertNoteSummary({
          id: responsePayload.noteId,
          title: responsePayload.meta.title,
          updatedAt: responsePayload.meta.updatedAt,
        });

        const savedAt = formatSavedAt(responsePayload.meta.updatedAt);
        if (origin === "auto") {
          setSaveState({
            kind: "success",
            message: `Autosaved at ${savedAt}.`,
          });
        } else {
          const actionLabel = responsePayload.created ? "Created" : "Updated";
          setSaveState({
            kind: "success",
            message: `${actionLabel} note ${responsePayload.noteId.slice(0, 8)} at ${savedAt}.`,
          });
        }
      } catch (error) {
        setSaveState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Save failed. Check that API is running on localhost.",
        });
      } finally {
        isSavingRef.current = false;

        if (queuedAutosaveRef.current) {
          queuedAutosaveRef.current = false;
          void saveNote("auto");
        }
      }
    },
    [lastSavedKey, upsertNoteSummary],
  );

  useEffect(() => {
    if (!currentSavePayload || currentSavePayload.key === lastSavedKey) {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      return;
    }

    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
    }

    autosaveTimerRef.current = setTimeout(() => {
      void saveNote("auto");
    }, AUTOSAVE_DELAY_MS);

    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [currentSavePayload, lastSavedKey, saveNote]);

  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
      }
    };
  }, []);

  return (
    <div className="app-shell">
      <div className={`workspace ${isPanelOpen ? "workspace-panel-open" : ""}`}>
        <aside id="workspace-panel" className="side-panel" aria-hidden={!isPanelOpen}>
          <div className="panel-header">
            <p className="panel-note-title">{title.trim() || "Untitled Note"}</p>
            <p className="panel-meta-line">
              <span>{noteId ? `#${noteId.slice(0, 8)}` : "New draft"}</span>
              <span>{parsedTags.length} tags</span>
            </p>
            <p className="panel-meta-line panel-meta-line-muted">{notesState.message}</p>
          </div>

          <div className="panel-tree-region">
            <div className="panel-tree-head">
              <p>Notes</p>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Refresh notes"
                title="Refresh notes"
                onClick={() => void refreshNotes()}
              >
                <RefreshCw className="ui-icon" />
              </Button>
            </div>

            <Input
              value={notesQuery}
              onChange={(event) => setNotesQuery(event.currentTarget.value)}
              placeholder="Search notes"
              aria-label="Search notes"
              className="panel-search-input"
            />

            {filteredNotes.length === 0 ? (
              <p className="panel-empty">No notes found.</p>
            ) : (
              <ul className="note-tree" role="tree" aria-label="Notes tree">
                {filteredNotes.map((note) => (
                  <li key={note.id} role="treeitem" aria-selected={note.id === noteId}>
                    <button
                      type="button"
                      className={`note-tree-item ${note.id === noteId ? "note-tree-item-active" : ""}`}
                      onClick={() => void openNote(note.id)}
                    >
                      <span className="note-tree-node" aria-hidden="true" />
                      <span className="note-tree-copy">
                        <strong>{note.title}</strong>
                        <span>{formatModifiedAt(note.updatedAt)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Button
            type="button"
            variant="subtle"
            className="panel-settings panel-settings-active"
            onClick={() => setActivePage("settings")}
          >
            <Settings className="ui-icon" />
            <span>Settings</span>
          </Button>
        </aside>

        <div className={`main-column ${activePage === "settings" ? "main-column-settings" : ""}`}>
          {activePage === "editor" ? (
            <>
              <header className="topbar">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="menu-toggle"
                  aria-label={isPanelOpen ? "Hide sidebar" : "Show sidebar"}
                  title={isPanelOpen ? "Hide sidebar" : "Show sidebar"}
                  aria-expanded={isPanelOpen}
                  aria-controls="workspace-panel"
                  onClick={() => setIsPanelOpen((current) => !current)}
                >
                  <Menu className="ui-icon" />
                </Button>

                <div className="topbar-meta">
                  <Input
                    className="topbar-title-input"
                    value={title}
                    onChange={(event) => setTitle(event.currentTarget.value)}
                    placeholder="Untitled note"
                    aria-label="Note title"
                  />
                  <p className="topbar-subline">
                    <span>{dayStamp}</span>
                    <span className={`save-indicator save-indicator-${saveIndicator.tone}`}>
                      <span className="save-indicator-dot" aria-hidden="true" />
                      {saveIndicator.label}
                    </span>
                  </p>
                </div>
              </header>

              <main className="canvas" aria-label="Writing canvas">
                <div className="canvas-frame">
                  <EditorSurface
                    editorKey={editorSeed}
                    initialState={editorInitialState}
                    onStateChange={setEditorState}
                    notes={notes}
                    onOpenLinkedNote={openNote}
                    onCreateLinkedNote={createWikiLinkedNote}
                  />
                </div>
              </main>
            </>
          ) : (
            <main className="settings-fullscreen-page" aria-label="Settings page">
              <div className="settings-fullscreen">
                <header className="settings-fullscreen-header">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="menu-toggle"
                    aria-label={isPanelOpen ? "Hide sidebar" : "Show sidebar"}
                    title={isPanelOpen ? "Hide sidebar" : "Show sidebar"}
                    aria-expanded={isPanelOpen}
                    aria-controls="workspace-panel"
                    onClick={() => setIsPanelOpen((current) => !current)}
                  >
                    <Menu className="ui-icon" />
                  </Button>
                  <h1>Settings</h1>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="settings-back-button"
                    onClick={() => setActivePage("editor")}
                  >
                    Back to note
                  </Button>
                </header>

                <section className="settings-team-section" aria-label="Team and storage settings">
                  <label className="settings-field" htmlFor="settings-team">
                    <span>Team</span>
                    <Input
                      id="settings-team"
                      value={team}
                      onChange={(event) => setTeam(event.currentTarget.value)}
                      placeholder="Core"
                    />
                  </label>
                  <label className="settings-field" htmlFor="settings-store-root">
                    <span>Store Root</span>
                    <Input
                      id="settings-store-root"
                      value={storeRootInput}
                      onChange={(event) => setStoreRootInput(event.currentTarget.value)}
                      placeholder={storeRootConfig?.defaultStoreRoot ?? "~/.rem"}
                      aria-describedby="settings-store-root-help"
                    />
                  </label>
                  <div className="settings-actions">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void saveStoreRootConfig()}
                      disabled={storeRootState.kind === "saving"}
                    >
                      Save store root
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="subtle"
                      onClick={() => void resetStoreRootConfig()}
                      disabled={storeRootState.kind === "saving"}
                    >
                      Use default
                    </Button>
                  </div>
                  <p
                    id="settings-store-root-help"
                    className={`settings-store-root-status settings-store-root-status-${storeRootState.kind}`}
                  >
                    {storeRootState.message}
                  </p>
                  <div className="settings-theme-switcher" aria-label="Theme switcher">
                    <span className="settings-theme-label">Theme</span>
                    <div className="settings-theme-options">
                      <Button
                        type="button"
                        size="sm"
                        variant={themePreference === "dark" ? "default" : "subtle"}
                        onClick={() => setThemePreference("dark")}
                      >
                        Dark
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={themePreference === "light" ? "default" : "subtle"}
                        onClick={() => setThemePreference("light")}
                      >
                        Light
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={themePreference === "system" ? "default" : "subtle"}
                        onClick={() => setThemePreference("system")}
                      >
                        System
                      </Button>
                    </div>
                  </div>
                  <p className="settings-team-help">
                    Team and theme preferences are stored locally in this browser. Store root
                    changes apply across the app and default to ~/.rem when not configured.
                  </p>
                </section>
              </div>
            </main>
          )}
        </div>
      </div>

      {isCommandPaletteOpen ? (
        <div
          className="command-palette-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeCommandPalette();
            }
          }}
        >
          <dialog className="command-palette" open aria-label="Command palette">
            <div className="command-palette-search">
              <Search className="ui-icon" aria-hidden="true" />
              <input
                ref={commandSearchInputRef}
                type="text"
                className="command-palette-search-input"
                placeholder="Search commands or notes"
                value={commandQuery}
                onChange={(event) => {
                  setCommandQuery(event.currentTarget.value);
                  setActiveCommandIndex(0);
                }}
                onKeyDown={(event) => {
                  if (isNextCommandShortcut(event) && commandPaletteItems.length > 0) {
                    event.preventDefault();
                    setActiveCommandIndex((current) =>
                      getNextCommandIndex(current, commandPaletteItems.length),
                    );
                    return;
                  }

                  if (isPreviousCommandShortcut(event) && commandPaletteItems.length > 0) {
                    event.preventDefault();
                    setActiveCommandIndex((current) =>
                      getPreviousCommandIndex(current, commandPaletteItems.length),
                    );
                    return;
                  }

                  if (
                    event.key === "Enter" &&
                    selectedCommand !== null &&
                    commandState.kind !== "saving"
                  ) {
                    event.preventDefault();
                    selectCommandPaletteItem(selectedCommand);
                  }
                }}
                aria-label="Search commands or notes"
              />
            </div>
            {commandPaletteSectionsWithIndices.length > 0 ? (
              commandPaletteSectionsWithIndices.map((section) => (
                <section
                  key={section.id}
                  className="command-palette-group"
                  aria-label={`${section.label} results`}
                >
                  <p className="command-palette-group-label">{section.label}</p>
                  <ul className="command-palette-list" aria-label={`${section.label} list`}>
                    {section.items.map(({ item, index }) => {
                      const isActive = index === selectedCommandIndex;
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            ref={(element) => {
                              commandItemRefs.current[index] = element;
                            }}
                            className={
                              isActive
                                ? "command-palette-item command-palette-item-active"
                                : "command-palette-item"
                            }
                            onClick={() => {
                              selectCommandPaletteItem(item);
                            }}
                            disabled={commandState.kind === "saving"}
                          >
                            {item.kind === "command" ? (
                              <>
                                <span className="command-palette-item-main">
                                  {item.id === "today" ? (
                                    <CalendarDays className="ui-icon" aria-hidden="true" />
                                  ) : (
                                    <Plus className="ui-icon" aria-hidden="true" />
                                  )}
                                  <span>{item.label}</span>
                                </span>
                                <span className="command-palette-shortcut">{item.shortcut}</span>
                              </>
                            ) : (
                              <>
                                <span className="command-palette-item-copy">
                                  <span className="command-palette-item-main">
                                    <FileText className="ui-icon" aria-hidden="true" />
                                    <span>{item.title}</span>
                                  </span>
                                  <span className="command-palette-item-secondary">
                                    {item.snippet}
                                  </span>
                                </span>
                                <span className="command-palette-meta">
                                  {formatModifiedAt(item.updatedAt)}
                                </span>
                              </>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))
            ) : commandNoteSearchState.kind === "saving" ? null : (
              <p className="command-palette-empty">No matching commands or notes.</p>
            )}
            {displayedCommandPaletteState.kind === "idle" ? null : (
              <p
                className={`command-palette-status command-palette-status-${displayedCommandPaletteState.kind}`}
                aria-live="polite"
              >
                {displayedCommandPaletteState.message}
              </p>
            )}
          </dialog>
        </div>
      ) : null}
    </div>
  );
}
