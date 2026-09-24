import { addUtm } from "./net.ts";
import { monthLabel } from "./schedule.ts";
import type { FactsPack, GeneratedVariant, RenderedEmail } from "./types.ts";
import { countWords, formatLocalDate, readingMinutes } from "./util.ts";

/** Mailchimp merge tags the provider requires in campaign content. */
export const UNSUBSCRIBE_PLACEHOLDER = "*|UNSUB|*";
export const ADDRESS_PLACEHOLDER = "*|LIST:ADDRESSLINE|*";

/** Volta website palette: black canvas, white type, pill outline CTA. */
const THEME = {
  page: "#000000",
  ink: "#ffffff",
  body: "#d4d4d4",
  muted: "#a3a3a3",
  line: "#262626",
  accent: "#05d9e7",
  draftBg: "#1a1400",
  draftText: "#fbbf24",
} as const;

const FONT =
  "Inter, Arial, Helvetica, sans-serif";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type RenderContext = {
  monthKey: string;
  timezone: string;
  factsPack: FactsPack;
  /** Set for previews so the draft can never be mistaken for a sent edition. */
  draftBanner?: boolean;
};

function campaignTag(context: RenderContext, variant: GeneratedVariant): string {
  return `volta-signal-${context.monthKey}-${variant.kind}`;
}

function eventLine(context: RenderContext, sourceItemIds: string[]): string | null {
  for (const id of sourceItemIds) {
    const item = context.factsPack.items.find((entry) => entry.source_item_id === id);
    if (item?.event_start_at) {
      return formatLocalDate(item.event_start_at, context.timezone);
    }
  }
  return null;
}

/**
 * Conservative table-based email. Used directly when no ESP template is
 * configured, and as the section content when one is.
 */
