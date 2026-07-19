import { MessageCircle, Send, StickyNote } from "lucide-react";
import { useState } from "react";

export type ComposerMode = "reply" | "note";

interface ComposerProps {
  replyName: string;
  reporterEmail?: string;
  emailConfigured: boolean;
  busy: boolean;
  onSubmit: (body: string, mode: ComposerMode) => void;
  onSetReporterEmail: (email: string) => void;
}

export function Composer({ replyName, reporterEmail, emailConfigured, busy, onSubmit, onSetReporterEmail }: ComposerProps) {
  const emailCopyAvailable = Boolean(reporterEmail) && emailConfigured;
  const [mode, setMode] = useState<ComposerMode>("reply");
  const [message, setMessage] = useState("");
  const [contactEmail, setContactEmail] = useState("");

  function submit(): void {
    const trimmed = message.trim();
    if (!trimmed || busy) return;
    onSubmit(trimmed, mode);
    setMessage("");
  }

  function saveReporterEmail(): void {
    const email = contactEmail.trim();
    if (!email || busy) return;
    onSetReporterEmail(email);
  }

  return (
    <div className="composer">
      <div className="ctabs" role="tablist" aria-label="Response type">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "reply"}
          className={mode === "reply" ? "active" : ""}
          onClick={() => setMode("reply")}
        >
          Reply to {replyName}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "note"}
          className={mode === "note" ? "active" : ""}
          onClick={() => setMode("note")}
        >
          Internal note
        </button>
      </div>

      {!reporterEmail ? (
        <div className="composer-contact">
          <div><b>Add reporter email (optional)</b><span>The reply will appear in the widget either way. Add an address to send an email copy too.</span></div>
          <input
            type="email"
            aria-label="Reporter email"
            placeholder="reporter@example.com"
            value={contactEmail}
            onChange={(event) => setContactEmail(event.target.value)}
            disabled={busy}
          />
          <button type="button" onClick={saveReporterEmail} disabled={busy || !contactEmail.trim()}>Save email</button>
        </div>
      ) : !emailConfigured ? (
        <p className="composer-warning">Replies appear in the reporter’s widget. Email copies are not configured for this deployment.</p>
      ) : null}

      <div className="composer-field">
        <textarea
          id="composer-message"
          aria-label={mode === "reply" ? `Reply to ${replyName}` : "Internal note"}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={mode === "reply" ? "Write a reply… visible in the reporter’s widget" : "Add a note for your team… saved to the report"}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submit();
          }}
        />
        <div className="composer-foot">
          <span className="via">
            {mode === "reply"
              ? <><MessageCircle size={13} />Visible in widget{emailCopyAvailable ? " + email copy" : ""}</>
              : <><StickyNote size={13} />Saved to report</>}
          </span>
          <button className="send" type="button" onClick={submit} disabled={busy || !message.trim()}>
            <Send size={14} />
            {mode === "reply" ? "Send reply" : "Add note"}
          </button>
        </div>
      </div>
    </div>
  );
}
