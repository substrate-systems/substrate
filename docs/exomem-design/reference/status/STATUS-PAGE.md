# Status page: free, off our servers

**Decision proposed:** Upptime (open source). GitHub Actions checks our endpoints every 5 minutes, opens a GitHub issue when something is down (that issue is the incident), and publishes a static status site to GitHub Pages at `status.exomem.io`. No server to rent, nothing on Hetzner, and it stays up when our servers don't, which is the point of a status page.

Cost: nothing, if the status repo is public (Actions minutes are free for public repos). The repo shows endpoint URLs and response times; health URLs are public anyway. Keep any token in repo secrets (`$NAME` in the config).

## What it shows (four lines, in the person's terms)

| Line on the page | What is checked | Where |
| --- | --- | --- |
| Website and sign-in | `GET https://exomem.io/` and `GET https://<control>/healthz` | Substrate control server |
| Your Exomem | `GET https://<cluster>/healthz`: 200 only when a canary note can be read and written | Exomem cluster |
| Sign-in emails | `GET https://<control>/healthz/email`: 200 when the last test send went through in the past hour | control server, calling the email provider |
| Payments | not probed: a navbar link to Paddle's own status page (paddlestatus.com; confirm the address before launch) | Paddle |

Health endpoints answer fast (under 1 s), take no auth, return `{"ok":true}` or a 503 with `{"ok":false}`, and say nothing about accounts.

## Setup (about 30 minutes, an agent can do it)

1. Create the repo from the Upptime template (github.com/upptime/upptime → "Use this template"), public, under the Substrate org: `exomem-status`.
2. Add a `GH_PAT` secret (fine-grained, this repo only: contents, issues, workflows read/write).
3. Replace `.upptimerc.yml` with `upptimerc.yml` beside this file; fill in the two hostnames. Check the `status-website` keys against the current Upptime docs (upptime.js.org/docs/configuration) as you go.
4. Copy `exomem-status.css` to `assets/exomem-status.css` (the theme, from our tokens) and the brand kit's `favicon.svg` and `exomem-wordmark-initial.svg` to `assets/`.
5. DNS: `status.exomem.io` CNAME to `substrate-systems.github.io` (the org's Pages host). Enable Pages on the `gh-pages` branch.
6. Build the three health endpoints (control `/healthz`, `/healthz/email`; cluster `/healthz`). Until they exist, point the lines at the site root and the API root.

Copy rules for incidents (the GitHub issue title is what people read): what is affected, in their terms, and what still works. "Saving is slow. Recall works, and nothing is lost." Close with what happened, in one line.
