import { EditorSurface } from "./components/EditorSurface";

export function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <p className="app-kicker">rem</p>
        <h1 className="app-title">Local-first memory workspace</h1>
        <p className="app-subtitle">
          Start capturing notes. Agent proposals and retrieval will layer on top of this editor
          surface.
        </p>
      </header>

      <main className="app-main">
        <section className="card">
          <h2 className="card-title">Draft note</h2>
          <EditorSurface />
        </section>
      </main>
    </div>
  );
}
