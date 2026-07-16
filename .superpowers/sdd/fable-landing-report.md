# Fable landing port report

## Summary

Ported the approved Fable/Claude Design landing handoff to the Substrate homepage while preserving the authored responsive aurora hero and its separate Framer parallax system. The homepage remains a server component. The full editorial narrative is server-rendered; only the converging spine and progressive reveals hydrate as small client islands.

The port includes the linked Iceland photo credit, 20vh hero dissolve, lazy mirrored afterglow, 880px editorial composition, approved thesis/principle/product copy and order, exact product and footer link ownership, closing axiom, accessible focus/contrast treatment, three-strand 55vh spine, bidirectional node activation, no-JS and reduced-motion states, live preference changes, offscreen pause/resume, and complete observer/listener/rAF cleanup.

## Files

- `src/app/page.tsx` — server homepage composition.
- `src/app/globals.css` — dissolve, afterglow, editorial spine/node/product states, reduced-motion fallbacks, and credit timing.
- `src/components/Hero.tsx` — quiet `/photography` credit and in-hero dissolve.
- `src/components/Footer.tsx` — approved 880px restrained eight-link footer.
- `src/components/LandingNarrative.tsx` — complete server-rendered thesis, ordered principles, product index, afterglow, and closing axiom.
- `src/components/LandingSpine.tsx` — client-only converging spine enhancement.
- `src/components/LandingRevealManager.tsx` — client-only progressive reveals.
- `public/brand/materials/aurora-afterglow.jpg` — dedicated 19,220-byte afterglow derivative.
- `src/components/__tests__/fable-landing-contract.test.ts` — exact handoff/source contracts.
- `src/components/__tests__/landing-reduced-motion.dom.test.tsx` — SSR/no-JS, spine, reveal, reduced-motion, offscreen, directionality, and cleanup DOM contracts.
- `src/components/__tests__/aurora-home-contract.test.ts` — retained non-superseded aurora/photography/provenance contracts.

## RED record

Before production edits, ran:

```text
npm test -- src/components/__tests__/fable-landing-contract.test.ts
```

Expected result: exit 1. The repository script expanded the full suite and the new Fable contract failed on the absent port: `page.tsx` had no `LandingNarrative`; the narrative, spine, and reveal modules did not exist; the afterglow derivative was absent; and the footer still used `max-w-3xl`.

Verifier follow-up findings were also handled red-first:

- The DOM regression run failed because no-JS still contained the SVG and the tail lacked the required opacity.
- The credit contract failed because it still shared the 1.2s Explore animation instead of the approved 1.4s delay.

Both follow-up runs were green after the narrow fixes.

## Verification

- Focused landing tests: 11/11 passed.
- Full `npm test`: 562/562 passed.
- `npm run lint`: exit 0; 19 pre-existing warnings, no errors.
- Changed-file Prettier check: passed.
- Repository-wide `npm run format:check`: remains red on the pre-existing 171-file formatting backlog; no changed landing file is in that backlog.
- `npm run openspec:validate`: 18/18 passed.
- `npm run build`: passed; `/` prerendered static. Existing build-time warnings remain for missing local `DATABASE_URL` and package module type.
- `git diff --check`: passed.
- Independent verifier: no release blocker; all four medium findings and the credit timing nit were fixed before commit.
- Desktop browser check at 1440×900: approved composition/spine visible and no horizontal overflow.
- Portrait browser check: mobile hero derivative selected, optional photo credit hidden, and no horizontal overflow.
- Mobile network check: afterglow remained lazy and transferred 7,938 bytes as optimized WebP; the desktop hero request was aborted at the mobile breakpoint, so no second full hero was transferred.

## Commits

- `11f5945289bc09aff9c65127ea45ffc622127599` — implementation, assets, and tests.
- This report is committed separately; its hash is reported in the parent handoff because a commit cannot contain its own final hash.

## Residual risks and visual follow-up

- Run the exact persisted side-by-side capture set against all five Fable screenshots at their matching scroll positions. The local Chrome pass visually matched the hero and thesis/principle frames, but the tool could not save screenshots under this worktree path.
- Recheck a true 390×844 device viewport and the tablet portrait crop. The connected Chrome window enforced a 486px minimum outer width, although it selected the mobile source and showed the expected portrait layout.
- The repository-wide formatting gate is not independently green because of the existing 171-file backlog; changed files are clean.
- No push, PR, merge, archive, deployment, or production mutation was performed.
