export type LicenseKeyEmailInput = {
  licenseKey: string;
  email: string;
};

export type RenderedEmail = {
  subject: string;
  htmlContent: string;
  textContent: string;
};

const DOWNLOAD_URL = 'https://substratesystems.io/endstate';
const ENGINE_SOURCE_URL = 'https://github.com/Artexis10/endstate';

export function renderLicenseKeyEmail({
  licenseKey,
}: LicenseKeyEmailInput): RenderedEmail {
  const subject = 'Your Endstate license key';

  const htmlContent = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111; max-width: 560px; margin: 0 auto; padding: 32px; background: #ffffff;">
    <p style="font-size: 16px; line-height: 1.6; margin: 0 0 16px;">Thanks for buying Endstate. Your license key is below.</p>
    <pre style="background: #f4f4f5; border: 1px solid #e4e4e7; border-radius: 6px; padding: 16px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; margin: 0 0 16px;">${escapeHtml(licenseKey)}</pre>
    <p style="font-size: 14px; line-height: 1.6; color: #333; margin: 0 0 16px;">It activates on up to 3 machines — no account needed.</p>
    <p style="font-size: 14px; line-height: 1.6; color: #333; margin: 0 0 8px;">Download: <a href="${DOWNLOAD_URL}" style="color: #2563eb; text-decoration: underline;">substratesystems.io/endstate</a></p>
    <p style="font-size: 14px; line-height: 1.6; color: #333; margin: 0 0 16px;">Engine source: <a href="${ENGINE_SOURCE_URL}" style="color: #2563eb; text-decoration: underline;">github.com/Artexis10/endstate</a></p>
    <p style="font-size: 14px; line-height: 1.6; color: #333; margin: 0 0 16px;">Need help? Just reply to this email.</p>
    <p style="font-size: 14px; line-height: 1.6; color: #111; margin: 24px 0 0;">— Hugo, Substrate Systems</p>
  </body>
</html>`;

  const textContent = `Thanks for buying Endstate. Your license key is below.

${licenseKey}

It activates on up to 3 machines — no account needed.

Download: ${DOWNLOAD_URL}
Engine source: ${ENGINE_SOURCE_URL}

Need help? Just reply to this email.

— Hugo, Substrate Systems`;

  return { subject, htmlContent, textContent };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
