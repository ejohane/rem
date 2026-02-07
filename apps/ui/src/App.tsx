import { useCallback, useEffect, useMemo, useState } from "react";

import { AutoFocusPlugin } from "@lexical/react/LexicalAutoFocusPlugin";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";

import { defaultEditorPlugins } from "./editor-plugins";
import {
  type LexicalStateLike,
  lexicalStateToPlainText,
  parseTags,
  plainTextToLexicalState,
} from "./lexical";
import { type CanonicalNoteRecord, extractSectionContext } from "./proposals";

const API_BASE_URL = import.meta.env.VITE_REM_API_BASE_URL ?? "http://127.0.0.1:8787";

const commandDeck = [
  { label: "CLI save", command: "rem notes save --input note.json --json" },
  { label: "CLI drafts", command: "rem drafts list --json" },
  { label: "API save", command: "POST /notes, PUT /notes/:id" },
  { label: "API drafts", command: "POST /drafts, GET /drafts/:id" },
  {
    label: "Search facets",
    command: "GET /search?q=...&tags=...&noteTypes=...&pluginNamespaces=...&createdSince=...",
  },
  { label: "Review proposals", command: "GET /proposals?status=open" },
  { label: "Accept proposal", command: "POST /proposals/:id/accept" },
  { label: "Migrate sections", command: "POST /migrations/sections" },
];

