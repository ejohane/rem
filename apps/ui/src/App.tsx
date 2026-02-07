const commandDeck = [
  { label: "Capture quick note", command: "rem notes save --input note.json" },
  { label: "Search memory", command: 'rem search "proposal queue" --json' },
  { label: "Review proposals", command: "rem proposals list --status open --json" },
];

const proposalQueue = [
  {
    title: "Refine sprint retro summary",
    scope: "note 28f3 • section id: retro-highlights",
    source: "agent: planning-harness",
  },
  {
    title: "Tag onboarding note with people/project facets",
    scope: "note 84c9 • section id: onboarding-checklist",
    source: "agent: auto-tagger",
  },
  {
    title: "Draft decision log entry from meeting notes",
    scope: "note b67e • section id: architecture-tradeoffs",
    source: "agent: meeting-synth",
  },
];

const workboardSteps = [
  "Connect status + search API routes",
  "Mount Lexical editor workspace",
  "Wire proposal accept/reject interactions",
  "Ship first plugin panel (daily notes)",
];

export function App() {
  return (
    <div className="app-shell">
      <div className="orb orb-sun" aria-hidden />
      <div className="orb orb-mint" aria-hidden />

      <header className="hero">
        <p className="hero-kicker">rem / local-first human ↔ agent memory</p>
        <h1>Control Room</h1>
        <p className="hero-copy">
          Canonical writes live in Core, events stay append-only, and UI actions stay transparent.
        </p>
      </header>

      <main className="dashboard" aria-label="rem UI shell">
        <section className="panel panel-command">
          <div className="panel-head">
            <h2>Command Deck</h2>
            <span className="chip">CLI mirrored</span>
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
            <h2>Open Proposal Queue</h2>
            <span className="chip">{proposalQueue.length} pending</span>
          </div>
          <ul className="proposal-list">
            {proposalQueue.map((proposal) => (
              <li key={proposal.title}>
                <h3>{proposal.title}</h3>
                <p>{proposal.scope}</p>
                <small>{proposal.source}</small>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel panel-workboard">
          <div className="panel-head">
            <h2>Bootstrap Track</h2>
            <span className="chip">next milestones</span>
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
