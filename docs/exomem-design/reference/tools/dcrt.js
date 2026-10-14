// dcrt: a small runtime for .dc.html components that renders by morphing the live DOM in place,
// so CSS animations, scroll position, focus and hover survive every setState.
(function () {
  class DCLogic {
    constructor(props) { this.props = props || {}; this.state = {}; }
    setState(p, cb) {
      Object.assign(this.state, typeof p === 'function' ? p(this.state) : p);
      if (this.__render && !this.__queued) { this.__queued = true; queueMicrotask(() => { this.__queued = false; if (typeof this.__render !== 'function') return; this.__render(); cb && cb(); }); }
      else cb && queueMicrotask(cb);
    }
  }
  window.DCLogic = DCLogic;
  const RX = /\{\{\s*([\s\S]+?)\s*\}\}/g;
  const cache = new Map();
  const ev = (expr, s) => {
    let f = cache.get(expr);
    if (!f) { try { f = new Function('s', 'with(s){return (' + expr + ')}'); } catch (e) { f = () => ''; } cache.set(expr, f); }
    try { return f(s); } catch (e) { return ''; }
  };
  const interp = (str, s) => str.replace(RX, (_, e) => { const v = ev(e, s); return v == null ? '' : String(v); });

  // Build a fresh tree for the template; event handlers are kept on the node, not attached yet.
  function build(node, s, out) {
    if (node.nodeType === 3) { out.push(document.createTextNode(RX.test(node.textContent) ? (RX.lastIndex = 0, interp(node.textContent, s)) : node.textContent)); RX.lastIndex = 0; return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'sc-for') {
      const list = ev(node.getAttribute('list').replace(RX, '$1'), s) || [];
      const as = node.getAttribute('as');
      list.forEach((it, idx) => node.childNodes.forEach((c) => build(c, { ...s, [as]: it, index: idx }, out)));
      return;
    }
    if (tag === 'sc-if') {
      if (ev(node.getAttribute('value').replace(RX, '$1'), s)) node.childNodes.forEach((c) => build(c, s, out));
      return;
    }
    if (tag === 'dc-import') {
      const props = {};
      [...node.attributes].forEach((a) => { if (!['name', 'hint-size'].includes(a.name)) props[a.name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = a.value.includes('{{') ? ev(a.value.replace(RX, '$1'), s) : a.value; });
      const host = document.createElement('div'); host.style.display = 'contents';
      host.__dc = { name: node.getAttribute('name'), props, sig: node.getAttribute('name') + JSON.stringify(props) };
      out.push(host); return;
    }
    const isSvg = node.namespaceURI === 'http://www.w3.org/2000/svg';
    const el = isSvg ? document.createElementNS(node.namespaceURI, node.tagName) : document.createElement(tag);
    el.__h = {};
    [...node.attributes].forEach((a) => {
      if (/^on[a-zA-Z]+$/.test(a.name) && a.value.includes('{{')) { const fn = ev(a.value.replace(RX, '$1'), s); if (typeof fn === 'function') el.__h[a.name.slice(2).toLowerCase()] = fn; return; }
      el.setAttribute(a.name, a.value.includes('{{') ? (RX.lastIndex = 0, interp(a.value, s)) : a.value); RX.lastIndex = 0;
    });
    const kids = []; node.childNodes.forEach((c) => build(c, s, kids)); kids.forEach((k) => el.appendChild(k));
    out.push(el);
  }
  function wire(el) {
    if (el.nodeType !== 1) return;
    if (el.__h) Object.keys(el.__h).forEach((t) => { el.__on = el.__on || {}; if (!el.__on[t]) { el.__on[t] = true; el.addEventListener(t, (e) => el.__h[t] && el.__h[t](e)); } });
    if (el.__dc && !el.__mounted) { el.__mounted = true; mount(el.__dc.name, el.__dc.props, el); return; }
    el.childNodes.forEach(wire);
  }
  // Morph `from` (live) into `to` (fresh); keep live nodes where the shape matches.
  function same(a, b) { return a.nodeType === b.nodeType && (a.nodeType !== 1 || (a.nodeName === b.nodeName && !!a.__dc === !!b.__dc && (!a.__dc || a.__dc.sig === b.__dc.sig))); }
  function morphKids(parent, fresh) {
    const live = [...parent.childNodes];
    fresh.forEach((f, i) => {
      const l = live[i];
      if (l && same(l, f)) morph(l, f);
      else if (l) { parent.replaceChild(f, l); wire(f); }
      else { parent.appendChild(f); wire(f); }
    });
    for (let i = fresh.length; i < live.length; i++) live[i].remove();
  }
  function morph(l, f) {
    if (l.nodeType === 3) { if (l.nodeValue !== f.nodeValue) l.nodeValue = f.nodeValue; return; }
    if (l.__dc) return;  // a child component renders itself
    [...l.attributes].forEach((a) => { if (!f.hasAttribute(a.name)) l.removeAttribute(a.name); });
    [...f.attributes].forEach((a) => { if (l.getAttribute(a.name) !== a.value) l.setAttribute(a.name, a.value); });
    l.__h = f.__h; wire(l);
    morphKids(l, [...f.childNodes]);
  }
  const files = () => window.__files || {};
  const injected = new Set();
  function mount(name, props, host) {
    const txt = files()[name];
    if (!txt) { host.textContent = 'missing ' + name; return; }
    const doc = new DOMParser().parseFromString(txt, 'text/html');
    const x = doc.querySelector('x-dc');
    const helm = x.querySelector('helmet');
    if (helm && !injected.has(name)) { injected.add(name); [...helm.children].forEach((c) => document.head.appendChild(c.cloneNode(true))); }
    if (helm) helm.remove();
    const sc = doc.querySelector('script[data-dc-script]');
    let meta = {}; try { meta = JSON.parse(sc.getAttribute('data-props') || '{}'); } catch (e) {}
    const defaults = {}; Object.entries(meta).forEach(([k, v]) => { if (k[0] !== '$' && v && 'default' in v) defaults[k] = v.default; });
    const C = new Function('DCLogic', sc.textContent + '\n;return Component;')(DCLogic);
    const inst = new C({ ...defaults, ...props });
    inst.props = { ...defaults, ...props };
    const tpl = [...x.childNodes];
    inst.__render = () => {
      if (!host.isConnected && inst.__mountedOnce) { inst.componentWillUnmount && inst.componentWillUnmount(); inst.__render = null; return; }
      const vals = inst.renderVals(); const out = []; tpl.forEach((c) => build(c, vals, out));
      morphKids(host, out);
    };
    inst.__render(); inst.__mountedOnce = true;
    inst.componentDidMount && inst.componentDidMount();
  }
  window.mountDC = mount;
})();
