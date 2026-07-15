export interface EmailConfig {
  resendApiKey?: string;
  replyFrom?: string;
  replyReplyTo?: string;
}

export function emailEnabled(config: EmailConfig): boolean {
  return Boolean(config.resendApiKey && config.replyFrom);
}

export interface ReplyEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailDelivery {
  id: string;
}

export interface ReportReplyContent {
  reportId: string;
  reportTitle: string;
  reportComment: string;
  message: string;
  reporterName?: string;
}

/** Builds a branded reporter email with a stable reference back to the report. */
export function buildReportReplyEmail(content: ReportReplyContent): Omit<ReplyEmail, "to"> {
  const reference = `#${content.reportId.slice(0, 8).toUpperCase()}`;
  const subjectTitle = content.reportTitle.replace(/\s+/g, " ").trim();
  const greeting = content.reporterName?.trim()
    ? `Hi ${content.reporterName.trim().split(/\s+/)[0]},`
    : "Hello,";
  const subject = `Re: ${subjectTitle} [${reference}]`;
  const text = [
    greeting,
    "",
    content.message,
    "",
    "Regarding your report",
    content.reportTitle,
    `Reference: ${reference}`,
    "",
    "Your original report:",
    content.reportComment,
    "",
    "This message was sent in response to a report you submitted through ReproRelay.",
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;background:#f5f5f4;color:#1c1917;font-family:Arial,Helvetica,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">A reply about ${escapeHtml(content.reportTitle)} · ${reference}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f5f5f4;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:620px;background:#ffffff;border:1px solid #e7e5e4;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(28,25,23,.06);">
          <tr>
            <td style="padding:22px 28px;background:#1c1917;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="width:36px;height:36px;border-radius:10px;background:#f97316;color:#ffffff;font-size:14px;font-weight:700;text-align:center;vertical-align:middle;">RR</td>
                  <td style="padding-left:12px;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:-.2px;">ReproRelay</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px 12px;">
              <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#ea580c;">Update on your report</div>
              <p style="margin:14px 0 18px;font-size:16px;line-height:1.6;color:#292524;">${escapeHtml(greeting)}</p>
              <div style="font-size:16px;line-height:1.7;color:#292524;">${formatHtmlText(content.message)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 32px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;">
                <tr>
                  <td style="padding:20px;">
                    <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9a3412;">Regarding your report</div>
                    <div style="margin-top:8px;font-size:17px;font-weight:700;line-height:1.4;color:#1c1917;">${escapeHtml(content.reportTitle)}</div>
                    <div style="margin-top:8px;font-size:13px;color:#78716c;">Reference <strong style="color:#9a3412;">${reference}</strong></div>
                    <div style="margin-top:16px;padding-top:16px;border-top:1px solid #fed7aa;font-size:13px;line-height:1.6;color:#57534e;">${formatHtmlText(content.reportComment)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px;background:#fafaf9;border-top:1px solid #e7e5e4;font-size:12px;line-height:1.5;color:#78716c;">
              This message was sent in response to a report you submitted through ReproRelay.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}

/** Sends a reporter reply through Resend. Throws when the request is rejected. */
export async function sendReplyEmail(config: EmailConfig, email: ReplyEmail): Promise<EmailDelivery> {
  if (!config.resendApiKey || !config.replyFrom) {
    throw new Error("Email replies are not configured");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.resendApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: config.replyFrom,
      to: [email.to],
      subject: email.subject,
      text: email.text,
      html: email.html,
      ...(config.replyReplyTo ? { reply_to: config.replyReplyTo } : {}),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Resend request failed: ${response.status} ${detail}`.trim());
  }

  const body = await response.json().catch(() => undefined) as { id?: unknown } | undefined;
  if (typeof body?.id !== "string" || !body.id) throw new Error("Resend accepted the request without returning a message id");
  return { id: body.id };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function formatHtmlText(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, "<br>");
}
