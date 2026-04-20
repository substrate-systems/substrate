export type LicenseKeyEmailInput = {
  licenseKey: string;
  email: string;
};

export type RenderedEmail = {
  subject: string;
  htmlContent: string;
  textContent: string;
};

const DOWNLOAD_URL = 'https://substratesystems.io/download';
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
    <p style="font-size: 14px; line-height: 1.6; color: #333; margin: 0 0 16px;"><a href="${DOWNLOAD_URL}" style="display: inline-block; background: #111; color: #fff; text-decoration: none; padding: 10px 18px; border-radius: 6px; font-weight: 600;">Download Endstate</a></p>
    <p style="font-size: 14px; line-height: 1.6; color: #333; margin: 0 0 16px;">It activates on up to 3 machines — no account needed.</p>
    <div style="border-top: 1px solid #e4e4e7; margin: 24px 0 0; padding-top: 20px;">
      <p style="font-size: 13px; font-weight: 600; color: #555; margin: 0 0 10px;">A note on the installer</p>
      <p style="font-size: 13px; line-height: 1.65; color: #555; margin: 0 0 12px;">When running the installer, Windows Defender SmartScreen may show a warning (&ldquo;Windows protected your PC&rdquo;). This is standard for new software that hasn&rsquo;t built an established reputation yet — we&rsquo;re in the process of getting a code-signing certificate to remove this warning.</p>
      <p style="font-size: 13px; line-height: 1.65; color: #555; margin: 0 0 12px;">To proceed: click &ldquo;More info&rdquo; in the warning dialog, then &ldquo;Run anyway.&rdquo;</p>
      <p style="font-size: 13px; line-height: 1.65; color: #555; margin: 0;">The engine that installs software on your machine is fully open source — you can verify what it does before running it: <a href="${ENGINE_SOURCE_URL}" style="color: #2563eb; text-decoration: underline;">github.com/Artexis10/endstate</a></p>
    </div>
    <p style="font-size: 14px; line-height: 1.6; color: #333; margin: 24px 0 16px;">Need help? Just reply to this email.</p>
    <p style="font-size: 14px; line-height: 1.6; color: #111; margin: 0;">— Hugo, Substrate Systems</p>
  </body>
</html>`;

  const textContent = `Thanks for buying Endstate. Your license key is below.

${licenseKey}

Download Endstate: ${DOWNLOAD_URL}

It activates on up to 3 machines — no account needed.

------------------------------------------------------------

A note on the installer

When running the installer, Windows Defender SmartScreen may show a warning ("Windows protected your PC"). This is standard for new software that hasn't built an established reputation yet — we're in the process of getting a code-signing certificate to remove this warning.

To proceed: click "More info" in the warning dialog, then "Run anyway."

The engine that installs software on your machine is fully open source — you can verify what it does before running it: ${ENGINE_SOURCE_URL}

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
