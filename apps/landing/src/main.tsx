import { useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const REPOSITORY_URL = "https://github.com/kish613/reprorelay";
const DOCS_URL = REPOSITORY_URL + "#quick-start";
const NPM_URL = "https://www.npmjs.com/package/@reprorelay/browser-sdk";
const BRAND_MARK_URL = import.meta.env.BASE_URL + "brand/reprorelay-mark.png";

type FlowStep = "report" | "context" | "review" | "handoff";

const flowSteps: Array<{
  id: FlowStep;
  number: string;
  title: string;
  copy: string;
}> = [
  {
    id: "report",
    number: "01",
    title: "Capture",
    copy: "A user describes what happened at the point the bug appears.",
  },
  {
    id: "context",
    number: "02",
    title: "Collect context",
    copy: "Replay, screenshot, browser details, console signals, and network metadata travel with it.",
  },
  {
    id: "review",
    number: "03",
    title: "Review",
    copy: "Your team reviews the evidence, adds a note, or requests a change before handoff.",
  },
  {
    id: "handoff",
    number: "04",
    title: "Hand off",
    copy: "A focused issue reaches engineering with the evidence needed to reproduce it.",
  },
];

function ArrowIcon() {
  return (
    <svg aria-hidden="true" className="icon" viewBox="0 0 24 24" fill="none">
      <path d="M4 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg aria-hidden="true" className="icon" viewBox="0 0 24 24" fill="none">
      <path d="M8 5.5v13l10-6.5-10-6.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg aria-hidden="true" className="icon" viewBox="0 0 24 24" fill="none">
      <path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg aria-hidden="true" className="icon icon-large" viewBox="0 0 24 24" fill="none">
      <path d="M12 3 19 6v5c0 4.5-2.9 8.1-7 10-4.1-1.9-7-5.5-7-10V6l7-3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <rect x="8.2" y="11" width="7.6" height="5.6" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 11V9.6a2 2 0 0 1 4 0V11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function BrowserIcon() {
  return (
    <svg aria-hidden="true" className="icon icon-large" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="4" width="18" height="15" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3 8h18M7 6h.01M10 6h.01M13 6h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="m10 11 5 3-5 3v-6Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function Mark() {
  return <img className="mark" src={BRAND_MARK_URL} alt="" />;
}

function LinkArrow() {
  return <span className="link-arrow"><ArrowIcon /></span>;
}

function ClientReport() {
  return (
    <article className="client-report" aria-label="Example client report">
      <div className="mock-window">
        <span />
        <span />
        <span />
        <p>app.example.com/checkout</p>
      </div>
      <div className="mock-heading">
        <span className="mini-label">Client report</span>
        <span className="mock-status">Ready to review</span>
      </div>
      <h3>Checkout total does not update</h3>
      <p className="report-copy">I updated the quantity but the total did not change.</p>
      <div className="replay-frame">
        <div className="replay-topline"><span>Checkout</span><span>20s</span></div>
        <div className="replay-canvas">
          <div className="replay-row"><span>Hoodie</span><span>2</span><span>$80.00</span></div>
          <div className="replay-total"><span>Total</span><strong>$80.00</strong></div>
          <button className="play-button" type="button" aria-label="Preview replay"><PlayIcon /></button>
        </div>
        <div className="replay-controls"><span>0:00 / 0:20</span><span className="replay-line" /><span>1×</span></div>
      </div>
      <dl className="context-list">
        <div><dt>Browser</dt><dd>Chrome · macOS</dd></div>
        <div><dt>Console</dt><dd>2 captured events</dd></div>
        <div><dt>Network</dt><dd>1 failed request</dd></div>
      </dl>
    </article>
  );
}

function EngineeringIssue({ stage }: { stage: FlowStep }) {
  const descriptions: Record<FlowStep, string> = {
    report: "The report arrives with the user’s words, not a vague inbox message.",
    context: "The replay and browser context let the team reproduce the path.",
    review: "Human review remains the deliberate gate before anything is handed off.",
    handoff: "The approved issue is clear enough for the next engineering step.",
  };

  return (
    <article className="engineering-issue" aria-label="Example engineering issue">
      <div className="issue-topbar">
        <div><span className="github-dot">◒</span><span>Issues</span><span className="breadcrumb">/ #1412</span></div>
        <span>•••</span>
      </div>
      <h3>Checkout total does not update</h3>
      <p className="issue-state"><span className="state-dot" /> Pending review <span>·</span> captured from a client report</p>
      <div className="issue-tabs">
        <span className="active">Details</span><span>Replay</span><span>Console</span><span>Network</span><span>Context</span>
      </div>
      <div className="issue-body">
        <div className="issue-replay">
          <p>Replay</p>
          <div className="replay-canvas issue-replay-canvas">
            <div className="replay-row"><span>Hoodie</span><span>2</span><span>$80.00</span></div>
            <div className="replay-total"><span>Total</span><strong>$80.00</strong></div>
            <button className="play-button" type="button" aria-label="Preview issue replay"><PlayIcon /></button>
          </div>
        </div>
        <div className="issue-context">
          <p>Browser context</p>
          <span>Chrome · macOS</span>
          <span>1920 × 1080</span>
          <span>Checkout route</span>
        </div>
        <div className="issue-signal"><p>Console (2)</p><span>Uncaught TypeError</span><span>Source map unavailable</span></div>
        <div className="issue-signal"><p>Network (1 failed)</p><span>POST /api/checkout/calculate</span><strong>500</strong></div>
      </div>
      <div className="issue-review">
        <div><strong>Human review</strong><span>{descriptions[stage]}</span></div>
        <div className="issue-actions"><button type="button">Request changes</button><button className="orange-button" type="button">Approve &amp; send</button></div>
      </div>
    </article>
  );
}

function FlowIcon({ id }: { id: FlowStep }) {
  if (id === "report") return <BrowserIcon />;
  if (id === "context") return <CodeIcon />;
  if (id === "review") return <ShieldIcon />;
  return <ArrowIcon />;
}

function App() {
  const [activeFlow, setActiveFlow] = useState<FlowStep>("report");
  const [menuOpen, setMenuOpen] = useState(false);

  function scrollToDemo(): void {
    document.getElementById("demo")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="ReproRelay home"><Mark /><span>ReproRelay</span></a>
        <button className="menu-button" type="button" aria-expanded={menuOpen} aria-label="Toggle navigation" onClick={() => setMenuOpen((value) => !value)}>
          <span /><span /><span />
        </button>
        <nav className={menuOpen ? "site-nav site-nav-open" : "site-nav"} aria-label="Primary navigation">
          <a href={DOCS_URL}>Docs</a>
          <a href={REPOSITORY_URL}>GitHub</a>
          <button type="button" onClick={scrollToDemo}>Demo</button>
          <a className="header-cta" href={REPOSITORY_URL}>View on GitHub</a>
        </nav>
      </header>
      <main id="top">
        <section className="hero shell">
          <div className="hero-copy">
            <h1>Turn vague bug reports into reproducible issues.</h1>
            <p>Capture the replay, screenshot, browser context, and client comment—then review a complete issue before it reaches engineering.</p>
            <div className="hero-actions">
              <button className="button button-primary" type="button" onClick={scrollToDemo}>Explore the demo <LinkArrow /></button>
              <a className="button button-secondary" href={DOCS_URL}>Read the docs <LinkArrow /></a>
            </div>
          </div>
          <div className="hero-product" aria-label="Client report flowing to engineering inbox">
            <div className="product-labels"><span>Client report</span><span>Engineering inbox</span></div>
            <div className="product-flow">
              <ClientReport />
              <div className="flow-connector" aria-hidden="true"><span /><ArrowIcon /></div>
              <EngineeringIssue stage={activeFlow} />
            </div>
          </div>
        </section>

        <section className="demo-section" id="demo">
          <div className="shell demo-shell">
            <div className="section-heading">
              <p className="section-number">A complete report, captured with intent.</p>
              <h2>See how a report becomes useful to engineering.</h2>
            </div>
            <div className="demo-grid">
              <div className="demo-control">
                <p>Choose a point in the flow.</p>
                <div className="flow-selectors">
                  {flowSteps.map((step) => (
                    <button
                      className={activeFlow === step.id ? "flow-selector selected" : "flow-selector"}
                      type="button"
                      key={step.id}
                      onClick={() => setActiveFlow(step.id)}
                    >
                      <span>{step.number}</span>
                      <strong>{step.title}</strong>
                      <small>{step.copy}</small>
                    </button>
                  ))}
                </div>
              </div>
              <div className="demo-issue"><EngineeringIssue stage={activeFlow} /></div>
            </div>
          </div>
        </section>

        <section className="process-section shell">
          <div className="section-heading process-heading">
            <p className="section-number">The path is visible.</p>
            <h2>From report to ready-to-review issue.</h2>
          </div>
          <div className="process-rail">
            {flowSteps.map((step, index) => (
              <button className={activeFlow === step.id ? "process-step process-step-active" : "process-step"} type="button" key={step.id} onClick={() => setActiveFlow(step.id)}>
                <span className="process-icon"><FlowIcon id={step.id} /></span>
                <span className="process-number">{step.number}</span>
                <strong>{step.title}</strong>
                <small>{step.copy}</small>
                {index < flowSteps.length - 1 ? <span className="process-line" aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
        </section>

        <section className="privacy-section">
          <div className="shell privacy-grid">
            <div className="privacy-title"><p className="section-number">Evidence, with boundaries.</p><h2>Useful evidence. Deliberate boundaries.</h2></div>
            <div className="privacy-detail">
              <BrowserIcon />
              <p>Replay, screenshot, browser context, and an optional client comment give an issue enough shape to investigate.</p>
            </div>
            <div className="privacy-detail privacy-detail-bordered">
              <ShieldIcon />
              <p>Input masking, token redaction, and human approval stay in the flow.</p>
              <pre><code>authorization: "<em>Bearer redacted</em>"
email: "<em>a***@example.com</em>"
password: "<em>••••••••</em>"</code></pre>
            </div>
          </div>
        </section>

        <section className="install-section shell">
          <div className="install-copy">
            <p className="section-number">Small integration. Complete context.</p>
            <h2>Add it where your users find the bug.</h2>
            <p>Use the browser SDK or React helper in the web app your customers already use. ReproRelay remains self-hosted and Git-native.</p>
            <div className="install-actions">
              <a className="button button-dark" href={DOCS_URL}>Start with the docs <LinkArrow /></a>
              <a className="button button-secondary" href={NPM_URL}>View on npm <LinkArrow /></a>
            </div>
          </div>
          <div className="code-examples">
            <div className="install-command"><span>Install</span><code>npm install @reprorelay/browser-sdk</code><button type="button" onClick={() => navigator.clipboard?.writeText("npm install @reprorelay/browser-sdk")}>Copy</button></div>
            <div className="code-card"><p>React helper</p><pre><code><span>import</span> {"{ ReproRelay }"} <span>from</span> "@reprorelay/react";

<span>export default function</span> App() {"{"}
  &lt;ReproRelay projectKey="frontend" /&gt;
{"}"}</code></pre></div>
            <div className="code-card"><p>Browser SDK</p><pre><code><span>import</span> {"{ ReproRelay }"} <span>from</span> "@reprorelay/browser-sdk";

ReproRelay.init({"{"}
  projectKey: "frontend"
{"}"});</code></pre></div>
          </div>
        </section>
      </main>
      <footer className="site-footer shell">
        <div><a className="brand" href="#top"><Mark /><span>ReproRelay</span></a><p>Open-source bug capture for web apps.</p></div>
        <div className="footer-links"><a href={REPOSITORY_URL}>GitHub</a><a href={NPM_URL}>npm</a><a href={DOCS_URL}>Docs</a><a href={REPOSITORY_URL + "/blob/main/LICENSE"}>MIT License</a></div>
      </footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
