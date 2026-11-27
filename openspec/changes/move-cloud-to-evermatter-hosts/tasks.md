# Tasks

## 1. Accepted-resource set (inert until configured)

- [x] 1.1 Add the accepted-resource setting with `EXOMEM_CLOUD_MCP_URL` as fallback, in `cloud-config.ts`.
- [x] 1.2 Replace the exact-equality resource checks with set membership at every call site.
- [x] 1.3 Make the protected-resource metadata, the 401 challenge, the gateway-signed JWT issuer and the upload URL follow the request's resource.
- [x] 1.4 Accept any listed `resource` at authorize and token; keep a refresh on its family's resource.
- [x] 1.5 Test a token for each listed resource and for an unlisted one; test a refresh with the old resource.

## 2. Public pages on evermatter.ai

- [x] 2.1 Serve the public product pages on `evermatter.ai` and redirect their old paths with a 308; leave the OAuth API routes unchanged.
- [x] 2.3 Serve the app pages on the `EXOMEM_PUBLIC_BASE_URL` origin and redirect them there from the other host.
- [x] 2.2 Move canonicals, the sitemap, structured data and the email wordmark link to `evermatter.ai`.
- [x] 2.4 Serve the app pages at the root of `evermatter.ai` once it is the app origin, redirect their `/exomem/` addresses there with a 308, and build every outgoing app link in that form.
- [x] 2.5 Keep checkout and OAuth discovery working through the switch: a resumed checkout accepts Home under either app origin, and each app host's authorization-server metadata names its own issuer.
- [x] 2.6 Accept a start-form Turnstile token made on any app host, and refuse one made on any other host.

## 3. Email

- [x] 3.1 Operator grant: authenticate `evermatter.ai` with the mail provider (DKIM, SPF, DMARC). Brevo reports the domain verified and authenticated (2026-11-24); DMARC is published; mail aligns through DKIM, and the apex SPF is the one Email Routing publishes.
- [ ] 3.2 Send Cloud email as Evermatter from the new address.

## 4. Rollout (operator grant for each live step)

- [ ] 4.1 Add DNS, TLS and ingress for `mcp.evermatter.ai`. The DNS record exists since 2026-11-27; TLS and ingress wait for the platform chart roll.
- [x] 4.6 Add `evermatter.ai` and `www.evermatter.ai` to the website project. Live since 2026-11-25.
- [x] 4.7 Set `EVERMATTER_SITE_ORIGIN` to `https://evermatter.ai` on the web app (migration step 5). Live: `https://substratesystems.io/exomem/docs` returns a 308 to `https://evermatter.ai/docs`.
- [ ] 4.2 Configure the accepted-resource set on the web app and the gateway together.
- [ ] 4.3 Prove an existing connection at the old host and a new connection at the new host; record both.
- [ ] 4.4 Operator grant: move sign-in on the web app only (migration step 6). The gateway keeps `EXOMEM_PUBLIC_BASE_URL` on `https://substratesystems.io`. Every prerequisite holds before the switch: TLS on `evermatter.ai` (4.6), `EVERMATTER_SITE_ORIGIN` on the web app (4.7), tasks 2.5 and 2.6 deployed, and steps 1 to 3 below done. The step does not wait for 3.2, 4.1, 4.2 or 4.3.
  1. Add `evermatter.ai` to the Turnstile widget's hostnames, and confirm that Cloudflare lists it.
  2. Request `evermatter.ai` as a checkout domain in Paddle, live and sandbox. Wait until Paddle reports both approved; live approval is a review that can take days.
  3. If the account-level default payment link names `https://substratesystems.io/exomem/home`, change it to `https://evermatter.ai/home`. Keep any other value.
  4. Set the web app's `EXOMEM_PUBLIC_BASE_URL` to `https://evermatter.ai` and redeploy the web app.
  5. Request a magic link to a Gmail, an Outlook.com and an iCloud mailbox. Each arrives in the inbox and opens sign-in on `evermatter.ai`.
  6. With a connection made before the switch, refresh through its stored token endpoint on `substratesystems.io`, then discover afresh from its MCP URL. The refresh succeeds, and the discovered issuer is `https://substratesystems.io/api/exomem/oauth`.
  7. Connect a new client. Consent completes on `evermatter.ai`, and the client calls the MCP URL with its token.
  8. With a test owner awaiting checkout, open checkout on `https://evermatter.ai/home` in live mode. Close it unpaid when Paddle shows the payment form, then delete the test account, which cancels the transaction.
- [ ] 4.5 Tell connected users through the service notices.
