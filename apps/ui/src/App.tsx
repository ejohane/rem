import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { TRANSFORMERS } from "@lexical/markdown";
import { AutoFocusPlugin } from "@lexical/react/LexicalAutoFocusPlugin";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { Menu, RefreshCw, Settings } from "lucide-react";

import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  type LexicalStateLike,
  lexicalStateToPlainText,
  parseTags,
  plainTextToLexicalState,
} from "./lexical";

const API_BASE_URL = import.meta.env.VITE_REM_API_BASE_URL ?? "http://127.0.0.1:8787";
const AUTOSAVE_DELAY_MS = 1200;

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
  lexicalState: LexicalStateLike;
  meta: {
    title: string;
    tags: string[];
  };
};

function formatSavedAt(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatModifiedAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isThemePreference(value: string): value is ThemePreference {
  return value === "dark" || value === "light" || value === "system";
}

function createNoteSavePayload(
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

function EditorSurface(props: {
  editorKey: number;
  initialState: LexicalStateLike;
  onStateChange: (state: LexicalStateLike) => void;
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
      }}
    >
      <div className="lexical-shell">
        <RichTextPlugin
          contentEditable={<ContentEditable className="lexical-editor" aria-label="Note editor" />}
          placeholder={<div className="lexical-placeholder">Start typing...</div>}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <AutoFocusPlugin />
        <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
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

  const noteIdRef = useRef<string | null>(null);
  const isSavingRef = useRef(false);
  const queuedAutosaveRef = useRef(false);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestPayloadRef = useRef<NoteSavePayload | null>(null);

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
        note.id.toLowerCase().includes(normalizedQuery),
    );
  }, [notes, notesQuery]);

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

  useEffect(() => {
    void refreshNotes();
  }, [refreshNotes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
        event.preventDefault();
        setIsPanelOpen((current) => !current);
      }

      if (event.key === "Escape") {
        setIsPanelOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

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
            className={`panel-settings ${activePage === "settings" ? "panel-settings-active" : ""}`}
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

                <section className="settings-team-section" aria-label="Team setting">
                  <label className="settings-field" htmlFor="settings-team">
                    <span>Team</span>
                    <Input
                      id="settings-team"
                      value={team}
                      onChange={(event) => setTeam(event.currentTarget.value)}
                      placeholder="Core"
                    />
                  </label>
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
                    Team and theme preferences are stored locally in this browser.
                  </p>
                </section>
              </div>
            </main>
          )}
        </div>
      </div>
    </div>
  );
}
