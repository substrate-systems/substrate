// Exomem graph layout: node and link awareness (canon rounds 54 to 56).
// One module for every graph we draw: Home's header graph, the map card, the flow pages' field, the landing's graphs
// and the map page. The prototype boards inline the same steps; the product should call these instead.
//
// Rules it enforces (see CANON.md, "Node and link awareness"):
//   1. Notes may sit close, never on each other:  edge gap >= gap (px at the size drawn).
//   2. Notes never sit under a label or in a keep-clear box (wordmark, theme control, account).
//   3. A link leaves the centre of each note: drawn from centre to centre, or trimmed along that same line.
//   4. Background links keep clear of the theme button's hover circle (linkClearOf), like the notes keep 10 px.
//   5. The Home map card draws constellations (pickConstellation + figure): see CANON.md, "The map card".
//   6. A focused note shows at most 12 (desktop) / 8 (phone) links on its ring (capRing); the rest are one "+N more" chip.
// Round 55 also tried clearLinks and chooseLinks on every graph; The approved design uses round 54's links, so they are NOT in
// the canon. They stay here as tools, unused by the boards.
//
// Notes are {x, y, r, fixed?}; links are [i, j]. Everything is deterministic (no Math.random): same input, same picture.

export function separate(nodes, { gap = 4.5, iterations = 200, bounds = null } = {}) {
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      const need = a.r + b.r + gap;
      if (d >= need) continue;
      if (d < 0.01) { dx = 1; dy = 0.5; d = Math.hypot(dx, dy); }
      const k = (need - d) / d, wa = a.fixed ? 0 : b.fixed ? 1 : 0.5;
      a.x -= dx * k * wa; a.y -= dy * k * wa; b.x += dx * k * (1 - wa); b.y += dy * k * (1 - wa);
      moved = true;
    }
    if (bounds) clamp(nodes, bounds);
    if (!moved) return nodes;
  }
  return nodes;
}

// Keep-clear boxes [x0, y0, x1, y1]: a note inside one (plus margin) moves to the nearest side. Nothing is removed.
export function clearBoxes(nodes, boxes, { margin = 10 } = {}) {
  nodes.forEach((p) => {
    if (p.fixed) return;
    boxes.forEach(([x0, y0, x1, y1]) => {
      const m = margin + p.r;
      if (!(p.x > x0 - m && p.x < x1 + m && p.y > y0 - m && p.y < y1 + m)) return;
      const opts = [[p.x - (x0 - m), 'x', x0 - m], [x1 + m - p.x, 'x', x1 + m], [p.y - (y0 - m), 'y', y0 - m], [y1 + m - p.y, 'y', y1 + m]];
      opts.sort((u, v) => u[0] - v[0]); p[opts[0][1]] = opts[0][2];
    });
  });
  return nodes;
}

// Labels go where they cover the fewest notes, near their anchor (above first, then below or beside).
// Returns boxes for clearBoxes(…, {margin: 1.5}) so any note still under a label steps clear.
export function placeLabels(nodes, labels, { charW = 6.6, h = 13, offsets = [-12, -16, -20, -24, -28, 20, 24, 28], shifts = [0, -8, 8, -16, 16, -24, 24], width = Infinity } = {}) {
  const taken = [];
  return labels.map(({ anchor, text }) => {
    const a = nodes[anchor], w = text.length * charW + 8;
    let best = null;
    for (const dy of offsets) for (const dx of shifts) {
      const x = Math.min(Math.max(a.x + dx, w / 2 + 4), width - w / 2 - 4), y = a.y + dy;
      const box = [x - w / 2, y - h + 3, x + w / 2, y + 3];
      if (taken.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
      const covered = nodes.filter((n) => n.x > box[0] - n.r && n.x < box[2] + n.r && n.y > box[1] - n.r && n.y < box[3] + n.r).length;
      const score = covered + 0.012 * Math.hypot(dx, dy + 12);
      if (!best || score < best.score) best = { score, x, y, box };
    }
    if (!best) return null;
    taken.push(best.box);
    return { text, x: best.x, y: best.y, box: best.box };
  });
}

// Real links: move notes off links they don't belong to (perpendicular; the link's ends give a little).
export function clearLinks(nodes, links, { linkGap = 2, iterations = 80, gap = 4.5 } = {}) {
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    links.forEach(([i, j]) => {
      const a = nodes[i], b = nodes[j], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
      nodes.forEach((c, k) => {
        if (k === i || k === j) return;
        const need = c.r + linkGap;
        if (c.x < Math.min(a.x, b.x) - need || c.x > Math.max(a.x, b.x) + need || c.y < Math.min(a.y, b.y) - need || c.y > Math.max(a.y, b.y) + need) return;
        const t = ((c.x - a.x) * dx + (c.y - a.y) * dy) / L2;
        if (t <= 0.02 || t >= 0.98) return;
        let ox = c.x - (a.x + t * dx), oy = c.y - (a.y + t * dy), d = Math.hypot(ox, oy);
        if (d >= need) return;
        if (d < 0.01) { ox = -dy; oy = dx; d = Math.sqrt(L2); }
        const m = (need - d) / d;
        if (!c.fixed) { c.x += ox * m * 0.7; c.y += oy * m * 0.7; }
        if (!a.fixed) { a.x -= ox * m * 0.3 * (1 - t); a.y -= oy * m * 0.3 * (1 - t); }
        if (!b.fixed) { b.x -= ox * m * 0.3 * t; b.y -= oy * m * 0.3 * t; }
        moved = true;
      });
    });
    separate(nodes, { gap, iterations: 1 });
    if (!moved) return nodes;
  }
  return nodes;
}

