// The supplied A + loop engine, scoped to one mounted graph.
const NS = "http://www.w3.org/2000/svg";
const reducedQ = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const mk = (tag, attrs, parent) => {
  const el = document.createElementNS(NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(el);
  return el;
};
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

class Alive {
  constructor(svg, pointer) {
    this.pointer = pointer;
    this.timeouts = new Set();
    this.svg = svg;
    this.mode = svg.getAttribute("data-alive");
    let g = {};
    try {
      g = JSON.parse(svg.getAttribute("data-graph") || "{}");
    } catch {}
    this.N = (g.n || []).map(([x, y, r]) => ({ x, y, r: r || 3 }));
    this.E = (g.e || []).filter(([i, j]) => this.N[i] && this.N[j]);
    this.adj = this.N.map(() => []);
    this.E.forEach(([i, j], k) => {
      this.adj[i].push([j, k]);
      this.adj[j].push([i, k]);
    });
    this.ink = svg.getAttribute("data-ink");
    this.amber = svg.getAttribute("data-amber");
    this.phosphor = svg.getAttribute("data-phosphor");
    const vb = (svg.getAttribute("viewBox") || "0 0 100 100").split(/[ ,]+/).map(Number);
    this.vb = vb;
    const en = (svg.getAttribute("data-entry") || "").split(",").map(Number);
    this.entry =
      en.length === 2 && !isNaN(en[0])
        ? { x: en[0], y: en[1] }
        : { x: vb[0] + vb[2] / 2, y: vb[1] + vb[3] };
    this.reduced = reducedQ();
    this.amb = mk("g", { class: "exo-alive-amb", "pointer-events": "none" }); // under the page's own notes and links
    this.root = mk("g", { class: "exo-alive", "pointer-events": "none" }); // events and hover, on top
    this.hov = mk("g", {}, this.root);
    this.evt = mk("g", {}, this.root);
    // CSS hash colour channels are a fixed field format, not a meaning decision.
    const hx = (this.ink.match(/[0-9a-f]{2}/gi) || ["00", "00", "00"])
      .slice(0, 3)
      .map((v) => parseInt(v, 16));
    this.k = (0.299 * hx[0] + 0.587 * hx[1] + 0.114 * hx[2]) / 255 < 0.5 ? 0.6 : 1; // dark ink on paper reads stronger
    // moving ink matches dark mode's contrast, not its opacity: light on black pops, grey on paper hides (WCAG luminance, solved per alpha)
    const lin = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      },
      unlin = (L) => 255 * (L <= 0.00304 ? L * 12.92 : 1.055 * Math.pow(L, 1 / 2.4) - 0.055);
    const light = this.k < 1,
      G = light ? 248 : 9,
      I = hx[1];
    this.par = (a) => {
      if (!light) return a;
      const cr = (lin(9 + a * (233 - 9)) + 0.05) / (lin(9) + 0.05),
        L = (lin(G) + 0.05) / cr - 0.05;
      return Math.min(0.9, Math.max(a, (G - unlin(Math.max(0, L))) / (G - I)));
    };
    this.items = [];
    this.t0 = performance.now();
    this.next = {};
    this.born = [];
    this.lenMed = this.E.length
      ? this.E.map(([i, j]) =>
          Math.hypot(this.N[i].x - this.N[j].x, this.N[i].y - this.N[j].y)
        ).sort((a, b) => a - b)[Math.floor(this.E.length / 2)]
      : 60;
    this.unit = Math.max(vb[2], vb[3]) / 1000; // speeds scale with the drawing

    this.svg.insertBefore(this.amb, this.svg.firstChild);
    this.svg.appendChild(this.root);
    if (svg.getAttribute("data-hover") === "glow") this.hoverOn = true;
    if (this.hoverOn && this.reduced)
      this.hovT = setInterval(() => {
        if (!this.alive()) clearInterval(this.hovT);
        else this.hoverStep();
      }, 120);
    this.loop = this.loop.bind(this);
    if (!this.reduced) this.raf = requestAnimationFrame(this.loop);
  }
  trim(i, j) {
    return trimEdge(this.N[i], this.N[j]);
  }
  line(a, b, attrs, parent) {
    return mk(
      "line",
      {
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        "vector-effect": "non-scaling-stroke",
        "stroke-linecap": "round",
        ...attrs,
      },
      parent || this.amb
    );
  }
  dot(p, r, attrs, parent) {
    return mk("circle", { cx: p.x, cy: p.y, r, ...attrs }, parent || this.amb);
  }
  alive() {
    return this.svg.isConnected;
  }
  loop(now) {
    // never let one bad frame stop the engine with half-drawn pulses frozen on screen (seen on canvas): schedule first, then draw
    if (this.destroyed) return;
    if (!this.alive()) {
      // the host may detach and re-attach the svg (a re-render); wait a while before giving up, and clear what was drawn
      this.items.forEach((it) => it.el?.remove());
      this.items = [];
      while (this.evt.firstChild) this.evt.firstChild.remove();
      while (this.hov.firstChild) this.hov.firstChild.remove();
      this.hovI = -1;
      this.destroy();
      return;
    }
    this.gone = 0;
    this.raf = requestAnimationFrame(this.loop);
    try {
      if (!this.root.isConnected) this.svg.appendChild(this.root); // a host re-render dropped the layers: put them back
      if (!this.amb.isConnected) this.svg.insertBefore(this.amb, this.svg.firstChild);
      if (this.hoverOn) this.hoverStep();
      if (!document.hidden) {
        const t = (now - this.t0) / 1000;
        this.tick(t);
        const cur = this.items;
        this.items = [];
        const keep = cur.filter((it) => {
          try {
            return it.step(t) !== false;
          } catch {
            it.el?.remove();
            return false;
          }
        });
        this.items = keep.concat(this.items);
      }
    } catch {
      this.items.forEach((it) => it.el?.remove());
      this.items = [];
      this.busy = false;
    }
  }
  every(key, gap, t, fn) {
    if (this.next[key] === undefined) this.next[key] = t + gap * Math.random();
    if (t >= this.next[key]) {
      this.next[key] = t + gap * rnd(0.75, 1.25);
      fn();
    }
  }
  tick(t) {
    if (!this.N.length) return;
    if (this.mode === "loop")
      this.every("pulse", 3.4 / Math.max(1, Math.min(2, this.E.length / 40)), t, () =>
        this.pulse(t, false)
      );
    // loop: today's walking light stays as the idle state (amber where the page already had it; ink on Home, data-walk="ink"); it steps aside while a real event plays
    if (this.mode === "loop" && this.svg.getAttribute("data-walk") === "ink")
      this.every("walk", 3.8, t, () => {
        if (!this.busy) this.pulse(t, false, null, null, true);
      });
    if (this.working)
      this.every("work", this.workAmber ? 0.55 : 0.7, t, () => {
        const V = this.workClear ? this.visible(this.workClear) : null;
        if (!V) return this.pulse(t, false, null, null, true);
        const from = this.N.map((_, i) => i).filter(
          (i) => V.n[i] && this.adj[i].some(([j]) => V.e(i, j))
        );
        if (!from.length) return;
        // toward: the work flows into the thing that is working (the checkout panel), arriving from different sides
        const el = this.workToward && document.querySelector(this.workToward),
          r = el && el.getBoundingClientRect(),
          sr = this.svg.getBoundingClientRect();
        if (r && r.width && sr.width) {
          const k = this.vb[2] / sr.width,
            bx = [this.vb[0] + (r.left - sr.left) * k, this.vb[0] + (r.right - sr.left) * k],
            by = [this.vb[1] + (r.top - sr.top) * k, this.vb[1] + (r.bottom - sr.top) * k];
          const dist = (i) => {
            const p = this.N[i],
              dx = Math.max(bx[0] - p.x, 0, p.x - bx[1]),
              dy = Math.max(by[0] - p.y, 0, p.y - by[1]);
            return Math.hypot(dx, dy);
          };
          const ends = from
              .slice()
              .sort((a, b) => dist(a) - dist(b))
              .slice(0, 6)
              .filter((i) => i !== this.lastWork),
            target = pick(ends.length ? ends : from);
          this.lastWork = target;
          const d = new Map([[target, 0]]),
            q = [target];
          while (q.length) {
            const u = q.shift();
            for (const [v] of this.adj[u])
              if (!d.has(v) && V.n[v] && V.e(u, v)) {
                d.set(v, d.get(u) + 1);
                q.push(v);
              }
          }
          const far = [...d].filter(([, n]) => n >= 2 && n <= 4).map((x) => x[0]);
          if (far.length) {
            const path = this.route(pick(far), target, (i) => V.n[i], V.e);
            if (path && path.length > 1)
              return this.workAmber
                ? this.pulse(t, true, path, () => this.glow(target, true), false, {
                    a0: 0.7,
                    w: 1.4,
                    speed: 140,
                  })
                : this.pulse(t, false, path, () => this.glow(target), true);
          }
        }
        this.pulse(t, false, this.walk(pick(from), Math.floor(rnd(2, 5)), V.e), null, true);
      });
  }
  // ---- current: faint ink pulses chain across two to five links — the system carrying, not recalling
  glow(i, am) {
    const p = this.N[i];
    if (!p || this.reduced) return;
    const a = am ? 0.85 : this.par(0.55),
      g = this.dot(
        p,
        p.r + (am ? 1.4 : 2.2),
        { fill: am ? this.amber : this.ink, opacity: a },
        am ? this.evt : this.amb
      ),
      g0 = performance.now();
    this.items.push({
      el: g,
      step: () => {
        const k = (performance.now() - g0) / 700;
        if (k >= 1) {
          g.remove();
          return false;
        }
        g.setAttribute("opacity", (a * (1 - k)).toFixed(3));
      },
    });
  }
  walk(from, hops, eok) {
    const path = [from];
    let k = 0;
    while (path.length <= hops && k++ < 20) {
      const u = path[path.length - 1],
        nb = this.adj[u].filter(([j]) => !path.includes(j) && (!eok || eok(u, j)));
      if (!nb.length) break;
      path.push(pick(nb)[0]);
    }
    return path;
  }
  // which notes and links can actually be seen: on screen, and not under the page's own text or panels (sel: the content to keep clear of).
  // Empty layout boxes don't count; text, controls, pictures and anything with a fill or border does.
  visible(sel) {
    const now = performance.now();
    if (this.visC && this.visC.sel === sel && now - this.visC.at < 900) return this.visC;
    const r = this.svg.getBoundingClientRect(),
      vb = this.vb;
    if (!r.width) return null;
    const sx = r.width / vb[2],
      sy = r.height / vb[3],
      memo = new Map();
    const solid = (el) => {
      if (memo.has(el)) return memo.get(el);
      let v = false;
      // These are fixed HTML element names; the match checks the DOM tag, not HTML source.
      if (
        /^(svg|img|input|button|select|textarea|iframe|canvas|video)$/i.test(el.tagName) ||
        (el.closest("svg") && !el.closest("svg[data-alive]"))
      )
        v = true;
      else if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) v = true;
      else {
        const cs = getComputedStyle(el),
          bg = cs.backgroundColor.match(/[\d.]+/g);
        v =
          (bg && (bg.length < 4 || +bg[3] > 0.02)) ||
          cs.backgroundImage !== "none" ||
          cs.boxShadow !== "none" ||
          parseFloat(cs.borderTopWidth) > 0 ||
          parseFloat(cs.borderLeftWidth) > 0;
      }
      memo.set(el, v);
      return v;
    };
    const free = (x, y) => {
      if (x < 2 || y < 2 || x > innerWidth - 2 || y > innerHeight - 2) return false;
      let el = document.elementFromPoint(x, y);
      if (!el) return false;
      for (; el && el.matches && el.matches(sel + " *"); el = el.parentElement)
        if (solid(el)) return false;
      return true;
    };
    const at = (x, y) => free(r.left + (x - vb[0]) * sx, r.top + (y - vb[1]) * sy);
    const n = this.N.map((p) => at(p.x, p.y)),
      ec = new Map();
    const e = (i, j) => {
      const key = i < j ? i + "-" + j : j + "-" + i;
      if (ec.has(key)) return ec.get(key);
      let v = n[i] && n[j];
      for (let k = 1; v && k < 5; k++) {
        const t = k / 5;
        v = at(
          this.N[i].x + (this.N[j].x - this.N[i].x) * t,
          this.N[i].y + (this.N[j].y - this.N[i].y) * t
        );
      }
      ec.set(key, v);
      return v;
    };
    return (this.visC = { sel, at: now, n, e });
  }
  pulse(t, amber, path, onArrive, bright, st) {
    path =
      path ||
      this.walk(Math.floor(Math.random() * this.N.length), Math.floor(rnd(2, bright ? 5 : 4)));
    if (path.length < 2) return;
    const pts = path.map((i) => (typeof i === "number" ? this.N[i] : i));
    const col = amber ? this.amber : this.ink,
      layer = amber ? this.evt : this.amb;
    const speed = (st && st.speed) || (amber ? 170 : bright ? 80 : 55),
      a0 = (st && st.a0) || (amber ? 0.8 : this.par(bright ? 0.5 : 0.34)),
      fade = amber ? 0.9 : 0.8;
    const segs = [];
    let acc = 0;
    for (let h = 0; h < pts.length - 1; h++) {
      let a = pts[h],
        b = pts[h + 1];
      if (typeof path[h] === "number" && typeof path[h + 1] === "number")
        [a, b] = this.trim(path[h], path[h + 1]);
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      segs.push({
        a,
        b,
        el: this.line(
          a,
          a,
          { stroke: col, "stroke-width": (st && st.w) || (amber ? 1.6 : 1.1), opacity: 0 },
          layer
        ),
        t0: acc,
        dur: L / speed,
        node: path[h + 1],
      });
      acc += L / speed;
    }
    const glint = (i) => {
      const p = this.N[i];
      if (!p) return;
      const ga = amber ? 0.9 : this.par(bright ? 0.5 : 0.28),
        g = this.dot(p, p.r + 1, { fill: col, opacity: ga }, layer),
        g0 = performance.now();
      this.items.push({
        el: g,
        step: () => {
          const k = (performance.now() - g0) / (amber ? 900 : 800);
          if (k >= 1) {
            g.remove();
            return false;
          }
          g.setAttribute("opacity", (ga * (1 - k)).toFixed(3));
        },
      });
    };
    const start = performance.now();
    this.items.push({
      el: segs[0].el,
      step: () => {
        const s = (performance.now() - start) / 1000;
        let live = false;
        segs.forEach((g, n) => {
          const k = (s - g.t0) / g.dur;
          if (k < 0) {
            live = true;
            return;
          }
          if (k <= 1) {
            const e = ease(k);
            g.el.setAttribute("x2", (g.a.x + (g.b.x - g.a.x) * e).toFixed(1));
            g.el.setAttribute("y2", (g.a.y + (g.b.y - g.a.y) * e).toFixed(1));
            g.el.setAttribute("opacity", a0.toFixed(3));
            live = true;
            return;
          }
          if (!g.done) {
            g.done = true;
            g.el.setAttribute("x2", g.b.x);
            g.el.setAttribute("y2", g.b.y);
            if (typeof g.node === "number") glint(g.node);
            if (n === segs.length - 1 && onArrive) onArrive();
          }
          const f = (s - g.t0 - g.dur) / fade;
          if (f < 1) {
            g.el.setAttribute("opacity", (a0 * (1 - f)).toFixed(3));
            live = true;
          } else if (g.el.isConnected) g.el.remove();
        });
        if (!live) {
          segs.forEach((g) => g.el.remove());
          return false;
        }
      },
    });
  }
  ripple(p) {
    const el = this.dot(
        p,
        3,
        {
          fill: "none",
          stroke: this.amber,
          "stroke-width": 1.2,
          "vector-effect": "non-scaling-stroke",
          opacity: 0.7,
        },
        this.evt
      ),
      t0 = performance.now(),
      R = this.lenMed * 1.8;
    this.items.push({
      el,
      step: () => {
        const k = Math.min(1, (performance.now() - t0) / 1600);
        el.setAttribute("r", (3 + R * ease(k)).toFixed(1));
        el.setAttribute("opacity", (0.7 * (1 - k)).toFixed(2));
        if (k >= 1) {
          el.remove();
          return false;
        }
      },
    });
  }
  light(i, ms) {
    const p = this.N[i];
    if (!p) return;
    const halo = this.dot(
        p,
        p.r + 6,
        { fill: this.k < 1 ? this.phosphor : this.amber, opacity: 0 },
        this.evt
      ),
      core = this.dot(p, p.r + 0.8, { fill: this.amber, opacity: 0 }, this.evt),
      t0 = performance.now();
    this.items.push({
      el: core,
      step: () => {
        const s = (performance.now() - t0) / ms,
          a = s < 0.15 ? s / 0.15 : s > 0.7 ? Math.max(0, (1 - s) / 0.3) : 1;
        core.setAttribute("opacity", a.toFixed(2));
        halo.setAttribute("opacity", ((this.k < 1 ? 0.3 : 0.16) * a).toFixed(3));
        if (s >= 1) {
          core.remove();
          halo.remove();
          return false;
        }
      },
    });
  }
  nearest(p, ok) {
    let b = 0,
      bd = 1e9;
    this.N.forEach((q, i) => {
      if (ok && !ok(i)) return;
      const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (d < bd) {
        bd = d;
        b = i;
      }
    });
    return b;
  }
  route(a, b, ok, eok) {
    const prev = new Map([[a, -1]]),
      q = [a];
    while (q.length) {
      const u = q.shift();
      if (u === b) break;
      for (const [v] of this.adj[u])
        if (!prev.has(v) && (!ok || ok(v) || v === b) && (!eok || eok(u, v))) {
          prev.set(v, u);
          q.push(v);
        }
    }
    if (!prev.has(b)) return eok ? null : ok ? this.route(a, b) : [a, b];
    const out = [];
    for (let u = b; u !== -1; u = prev.get(u)) out.unshift(u);
    return out;
  }
  // ---- events: only when something happened. kind: recall | save | connect
  event(ev) {
    const kind = (ev && ev.kind) || "recall";
    // work: something is in progress (a payment): the web runs a little faster, in ink, until it is told to stop. The amber comes when it lands.
    if (kind === "work") {
      this.working = !!ev.on && !this.reduced;
      this.workClear = ev.clear || null;
      this.workToward = ev.toward || null;
      this.workAmber = !!ev.amber;
      delete this.next.work;
      return;
    }
    // data-avoid="x,y,w,h": where the page's own text sits over the graph; events never light notes there
    const V = ev && ev.clear ? this.visible(ev.clear) : null;
    const av = (this.svg.getAttribute("data-avoid") || "").split(",").map(Number),
      out0 = (i) =>
        av.length !== 4 ||
        isNaN(av[0]) ||
        !(
          this.N[i].x > av[0] &&
          this.N[i].x < av[0] + av[2] &&
          this.N[i].y > av[1] &&
          this.N[i].y < av[1] + av[3]
        );
    const out = V ? (i) => out0(i) && V.n[i] && this.adj[i].some(([j]) => V.e(i, j)) : out0;
    if (V && !this.N.some((p, i) => out(i))) return;
    const hubs = this.N.map((p, i) => [i, this.adj[i].length])
      .filter(([i]) => out(i))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map((x) => x[0]);
    const target = ev && ev.target !== undefined ? ev.target : pick(hubs.length ? hubs : [0]);
    const group = [
      target,
      ...this.adj[target]
        .map(([j]) => j)
        .filter((j) => out(j) && (!V || V.e(target, j)))
        .slice(0, kind === "recall" ? 3 : 0),
    ];
    if (this.reduced) {
      group.forEach((i) => this.lightStill(i));
      return;
    }
    const W = this.vb[2],
      anchor =
        ev && ev.of
          ? { x: this.vb[0] + (W * ((ev.from || 0) + 0.5)) / ev.of, y: this.entry.y }
          : this.entry;
    const near = this.N.map((q, i) => [i, (q.x - anchor.x) ** 2 + (q.y - anchor.y) ** 2])
      .filter(([i]) => out(i) && i !== this.lastStart)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 4);
    let start = near.length ? pick(near)[0] : this.nearest(this.entry, out);
    if (V) {
      const d = new Map([[target, 0]]),
        q = [target];
      while (q.length) {
        const u = q.shift();
        for (const [v] of this.adj[u])
          if (!d.has(v) && out(v) && V.e(u, v)) {
            d.set(v, d.get(u) + 1);
            q.push(v);
          }
      }
      const far = [...d].filter(([, k]) => k >= 2 && k <= 4).map((x) => x[0]),
        one = [...d].filter(([, k]) => k === 1).map((x) => x[0]);
      start = far.length ? pick(far) : one.length ? pick(one) : target;
    }
    this.lastStart = start;
    let path = this.route(start, target, out, V ? V.e : undefined);
    if (!path) path = [start]; // starts on a note, so it reads as coming out of the web, not out of one fixed point
    const arrive = () => {
      group.forEach((i, n) => this.later(() => this.light(i, 2600), n * 120));
    };
    if (path.length < 2) {
      if (V) {
        arrive();
        return;
      }
      path.unshift(this.adj[start][0] ? this.adj[start][0][0] : start);
    }
    this.busy = true;
    clearTimeout(this.busyT);
    this.pulse((performance.now() - this.t0) / 1000, true, path, () => {
      arrive();
      this.busyT = this.later(() => {
        this.busy = false;
      }, 2800);
    });
  }
  hoverStep() {
    const P = this.pointer.current,
      r = this.svg.getBoundingClientRect();
    let want = -1;
    if (P && r.width && P.x >= r.left && P.x <= r.right && P.y >= r.top && P.y <= r.bottom) {
      const m = this.svg.getScreenCTM();
      if (m) {
        const q = new DOMPoint(P.x, P.y).matrixTransform(m.inverse());
        let bd = (this.lenMed * 0.7) ** 2;
        this.N.forEach((n, i) => {
          const d = (n.x - q.x) ** 2 + (n.y - q.y) ** 2;
          if (d < bd) {
            bd = d;
            want = i;
          }
        });
      }
    }
    if (want !== this.hovI) {
      this.hovI = want;
      this.hovK = this.reduced ? 1 : 0;
      while (this.hov.firstChild) this.hov.firstChild.remove();
      if (want >= 0) {
        const p = this.N[want],
          nb = this.adj[want].map(([j]) => j);
        this.hovEls = {
          links: nb.map((j) =>
            this.line(
              ...this.trim(want, j),
              { stroke: this.amber, "stroke-width": 1, opacity: 0 },
              this.hov
            )
          ),
          wake: nb.map((j) =>
            this.dot(this.N[j], this.N[j].r, { fill: this.ink, opacity: 0 }, this.hov)
          ),
          halo: this.dot(
            p,
            p.r + 6,
            { fill: this.k < 1 ? this.phosphor : this.amber, opacity: 0 },
            this.hov
          ),
          core: this.dot(p, p.r + 0.8, { fill: this.amber, opacity: 0 }, this.hov),
        };
      }
    }
    if (this.hovI >= 0 && this.hovEls) {
      this.hovK = this.reduced ? 1 : this.hovK + (1 - this.hovK) * 0.16;
      const k = this.hovK,
        E = this.hovEls;
      E.core.setAttribute("opacity", k.toFixed(2));
      E.halo.setAttribute("opacity", ((this.k < 1 ? 0.3 : 0.16) * k).toFixed(3));
      E.links.forEach((el) =>
        el.setAttribute("opacity", ((this.k < 1 ? 0.8 : 0.45) * k).toFixed(3))
      );
      E.wake.forEach((el) => el.setAttribute("opacity", (0.62 * this.k * k).toFixed(3)));
    }
  }
  later(fn, ms) {
    const timer = setTimeout(() => {
      this.timeouts.delete(timer);
      if (!this.destroyed) fn();
    }, ms);
    this.timeouts.add(timer);
    return timer;
  }
  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    clearInterval(this.hovT);
    clearTimeout(this.busyT);
    this.timeouts.forEach(clearTimeout);
    this.timeouts.clear();
    this.root.remove();
    this.amb.remove();
  }
  lightStill(i) {
    const p = this.N[i];
    const c = this.dot(p, p.r + 0.8, { fill: this.amber }, this.evt);
    this.later(() => c.remove(), 4000);
  }
}
export function trimEdge(a, b) {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / length,
    uy = (b.y - a.y) / length;
  const radius = (node) =>
    node.r === null
      ? 0
      : node.halfWidth
        ? Math.min(
            node.halfWidth / Math.abs(ux || Number.EPSILON),
            node.halfHeight / Math.abs(uy || Number.EPSILON)
          ) + 1
        : (node.r ?? 3) + 1;
  const ra = radius(a),
    rb = radius(b);
  if (length <= ra + rb + 1) return [a, b];
  return [
    { x: a.x + ux * ra, y: a.y + uy * ra },
    { x: b.x - ux * rb, y: b.y - uy * rb },
  ];
}

