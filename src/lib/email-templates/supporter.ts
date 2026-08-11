type SupporterThankYouParams = { tier: string };

/** Recognition is opt-in and intentionally handled outside the desktop app. */
export function renderSupporterThankYou({ tier }: SupporterThankYouParams) {
  const subject = "Thank you for supporting Endstate";
  const textContent = `Thank you for supporting Endstate as a ${tier}.

Your contribution unlocks nothing: Endstate's local product stays free and open source.

If you would like public recognition in SUPPORTERS.md, reply to this email with “yes, add my name” and the name you want shown. We will not add your name without your permission.

— Endstate`;
  const htmlContent = `<p>Thank you for supporting Endstate as a ${escapeHtml(tier)}.</p>
<p>Your contribution unlocks nothing: Endstate&rsquo;s local product stays free and open source.</p>
<p>If you would like public recognition in <code>SUPPORTERS.md</code>, reply to this email with <strong>“yes, add my name”</strong> and the name you want shown. We will not add your name without your permission.</p>
<p>&mdash; Endstate</p>`;
  return { subject, textContent, htmlContent };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!
  );
}
