// Renders the canon: every screen and state in canon/jobs.json, from reference/boards, with the dc runtime (dcrt.js).
//   node docs/exomem-design/reference/tools/render-canon.js docs/exomem-design/canon/jobs.json /tmp/canon-png
// It writes PNGs; the committed images are the same renders as WebP (quality 82), with page-length screens trimmed
// to the page. Needs Playwright's Chromium. Set FORCE=1 to re-render files that exist.
// job: {id, board, props, w, h, wait, full}  full: crop to the component's own height (page-length screens)
const { chromium } = require("playwright");
const fs = require("fs"),
  path = require("path");
(async () => {
  const [jobsF, out] = process.argv.slice(2);
  const jobs = JSON.parse(fs.readFileSync(jobsF, "utf8"));
  const dir = process.env.BOARDS || path.join(__dirname, "..", "boards");
  const files = {};
  fs.readdirSync(dir)
    .filter((f) => f.endsWith(".dc.html"))
    .forEach((f) => {
      files[f.replace(".dc.html", "")] = fs.readFileSync(path.join(dir, f), "utf8");
    });
  const b = await chromium.launch();
  const ctx = await b.newContext({ deviceScaleFactor: 1 });
  for (const j of jobs) {
    const dst = path.join(out, j.id + ".png");
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.existsSync(dst) && !process.env.FORCE) continue;
    const p = await ctx.newPage({
      viewport: { width: j.w, height: j.full ? j.fullH || 4000 : j.h },
    });
    await p.setViewportSize({ width: j.w, height: j.full ? j.fullH || 4000 : j.h });
    const errs = [];
    p.on("pageerror", (e) => errs.push(e.message));
    await p.setContent(
      '<!doctype html><html><head><style>body{margin:0;background:#000}</style></head><body><div id="root"></div></body></html>'
    );
    await p.evaluate((f) => {
      window.__files = f;
    }, files);
    await p.addScriptTag({ path: path.join(__dirname, "dcrt.js") });
    await p.evaluate(
      ([n, pr]) => window.mountDC(n, pr, document.getElementById("root")),
      [j.board, j.props]
    );
    await p.waitForTimeout(j.wait || 3000);
    let clip = { x: 0, y: 0, width: j.w, height: j.h };
    if (j.full) {
      const bb = await p.evaluate(() => {
        const e = document.querySelector("#root > *:not(style):not(link)");
        const r = (e || document.body).getBoundingClientRect();
        return { h: Math.ceil(Math.max(r.height, document.querySelector("#root").scrollHeight)) };
      });
      clip.height = Math.min(bb.h, j.fullH || 4000);
    }
    await p.screenshot({ path: dst, clip });
    console.log(j.id, clip.width + "x" + clip.height, errs.length ? "ERR " + errs[0] : "");
    await p.close();
  }
  await b.close();
})();
