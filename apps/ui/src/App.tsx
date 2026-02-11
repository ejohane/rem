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
import { Menu, RefreshCw, Settings } from "lucide-react";

import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  type LexicalStateLike,
  lexicalStateToPlainText,
  parseTags,
  plainTextToLexicalState,
} from "./lexical";
import {
  type HostedPluginCommand,
  type PluginCommandSource,
  buildPluginCommandInvocationPayload,
  deriveHostedPluginCommands,
} from "./plugin-commands";
import {
  type PluginPanelSource,
  type PluginPanelsBySlot,
  deriveHostedPluginPanels,
  groupHostedPluginPanelsBySlot,
} from "./plugin-panels";
import {
  type CanonicalNoteRecord,
  type ProposalContentRecord,
  type ProposalEntityReference,
  collectProposalEntityReferences,
  extractSectionContext,
  formatEntityReferenceLabel,
  summarizeEntityContext,
} from "./proposals";

const API_BASE_URL = import.meta.env.VITE_REM_API_BASE_URL ?? "http://127.0.0.1:8787";
const AUTOSAVE_DELAY_MS = 1200;
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
  sectionIndex: CanonicalNoteRecord["sectionIndex"];
  meta: {
    title: string;
    tags: string[];
  };
};

type ProposalSourceRecord = {
  proposal: {
    id: string;
    status: "open" | "accepted" | "rejected" | "superseded";
    target: {
      noteId: string;
      sectionId: string;
      fallbackPath?: string[];
    };
    proposalType: "replace_section" | "annotate";
  };
  content: ProposalContentRecord;
};

type ProposalReviewEntityContext = {
  reference: ProposalEntityReference;
  summary: string;
  unresolved: boolean;
};

type ProposalReviewContext = {
  proposalId: string;
  proposalType: ProposalSourceRecord["proposal"]["proposalType"];
  sectionId: string;
  fallbackPath: string[];
  sectionContext: string | null;
  entities: ProposalReviewEntityContext[];
};

type ProposalEntityLookupResponse = {
  entity: {
    data: Record<string, unknown>;
  };
};

const EMPTY_PLUGIN_PANELS: PluginPanelsBySlot = {
  sidebar: [],
  toolbar: [],
  proposalReview: [],
};

