# Tasks

## 1. Accepted-resource set (inert until configured)

- [ ] 1.1 Add the accepted-resource setting with `EXOMEM_CLOUD_MCP_URL` as fallback, in `cloud-config.ts`.
- [ ] 1.2 Derive the request resource per host in the gateway; replace the exact-equality checks with set membership plus per-host match at every call site.
- [ ] 1.3 Make the protected-resource metadata, the 401 challenge, the gateway-signed JWT issuer and the upload URL follow the request's resource.
- [ ] 1.4 Accept any listed `resource` at authorize and token; keep a refresh on its family's resource.
- [ ] 1.5 Test a token at its own host, at the other host and at an unlisted host; test a refresh with the old resource.

## 2. Public pages on evermatter.ai

- [ ] 2.1 Serve the public product pages on `evermatter.ai` and redirect their old paths with a 308; leave OAuth and app pages unchanged.
- [ ] 2.2 Move canonicals, the sitemap, structured data and the email wordmark link to `evermatter.ai`.

## 3. Email

- [ ] 3.1 Operator grant: authenticate `evermatter.ai` with the mail provider (DKIM, SPF, DMARC).
- [ ] 3.2 Send Cloud email as Evermatter from the new address.

## 4. Rollout (operator grant for each live step)

- [ ] 4.1 Add DNS, TLS and ingress for `mcp.evermatter.ai`; add `evermatter.ai` and `www.evermatter.ai` to the website project.
- [ ] 4.2 Configure the accepted-resource set on the web app and the gateway together.
- [ ] 4.3 Prove an existing connection at the old host and a new connection at the new host; record both.
- [ ] 4.4 Tell connected users through the service notices.
