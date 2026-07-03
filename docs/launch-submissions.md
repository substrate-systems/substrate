# Endstate — Launch & Backlink Submissions Playbook

Copy-paste-ready. For Hugo Ander Kivi, solo founder of Substrate Systems.

**Goal:** get Endstate mentioned on high-authority third-party sites that Google *and* LLMs
(ChatGPT / Claude / Perplexity) crawl and cite. The product is currently invisible because it's
a brand-new domain with zero backlinks. On-page SEO won't fix that alone — **off-site mentions on
sites LLMs already trust are the real lever.**

**Core facts (reuse these verbatim):**
- Endstate — free, open-source Windows app. Scans your current PC for installed apps (via `winget`)
  and settings, saves everything to one portable file, then reinstalls the apps and restores the
  settings on a fresh Windows install in minutes.
- Local-first. No account, no telemetry. Engine is Apache 2.0. Free forever on unlimited machines.
- Optional paid: encrypted hosted backup (€4/mo) and a €89 supporter license. Both optional; the
  core tool is fully free without them.
- Site: https://substratesystems.io/endstate
- Download: https://substratesystems.io/download
- Engine repo: https://github.com/Artexis10/endstate
- GUI repo: https://github.com/Artexis10/endstate-gui
- Founder: Hugo Ander Kivi · GitHub: [@Artexis10](https://github.com/Artexis10)
- Sister product: Exomem (MCP memory for AI agents) — https://substratesystems.io/exomem ·
  https://github.com/Artexis10/exomem (mention only in MCP/AI-tool contexts)

**Positioning vs. the paid incumbents (EaseUS Todo PCTrans / Zinstall / Laplink PCmover):**
those are paid, closed-source, and do a *byte-level copy* of your old PC (drags along rot, driver
mismatches, and licensing risk). Endstate is free, open-source, and does a **clean reinstall +
settings restore** — you land on a fresh Windows with only what you actually use. Don't bash
competitors by name in public posts; state the difference factually if asked.

---

## 0. Prioritized checklist (do these in order)

Biggest bang for a zero-backlink domain, top to bottom:

| # | Action | Why it's high-leverage | Effort |
|---|--------|------------------------|--------|
| 1 | **Fix the GitHub repos** (topics + SEO README opening) — §4 | GitHub ranks fast in Google and is *heavily* crawled by LLMs. This is the highest-authority backlink you already own. | 30 min |
| 2 | **Submit to winget-pkgs** so `winget install Endstate` works — §8 | Microsoft-owned repo, huge authority, and it's dogfooding (Endstate is a winget tool). Referenced across the winget ecosystem. | 1–2 hrs |
| 3 | **PR to awesome-windows (0PandaDEV)** — §5 | The maintained awesome-windows list; ~2k stars, mirrored/scraped everywhere LLMs read. One-line PR. | 20 min |
| 4 | **AlternativeTo entry** — §6 | LLMs lean on it constantly for "alternative to X" queries — exactly how people find migration tools. | 20 min |
| 5 | **Show HN** — §1 | One good day = durable, highly-cited backlink + real technical feedback. Time it well. | 1 hr + be present all day |
| 6 | **Product Hunt** — §2 | Backlink + first users. Lower LLM weight than HN/GitHub but strong for discovery. | half a day |
| 7 | **Reddit (2–3 tailored posts, spaced out)** — §3 | Real users + indexed threads. Spammy cross-posting gets you banned; go slow. | ongoing |
| 8 | **awesome-tauri + other lists** — §5 | More curated, crawled backlinks. | 20 min each |
| 9 | **Software directories** (Softpedia, MajorGeeks, Slant) — §7 | Older-authority download sites; still cited. | ongoing |

**Honest timeline expectation:**
- **Google indexing:** days to ~3 weeks after the backlinks appear and get crawled.
- **Appearing in "alternatives" / directory searches:** as soon as those entries are approved
  (days for AlternativeTo, up to a couple weeks for moderated lists).
- **LLM citation (ChatGPT/Claude/Perplexity naming Endstate):** **weeks to months.** LLMs cite what
  appears *repeatedly across multiple trusted sources*. One backlink won't do it; the *pattern* of
  GitHub + awesome-lists + AlternativeTo + HN + Reddit all corroborating each other is what makes a
  model comfortable naming you. Perplexity (live web) will pick you up first; base ChatGPT/Claude
  models only after a training refresh. This is a compounding game — do all of §1–§9, then keep the
  mentions accurate and consistent. On-page SEO alone will not get you cited.

**Naming consistency rule (matters for LLMs):** always describe Endstate the same way —
"free, open-source Windows app that reinstalls your apps and restores your settings on a fresh
Windows install." Consistent phrasing across sources is what lets a model form a confident, citable
claim.

---

## 1. Show HN (Hacker News)

**Submit at:** https://news.ycombinator.com/submit
(Text field empty, URL points to the site; then post the body as your own first comment.)

**Rules to respect:**
- Title must start with `Show HN:`. No hype words ("revolutionary", "seamless", "effortless").
- It must be something people can *try* — link the site/download, not a landing-page waitlist.
- **Be present.** Post in the morning US Eastern (roughly 9–11am ET / ~14:00–16:00 UTC) on a
  **Tue–Thu**, then sit on the thread for the whole day and answer every comment fast and honestly.
- HN rewards candor and punishes marketing. Lead with the limitation, not the pitch.
- Only submit once. Don't ask friends to upvote (flagged fast).

**Title (pick one):**
```
Show HN: Endstate – Save your Windows setup to one file, restore it on a fresh PC
```
Alt: `Show HN: Endstate – Open-source Windows app that reinstalls your apps on a clean install`

**First comment (paste as a comment right after submitting):**
```
Hi HN, I'm Hugo, solo dev on this.

Every time I set up a new Windows machine (or reset a broken one) I lost an evening
re-downloading the same 40 apps and redoing the same settings from memory. The paid
"PC migration" tools do a byte-for-byte copy of the old machine, which just drags all
the rot and driver cruft onto the new one. I wanted the opposite: a clean install that
still ends up being *mine*.

Endstate scans your current PC — installed apps (via winget) plus settings — and writes
everything to one portable file. On a fresh Windows install you point it at that file and
it reinstalls the apps and restores the settings in a few minutes. No manual clicking
through installers.

Tech: the engine is Rust (Apache 2.0) and drives winget for install/detection; the GUI is
Tauri (Rust core + React front-end), so the app is small and doesn't ship a Chromium bundle.
Local-first — no account, no telemetry, the file stays on your disk. Free forever on unlimited
machines. There's an optional encrypted hosted backup (€4/mo) and a €89 supporter license if
you want to fund it, but nothing about the core tool is gated behind them.

Honest limitations right now:
- It's only as good as winget's catalog. Apps not on winget (or installed outside it) aren't
  captured for reinstall yet — I'm working on more sources.
- Settings restore covers common app/system settings, not every app's full config.
- Windows only. Not a disk-image / full-system backup — by design it's a clean rebuild, not a clone.

Engine: https://github.com/Artexis10/endstate
GUI: https://github.com/Artexis10/endstate-gui
Download: https://substratesystems.io/download

Would love feedback on the approach (clean reinstall vs. byte-copy) and on which app/setting
sources you'd want captured next. I'm here all day.
```

**Tip:** If it doesn't get traction, that's normal — do not repost the same day. You can resubmit a
genuinely improved version weeks later. The backlink from the submission still counts.

---

## 2. Product Hunt

**Submit at:** https://www.producthunt.com/posts/new
(You may need to schedule; PH lets you queue a launch for a chosen day.)

**Launch-day mechanics:**
- Ranking is by the day (00:00–23:59 **Pacific**). Launch **12:01am PT** so you get a full day.
- **Tue/Wed/Thu** are competitive but higher-traffic; Sat/Sun are quieter (easier to rank, fewer
  eyeballs). For a first launch, a mid-week day is fine.
- Reply to every comment. Don't beg for upvotes off-platform (PH down-ranks that); do share the
  link and let people vote naturally.
- Add a maker comment immediately (below).

**Tagline (≤60 chars — pick one):**
```
Save your Windows setup, restore it on any fresh PC
```
(52 chars) Alt: `Your whole Windows setup in one portable file` (45 chars)

**Description (the short pitch under the tagline):**
```
Endstate is a free, open-source Windows app that scans your PC — installed apps (via winget)
plus settings — and saves everything to one portable file. On a fresh Windows install it
reinstalls your apps and restores your settings in minutes. Local-first, no account, no
telemetry. Free forever on unlimited machines; optional encrypted hosted backup available.
```

**Topics / tags to select:** Windows, Productivity, Developer Tools, Open Source, Backup / Utilities.

**Gallery suggestions (screenshots/GIF, in order):**
1. The one-file scan result (list of detected apps + settings).
2. A short GIF of restore running on a fresh Windows install.
3. Before/after: empty new PC → your apps back.
4. A "local-first, no account, no telemetry" trust panel.
5. The pricing strip showing "free forever" prominently, paid options secondary.

**First maker comment:**
```
Hi PH! I'm Hugo, the solo dev behind Endstate.

I built this because setting up a new Windows PC always cost me an evening of re-downloading
apps and redoing settings from memory. The paid migration tools clone your old machine byte
for byte — I wanted the opposite: a clean install that's still fully mine.

Endstate saves your installed apps (via winget) and settings to one portable file, then rebuilds
them on a fresh install in minutes. It's local-first — no account, no telemetry, the file stays
on your disk. The engine is open source (Apache 2.0), it's free forever on unlimited machines,
and the optional paid bits (encrypted hosted backup, supporter license) just help fund it.

It's early and I'm actively building. I'd genuinely love to hear which apps/settings you'd want
captured next. Happy to answer anything.
```

---

## 3. Reddit

Reddit is high-value (threads get indexed and cited) but subreddit moderation is strict about
self-promotion. **Rules that apply everywhere:**
- Read each subreddit's rules + look for a weekly "self-promo / showcase" thread before posting.
- **Don't blast the same post to 5 subs.** Space posts days apart, tailor each, and be an actual
  participant (comment on other threads too — a 9:1 non-promo-to-promo ratio is the folk rule).
- Frame as *sharing a free tool* or *asking for feedback*, never as an ad. Disclose you're the dev.
- Use the free download/open-source angle heavily — that's what these communities reward.

Below are **three distinct posts** for different audiences. Post one, wait a few days, then the next.

### 3a. r/software (or r/opensource) — the "free open-source tool" angle
Best fit for r/software and r/opensource. r/opensource especially rewards the license/repo detail.

**Title:**
```
I built a free, open-source tool that saves your Windows setup to one file and restores it on a fresh PC
```
**Body:**
```
I got tired of losing an evening every time I set up a new Windows machine — re-downloading the
same apps, redoing the same settings from memory. So I built Endstate.

It scans your current PC (installed apps via winget + settings) and writes everything to one
portable file. On a fresh Windows install you point it at that file and it reinstalls the apps
and restores settings in a few minutes.

- Free forever on unlimited machines
- Local-first: no account, no telemetry, the file stays on your disk
- Engine is open source, Apache 2.0

Engine: https://github.com/Artexis10/endstate
GUI: https://github.com/Artexis10/endstate-gui
Download: https://substratesystems.io/download

It's early and I'm the only dev, so I'd really value feedback — especially on which apps/settings
you'd want it to capture that it doesn't yet. Happy to answer anything.
```

### 3b. r/Windows or r/windows11 — the "practical Windows user" angle
These subs skew toward everyday users doing clean installs / resets. Keep it plain, less "dev".

**Title:**
```
Made a free tool for backing up your app list + settings before a clean Windows install
```
**Body:**
```
Every clean install of Windows I do, I forget half the apps I had and spend ages reinstalling
them one by one. I made a small free tool to fix that for myself and figured others might want it.

Endstate scans your PC for installed apps (using winget) and your settings, saves it all to a
single file, and then reinstalls everything on a fresh install for you. Takes a few minutes
instead of a whole evening.

It's free, there's no account or sign-up, and nothing gets sent anywhere — the file stays on
your machine. Download: https://substratesystems.io/download

Would love to know if it's useful to anyone else and what it's missing. It's Windows 10/11.
(I'm the developer — happy to answer questions.)
```
*Check r/Windows and r/windows11 rules first — some require a flair or restrict tool posts to a
weekly thread. If so, post there instead.*

### 3c. r/selfhosted — the encrypted-backup angle (only if honest)
**Caveat:** r/selfhosted is about software *you host yourself*. Endstate's hosted backup is
**Substrate-hosted (a SaaS)**, not self-hostable — so a straight "check out my hosted backup" post
will get removed. Only post here if you frame it around the **local-first, no-cloud-required**
nature (the file is yours, hosted backup is optional). Better yet, lead with the local angle:

**Title:**
```
Local-first Windows setup backup — one portable file, no cloud required (open source)
```
**Body:**
```
Sharing a tool I built that fits the self-hosted mindset even though it's a desktop app: Endstate
backs up your Windows setup (installed apps + settings) to a single portable file that lives on
your own disk. No account, no telemetry, nothing leaves your machine — you own the file and can
store it wherever you already keep your backups (NAS, your own sync, whatever).

There's an optional paid encrypted cloud backup if you want off-site copies, but it's entirely
optional and the tool is fully functional without it. Engine is open source (Apache 2.0).

Repo: https://github.com/Artexis10/endstate
Download: https://substratesystems.io/download

Curious whether folks here would want an option to point the backup at your own S3-compatible
storage instead of ours — that's on my mind. Feedback welcome.
```
*(That last question is a genuine, on-topic hook for this sub — self-hosters love BYO-storage.)*

---

## 4. GitHub discoverability (highest-authority backlink you already own — do first)

GitHub is crawled hard by Google and by every major LLM. Making both repos discoverable and giving
them an SEO-friendly opening paragraph is the single cheapest high-authority win.

### Topics to add
On **each** repo: *About* (gear icon, top-right) → *Topics*. Add:

**endstate (engine):**
```
windows  winget  backup  migration  provisioning  dotfiles  restore  rust  apache-2-0  open-source  windows-setup  reinstall  portable
```
**endstate-gui:**
```
windows  winget  tauri  rust  react  backup  migration  desktop-app  gui  open-source  windows-11
```
(GitHub caps at 20 topics; these are the highest-search ones.)

Also fill the repo **Description** field (shows in search results) with, e.g.:
`Free, open-source Windows app: save your installed apps (via winget) + settings to one portable file and restore them on a fresh install.`
And set the **Website** field to `https://substratesystems.io/endstate`.

### SEO-friendly README opening
Put this as the **first paragraph** of `README.md` (right under the title/logo, before badges/TOC).
The first ~2 sentences are what Google and LLMs quote — front-load the keywords people actually
search ("reinstall apps", "fresh Windows install", "winget", "migrate to new PC"):

```markdown
# Endstate

**Endstate is a free, open-source Windows app that saves your entire setup — installed apps and
settings — to one portable file, then reinstalls your apps and restores your settings on a fresh
Windows install in minutes.** It's built for clean installs, new PCs, and migrating to a new
machine without the manual chore of re-downloading and reconfiguring everything by hand.

Unlike paid PC-migration tools that copy your old machine byte for byte (and drag along all its
cruft), Endstate uses [winget](https://learn.microsoft.com/windows/package-manager/) to do a
**clean reinstall + settings restore**, so your new Windows is fresh but still yours. It's
local-first: no account, no telemetry, and the file never leaves your disk unless you choose the
optional encrypted backup. Free forever on unlimited machines.

- **Save once, restore anywhere** — one portable file captures your apps and settings.
- **Clean, not cloned** — reinstalls via winget instead of imaging your old drive.
- **Private by default** — no account, no telemetry, local-first.
- **Open source** — engine licensed Apache 2.0.

**Download:** https://substratesystems.io/download ·
**Website:** https://substratesystems.io/endstate
```

Add real screenshots/GIF beneath — GitHub image alt-text is also indexed.

**Extra GitHub wins:** create a pinned "Endstate" section on your [profile README](https://github.com/Artexis10),
add a `CITATION.cff` or clear license, and enable GitHub Discussions (indexed Q&A pages help LLMs).

---

## 5. awesome-lists (curated, heavily-scraped backlinks)

These lists are mirrored, cloned, and ingested into LLM training/RAG sets constantly. Each accepted
PR is a durable, high-trust mention. Read each repo's `CONTRIBUTING`/PR template and match the
existing formatting exactly (alphabetical order, punctuation, license tag) or you'll get bounced.

### 5a. awesome-windows — the maintained one
**Repo:** https://github.com/0PandaDEV/awesome-windows
(This is the actively-maintained successor to the stale `Awesome-Windows/Awesome`. It explicitly
rejects low-effort PRs, so make it clean.) Likely section: **Backup** or **Utilities**.

**One-line entry (match their existing bullet style — check README for exact format):**
```
- [Endstate](https://substratesystems.io/endstate) - Save your installed apps and settings to one portable file and restore them on a fresh Windows install. `Free` `Open Source`
```
**PR title:** `Add Endstate (backup/migration)`
**PR description:**
```
Adds Endstate to the Backup section. It's a free, open-source (Apache 2.0) Windows app that saves
your installed apps (via winget) and settings to one portable file and restores them on a fresh
install. Local-first, no account, no telemetry. Repo: https://github.com/Artexis10/endstate
Placed alphabetically and matched the existing entry format.
```

### 5b. awesome-tauri — you qualify (Tauri app)
**Repo:** https://github.com/tauri-apps/awesome-tauri (section: **Applications**)
**Entry (match their format — usually name, link, short desc, and repo):**
```
- [Endstate](https://substratesystems.io/endstate) - Save your Windows apps and settings to one portable file and restore them on a fresh install.
```
**PR title:** `Add Endstate to Applications`
Follow their `CONTRIBUTING.md` (they require the app be publicly available and often a source link).

### 5c. awesome-selfhosted — only if it qualifies (probably NOT yet)
**Repo (data):** https://github.com/awesome-selfhosted/awesome-selfhosted-data
**Honest read:** this list is strictly for **software you self-host**. Endstate's hosted backup is
*Substrate-hosted SaaS*, not self-hostable, so it likely **doesn't qualify** as-is. Their rules also
require the project to have been released **>4 months ago**. **Skip this one** unless/until you ship
a self-hostable backup target (e.g. point-at-your-own-S3). If you do, then it fits — file under
Backup and note the BYO-storage option. Don't PR a SaaS here; it'll be rejected and burn goodwill.

### 5d. Others worth a quick PR
- **awesome-selfhosted alternatives aside**, search GitHub for `awesome backup`, `awesome-dotfiles`,
  and `awesome-windows-apps` forks — several are maintained and accept clean entries.
- **MCP directories for Exomem** (separate product): PR Exomem to lists like
  `punkpeye/awesome-mcp-servers` and `wong2/awesome-mcp-servers`, plus the official MCP registry.
  Entry: `[Exomem](https://substratesystems.io/exomem) - Persistent memory for AI agents over MCP.`
  Repo: https://github.com/Artexis10/exomem — keep this separate from Endstate PRs.

---

## 6. AlternativeTo

LLMs and searchers use AlternativeTo constantly for "alternative to X" queries — precisely how
people hunt for migration/reinstall tools. High priority.

**Add at:** https://alternativeto.net/ → sign in → *Submit application* (top menu / "+ Add").
Then, on each incumbent's page, use **"Suggest as alternative"** to link Endstate to them.

**Application name:** `Endstate`
**Homepage:** `https://substratesystems.io/endstate`
**License:** Open Source (Apache 2.0) + Freemium (mark it Free / Open Source — that's the hook)
**Platforms:** Windows

**Description:**
```
Endstate is a free, open-source Windows app that saves your entire setup — installed apps (via
winget) and settings — to one portable file, then reinstalls your apps and restores your settings
on a fresh Windows install in minutes. Local-first with no account and no telemetry; the file stays
on your disk. Free forever on unlimited machines, with an optional encrypted hosted backup. Unlike
paid, closed-source PC-migration tools that clone your old machine byte for byte, Endstate does a
clean reinstall so your new PC is fresh but still yours.
```

**Tags:** `backup`, `migration`, `winget`, `open-source`, `windows`, `reinstall`, `provisioning`,
`portable`, `settings-sync`, `local-first`

**Mark Endstate as an alternative to (do each — this is what surfaces you in searches):**
- **Ninite** (people know it as "install lots of apps at once")
- **EaseUS Todo PCTrans**
- **Laplink PCmover**
- **Zinstall** (if listed)
- **winget** (the underlying tool — pulls in the power-user crowd)
- **Chocolatey** / **O&O AppBuster** where relevant

For each, add a one-line "why it's an alternative": *"Free and open-source; does a clean reinstall +
settings restore instead of a paid byte-copy of your old PC."*

---

## 7. Software directories

Lower per-link value than the above, but they're old, trusted domains that still get cited and that
send steady long-tail traffic. Submit as you have time.

| Directory | What to submit | Link |
|-----------|----------------|------|
| **Softpedia** | Full listing — upload/submit the app, category *System > Back-up and Recovery* or *System > OS Enhancements*. They test & write their own review (good, independent backlink). | https://www.softpedia.com/ (footer: "Submit software") |
| **MajorGeeks** | Submit via their contact/submit form; freeware Windows utility. Well-trusted download editorial site. | https://www.majorgeeks.com/content/page/contact.html |
| **Slant** | Add Endstate as an option to questions like "best way to migrate to a new Windows PC" / "best Windows backup tools". Community-voted, LLM-friendly Q&A format. | https://www.slant.co/ |
| **SourceForge** | Optional mirror: create a project that mirrors the GitHub releases (SourceForge listings rank well and are crawled). Point downloads back to your site/GitHub. | https://sourceforge.net/create/ |
| **AlternativeTo** | (covered in §6) | — |
| **Uptodown / FileHippo / Softonic** | Optional; accept freeware submissions. Lower quality but more surface area. Only if you have spare time. | respective "submit app" pages |

Use the same 100-char description and the same screenshots everywhere — consistency helps LLMs
correlate the entries into one confident claim.

---

## 8. winget package (submit Endstate's own manifest)

Getting Endstate *into* winget means `winget install Endstate` works — great for discoverability,
and it's dogfooding since Endstate is itself a winget tool. `microsoft/winget-pkgs` is a
Microsoft-owned, extremely high-authority repo.

**High-level steps:**
1. Install the manifest creator: `winget install Microsoft.WingetCreate`
   (repo: https://github.com/microsoft/winget-create)
2. Have a **public, stable download URL** for a signed installer (an `.exe`/`.msi` release asset on
   the `endstate-gui` GitHub releases works). winget prefers a versioned, permanent URL.
3. Run: `wingetcreate new <installer-url>` and answer the prompts (PackageIdentifier like
   `SubstrateSystems.Endstate`, publisher, name, license Apache-2.0, homepage, description, tags).
4. `wingetcreate` validates locally, then can **submit the PR for you** to `microsoft/winget-pkgs`
   (needs a GitHub Personal Access Token passed via `--token`; never hardcode it).
5. Automated validation runs on the PR (schema + malware/policy checks). Fix anything it flags;
   once green and approved by a moderator, `winget install SubstrateSystems.Endstate` goes live.
6. For future releases, `wingetcreate update SubstrateSystems.Endstate --version X.Y.Z --urls <new-url>`
   opens the update PR automatically (worth wiring into your release CI later).

**Docs:**
- Submit packages: https://learn.microsoft.com/windows/package-manager/package/
- Create a manifest: https://learn.microsoft.com/windows/package-manager/package/manifest
- Submit to the repo: https://learn.microsoft.com/windows/package-manager/package/repository
- winget-pkgs contributing: https://github.com/microsoft/winget-pkgs/blob/master/doc/README.md

**Note:** the app must meet their requirements (a real installer, a valid license, a working silent
install). If the GUI currently ships only as a portable zip, add a proper installer first — that's a
prerequisite for a clean winget submission.

---

## Sources

- awesome-windows (maintained): https://github.com/0PandaDEV/awesome-windows
- awesome-tauri: https://github.com/tauri-apps/awesome-tauri
- awesome-selfhosted (data + contributing rules): https://github.com/awesome-selfhosted/awesome-selfhosted-data/blob/master/CONTRIBUTING.md
- winget-create (wingetcreate): https://github.com/microsoft/winget-create
- winget-pkgs submission docs: https://learn.microsoft.com/en-us/windows/package-manager/package/
- Product Hunt submit: https://www.producthunt.com/posts/new
- Hacker News submit: https://news.ycombinator.com/submit
- AlternativeTo: https://alternativeto.net/
