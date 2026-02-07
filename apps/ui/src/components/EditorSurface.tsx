import { type InitialConfigType, LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import type { EditorState } from "lexical";
import { $getRoot } from "lexical";
import { useCallback, useState } from "react";

const initialConfig: InitialConfigType = {
  namespace: "rem-editor",
  onError(error: Error) {
    throw error;
  },
  theme: {
    paragraph: "editor-paragraph",
    text: {
      bold: "editor-bold",
      italic: "editor-italic",
      underline: "editor-underline",
    },
  },
};

export function EditorSurface() {
  const [characterCount, setCharacterCount] = useState(0);

  const handleEditorChange = useCallback((editorState: EditorState) => {
    editorState.read(() => {
      const text = $getRoot().getTextContent();
      setCharacterCount(text.trim().length);
    });
  }, []);

  return (
    <div className="editor-shell">
      <LexicalComposer initialConfig={initialConfig}>
        <div className="editor-surface">
          <RichTextPlugin
            contentEditable={<ContentEditable className="editor-input" />}
            placeholder={
              <p className="editor-placeholder">
                Capture a thought, meeting note, or task context...
              </p>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <OnChangePlugin onChange={handleEditorChange} />
        </div>
      </LexicalComposer>
      <footer className="editor-footer">
        <span>{characterCount} characters</span>
        <button className="editor-button" type="button">
          Save Draft
        </button>
      </footer>
    </div>
  );
}
