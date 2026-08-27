/**
 * Outbound mail — Phase 0, one message type: a temporary password.
 *
 * Configuration is environment only (TECHSTACK A13): SMTP_HOST, SMTP_PORT,
 * SMTP_USER, SMTP_PASS and MAIL_FROM. When they are absent the system is not
 * broken, it is simply offline for mail — `isConfigured()` says so and the
 * screens fall back to showing the secret once to the administrator.
 */
import nodemailer from 'nodemailer';

export interface MailSettings {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly from: string;
  readonly appUrl: string;
}

export function settings(): MailSettings | null {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  if (!host || !user || !pass) return null;
  return {
    host,
    port: Number(process.env.SMTP_PORT ?? '465'),
    user,
    pass,
    from: process.env.MAIL_FROM?.trim() || user,
    appUrl: process.env.BETTER_AUTH_URL?.trim() || 'https://erp.qs-groups.com',
  };
}

export function isConfigured(): boolean {
  return settings() !== null;
}

function transport(config: MailSettings) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
  });
}

export interface TemporaryPasswordMail {
  readonly to: string;
  readonly displayName: string;
  readonly password: string;
  /** 'created' for a new account, 'reset' for an administrative reset. */
  readonly reason: 'created' | 'reset';
  readonly companyName: string;
}

/**
 * Sends the temporary password. Returns true when the message was accepted by
 * the SMTP server; false when mail is not configured. A transport failure
 * throws, so the caller can fall back to showing the secret rather than
 * claiming it was sent.
 */
export async function sendTemporaryPassword(mail: TemporaryPasswordMail): Promise<boolean> {
  const config = settings();
  if (!config) return false;

  const subject =
    mail.reason === 'created'
      ? `${mail.companyName} ERP — your account`
      : `${mail.companyName} ERP — your password was reset`;
  const intro =
    mail.reason === 'created'
      ? 'An account has been created for you.'
      : 'An administrator has reset your password.';

  const text = [
    `Hello ${mail.displayName},`,
    '',
    intro,
    '',
    `Sign in: ${config.appUrl}/sign-in`,
    `Email: ${mail.to}`,
    `Temporary password: ${mail.password}`,
    '',
    'You will be asked to choose a new password after signing in.',
    'If you did not expect this message, tell your system administrator.',
  ].join('\n');

  const html = `
    <div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;color:#0d1d4e">
      <h2 style="margin:0 0 12px">${mail.companyName} ERP</h2>
      <p>Hello ${escape(mail.displayName)},</p>
      <p>${intro}</p>
      <table style="border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:6px 12px 6px 0;color:#596884">Sign in</td><td><a href="${config.appUrl}/sign-in">${config.appUrl}/sign-in</a></td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#596884">Email</td><td>${escape(mail.to)}</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#596884">Temporary password</td><td><code style="font-size:16px;letter-spacing:.04em">${escape(mail.password)}</code></td></tr>
      </table>
      <p>You will be asked to choose a new password after signing in.</p>
      <p style="color:#596884;font-size:12px">If you did not expect this message, tell your system administrator.</p>
    </div>`;

  await transport(config).sendMail({ from: config.from, to: mail.to, subject, text, html });
  return true;
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
