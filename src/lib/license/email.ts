export async function sendLicenseEmail(params: {
  to: string;
  licenseKey: string;
}): Promise<void> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('BREVO_API_KEY is not set');
  const { to, licenseKey } = params;

  const html = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111; max-width: 560px; margin: 0 auto; padding: 32px;">
    <h1 style="font-size: 20px; margin: 0 0 16px;">Your Endstate License Key</h1>
    <p style="line-height: 1.6;">Thanks for your purchase. Your license key is below. Copy the entire block and paste it into the Endstate app when prompted.</p>
    <pre style="background: #f4f4f5; border: 1px solid #e4e4e7; border-radius: 6px; padding: 16px; font-size: 12px; white-space: pre-wrap; word-break: break-all;">${escapeHtml(licenseKey)}</pre>
    <p style="line-height: 1.6; color: #555; font-size: 14px;">This license activates Endstate on up to 3 devices. You can deactivate a device from the app at any time to free up a slot.</p>
    <p style="line-height: 1.6; color: #555; font-size: 14px;">If you need help, reply to this email.</p>
    <p style="color: #888; font-size: 12px; margin-top: 32px;">Substrate Systems</p>
  </body>
</html>`;

  const text = `Your Endstate License Key

Thanks for your purchase. Copy the entire block below and paste it into the Endstate app when prompted:

${licenseKey}

This license activates Endstate on up to 3 devices. You can deactivate a device from the app at any time to free up a slot.

If you need help, reply to this email.

Substrate Systems`;

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'Endstate', email: 'noreply@substratesystems.io' },
      to: [{ email: to }],
      subject: 'Your Endstate License Key',
      htmlContent: html,
      textContent: text,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`brevo error ${res.status}: ${detail || res.statusText}`);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