export function renderVariant(variant: GeneratedVariant, context: RenderContext): RenderedEmail {
  const tag = campaignTag(context, variant);
  const title = monthLabel(context.monthKey);

  const sectionsHtml = variant.sections
    .map((section) => {
      const itemsHtml = section.items
        .map((item) => {
          const date = eventLine(context, item.sourceItemIds);
          const cta =
            item.ctaUrl && item.ctaLabel
              ? `<p style="margin:8px 0 0;"><a href="${escapeHtml(addUtm(item.ctaUrl, tag))}" style="color:${THEME.accent};text-decoration:underline;">${escapeHtml(item.ctaLabel)}</a></p>`
              : "";
          return `
            <tr>
              <td style="padding:0 0 20px;">
                <h3 style="margin:0 0 6px;font-size:17px;line-height:1.35;color:${THEME.ink};font-weight:600;">${escapeHtml(item.headline)}</h3>
                ${date ? `<p style="margin:0 0 6px;font-size:13px;color:${THEME.muted};">${escapeHtml(date)}</p>` : ""}
                <p style="margin:0;font-size:15px;line-height:1.55;color:${THEME.body};">${escapeHtml(item.copy)}</p>
                ${cta}
              </td>
            </tr>`;
        })
        .join("");

      return `
        <tr>
          <td style="padding:8px 0 4px;">
            <h2 style="margin:0 0 12px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:${THEME.muted};">${escapeHtml(section.heading)}</h2>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${itemsHtml}</table>
          </td>
        </tr>`;
    })
    .join("");

  const primaryCtaHtml = `
    <tr>
      <td style="padding:8px 0 24px;">
        <a href="${escapeHtml(addUtm(variant.primaryCta.url, tag))}"
           style="display:inline-block;padding:14px 28px;min-height:44px;box-sizing:border-box;background:${THEME.page};color:${THEME.ink};font-size:15px;font-weight:600;text-decoration:none;border-radius:80px;border:2px solid ${THEME.ink};">
          ${escapeHtml(variant.primaryCta.label)}
        </a>
      </td>
    </tr>`;

  const banner = context.draftBanner
    ? `<tr><td bgcolor="${THEME.draftBg}" style="padding:12px 16px;background:${THEME.draftBg};color:${THEME.draftText};font-size:13px;font-weight:700;letter-spacing:.06em;">DRAFT — NOT SENT</td></tr>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <meta name="supported-color-schemes" content="dark" />
    <title>${escapeHtml(variant.subject)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet" />
  </head>
  <body bgcolor="${THEME.page}" style="margin:0;padding:0;background:${THEME.page};color:${THEME.ink};font-family:${FONT};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(variant.preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${THEME.page}" style="background:${THEME.page};">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" bgcolor="${THEME.page}" style="width:640px;max-width:100%;background:${THEME.page};">
            ${banner}
            <tr>
              <td style="padding:28px 28px 8px;">
                <p style="margin:0 0 18px;font-size:22px;line-height:1;font-weight:700;letter-spacing:-0.03em;color:${THEME.ink};">VOLTA</p>
                <p style="margin:0 0 6px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:${THEME.muted};">${escapeHtml(title)}</p>
                <h1 style="margin:0 0 12px;font-size:28px;line-height:1.2;font-weight:600;color:${THEME.ink};">${escapeHtml(variant.subject)}</h1>
                <p style="margin:0;font-size:16px;line-height:1.6;color:${THEME.body};">${escapeHtml(variant.intro)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  ${primaryCtaHtml}
                  ${sectionsHtml}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 28px 28px;border-top:1px solid ${THEME.line};">
                <p style="margin:16px 0 8px;font-size:12px;line-height:1.6;color:${THEME.muted};">
                  You are receiving this monthly edition because you subscribed to Volta updates.
                </p>
                <p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:${THEME.muted};">${ADDRESS_PLACEHOLDER}</p>
                <p style="margin:0;font-size:12px;line-height:1.6;color:${THEME.muted};">
                  <a href="${UNSUBSCRIBE_PLACEHOLDER}" style="color:${THEME.muted};text-decoration:underline;">Unsubscribe</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = renderPlainText(variant, context);
  const words = countWords(
    [
      variant.intro,
      ...variant.sections.flatMap((section) => section.items.map((item) => `${item.headline} ${item.copy}`)),
    ].join(" "),
  );

  return { html, text, readingMinutes: readingMinutes(words) };
}

export function renderPlainText(variant: GeneratedVariant, context: RenderContext): string {
  const tag = campaignTag(context, variant);
  const lines: string[] = [];

  if (context.draftBanner) lines.push("DRAFT - NOT SENT", "");
  lines.push(`VOLTA · ${monthLabel(context.monthKey).toUpperCase()}`, "", variant.subject, "", variant.intro, "");
  lines.push(`${variant.primaryCta.label}: ${addUtm(variant.primaryCta.url, tag)}`, "");

  for (const section of variant.sections) {
    lines.push(section.heading.toUpperCase(), "-".repeat(section.heading.length), "");
    for (const item of section.items) {
      const date = eventLine(context, item.sourceItemIds);
      lines.push(item.headline);
      if (date) lines.push(date);
      lines.push(item.copy);
      if (item.ctaUrl) lines.push(`${item.ctaLabel ?? "Read more"}: ${addUtm(item.ctaUrl, tag)}`);
      lines.push("");
    }
  }

  lines.push(
    "You are receiving this monthly edition because you subscribed to Volta updates.",
    ADDRESS_PLACEHOLDER,
    `Unsubscribe: ${UNSUBSCRIBE_PLACEHOLDER}`,
  );

  return lines.join("\n");
}

/** Source ledger shown in Slack and on the preview page. */
export function renderSourceLedger(variant: GeneratedVariant, factsPack: FactsPack): string {
  const used = new Set(
    variant.sections.flatMap((section) => section.items.flatMap((item) => item.sourceItemIds)),
  );
  const rows = factsPack.items
    .filter((item) => used.has(item.source_item_id))
    .map((item) => `• ${item.title}\n  ${item.url}`);
  return rows.join("\n");
}