export const trimSvg = (svg) => {
  try {
    const ls = svg.querySelectorAll("line:not([data-exo-t])");
    if (!ls.length) return;
    const cs = [];
    svg
      .querySelectorAll(
        svg.querySelector("[data-graph-node]") ? "circle[data-graph-node]" : "circle"
      )
      .forEach((c) => {
        if (c.closest(".exo-alive,.exo-alive-amb")) return;
        const r = +c.getAttribute("r") || 0;
        if (r >= 1.5)
          cs.push({
            x: +c.getAttribute("cx"),
            y: +c.getAttribute("cy"),
            r: r + (parseFloat(c.getAttribute("stroke-width")) || 0) / 2,
          });
      });
    // SVG rectangles are parsed node bounds too; hit areas and halos never define a link's endpoint.
    svg.querySelectorAll("rect[data-graph-node]").forEach((rect) => {
      const width = +rect.getAttribute("width"),
        height = +rect.getAttribute("height");
      const stroke = (parseFloat(rect.getAttribute("stroke-width")) || 0) / 2;
      cs.push({
        x: +rect.getAttribute("x") + width / 2,
        y: +rect.getAttribute("y") + height / 2,
        r: Math.hypot(width, height) / 2,
        halfWidth: width / 2 + stroke,
        halfHeight: height / 2 + stroke,
      });
    });
    const near = (x, y) => {
      let b = null;
      for (const c of cs)
        if (Math.abs(c.x - x) < 0.8 && Math.abs(c.y - y) < 0.8 && (!b || c.r > b.r)) b = c;
      return b;
    }; // Marked circles identify the note; hit areas and halos do not define its edge.
    ls.forEach((el) => {
      if (el.closest(".exo-alive,.exo-alive-amb")) return;
      el.setAttribute("data-exo-t", "");
      const x1 = +el.getAttribute("x1"),
        y1 = +el.getAttribute("y1"),
        x2 = +el.getAttribute("x2"),
        y2 = +el.getAttribute("y2");
      const a = near(x1, y1),
        b = near(x2, y2);
      if (!a && !b) return;
      const [start, end] = trimEdge(a ?? { x: x1, y: y1, r: null }, b ?? { x: x2, y: y2, r: null });
      if (a) {
        el.setAttribute("x1", start.x.toFixed(2));
        el.setAttribute("y1", start.y.toFixed(2));
      }
      if (b) {
        el.setAttribute("x2", end.x.toFixed(2));
        el.setAttribute("y2", end.y.toFixed(2));
      }
    });
  } catch {}
};

export function attachAlive(svg) {
  trimSvg(svg);
  const pointer = { current: null };
  const engine = new Alive(svg, pointer);
  const page = svg.closest("[data-alive-surface]") || svg.parentElement;
  let tapTimer = 0;
  let ignoreMouseUntil = 0;
  const move = (event) => {
    if (event.pointerType !== "mouse" || performance.now() < ignoreMouseUntil) return;
    pointer.current = { x: event.clientX, y: event.clientY };
  };
  const leave = () => {
    pointer.current = null;
  };
  const tap = (event) => {
    if (event.pointerType === "mouse") return;
    ignoreMouseUntil = performance.now() + 2000;
    pointer.current = { x: event.clientX, y: event.clientY };
    clearTimeout(tapTimer);
    tapTimer = setTimeout(leave, 1800);
  };
  page.addEventListener("pointermove", move, { passive: true });
  page.addEventListener("pointerleave", leave);
  page.addEventListener("pointerdown", tap, { passive: true });
  return {
    fire: (event) => engine.event(event),
    destroy() {
      page.removeEventListener("pointermove", move);
      page.removeEventListener("pointerleave", leave);
      page.removeEventListener("pointerdown", tap);
      clearTimeout(tapTimer);
      engine.destroy();
    },
  };
}
