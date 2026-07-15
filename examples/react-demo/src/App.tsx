import { ReproRelayProvider } from "@reprorelay/react";
import { useState } from "react";

const apiUrl = import.meta.env.VITE_REPRORELAY_API_URL ?? "http://localhost:4000";

export function App() {
  const [template, setTemplate] = useState("July offer");
  const [group, setGroup] = useState("Gold customers");
  const [previewBroken, setPreviewBroken] = useState(false);

  return (
    <ReproRelayProvider
      config={{
        projectKey: "proj_demo-react",
        apiUrl,
        release: "demo-0.1.0",
        environment: "staging",
        autoInjectButton: true,
        user: { id: "demo-client", email: "client@example.com", name: "Client Demo" },
        context: { app: "react-demo" },
      }}
    >
      <main className="demo-shell">
        <header className="demo-header">
          <div>
            <strong>Client Campaign Console</strong>
            <span>Staging</span>
          </div>
          <span className="sdk-status">ReproRelay ready</span>
        </header>

        <section className="composer">
          <div className="composer-main">
            <h1>Campaign composer</h1>
            <label>
              Template
              <select value={template} onChange={(event) => setTemplate(event.target.value)}>
                <option>July offer</option>
                <option>Renewal reminder</option>
                <option>Welcome sequence</option>
              </select>
            </label>
            <label>
              Contact group
              <select
                value={group}
                onChange={(event) => {
                  setGroup(event.target.value);
                  setPreviewBroken(event.target.value === "Gold customers");
                  console.error("Preview renderer failed for contact group variables", { group: event.target.value });
                }}
              >
                <option>All contacts</option>
                <option>Gold customers</option>
                <option>New leads</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => {
                setPreviewBroken(true);
                console.warn("Demo intentionally broke the preview panel");
              }}
            >
              Generate preview
            </button>
          </div>

          <aside className={previewBroken ? "preview broken" : "preview"}>
            <h2>Message preview</h2>
            {previewBroken ? (
              <p>Preview failed to render for {group}.</p>
            ) : (
              <p>
                Hi Sarah, your selected template is <strong>{template}</strong>. This panel is intentionally realistic enough to create a useful replay.
              </p>
            )}
          </aside>
        </section>
      </main>
    </ReproRelayProvider>
  );
}
