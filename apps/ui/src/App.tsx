import { useMemo, useState } from "react";

import { parseTags, plainTextToLexicalState } from "./lexical";

const API_BASE_URL = import.meta.env.VITE_REM_API_BASE_URL ?? "http://127.0.0.1:8787";

const commandDeck = [
  { label: "CLI save", command: "rem notes save --input note.json --json" },
  { label: "API save", command: "POST /notes" },
  { label: "Read plain text", command: "GET /notes/:id/text" },
];

const workboardSteps = [
  "Connect UI status/search surfaces to API",
  "Mount Lexical editor primitives",
  "Add proposal review and accept/reject actions",
  "Ship plugin panel and daily-note actions",
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

export function App() {
  const [noteId, setNoteId] = useState<string | null>(null);
  const [title, setTitle] = useState("Untitled Draft");
  const [body, setBody] = useState("Capture your note here.");
  const [tagsInput, setTagsInput] = useState("daily, scratchpad");
  const [saveState, setSaveState] = useState<SaveState>({
    kind: "idle",
    message: "Not saved yet.",
  });

  const parsedTags = useMemo(() => parseTags(tagsInput), [tagsInput]);
  const isSaving = saveState.kind === "saving";

  async function saveDraft(): Promise<void> {
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
            <button type="button" onClick={saveDraft} disabled={isSaving}>
              {isSaving ? "Saving..." : noteId ? "Save Update" : "Save Draft"}
            </button>
            <p className={`save-state save-state-${saveState.kind}`}>{saveState.message}</p>
          </div>

          <p className="note-meta">
            Note id: <code>{noteId ?? "new note"}</code>
          </p>
          <p className="note-meta">
            Tags payload: <code>{parsedTags.join(", ") || "(none)"}</code>
          </p>
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

        <section className="panel panel-workboard">
          <div className="panel-head">
            <h2>Next UI Track</h2>
            <span className="chip">up next</span>
          </div>
          <ol>
            {workboardSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>
      </main>
    </div>
  );
}
