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

## 3. Email

- [x] 3.1 Operator grant: authenticate `evermatter.ai` with the mail provider (DKIM, SPF, DMARC). Brevo reports the domain verified and authenticated (2026-11-24); DMARC is published; mail aligns through DKIM, and the apex SPF is the one Email Routing publishes.
- [ ] 3.2 Send Cloud email as Evermatter from the new address.

## 4. Rollout (operator grant for each live step)

- [ ] 4.1 Add DNS, TLS and ingress for `mcp.evermatter.ai`; add `evermatter.ai` and `www.evermatter.ai` to the website project.
- [ ] 4.2 Configure the accepted-resource set on the web app and the gateway together.
- [ ] 4.3 Prove an existing connection at the old host and a new connection at the new host; record both.
- [ ] 4.4 Operator grant: set `EXOMEM_PUBLIC_BASE_URL` to `https://evermatter.ai` on the web app and the gateway together; prove sign-in, a magic link and a new connection on the new host.
- [ ] 4.5 Tell connected users through the service notices.
