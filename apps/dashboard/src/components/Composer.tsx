import { Mail, Send, StickyNote } from "lucide-react";
import { useEffect, useState } from "react";

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
  const canReply = Boolean(reporterEmail) && emailConfigured;
  const [mode, setMode] = useState<ComposerMode>(canReply ? "reply" : "note");
  const [message, setMessage] = useState("");
  const [contactEmail, setContactEmail] = useState("");

  useEffect(() => {
    if (canReply) setMode("reply");
  }, [canReply]);

  const effectiveMode: ComposerMode = mode === "reply" && !canReply ? "note" : mode;

  function submit(): void {
    const trimmed = message.trim();
    if (!trimmed || busy) return;
    onSubmit(trimmed, effectiveMode);
    setMessage("");
  }

  function saveReporterEmail(): void {
    const email = contactEmail.trim();
    if (!email || busy) return;
    onSetReporterEmail(email);
  }

  const replyUnavailableReason = !reporterEmail
    ? "No reporter email was captured for this report"
    : !emailConfigured
      ? "Email replies aren't configured for this deployment"
      : undefined;

  return (
    <div className="composer">
      <div className="ctabs" role="tablist" aria-label="Response type">
        <button
          type="button"
          role="tab"
          aria-selected={effectiveMode === "reply"}
          className={effectiveMode === "reply" ? "active" : ""}
          onClick={() => setMode("reply")}
          disabled={!canReply}
          title={replyUnavailableReason}
        >
          Reply to {replyName}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={effectiveMode === "note"}
          className={effectiveMode === "note" ? "active" : ""}
          onClick={() => setMode("note")}
        >
          Internal note
        </button>
      </div>

      {!reporterEmail ? (
        <div className="composer-contact">
          <div><b>Add reporter email</b><span>Required before this report can receive an email reply.</span></div>
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
        <p className="composer-warning">Email delivery is not configured for this deployment. Internal notes remain available.</p>
      ) : null}

      <div className="composer-field">
        <textarea
          id="composer-message"
          aria-label={effectiveMode === "reply" ? `Reply to ${replyName}` : "Internal note"}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={effectiveMode === "reply" ? "Write a reply… sent to the reporter by email" : "Add a note for your team… saved to the report"}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submit();
          }}
        />
        <div className="composer-foot">
          <span className="via">
            {effectiveMode === "reply" ? <><Mail size={13} />Sent via email</> : <><StickyNote size={13} />Saved to report</>}
          </span>
          <button className="send" type="button" onClick={submit} disabled={busy || !message.trim()}>
            <Send size={14} />
            {effectiveMode === "reply" ? "Send reply" : "Add note"}
          </button>
        </div>
      </div>
    </div>
  );
}
