import type { ReportRecord } from "@reprorelay/shared";
import {
  Archive,
  ArchiveRestore,
  Bot,
  ChevronDown,
  Copy,
  Check,
  Download,
  ExternalLink,
  FileImage,
  FileJson,
  FileText,
  Github,
  Upload,
  UserRound,
  Video,
} from "lucide-react";
import { useState } from "react";
import type { AttachmentPresentation, ReportPresentation } from "../lib/data-source.js";
import { Composer, type ComposerMode } from "./Composer.js";

const STATUS_OPTIONS: Array<{ value: ReportRecord["status"]; label: string }> = [
  { value: "new", label: "New" },
  { value: "triaged", label: "Triaged" },
  { value: "github_created", label: "Issue created" },
  { value: "agent_handoff", label: "With engineering" },
  { value: "closed", label: "Closed" },
];

const STATUS_LABEL: Record<ReportRecord["status"], string> = {
  new: "New",
  triaged: "Triaged",
  github_created: "Issue created",
  agent_handoff: "With engineering",
  closed: "Closed",
};

interface ReportDetailProps {
  report: ReportRecord;
  presentation: ReportPresentation;
  /** "owner/repo" this report's project files issues into, when linked. */
  projectRepo?: string;
  busy: boolean;
  onChangeStatus: (status: ReportRecord["status"]) => void;
  onToggleAssignee: () => void;
  onCreateIssue: () => void;
  onSendToEngineering: () => void;
  onUpdateReporterEmail: (email: string) => void;
  onArchive: () => void;
  onRestore: () => void;
  emailConfigured: boolean;
  onSubmitComposer: (body: string, mode: ComposerMode) => void;
}

