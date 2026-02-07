import { useCallback, useEffect, useMemo, useState } from "react";

import { parseTags, plainTextToLexicalState } from "./lexical";

const API_BASE_URL = import.meta.env.VITE_REM_API_BASE_URL ?? "http://127.0.0.1:8787";

const commandDeck = [
  { label: "CLI save", command: "rem notes save --input note.json --json" },
  { label: "CLI drafts", command: "rem drafts list --json" },
  { label: "API save", command: "POST /notes" },
  { label: "API drafts", command: "POST /drafts, GET /drafts/:id" },
  { label: "Review proposals", command: "GET /proposals?status=open" },
  { label: "Accept proposal", command: "POST /proposals/:id/accept" },
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
  lexicalState: {
    root?: {
      children?: Array<{
        children?: Array<{
          text?: string;
        }>;
      }>;
    };
  };
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

function formatProposalContent(record: ProposalRecord): string {
  if (record.content.format === "text") {
    return String(record.content.content);
  }

  return JSON.stringify(record.content.content, null, 2);
}

export function App() {
  const [noteId, setNoteId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [title, setTitle] = useState("Untitled Draft");
  const [body, setBody] = useState("Capture your note here.");
  const [tagsInput, setTagsInput] = useState("daily, scratchpad");
  const [saveState, setSaveState] = useState<SaveState>({
    kind: "idle",
    message: "Not saved yet.",
  });
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [draftState, setDraftState] = useState<SaveState>({
    kind: "idle",
    message: "No draft action yet.",
  });

  const [proposals, setProposals] = useState<ProposalRecord[]>([]);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [proposalState, setProposalState] = useState<ProposalActionState>({
    kind: "idle",
    message: "No review action yet.",
  });

  const parsedTags = useMemo(() => parseTags(tagsInput), [tagsInput]);
  const selectedProposal = useMemo(
    () => proposals.find((proposal) => proposal.proposal.id === selectedProposalId) ?? null,
    [proposals, selectedProposalId],
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

  async function saveNote(): Promise<void> {
    const normalizedTitle = title.trim();
    const normalizedBody = body.trim();

    if (!normalizedTitle && !normalizedBody) {
      setSaveState({
        kind: "error",
        message: "Add a title or note content before saving.",
      });
      return;
    }

    setSaveState({ kind: "saving", message: "Saving through Core..." });

    try {
      const response = await fetch(`${API_BASE_URL}/notes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: noteId ?? undefined,
          title: normalizedTitle || "Untitled Draft",
          lexicalState: plainTextToLexicalState(body),
          tags: parsedTags,
        }),
      });

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
    const normalizedBody = body.trim();

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
          lexicalState: plainTextToLexicalState(body),
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
      const textBody = payload.lexicalState.root?.children
        ?.map((paragraph) =>
          paragraph.children
            ?.map((child) => child.text ?? "")
            .join("")
            .trim(),
        )
        .filter((line): line is string => Boolean(line))
        .join("\n");

      setDraftId(payload.draftId);
      setTitle(payload.meta.title || "Untitled Draft");
      setTagsInput(payload.meta.tags.join(", "));
      setBody(textBody || "");
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
      <div className="orb orb-sun" aria-hidden />
      <div className="orb orb-mint" aria-hidden />

      <header className="hero">
        <p className="hero-kicker">rem / local-first human ↔ agent memory</p>
        <h1>Editor Console</h1>
        <p className="hero-copy">
          Draft text in the UI, then save through Core to canonical files and append-only events.
        </p>
      </header>

      <main className="dashboard" aria-label="rem UI shell">
        <section className="panel panel-editor">
          <div className="panel-head">
            <h2>Draft Editor</h2>
            <span className="chip">core write path</span>
          </div>

          <label className="field">
            <span>Title</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
              placeholder="Weekly planning"
            />
          </label>

          <label className="field">
            <span>Tags (comma-separated)</span>
            <input
              value={tagsInput}
              onChange={(event) => setTagsInput(event.currentTarget.value)}
              placeholder="planning, sprint"
            />
          </label>

          <label className="field">
            <span>Body</span>
            <textarea
              value={body}
              onChange={(event) => setBody(event.currentTarget.value)}
              rows={10}
              placeholder="Write your draft note..."
            />
          </label>

          <div className="editor-footer">
            <button type="button" onClick={saveNote} disabled={isSaving}>
              {isSaving ? "Saving..." : noteId ? "Save Note Update" : "Save Note"}
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={saveDraftObject}
              disabled={isDraftSaving}
            >
              {isDraftSaving ? "Saving..." : draftId ? "Save Draft Update" : "Save Draft Object"}
            </button>
            <p className={`save-state save-state-${saveState.kind}`}>{saveState.message}</p>
          </div>
          <p className={`save-state save-state-${draftState.kind}`}>{draftState.message}</p>

          <p className="note-meta">
            Note id: <code>{noteId ?? "new note"}</code>
          </p>
          <p className="note-meta">
            Draft id: <code>{draftId ?? "new draft"}</code>
          </p>
          <p className="note-meta">
            Tags payload: <code>{parsedTags.join(", ") || "(none)"}</code>
          </p>

          <div className="proposal-head-actions">
            <p className="proposal-caption">Draft inbox</p>
            <button type="button" className="ghost-button" onClick={() => void refreshDrafts()}>
              Refresh drafts
            </button>
          </div>
          {drafts.length === 0 ? (
            <p className="proposal-empty">No saved drafts yet.</p>
          ) : (
            <ul className="proposal-list">
              {drafts.map((draft) => (
                <li key={draft.id}>
                  <button
                    type="button"
                    className={`proposal-item ${draft.id === draftId ? "proposal-item-selected" : ""}`}
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

        <section className="panel panel-command">
          <div className="panel-head">
            <h2>Service Surface</h2>
            <span className="chip">localhost api</span>
          </div>
          <ul className="command-list">
            {commandDeck.map((item) => (
              <li key={item.command}>
                <p>{item.label}</p>
                <code>{item.command}</code>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel panel-proposals">
          <div className="panel-head">
            <h2>Proposal Inbox</h2>
            <div className="proposal-head-actions">
              <span className="chip">open queue</span>
              <button
                type="button"
                className="ghost-button"
                onClick={() => void refreshProposals()}
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="proposal-layout">
            <div>
              <p className="proposal-caption">Open proposals</p>
              {proposals.length === 0 ? (
                <p className="proposal-empty">No open proposals.</p>
              ) : (
                <ul className="proposal-list">
                  {proposals.map((proposal) => {
                    const isSelected = proposal.proposal.id === selectedProposal?.proposal.id;
                    return (
                      <li key={proposal.proposal.id}>
                        <button
                          type="button"
                          className={`proposal-item ${isSelected ? "proposal-item-selected" : ""}`}
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
            </div>

            <div>
              <p className="proposal-caption">Selected proposal</p>
              {selectedProposal ? (
                <div className="proposal-detail">
                  <p>
                    <strong>ID:</strong> <code>{selectedProposal.proposal.id}</code>
                  </p>
                  <p>
                    <strong>Target:</strong> {selectedProposal.proposal.target.noteId} /{" "}
                    {selectedProposal.proposal.target.sectionId}
                  </p>
                  <p>
                    <strong>Fallback:</strong>{" "}
                    {selectedProposal.proposal.target.fallbackPath?.join(" > ") ?? "(none)"}
                  </p>
                  <p>
                    <strong>Rationale:</strong> {selectedProposal.proposal.rationale ?? "(none)"}
                  </p>
                  <p>
                    <strong>Content format:</strong> {selectedProposal.content.format}
                  </p>
                  <pre>{formatProposalContent(selectedProposal)}</pre>

                  <div className="proposal-actions">
                    <button
                      type="button"
                      className="approve"
                      disabled={isReviewBusy}
                      onClick={() => void reviewProposal("accept")}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className="reject"
                      disabled={isReviewBusy}
                      onClick={() => void reviewProposal("reject")}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ) : (
                <p className="proposal-empty">Select a proposal to review.</p>
              )}
            </div>
          </div>

          <p className={`save-state save-state-${proposalState.kind}`}>{proposalState.message}</p>
        </section>
      </main>
    </div>
  );
}
