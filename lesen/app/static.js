"use strict";
// Statische Lese-Oberfläche (öffentliche Demo, tools/demo_lesen.py): ersetzt die Kurations-API im Browser.
// window.KANONIK_STATIC = {daten: "./", assets: "../app/"} setzt die Seite vor diesem Skript.
//   Suche und Knotenansicht laufen gegen den exportierten Graphen (graph.json aus tools/neo4j_export.py) – dieselben
//   Abfragen wie MemoryStore.search/details in common/curation.py (Trefferstufen, Beziehungen, Quellbelege, Pfade,
//   Gleichbedeutung, Ableitungen, letzte Entscheidungen); Änderungen dort bitte hier nachziehen.
//   Volltext der Lücken: volltext.json. Übrige Anfragen (Statistik, Prüfstand, Lücken, Zusatzkarten): api/index.json
//   (Schlüssel: Pfad + sortierte Parameter). Änderungen werden abgelehnt.
(function () {
  const S = window.KANONIK_STATIC;
  if (!S) return;
  const echt = window.fetch.bind(window);
  const daten = S.daten || "./", assets = S.assets || "../app/";
  const cache = {};
  const laden = (f) => (cache[f] ||= echt(daten + f).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  const antwort = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const enc = (s) => encodeURIComponent(s);
  function schluessel(pfad, params) {
    const p = params.filter(([, v]) => v !== "" && v != null).map(([k, v]) => [String(k), String(v)])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    return pfad + (p.length ? "?" + p.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&") : "");
  }
  const ab = (x) => (x === undefined ? null : x);
  const schnitt = (a, b) => (a || []).some((x) => (b || []).includes(x));
  const vergleich = (x, y) => { for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const a = x[i], b = y[i];
    if (a === undefined) return -1; if (b === undefined) return 1;
    if (Array.isArray(a)) { const c = vergleich(a, b); if (c) return c; continue; }
    if (a < b) return -1; if (a > b) return 1; } return 0; };
  const anhaengen = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  const STATUS_ORDER = { confirmed: 0, candidate: 1, rejected: 2 };
  const EQUIV_OK = [null, "confirmed", "auto", "source"], EQUIV_DEPTH = 8, EQUIV_LIMIT = 200;
  const IMPLIED = ["EXACT_MATCH", "CLOSE_MATCH"], BELEG = ["DERIVED_FROM", "MENTIONED_IN"];
  // ---------------------------------------------------------------- Graph laden
  let G = null;
  async function graph() {
    if (G) return G;
    const d = await laden("graph.json");
    if (!d) return null;
    const aus = new Map(), ein = new Map(), rels = [];
    d.kanten.forEach((k, i) => {
      const r = { i, type: k[0], start: k[1], end: k[2], props: k[3] || {}, h: ab(k[4]) };
      r.hp = k[5] === 0 ? r.h : ab(k[5]);
      rels.push(r); anhaengen(aus, r.start, r); anhaengen(ein, r.end, r);
    });
    const K = d.konfig, ok = (r) => EQUIV_OK.includes(ab(r.props.status));
    const dec = new Map(d.entscheidungen.map(([k, v]) => [k.map((x) => (x == null ? "" : x)).join("\u0001"), v]));
    G = { ...d, K, rels, aus, ein, dec,
      imp: new Implications(rels.filter((r) => r.type === "EXACT_MATCH" && ok(r)).map((r) => [r.start, r.end]),
        rels.filter((r) => r.type === "BROADER" && ok(r)).map((r) => [r.start, r.end])) };
    return G;
  }
  // node_ref / summarize (Anzeige vorberechnet)
  function ref(id) {
    const n = G.knoten[id];
    if (!n) { const [doc, lang] = (G.fehlend || {})[id] || [null, null];
      return { id, labels: [], label: null, type: null, title: id, titleEn: null, editable: false, doc, lang }; }
    const a = n.a;
    return { id, labels: n.l, label: a.label, type: a.type, title: a.title, titleEn: a.titleEn,
      editable: a.type != null && id != null, doc: a.doc, lang: a.lang };
  }
  const refOder = (id) => (G.knoten[id] ? ref(id) : null);
  function zusammenfassung(id) {
    const n = G.knoten[id], a = n.a, p = n.p;
    return { id: ab(p.id), type: a.type, labels: n.l, label: a.label, title: a.title, titleEn: a.titleEn, subtitle: a.subtitle,
      status: p.status || "extracted", rev: parseInt(p.curationRev || 0, 10) || 0, doc: a.doc, lang: a.lang };
  }
  const relSpec = (t) => G.K.beziehungen[t] || null;
  function relGruppe(t) {
    for (const [g, ts] of Object.entries(G.K.gruppen)) if (ts.includes(t)) return g;
    return G.K.standardgruppe;
  }
  const ersteRel = (pth, i) => (Array.isArray(pth.steps[i].rel) ? pth.steps[i].rel[0] : pth.steps[i].rel);
  // ---------------------------------------------------------------- Gleichbedeutung (EquivIndex, Implications)
  class EquivIndex {
    constructor(edges) {
      this.adj = new Map(); this.parent = new Map();
      for (const [a, b] of edges) {
        if (a === b) continue;
        if (!this.adj.has(a)) this.adj.set(a, new Set()); if (!this.adj.has(b)) this.adj.set(b, new Set());
        this.adj.get(a).add(b); this.adj.get(b).add(a);
        const ra = this.find(a), rb = this.find(b);
        if (ra !== rb) this.parent.set(ra, rb);
      }
    }
    find(x) {
      let root = x;
      while ((this.parent.get(root) ?? root) !== root) root = this.parent.get(root);
      while ((this.parent.get(x) ?? x) !== root) { const n = this.parent.get(x); this.parent.set(x, root); x = n; }
      return root;
    }
    root(x) { return this.adj.has(x) ? this.find(x) : x; }
    same(a, b) { return this.adj.has(a) && this.adj.has(b) && this.find(a) === this.find(b); }
    path(a, b) {
      const prev = new Map([[a, null]]), todo = [a];
      for (let i = 0; i < todo.length; i++) {
        const cur = todo[i];
        if (cur === b) break;
        for (const nb of [...(this.adj.get(cur) || [])].sort()) if (!prev.has(nb)) { prev.set(nb, cur); todo.push(nb); }
      }
      if (!prev.has(b)) return [];
      const out = []; let x = prev.get(b);
      while (x != null && x !== a) { out.push(x); x = prev.get(x); }
      return out.reverse();
    }
  }
  class Implications {
    constructor(eq, broader) {
      this.eq = new EquivIndex(eq); this.up = new Map(); this.down = new Map(); this.pairs = new Map();
      for (const [a, b] of broader) {
        const ra = this.eq.root(a), rb = this.eq.root(b);
        anhaengen(this.up, ra, [a, b]); anhaengen(this.down, rb, [a, b]); anhaengen(this.pairs, ra + "\u0001" + rb, [a, b]);
      }
    }
    derive(t, status, a, b) {
      if (t === "BROADER" && status !== "rejected" && this.eq.same(a, b)) return { conflict: true };
      if (status !== "candidate") return null;
      if (IMPLIED.includes(t) && this.eq.same(a, b)) return { status: "implied", via: this.eq.path(a, b) };
      if (t === "BROADER") {
        for (const [x, y] of this.pairs.get(this.eq.root(a) + "\u0001" + this.eq.root(b)) || [])
          if (!(x === a && y === b)) return { status: "implied", via: [x, y].filter((v) => v !== a && v !== b) };
        const via = this.chain(a, b);
        if (via.length) return { status: "implied", via };
      }
      return null;
    }
    chain(a, b, depth = 8) {
      const ra = this.eq.root(a), rb = this.eq.root(b), prev = new Map([[ra, null]]);
      let frontier = [ra];
      for (let d = 0; d < depth; d++) {
        const nxt = [];
        for (const r of frontier) for (const [x, y] of this.up.get(r) || []) {
          const ry = this.eq.root(y);
          if (prev.has(ry)) continue;
          prev.set(ry, [r, x, y]);
          if (ry === rb) {
            const out = []; let k = ry;
            while (prev.get(k) != null) {
              const [pr, x0, y0] = prev.get(k);
              for (const v of [y0, x0]) if (v !== a && v !== b && !out.includes(v)) out.push(v);
              k = pr;
            }
            out.reverse();
            let n = 0; k = rb; while (prev.get(k) != null) { k = prev.get(k)[0]; n++; }
            return n >= 2 ? out : [];
          }
          nxt.push(ry);
        }
        frontier = nxt;
        if (!frontier.length) break;
      }
      return [];
    }
    inherited(me, depth = 8) {
      if (!this.members) { this.members = new Map(); for (const x of this.eq.adj.keys()) anhaengen(this.members, this.eq.root(x), x); }
      const out = { broader: [], narrower: [] };
      for (const [key, edges, pick] of [["broader", this.up, (e) => [e[0], e[1]]], ["narrower", this.down, (e) => [e[1], e[0]]]]) {
        const seenCls = new Set([this.eq.root(me)]), seen = new Set([me]);
        let frontier = [this.eq.root(me)];
        for (let d = 0; d < depth; d++) {
          const nxt = [];
          for (const r of frontier) for (const e of edges.get(r) || []) {
            const [frm, to] = pick(e);
            if (this.eq.same(to, me)) continue;
            if (!seen.has(to)) { seen.add(to); if (frm !== me) out[key].push([to, frm, this.eq.same(frm, me) ? "gleich" : "kette"]); }
            const rt = this.eq.root(to);
            if (!seenCls.has(rt)) {
              seenCls.add(rt); nxt.push(rt);
              for (const m of this.members.get(rt) || []) if (!seen.has(m)) { seen.add(m); out[key].push([m, to, "gleich"]); }
            }
          }
          frontier = nxt;
          if (!frontier.length) break;
        }
      }
      return out;
    }
  }
  // ---------------------------------------------------------------- Knotenansicht (MemoryStore.details + assemble)
  function walk(pth, id, limit) {
    const rows = [];
    const step = (i, cur, nodes, edges) => {
      if (rows.length >= limit) return;
      if (i === pth.steps.length) { rows.push([nodes, edges]); return; }
      const st = pth.steps[i], types = Array.isArray(st.rel) ? st.rel : [st.rel];
      const cands = cur == null ? [] : (st.dir === "out" ? G.aus : G.ein).get(cur) || [];
      const hits = [];
      for (const r of cands) {
        if (!types.includes(r.type)) continue;
        const other = st.dir === "out" ? r.end : r.start, o = G.knoten[other];
        if (o && schnitt(o.l, st.to || [])) hits.push([other, r]);
      }
      if (!hits.length) {
        if (st.optional) { const rest = pth.steps.length - i; rows.push([nodes.concat(Array(rest).fill(null)), edges.concat(Array(rest).fill(null))]); }
        return;
      }
      for (const [other, r] of hits) step(i + 1, other, nodes.concat([other]), edges.concat([r]));
    };
    step(0, id, [], []);
    return rows;
  }
  function equivKlasse(id) {
    const seen = new Set([id]), todo = [id], depth = new Map([[id, 0]]);
    while (todo.length && seen.size <= EQUIV_LIMIT) {
      const cur = todo.shift();
      if (depth.get(cur) >= EQUIV_DEPTH) continue;
      for (const r of [...(G.aus.get(cur) || []), ...(G.ein.get(cur) || [])]) {
        if (r.type !== "EXACT_MATCH" || !EQUIV_OK.includes(ab(r.props.status))) continue;
        const nb = r.start === cur ? r.end : r.start;
        if (!seen.has(nb) && G.knoten[nb]) { seen.add(nb); depth.set(nb, depth.get(cur) + 1); todo.push(nb); }
      }
    }
    const edges = [];
    for (const x of seen) for (const r of G.aus.get(x) || []) if (r.type === "EXACT_MATCH" && seen.has(r.end)) edges.push([r.start, r.end, ab(r.props.status)]);
    return edges;
  }
  function aufloesen(pairs) {                    // kanonik.merge.resolve
    const parent = new Map();
    const find = (a) => { while ((parent.get(a) ?? a) !== a) { parent.set(a, parent.get(parent.get(a)) ?? parent.get(a)); a = parent.get(a); } return a; };
    for (const [x, y] of pairs) { const rx = find(x), ry = find(y); if (rx !== ry) parent.set(rx, ry); }
    const out = new Map();
    for (const a of [...parent.keys()]) { const r = find(a); if (r !== a) out.set(a, r); }
    return out;
  }
  function gleichbedeutend(me, edges) {          // equivalence_view
    const adj = new Map();
    for (const [a, b, st] of edges) if (EQUIV_OK.includes(st) && a !== b) {
      if (!adj.has(a)) adj.set(a, new Set()); if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a).add(b); adj.get(b).add(a);
    }
    const parent = new Map([[me, null]]), dist = new Map([[me, 0]]), order = [me];
    for (let i = 0; i < order.length; i++) {
      const cur = order[i];
      for (const nb of [...(adj.get(cur) || [])].sort())
        if (!dist.has(nb) && dist.get(cur) < EQUIV_DEPTH) { dist.set(nb, dist.get(cur) + 1); parent.set(nb, cur); order.push(nb); }
    }
    const members = order.slice(1).map((nid) => {
      const via = []; let x = parent.get(nid);
      while (x != null && x !== me) { via.push(ref(x)); x = parent.get(x); }
      return { node: ref(nid), distance: dist.get(nid), via: via.reverse() };
    });
    members.sort((a, b) => vergleich([a.distance, (a.node.title || "").toLowerCase()], [b.distance, (b.node.title || "").toLowerCase()]));
    const labs = G.K.merge_labels, inCls = new Set(order), labsOf = (x) => (G.knoten[x] || { l: [] }).l;
    const pairs = edges.filter(([a, b, st]) => ["confirmed", null, "source"].includes(st) && inCls.has(a) && inCls.has(b)
      && labsOf(a).some((l) => labsOf(b).includes(l) && labs.includes(l))).map(([a, b]) => [a, b]);
    const mapping = aufloesen(pairs), target = mapping.get(me);
    const de = [], en = [];
    for (const nid of order.slice(1)) {
      const p = (G.knoten[nid] || { p: {} }).p;
      for (const v of [p.prefLabel || p.label || p.name, ...(p.altLabels || [])]) if (v && !de.includes(v)) de.push(v);
      for (let v of [p.prefLabelEn || p.labelEn || p.nameEn, ...(p.altLabelsEn || [])]) {
        if (v && v === v.toUpperCase() && v !== v.toLowerCase() && v.length > 4) v = v.slice(0, 1) + v.slice(1).toLowerCase();
        if (v && !en.includes(v)) en.push(v);
      }
    }
    return { members, transitive: members.filter((m) => m.distance > 1).length, merge_into: target ? ref(target) : null,
      merge_from: [...mapping].filter(([, c]) => c === me).map(([a]) => ref(a)), labels: { de, en } };
  }
  function ableiten(me, relOut, pathOut) {       // mark_derived
    const cache = new Map(), r0 = (x) => { if (!cache.has(x)) cache.set(x, refOder(x) || { id: x, title: x }); return cache.get(x); };
    const mark = (props, typ, start, end) => {
      const d = G.imp.derive(typ, ab(props[(relSpec(typ) || {}).status_prop || "status"]), start, end);
      if (!d) return props;
      if (d.conflict) return { ...props, conflict: true };
      return { ...props, implied: true, impliedVia: d.via.map(r0) };
    };
    for (const r of relOut) if (r.curate) r.props = mark(r.props, r.type, r.curate.start, r.curate.end);
    for (const p of pathOut) for (const row of p.rows) if (row.curate) row.edge = mark(row.edge, row.curate.type, row.curate.start, row.curate.end);
  }
  function geerbt(me, relOut) {                  // inherited_view
    const direkt = new Set(relOut.filter((r) => r.type === "BROADER" && (r.props || {}).status !== "rejected").map((r) => `${r.outgoing}\u0001${r.other.id}`));
    const inh = G.imp.inherited(me);
    const refs = (rows, outgoing) => rows.filter(([node]) => !direkt.has(`${outgoing}\u0001${node}`))
      .map(([node, via, art]) => ({ node: refOder(node), via: refOder(via) || { id: via, title: via }, art })).filter((x) => x.node)
      .sort((a, b) => vergleich([(a.node.title || "").toLowerCase()], [(b.node.title || "").toLowerCase()]));
    return { broader: refs(inh.broader, true), narrower: refs(inh.narrower, false) };
  }
  function entscheidungen(d) {                   // _with_decisions
    if (!G.dec.size) return d;
    const me = d.props.id, k = (...x) => G.dec.get(x.map((v) => (v == null ? "" : v)).join("\u0001"));
    for (const rel of d.relations) {
      const o = rel.other.id, [a, b] = rel.outgoing ? [me, o] : [o, me];
      const e = k(a, rel.type, b) || k(b, rel.type, a);
      if (e) rel.entscheidung = e;
    }
    for (const pth of d.paths) for (const row of pth.rows) {
      const c = row.curate;
      if (c) { const e = k(c.start, c.type, c.end); if (e) row.entscheidung = e; }
    }
    d.entscheidung = ab(k("node", me));
    return d;
  }
  function details(id, label) {
    const n = G.knoten[id];
    if (!n || (label && !n.l.includes(label))) return null;
    const labels = n.l, props = JSON.parse(JSON.stringify(n.p)), a = n.a, K = G.K;
    const rels = [], ev = [];
    const alle = [...(G.aus.get(id) || []), ...(G.ein.get(id) || []).filter((r) => r.start !== id)].sort((x, y) => x.i - y.i);
    for (const r of alle) {
      const other = r.start === id ? r.end : r.start;
      if (BELEG.includes(r.type) && G.elemente[other]) {
        const el = G.elemente[other];
        ev.push({ type: r.type, quote: ab(r.props.quote), verified: ab(r.props.verified), via: ab(r.props.via || r.props.source),
          element_id: other, citation: ab(el.citation), text: (el.text || "").slice(0, 1200), doc: ab(el.doc), i: r.i });
        continue;
      }
      rels.push({ r, other, outgoing: r.start === id });
    }
    rels.sort((x, y) => vergleich([x.r.type, x.other, x.r.i], [y.r.type, y.other, y.r.i]));
    ev.sort((x, y) => vergleich([x.type !== "DERIVED_FROM" ? 1 : 0, x.element_id, x.i], [y.type !== "DERIVED_FROM" ? 1 : 0, y.element_id, y.i]));
    ev.forEach((e) => delete e.i);
    const relOut = rels.slice(0, 500).map(({ r, other, outgoing }) => {
      const spec = relSpec(r.type), o = ref(other);
      const [start, end] = outgoing ? [id, other] : [other, id];
      const [aL, bL] = outgoing ? [labels, o.labels] : [o.labels, labels];
      const cur = !!(spec && schnitt(spec.from, aL) && schnitt(spec.to, bL));
      return { type: r.type, outgoing, props: r.props || {}, other: o, group: relGruppe(r.type), herkunft: r.h,
        curate: cur ? { start, end, type: r.type, start_label: outgoing ? a.label : o.label, status_prop: spec.status_prop || "status" } : null };
    });
    const pathOut = (a.pf || []).map((pi) => {
      const pth = K.pfade[pi], ei = pth.edge ?? null, spec = ei != null ? relSpec(ersteRel(pth, ei)) : null;
      const rows = walk(pth, id, K.pfad_limit).map(([nodes, edges]) => {
        const refs = nodes.map((x) => (x == null ? null : ref(x)));
        const er = ei != null && ei < edges.length ? edges[ei] : null, edge = er ? { ...er.props } : {};
        let curate = null;
        if (spec && ei != null && refs[ei] != null) {
          let start = ei === 0 ? id : (refs[ei - 1] || {}).id, end = refs[ei].id;
          const rein = pth.steps[ei].dir === "in";
          if (rein) [start, end] = [end, start];
          const an = rein ? refs[ei] : ei ? refs[ei - 1] : null;
          curate = { start: ab(start), end, type: ersteRel(pth, ei), start_label: an ? an.label : a.label, status_prop: spec.status_prop || "status" };
        }
        return { nodes: refs, edge, curate, herkunft: er && Object.keys(edge).length ? er.hp : null };
      });
      const stp = (spec || {}).status_prop || "status", scp = (spec || {}).score_prop || "score";
      const key = (r) => [STATUS_ORDER[r.edge[stp]] ?? 1, -parseFloat(r.edge[scp] || 0) || 0, r.nodes.map((x) => ((x || {}).title || "").toLowerCase())];
      rows.sort((x, y) => vergleich(key(x), key(y)));
      return { id: pth.id, group: ab(pth.group), title: ab(pth.title), columns: pth.columns || pth.steps.map((_, i) => `Schritt ${i + 1}`), edge: ei, rows };
    });
    let eq = null;
    if (K.aequivalenz) eq = gleichbedeutend(id, equivKlasse(id));
    ableiten(id, relOut, pathOut);
    if (eq) eq.inherited = geerbt(id, relOut);
    const editable = K.felder[a.type] || {}, hk = new Set(K.herkunft_props);
    return entscheidungen({ ...zusammenfassung(id), label: a.label, props, editable,
      readonly: Object.keys(props).filter((k) => !(k in editable) && !hk.has(k)).sort(), relations: relOut, paths: pathOut,
      evidence: ev, equivalents: eq, chapter: ab(a.chapter), herkunft: ab(a.herkunft), allgemein: ab(a.allgemein) });
  }
  // ---------------------------------------------------------------- Suche (MemoryStore.search + rank_key)
  const strs = (v) => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
  let index = null;
  function suchindex() {
    if (index) return index;
    const K = G.K;
    index = Object.entries(G.knoten).filter(([, n]) => n.such).map(([id, n]) => {
      const p = n.p, a = n.a, t = a.type || "", title = a.title;
      return { id, labels: n.l, status: n.such === 1 ? p.status || "extracted" : null, doc: a.doc, lang: a.lang,
        abbr: strs(p.abbreviations).concat(strs(p.abbreviation)),
        names: [...K.title_keys, "prefLabelEn", "labelEn"].flatMap((k) => strs(p[k])).concat(strs(p.altLabels), strs(p.altLabelsEn), strs(p.hiddenLabels)),
        texts: K.text_keys.flatMap((k) => strs(p[k])),
        hay: [id, ...K.such_keys.map((k) => String(p[k] ?? "")), ...(p.abbreviations || []), ...(p.altLabels || []), ...(p.altLabelsEn || []), ...(p.hiddenLabels || [])]
          .map((h) => String(h).toLowerCase()),
        typ: K.typ_ordnung[t] ?? 99, def: p.definition || p.description ? 0 : 1, title, tl: String(title).toLowerCase() };
    });
    return index;
  }
  function stufe(r, q) {
    const ql = q.toLowerCase(), lo = (x) => String(x).toLowerCase();
    const wort = new RegExp(`(?<![\\p{L}\\p{N}_])${ql.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "u");
    if (r.abbr.includes(q)) return 0;
    if (r.abbr.some((x) => lo(x) === ql)) return 1;
    if (r.names.some((n) => lo(n) === ql)) return 2;
    if ([...r.names, ...r.abbr].some((x) => lo(x).startsWith(ql))) return 3;
    if (r.names.some((n) => wort.test(lo(n)))) return 4;
    if ([...r.names, ...r.abbr].some((x) => lo(x).includes(ql))) return 5;
    if (r.texts.some((x) => wort.test(lo(x)))) return 6;
    return 7;
  }
  async function suchen(u) {
    if (!(await graph())) return [];
    const g = (k) => u.searchParams.get(k) || "";
    const q = g("q").trim(), ql = q.toLowerCase(), label = g("label"), status = g("status"), doc = g("doc"), lang = g("lang");
    const limit = Math.min(Number(g("limit") || 50), 2000);
    if (g("scope") === "link" && !q) return [];
    const treffer = suchindex().filter((r) => (!label || r.labels.includes(label)) && (!status || r.status === status)
      && (!doc || r.doc === doc) && (!lang || r.lang === lang) && (!ql || r.hay.some((h) => h.includes(ql))));
    const key = (r) => (q ? [stufe(r, q), r.typ, r.def, r.title.length, r.tl] : [0, r.typ, r.tl]);
    const ks = new Map(treffer.map((r) => [r, key(r)]));
    treffer.sort((a, b) => vergleich(ks.get(a), ks.get(b)));
    return treffer.slice(0, limit).map((r) => zusammenfassung(r.id));
  }
  const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");
  async function volltext(u) {
    const v = (await laden("volltext.json")) || { absaetze: [] };
    const w = norm(u.searchParams.get("q")).split(/\s+/).filter(Boolean);
    const t = w.length ? v.absaetze.filter((b) => w.every((x) => norm(b.text).includes(x))) : [];
    return { dokument: v.dokument, treffer: t.slice(0, 60), mehr: t.length > 60, anzahl: t.length };
  }
  // ---------------------------------------------------------------- fetch ersetzen
  window.fetch = async function (eingabe, opts = {}) {
    const url = typeof eingabe === "string" ? eingabe : eingabe.url;
    const u = new URL(url, location.href);
    if (u.origin !== location.origin) return echt(eingabe, opts);
    const pfad = u.pathname.replace(/^.*?(\/api\/|\/static\/)/, "$1");
    if (pfad.startsWith("/static/")) return echt(assets + pfad.slice("/static/".length), opts);
    if (!pfad.startsWith("/api/")) return echt(eingabe, opts);
    if ((opts.method || "GET").toUpperCase() !== "GET")
      return antwort({ message: "In der öffentlichen Demo nur lesen" }, 403);
    if (pfad === "/api/search") return antwort(await suchen(u));
    if (pfad === "/api/luecken/volltext") return antwort(await volltext(u));
    if (pfad === "/api/history") return antwort([]);
    if (pfad === "/api/node") {
      if (!(await graph())) return antwort({ message: "Graph der Demo nicht geladen" }, 503);
      const d = details(u.searchParams.get("id") || "", u.searchParams.get("label") || "");
      return d ? antwort(d) : antwort({ message: "Knoten nicht gefunden" }, 404);
    }
    const index = (await laden("api/index.json")) || {};
    const params = [...u.searchParams.entries()];
    const datei = index[schluessel(pfad, params)] || index[schluessel(pfad, params.filter(([k]) => k === "id" || k === "doc"))];
    if (!datei) return antwort({ message: "In der statischen Demo nicht verfügbar" }, 404);
    return echt(daten + "api/" + datei);
  };
  // Sprung in den Document Structure Viewer: Seite des Dokuments mit #ref (docling.json)
  let ziele = null;
  laden("docling.json").then((d) => { ziele = d; });
  window.KANONIK_STATIC.doclingUrl = function (p) {
    if (!ziele) return "#";
    const z = (p.el && ziele.ziele[`el:${p.el}`]) || (p.node && ziele.ziele[`node:${p.node}`])
      || (p.doc && p.section && ziele.ziele[`section:${p.doc}:${p.section}`]) || (p.doc ? { doc: p.doc, ref: p.ref } : null);
    if (!z || !ziele.verfuegbar.includes(z.doc)) return "#";
    return `${ziele.dokumente}${encodeURIComponent(z.doc)}.html${z.ref ? "#ref=" + encodeURIComponent(z.ref) : ""}`;
  };
  window.KANONIK_STATIC.bereit = laden("docling.json");
})();
