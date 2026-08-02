// Minimal Resend REST client — one call: POST /emails. We deliberately do NOT
// pull the official @resend/node SDK: it adds several transitive deps for a
// single JSON POST, and we already control retries + rate-limits in the
// dispatcher. If Resend adds features we need (batching, scheduling), swap
// this file for the SDK — the surface stays the same.
export interface SendEmailInput {
  to: string;
  subject: string;
  html?: string;
  text: string;
}

export interface ResendResult {
  id: string;
}

export class EmailSendError extends Error {
  constructor(public status: number, public body: string) {
    super(`Resend HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

const RESEND_URL = "https://api.resend.com/emails";

/** Send one email. Throws EmailSendError on non-2xx so the dispatcher can
 *  distinguish transient (5xx / 429 → retry) from permanent (4xx → skip). */
export async function sendEmail(input: SendEmailInput): Promise<ResendResult> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) {
    throw new EmailSendError(0, "RESEND_API_KEY or EMAIL_FROM not set");
  }
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
    }),
  });
  if (!res.ok) {
    throw new EmailSendError(res.status, await res.text());
  }
  return (await res.json()) as ResendResult;
}

/** True when 429 or 5xx — dispatcher should retry rather than mark permanent. */
export function isTransientEmailError(e: unknown): boolean {
  if (!(e instanceof EmailSendError)) return true; // network / timeout etc
  return e.status === 429 || e.status >= 500;
}