type SaveState =
  | { kind: "idle"; message: string }
  | { kind: "saving"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

type SaveNoteResponse = {
  noteId: string;
  created: boolean;
  meta: {
    updatedAt: string;
  };
};

type SaveDraftResponse = {
  draftId: string;
  created: boolean;
  meta: {
    updatedAt: string;
  };
};

type DraftSummary = {
  id: string;
  title: string;
  updatedAt: string;
  tags: string[];
};

type DraftRecord = {
  draftId: string;
  lexicalState: LexicalStateLike;
  meta: {
    title: string;
    tags: string[];
  };
};

type ProposalRecord = {
  proposal: {
    id: string;
    status: "open" | "accepted" | "rejected" | "superseded";
    createdAt: string;
    updatedAt: string;
    proposalType: "replace_section" | "annotate";
    target: {
      noteId: string;
      sectionId: string;
      fallbackPath?: string[];
    };
    rationale?: string;
  };
  content: {
    format: "lexical" | "text" | "json";
    content: unknown;
  };
  meta: {
    source?: string;
  };
};

type ProposalActionState =
  | { kind: "idle"; message: string }
  | { kind: "loading"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

type SectionContextState =
  | { kind: "idle"; message: string; content: string }
  | { kind: "loading"; message: string; content: string }
  | { kind: "success"; message: string; content: string }
  | { kind: "error"; message: string; content: string };

function formatProposalContent(record: ProposalRecord): string {
  if (record.content.format === "text") {
    return String(record.content.content);
  }

  return JSON.stringify(record.content.content, null, 2);
}

type IconName =
  | "panel"
  | "panelClose"
  | "draft"
  | "save"
  | "close"
  | "refresh"
  | "accept"
  | "reject";

function Icon(props: { name: IconName }): React.JSX.Element {
  switch (props.name) {
    case "panel":
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      );
    case "panelClose":
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      );
    case "draft":
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 4h12v16H6z" />
          <path d="M9 4v5h6V4M9 13h6M9 16h6" />
        </svg>
      );
    case "save":
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4v10M8 10l4 4 4-4M5 18h14" />
        </svg>
      );
    case "close":
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      );
    case "refresh":
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20 11a8 8 0 1 0 2 5" />
          <path d="M20 4v7h-7" />
        </svg>
      );
    case "accept":
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12l5 5 9-10" />
        </svg>
      );
    case "reject":
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      );
  }
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
  const [draftId, setDraftId] = useState<string | null>(null);
  const [title, setTitle] = useState("Untitled Draft");
  const [tagsInput, setTagsInput] = useState("daily, scratchpad");
  const [editorSeed, setEditorSeed] = useState(0);
  const [editorInitialState, setEditorInitialState] =
    useState<LexicalStateLike>(defaultEditorState);
  const [editorState, setEditorState] = useState<LexicalStateLike>(defaultEditorState);
  const [saveState, setSaveState] = useState<SaveState>({
    kind: "idle",
    message: "Not saved yet.",
  });
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [draftState, setDraftState] = useState<SaveState>({
    kind: "idle",
    message: "No draft action yet.",
  });
  const [isPanelOpen, setIsPanelOpen] = useState(false);

  const [proposals, setProposals] = useState<ProposalRecord[]>([]);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [proposalState, setProposalState] = useState<ProposalActionState>({
    kind: "idle",
    message: "No review action yet.",
  });
  const [sectionContext, setSectionContext] = useState<SectionContextState>({
    kind: "idle",
    message: "Select a proposal to view current section context.",
    content: "",
  });

  const parsedTags = useMemo(() => parseTags(tagsInput), [tagsInput]);
  const editorPlainText = useMemo(() => lexicalStateToPlainText(editorState), [editorState]);
  const selectedProposal = useMemo(
    () => proposals.find((proposal) => proposal.proposal.id === selectedProposalId) ?? null,
    [proposals, selectedProposalId],
  );

  const dayStamp = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      }).format(new Date()),
    [],
  );

  const pluginOutputs = useMemo(
    () =>
      defaultEditorPlugins.map((plugin) => ({
        id: plugin.id,
        title: plugin.title,
        value: plugin.render({
          plainText: editorPlainText,
          tags: parsedTags,
          noteId,
          draftId,
        }),
      })),
    [editorPlainText, parsedTags, noteId, draftId],
  );

  const isSaving = saveState.kind === "saving";
  const isDraftSaving = draftState.kind === "saving";
  const isReviewBusy = proposalState.kind === "loading";

  const refreshProposals = useCallback(async (): Promise<void> => {
    setProposalState({ kind: "loading", message: "Refreshing proposal inbox..." });

    try {
      const response = await fetch(`${API_BASE_URL}/proposals?status=open`);
      if (!response.ok) {
        throw new Error(`Failed loading proposals (${response.status})`);
      }

      const payload = (await response.json()) as ProposalRecord[];
      setProposals(payload);

      setSelectedProposalId((current) =>
        current && payload.some((proposal) => proposal.proposal.id === current)
          ? current
          : (payload[0]?.proposal.id ?? null),
      );

      setProposalState({
        kind: "success",
        message:
          payload.length === 0 ? "No open proposals." : `Loaded ${payload.length} open proposals.`,
      });
    } catch (error) {
      setProposalState({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed loading proposals.",
      });
    }
  }, []);

  const refreshDrafts = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`${API_BASE_URL}/drafts?limit=20`);
      if (!response.ok) {
        throw new Error(`Failed loading drafts (${response.status})`);
      }

      const payload = (await response.json()) as DraftSummary[];
      setDrafts(payload);
      setDraftState({
        kind: "success",
        message: payload.length === 0 ? "No stored drafts." : `Loaded ${payload.length} drafts.`,
      });
    } catch (error) {
      setDraftState({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed loading drafts.",
      });
    }
  }, []);

  useEffect(() => {
    void refreshProposals();
    void refreshDrafts();
  }, [refreshProposals, refreshDrafts]);

  useEffect(() => {
    if (!selectedProposal) {
      setSectionContext({
        kind: "idle",
        message: "Select a proposal to view current section context.",
        content: "",
      });
      return;
    }

    const controller = new AbortController();

    const loadSectionContext = async (): Promise<void> => {
      setSectionContext({
        kind: "loading",
        message: "Loading current section context...",
        content: "",
      });

      try {
        const response = await fetch(
          `${API_BASE_URL}/notes/${selectedProposal.proposal.target.noteId}`,
          {
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          throw new Error(`Failed loading target note (${response.status})`);
        }

        const note = (await response.json()) as CanonicalNoteRecord;
        const context = extractSectionContext(
          note,
          selectedProposal.proposal.target.sectionId,
          selectedProposal.proposal.target.fallbackPath,
        );

        if (!context) {
          setSectionContext({
            kind: "error",
            message: "Unable to resolve target section in current note revision.",
            content: "",
          });
          return;
        }

        setSectionContext({
          kind: "success",
          message: "Loaded current section context.",
          content: context,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        setSectionContext({
          kind: "error",
          message: error instanceof Error ? error.message : "Failed loading section context.",
          content: "",
        });
      }
    };

    void loadSectionContext();

    return () => {
      controller.abort();
    };
  }, [selectedProposal]);

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

  async function saveNote(): Promise<void> {
    const normalizedTitle = title.trim();
    const normalizedBody = editorPlainText.trim();

    if (!normalizedTitle && !normalizedBody) {
      setSaveState({
        kind: "error",
        message: "Add a title or note content before saving.",
      });
      return;
    }

    setSaveState({ kind: "saving", message: "Saving through Core..." });

    try {
      const isUpdate = Boolean(noteId);
      const response = await fetch(
        isUpdate ? `${API_BASE_URL}/notes/${noteId}` : `${API_BASE_URL}/notes`,
        {
          method: isUpdate ? "PUT" : "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            title: normalizedTitle || "Untitled Draft",
            noteType: "note",
            lexicalState: editorState,
            tags: parsedTags,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`Save failed with status ${response.status}`);
      }

      const payload = (await response.json()) as SaveNoteResponse;
      setNoteId(payload.noteId);

      const actionLabel = payload.created ? "Created" : "Updated";
      const savedAt = new Date(payload.meta.updatedAt).toLocaleTimeString();

      setSaveState({
        kind: "success",
        message: `${actionLabel} note ${payload.noteId.slice(0, 8)} at ${savedAt}.`,
      });

      await refreshProposals();
      await refreshDrafts();
    } catch (error) {
      setSaveState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Save failed. Check that API is running on localhost.",
      });
    }
  }

  async function saveDraftObject(): Promise<void> {
    const normalizedTitle = title.trim();
    const normalizedBody = editorPlainText.trim();

    if (!normalizedTitle && !normalizedBody) {
      setDraftState({
        kind: "error",
        message: "Add a title or note content before saving a draft.",
      });
      return;
    }

    setDraftState({ kind: "saving", message: "Saving draft object..." });

    try {
      const response = await fetch(`${API_BASE_URL}/drafts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: draftId ?? undefined,
          title: normalizedTitle || "Untitled Draft",
          lexicalState: editorState,
          tags: parsedTags,
          author: { kind: "human", id: "ui-author" },
        }),
      });

      if (!response.ok) {
        throw new Error(`Draft save failed with status ${response.status}`);
      }

      const payload = (await response.json()) as SaveDraftResponse;
      setDraftId(payload.draftId);

      const actionLabel = payload.created ? "Created" : "Updated";
      const savedAt = new Date(payload.meta.updatedAt).toLocaleTimeString();
      setDraftState({
        kind: "success",
        message: `${actionLabel} draft ${payload.draftId.slice(0, 8)} at ${savedAt}.`,
      });

      await refreshDrafts();
    } catch (error) {
      setDraftState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Draft save failed. Check that API is running on localhost.",
      });
    }
  }

  async function openDraft(targetDraftId: string): Promise<void> {
    setDraftState({ kind: "saving", message: `Loading draft ${targetDraftId.slice(0, 8)}...` });

    try {
      const response = await fetch(`${API_BASE_URL}/drafts/${targetDraftId}`);
      if (!response.ok) {
        throw new Error(`Failed loading draft (${response.status})`);
      }

      const payload = (await response.json()) as DraftRecord;

      setDraftId(payload.draftId);
      setTitle(payload.meta.title || "Untitled Draft");
      setTagsInput(payload.meta.tags.join(", "));
      setEditorInitialState(payload.lexicalState);
      setEditorState(payload.lexicalState);
      setEditorSeed((current) => current + 1);
      setDraftState({
        kind: "success",
        message: `Loaded draft ${payload.draftId.slice(0, 8)}.`,
      });
    } catch (error) {
      setDraftState({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed loading draft.",
      });
    }
  }

  async function reviewProposal(action: "accept" | "reject"): Promise<void> {
    if (!selectedProposal) {
      setProposalState({ kind: "error", message: "Select a proposal first." });
      return;
    }

    const endpoint = `${API_BASE_URL}/proposals/${selectedProposal.proposal.id}/${action}`;
    setProposalState({
      kind: "loading",
      message: `${action === "accept" ? "Accepting" : "Rejecting"} proposal...`,
    });

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          actor: { kind: "human", id: "ui-reviewer" },
        }),
      });

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(
          errorBody?.error?.message ?? `Proposal ${action} failed (${response.status})`,
        );
      }

      await refreshProposals();
      setProposalState({
        kind: "success",
        message: `${action === "accept" ? "Accepted" : "Rejected"} proposal ${selectedProposal.proposal.id.slice(0, 8)}.`,
      });
    } catch (error) {
      setProposalState({
        kind: "error",
        message: error instanceof Error ? error.message : `Failed to ${action} proposal.`,
      });
    }
  }

  return (
    <div className="app-shell">
      <div className={`workspace ${isPanelOpen ? "workspace-panel-open" : ""}`}>
        <aside id="workspace-panel" className="side-panel" aria-hidden={!isPanelOpen}>
          <div className="panel-headline">
            <p>Workspace</p>
            <button
              type="button"
              className="icon-button icon-only"
              aria-label="Close panel"
              title="Close panel"
              onClick={() => setIsPanelOpen(false)}
            >
              <Icon name="close" />
            </button>
          </div>

          <section className="panel-group">
            <p className="panel-label">Metadata</p>
            <label className="field">
              <span>Title</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.currentTarget.value)}
                placeholder="Untitled Draft"
              />
            </label>

            <label className="field">
              <span>Tags</span>
              <input
                value={tagsInput}
                onChange={(event) => setTagsInput(event.currentTarget.value)}
                placeholder="daily, scratchpad"
              />
            </label>

            <div className="panel-actions">
              <button
                type="button"
                className="ghost-button icon-only"
                onClick={() => void saveDraftObject()}
                disabled={isDraftSaving}
                aria-label={isDraftSaving ? "Saving draft" : "Save draft"}
                title={isDraftSaving ? "Saving draft" : "Save draft"}
              >
                <Icon name="draft" />
              </button>
              <button
                type="button"
                className="solid-button icon-only"
                onClick={() => void saveNote()}
                disabled={isSaving}
                aria-label={isSaving ? "Saving note" : "Save note"}
                title={isSaving ? "Saving note" : "Save note"}
              >
                <Icon name="save" />
              </button>
            </div>

            <p className={`save-state save-state-${saveState.kind}`}>{saveState.message}</p>
            <p className={`save-state save-state-${draftState.kind}`}>{draftState.message}</p>
          </section>

          <section className="panel-group">
            <div className="panel-row">
              <p className="panel-label">Drafts</p>
              <button
                type="button"
                className="ghost-button small icon-only"
                aria-label="Refresh drafts"
                title="Refresh drafts"
                onClick={() => void refreshDrafts()}
              >
                <Icon name="refresh" />
              </button>
            </div>

            {drafts.length === 0 ? (
              <p className="panel-empty">No saved drafts yet.</p>
            ) : (
              <ul className="stack-list">
                {drafts.map((draft) => (
                  <li key={draft.id}>
                    <button
                      type="button"
                      className={`stack-button ${draft.id === draftId ? "stack-button-selected" : ""}`}
                      onClick={() => void openDraft(draft.id)}
                    >
                      <strong>{draft.id.slice(0, 8)}</strong>
                      <span>{draft.title || "(untitled)"}</span>
                      <span>{new Date(draft.updatedAt).toLocaleTimeString()}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel-group">
            <div className="panel-row">
              <p className="panel-label">Proposal Inbox</p>
              <button
                type="button"
                className="ghost-button small icon-only"
                aria-label="Refresh proposals"
                title="Refresh proposals"
                onClick={() => void refreshProposals()}
              >
                <Icon name="refresh" />
              </button>
            </div>

            {proposals.length === 0 ? (
              <p className="panel-empty">No open proposals.</p>
            ) : (
              <ul className="stack-list">
                {proposals.map((proposal) => {
                  const isSelected = proposal.proposal.id === selectedProposal?.proposal.id;

                  return (
                    <li key={proposal.proposal.id}>
                      <button
                        type="button"
                        className={`stack-button ${isSelected ? "stack-button-selected" : ""}`}
                        onClick={() => setSelectedProposalId(proposal.proposal.id)}
                      >
                        <strong>{proposal.proposal.id.slice(0, 8)}</strong>
                        <span>{proposal.proposal.target.noteId.slice(0, 8)}</span>
                        <span>{proposal.proposal.proposalType}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {selectedProposal ? (
              <div className="proposal-detail">
                <p>
                  <strong>ID</strong> <code>{selectedProposal.proposal.id}</code>
                </p>
                <p>
                  <strong>Target</strong> {selectedProposal.proposal.target.noteId} /{" "}
                  {selectedProposal.proposal.target.sectionId}
                </p>
                <p>
                  <strong>Fallback</strong>{" "}
                  {selectedProposal.proposal.target.fallbackPath?.join(" > ") ?? "(none)"}
                </p>
                <p>
                  <strong>Rationale</strong> {selectedProposal.proposal.rationale ?? "(none)"}
                </p>
                <p>
                  <strong>Current section context</strong>
                </p>
                <pre>
                  {sectionContext.content ||
                    (sectionContext.kind === "loading"
                      ? "Loading current section context..."
                      : sectionContext.message)}
                </pre>
                <p>
                  <strong>Proposed content ({selectedProposal.content.format})</strong>
                </p>
                <pre>{formatProposalContent(selectedProposal)}</pre>

                <div className="proposal-actions">
                  <button
                    type="button"
                    className="solid-button icon-only"
                    disabled={isReviewBusy}
                    aria-label="Accept proposal"
                    title="Accept proposal"
                    onClick={() => void reviewProposal("accept")}
                  >
                    <Icon name="accept" />
                  </button>
                  <button
                    type="button"
                    className="ghost-button icon-only"
                    disabled={isReviewBusy}
                    aria-label="Reject proposal"
                    title="Reject proposal"
                    onClick={() => void reviewProposal("reject")}
                  >
                    <Icon name="reject" />
                  </button>
                </div>
              </div>
            ) : null}

            <p className={`save-state save-state-${proposalState.kind}`}>{proposalState.message}</p>
          </section>

          <section className="panel-group" aria-label="plugin host">
            <p className="panel-label">Plugin host</p>
            <ul className="plugin-list">
              {pluginOutputs.map((plugin) => (
                <li key={plugin.id}>
                  <strong>{plugin.title}</strong>
                  <span>{plugin.value}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel-group">
            <p className="panel-label">Service surface</p>
            <ul className="command-list">
              {commandDeck.map((item) => (
                <li key={item.command}>
                  <p>{item.label}</p>
                  <code>{item.command}</code>
                </li>
              ))}
            </ul>
          </section>
        </aside>

        <div className="main-column">
          <header className="topbar">
            <div className="topbar-left">
              <button
                type="button"
                className="menu-toggle icon-only"
                aria-label={isPanelOpen ? "Hide panel" : "Show panel"}
                title={isPanelOpen ? "Hide panel" : "Show panel"}
                aria-expanded={isPanelOpen}
                aria-controls="workspace-panel"
                onClick={() => setIsPanelOpen((current) => !current)}
              >
                <Icon name={isPanelOpen ? "panelClose" : "panel"} />
              </button>

              <div className="meta-block">
                <input
                  className="meta-title-input"
                  value={title}
                  onChange={(event) => setTitle(event.currentTarget.value)}
                  placeholder="Untitled note"
                  aria-label="Note title"
                />
                <p className="meta-line">
                  <span>{dayStamp}</span>
                </p>
              </div>
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
        </div>
      </div>
    </div>
  );
}
