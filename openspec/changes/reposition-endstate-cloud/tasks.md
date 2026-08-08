## 1. Endstate Cloud rename (public copy only)

- [x] 1.1 Rename the pricing tier, cadence toggle aria-label, calls to action,
      description, and feature bullets in `src/app/endstate/page.tsx`, and the
      "Everything in Endstate Cloud" bullet in the Teams tier
- [x] 1.2 Rename the Terms definition (keeping a "(previously Hosted Backup)"
      parenthetical on first use), the subscription, acceptable use, privacy,
      payment-processing, and refund sections in `src/app/terms/page.tsx`
- [x] 1.3 Rename the account surface copy and mail subjects in
      `src/app/account/page.tsx` and `src/app/account/AccountView.tsx`, and
      update `src/app/account/AccountView.test.ts`
- [x] 1.4 Rename the claim page metadata, headings, body copy, and mail subjects
      in `src/app/endstate/claim/[token]/page.tsx`, keeping the in-app section
      label accurate and qualified
- [x] 1.5 Rename the subjects and bodies in `src/lib/email-templates/claim.ts`,
      keeping the in-app fallback instruction accurate and qualified, and update
      `src/lib/email-templates/__tests__/claim.test.ts`
- [x] 1.6 Rename the HowTo step text in `src/lib/structured-data.ts`
- [x] 1.7 Update `public/llms.txt` and `public/llms-full.txt`
- [x] 1.8 Record every deliberately retained internal identifier in
      `docs/naming.md` and cross-reference it from `README.md`

## 2. Support Endstate

- [x] 2.1 Add `src/lib/support-tiers.ts` with the config-driven tier array, the
      configured-tier filter, and the Custom Project Sponsor mail link
- [x] 2.2 Replace `openSupporterCheckout` with `openSupportCheckout(tier)` in
      `src/lib/paddle.ts`
- [x] 2.3 Replace the Supporter License pricing tier in
      `src/app/endstate/page.tsx` with a Support Endstate card that shows the
      lowest configured amount and links to `/endstate/supporters#support`
- [x] 2.4 Add `src/app/endstate/supporters/SupportTiers.tsx` rendering only
      configured tiers plus the Custom Project Sponsor option
- [x] 2.5 Add the Support Endstate section to
      `src/app/endstate/supporters/page.tsx`, keeping the `## Supporters`
      parsing contract and the opt-in recognition statement unchanged
- [x] 2.6 Update `src/app/endstate/supporters/layout.tsx` metadata
- [x] 2.7 Update the Terms sections that named the Supporter License
- [x] 2.8 Accept every configured support price in
      `src/app/api/license/webhook/route.ts` while keeping the existing €89
      price working, and cover it in
      `src/app/api/license/webhook/__tests__/route.test.ts`
- [x] 2.9 Document the Paddle setup in
      `docs/runbooks/support-endstate-paddle-setup.md`

## 3. Sponsor an integration

- [x] 3.1 Add `src/app/endstate/sponsor-an-integration/page.tsx` with the
      verbatim central explanation, the installation-versus-migration
      distinction, the stated limits, and the structured `mailto:` intake
- [x] 3.2 Add `src/app/endstate/sponsor-an-integration/layout.tsx` with metadata
      and breadcrumb structured data
- [x] 3.3 Link the page from the Endstate footer in
      `src/app/endstate/_shared.tsx`
- [x] 3.4 Add the route to `src/app/sitemap.ts`

## 4. Consistency

- [x] 4.1 Update the README content-discipline rules for both renames
- [x] 4.2 Add the new pages to `public/llms.txt` and `public/llms-full.txt`
- [x] 4.3 Confirm the Endstate software structured data still declares
      `operatingSystem: "Windows"` and that no price changed

## 5. Verification

- [x] 5.1 `npm run lint`
- [x] 5.2 `npm test`
- [x] 5.3 `npm run build`
- [x] 5.4 `npm run openspec:validate`
- [x] 5.5 Search the owned files for "Hosted Backup" and "Supporter License" and
      classify every survivor as a retained internal identifier, required
      historical text, or a defect; fix the defects