// Invented links only (decorative graphs): k nearest neighbours, shortest first, kept if it passes no note and crosses
// no kept link.
export function chooseLinks(nodes, { k = 3, maxLen = 150, clear = 7 } = {}) {
  const seen = new Set(), cand = [], E = [];
  nodes.forEach((p, i) => {
    nodes.map((q, j) => [j, Math.hypot(q.x - p.x, q.y - p.y)]).filter(([j]) => j !== i).sort((a, b) => a[1] - b[1]).slice(0, k)
      .forEach(([j, d]) => { const key = Math.min(i, j) + '-' + Math.max(i, j); if (d <= maxLen && !seen.has(key)) { seen.add(key); cand.push([i, j, d]); } });
  });
  cand.sort((u, v) => u[2] - v[2]).forEach(([i, j]) => {
    if (nodes.some((c, m) => m !== i && m !== j && segDist(nodes[i], nodes[j], c) < clear)) return;
    if (E.some(([a, b]) => a !== i && a !== j && b !== i && b !== j && crosses(nodes[i], nodes[j], nodes[a], nodes[b]))) return;
    E.push([i, j]);
  });
  return E;
}

// Which invented links show at rest: a per-link pick, so moving one note never reshuffles the others.
export function restPick(i, j, share = 0.34) {
  let h = (Math.min(i, j) * 73856093) ^ (Math.max(i, j) * 19349663);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995); h ^= h >>> 15;
  return ((h >>> 0) % 1000) / 1000 < share;
}

// A link drawn from a's edge to b's edge, along the centre line (pad: px left clear of each note).
export function trimLink(a, b, pad = 1) {
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1, ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
  if (L <= a.r + b.r + 2 * pad) return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
  return [{ x: a.x + ux * (a.r + pad), y: a.y + uy * (a.r + pad) }, { x: b.x - ux * (b.r + pad), y: b.y - uy * (b.r + pad) }];
}
// HTML links: a 1 px tall box turned about its left-middle has its axis half a pixel below its top: top = y - 0.5.

export function segDist(a, b, c) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / L2));
  return Math.hypot(a.x + t * dx - c.x, a.y + t * dy - c.y);
}
function crosses(a, b, c, d) { const s = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)); return s(a, b, c) * s(a, b, d) < 0 && s(c, d, a) * s(c, d, b) < 0; }
function clamp(nodes, [x0, y0, x1, y1]) { nodes.forEach((p) => { p.x = Math.min(x1 - p.r, Math.max(x0 + p.r, p.x)); p.y = Math.min(y1 - p.r, Math.max(y0 + p.r, p.y)); }); }

// The map card's constellations (display only; recall ranking never uses usage).
// A topic picks its 13 stars mostly by use (recalls in the last 90 days), a little by connections, and only from the
// nearer 60% of its notes, so the figure stays compact. Stable: redraw only when 3 or more of the 13 change.
export function pickConstellation(nodes, members, hub, { use, degree, size = 13, core = 0.6, wUse = 0.65 } = {}) {
  const ms = members.filter((k) => k !== hub);
  const dist = (k) => Math.hypot(nodes[k].x - nodes[hub].x, nodes[k].y - nodes[hub].y);
  const lim = ms.map(dist).sort((a, b) => a - b)[Math.floor(ms.length * core)] ?? Infinity;
  const rank = (key) => { const r = {}; [...ms].sort((a, b) => key[b] - key[a]).forEach((k, i) => { r[k] = i / ms.length; }); return r; };
  const ru = rank(use), rd = rank(degree);
  return ms.filter((k) => dist(k) <= lim).sort((a, b) => (wUse * ru[a] + (1 - wUse) * rd[a]) - (wUse * ru[b] + (1 - wUse) * rd[b])).slice(0, size);
}
// The figure: from the hub, repeatedly join the nearest star not yet in the figure (a drawing, like real constellations).
export function figure(nodes, stars, hub) {
  const inT = new Set([hub]), rest = new Set(stars.filter((k) => k !== hub)), segs = [];
  while (rest.size) {
    let best = null;
    inT.forEach((a) => rest.forEach((b) => { const d = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y); if (!best || d < best[0]) best = [d, a, b]; }));
    segs.push([best[1], best[2]]); inT.add(best[2]); rest.delete(best[2]);
  }
  return segs;
}
// Background links are not drawn where they would pass under a control's hover circle (cx, cy, r) plus a margin.
export function linkClearOf(a, b, { cx, cy, r }, margin = 3) { return segDist(a, b, { x: cx, y: cy }) >= r + margin; }

// Round 57: which links a focused note shows on its ring. linkOf(j) gives {type, supersedesMe, degree} for neighbour j.
// Order: what supersedes this note, what it supersedes, unresolved disagreements, supports, refines, then by connections.
export function capRing(neighbours, linkOf, { cap = 12 } = {}) {
  const pr = (l) => l.supersedesMe ? 0 : l.type === 'supersedes' ? 1 : l.type === 'contradicts' && !l.resolved ? 2 : l.type === 'supports' ? 3 : l.type === 'refines' ? 4 : 5;
  const srt = [...neighbours].sort((a, b) => { const A = linkOf(a), B = linkOf(b); return pr(A) - pr(B) || B.degree - A.degree || (a < b ? -1 : 1); });
  return { ring: srt.slice(0, cap), more: Math.max(0, srt.length - cap) };
}

// Audit: what the canon checks on every board state. Returns counts; all must be 0.
export function audit(nodes, links, { gap = 4, linkGap = 1.5 } = {}) {
  let overlaps = 0, overNote = 0;
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) if (Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) < nodes[i].r + nodes[j].r + gap) overlaps++;
  links.forEach(([i, j]) => nodes.forEach((c, k) => { if (k !== i && k !== j && segDist(nodes[i], nodes[j], c) < c.r + linkGap) overNote++; }));
  return { overlaps, overNote };
}