export function ReportDetail({
  report,
  presentation,
  projectRepo,
  busy,
  onChangeStatus,
  onToggleAssignee,
  onCreateIssue,
  onSendToEngineering,
  onUpdateReporterEmail,
  onArchive,
  onRestore,
  emailConfigured,
  onSubmitComposer,
}: ReportDetailProps) {
  const [statusOpen, setStatusOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const replyName = presentation.reporter.name.split(" ")[0] ?? presentation.reporter.name;
  const handoffQueued = report.agentStatus === "queued";
  const handoffSent = report.agentStatus === "sent";
  const issueState = report.githubIssueUrl ? "view" : report.githubIssueRequestedAt ? "queued" : "create";
  const agentPromptText = presentation.agentPrompt
    ? projectRepo
      ? `In repository ${projectRepo}:\n\n${presentation.agentPrompt}`
      : presentation.agentPrompt
    : undefined;

  function copyError(): void {
    if (!presentation.evidence.errorSignal) return;
    void navigator.clipboard?.writeText(presentation.evidence.errorSignal).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }

  function copyAgentPrompt(): void {
    if (!agentPromptText) return;
    void navigator.clipboard?.writeText(agentPromptText).then(() => {
      setPromptCopied(true);
      window.setTimeout(() => setPromptCopied(false), 1600);
    });
  }

  return (
    <section className="detail" aria-label="Report detail">
      <div className="dhead">
        <div className="kick">
          <span className={`sev sev-${report.severity}`} data-status={report.status}><span className="d" />{report.severity}</span>
          <span className="id">{presentation.reportNumber}</span>
          <span className="made">{presentation.createdLabel}</span>
        </div>
        <h1>{report.title}</h1>
        <div className="actions">
          <div className="menu-wrap">
            <button className="abtn" type="button" onClick={() => setStatusOpen((open) => !open)} aria-expanded={statusOpen} disabled={busy}>
              <span className="lab">Status</span> {STATUS_LABEL[report.status]} <ChevronDown size={13} />
            </button>
            {statusOpen ? (
              <>
                <button
                  type="button"
                  aria-label="Close status menu"
                  onClick={() => setStatusOpen(false)}
                  style={{ position: "fixed", inset: 0, zIndex: 20, cursor: "default" }}
                />
                <div className="menu" role="menu">
                  {STATUS_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="menuitem"
                      className={option.value === report.status ? "selected" : ""}
                      disabled={busy}
                      onClick={() => { onChangeStatus(option.value); setStatusOpen(false); }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </div>

          <button className="abtn" type="button" onClick={onToggleAssignee} disabled={busy}>
            <UserRound size={14} />
            <span className="lab">Assignee</span> {presentation.assignee?.name ?? "Unassigned"}
          </button>

          <span className="sp" />

          <button className="abtn" type="button" onClick={report.archivedAt ? onRestore : onArchive} disabled={busy}>
            {report.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            {report.archivedAt ? "Restore" : "Archive"}
          </button>

          {issueState === "view" ? (
            <a className="abtn" href={report.githubIssueUrl} target="_blank" rel="noreferrer">
              <Github size={14} />View issue<ExternalLink size={13} />
            </a>
          ) : (
            <button className="abtn" type="button" onClick={onCreateIssue} disabled={busy || issueState === "queued"}>
              <Github size={14} />{issueState === "queued" ? "Queued — syncing…" : "Create issue"}
            </button>
          )}

          <button className="abtn primary" type="button" onClick={onSendToEngineering} disabled={busy || handoffQueued || handoffSent}>
            <Upload size={14} />
            {handoffSent ? "Sent to engineering" : handoffQueued ? "Queued — sending…" : busy ? "Working…" : "Send to engineering"}
          </button>
        </div>
      </div>

      <div className="dbody">
        <div className="sec">
          <dl className="meta">
            <div><dt>Reporter</dt><dd>{presentation.reporter.name}</dd></div>
            <div><dt>Environment</dt><dd>{presentation.environmentLabel}</dd></div>
            {presentation.releaseLabel ? <div><dt>Release</dt><dd>{presentation.releaseLabel}</dd></div> : null}
            <div><dt>Browser</dt><dd>{presentation.browserLabel}</dd></div>
            <div><dt>Platform</dt><dd>{presentation.platformLabel}</dd></div>
            <div><dt>Labels</dt><dd>{presentation.tags.length ? presentation.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>) : <span className="tag">None</span>}</dd></div>
          </dl>
        </div>

        <div className="sec">
          <h3>Report</h3>
          <article className="msg">
            <span className="glyph"><UserRound size={15} /></span>
            <div>
              <div className="msg-head"><b>{presentation.reporter.name}</b><span className="role">Reporter</span><time>{presentation.createdLabel}</time></div>
              <p>{report.comment}</p>
            </div>
          </article>

          <article className="msg">
            <span className="glyph"><Bot size={15} /></span>
            <div>
              <div className="msg-head"><b>AI summary</b>{report.aiTriage ? <span className="role">{Math.round(report.aiTriage.confidence * 100)}% confidence · {report.aiTriage.likelyArea}</span> : null}</div>
              {presentation.aiSummary.length ? (
                <ul>{presentation.aiSummary.map((line) => <li key={line}>{line}</li>)}</ul>
              ) : <p className="section-empty">AI triage has not run for this report yet.</p>}
              {agentPromptText ? (
                <div className="snippet agent-prompt">
                  <div className="snippet-head">
                    <span>Fix prompt — paste into your AI coding agent</span>
                    <button type="button" onClick={copyAgentPrompt}>
                      {promptCopied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy prompt</>}
                    </button>
                  </div>
                  <pre>{agentPromptText}</pre>
                </div>
              ) : null}
            </div>
          </article>

          {presentation.internalNotes.map((note, index) => (
            <article className={note.channel === "email" ? "msg email-note" : "msg"} key={`${note.author.name}-${index}`}>
              <span className="glyph"><UserRound size={15} /></span>
              <div>
                <div className="msg-head"><b>{note.author.name}</b><time>{note.createdLabel}</time></div>
                <span className="note-badge">{note.channel === "email" ? "Emailed reply" : "Internal note"}</span>
                <p>{note.body}</p>
              </div>
            </article>
          ))}
        </div>

        <div className="sec">
          <h3>Evidence <span className="side">Captured {presentation.evidence.capturedLabel}</span></h3>

          {report.videoDeletedAt ? (
            <p className="retention-note"><Video size={15} />Video evidence was automatically deleted under the seven-day retention policy.</p>
          ) : null}

          {presentation.evidence.video ? (
            <>
              <p className="subhead">Screen recording</p>
              <EvidenceVideo url={presentation.evidence.video.url} contentType={presentation.evidence.video.contentType} />
            </>
          ) : (
            <div className="evidence-empty"><Video size={22} /><b>No screen recording captured</b></div>
          )}

          {presentation.evidence.screenshotUrl ? (
            <>
              <p className="subhead">Screenshot</p>
              <div className="shot-frame"><img src={presentation.evidence.screenshotUrl} alt={presentation.evidence.screenshotAlt} /></div>
            </>
          ) : null}

          <p className="subhead">Reproduction steps</p>
          {presentation.evidence.steps.length ? (
            <ol className="steps">{presentation.evidence.steps.map((step, index) => <li key={`${step}-${index}`}>{step}</li>)}</ol>
          ) : <p className="section-empty">No reproduction steps were captured.</p>}

          <p className="subhead">Error signal</p>
          {presentation.evidence.errorSignal ? (
            <div className="signal">
              <span className="badge">Error</span>
              <code>{presentation.evidence.errorSignal}</code>
              <button type="button" onClick={copyError}>{copied ? <><Check size={14} />Copied</> : <><Copy size={14} />Copy</>}</button>
            </div>
          ) : <p className="section-empty">No console or failed-network signal was captured.</p>}

          <p className="subhead">Attachments</p>
          {presentation.evidence.attachments.length ? (
            <div className="files">
              {presentation.evidence.attachments.map((attachment) => <AttachmentRow key={attachment.id} attachment={attachment} />)}
            </div>
          ) : <p className="section-empty">No evidence files attached.</p>}
        </div>

        <div className="sec">
          <h3>Activity</h3>
          {presentation.activity.map((item) => (
            <div className="tl" key={`${item.label}-${item.time}`}>
              <span className={`nd ${item.kind === "ai" ? "ai" : item.kind === "review" ? "review" : ""}`}><i /></span>
              <span className="x">{item.label}{item.detail ? <small>{item.detail}</small> : null}</span>
              <time>{item.time}</time>
            </div>
          ))}
        </div>
      </div>

      <Composer
        replyName={replyName}
        reporterEmail={presentation.reporter.email}
        emailConfigured={emailConfigured}
        busy={busy}
        onSubmit={onSubmitComposer}
        onSetReporterEmail={onUpdateReporterEmail}
      />
    </section>
  );
}

function EvidenceVideo({ url, contentType }: { url: string; contentType: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    const isWebm = contentType.toLowerCase().includes("webm");
    return (
      <div className="evidence-empty video-error">
        <Video size={22} />
        <b>This recording can’t be played in this browser</b>
        <p>
          {isWebm
            ? "It was recorded as WebM, which Safari and iPhones can’t decode — open it in Chrome, Edge, or Firefox, or download it below. New recordings are captured as MP4 and will play everywhere."
            : "The file may have failed to upload from the reporter’s browser, or the format isn’t supported here."}
        </p>
        <a className="video-download" href={url} target="_blank" rel="noreferrer"><Download size={14} /> Download recording</a>
      </div>
    );
  }

  return (
    <video
      className="video-player"
      controls
      playsInline
      preload="metadata"
      src={url}
      onError={() => setFailed(true)}
    >
      Your browser cannot play this recording.
    </video>
  );
}

function AttachmentRow({ attachment }: { attachment: AttachmentPresentation }) {
  const content = (
    <>
      <span className="fi">{attachmentIcon(attachment)}</span>
      <span className="fname">{attachment.title}</span>
      <span className="fsz">{attachment.meta ?? "—"}</span>
      <span className="dl"><Download size={15} /></span>
    </>
  );
  if (attachment.url) {
    return <a className="file" href={attachment.url} target="_blank" rel="noreferrer">{content}</a>;
  }
  return <span className="file">{content}</span>;
}

function attachmentIcon(attachment: AttachmentPresentation) {
  switch (attachment.kind) {
    case "image": return <FileImage size={17} />;
    case "video": return <Video size={17} />;
    case "text": return <FileText size={17} />;
    default: return <FileJson size={17} />;
  }
}