type StoreRootConfigResponse = {
  schemaVersion: string;
  configPath: string;
  defaultStoreRoot: string;
  configuredStoreRoot: string | null;
  effectiveStoreRoot: string;
  source: "runtime" | "env" | "config" | "default";
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

function proposalEntityReferenceKey(reference: ProposalEntityReference): string {
  return `${reference.namespace}:${reference.entityType}:${reference.entityId}`;
}

function isThemePreference(value: string): value is ThemePreference {
  return value === "dark" || value === "light" || value === "system";
}

function formatStoreRootMessage(config: StoreRootConfigResponse): string {
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
  const [pluginPanelsBySlot, setPluginPanelsBySlot] =
    useState<PluginPanelsBySlot>(EMPTY_PLUGIN_PANELS);
  const [pluginPanelsState, setPluginPanelsState] = useState<SaveState>({
    kind: "idle",
    message: "Loading plugin panels...",
  });
  const [pluginCommands, setPluginCommands] = useState<HostedPluginCommand[]>([]);
  const [pluginCommandsState, setPluginCommandsState] = useState<SaveState>({
    kind: "idle",
    message: "Loading plugin commands...",
  });
  const [proposalReviewContexts, setProposalReviewContexts] = useState<ProposalReviewContext[]>([]);
  const [proposalReviewState, setProposalReviewState] = useState<SaveState>({
    kind: "idle",
    message: "Select a saved note to inspect proposal context.",
  });
  const [runningPluginCommandKey, setRunningPluginCommandKey] = useState<string | null>(null);
  const [activePage, setActivePage] = useState<"editor" | "settings">("editor");
  const [team, setTeam] = useState("Core");
  const [themePreference, setThemePreference] = useState<ThemePreference>("dark");
  const [storeRootInput, setStoreRootInput] = useState("");
  const [storeRootConfig, setStoreRootConfig] = useState<StoreRootConfigResponse | null>(null);
  const [storeRootState, setStoreRootState] = useState<SaveState>({
    kind: "idle",
    message: "Loading store root...",
  });

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

  const refreshPluginPanels = useCallback(async (): Promise<void> => {
    setPluginPanelsState({
      kind: "saving",
      message: "Loading plugin panels...",
    });
    setPluginCommandsState({
      kind: "saving",
      message: "Loading plugin commands...",
    });

    try {
      const response = await fetch(`${API_BASE_URL}/plugins?limit=200`);
      if (!response.ok) {
        throw new Error(`Failed loading plugin panels (${response.status})`);
      }

      const payload = (await response.json()) as Array<PluginPanelSource & PluginCommandSource>;
      const hostedPanels = deriveHostedPluginPanels(payload);
      const hostedCommands = deriveHostedPluginCommands(payload);
      setPluginPanelsBySlot(groupHostedPluginPanelsBySlot(hostedPanels));
      setPluginCommands(hostedCommands);
      setPluginPanelsState({
        kind: "success",
        message:
          hostedPanels.length === 0
            ? "No plugin panels available."
            : `Loaded ${hostedPanels.length} plugin panels.`,
      });
      setPluginCommandsState({
        kind: "success",
        message:
          hostedCommands.length === 0
            ? "No plugin commands available."
            : `Loaded ${hostedCommands.length} plugin commands.`,
      });
    } catch (error) {
      setPluginPanelsBySlot(EMPTY_PLUGIN_PANELS);
      setPluginCommands([]);
      setPluginPanelsState({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed loading plugin panels.",
      });
      setPluginCommandsState({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed loading plugin commands.",
      });
    }
  }, []);

  const refreshProposalReview = useCallback(async (): Promise<void> => {
    const targetNoteId = noteId;
    if (!targetNoteId) {
      setProposalReviewContexts([]);
      setProposalReviewState({
        kind: "idle",
        message: "Select a saved note to inspect proposal context.",
      });
      return;
    }

    setProposalReviewState({
      kind: "saving",
      message: `Loading proposal context for ${targetNoteId.slice(0, 8)}...`,
    });

    try {
      const [proposalResponse, noteResponse] = await Promise.all([
        fetch(`${API_BASE_URL}/proposals?status=open`),
        fetch(`${API_BASE_URL}/notes/${targetNoteId}`),
      ]);

      if (!proposalResponse.ok) {
        throw new Error(`Failed loading proposals (${proposalResponse.status})`);
      }
      if (!noteResponse.ok) {
        throw new Error(`Failed loading note context (${noteResponse.status})`);
      }

      const proposalPayload = (await proposalResponse.json()) as ProposalSourceRecord[];
      const notePayload = (await noteResponse.json()) as CanonicalNoteResponse;
      const openProposals = proposalPayload
        .filter((record) => {
          return (
            record.proposal.status === "open" && record.proposal.target.noteId === targetNoteId
          );
        })
        .sort((left, right) => left.proposal.id.localeCompare(right.proposal.id));

      if (openProposals.length === 0) {
        if (noteIdRef.current !== targetNoteId) {
          return;
        }

        setProposalReviewContexts([]);
        setProposalReviewState({
          kind: "success",
          message: "No open proposals for this note.",
        });
        return;
      }

      const proposalContexts = openProposals.map((record) => {
        const sectionContext = extractSectionContext(
          notePayload,
          record.proposal.target.sectionId,
          record.proposal.target.fallbackPath,
        );
        const references = collectProposalEntityReferences({
          sectionContext,
          proposalContent: record.content,
        });

        return {
          proposalId: record.proposal.id,
          proposalType: record.proposal.proposalType,
          sectionId: record.proposal.target.sectionId,
          fallbackPath: record.proposal.target.fallbackPath ?? [],
          sectionContext,
          references,
        };
      });

      const uniqueReferences = new Map<string, ProposalEntityReference>();
      for (const proposalContext of proposalContexts) {
        for (const reference of proposalContext.references) {
          uniqueReferences.set(proposalEntityReferenceKey(reference), reference);
        }
      }

      const contextByEntityKey = new Map<string, ProposalReviewEntityContext>();
      await Promise.all(
        [...uniqueReferences.values()].map(async (reference) => {
          const key = proposalEntityReferenceKey(reference);
          const referenceLabel = formatEntityReferenceLabel(reference);

          try {
            const response = await fetch(
              `${API_BASE_URL}/entities/${encodeURIComponent(reference.namespace)}/${encodeURIComponent(reference.entityType)}/${encodeURIComponent(reference.entityId)}`,
            );

            if (response.status === 404) {
              contextByEntityKey.set(key, {
                reference,
                summary: `${referenceLabel} (missing entity)`,
                unresolved: true,
              });
              return;
            }

            if (!response.ok) {
              contextByEntityKey.set(key, {
                reference,
                summary: `${referenceLabel} (entity lookup failed: ${response.status})`,
                unresolved: true,
              });
              return;
            }

            const payload = (await response.json()) as ProposalEntityLookupResponse;
            const entityData = payload.entity?.data;
            if (!entityData || typeof entityData !== "object") {
              contextByEntityKey.set(key, {
                reference,
                summary: `${referenceLabel} (entity payload missing data)`,
                unresolved: true,
              });
              return;
            }

            contextByEntityKey.set(key, {
              reference,
              summary: summarizeEntityContext(reference, entityData),
              unresolved: false,
            });
          } catch {
            contextByEntityKey.set(key, {
              reference,
              summary: `${referenceLabel} (entity lookup failed)`,
              unresolved: true,
            });
          }
        }),
      );

      if (noteIdRef.current !== targetNoteId) {
        return;
      }

      const hydratedContexts: ProposalReviewContext[] = proposalContexts.map((proposalContext) => {
        const entities = proposalContext.references.map((reference) => {
          return (
            contextByEntityKey.get(proposalEntityReferenceKey(reference)) ?? {
              reference,
              summary: `${formatEntityReferenceLabel(reference)} (entity context unavailable)`,
              unresolved: true,
            }
          );
        });

        return {
          proposalId: proposalContext.proposalId,
          proposalType: proposalContext.proposalType,
          sectionId: proposalContext.sectionId,
          fallbackPath: proposalContext.fallbackPath,
          sectionContext: proposalContext.sectionContext,
          entities,
        };
      });

      setProposalReviewContexts(hydratedContexts);
      setProposalReviewState({
        kind: "success",
        message: `Loaded context for ${hydratedContexts.length} open proposal${hydratedContexts.length === 1 ? "" : "s"}.`,
      });
    } catch (error) {
      if (noteIdRef.current !== targetNoteId) {
        return;
      }

      setProposalReviewContexts([]);
      setProposalReviewState({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed loading proposal context.",
      });
    }
  }, [noteId]);

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
        await refreshPluginPanels();
      } catch (error) {
        setStoreRootState({
          kind: "error",
          message: error instanceof Error ? error.message : "Failed updating store root.",
        });
      }
    },
    [refreshNotes, refreshPluginPanels],
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
    void refreshPluginPanels();
  }, [refreshPluginPanels]);

  useEffect(() => {
    void refreshProposalReview();
  }, [refreshProposalReview]);

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

  const runPluginCommand = useCallback(
    async (command: HostedPluginCommand): Promise<void> => {
      const commandKey = `${command.namespace}:${command.actionId}`;
      if (!command.allowed) {
        setPluginCommandsState({
          kind: "error",
          message: `Command ${command.namespace}/${command.actionId} blocked: missing permissions ${command.missingPermissions.join(", ")}`,
        });
        return;
      }

      setRunningPluginCommandKey(commandKey);
      setPluginCommandsState({
        kind: "saving",
        message: `Running ${command.namespace}/${command.actionId}...`,
      });

      try {
        const response = await fetch(
          `${API_BASE_URL}/plugins/${command.namespace}/actions/${command.actionId}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify(
              buildPluginCommandInvocationPayload({
                noteId,
                title,
                tags: parsedTags,
                plainText: lexicalStateToPlainText(editorState),
              }),
            ),
          },
        );

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(
            payload?.error?.message ??
              `Command failed (${response.status}) for ${command.namespace}/${command.actionId}`,
          );
        }

        const payload = (await response.json()) as {
          requestId?: string;
        };
        setPluginCommandsState({
          kind: "success",
          message: `Ran ${command.namespace}/${command.actionId}${payload.requestId ? ` (${payload.requestId.slice(0, 8)})` : ""}`,
        });
        await Promise.all([refreshNotes(), refreshProposalReview()]);
      } catch (error) {
        setPluginCommandsState({
          kind: "error",
          message: error instanceof Error ? error.message : "Plugin command failed.",
        });
      } finally {
        setRunningPluginCommandKey(null);
      }
    },
    [editorState, noteId, parsedTags, refreshNotes, refreshProposalReview, title],
  );

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

          <div className="plugin-slot plugin-slot-sidebar" aria-label="Plugin sidebar panels">
            <div className="panel-tree-head">
              <p>Plugin Sidebar Panels</p>
            </div>
            <p className="panel-meta-line panel-meta-line-muted">{pluginPanelsState.message}</p>
            {pluginPanelsBySlot.sidebar.length === 0 ? (
              <p className="panel-empty">No sidebar plugin panels.</p>
            ) : (
              <ul className="plugin-panel-list" aria-label="Sidebar plugin panels">
                {pluginPanelsBySlot.sidebar.map((panel) => (
                  <li key={`${panel.namespace}:${panel.panelId}`} className="plugin-panel-card">
                    <p>
                      {panel.namespace}/{panel.panelId}
                    </p>
                    <strong>{panel.title}</strong>
                    <span>Isolated declarative panel (runtime disabled)</span>
                    {panel.requiredPermissions.length > 0 ? (
                      <span>Permissions: {panel.requiredPermissions.join(", ")}</span>
                    ) : (
                      <span>Permissions: none declared</span>
                    )}
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

                <div className="plugin-toolbar-slot" aria-label="Plugin toolbar panels">
                  {pluginPanelsBySlot.toolbar.length === 0 ? (
                    <p>No toolbar plugin panels.</p>
                  ) : (
                    pluginPanelsBySlot.toolbar.map((panel) => (
                      <div
                        key={`${panel.namespace}:${panel.panelId}`}
                        className="plugin-toolbar-chip"
                        title={`Isolated declarative panel for ${panel.namespace}/${panel.panelId}`}
                      >
                        <span>{panel.title}</span>
                        <small>{panel.namespace}</small>
                      </div>
                    ))
                  )}
                </div>
              </header>

              <section className="plugin-command-surface" aria-label="Plugin commands">
                <header>
                  <h2>Plugin Commands</h2>
                  <p>{pluginCommandsState.message}</p>
                </header>
                {pluginCommands.length === 0 ? (
                  <p className="plugin-command-empty">No plugin commands.</p>
                ) : (
                  <ul className="plugin-command-list">
                    {pluginCommands.map((command) => {
                      const commandKey = `${command.namespace}:${command.actionId}`;
                      const disabled =
                        !command.allowed ||
                        runningPluginCommandKey === commandKey ||
                        pluginCommandsState.kind === "saving";

                      return (
                        <li key={commandKey}>
                          <Button
                            type="button"
                            size="sm"
                            variant={command.allowed ? "subtle" : "ghost"}
                            disabled={disabled}
                            onClick={() => void runPluginCommand(command)}
                          >
                            {command.title}
                          </Button>
                          <span>
                            {command.namespace}/{command.actionId}
                          </span>
                          {command.allowed ? (
                            <small>allowed</small>
                          ) : (
                            <small>blocked: {command.missingPermissions.join(", ")}</small>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <main className="canvas" aria-label="Writing canvas">
                <div className="canvas-frame">
                  <EditorSurface
                    editorKey={editorSeed}
                    initialState={editorInitialState}
                    onStateChange={setEditorState}
                  />
                </div>

                <section className="proposal-plugin-slot" aria-label="Proposal review panels">
                  <header>
                    <h2>Proposal Review Panels</h2>
                    <p>Entity context is resolved from open proposals and plugin entities.</p>
                  </header>
                  <section
                    className="proposal-review-context"
                    aria-label="Entity-aware proposal context"
                  >
                    <header>
                      <h3>Entity-Aware Context</h3>
                      <p>{proposalReviewState.message}</p>
                    </header>
                    {proposalReviewContexts.length === 0 ? (
                      <p className="proposal-review-empty">
                        No entity-aware proposal context for this note.
                      </p>
                    ) : (
                      <ul className="proposal-review-list">
                        {proposalReviewContexts.map((proposalContext) => (
                          <li key={proposalContext.proposalId} className="proposal-review-card">
                            <div className="proposal-review-card-head">
                              <strong>{proposalContext.proposalId}</strong>
                              <span>{proposalContext.proposalType}</span>
                            </div>
                            <p className="proposal-review-target">
                              section <code>{proposalContext.sectionId}</code>
                              {proposalContext.fallbackPath.length > 0
                                ? ` (${proposalContext.fallbackPath.join(" > ")})`
                                : ""}
                            </p>
                            <p className="proposal-review-section">
                              {proposalContext.sectionContext ?? "Section context unavailable."}
                            </p>
                            {proposalContext.entities.length === 0 ? (
                              <p className="proposal-review-entity-empty">
                                No person/meeting references found in proposal or section context.
                              </p>
                            ) : (
                              <ul className="proposal-review-entities">
                                {proposalContext.entities.map((entityContext) => (
                                  <li
                                    key={proposalEntityReferenceKey(entityContext.reference)}
                                    className={
                                      entityContext.unresolved
                                        ? "proposal-review-entity proposal-review-entity-unresolved"
                                        : "proposal-review-entity"
                                    }
                                  >
                                    <code>
                                      {formatEntityReferenceLabel(entityContext.reference)}
                                    </code>
                                    <span>{entityContext.summary}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                  {pluginPanelsBySlot.proposalReview.length === 0 ? (
                    <p>No proposal-review plugin panels.</p>
                  ) : (
                    <ul className="proposal-plugin-list">
                      {pluginPanelsBySlot.proposalReview.map((panel) => (
                        <li key={`${panel.namespace}:${panel.panelId}`}>
                          <strong>{panel.title}</strong>
                          <span>
                            {panel.namespace}/{panel.panelId}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
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
    </div>
  );
}
