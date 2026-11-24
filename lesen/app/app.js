/* Kanonik-Kuration – Oberfläche ohne externe Bibliotheken. Alle Texte aus dem Graph werden per textContent gesetzt. */
"use strict";

// ------------------------------------------------------------------ Sprache (Deutsch = Quelltexte, Englisch: i18n/en.json)
const LANGS = { de: "Deutsch", en: "English" };
const I18N = { lang: "de", dict: {} };
function pickLang() {
  let v = null;
  try { v = localStorage.getItem("curator.lang"); } catch { /* privater Modus */ }
  if (v && LANGS[v]) return v;
  return (navigator.language || "de").toLowerCase().startsWith("de") ? "de" : "en";
}
async function loadLang() {
  I18N.lang = pickLang();
  document.documentElement.lang = I18N.lang;
  if (I18N.lang === "de") return;
  try {
    const res = await fetch(`/static/i18n/${I18N.lang}.json`, { cache: "no-store" });
    if (res.ok) I18N.dict = await res.json();
  } catch { /* ohne Übersetzung: deutsche Texte */ }
}
// t("Text {n}", {n: 3}): Übersetzung des deutschen Texts; fehlt sie, bleibt der deutsche Text
function t(text, params) {
  if (text === undefined || text === null) return text;
  let out = I18N.dict[text] ?? text;
  if (params) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  return out;
}
// Einzahl/Mehrzahl (v63.0.3): tp(n, "1 Entscheidung", "{n} Entscheidungen", { … })
function tp(n, one, many, params = {}) { return t(Number(n) === 1 ? one : many, { n, ...params }); }
// Text aus curation_config.json: "Text" (alle Sprachen) oder {"de": "…", "en": "…"}
function L(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) return v[I18N.lang] ?? v.de ?? Object.values(v)[0] ?? "";
  return v;
}
function localizeConfig(cfg) {
  for (const spec of Object.values(cfg.labels || {})) for (const f of Object.values(spec.editable || {})) if (f.label) f.label = L(f.label);
  const rel = cfg.relations || {};
  for (const g of rel.groups || []) g.title = L(g.title);
  for (const pth of rel.paths || []) { pth.title = L(pth.title); if (pth.columns) pth.columns = pth.columns.map(L); }
  for (const lt of Object.values((rel.links || {}).types || {})) { lt.title = L(lt.title); if (lt.inverse) lt.inverse = L(lt.inverse); }
  for (const ml of Object.values(rel.method_labels || {})) { ml.title = L(ml.title); ml.hint = L(ml.hint); }
  for (const k of Object.keys(rel.rel_titles || {})) rel.rel_titles[k] = L(rel.rel_titles[k]);
  for (const tg of Object.values(rel.retype || {})) for (const k of Object.keys(tg)) tg[k] = L(tg[k]);
  return cfg;
}
const tr = (obj) => new Proxy(obj, { get: (o, k) => (k in o ? t(o[k]) : undefined) });

const STATUS_DE = tr({ extracted: "extrahiert", curated: "bearbeitet", confirmed: "verifiziert", rejected: "abgelehnt" });
const ACTION_DE = tr({ save: "gespeichert", verify: "verifiziert", unverify: "Verifizierung aufgehoben", reject: "abgelehnt", create: "angelegt" });
const state = { basis: [], basisNote: "", basisKeep: false, basisOpen: false, config: null, results: [], node: null, original: {}, values: {}, errors: {}, pending: null, selected: null,
  display: null, seenTypes: new Set(), tab: "nodes", proposals: { items: [], total: 0 } };
const REL_STATUS_DE = tr({ candidate: "Vorschlag", implied: "transitiv bestätigt", confirmed: "bestätigt", rejected: "abgelehnt", auto: "automatisch", source: "aus Quelle", deleted: "gelöscht" });
const LINK_ACTION_DE = tr({ add: "Verknüpfung angelegt", remove: "Verknüpfung entfernt" });
const REL_ACTION_DE = tr({ confirm: "Zuordnung bestätigt", reject: "Zuordnung abgelehnt", reset: "Zuordnung zurückgesetzt" });
const CANDIDATE_FILTER = tr({ all: "alle Zuordnungen", no_rejected: "ohne abgelehnte", confirmed: "nur bestätigte", min_score: "Vorschläge ab Score" });

// ------------------------------------------------------------------ Hilfen
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);
// Statische Lese-Oberfläche der öffentlichen Demo (curator/static/static.js, tools/demo_lesen.py): Dateien statt Server
const STATIC = !!window.KANONIK_STATIC;
const ASSET = (window.KANONIK_STATIC && window.KANONIK_STATIC.assets) || "/static/";
function pill(status) {
  const s = status || "extracted";
  return h("span", { class: `pill st-${s}`, text: STATUS_DE[s] || s });
}
function fmtTs(ts) {
  if (!ts) return "";
  try { return new Date(ts).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }); } catch { return ts; }
}
function fmtVal(v) {
  if (v === null || v === undefined || v === "") return "–";
  if (Array.isArray(v)) return v.length ? v.join(" · ") : "–";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function toast(msg, isError = false) {
  const box = $("toast");
  box.textContent = msg;
  box.className = "toast" + (isError ? " error" : "");
  box.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { box.hidden = true; }, isError ? 7000 : 3000);
}
// Laufende Anfragen: Fortschrittsbalken oben (erscheint erst nach kurzer Verzögerung, kein Flackern)
let inflight = 0;
function busyChanged(d) {
  inflight = Math.max(0, inflight + d);
  document.body.classList.toggle("busy", inflight > 0);
  document.body.setAttribute("aria-busy", String(inflight > 0));
}
async function api(path, opts = {}) {
  const decision = DECISION_PATHS.includes(path) && opts.body;     // Entscheidung: Grundlage mitschicken
  if (decision) opts = { ...opts, body: withBasis(opts.body) };
  busyChanged(1);
  try {
    const res = await apiRaw(path, opts);
    if (decision) basisUsed();
    if (changesData(path, opts)) scheduleListRefresh();
    if (res && res.transitiv && (res.transitiv.done || res.transitiv.failed.length)) showTransitiv(res.transitiv);
    return res;
  } finally { busyChanged(-1); }
}
// Nach jeder Änderung (Speichern, Status, Zuordnung, Verknüpfung, Sammelaktion, neuer Begriff …) die Liste links
// neu laden – Treffer bzw. Beziehungsvorschläge zeigen dann Status und Zählungen ohne „neu laden“ (v62.7.2)
const NO_REFRESH = ["/api/chat", "/api/chat/key"];
function changesData(path, opts) {
  const m = String((opts && opts.method) || "GET").toUpperCase();
  return m !== "GET" && m !== "HEAD" && path.startsWith("/api/") && !NO_REFRESH.includes(path.split("?")[0]);
}
// v62.7.4: Vorschläge, die sich durch die Entscheidung schon transitiv ergeben, schließt der Server gleich ab
// (abgelehnt mit Grund und Weg); hier eigenes Feld mit der Liste und „Rückgängig“ (Sammelentscheidung „transitiv“)
function showTransitiv(tr) {
  let box = $("transitiv-panel");
  if (!box) { box = h("aside", { id: "transitiv-panel", class: "tr-panel", role: "status", "aria-live": "polite" }); document.body.append(box); }
  const link = (r) => h("a", { href: nodeHash(r.id, null), class: "link", onclick: (ev) => { if (ev.button || ev.ctrlKey || ev.metaKey) return; ev.preventDefault(); setTab("nodes"); openNode(r.id); } }, r.title || r.id);
  const undo = async () => {
    const user = $("user").value.trim();
    if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); return; }
    try { const r = await api("/api/batch/undo", { method: "POST", body: JSON.stringify({ batch: tr.batch, user }) });
      toast(t("{d} zurückgenommen", { d: r.done })); box.hidden = true;
      if (state.node) openNode(state.node.id, { force: true, label: state.node.type ? null : state.node.label }); }
    catch (e) { toast(e.message, true); }
  };
  box.replaceChildren(...[                         // ohne null (replaceChildren schreibt sonst „null“)
    h("div", { class: "tr-head" }, h("strong", { text: t("Dadurch transitiv erledigt ({n})", { n: tr.done }) }),
      h("button", { type: "button", class: "link small", "aria-label": t("Schließen"), onclick: () => { box.hidden = true; } }, "✕")),
    h("div", { class: "small muted", text: t("Diese Vorschläge ergeben sich jetzt schon aus bestätigten Verknüpfungen und wurden abgeschlossen (abgelehnt mit Grund „ergibt sich transitiv über …“, Weg als Grundlage). In der Auswertung je Quelle zählen sie nicht als Fehler.") }),
    h("ul", { class: "plain small tr-list" }, ...tr.items.map((r) => h("li", {}, link(r.start_ref), h("span", { class: "muted", text: ` –[${relTitle(r.type)}]→ ` }), link(r.end_ref),
      h("span", { class: "muted", text: ` · ${t("über")} ` }), ...r.via_refs.flatMap((v, i) => [i ? " → " : "", link(v)])))),
    tr.failed.length ? h("details", { class: "small" }, h("summary", { text: t("{f} nicht möglich (inzwischen geändert?)", { f: tr.failed.length }) }),
      h("ul", { class: "plain small" }, ...tr.failed.map((f) => h("li", { text: `${f.start} –[${relTitle(f.type)}]→ ${f.end}: ${f.message}` })))) : null,
    h("div", { class: "el-bar" }, tr.batch ? h("button", { type: "button", class: "small", onclick: undo }, t("Rückgängig")) : null,
      h("button", { type: "button", class: "small link", onclick: () => { box.hidden = true; } }, t("Schließen")))].filter(Boolean));
  box.hidden = false;
}
let listRefreshTimer = null;
function scheduleListRefresh() {
  clearTimeout(listRefreshTimer);
  listRefreshTimer = setTimeout(() => {
    loadAbbr();
    if (state.tab === "nodes" && state.results) search(false, { keep: true });
    else if (state.tab === "props" && state.proposals) searchProposals(false, { keep: true });
  }, 350);
}
async function apiRaw(path, opts) {
  // Bearbeitername mitschicken: Mengenbegrenzung je Person ohne Anmeldung (v63.1, common/schutz.py)
  const who = ($("user") && $("user").value.trim()) || "";
  const res = await fetch(path, { headers: { "Content-Type": "application/json", ...(who ? { "X-Kanonik-User": encodeURIComponent(who) } : {}) }, ...opts });
  let body = null;
  try { body = await res.json(); } catch { /* leer */ }
  if (!res.ok) {
    // Pfad unbekannt (Antwort des Webservers, nicht des Curators): Oberfläche neuer als der laufende Server
    const stale = res.status === 404 && body && body.detail === "Not Found" && path.startsWith("/api/");
    const err = new Error(stale ? t("Der laufende Curator kennt {p} noch nicht – die Oberfläche ist neuer als der Server. Bitte den Curator neu starten.", { p: path.split("?")[0] })
      : errorText(body) || `HTTP ${res.status}`);
    err.status = res.status; err.body = body;
    throw err;
  }
  return body;
}
// Ladeanzeige: Platzhalter mit Drehsymbol; Liste links und Detailbereich markieren, solange geladen wird
function loadingEl(text = null, cls = "") {
  return h("div", { class: `loading-ph ${cls}`, role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), text || t("lädt …"));
}
// je Liste (Reiter) eine laufende Nummer: nur die Antwort auf die letzte Anfrage zählt
function nextSeq(tab) { state.seq = state.seq || {}; state.seq[tab] = (state.seq[tab] || 0) + 1; return state.seq[tab]; }
function isSeq(tab, n) { return state.seq && state.seq[tab] === n; }
function listLoading(tab, show = true) {
  const n = nextSeq(tab);
  const b = $(`tab-${tab}`);
  if (b) b.classList.add("tab-busy");
  if (show && state.tab === tab) {
    $("result-info").textContent = t("lädt …");
    $("results").replaceChildren(h("li", { class: "loading-li", role: "option", "aria-disabled": "true" }, loadingEl()));
    $("results").setAttribute("aria-busy", "true");
  }
  return n;
}
function listDone(tab) {
  const b = $(`tab-${tab}`);
  if (b) b.classList.remove("tab-busy");
  if (state.tab === tab) $("results").removeAttribute("aria-busy");
}
function detailLoading(on) {
  const d = $("detail");
  d.classList.toggle("loading", on);
  if (on) d.setAttribute("aria-busy", "true"); else d.removeAttribute("aria-busy");
}
// Blättern in langen Tabellen: „‹ zurück · 1–100 von 834 · weiter ›“
function pagerEl(total, page, size, onPage) {
  if (total <= size) return null;
  const pages = Math.ceil(total / size), a = page * size + 1, b = Math.min(total, (page + 1) * size);
  return h("div", { class: "pager small" },
    h("button", { type: "button", class: "small", disabled: page <= 0, onclick: () => onPage(page - 1) }, "‹ " + t("zurück")),
    h("span", { class: "muted", text: t("{a}–{b} von {n}", { a, b, n: total }) + " · " + t("Seite {p} von {m}", { p: page + 1, m: pages }) }),
    h("button", { type: "button", class: "small", disabled: page >= pages - 1, onclick: () => onPage(page + 1) }, t("weiter") + " ›"));
}
// Lange Liste schrittweise: erst size Einträge, dann „weitere k anzeigen“
function growList(ul, items, render, size = 100) {
  let shown = 0;
  const more = h("li", { class: "more" });
  const step = () => {
    const next = items.slice(shown, shown + size).map(render);
    shown += next.length;
    more.remove();
    ul.append(...next);
    if (shown < items.length) {
      more.replaceChildren(h("button", { type: "button", class: "small", onclick: step }, t("weitere {k} anzeigen", { k: Math.min(size, items.length - shown) }) + ` (${items.length - shown})`));
      ul.append(more);
    }
  };
  step();
  return ul;
}
// Fehlermeldung des Servers: Vorlage (key) übersetzen, Parameter einsetzen ({de, en} in der gewählten Sprache)
function errorText(body) {
  if (!body) return null;
  if (body.key) {
    const params = {};
    for (const [k, v] of Object.entries(body.params || {})) params[k] = L(v);
    return t(body.key, params);
  }
  return body.message || null;
}
// Titel eines Knotens: in der englischen Ansicht die englische Benennung, wo es eine gibt
function ttl(x) {
  if (!x) return "";
  return (I18N.lang === "en" && x.titleEn) || x.title || x.id || "";
}
// Abkürzungen im Titel (v63.0.4): <abbr> mit der langen Form beim Zeigen (aus den Begriffen/Rollen, /api/abbreviations)
const ABBR = { map: {}, rx: null };
async function loadAbbr() {
  try { ABBR.map = await api("/api/abbreviations"); } catch { ABBR.map = {}; }
  const keys = Object.keys(ABBR.map).sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  ABBR.rx = keys.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${keys.join("|")})(?![\\p{L}\\p{N}])`, "gu") : null;
}
function abbrTitle(a) {
  return (ABBR.map[a] || []).map((x) => (I18N.lang === "en" && x.en ? `${x.en} (${x.de})` : x.de + (x.en ? ` – ${x.en}` : ""))).join(" / ");
}
function abbrify(text) {
  const s = String(text ?? "");
  if (!ABBR.rx || !s) return s;
  const out = [];
  let last = 0;
  for (const m of s.matchAll(ABBR.rx)) {
    const long = abbrTitle(m[1]);
    if (!long || long.split(" / ").some((l) => s.includes(l.split(" – ")[0]))) continue;   // lange Form steht schon da
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(h("abbr", { title: long, text: m[1] }));
    last = m.index + m[1].length;
  }
  if (!out.length) return s;
  if (last < s.length) out.push(s.slice(last));
  return out;
}
function ttlHint(x) { return I18N.lang === "en" && x && x.titleEn && x.title !== x.titleEn ? x.title : null; }
// Ansicht je Fenster (Reiter, Typ, Filter, Auswahl in Karten): zuerst sessionStorage dieses Fensters, localStorage nur
// als Vorgabe für neue Fenster – ein neu geladenes Fenster übernimmt so nicht die Ansicht eines anderen
const WINDOW_KEYS = new Set(["curator.tab", "curator.type", "curator.filters", "curator.same", "curator.rrStage",
  "curator.daCtx", "curator.daPart", "curator.kindFilter"]);
function storage(key, value) {
  const own = WINDOW_KEYS.has(key);
  try {
    if (value === undefined) return (own ? sessionStorage.getItem(key) : null) ?? localStorage.getItem(key);
    if (own) sessionStorage.setItem(key, value);
    localStorage.setItem(key, value);
  } catch { /* privater Modus */ }
  return null;
}

// ------------------------------------------------------------------ Werte
function normalize(spec, v) {
  if (spec.type === "list") {
    const arr = Array.isArray(v) ? v : (typeof v === "string" ? v.split("\n") : []);
    const out = [];
    for (const x of arr.map((s) => String(s).trim())) if (x && !out.includes(x)) out.push(x);
    return out;
  }
  if (spec.type === "boolean") return v === true || v === false ? v : null;
  if (spec.type === "number") return v === "" || v === null || v === undefined ? null : Number(v);
  if (v === null || v === undefined) return null;
  const s = spec.type === "textarea" ? String(v).replace(/\r\n/g, "\n").replace(/^[\n ]+|[\n ]+$/g, "") : String(v).trim();
  return s === "" ? null : s;
}
function same(a, b) {
  const empty = (x) => x === null || x === undefined || x === "" || (Array.isArray(x) && x.length === 0);
  if (empty(a) && empty(b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}
function validateField(spec, v) {
  if (spec.required && (v === null || (Array.isArray(v) && !v.length))) return t("Pflichtfeld");
  if (spec.max_length && typeof v === "string" && v.length > spec.max_length) return t("höchstens {max} Zeichen ({n})", { max: spec.max_length, n: v.length });
  if (spec.type === "text" && typeof v === "string" && v.includes("\n")) return t("kein Zeilenumbruch");
  if (spec.type === "number" && v !== null && Number.isNaN(v)) return t("Zahl erwartet");
  return null;
}
function changes(values = state.values) {
  const out = {};
  const ed = state.node ? state.node.editable : {};
  for (const [k, spec] of Object.entries(ed)) {
    const v = normalize(spec, values[k]);
    if (!same(v, normalize(spec, state.original[k]))) out[k] = v;
  }
  return out;
}
const isDirty = () => Object.keys(changes()).length > 0;

// ------------------------------------------------------------------ Kopf, Suche
async function loadStats() {
  try {
    const s = await api("/api/stats");
    const el = $("stats");
    el.replaceChildren(...Object.keys(STATUS_DE).filter((k) => s[k]).map((k) =>
      h("span", { class: `pill st-${k}`, title: STATUS_DE[k] }, `${STATUS_DE[k]} ${s[k]}`)));
  } catch { /* egal */ }
}

let searchTimer = null;
function scheduleSearch() { clearTimeout(searchTimer); searchTimer = setTimeout(search, 220); }
const SEARCH_PAGE = 200;
async function search(more = false, { keep = false } = {}) {
  // keep: nach einer Änderung neu laden – ohne Platzhalter, gleiche Länge und Stelle der Liste (v62.7.2)
  const q = $("q").value, label = $("f-type").value, status = $("f-status").value, doc = $("f-doc").value;
  state.searchLimit = more ? (state.searchLimit || SEARCH_PAGE) + SEARCH_PAGE : keep ? (state.searchLimit || SEARCH_PAGE) : SEARCH_PAGE;
  const seq = listLoading("nodes", !more && !keep);
  if (more) { const b = $("results").querySelector("li.more"); if (b) { b.setAttribute("aria-disabled", "true"); b.replaceChildren(loadingEl()); } }
  const p = new URLSearchParams({ q, limit: String(state.searchLimit) });
  if (label) p.set("label", label);
  if (doc) p.set("doc", doc);
  if (status) p.set("status", status);
  if ($("f-herkunft").value) p.set("herkunft", $("f-herkunft").value);
  const fl = activeFilters();
  if (fl.length) p.set("filters", JSON.stringify(fl));
  let res;
  try {
    res = await api(`/api/search?${p}`);
  } catch (e) { if (isSeq("nodes", seq)) { listDone("nodes"); toast(t("Suche fehlgeschlagen: {msg}", { msg: e.message }), true); } return; }
  if (!isSeq("nodes", seq)) return;                 // inzwischen neuere Suche
  const keepScroll = more || keep ? $("results").scrollTop : 0;
  state.results = res;
  listDone("nodes");
  renderResults();
  if (more || keep) $("results").scrollTop = keepScroll;
}
// „weitere laden“ in einer Auswahlliste (role=listbox): selbst eine Option, kein Knopf darin (BITV: nur Optionen im listbox)
function mehrOption(laden) {
  const li = h("li", { class: "more", role: "option", tabindex: "0", "aria-selected": "false",
    onclick: () => { if (li.getAttribute("aria-disabled") !== "true") laden(); },
    onkeydown: (e) => { if ((e.key === "Enter" || e.key === " ") && li.getAttribute("aria-disabled") !== "true") { e.preventDefault(); laden(); } } },
  h("span", { class: "small link", text: t("weitere laden") }));
  return li;
}
function renderResults() {
  if (state.tab !== "nodes") return;
  const ul = $("results");
  const lim = state.searchLimit || SEARCH_PAGE, full = state.results.length >= lim;
  const cap = ((state.config.schutz || {}).seiten || {}).suche;             // v63.1: kleinere Seiten (Option)
  const capped = cap && state.results.length >= cap;
  $("result-info").textContent = capped ? t("{n}+ Treffer – bitte Suche eingrenzen (höchstens {n} je Suche)", { n: cap })
    : full ? t("{n}+ Treffer – Suche eingrenzen oder weitere laden", { n: lim }) : t("{n} Treffer", { n: state.results.length });
  ul.replaceChildren(...state.results.map((r) => h("li", {
    role: "option", tabindex: "0", "aria-selected": String(r.id === state.selected), "data-id": r.id,
    onclick: () => openNode(r.id, { label: r.type ? null : r.label }),
    onkeydown: (e) => { if (e.key === "Enter") openNode(r.id, { label: r.type ? null : r.label }); },
  }, h("div", { class: "r-title", title: ttlHint(r) }, abbrify(ttl(r))),
     h("div", { class: "r-meta" }, h("span", { class: "pill type", text: r.type || r.label }),
       r.type ? pill(r.status) : h("span", { class: "pill ro", text: t("nur lesen") }), docBadge(r), r.subtitle ? h("span", { text: r.subtitle }) : null),
     r.fields && Object.keys(r.fields).length ? h("div", { class: "r-fields" }, ...Object.entries(r.fields).map(([k, v]) =>
       h("span", {}, h("span", { class: "mono muted", text: `${k}: ` }), v))) : null)));
  ul.setAttribute("role", "listbox");
  if (full && !capped && lim < 2000) ul.append(mehrOption(() => search(true)));
}
// ------------------------------------------------------------------ Erweiterte Suche: Filter über Eigenschaften
const FILTER_OPS = tr({ contains: "enthält", not_contains: "enthält nicht", eq: "gleich", ne: "ungleich", starts: "beginnt mit",
  empty: "leer", filled: "nicht leer", gt: "größer als", lt: "kleiner als" });
state.filters = (() => { try { return JSON.parse(storage("curator.filters") || "[]"); } catch { return []; } })();
state.propKeys = {};
function activeFilters() {
  return (state.filters || []).filter((f) => f.prop && (f.op === "empty" || f.op === "filled" || String(f.value || "").trim() !== ""));
}
async function propKeys(label) {
  const key = label || "";
  if (!state.propKeys[key]) {
    try { state.propKeys[key] = await api(`/api/props?${new URLSearchParams(label ? { label } : {})}`); }
    catch (e) { toast(e.message, true); state.propKeys[key] = []; }
  }
  return state.propKeys[key];
}
function saveFilters(run = true) {
  storage("curator.filters", JSON.stringify(state.filters));
  const n = activeFilters().length;
  $("adv-count").textContent = n ? String(n) : "";
  if (n && !$("adv").open) $("adv").open = true;
  if (run) scheduleSearch();
}
async function renderAdv() {
  const keys = await propKeys($("f-type").value);
  const known = new Set(keys.map((k) => k.key));
  $("adv-rows").replaceChildren(...state.filters.map((f, i) => {
    const prop = h("select", { "aria-label": t("Eigenschaft") }, h("option", { value: "", text: t("Eigenschaft …") }),
      ...(f.prop && !known.has(f.prop) ? [h("option", { value: f.prop, text: f.prop })] : []),
      ...keys.map((k) => h("option", { value: k.key, text: `${k.key} (${k.count})`, title: k.samples.join(" | ") })));
    prop.value = f.prop || "";
    const op = h("select", { "aria-label": t("Vergleich") }, ...Object.entries(FILTER_OPS).map(([v, lab]) => h("option", { value: v, text: lab })));
    op.value = f.op || "contains";
    const val = h("input", { type: "text", value: f.value || "", placeholder: t("Wert"), "aria-label": t("Wert"),
      hidden: f.op === "empty" || f.op === "filled" });
    const k = keys.find((x) => x.key === f.prop);
    if (k && k.samples.length) val.setAttribute("title", t("z. B. {s}", { s: k.samples.join(" | ") }));
    prop.addEventListener("change", () => { f.prop = prop.value; saveFilters(); renderAdv(); });
    op.addEventListener("change", () => { f.op = op.value; val.hidden = f.op === "empty" || f.op === "filled"; saveFilters(); });
    val.addEventListener("input", () => { f.value = val.value; saveFilters(); });
    const del = h("button", { type: "button", class: "small", title: t("Filter entfernen"), "aria-label": t("Filter entfernen"),
      onclick: () => { state.filters.splice(i, 1); saveFilters(); renderAdv(); } }, "×");
    return h("div", { class: "adv-row" }, prop, op, val, del);
  }));
  saveFilters(false);
}

// ------------------------------------------------------------------ Verlauf der Ansichten (Zurück/Vor im Browser)
// Knoten stehen als #n=… im Verlauf, Reiter und Kategorien als #v=<reiter>&k=<kategorie> – so führt „Zurück“ durch die
// Ansichten (z. B. Lücken → Suchen → Nach Lückentyp) statt aus der Oberfläche heraus.
const KAT = { gap: "gapCat", dec: "decCat", src: "srcCat" };
function ansichtHash(tab, kat) {
  const p = new URLSearchParams({ v: tab });
  if (kat) p.set("k", kat);
  return `#${p}`;
}
function ansichtAusHash() {
  const raw = location.hash.slice(1);
  if (!raw.startsWith("v=")) return null;
  const p = new URLSearchParams(raw);
  return { tab: p.get("v"), kat: p.get("k") };
}
// vom Nutzer gewählte Ansicht: anzeigen und in den Verlauf (mit push=false nur anzeigen, z. B. bei Zurück)
function zuAnsicht(tab, kat, push = true) {
  const h = ansichtHash(tab, kat);
  if (push && location.hash !== h) history.pushState({ v: tab, k: kat || null }, "", h);
  state.shownHash = location.hash;
  if (kat && KAT[tab]) state[KAT[tab]] = kat;
  if (state.tab !== tab) setTab(tab);
  else if (kat && tab === "gap") renderGaps(kat);
  else if (kat && tab === "dec") renderDecisions(kat);
  else if (kat && tab === "src") renderSources(kat);
}

// ------------------------------------------------------------------ Knoten
function nodeHash(id, label) {
  const p = new URLSearchParams({ n: id });
  if (label) p.set("l", label);
  return `#${p}`;
}
function parseHash() {
  const raw = location.hash.slice(1);
  if (!raw || raw.startsWith("v=")) return null;      // #v=…: Ansicht (Reiter, Kategorie), kein Knoten
  if (!raw.startsWith("n=")) return { id: decodeURIComponent(raw), label: null };      // ältere Links: nur die ID
  const p = new URLSearchParams(raw);
  return { id: p.get("n"), label: p.get("l") };
}
async function openNode(id, { force = false, push = true, label = null } = {}) {
  if (!force && state.node && isDirty() && id !== state.node.id) {
    state.pending = { id, label };
    renderDetail();
    $("detail").scrollTop = 0;
    return;
  }
  let node;
  const q = new URLSearchParams({ id });
  if (label) q.set("label", label);
  const seq = (state.openSeq = (state.openSeq || 0) + 1);
  detailLoading(true);
  try { node = await api(`/api/node?${q}`); } catch (e) { if (seq === state.openSeq) { detailLoading(false); toast(e.message, true); } return; }
  if (seq !== state.openSeq) return;                // inzwischen anderer Knoten angefordert: ältere Antwort verwerfen
  detailLoading(false);
  state.node = node; state.selected = id; state.pending = null; state.errors = {};
  state.original = {}; state.values = {};
  for (const [k, spec] of Object.entries(node.editable)) {
    state.original[k] = normalize(spec, node.props[k]);
    state.values[k] = state.original[k];
  }
  const hash = nodeHash(id, node.editable && Object.keys(node.editable).length ? null : (label || node.label));
  if (push && location.hash !== hash) history.pushState({ id }, "", hash);
  state.shownHash = location.hash;
  windowTitle();
  for (const r of node.relations) state.seenTypes.add(r.type);
  renderDisplay();
  renderResults();
  renderDetail();
  loadHistory(id);
}

function fieldInput(key, spec) {
  const v = state.values[key];
  const id = `f_${key}`;
  const onChange = (val) => { state.values[key] = val; updateField(key); };
  if (spec.type === "textarea") {
    const ta = h("textarea", { id, rows: String(Math.min(10, Math.max(3, Math.ceil(((v || "").length || 1) / 90)))) });
    ta.value = v || "";
    ta.addEventListener("input", () => onChange(ta.value));
    return ta;
  }
  if (spec.type === "list" && spec.options) {
    const box = h("div", { class: "checks", id, role: "group" });
    for (const opt of spec.options) {
      const cb = h("input", { type: "checkbox", value: opt });
      cb.checked = (v || []).includes(opt);
      cb.addEventListener("change", () => onChange([...box.querySelectorAll("input:checked")].map((x) => x.value)));
      box.append(h("label", {}, cb, opt));
    }
    return box;
  }
  if (spec.type === "list") {
    const ta = h("textarea", { id, rows: String(Math.min(10, Math.max(2, (v || []).length + 1))), placeholder: t("ein Eintrag je Zeile") });
    ta.value = (v || []).join("\n");
    ta.addEventListener("input", () => onChange(ta.value.split("\n")));
    return ta;
  }
  if (spec.type === "enum" || spec.type === "boolean") {
    const opts = spec.type === "boolean" ? [["", "–"], ["true", t("ja")], ["false", t("nein")]] : [["", "–"], ...spec.options.map((o) => [o, o])];
    const sel = h("select", { id }, ...opts.map(([val, lab]) => h("option", { value: val, text: lab })));
    sel.value = v === null || v === undefined ? "" : String(v);
    if (spec.type === "enum" && v && !spec.options.includes(v)) sel.prepend(h("option", { value: v, text: t("{v} (nicht in Auswahl)", { v }) })), (sel.value = v);
    sel.addEventListener("change", () => onChange(spec.type === "boolean" ? (sel.value === "" ? null : sel.value === "true") : sel.value || null));
    return sel;
  }
  const inp = h("input", { id, type: spec.type === "number" ? "number" : "text", maxlength: spec.max_length || null });
  inp.value = v === null || v === undefined ? "" : String(v);
  inp.addEventListener("input", () => onChange(inp.value));
  return inp;
}

function updateField(key) {
  const spec = state.node.editable[key];
  const wrap = document.querySelector(`.field[data-key="${CSS.escape(key)}"]`);
  const val = normalize(spec, state.values[key]);
  const changed = !same(val, state.original[key]);
  const err = validateField(spec, val);
  state.errors[key] = err;
  if (wrap) {
    wrap.classList.toggle("changed", changed);
    wrap.classList.toggle("invalid", !!err);
    wrap.querySelector(".err").textContent = err || "";
    wrap.querySelector(".undo").hidden = !changed;
  }
  updateButtons();
}

function updateButtons() {
  const dirty = isDirty();
  const invalid = Object.values(state.errors).some(Boolean);
  const st = state.node.status;
  const set = (id, dis) => { const b = $(id); if (b) b.disabled = dis; };
  set("btn-save", !dirty || invalid);
  set("btn-verify", invalid || (st === "confirmed" && !dirty));
  set("btn-reset", !dirty);
  set("btn-reject", dirty || st === "rejected");
  set("btn-unverify", dirty || !["confirmed", "rejected"].includes(st));
  const n = Object.keys(changes()).length;
  $("dirty-info").textContent = dirty ? t(n === 1 ? "{n} Feld geändert" : "{n} Felder geändert", { n }) : "";
  $("btn-verify").textContent = dirty ? t("Speichern und verifizieren") : t("Als verifiziert markieren");
}

function renderDetail() {
  $("detail").dataset.maske = "knoten";                 // Handbuch: passendes Kapitel (handbuch.js)
  const n = state.node;
  const root = $("detail");
  if (!n) return;
  const parts = [];
  if (state.pending) {
    parts.push(h("div", { class: "banner warn", role: "alert" },
      h("span", { text: t("Ungespeicherte Änderungen an diesem Knoten.") }),
      h("button", { class: "primary", onclick: () => doAction("save").then((ok) => ok && openNode(state.pending.id, { force: true, label: state.pending.label })) }, t("Speichern und wechseln")),
      h("button", { onclick: () => openNode(state.pending.id, { force: true, label: state.pending.label }) }, t("Verwerfen und wechseln")),
      h("button", { onclick: () => { state.pending = null; renderDetail(); } }, t("Hierbleiben"))));
  }
  if (state.conflict) {
    parts.push(h("div", { class: "banner error", role: "alert" },
      h("span", { text: state.conflict }),
      h("button", { onclick: () => { state.conflict = null; openNode(n.id, { force: true, push: false }); } }, t("Neu laden (eigene Änderungen gehen verloren)"))));
  }
  const readOnlyNode = !n.type;
  const typeId = n.type || n.label || "?";
  const meta = [h("button", { type: "button", class: "pill type pill-link", title: t("Im Metamodell zeigen"), onclick: () => openMeta("node", typeId) }, typeId),
    n.props.archimateType ? h("span", { class: "pill type", title: `ArchiMate: ${n.props.archimateLayer || ""} · ${n.props.archimateAspect || ""}`,
      text: `ArchiMate ${n.props.archimateType}` }) : null,
    n.props.candidate ? h("span", { class: "pill rel-candidate", title: t("Vorschlag: Als verifiziert markieren oder ablehnen"), text: t("Vorschlag") }) : null,
    n.allgemein ? h("span", { class: "pill general", title: t("Allgemeines Wort: keine Vorschläge über die Benennung, Datenelemente mit eigenem englischen Namen bekommen eigene Begriffe")
      + (n.allgemein === "konfiguration" ? t(" (laut configuration/generic_terms.yaml)") : ""), text: t("allgemeines Wort") }) : null,
    readOnlyNode ? h("span", { class: "pill ro", text: t("nur lesen") }) : pill(n.status), docBadge(n, false), herkunftPills(n.herkunft), h("span", { class: "mono", text: n.id }),
    n.onto_class && ontoAn() ? h("button", { type: "button", class: "pill onto-ok pill-link", onclick: () => openOnto(n.onto_class.id),
      title: (n.onto_class.direct ? t("Klasse der Fachontologie") : t("Klasse der Fachontologie (über Oberbegriffe abgeleitet)")) + " – " + t("in der Ontologie zeigen"),
      text: t("Klasse: {c}", { c: n.onto_class.title }) + (n.onto_class.direct ? "" : " ~") }) : null,
    sichtPill(n.sicht && n.sicht.sicht, n.sicht && n.sicht.quelle),
    readOnlyNode ? null : h("span", { text: t("Version {rev}", { rev: n.rev }) }),
    state.config.readonly ? null : basisButton({ art: "knoten", id: n.id, title: ttl(n) }, t("diesen Knoten als Grundlage einer anderen Entscheidung merken")),
    decisionInfo(n.entscheidung)];
  if (n.props.curatedAt) meta.push(h("span", { text: t("bearbeitet {ts} von {user}", { ts: fmtTs(n.props.curatedAt), user: n.props.curatedBy || "?" }) }));
  if (n.props.reviewedAt) meta.push(h("span", { text: t(n.status === "rejected" ? "abgelehnt {ts} von {user}" : "geprüft {ts} von {user}", { ts: fmtTs(n.props.reviewedAt), user: n.props.reviewedBy || "?" }) }));
  parts.push(h("div", { class: "node-head" }, h("h1", {}, abbrify(ttl(n))), ttlHint(n) ? h("div", { class: "muted small", lang: "de", text: ttlHint(n) }) : null, h("div", { class: "meta" }, ...meta),
    n.props.reviewComment ? h("div", { class: "muted small", text: t("Kommentar: {c}", { c: n.props.reviewComment }) }) : null));

  // Formular
  const fields = Object.entries(n.editable).map(([k, spec]) => {
    const wrap = h("div", { class: "field", "data-key": k },
      h("label", { for: `f_${k}` }, L(spec.label) || k, h("span", { class: "hint mono", text: k }), spec.required ? h("span", { class: "hint", text: t("Pflicht") }) : null,
        (n.props.curatedProps || []).includes(k) ? h("span", { class: "hint", text: t("manuell gepflegt") }) : null,
        h("button", { type: "button", class: "link undo", hidden: true, onclick: () => { state.values[k] = state.original[k]; renderDetail(); } }, t("zurücksetzen"))),
      fieldInput(k, spec), h("div", { class: "err" }));
    return wrap;
  });
  const comment = h("input", { id: "comment", type: "text", class: "comment", placeholder: t("Kommentar zur Prüfung (optional)"), maxlength: "500" });
  const form = h("form", { class: "card", onsubmit: (e) => { e.preventDefault(); doAction("save"); } },
    h("h2", { text: Object.keys(n.editable).length ? t("Bearbeitbare Eigenschaften") : t("Keine bearbeitbaren Eigenschaften") }),
    h("div", { class: "fields" }, ...fields),
    h("div", { class: "actions" },
      h("button", { id: "btn-save", type: "submit", class: "primary" }, t("Speichern")),
      h("button", { id: "btn-verify", type: "button", onclick: () => doAction("verify") }, t("Als verifiziert markieren")),
      h("button", { id: "btn-reset", type: "button", onclick: () => { for (const k in state.values) state.values[k] = state.original[k]; renderDetail(); } }, t("Alles zurücksetzen")),
      h("span", { id: "dirty-info", class: "muted small" }),
      h("span", { class: "spacer" }),
      comment,
      h("button", { id: "btn-unverify", type: "button", onclick: () => doAction("unverify") }, t("Verifizierung aufheben")),
      h("button", { id: "btn-reject", type: "button", class: "danger", onclick: () => doAction("reject") }, t("Ablehnen"))));
  const viewer = !!state.config.viewer;
  if (viewer && !readOnlyNode) {
    const filled = Object.entries(n.editable).filter(([k]) => !isEmptyVal(n.props[k]));
    parts.push(h("div", { class: "card" }, h("h2", { text: t("Eigenschaften") }),
      filled.length ? h("table", { class: "props view-props" }, h("tbody", {}, ...filled.map(([k, spec]) =>
        h("tr", {}, h("th", { title: k, text: L(spec.label) || k }), h("td", {}, viewVal(n.props[k]))))))
        : h("div", { class: "muted", text: t("keine") })));
  } else if (!readOnlyNode) parts.push(form);

  // nur lesen
  const ro = n.readonly.filter((k) => !["curationRev"].includes(k));
  parts.push(h("details", { class: "card", open: readOnlyNode }, h("summary", { text: readOnlyNode ? t("Eigenschaften ({n})", { n: ro.length }) : viewer ? t("Weitere Eigenschaften ({n})", { n: ro.length }) : t("Weitere Eigenschaften (nur lesen, {n})", { n: ro.length }) }),
    h("table", { class: "props" }, h("tbody", {}, ...ro.map((k) => h("tr", {}, h("td", { text: k }), h("td", { text: fmtVal(n.props[k]) })))))));

  // Regeln: Formen (SHACL, BPMN, ODRL) und Testfälle
  if (n.labels.includes("Rule")) parts.push(readinessCard(n), ruleFormsCard(n));
  // Bounded Context: Abgleich mit Prozessen und Regeln seiner Kapitel
  if (n.labels.includes("DomainElement") && n.props.dddKind === "BoundedContext") parts.push(dddAlignmentCard(n.id.split(":")[0], n.id));
  // DMN-Entscheidung: Tabelle; BPMN-Diagramm: Prozess, Prozesselement oder Knoten mit verbundenen Prozesselementen
  if (n.labels.includes("DmnDecision") && n.props.decisionId) parts.push(dmnCard(n));
  if (!n.labels.includes("Rule") && hasDiagram(n)) parts.push(diagramCard(n));
  // Schnittstelle (WSDL/XSD): Struktur und Dokument
  if (SCHEMA_LABELS.some((l) => n.labels.includes(l))) parts.push(schemaCard(n));
  // Beziehungen und Pfade, nach Gruppen (Einstellungen: Anzeige)
  for (const card of relationCards(n)) parts.push(card);

  // Allgemeines Wort (kanonik/allgemein.py): Vorschläge über die Benennung und spezifische Datenelemente bereinigen
  if (n.allgemein && !readOnlyNode && !state.config.readonly) parts.push(generalCard(n));
  // Datenelemente, die diesem Begriff zugeordnet werden sollen: alle auf einmal, mit Kontext (v62.5)
  if (!state.config.readonly) { const ec = elementsCard(n); if (ec) parts.push(ec); }

  // Belege (mit Sprung in den Document Structure Viewer: Gliederung, Seite und Kontext des Belegs)
  const evDocs = n.evidence.some((e) => hasDocling(e.doc));
  const chapterLink = !n.evidence.length && n.chapter && hasDocling(n.doc)
    ? h("div", { class: "small" }, doclingLink({ node: n.id }, t("Kapitel {c} im Dokument zeigen", { c: n.chapter }))) : null;
  if (state.display.groups.evidence !== false) parts.push(h("details", { class: "card", open: true }, h("summary", { text: t("Quellbelege ({n})", { n: n.evidence.length }) }),
    h("div", { class: "summary-aktionen small" },          // Links und Knöpfe nicht in summary (BITV: keine Bedienelemente darin)
      n.evidence.length > 1 && evDocs ? h("span", { class: "ev-all" }, doclingLink({ node: n.id }, t("alle im Dokument zeigen"))) : null,
      n.evidence.length && !state.config.readonly ? h("span", { class: "ev-all" }, " · ", h("button", { type: "button", class: "link small danger",
        title: t("Alle Quellbelege dieses Knotens entfernen (z. B. Erwähnungen eines allgemeinen Wortes) – im Protokoll, auch nach dem nächsten Laden"),
        onclick: (ev) => { ev.preventDefault(); removeEvidence(n, n.evidence, true); } }, t("alle entfernen ({n})", { n: n.evidence.length }))) : null),
    ...n.evidence.map((e) => {
      const text = e.text || "";
      const q = e.quote || "";
      const i = q ? text.indexOf(q) : -1;
      const body = i >= 0 ? [text.slice(0, i), h("mark", { text: q }), text.slice(i + q.length)] : [text];
      return h("div", { class: "ev" },
        h("div", {}, docBadge({ doc: e.doc }), " ", h("span", { class: "cit", text: e.citation || e.element_id }), " ",
          h("span", { class: "pill type", text: e.type === "DERIVED_FROM" ? (e.verified ? t("Beleg geprüft") : t("Beleg")) : t("Erwähnung") + (e.via ? " · " + e.via : "") }),
          hasDocling(e.doc) ? h("span", { class: "ev-doc" }, " ", doclingLink({ el: e.element_id, q: q, title: ttl(n) }, t("im Dokument zeigen"))) : null,
          state.config.readonly ? null : basisButton({ art: "dokument", element: e.element_id, doc: e.doc, citation: e.citation, zitat: q || null }),
          state.config.readonly ? null : h("button", { type: "button", class: "small link danger ev-remove", title: t("Diesen Quellbeleg entfernen (passt nicht)"),
            onclick: () => removeEvidence(n, [e], false) }, t("entfernen"))),
        h("div", { class: "small" }, ...body),
        i < 0 && q ? h("div", { class: "small muted", text: t("Zitat: {q}", { q }) }) : null);
    }), n.evidence.length ? null : h("div", { class: "muted", text: t("keine") }), chapterLink));

  // Historie
  const hc = state.histCache && state.histCache.id === n.id ? state.histCache.entries : null;   // letzter Stand sofort (v63.0.3)
  parts.push(h("details", { class: "card", id: "history", open: true }, ...(hc ? histParts(hc) : [h("summary", { text: t("Änderungshistorie") }), loadingEl()])));
  root.replaceChildren(...parts);
  if (viewer) return;
  for (const k of Object.keys(n.editable)) updateField(k);
  if (!readOnlyNode) updateButtons();
}
function isEmptyVal(v) { return v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length); }
// Wert in der Lese-Oberfläche: Listen als Aufzählung, Adressen als Link
function viewVal(v) {
  const one = (x) => /^https?:\/\//.test(String(x)) ? h("a", { href: String(x), target: "_blank", rel: "noopener", text: String(x) }) : String(x);
  if (Array.isArray(v)) return v.length > 1 ? h("ul", { class: "plain" }, ...v.map((x) => h("li", {}, one(x)))) : one(v[0]);
  if (typeof v === "boolean") return v ? t("ja") : t("nein");
  return typeof v === "object" ? fmtVal(v) : one(v);
}

// ------------------------------------------------------------------ Quellbelege entfernen (Protokoll kind „evidence“)
async function removeEvidence(n, evs, all) {
  const user = $("user").value.trim();
  if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); $("user").focus(); return; }
  if (all && !window.confirm(t("{n} Quellbelege von „{t}“ entfernen? Sie bleiben auch nach dem nächsten Laden entfernt (Protokoll); die Begründung aus „Grundlage“ wird mitgeschrieben.", { n: evs.length, t: ttl(n) }))) return;
  let res;
  try {
    res = await api("/api/evidence/action", { method: "POST", body: JSON.stringify({ id: n.id, view_label: n.type ? null : n.label, user, action: "remove",
      items: evs.map((e) => ({ type: e.type, element: e.element_id })), comment: ($("comment") || {}).value || null }) });
  } catch (e) { toast(e.message, true); return; }
  toast(t("{d} Quellbelege entfernt", { d: res.done }));
  if (res.node && state.node && state.node.id === n.id) { state.node.evidence = res.node.evidence; renderDetail(); loadHistory(n.id); }
}

// ------------------------------------------------------------------ Datenelemente zuordnen (v62.5)
// Offene Vorschläge Datenelement -> Begriff (bedeutet, im Kontext von, enthält im Namen) als Liste mit Kontext:
// in welchen Nachrichten, unter welchem Pfad bzw. in welcher Gruppe das Element vorkommt; auswählen, dann alle auf
// einmal bestätigen oder ablehnen (Sammelaktion, Grundlage aus der Ablage).
const ELEMENT_LABELS = ["DataElement", "Codelist", "Code", "Message", "Service"];
function elementsCard(n) {
  const rels = (n.relations || []).filter((r) => r.curate && !r.outgoing && ELEMENT_LABELS.includes(r.other.label)
    && ["candidate", "auto", undefined, null].includes((r.props || {}).status));
  const done = (n.relations || []).filter((r) => r.curate && !r.outgoing && ELEMENT_LABELS.includes(r.other.label)
    && ["confirmed", "rejected"].includes((r.props || {}).status));
  if (!rels.length && !done.length) return null;
  const key = (r) => `${r.curate.start}|${r.curate.type}`;
  const sel = new Map(rels.map((r) => [key(r), true]));
  const ctx = {};
  const q = h("input", { type: "search", placeholder: t("Filter: Name, Nachricht, Pfad …"), class: "el-filter" });
  const tbody = h("tbody", {});
  const count = h("span", { class: "muted small" });
  const btnOk = h("button", { type: "button", class: "small primary" }), btnNo = h("button", { type: "button", class: "small danger" });
  const shown = () => { const f = q.value.trim().toLowerCase(); return rels.filter((r) => !f || elemText(r, ctx[r.other.id]).includes(f)); };
  const chosen = () => shown().filter((r) => sel.get(key(r)) && !(openForm && groupOf(r) === openForm));
  const footHint = h("span", { class: "muted small" });
  const upd = () => {
    const c = chosen().length;
    footHint.textContent = t("ordnet die ausgewählten Elemente „{b}“ zu bzw. lehnt die Zuordnung ab – legt keinen Begriff an", { b: ttl(n) })
      + (openForm ? " · " + t("Feldgruppe „{g}“ zählt hier nicht mit (eigener Begriff in Arbeit)", { g: openForm }) : "");
    btnOk.textContent = t("Ausgewählte bestätigen ({n})", { n: c }); btnNo.textContent = t("Ausgewählte ablehnen ({n})", { n: c });
    btnOk.disabled = btnNo.disabled = !c;
    count.textContent = t("{s} von {n} angezeigt, {c} ausgewählt", { s: shown().length, n: rels.length, c });
  };
  const row = (r, S = sel, after = upd) => {
    const cb = h("input", { type: "checkbox", checked: S.get(key(r)), "aria-label": ttl(r.other) });
    cb.addEventListener("change", () => { S.set(key(r), cb.checked); after(); });
    const st = (r.props || {}).status;
    const c = ctx[r.other.id];
    const occ = c ? c.vorkommen.map((o) => h("li", { title: o.path || "" }, h("span", { class: "mono small", text: o.message || "?" }), " ",
      h("span", { text: o.name || "" }), o.path ? h("span", { class: "muted small", text: ` ${shortPath(o.path)}` }) : null,
      o.feldNr ? h("span", { class: "muted small", text: ` · Feld ${o.feldNr}` }) : null)) : [];
    return h("tr", {}, h("td", {}, cb),
      h("td", {}, nodeLink(r.other), r.other.titleEn && r.other.titleEn !== r.other.title ? h("div", { class: "muted small", lang: "en", text: r.other.titleEn }) : null,
        h("div", { class: "small" }, h("span", { class: "pill type", text: relTitle(r.type) }), " ",
          st === "confirmed" || st === "rejected" ? [h("span", { class: `pill rel-${st}`, text: REL_STATUS_DE[st] || st }), " "] : null,
          (r.props || {}).method ? h("span", { class: "muted", title: methodInfo(r.props.method).hint || "", text: methodInfo(r.props.method).title }) : null,
          (r.props || {}).score !== undefined && (r.props || {}).score !== null ? h("span", { class: "muted", text: ` · ${Number(r.props.score).toFixed(2)}` }) : null)),
      h("td", { class: "el-ctx" }, c === undefined ? h("span", { class: "muted small", text: t("lädt …") })
        : !c ? h("span", { class: "muted small", text: t("kein Vorkommen in Nachrichten") })
        : [h("ul", { class: "plain small" }, ...occ),
          c.anzahl > c.vorkommen.length ? h("div", { class: "muted small", text: t("… {n} Vorkommen in {m} Nachrichten", { n: c.anzahl, m: c.nachrichten.length }) }) : null]));
  };
  // v62.6: nach Feldgruppe gruppieren (Kontext: „Code“ in Kontrollergebnis, Zusätzliche Information …); je Gruppe
  // „Eigenen Begriff anlegen“ – z. B. „Code (Kontrollergebnis)“ unter „Code“, die Datenelemente wandern mit
  const NO_GROUP = "\u0000", MANY = "\u0001";
  const groupOf = (r) => { const c = ctx[r.other.id]; if (!c || !(c.gruppen || []).length) return NO_GROUP;
    return c.gruppen.length === 1 ? c.gruppen[0].de : MANY; };
  const groupEn = (g) => { for (const r of rels) { const c = ctx[r.other.id]; const x = c && (c.gruppen || []).find((y) => y.de === g); if (x && x.en) return x.en; } return ""; };
  let openForm = null, fsel = new Map();
  const groupHead = (g, rs) => {
    const name = g === NO_GROUP ? t("ohne Feldgruppe") : g === MANY ? t("in mehreren Feldgruppen") : g;
    const real = g !== NO_GROUP && g !== MANY && n.label === "Concept";
    const inForm = openForm === g;
    // Kopfzeile = Überschrift der Gruppe, kein Eintrag: Auswahl der Elemente über „alle/keine“, eigener Begriff als
    // eigener Arbeitsschritt rechts (öffnet einen Bereich mit eigener Auswahl, getrennt von „Ausgewählte bestätigen“)
    return h("tr", { class: `el-group${inForm ? " el-group-form" : ""}` }, h("td", {}),
      h("td", { colspan: 2 }, h("span", { class: "el-gname" }, h("span", { class: "muted small", text: t("Feldgruppe") + " " }), h("strong", { text: name }),
        h("span", { class: "muted small", text: ` · ${(rs.length === 1 ? t("1 Element") : t("{n} Elemente", { n: rs.length }))}` })),
        inForm ? null : h("span", { class: "el-gsel small" }, h("button", { type: "button", class: "link small", title: t("alle Elemente dieser Gruppe auswählen"),
          onclick: () => { for (const r of rs) sel.set(key(r), true); render(); } }, t("alle")),
          h("button", { type: "button", class: "link small", onclick: () => { for (const r of rs) sel.set(key(r), false); render(); } }, t("keine"))),
        real && !inForm ? h("button", { type: "button", class: "small el-new", title: t("Für diese Feldgruppe einen eigenen Begriff anlegen, z. B. „{b} ({g})“ – mit eigener Auswahl der Elemente", { b: n.props.prefLabel || ttl(n), g }),
          onclick: () => { openForm = g; fsel = new Map(rs.map((r) => [key(r), true])); render(); } }, "＋ ", t("Eigenen Begriff anlegen …")) : null));
  };
  const newForm = (g, rs) => {
    const base = n.props.prefLabel || ttl(n);
    const de = h("input", { type: "text", value: `${base} (${g})`, "aria-label": t("Benennung") });
    const ge = groupEn(g);
    const en = h("input", { type: "text", value: ge ? `${ge} ${String(n.props.prefLabelEn || base).toLowerCase()}` : "", "aria-label": t("Benennung englisch"), lang: "en" });
    const bro = h("input", { type: "checkbox", checked: true });
    const rel = h("input", { type: "checkbox", checked: true });
    const relBox = h("label", { class: "small", hidden: true }, rel, " ", h("span", {}));
    let relId = null;
    api(`/api/search?${new URLSearchParams({ q: g, label: "Concept", limit: "20" })}`).then((hits) => {
      const x = (hits || []).find((y) => y.id !== n.id && String(y.title || "").toLowerCase() === g.toLowerCase());
      if (x) { relId = x.id; relBox.hidden = false; relBox.lastChild.textContent = t("verwandt mit „{b}“ (Feldgruppe)", { b: x.title }); }
    }).catch(() => {});
    const go = async () => {
      const user = $("user").value.trim();
      if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); $("user").focus(); return; }
      const items = rs.filter((r) => fsel.get(key(r)));
      let res;
      try { res = await api("/api/concept/create", { method: "POST", body: JSON.stringify({ label: de.value.trim(), label_en: en.value.trim() || null,
        broader: bro.checked ? n.id : null, related: rel.checked && relId ? relId : null, user,
        items: items.map((r) => ({ start: r.curate.start, type: r.curate.type, end: r.curate.end, start_label: r.curate.start_label || null })),
        comment: ($("comment") || {}).value || t("eigener Begriff für Feldgruppe {g}", { g }) }) }); }
      catch (e) { toast(e.message, true); return; }
      toast((res.created ? t("Begriff „{b}“ angelegt", { b: de.value.trim() }) : t("Begriff „{b}“ gab es schon", { b: de.value.trim() }))
        + " · " + t("{d} Datenelemente umgehängt", { d: res.moved })
        + (res.failed.length ? t(", {f} nicht möglich (inzwischen geändert?)", { f: res.failed.length }) : ""), res.failed.length > 0);
      openNode(res.id, { force: true });
    };
    const btnGo = h("button", { type: "button", class: "small primary", onclick: go });
    const updForm = () => { const c = rs.filter((r) => fsel.get(key(r))).length; btnGo.textContent = t("Begriff anlegen und {n} Elemente zuordnen", { n: c }); btnGo.disabled = !c; };
    updForm();
    return [h("tr", { class: "el-form" }, h("td", {}), h("td", { colspan: 2 },
      h("div", { class: "el-form-title", text: t("Eigener Begriff für die Feldgruppe „{g}“", { g }) }),
      h("div", { class: "small muted", text: t("Die unten angehakten Elemente dieser Gruppe werden dem neuen Begriff zugeordnet, ihre Zuordnung zu „{b}“ abgelehnt. Bleibt nach jedem Laden erhalten (Kurationsprotokoll); rückgängig im Reiter Entscheidungen.", { b: ttl(n) }) }),
      h("div", { class: "el-form-grid" }, h("label", { class: "small", text: t("Benennung") }), de,
        h("label", { class: "small", text: t("Benennung englisch") }), en),
      h("div", {}, h("label", { class: "small" }, bro, " ", t("Oberbegriff „{b}“", { b: ttl(n) }))), h("div", {}, relBox))),
      ...rs.map((r) => { const tr = row(r, fsel, updForm); tr.classList.add("el-in-form"); return tr; }),
      h("tr", { class: "el-form el-form-foot" }, h("td", {}), h("td", { colspan: 2 }, h("div", { class: "el-bar" }, btnGo,
        h("button", { type: "button", class: "link small", onclick: () => { openForm = null; render(); } }, t("Abbrechen")))))];
  };
  const render = () => {
    const groups = new Map();
    for (const r of shown()) { const g = groupOf(r); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); }
    const order = [...groups.keys()].sort((a, b) => (a < "\u0002") - (b < "\u0002") || a.localeCompare(b, "de"));
    const single = order.length === 1 && order[0] === NO_GROUP;
    tbody.replaceChildren(...order.flatMap((g) => [single ? null : groupHead(g, groups.get(g)),
      ...(openForm === g ? newForm(g, groups.get(g)) : groups.get(g).map((r) => row(r)))]).filter(Boolean));
    upd();
  };
  const bulk = async (action) => {
    const user = $("user").value.trim();
    if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); $("user").focus(); return; }
    const rs = chosen();
    if (action === "reject" && !window.confirm(t("{n} Zuordnungen ablehnen?", { n: rs.length }))) return;
    let res;
    try { res = await api("/api/relation/bulk", { method: "POST", body: JSON.stringify({ action, user,
      items: rs.map((r) => ({ start: r.curate.start, type: r.curate.type, end: r.curate.end, start_label: r.curate.start_label || null, expected_status: (r.props || {}).status ?? null })),
      comment: ($("comment") || {}).value || t("Sammelentscheidung Datenelemente → {b}", { b: ttl(n) }) }) }); }
    catch (e) { toast(e.message, true); return; }
    toast((action === "confirm" ? t("{d} bestätigt", { d: res.done }) : t("{d} abgelehnt", { d: res.done }))
      + (res.failed.length ? t(", {f} nicht möglich (inzwischen geändert?)", { f: res.failed.length }) : ""), res.failed.length > 0);
    openNode(n.id, { force: true, label: n.type ? null : n.label });
  };
  btnOk.addEventListener("click", () => bulk("confirm")); btnNo.addEventListener("click", () => bulk("reject"));
  // v62.7: schon entschiedene Zuordnungen gesammelt zurücksetzen (zurück auf „Vorschlag“)
  const dsel = new Map(done.map((r) => [key(r), false]));
  const dbody = h("tbody", {});
  const btnReset = h("button", { type: "button", class: "small" });
  const dchosen = () => done.filter((r) => dsel.get(key(r)));
  const dupd = () => { const c = dchosen().length; btnReset.textContent = t("Ausgewählte zurücksetzen ({n})", { n: c }); btnReset.disabled = !c; };
  const drender = () => {
    const groups = new Map();
    for (const r of done) { const g = groupOf(r); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); }
    const order = [...groups.keys()].sort((a, b) => (a < "\u0002") - (b < "\u0002") || a.localeCompare(b, "de"));
    const single = order.length === 1 && order[0] === NO_GROUP;
    dbody.replaceChildren(...order.flatMap((g) => {
      const rs = groups.get(g);
      const cbAll = h("input", { type: "checkbox", checked: rs.every((r) => dsel.get(key(r))), "aria-label": t("Gruppe auswählen") });
      cbAll.addEventListener("change", () => { for (const r of rs) dsel.set(key(r), cbAll.checked); drender(); });
      return [single ? null : h("tr", { class: "el-group" }, h("td", {}, cbAll), h("td", { colspan: 2 },
        h("strong", { text: g === NO_GROUP ? t("ohne Feldgruppe") : g === MANY ? t("in mehreren Feldgruppen") : g }),
        h("span", { class: "muted small", text: ` · ${(rs.length === 1 ? t("1 Element") : t("{n} Elemente", { n: rs.length }))}` }))), ...rs.map((r) => row(r, dsel, dupd))];
    }).filter(Boolean));
    dupd();
  };
  btnReset.addEventListener("click", async () => {
    const user = $("user").value.trim();
    if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); $("user").focus(); return; }
    const rs = dchosen();
    if (!window.confirm(t("{n} Entscheidungen zurücksetzen? Die Zuordnungen werden wieder Vorschläge.", { n: rs.length }))) return;
    let res;
    try { res = await api("/api/relation/bulk", { method: "POST", body: JSON.stringify({ action: "reset", user,
      items: rs.map((r) => ({ start: r.curate.start, type: r.curate.type, end: r.curate.end, start_label: r.curate.start_label || null, expected_status: r.props.status })),
      comment: ($("comment") || {}).value || t("Sammelentscheidung Datenelemente → {b} zurückgesetzt", { b: ttl(n) }) }) }); }
    catch (e) { toast(e.message, true); return; }
    toast(t("{d} zurückgesetzt", { d: res.done }) + (res.failed.length ? t(", {f} nicht möglich (inzwischen geändert?)", { f: res.failed.length }) : ""), res.failed.length > 0);
    openNode(n.id, { force: true, label: n.type ? null : n.label });
  });
  const doneBox = done.length ? h("details", { class: "el-done" },
    h("summary", { text: t("Schon entschieden ({n})", { n: done.length }) }),
    h("div", { class: "small muted", text: t("Bestätigte und abgelehnte Zuordnungen. Ausgewählte zurücksetzen macht sie wieder zu Vorschlägen (im Protokoll). Eine ganze Sammelentscheidung nehmen Sie im Reiter Entscheidungen unter „Sammelentscheidungen“ zurück.") }),
    h("div", { class: "el-bar" }, h("button", { type: "button", class: "link small", onclick: () => { for (const r of done) dsel.set(key(r), true); drender(); } }, t("alle")),
      h("button", { type: "button", class: "link small", onclick: () => { for (const r of done) dsel.set(key(r), false); drender(); } }, t("keine"))),
    h("div", { class: "table-wrap" }, h("table", { class: "el-tbl" },
      h("thead", {}, h("tr", {}, h("th", {}), h("th", { text: t("Element") }), h("th", { text: t("Kontext (Nachricht, Feld, Pfad)") }))), dbody)),
    h("div", { class: "el-bar" }, btnReset)) : null;
  q.addEventListener("input", render);
  const all = (v) => { for (const r of shown()) sel.set(key(r), v); render(); };
  const card = h("details", { class: "card el-card", open: true, "data-maske": "datenelemente" },
    h("summary", { text: t("Datenelemente zuordnen ({n} offen)", { n: rels.length }) }),
    !rels.length ? h("div", { class: "muted", text: t("keine offenen Vorschläge") }) : null,
    h("div", { class: "small muted", text: t("Vorschläge aus der Schnittstelle für „{b}“ – mit Kontext: in welcher Nachricht, unter welchem Pfad bzw. in welcher Gruppe das Element vorkommt. Auswählen, dann alle auf einmal entscheiden; die Grundlage aus der Ablage geht mit.", { b: ttl(n) })
      + (done.length ? " " + t("Schon entschieden: {n}.", { n: done.length }) : "") }),
    rels.length ? [h("div", { class: "el-bar" }, q, h("button", { type: "button", class: "link small", onclick: () => all(true) }, t("alle")),
      h("button", { type: "button", class: "link small", onclick: () => all(false) }, t("keine")), count),
    h("div", { class: "table-wrap" }, h("table", { class: "el-tbl" },
      h("thead", {}, h("tr", {}, h("th", {}), h("th", { text: t("Element") }), h("th", { text: t("Kontext (Nachricht, Feld, Pfad)") }))), tbody))] : null,
    doneBox,
    rels.length ? h("div", { class: "actions" }, btnOk, btnNo, footHint) : null);
  render(); drender();
  const ids = [...new Set([...rels, ...done].map((r) => r.other.id))];
  api(`/api/elements/context?${new URLSearchParams(ids.map((x) => ["ids", x]))}`).then((d) => {
    for (const id of ids) ctx[id] = d[id] || null;
    render(); drender();
  }).catch(() => { for (const id of ids) ctx[id] = null; render(); drender(); });
  return card;
}
function shortPath(p) { const xs = String(p || "").split("/").filter(Boolean); return xs.length > 4 ? `…/${xs.slice(-4).join("/")}` : xs.join("/"); }
function elemText(r, c) {
  return [ttl(r.other), r.other.titleEn || "", r.other.id, ...(c ? c.vorkommen.flatMap((o) => [o.message, o.name, o.path]) : [])].join(" ").toLowerCase();
}

// ------------------------------------------------------------------ Allgemeines Wort („Code“)
const NAME_METHODS = ["label_en", "data_element_en", "same_label", "same_abbreviation", "abbreviation", "embedding", "fuzzy",
  "exact", "compound_head", "contains_concept", "text_statement", "rule_anchor_concept", "rule_anchor_reference"];
function generalCard(n) {
  const gen = new Set([...(state.config.allgemein_en || []), (n.props.prefLabel || "").toLowerCase(), (n.props.prefLabelEn || "").toLowerCase()].filter(Boolean));
  const rels = n.relations.filter((r) => r.curate);
  const enName = (o) => String(o.titleEn || "").replace(` ${o.id}`, "").trim();          // „CONTROL RESULT CODE 50758“ -> Name
  const props = rels.filter((r) => r.type !== "MEANS" && (r.props || {}).status === "candidate" && NAME_METHODS.includes((r.props || {}).method));
  const elems = rels.filter((r) => r.type === "MEANS" && !r.outgoing && r.other.label === "DataElement"
    && ["auto", "candidate", undefined, null].includes((r.props || {}).status)
    && enName(r.other) && !gen.has(enName(r.other).toLowerCase()));
  const item = (r) => ({ start: r.curate.start, type: r.curate.type, end: r.curate.end, start_label: r.curate.start_label || null,
    expected_status: (r.props || {}).status ?? null });
  const bulk = async (rs, what) => {
    const user = $("user").value.trim();
    if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); $("user").focus(); return; }
    let res;
    try { res = await api("/api/relation/bulk", { method: "POST", body: JSON.stringify({ items: rs.map(item), action: "reject", user,
      comment: t("allgemeines Wort: {w}", { w: what }) }) }); }
    catch (e) { toast(e.message, true); return; }
    toast(t("{d} abgelehnt", { d: res.done }) + (res.failed.length ? t(", {f} nicht möglich (inzwischen geändert?)", { f: res.failed.length }) : ""), res.failed.length > 0);
    openNode(n.id, { force: true, label: n.type ? null : n.label });
  };
  return h("div", { class: "card general-card" }, h("h2", { text: t("Allgemeines Wort") }),
    h("div", { class: "small", text: t("Die Benennung wird im Dokument allgemein gebraucht. Beim nächsten Lauf entstehen keine Vorschläge mehr über die Benennung (Sprach- und Begriffsabgleich, Regelanker); Datenelemente in genau einer Feldgruppe oder mit eigenem englischen Namen bekommen einen eigenen Begriff („{w} (Feldgruppe)“), die übrigen Zuordnungen werden Vorschläge. Eigene Begriffe je Feldgruppe auch unten unter „Datenelemente zuordnen“. Bis dahin hier aufräumen:", { w: n.props.prefLabel || n.title }) }),
    h("div", { class: "actions" },
      h("button", { type: "button", disabled: !props.length, title: props.map((r) => `${relTitle(r.type)}: ${ttl(r.other)} (${methodInfo(r.props.method).title})`).join("\n") || null,
        onclick: () => bulk(props, t("Vorschläge über die Benennung")) }, t("Vorschläge über die Benennung ablehnen ({n})", { n: props.length })),
      h("button", { type: "button", disabled: !elems.length, title: elems.map((r) => `${r.other.id}: ${enName(r.other)}`).join("\n") || null,
        onclick: () => bulk(elems, t("Datenelemente mit eigenem englischen Namen")) }, t("Zuordnungen spezifischer Datenelemente ablehnen ({n})", { n: elems.length })),
      h("button", { type: "button", disabled: !n.evidence.length, onclick: () => removeEvidence(n, n.evidence, true) },
        t("Quellbelege (Erwähnungen) entfernen ({n})", { n: n.evidence.length }))),
    elems.length ? h("div", { class: "small muted", text: t("Spezifisch: {l}", { l: [...new Set(elems.map((r) => enName(r.other)))].slice(0, 8).join(", ") }) }) : null);
}

// ------------------------------------------------------------------ Document Structure Viewer (Quellbelege im Dokument)
// /docling/view des Servers (kanonik.docling_view); nur Dokumente mit Docling-JSON, nicht in der Nur-Lesen-Demo
function hasDocling(doc) { return !!(doc && state.docling && state.docling[doc] && state.docling[doc].docling); }
function doclingUrl(params) {
  if (window.KANONIK_STATIC && window.KANONIK_STATIC.doclingUrl) return window.KANONIK_STATIC.doclingUrl(params);   // öffentliche Demo
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  return `/docling/view?${p}`;
}
// Kopfleiste „Quellen ▾“: jedes Dokument der Domäne im Document Structure Viewer (am Anfang oder an einem Kapitel)
// und Code und Schnittstellen in der Quelltext-Ansicht – ohne Umweg über einen Beleg
function renderQuellenMenu() {
  const ds = Object.values(state.docling || {}).filter((d) => d.docling);
  const code = !STATIC && (!state.config.readonly || state.config.viewer);
  $("quellen-menu").hidden = !ds.length && !code;
  $("quellen-body").replaceChildren(...[
    h("div", { class: "small muted", text: t("Dokumente im Document Structure Viewer (eigenes Fenster)") }),
    ...ds.map((d) => h("div", { class: "quellen-dok" },
      h("a", { class: "link", href: doclingUrl({ doc: d.id }), target: "docling", rel: "noopener", title: d.long || d.title, text: `📄 ${d.title}` }),
      (d.kapitel || []).length ? h("details", { class: "small" }, h("summary", { text: tp(d.kapitel.length, "1 Kapitel", "{n} Kapitel") }),
        h("ul", { class: "quellen-kap" }, ...d.kapitel.map((k) => h("li", {}, h("a", { class: "link", href: doclingUrl({ doc: d.id, section: k.number }),
          target: "docling", rel: "noopener", text: `${k.number} ${k.title}` }))))) : null)),
    ds.length ? null : h("div", { class: "small muted", text: t("keine Dokumente mit Docling-JSON") }),
    code ? h("div", { class: "quellen-dok" }, h("a", { class: "link", href: "/quelltext", target: "_blank", rel: "noopener",
      text: "⌨ " + t("Code und Schnittstellen vollständig ↗") })) : null].filter(Boolean));
}
function doclingLink(params, text) {
  return h("a", { class: "link docling-link", href: doclingUrl(params), target: "docling", rel: "noopener",
    title: t("Document Structure Viewer: Gliederung, Seite und Kontext des Belegs (eigenes Fenster)"), text: "📄 " + text });
}
async function loadDocling() {
  try { const r = await fetch("/api/docling/docs"); state.docling = r.ok ? await r.json() : {}; } catch { state.docling = {}; }
}

// ------------------------------------------------------------------ Beziehungen
const RULE_LINK_TYPES = ["FORMALIZED_AS", "TESTED_BY"];        // eigene Karte „Formen und Testfälle“
function relCfg() { return (state.config && state.config.relations) || { groups: [], paths: [], editable: {}, display_defaults: {} }; }
// ------------------------------------------------------------------ Dokumente (input/inputs.json documents)
function docs() { return (state.config && state.config.documents) || []; }
function docInfo(id) { return docs().find((d) => d.id === id) || null; }
// Kennzeichen Dokument + Sprache, sobald mehr als ein Dokument geladen ist (z. B. „EN · Leitfaden 1.0“)
function docBadge(x, mini = true) {
  if (!x || docs().length < 2) return null;
  const d = docInfo(x.doc);
  if (!d && !x.lang) return null;
  const lang = (x.lang || (d && d.lang) || "").toUpperCase();
  return h("span", { class: `pill doc${mini ? " mini" : ""} doc-${(x.lang || (d && d.lang) || "x")}`,
    title: d ? `${d.title} (${d.id})` : null, text: [lang, d ? d.short : null].filter(Boolean).join(" · ") });
}
// Fenster zum Vergleichen: ein benanntes Fenster, das bei jedem „↗“ wiederverwendet wird (rechte Bildschirmhälfte)
const COMPARE_WIN = "kanonik-curator-vergleich";
function refHash(ref) { return nodeHash(ref.id, ref.editable ? null : ref.label); }
// Rolle des Fensters steckt im Fensternamen: „kanonik-curator-vergleich“ (Vergleichsfenster) bzw. „…-2“ (Vergleichsfenster
// des Vergleichsfensters); Zusatz „~fest~…“ = festgehalten, „~busy~…“ = zeigt gerade Prüfstand/Metamodell. Nur unter dem
// reinen Namen erreicht ein „↗“ bzw. „Nebeneinander“ aus einem anderen Fenster dieses Fenster.
function winRole() { const r = window.name.split("~")[0]; return r.startsWith(COMPARE_WIN) ? r : null; }
function isCompareWin() { return !!winRole(); }
function isPinned() { return window.name.includes("~fest~"); }
function applyWinName() {
  const role = winRole();
  if (!role) return;
  state.winId = state.winId || Date.now().toString(36);
  const busy = state.tab === "review" || state.tab === "meta" || state.tab === "onto";
  window.name = isPinned() ? window.name : busy ? `${role}~busy~${state.winId}` : role;
  windowTitle();
}
function openWindow(ref, name = null) {
  // Vorgabe: ein Vergleichsfenster, das wiederverwendet wird – aus dem Vergleichsfenster selbst ein zweites (nie sich
  // selbst, sonst ginge bei „Nebeneinander“ das Ende verloren). „Festhalten“ bzw. Anzeige-Einstellung „jedes Mal neues
  // Fenster“ -> das nächste „↗“ öffnet ein weiteres Fenster; ein Fenster im Prüfstand/Metamodell wird nicht verwendet.
  const each = state.display && state.display.newWindowEach;
  const target = winRole() === COMPARE_WIN ? `${COMPARE_WIN}-2` : COMPARE_WIN;
  name = name || (each ? `${COMPARE_WIN}-${Date.now().toString(36)}` : target);
  const n = each ? (state.winCount = (state.winCount || 0) + 1) : (name === COMPARE_WIN ? 0 : 1);
  const sw = screen.availWidth || 1600, sh = screen.availHeight || 900;
  const w = Math.max(640, Math.round(sw / 2));
  const left = (screen.availLeft || 0) + sw - w - (n % 5) * 30, top = (screen.availTop || 0) + (n % 5) * 30;
  const win = window.open(`${location.pathname}${location.search}${refHash(ref)}`, name,
    `popup,width=${w},height=${sh},left=${left},top=${top}`);
  if (!win) { toast(t("Das neue Fenster wurde vom Browser blockiert (Pop-ups für den Curator erlauben)."), true); return null; }
  win.focus();
  return win;
}
// Fenstertitel mit Knoten (Taskleiste, Fensterwechsel): welches Fenster zeigt was?
function windowTitle() {
  state.baseTitle = state.baseTitle || document.title;
  const role = isCompareWin() ? (isPinned() ? t("Festgehalten") : t("Vergleich")) : null;
  document.title = [role, state.node ? ttl(state.node) : null, state.baseTitle].filter(Boolean).join(" – ");
  const b = $("win-pin");
  if (b) {
    b.hidden = !isCompareWin();
    b.textContent = isPinned() ? t("Festgehalten") : t("Festhalten");
    b.classList.toggle("primary", isPinned());
    b.title = isPinned()
      ? t("Festgehalten: „↗“ aus anderen Fenstern ändert dieses Fenster nicht. Klick: wieder als Vergleichsfenster verwenden.")
      : t("Dieses Vergleichsfenster behält seinen Knoten; das nächste „↗“ öffnet ein neues Fenster.");
  }
}
function togglePin() {
  const role = winRole();
  if (!role) return;
  state.winId = state.winId || Date.now().toString(36);
  window.name = isPinned() ? role : `${role}~fest~${state.winId}`;
  applyWinName();
}
// Link auf einen Knoten: Klick öffnet hier; Strg/⌘-Klick bzw. mittlere Taste neuer Tab, Umschalt-Klick neues Fenster
// (Browser); „↗“ öffnet im Vergleichsfenster
function nodeLink(ref) {
  if (!ref) return h("span", { class: "muted", text: "–" });
  const txt = ttl(ref);
  const here = (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;      // Browser: neuer Tab/neues Fenster
    e.preventDefault();
    openNode(ref.id, { label: ref.editable ? null : ref.label });
  };
  return h("span", { class: "node-link" },
    h("a", { class: "link", href: refHash(ref), title: [ttlHint(ref), ref.label, ref.id].filter(Boolean).join(" · "), onclick: here },
      ref.editable ? null : h("span", { class: "pill type mini", text: ref.label || "" }), abbrify(txt), docBadge(ref)),
    h("a", { class: "new-win", href: refHash(ref), target: COMPARE_WIN, title: t("In eigenem Fenster öffnen (zum Vergleichen)"),
      "aria-label": t("In eigenem Fenster öffnen (zum Vergleichen)"),
      onclick: (e) => { e.preventDefault(); openWindow(ref); } }, "↗"));
}
function linkTypes() { return (relCfg().links || {}).types || {}; }
// Verknüpfungsart für diesen Knoten? Typen mit eigenem from (REFERS_TO: nur Erwähnungen), sonst die allgemeinen
function linkAllowedFor(n, type) {
  const lt = linkTypes()[type];
  if (!lt) return false;
  if (lt.from) return n.labels.some((l) => lt.from.includes(l));
  const typed = new Set(Object.values(linkTypes()).flatMap((x) => x.from || []));
  return !n.labels.some((l) => typed.has(l) && !((relCfg().links || {}).from || []).includes(l));
}
function edgeInfo(curate, props) {
  if (!curate) return {};
  const spec = relCfg().editable[curate.type] || {};
  let status = props[spec.status_prop || "status"] || null;
  // Verknüpfung ohne Status (z. B. Oberbegriff aus Glossar oder Kapitelextraktion): gilt, "aus Quelle"
  if (!status && (linkTypes()[curate.type] || spec.default_status)) status = spec.default_status || "source";
  // Vorschlag zwischen gleichbedeutenden Knoten (über bestätigte Kanten): Anzeige „transitiv bestätigt“, gespeichert candidate
  const shown = props.implied && status === "candidate" ? "implied" : (status || "candidate");
  return { status, score: props[spec.score_prop || "score"], shown };
}
// „über A, B“: Weg der bestätigten Gleichbedeutung
function impliedHint(via) {
  return via && via.length ? t("ergibt sich über {via}", { via: via.map((x) => ttl(x)).join(" → ") }) : t("gleichbedeutend (bestätigt)");
}
const CONFLICT_HINT = () => t("Widerspruch: beide Knoten sind gleichbedeutend (bestätigt) – Ober-/Unterbegriff passt nicht");
function passesFilter(curate, props) {
  if (!curate) return true;
  const d = state.display;
  const { status, score, shown } = edgeInfo(curate, props);
  if (d.candidates === "confirmed") return status === "confirmed" || shown === "implied";
  if (d.candidates === "no_rejected") return status !== "rejected";
  if (d.candidates === "min_score") return status === "confirmed" || (status !== "rejected" && Number(score || 0) >= Number(d.min_score || 0));
  return true;
}
// Urteil der Fachontologie zu einer Beziehung (Klassen der Endknoten; v56.4)
// ------------------------------------------------------------------ Grundlage der Entscheidungen (kanonik/grundlage.py)
// Ablage „Grundlage“: Dokumentstellen (Quellbelege, Document Structure Viewer), Knoten, Webseiten/Chat, freier Text und eine
// Begründung. Jede Entscheidung (speichern, verifizieren, bestätigen, ablehnen, verknüpfen, Beziehungsart ändern)
// nimmt sie mit ins Protokoll; danach ist die Ablage leer (außer „behalten“).
const DECISION_PATHS = ["/api/node/action", "/api/relation/action", "/api/relation/bulk", "/api/relation/retype", "/api/link/action", "/api/evidence/action"];
const BASIS_ART = () => ({ dokument: t("Dokument"), knoten: t("Knoten"), regel: t("Regel"), llm: t("Sprachmodell"), ontologie: t("Ontologie"),
  chat: t("Chat"), extern: t("Quelle"), text: t("Text") });
function basisLabel(g) {
  if (g.art === "dokument") return `${g.citation || (g.text ? g.text.slice(0, 60) : "") || g.element || g.ref || ""}${g.zitat ? ` „${g.zitat.slice(0, 60)}${g.zitat.length > 60 ? "…" : ""}“` : ""}`;
  if (g.art === "knoten") return g.title || g.id;
  if (g.art === "regel") return `${g.id || ""}${g.score != null ? ` · ${Number(g.score).toFixed(2)}` : ""}`;
  if (g.art === "llm") return [g.modell, g.lauf, g.text].filter(Boolean).join(" · ");
  if (g.art === "ontologie") return g.klasse || g.text || "";
  return g.titel || g.url || g.text || "";
}
function basisHref(g) {
  if (g.art === "dokument") return g.element ? doclingUrl({ el: g.element, q: g.zitat || "" }) : (g.doc && g.ref ? doclingUrl({ doc: g.doc, ref: g.ref }) : null);
  if (g.art === "knoten") return nodeHash(g.id, null);
  return g.url || null;
}
function basisChip(g, onRemove) {
  const href = basisHref(g);
  const body = [h("span", { class: "k", text: BASIS_ART()[g.art] || g.art }), " ", basisLabel(g)];
  return h("span", { class: `bchip b-${g.art}`, title: [g.zitat, g.text, g.stand ? t("Stand {s}", { s: g.stand }) : null].filter(Boolean).join("\n") || null },
    href ? h("a", { href, target: g.art === "knoten" ? null : (g.art === "dokument" ? "docling" : "_blank"), rel: "noopener" }, ...body) : h("span", {}, ...body),
    onRemove ? h("button", { type: "button", class: "x", title: t("entfernen"), "aria-label": t("entfernen"), onclick: onRemove }, "×") : null);
}
function addBasis(g, quiet = false) {
  const key = JSON.stringify({ ...g, zitat: undefined });
  if (state.basis.some((x) => JSON.stringify({ ...x, zitat: undefined }) === key && (x.zitat || "") === (g.zitat || ""))) { if (!quiet) toast(t("schon in der Grundlage")); return; }
  state.basis.push(g);
  renderBasis();
  if (!quiet) toast(t("Grundlage: {g}", { g: basisLabel(g).slice(0, 80) }));
}
function withBasis(body) {
  if (!state.basis.length && !state.basisNote) return body;
  let b;
  try { b = JSON.parse(body); } catch { return body; }
  if (state.basis.length) b.grundlage = state.basis;
  if (state.basisNote && !b.comment) b.comment = state.basisNote;
  return JSON.stringify(b);
}
function basisUsed() {
  if (!state.basis.length && !state.basisNote) return;
  if (!state.basisKeep) { state.basis = []; state.basisNote = ""; }
  renderBasis();
}
function renderBasis() {
  const n = state.basis.length;
  $("basis-count").textContent = n ? String(n) : "";
  $("basis-btn").classList.toggle("has", n > 0 || !!state.basisNote);
  const box = $("basis");
  box.hidden = !state.basisOpen;
  $("basis-btn").setAttribute("aria-expanded", String(!!state.basisOpen));
  document.body.classList.toggle("basis-open", !box.hidden);
  if (box.hidden) return;
  const inp = h("input", { type: "text", placeholder: t("Webseite, Chat-Link oder Text …"), "aria-label": t("Quelle hinzufügen") });
  const add = () => {
    const v = inp.value.trim();
    if (!v) return;
    if (/^https?:\/\//.test(v)) addBasis({ art: /claude\.ai\/|chatgpt\.com\//.test(v) ? "chat" : "extern", url: v });
    else addBasis({ art: "text", text: v });
    inp.value = "";
  };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  const note = h("input", { type: "text", class: "note", placeholder: t("Begründung (wenn die Aktion keinen Kommentar hat)"), "aria-label": t("Begründung"), maxlength: "500" });
  note.value = state.basisNote || "";
  note.addEventListener("input", () => { state.basisNote = note.value.trim(); $("basis-btn").classList.toggle("has", state.basis.length > 0 || !!state.basisNote); });
  const keep = h("input", { type: "checkbox", id: "basis-keep" });
  keep.checked = !!state.basisKeep;
  keep.addEventListener("change", () => { state.basisKeep = keep.checked; });
  box.replaceChildren(
    h("div", { class: "bhead" }, h("strong", { text: t("Grundlage der nächsten Entscheidung") }),
      h("span", { class: "muted small", text: t("geht mit Speichern, Verifizieren, Bestätigen, Ablehnen, Verknüpfen ins Protokoll") }),
      h("button", { type: "button", class: "small link", onclick: () => { state.basisOpen = false; renderBasis(); } }, "✕")),
    h("div", { class: "bchips" }, ...(n ? state.basis.map((g, i) => basisChip(g, () => { state.basis.splice(i, 1); renderBasis(); }))
      : [h("span", { class: "muted small", text: t("leer – „+ Grundlage“ an Quellbelegen und Knoten, „als Grundlage übernehmen“ im Document Structure Viewer") })])),
    h("div", { class: "brow" }, inp, h("button", { type: "button", class: "small", onclick: add }, t("hinzufügen"))),
    h("div", { class: "brow" }, note),
    h("div", { class: "brow small" }, h("label", {}, keep, " ", t("nach der Entscheidung behalten")),
      h("button", { type: "button", class: "small", disabled: !n && !state.basisNote, onclick: () => { state.basis = []; state.basisNote = ""; renderBasis(); } }, t("leeren"))));
  // Platz unter dem Inhalt, damit die Ablage nichts dauerhaft verdeckt (v63.0.3, Befund des explorativen Tests)
  document.documentElement.style.setProperty("--basis-h", `${box.offsetHeight + 24}px`);
}
function basisButton(g, title) {
  return h("button", { type: "button", class: "small link add-basis", title: title || t("als Grundlage der nächsten Entscheidung merken"),
    onclick: () => addBasis(g) }, t("+ Grundlage"));
}
function decisionInfo(e, compact = true) {
  // letzte Entscheidung an einer Beziehung bzw. einem Knoten: Grundlage und Begründung
  if (!e || (!e.grundlage && !e.comment)) return null;
  const n = (e.grundlage || []).length;
  const title = [`${fmtTs(e.ts)} · ${e.user || ""}`, e.comment ? t("Begründung: {c}", { c: e.comment }) : null,
    ...(e.grundlage || []).map((g) => `• ${BASIS_ART()[g.art] || g.art}: ${basisLabel(g)}`)].filter(Boolean).join("\n");
  if (compact) return h("span", { class: "pill basis-pill", title, text: n ? `📎 ${n}` : "💬" });
  return h("div", { class: "decision" }, e.comment ? h("div", { class: "small", text: t("Begründung: {c}", { c: e.comment }) }) : null,
    n ? h("div", { class: "bchips" }, ...e.grundlage.map((g) => basisChip(g))) : null);
}
function listenDocling() {
  // „als Grundlage übernehmen“ im Document Structure Viewer (anderes Fenster, gleicher Server)
  try {
    const ch = new BroadcastChannel("kanonik-grundlage");
    ch.onmessage = (ev) => { const g = ev.data; if (g && g.art === "dokument") { addBasis(g); if (!state.basisOpen) { state.basisOpen = true; renderBasis(); } } };
  } catch { /* ältere Browser */ }
}

// ------------------------------------------------------------------ Herkunft (configuration/herkunft.yaml)
// wer die Aussage bzw. den Vorschlag geliefert hat; getrennt vom Status (wer ihn geprüft hat)
const HERKUNFT_PROPS = ["herkunft", "herkunftDetail"];
function herkunftTitle(k) {
  const a = (state.config.herkunft || {})[k];
  return a ? (I18N.lang === "en" && a.en ? a.en : t(a.title)) : k;
}
function herkunftPills(hk, mini = false) {
  if (!hk || !hk.arten || !hk.arten.length) return null;
  const cfg = state.config.herkunft || {};
  return h("span", { class: `herkunft${mini ? " mini" : ""}` }, ...hk.arten.map((k) => {
    const a = cfg[k] || {};
    return h("span", { class: "pill hk", style: a.color ? `--hk:${a.color}` : null,
      title: [t("Herkunft: {h}", { h: herkunftTitle(k) }), hk.detail, a.hint ? t(a.hint) : null].filter(Boolean).join("\n"),
      text: herkunftTitle(k) });
  }));
}

// Sicht der Fachontologie (v60): fachlich (rechtlich und operativ) bzw. technisch (IT)
const SICHT_TITLE = () => ({ fachlich: t("fachlich (rechtlich und operativ)"), technisch: t("technisch (IT)") });
function sichtPill(v, quelle = null, mini = false) {
  if (!v) return null;
  const why = quelle === "klasse" ? t("aus der Klasse der Fachontologie") : quelle === "knoten" ? t("aus Art und Herkunft des Knotens")
    : quelle === "geerbt" ? t("von der Oberklasse geerbt") : null;
  return h("span", { class: `pill sicht s-${v}${mini ? " mini" : ""}`, title: [t("Sicht: {s}", { s: SICHT_TITLE()[v] || v }), why].filter(Boolean).join(" – "),
    text: v === "fachlich" ? t("fachlich") : t("technisch") });
}
// Sichten beider Seiten einer Beziehung: Brücke (verschiedene Sichten) hervorgehoben
function viewsPill(o) {
  const v = o && o.views;
  if (!v || !(v[0] || v[1])) return null;
  const s = (x) => x ? (x === "fachlich" ? t("fachlich") : t("technisch")) : "?";
  return h("span", { class: `pill sicht ${o.bridge ? "s-bruecke" : `s-${v[0] || v[1]}`} mini`,
    title: o.bridge ? t("Brücke zwischen den Sichten: {a} ↔ {b} – keine Gleichsetzung, sondern z. B. „bedeutet“, „wird übermittelt als“", { a: s(v[0]), b: s(v[1]) })
      : t("Sicht: {a} ↔ {b}", { a: s(v[0]), b: s(v[1]) }),
    text: o.bridge ? t("Brücke {a} ↔ {b}", { a: s(v[0]), b: s(v[1]) }) : (v[0] === v[1] ? s(v[0]) : `${s(v[0])} ↔ ${s(v[1])}`) });
}
function ontoPill(o) {
  if (!o || o.ok === null || o.ok === undefined) return viewsPill(o);
  const vt = (x) => (x ? (x === "fachlich" ? t("fachlich") : t("technisch")) : "?");   // ohne Klasse: Sicht des Knotens
  const cls = `${o.a_title || vt((o.views || [])[0])} ↔ ${o.b_title || vt((o.views || [])[1])}`;
  return [viewsPill(o), o.ok ? h("span", { class: "pill onto-ok", title: t("Fachontologie: {c} – {n}", { c: cls, n: o.note }), text: o.a === o.b ? o.a_title : cls })
    : h("span", { class: `pill ${o.sure ? "onto-bad" : "onto-maybe"}`, title: t("Fachontologie: {c} – {n}", { c: cls, n: o.note }) + (o.sure ? "" : t(" (Klasse über Oberbegriffe abgeleitet)")),
      text: (o.sure ? t("gegen Ontologie: {c}", { c: cls }) : t("fraglich nach Ontologie: {c}", { c: cls })) })];
}
// Kontext für das Umtypisieren in eine Brücke: Labels von Start und Ende, verschiedene Sichten (Ontologie bzw. Labels)
function relCtx(n, r) {
  const a = r.outgoing ? n.labels : (r.other.labels || []), b = r.outgoing ? (r.other.labels || []) : n.labels;
  const ov = r.onto && r.onto.views;
  const views = ov && ov[0] && ov[1] ? ov : [viewByLabels(a), viewByLabels(b)];
  return { a, b, bridge: views[0] !== views[1], views };
}
function curateControls(curate, props, ctx = null) {
  if (!curate) return null;
  const { status, score, shown } = edgeInfo(curate, props);
  const st = status || "candidate";
  const box = h("span", { class: "curate" },
    h("span", { class: `pill rel-${shown}`, text: REL_STATUS_DE[shown] || shown,
      title: shown === "implied" ? impliedHint(props.impliedVia) : null }),
    props.conflict ? h("span", { class: "pill conflict", title: CONFLICT_HINT(), text: t("Widerspruch") }) : null,
    score !== undefined && score !== null && score !== "" ? h("span", { class: "muted small", text: `Score ${Number(score).toFixed(2)}` }) : null,
    props.method ? h("span", { class: "muted small", title: [methodInfo(props.method).hint, props.evidence].filter(Boolean).join(" · "),
      text: methodInfo(props.method).title }) : null,
    props.reviewedBy ? h("span", { class: "muted small", text: `${props.reviewedBy}, ${fmtTs(props.reviewedAt)}` }) : null);
  const btn = (action, label, cls) => h("button", { type: "button", class: `small ${cls || ""}`,
    onclick: () => doRelAction(curate, action, status) }, label);
  if (linkTypes()[curate.type] && (st === "confirmed" || st === "source")) {
    // maschineller Vorschlag: nicht löschbar (käme beim nächsten Lauf wieder) – wird abgelehnt; „Zurücksetzen“ macht
    // ihn wieder zum offenen Vorschlag. Selbst angelegte Verknüpfung: wird gelöscht (v63.0.3: Beschriftung eindeutig)
    const machine = !!props.method && props.source !== "curator";
    box.append(h("button", { type: "button", class: "small danger",
      title: machine ? t("maschineller Vorschlag: wird abgelehnt und kommt beim nächsten Lauf nicht wieder") : t("selbst angelegte Verknüpfung löschen"),
      onclick: () => doLinkAction("remove", curate.start, curate.type, curate.end, curate.start_label, null) }, machine ? t("Ablehnen") : t("Entfernen")));
    if (machine && st === "confirmed") box.append(btn("reset", t("Zurücksetzen")));
    return box;
  }
  if (st === "source") {                            // aus der Quelle (z. B. Extraktion): nur ablehnen
    box.append(btn("reject", t("Ablehnen"), "danger"));
    return box;
  }
  if (st !== "confirmed") box.append(btn("confirm", t("Bestätigen"), "primary"));
  if (st !== "rejected") box.append(btn("reject", t("Ablehnen"), "danger"));
  if (st !== "candidate" && st !== "auto") box.append(btn("reset", t("Zurücksetzen")));
  box.append(...retypeButtons(curate.type, (to) => doRetype(curate, to), ctx));
  return box;
}
function relationCards(n) {
  const cfg = relCfg(), d = state.display, max = Number(d.max_per_group || 50);
  const groups = [...cfg.groups];
  if (!groups.some((g) => g.id === "other")) groups.push({ id: "other", title: t("Weitere") });
  const cards = [];
  for (const g of groups) {
    if (d.groups[g.id] === false) continue;
    const blocks = [];
    let count = 0;
    for (const p of n.paths.filter((x) => x.group === g.id)) {
      const rows = p.rows.filter((r) => passesFilter(r.curate, r.edge));
      if (!rows.length) continue;
      count += rows.length;
      const shown = rows.slice(0, max);
      const hasEdge = rows.some((r) => r.curate);
      blocks.push(h("div", { class: "rel-group" }, h("h3", { text: `${L(p.title)} (${rows.length})` }),
        h("div", { class: "table-wrap" }, h("table", { class: "paths" },
          h("thead", {}, h("tr", {}, ...p.columns.map((c) => h("th", { text: L(c) })), hasEdge ? h("th", { text: t("Zuordnung") }) : null)),
          h("tbody", {}, ...shown.map((r) => h("tr", { class: (r.edge || {}).status === "rejected" ? "rejected" : null }, ...r.nodes.map((x) => h("td", {}, nodeLink(x))),
            hasEdge ? h("td", { class: "cur" }, curateControls(r.curate, r.edge), herkunftPills(r.herkunft, true), decisionInfo(r.entscheidung)) : null))))),
        rows.length > max ? h("div", { class: "muted small", text: t("… {n} weitere (Anzeige: Höchstzahl je Gruppe)", { n: rows.length - max }) }) : null));
    }
    const byType = {};
    const lts = linkTypes();
    for (const r of n.relations.filter((x) => x.group === g.id && !d.hiddenTypes.includes(x.type) && !RULE_LINK_TYPES.includes(x.type) && passesFilter(x.curate, x.props))) {
      const lt = lts[r.type];
      const rt = (relCfg().rel_titles || {})[r.type];
      const head = lt ? (lt.symmetric ? lt.title : (r.outgoing ? lt.title : lt.inverse)) + ` (${r.type})`
        : `${r.outgoing ? "→" : "←"} ${rt ? `${rt} (${r.type})` : r.type}`;
      (byType[head] ||= []).push(r);
    }
    for (const [head, rs] of Object.entries(byType)) {
      count += rs.length;
      blocks.push(h("div", { class: "rel-group" }, h("h3", { text: `${head} (${rs.length})` }),
        h("ul", {}, ...rs.slice(0, max).map((r) => {
          const extra = r.curate ? "" : Object.entries(r.props || {}).filter(([k, v]) => v !== null && v !== "" && !(Array.isArray(v) && !v.length) && !HERKUNFT_PROPS.includes(k))
            .map(([k, v]) => `${k}: ${fmtVal(v)}`).join("; ");
          return h("li", {}, nodeLink(r.other), extra ? h("span", { class: "muted small", text: `  (${extra})` }) : null,
            curateControls(r.curate, r.props, relCtx(n, r)), r.curate && (r.props || {}).status === "candidate" ? ontoPill(r.onto) : null, herkunftPills(r.herkunft, true),
            decisionInfo(r.entscheidung));
        })),
        rs.length > max ? h("div", { class: "muted small", text: t("… {n} weitere", { n: rs.length - max }) }) : null));
    }
    const extra = g.id === "terms" ? termExtras(n) : [];
    cards.push(h("details", { class: "card", open: (count > 0 && count <= 60) || (g.id === "terms" && extra.length > 0) },
      h("summary", { text: `${g.title} (${count})` }), ...extra.slice(0, 1),
      ...(blocks.length ? blocks : [h("div", { class: "muted", text: t("keine") })]), ...extra.slice(1)));
  }
  return cards;
}

// ------------------------------------------------------------------ Begriffe: Benennungen, Verknüpfungen
const LABEL_FIELDS = [["prefLabel", "Vorzugsbenennung"], ["label", "Benennung"], ["prefLabelEn", "englisch"], ["labelEn", "englisch"],
  ["altLabels", "Synonyme"], ["altLabelsEn", "Synonyme englisch"], ["abbreviations", "Abkürzungen"], ["abbreviation", "Abkürzung"],
  ["hiddenLabels", "Aliase"], ["nameDe", "Name deutsch"], ["nameEn", "Name englisch"], ["mergedIds", "zusammengeführt aus"]];
function mentionExtras(n) {
  const p = n.props;
  const rows = [];
  if (p.kind) rows.push(h("tr", {}, h("td", { text: t("Art") }), h("td", { text: p.kind === "role" ? t("Rolle / Akteur") : t("Begriff") })));
  if (p.section) rows.push(h("tr", {}, h("td", { text: t("Kapitel") }), h("td", { text: `${p.section}${p.sectionTitle ? " " + p.sectionTitle : ""}` })));
  if (p.resolvedTo) rows.push(h("tr", {}, h("td", { text: t("zugeordnet zu") }), h("td", {}, nodeLink({ id: p.resolvedTo, title: p.resolvedTo }))));
  if (p.suggestedLabel) rows.push(h("tr", {}, h("td", { text: t("Vorschlag Sprachmodell") }), h("td", {},
    p.suggestedLabel, " ", n.type && !document.body.classList.contains("readonly") ? h("button", { type: "button", class: "link", onclick: () => {
      state.values.newLabel = p.suggestedLabel; renderDetail(); } }, t("als neue Benennung übernehmen")) : null)));
  return [h("div", { class: "rel-group" }, h("h3", { text: t("Erwähnung eines generischen Worts") }),
    h("div", { class: "muted small", text: t("Das Wort steht so im Text, meint aber je nach Satz etwas anderes. Zuordnen: Vorschlag „verweist auf“ bestätigen oder unten ein Ziel wählen; eigene Rolle/eigener Begriff: Feld „Neue Benennung“; kein Begriff: ablehnen. Wirksam beim nächsten Einspielen (Demo: Neustart).") }),
    rows.length ? h("table", { class: "props" }, h("tbody", {}, ...rows)) : null,
    (p.contexts || []).length ? h("ul", { class: "quotes" }, ...(p.contexts || []).map((q) => h("li", {}, h("q", { text: q })))) : null),
    linkForm(n)];
}
function termExtras(n) {
  if (n.labels.includes("Mention")) return mentionExtras(n);
  const lk = relCfg().links || {};
  const all = new Set([...(lk.from || []), ...(lk.to || [])]);
  if (!n.labels.some((l) => all.has(l))) return [];
  const rows = LABEL_FIELDS.filter(([k]) => !(Array.isArray(n.props[k]) ? !n.props[k].length : n.props[k] === undefined || n.props[k] === null || n.props[k] === ""))
    .map(([k, lab]) => h("tr", {}, h("td", { text: t(lab) }), h("td", { text: fmtVal(n.props[k]) })));
  const eq = n.equivalents;
  if (eq && eq.members.length) {
    if (eq.labels.de.length) rows.push(h("tr", {}, h("td", { text: t("über Gleichbedeutende") }), h("td", { text: fmtVal(eq.labels.de) })));
    if (eq.labels.en.length) rows.push(h("tr", {}, h("td", { text: t("über Gleichbedeutende, englisch") }), h("td", { text: fmtVal(eq.labels.en) })));
  }
  const names = h("div", { class: "rel-group" }, h("h3", { text: t("Benennungen") }),
    rows.length ? h("table", { class: "props" }, h("tbody", {}, ...rows)) : h("div", { class: "muted small", text: t("keine") }),
    n.type && !state.config.readonly ? h("div", { class: "muted small", text: t("Bearbeiten im Formular oben (Felder Benennung, englisch, Synonyme, Abkürzungen, Aliase).") }) : null);
  return [names, ...(eq && eq.members.length ? [equivalenceBlock(eq)] : []), ...inheritedBlock(eq), linkForm(n)];
}
// Ober-/Unterbegriffe der gleichbedeutenden Knoten (nur Anzeige; nach dem Einspielen/Zusammenführen echte Kanten)
function inheritedBlock(eq) {
  // v62.7.3: auch transitiv über die Kette der Ober-/Unterbegriffe (A → B → C), nicht nur über Gleichbedeutende
  const inh = eq && eq.inherited;
  if (!inh || (!inh.broader.length && !inh.narrower.length)) return [];
  const ART = { gleich: t("gleichbedeutend"), kette: t("Kette") };
  const table = (rows, col) => h("div", { class: "table-wrap" }, h("table", { class: "paths" },
    h("thead", {}, h("tr", {}, h("th", { text: col }), h("th", { text: t("über") }))),
    h("tbody", {}, ...rows.map((r) => h("tr", { class: "transitive" }, h("td", {}, nodeLink(r.node)),
      h("td", {}, nodeLink(r.via), r.art ? h("span", { class: "muted small", text: ` (${ART[r.art] || r.art})` }) : null))))));
  return [h("div", { class: "rel-group" },
    h("h3", { text: t("Geerbt und transitiv ({n})", { n: inh.broader.length + inh.narrower.length }) }),
    inh.broader.length ? table(inh.broader, t("Oberbegriff")) : null,
    inh.narrower.length ? table(inh.narrower, t("Unterbegriff")) : null,
    h("div", { class: "muted small", text: t("Abgeleitet aus bestätigten Verknüpfungen, nicht gespeichert: über gleichbedeutende Knoten und über die Kette der Ober- bzw. Unterbegriffe. Beim Einspielen (Reiter Prüfstand) werden gleichbedeutende Begriffe und Rollen zusammengeführt; dann gehören die Beziehungen zum Knoten selbst.") }))];
}
function equivalenceBlock(eq) {
  // Gleichbedeutend ist transitiv: A = B und B = C ergibt A = C (nur bestätigte bzw. automatische Verknüpfungen)
  const rows = eq.members.map((m) => h("tr", { class: m.distance > 1 ? "transitive" : null },
    h("td", {}, m.node.editable ? h("span", { class: "pill type mini", text: m.node.type || "" }) : null, nodeLink(m.node)),
    h("td", {}, m.distance === 1 ? h("span", { class: "pill rel-confirmed", text: t("direkt") })
      : h("span", {}, h("span", { class: "pill rel-auto", text: t("transitiv") }), " " + t("über") + " ",
        ...m.via.flatMap((v, i) => [i ? " → " : "", nodeLink(v)]))),
    h("td", { class: "num", text: String(m.distance) })));
  let merge = null;
  if (eq.merge_into) merge = h("div", { class: "small" }, t("Beim Zusammenführen geht dieser Knoten auf in") + " ", nodeLink(eq.merge_into), ".");
  else if (eq.merge_from.length) merge = h("div", { class: "small" }, t("Beim Zusammenführen bleibt dieser Knoten; darin gehen auf:") + " ",
    ...eq.merge_from.flatMap((r, i) => [i ? ", " : "", nodeLink(r)]), ".");
  return h("div", { class: "rel-group" },
    h("h3", { text: t("Gleichbedeutend – alle, auch über andere Knoten ({n}, davon transitiv {k})", { n: eq.members.length, k: eq.transitive }) }),
    h("div", { class: "table-wrap" }, h("table", { class: "paths" },
      h("thead", {}, h("tr", {}, h("th", { text: t("Knoten") }), h("th", { text: t("Weg") }), h("th", { text: t("Schritte") }))),
      h("tbody", {}, ...rows))),
    merge,
    h("div", { class: "muted small", text: t("Nur bestätigte bzw. automatische Verknüpfungen; Vorschläge zählen erst nach dem Bestätigen.") }));
}
function linkForm(n) {
  const opts = [["BROADER:out", "Oberbegriff hinzufügen (dieser Knoten ist Unterbegriff)"], ["BROADER:in", "Unterbegriff hinzufügen"],
    ["EXACT_MATCH:out", "Gleichbedeutend / Übersetzung – geht im Ziel auf"], ["EXACT_MATCH:in", "Gleichbedeutend / Übersetzung – dieser Knoten bleibt"],
    ["CLOSE_MATCH:out", "Nahe Entsprechung / Übersetzung – ohne Zusammenführen"], ["RELATED:out", "Verwandt"],
    ["REFERS_TO:out", "Zuordnen: diese Erwähnung meint …"]].filter(([k]) => linkAllowedFor(n, k.split(":")[0])).map(([k, lab]) => [k, t(lab)]);
  const sel = h("select", { "aria-label": t("Art der Verknüpfung") }, ...opts.map(([v, lab]) => h("option", { value: v, text: lab })));
  const inp = h("input", { type: "search", placeholder: t("Ziel suchen: Begriff, Rolle, Datenelement, Nachricht …"), "aria-label": t("Ziel der Verknüpfung") });
  const list = h("ul", { class: "link-results", role: "listbox" });
  // Ziel in der anderen Sprache (Deutsch ↔ Englisch): nur Knoten der anderen Sprache anzeigen
  const myLang = n.lang || "de", other = myLang === "en" ? "de" : "en";
  const langs = new Set(docs().map((d) => d.lang));
  const otherBox = h("input", { type: "checkbox" });
  const otherLabel = langs.size > 1 ? h("label", { class: "small" }, otherBox, " ", t("nur andere Sprache ({lang})", { lang: other.toUpperCase() })) : null;
  otherBox.addEventListener("change", () => run());
  const hint = h("div", { class: "muted small", text: t("Gleichbedeutende Begriffe bzw. Rollen werden beim nächsten Einspielen (Reiter Prüfstand oder curator/replay_links.py) zusammengeführt; Benennungen und Beziehungen wandern mit.") });
  let timer = null;
  const run = async () => {
    const q = inp.value.trim();
    if (q.length < 2) { list.replaceChildren(); return; }
    let hits = [];
    const prm = new URLSearchParams({ q, scope: "link", limit: "15" });
    if (otherBox.checked) prm.set("lang", other);
    try { hits = await api(`/api/search?${prm}`); } catch (e) { toast(e.message, true); return; }
    list.replaceChildren(...hits.filter((x) => x.id !== n.id).map((x) => h("li", {},
      h("button", { type: "button", class: "link", onclick: () => {
        const [lt, dir] = sel.value.split(":");
        const me = { id: n.id, label: n.type ? null : n.label }, other = { id: x.id, label: x.type ? null : x.label };
        const [a, b] = dir === "out" ? [me, other] : [other, me];
        doLinkAction("add", a.id, lt, b.id, a.label, b.label).then((ok) => { if (ok) { inp.value = ""; list.replaceChildren(); } });
      } }, h("span", { class: "pill type mini", text: x.type || x.label || "" }), ttl(x), docBadge(x),
      x.subtitle ? h("span", { class: "muted small", text: ` · ${x.subtitle}` }) : null))));
    if (!hits.length) list.replaceChildren(h("li", { class: "muted small", text: t("keine Treffer") }));
  };
  inp.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 250); });
  return h("div", { class: "rel-group link-form" }, h("h3", { text: t("Verknüpfung hinzufügen") }),
    h("div", { class: "link-row" }, sel, inp), otherLabel, list, hint,
    linkTypes().CLOSE_MATCH ? h("div", { class: "muted small", text: t("Nahe Entsprechung: Bedeutung nicht ganz gleich (z. B. enger, national) – die Knoten bleiben getrennt.") }) : null);
}
// Antwort einer Beziehungsaktion (view_id): alles übernehmen, was sich aus Beziehungen ergibt – Beziehungen, Pfade,
// gleichbedeutende Knoten samt transitiven, geerbte Ober-/Unterbegriffe, Ontologie, Herkunft; nicht die Felder in
// Bearbeitung (props, editable, rev), damit ungespeicherte Eingaben bleiben (v62.7.3)
function applyNodeUpdate(node) {
  if (!state.node || node.id !== state.node.id) return;
  for (const [k, v] of Object.entries(node)) if (!["props", "editable", "rev"].includes(k)) state.node[k] = v;
}
async function doLinkAction(action, start, type, end, startLabel, endLabel, force = false) {
  const user = $("user").value.trim();
  if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); $("user").focus(); return false; }
  const n = state.node;
  const payload = { start, type, end, action, user, comment: ($("comment") || {}).value || null,
    start_label: startLabel || null, end_label: endLabel || null, view_id: n.id, view_label: n.type ? null : n.label, force };
  try {
    const res = await api("/api/link/action", { method: "POST", body: JSON.stringify(payload) });
    if (res.node) applyNodeUpdate(res.node);
    const lt = linkTypes()[type] || {};
    toast(`${LINK_ACTION_DE[action]}: ${lt.title || type}${res.status === "rejected" ? " (" + t("Vorschlag abgelehnt") + ")" : ""}`);
    renderDetail(); loadHistory(n.id);
    return true;
  } catch (e) {
    // Fachontologie widerspricht: Rückfrage, dann trotzdem anlegen
    if (!force && e.body && e.body.params && e.body.params.onto === "conflict") {
      if (window.confirm(e.message)) return doLinkAction(action, start, type, end, startLabel, endLabel, true);
      return false;
    }
    toast(e.message, true); return false;
  }
}
async function doRelAction(curate, action, currentStatus) {
  const user = $("user").value.trim();
  if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); $("user").focus(); return; }
  const n = state.node;
  const payload = { start: curate.start, type: curate.type, end: curate.end, action, user, start_label: curate.start_label || null,
    comment: ($("comment") || {}).value || null, expected_status: currentStatus === "source" ? null : (currentStatus ?? null),
    view_id: n.id, view_label: n.type ? null : n.label };
  try {
    const res = await api("/api/relation/action", { method: "POST", body: JSON.stringify(payload) });
    if (res.node) applyNodeUpdate(res.node);
    toast(`${REL_ACTION_DE[action]}: ${curate.type} → ${curate.end}`);
    renderDetail(); loadHistory(n.id);
  } catch (e) { toast(e.message, true); }
}

// ------------------------------------------------------------------ Suche nach Beziehungsvorschlägen
const PROP_STATUS = tr({ candidate: "Vorschläge", implied: "transitiv bestätigt", confirmed: "bestätigt", rejected: "abgelehnt", auto: "automatisch", source: "aus Quelle", all: "alle Status" });
const PAGE = 100;
// Verfahren (method): Anzeigename und Erklärung aus relations.method_labels, sonst der technische Wert
function methodInfo(m) { return (relCfg().method_labels || {})[m || "–"] || { title: m || "–", hint: null }; }
function relTitle(rt) { return (relCfg().rel_titles || {})[rt] || (linkTypes()[rt] || {}).title || rt; }
// Reiter „Ontologie“ und Klassen-Sprünge nur für Domänen mit Ontologie-Curator (domain.yaml ontologie_curator)
const ontoAn = () => !!(state.config && state.config.domaene && state.config.domaene.ontologie_curator);
function setTab(tab) {
  if ((tab === "onto" && !ontoAn()) || (STATIC && ["props", "dec", "src"].includes(tab))) tab = "nodes";
  state.tab = tab;
  storage("curator.tab", tab);
  applyWinName();                                   // Prüfstand/Metamodell: nicht mehr Ziel von „↗“ aus anderen Fenstern
  for (const k of ["nodes", "props", "review", "meta", "dec", "onto", "src", "gap"]) $(`tab-${k}`).setAttribute("aria-selected", String(tab === k));
  $("search-form").hidden = tab !== "nodes";
  $("prop-form").hidden = tab !== "props";
  $("meta-form").hidden = tab !== "meta";
  $("onto-form").hidden = tab !== "onto";
  if (tab !== "onto" && state.ontoShown) { state.ontoShown = false; if (state.node) renderDetail(); }
  if (tab !== "review" && state.reviewShown) { state.reviewShown = false; if (state.node && tab !== "meta") renderDetail(); }
  if (tab !== "meta" && state.metaShown) { state.metaShown = false; if (state.node) renderDetail(); }
  if (tab !== "dec" && state.decShown) { state.decShown = false; if (state.node) renderDetail(); }
  if (tab !== "src" && state.srcShown) { state.srcShown = false; if (state.node) renderDetail(); }
  if (tab !== "gap" && state.gapShown) { state.gapShown = false; if (state.node) renderDetail(); }
  $("results").removeAttribute("aria-busy");
  if (tab === "props") searchProposals();
  else if (tab === "review") loadReview();
  else if (tab === "meta") loadMeta();
  else if (tab === "dec") loadDecisions();
  else if (tab === "src") loadSources();
  else if (tab === "gap") loadGaps();
  else if (tab === "onto") loadOnto();
  else if (state.tab === "nodes" && $("tab-nodes").classList.contains("tab-busy")) {   // Suche läuft noch
    $("result-info").textContent = t("lädt …");
    $("results").replaceChildren(h("li", { class: "loading-li", role: "option", "aria-disabled": "true" }, loadingEl()));
  } else renderResults();
}

// ------------------------------------------------------------------ Quellen (v64.5, common/quellen.py, agent/quellen_agent.py)
const SRC_CATS = () => [["vorhanden", t("Vorhandene Eingaben"), t("Dokumente und Dateien der Domäne (input/inputs.json) mit Quelle, Rechten und Stand")],
  ["neu", t("Neue Vorschläge"), t("Vom Quellen-Agenten gefunden, noch nicht entschieden")],
  ["aufnehmen", t("Zum Aufnehmen"), t("Entschieden: aufnehmen – noch nicht in der Domäne")],
  ["aufgenommen", t("Aufgenommen"), t("Vorschläge, die schon als Eingabe in der Domäne stehen")],
  ["offen", t("Zurückgestellt"), t("Entscheidung offen")],
  ["verwerfen", t("Verworfen"), t("Werden nicht erneut vorgeschlagen")],
  ["suche", t("Suche und Aufnahme"), t("Neue Quellen suchen (Websuche), markierte aufnehmen, Läufe")]];
function srcItems(cat) {
  const v = (state.src || { vorschlaege: [] }).vorschlaege;
  if (cat === "neu") return v.filter((x) => x.entscheidung === "neu" && !x.aufgenommen);
  if (cat === "aufnehmen") return v.filter((x) => x.entscheidung === "aufnehmen" && !x.aufgenommen);
  if (cat === "aufgenommen") return v.filter((x) => x.aufgenommen);
  if (cat === "offen" || cat === "verwerfen") return v.filter((x) => x.entscheidung === cat && !x.aufgenommen);
  return [];
}
function srcCount(c) { const s = state.src; return c === "vorhanden" ? s.vorhanden.length : c === "suche" ? s.laeufe.length : srcItems(c).length; }
async function loadSources() {
  const seq = listLoading("src");
  detailLoading(true);
  let res;
  try { res = await api("/api/quellen"); } catch (e) { if (isSeq("src", seq)) { listDone("src"); detailLoading(false); toast(e.message, true); } return; }
  if (!isSeq("src", seq)) return;
  listDone("src"); detailLoading(false);
  if (state.tab !== "src") return;
  state.src = res;
  renderSources(state.srcCat || (srcItems("neu").length ? "neu" : "vorhanden"));
}
function renderSourceList() {
  const s = state.src;
  $("result-info").textContent = t("Domäne {d} · {n} Vorschläge", { d: s.domaene, n: s.vorschlaege.length });
  $("results").setAttribute("role", "listbox");
  $("results").replaceChildren(...SRC_CATS().map(([k, title, hint]) => h("li", {
    role: "option", tabindex: "0", "aria-selected": String(k === state.srcCat), title: hint,
    onclick: () => zuAnsicht("src", k), onkeydown: (e) => { if (e.key === "Enter") zuAnsicht("src", k); },
  }, h("div", { class: "r-title", text: title }), h("div", { class: "r-meta" },
    h("span", { class: `pill ${["neu", "aufnehmen"].includes(k) && srcCount(k) ? "rel-candidate" : "type"}`, text: String(srcCount(k)) }),
    h("span", { class: "muted small", text: hint })))));
}
async function srcDecide(v, entscheidung, felder = {}) {
  const user = $("user").value.trim();
  if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); $("user").focus(); return; }
  try { await api("/api/quellen/entscheiden", { method: "POST", body: JSON.stringify({ url: v.url, entscheidung, user, titel: v.titel, ...felder }) }); }
  catch (e) { toast(e.message, true); return; }
  toast(t("„{t}“: {e}", { t: v.titel, e: SRC_DEC()[entscheidung] }));
  loadSources();
}
const SRC_DEC = () => ({ aufnehmen: t("aufnehmen"), verwerfen: t("verwerfen"), offen: t("zurückgestellt"), neu: t("neu") });
const SRC_PRIO = () => ({ 1: t("Priorität 1 – deckt eine klare Lücke"), 2: t("Priorität 2 – ergänzt"), 3: t("Priorität 3 – optional") });
function srcLink(url, text) { return h("a", { href: url, target: "_blank", rel: "noopener noreferrer", class: "link", text: text || url }); }
function srcCard(v) {
  const ro = state.config.readonly;
  const f = v.felder || {};
  const inp = (k, ph, w = "10em") => h("input", { type: "text", value: f[k] || "", placeholder: ph, "data-k": k, style: `width:${w}` });
  const form = h("div", { class: "small", hidden: true },
    h("div", {}, t("PDF-Fassung"), " ", inp("pdf_url", "https://…", "28em")),
    h("div", {}, t("Kennung"), " ", inp("id", "z. B. eu_uzk_de"), " ", t("Sprache"), " ", inp("sprache", "de", "4em"), " ",
      t("Profil"), " ", inp("profil", "", "9em"), " ", t("Fassung"), " ", inp("version", "", "6em")),
    h("div", {}, t("Lokale PDF (statt Download)"), " ", inp("pfad", "quellen/…pdf", "20em")),
    h("div", { class: "el-bar" }, h("button", { type: "button", class: "small", onclick: () => {
      const felder = {};
      form.querySelectorAll("input[data-k]").forEach((i) => { felder[i.dataset.k] = i.value.trim(); });
      srcDecide(v, v.entscheidung === "neu" ? "offen" : v.entscheidung, felder);
    } }, t("Angaben speichern"))));
  const btn = (e, cls, label) => v.entscheidung === e ? null : h("button", { type: "button", class: `small ${cls}`, onclick: () => srcDecide(v, e) }, label);
  return h("div", { class: "hist" },
    h("div", {}, h("strong", {}, srcLink(v.url, v.titel)),
      v.url_aus_suche === false ? h("span", { class: "pill rel-rejected", title: t("Diese Adresse stand nicht in den Suchergebnissen – vor dem Aufnehmen prüfen"), text: t("⚠ URL nicht aus der Suche") }) : null,
      v.pdf_url ? [" · ", srcLink(v.pdf_url, "PDF"), v.pdf_url_aus_suche === false ? " ⚠" : ""] : null,
      v.von_hand ? h("span", { class: "pill type", text: t("von Hand") }) : null),
    h("div", { class: "small muted", text: [v.herausgeber, [v.art, v.format, v.sprache].filter(Boolean).join(" · "),
      v.frei_verfuegbar ? t("frei: {f}", { f: v.frei_verfuegbar }) + (v.lizenz ? ` (${v.lizenz})` : "") : null,
      v.sicherheit != null ? t("Sicherheit {s}", { s: Number(v.sicherheit).toFixed(2) }) : null].filter(Boolean).join(" · ") }),
    v.nutzen ? h("div", { class: "small", text: v.nutzen + (v.luecke ? ` – ${v.luecke}` : "") }) : null,
    v.entschieden_von ? h("div", { class: "small muted", text: t("{e} · {d} · {u}", { e: SRC_DEC()[v.entscheidung] || v.entscheidung, d: v.entschieden_am || "", u: v.entschieden_von }) + (v.kommentar ? ` · „${v.kommentar}“` : "") }) : null,
    ro || v.aufgenommen ? null : h("div", { class: "el-bar" }, btn("aufnehmen", "primary", t("Aufnehmen")), btn("offen", "", t("Zurückstellen")),
      btn("verwerfen", "danger", t("Verwerfen")),
      h("button", { type: "button", class: "small link", onclick: () => { form.hidden = !form.hidden; } }, t("Angaben …"))),
    ro ? null : form);
}
function srcByPrio(items) {
  if (!items.length) return [h("div", { class: "card" }, h("div", { class: "muted", text: t("keine") }))];
  if (items.length < (state.src.liste_ab || 5)) return [h("div", { class: "card" }, ...items.map(srcCard))];
  return [1, 2, 3].map((p) => [p, items.filter((x) => (Number(x.prioritaet) || 3) === p)]).filter(([, xs]) => xs.length)
    .map(([p, xs]) => h("div", { class: "card" }, h("h2", { text: `${SRC_PRIO()[p]} (${xs.length})` }), ...xs.map(srcCard)));
}
async function srcRun(path, body, card, confirmText) {
  if (confirmText && !window.confirm(confirmText)) return;
  const out = h("pre", { class: "small", tabindex: "0", style: "white-space:pre-wrap;max-height:28em;overflow:auto" });
  card.querySelectorAll("pre").forEach((p) => p.remove());
  card.append(loadingEl(t("läuft … (Websuche bzw. Download kann einige Minuten dauern)")));
  let r;
  try { r = await api(path, { method: "POST", body: JSON.stringify(body) }); }
  catch (e) { card.querySelectorAll(".loading-ph").forEach((x) => x.remove()); toast(e.message, true); return; }
  card.querySelectorAll(".loading-ph").forEach((x) => x.remove());
  out.textContent = r.ausgabe || "";
  card.append(h("div", { class: "small muted", text: t("Ende: Rückgabe {rc}, {s} s", { rc: r.rc, s: r.sekunden }) }), out);
  toast(r.rc === 0 ? t("fertig") : t("beendet mit Rückgabe {rc}", { rc: r.rc }), r.rc !== 0);
  if (!body.trocken) { const keep = state.srcCat; await loadSources(); state.srcCat = keep; }
}
function srcSearchCard() {
  const s = state.src, ro = state.config.readonly;
  const themen = h("textarea", { rows: 3, style: "width:100%", placeholder: t("weitere Themen, eines je Zeile (die Themen der Domäne gelten immer)") });
  const doms = h("input", { type: "text", style: "width:100%", placeholder: t("nur diese Websites, durch Leerzeichen getrennt (leer = alle)") });
  const body = (trocken) => ({ themen: themen.value.split("\n").map((x) => x.trim()).filter(Boolean),
    domains: doms.value.split(/\s+/).map((x) => x.trim()).filter(Boolean), trocken });
  const card = h("div", { class: "card" }, h("h2", { text: t("Neue Quellen suchen") }),
    h("div", { class: "small" }, t("Websuche der Claude API: gesendet werden nur Titel und Beschreibung der Domäne und die Titel der vorhandenen Quellen.")),
    h("div", { class: "small" }, h("span", { class: `pill ${s.freigegeben ? "rel-confirmed" : "rel-rejected"}`, text: s.freigegeben ? t("freigegeben") : t("gesperrt (quellen.freigegeben)") }), " ",
      h("span", { class: `pill ${s.schluessel ? "rel-confirmed" : "rel-rejected"}`, text: s.schluessel ? t("API-Schlüssel vorhanden") : t("kein API-Schlüssel") }), " ",
      h("span", { class: "muted", text: t("bis {n} Suchen × {p} USD zzgl. Tokens", { n: s.max_suchen, p: s.preis_je_suche }) })),
    s.themen.length ? h("div", { class: "small muted", text: t("Themen der Domäne: {t}", { t: s.themen.join(" · ") }) }) : null,
    ro ? null : [themen, doms, h("div", { class: "el-bar" },
      h("button", { type: "button", class: "small", onclick: () => srcRun("/api/quellen/suchen", body(true), card) }, t("Anfrage ansehen (ohne Senden)")),
      h("button", { type: "button", class: "small primary", disabled: !(s.freigegeben && s.schluessel), onclick: () => srcRun("/api/quellen/suchen", body(false), card,
        t("Suche mit der Claude API starten? Kosten bis etwa {u} USD für Suchen zzgl. Tokens.", { u: (s.max_suchen * s.preis_je_suche).toFixed(2) })) }, t("Suche starten")))]);
  return card;
}
function srcAddCard() {
  const n = srcItems("aufnehmen").length, ro = state.config.readonly;
  const umw = h("input", { type: "checkbox", checked: true });
  const card = h("div", { class: "card" }, h("h2", { text: t("Markierte aufnehmen") }),
    h("div", { class: "small", text: t("Lädt jede Quelle mit „aufnehmen“ von genau der eingetragenen Adresse (PDF-Fassung bevorzugt), legt sie unter input/quellen/ ab, trägt sie in input/inputs.json ein und wandelt sie mit Docling um. Webseiten werden nur gemeldet.") }),
    ro ? null : h("div", { class: "el-bar" }, h("label", { class: "small" }, umw, " ", t("mit Docling umwandeln")),
      h("button", { type: "button", class: "small", disabled: !n, onclick: () => srcRun("/api/quellen/aufnehmen", { trocken: true }, card) }, t("Vorschau")),
      h("button", { type: "button", class: "small primary", disabled: !n, onclick: () => srcRun("/api/quellen/aufnehmen", { trocken: false, umwandeln: umw.checked }, card,
        tp(n, "1 Quelle jetzt laden und aufnehmen?", "{n} Quellen jetzt laden und aufnehmen?")) }, tp(n, "1 Quelle aufnehmen", "{n} Quellen aufnehmen"))),
    state.src.letzte_aufnahme ? h("details", { class: "small" }, h("summary", { text: t("Bericht der letzten Aufnahme") }),
      h("pre", { style: "white-space:pre-wrap", tabindex: "0", text: state.src.letzte_aufnahme })) : null);
  return card;
}
function renderSources(cat) {
  $("detail").dataset.maske = "quellen";                 // Handbuch: passendes Kapitel (handbuch.js)
  state.srcCat = cat; state.srcShown = true;
  renderSourceList();
  const s = state.src;
  const [, title, hint] = SRC_CATS().find((x) => x[0] === cat);
  const parts = [h("div", { class: "node-head" }, h("h1", { text: title }), h("div", { class: "muted small" }, hint, " · ",
    h("a", { href: "/quelltext", target: "_blank", rel: "noopener", text: t("Code und Schnittstellen vollständig ↗") })))];
  if (cat === "vorhanden") {
    parts.push(h("div", { class: "card" }, h("div", { class: "table-wrap" }, h("table", { class: "paths review" },
      h("thead", {}, h("tr", {}, ...[t("Eingabe"), t("Art"), t("Fassung"), t("abgerufen"), t("Quelle"), t("Rechte"), t("Stand")].map((x) => h("th", { text: x })))),
      h("tbody", {}, ...s.vorhanden.map((r) => h("tr", {},
        h("td", {}, h("strong", { text: r.titel }), h("div", { class: "small muted mono", text: `${r.id}${r.datei ? " · " + r.datei : ""}` })),
        h("td", { text: r.art === "dokument" ? `${r.format}${r.sprache ? " · " + r.sprache : ""}${r.profil ? " · " + r.profil : ""}${r.haupt ? " · " + t("Hauptdokument") : ""}` : t("Datei") }),
        h("td", { text: r.version || "–" }), h("td", { text: r.abgerufen || "–" }),
        h("td", {}, ...(r.quelle || "–").split(/(https?:\/\/\S+)/).map((x) => /^https?:\/\//.test(x) ? srcLink(x, x.length > 60 ? x.slice(0, 57) + "…" : x) : x)),
        h("td", { text: r.rechte || "–" }),
        h("td", {}, r.status ? h("span", { class: `pill ${r.status === "ok" ? "rel-confirmed" : "rel-candidate"}`, title: r.status_text || "", text: r.status }) : "–"))))))));
  } else if (cat === "suche") {
    parts.push(srcSearchCard(), srcAddCard(), h("div", { class: "card" }, h("h2", { text: t("Läufe") }),
      ...(s.laeufe.length ? s.laeufe.map((l) => h("div", { class: "small", text: t("{ts} · {n} neue Vorschläge · {s} Suchen · {u} USD · {m}", { ts: fmtTs(l.ts), n: l.neu, s: l.suchen, u: l.kosten_usd, m: l.modell }) }))
        : [h("div", { class: "muted small", text: t("noch keine Suche") })])));
  } else {
    if (cat === "aufnehmen") parts.push(srcAddCard());
    parts.push(...srcByPrio(srcItems(cat)));
  }
  parts.push(h("div", { class: "muted small", text: t("Entscheidungen stehen in {f} (Repo der Domäne).", { f: s.datei }) }));
  $("detail").replaceChildren(...parts);
}

// ------------------------------------------------------------------ Lücken (FR4, common/luecken.py, abgleich/drei_sichten.py)
const GAP_CATS = () => [["steckbrief", t("Steckbrief der Domäne"), t("Systeme und Rollen, Prozesse, Schnittstellen, Dienste im Code, Kennzahlen und Lücken auf einer Seite")],
  ["architektur", t("Architektur (ArchiMate)"), t("Enterprise-Architektur aus Fachkonzept und Schnittstellen: Elemente je Schicht als Diagramm, Fachdomänen, Modell zum Laden in Archi")],
  ["baum", t("Lückenbaum und Aufgaben"), t("Hauptlücken je Kapitel mit ihren Folgelücken, was alles dazugehört, und je Hauptlücke ein Aufgabenvorschlag zum Schließen (Markdown für Tickets)")],
  ["suche", t("Suchen"), t("Lücken nach Anforderung, Regel, System/Microservice, Package, Klasse/Methode, BPMN-Prozess/Aktivität")],
  ["oben", t("Von oben: Fachkonzept → Code"), t("Kapitel, Anforderungen und Regeln mit ihren Lücken und Codestellen")],
  ["unten", t("Von unten: Code → Fachkonzept"), t("Dienste, Dateien und Methoden mit ihren Lücken, Anforderungen und Abschnitten")],
  ["matrix", t("Traceability-Matrix"), t("Je Anforderung und Regel die Kette Belegstelle → Regel → Prozess → Nachricht → Klasse → Test, mit Lücken; Export als CSV für Excel")],
  ["impact", t("Auswirkungen (Impact Analysis)"), t("Was ist betroffen, wenn sich eine Anforderung, Regel, ein Begriff, eine Nachricht oder Klasse ändert – mit Weg und Grund")],
  ["abdeckung", t("Abdeckung: nicht Verknüpftes"), t("Welche Abschnitte der Dokumente und welche Nachrichten und Felder der Schnittstelle mit keinem Begriff, keiner Regel und keinem anderen Wissensknoten verknüpft sind")],
  ["zuordnung", t("Anforderungen je System/Package/Klasse"), t("Anforderungen und Regeln je Microservice, Package und Klasse – zugeordnet über Begriffe, Domänenmodell, Tätigkeiten, Nachrichten und Lücken (heuristisch)")],
  ["rollen", t("Rollen je System"), t("Rollen bzw. Akteure je System des Fachkonzepts mit ihren Anforderungen")],
  ["typen", t("Nach Lückentyp"), t("Lücken gruppiert nach Typ (Regel des Abgleichs) mit Zahl je Typ und Entscheidung")],
  ["neu", t("Neu"), t("Noch nicht entschieden")],
  ["bpmn", t("Sicht BPMN"), t("Im vorhandenen BPMN fehlt oder weicht ab, was das Fachkonzept verlangt")],
  ["code", t("Sicht Code"), t("Im Code fehlt oder weicht ab, was das Fachkonzept verlangt")],
  ["beide", t("BPMN und Code"), t("In beiden Sichten")],
  ["schnittstelle", t("Sicht Schnittstelle"), t("In der Schnittstellenbeschreibung des Projekts (OpenAPI/AsyncAPI/JSON Schema) fehlt oder weicht ab, was die Nachrichtentabelle verlangt")],
  ["bestaetigt", t("Bestätigt"), t("Als echte Lücke bestätigt")],
  ["falsch", t("Fehlalarm"), t("Als falsch markiert – die Regel des Abgleichs schärfen")],
  ["offen", t("Zurückgestellt"), t("Entscheidung offen")],
  ["abgleich", t("BPMN-Abgleich"), t("Abgeleitete Prozesse (aus dem Fachkonzept) ↔ vorhandenes BPMN, Element für Element")],
  ["graph", t("BPMN als Graph"), t("Vorhandenes und abgeleitetes BPMN als Diagramm: rot fehlt im BPMN, orange nur im BPMN, grün passt")]];
const GAP_DEC = () => ({ bestaetigt: t("bestätigt"), falsch: t("Fehlalarm"), offen: t("zurückgestellt"), neu: t("neu") });
const GAP_ART = () => ({ fehlt: t("fehlt"), abweichend: t("abweichend"), unvollstaendig: t("unvollständig") });
// Lückentypen = Regeln des Abgleichs (abgleich/drei_sichten.py), nach Sicht gruppiert
const GAP_TYP = () => ({
  nachricht_nicht_gesendet: t("Nachricht nicht gesendet"), nachricht_nicht_empfangen: t("Nachricht nicht empfangen"),
  nachricht_ohne_sender: t("Nachricht ohne Absender"), nachricht_benennung: t("Nachricht anders benannt"),
  partner_abweichend: t("Absender/Empfänger abweichend"), daten_fehlen: t("Nutzdaten fehlen"), feld_nicht_gesetzt: t("Feld nicht gesetzt"),
  attribut_fehlt: t("Attribut fehlt"), klasse_fehlt: t("Klasse fehlt"), variable_abweichend: t("Variable anders geschrieben"),
  feste_daten: t("Feste Daten statt Eingaben"), idempotenz: t("Wiederholung nicht erkannt"), begrenzung_fehlt: t("Begrenzung fehlt"),
  regelwert_abweichend: t("Regelwert abweichend"), regelwert_fehlt: t("Regelwert nicht geprüft"),
  platzhalter: t("Platzhalter statt Fachlogik"), start_ohne_modell: t("Prozessstart ohne Modell"),
  prozess_fehlt_bpmn: t("Prozess fehlt im BPMN"),
  nachricht_fehlt_schnittstelle: t("Nachricht fehlt in der Schnittstelle"), daten_fehlen_schnittstelle: t("Nutzdaten fehlen in der Schnittstelle"),
  partner_abweichend_schnittstelle: t("Absender in der Schnittstelle abweichend"), baustein_fehlt_bpmn: t("Baustein fehlt im BPMN"),
  nachricht_fehlt_bpmn: t("Nachricht fehlt im BPMN"), frist_fehlt_bpmn: t("Frist fehlt im BPMN"), benennung_abweichend: t("Benennung abweichend") });
const gapTypName = (r) => GAP_TYP()[r] || r;
const gapTypen = (x) => x.regeln && x.regeln.length ? x.regeln : x.regel ? [x.regel] : [];
const gapTypPills = (x) => gapTypen(x).map((r) => h("span", { class: "pill gap-typ", title: `${t("Lückentyp")} · ${t("Kennung")}: ${r}`, text: gapTypName(r) }));
function gapItems(cat) {
  const l = (state.gap || { luecken: [] }).luecken;
  // Folgelücken (haengt_an) erst entscheiden, wenn die Hauptlücke behoben ist – nicht unter „Neu“
  if (cat === "neu") return l.filter((x) => x.entscheidung === "neu" && !(x.haengt_an || []).length);
  if (["bestaetigt", "falsch", "offen"].includes(cat)) return l.filter((x) => x.entscheidung === cat);
  if (["bpmn", "code", "beide", "schnittstelle"].includes(cat)) return l.filter((x) => x.sicht === cat && x.entscheidung !== "falsch");
  return [];
}
function gapCount(c) {
  const s = state.gapSichten;
  if (c === "oben") return s ? s.oben.reduce((n, k) => n + k.mit_luecke, 0) : 0;
  if (c === "unten") return s ? s.unten.reduce((n, d) => n + d.dateien.reduce((m, f) => m + f.stellen.length, 0), 0) : 0;
  if (c === "suche") return (state.gap.luecken || []).length;
  if (c === "zuordnung" || c === "rollen" || c === "steckbrief" || c === "architektur" || c === "matrix" || c === "impact" || c === "abdeckung") return null;
  if (c === "baum") return (state.gap.luecken || []).filter((x) => !(x.haengt_an || []).length).length;   // eigene Ansicht, keine Zahl von Lücken
  if (c === "typen") return new Set((state.gap.luecken || []).flatMap(gapTypen)).size;
  return c === "abgleich" || c === "graph" ? Object.keys(state.gap.bpmn || {}).length : gapItems(c).length;
}
async function loadGaps() {
  const seq = listLoading("gap");
  detailLoading(true);
  let res;
  try { [res, state.gapSichten] = await Promise.all([api("/api/luecken"), api("/api/luecken/sichten")]); }
  catch (e) { if (isSeq("gap", seq)) { listDone("gap"); detailLoading(false); toast(e.message, true); } return; }
  if (!isSeq("gap", seq)) return;
  listDone("gap"); detailLoading(false);
  if (state.tab !== "gap") return;
  state.gap = res;
  state.gapGraph = null;                                 // BPMN als Graph neu laden
  state.gapIndex = null;                                 // Suchindex neu laden
  state.gapZuordnung = null;                             // Anforderungen je System/Package/Klasse neu laden
  state.steckbrief = null;                               // Steckbrief neu laden
  state.archimate = null;                                // ArchiMate-Modell neu laden (Filter bleiben)
  state.trMatrix = null;                                 // Traceability-Matrix neu laden
  state.impGraph = null;                                 // Wirkungsgraph neu laden (Ausgangspunkt bleibt)
  state.abdeckung = null;                                // Abdeckung neu berechnen
  state.baum = null;                                     // Lückenbaum neu aufbauen
  renderGaps(state.gapCat || "oben");
}
function renderGapList() {
  const g = state.gap;
  $("result-info").textContent = t("{n} Lücken · Stand {s}", { n: g.luecken.length, s: g.stand || "–" });
  $("results").setAttribute("role", "listbox");
  $("results").replaceChildren(...GAP_CATS().map(([k, title, hint]) => h("li", {
    role: "option", tabindex: "0", "aria-selected": String(k === state.gapCat), title: hint,
    onclick: () => zuAnsicht("gap", k), onkeydown: (e) => { if (e.key === "Enter") zuAnsicht("gap", k); },
  }, h("div", { class: "r-title", text: title }), h("div", { class: "r-meta" },
    gapCount(k) === null ? null : h("span", { class: `pill ${k === "neu" && gapCount(k) ? "rel-candidate" : "type"}`, text: String(gapCount(k)) }),
    h("span", { class: "muted small", text: hint })))));
}
async function gapDecide(x, entscheidung, kommentar, nachher) {
  const user = $("user").value.trim();
  if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); $("user").focus(); return; }
  try { await api("/api/luecken/entscheiden", { method: "POST", body: JSON.stringify({ schluessel: x.schluessel, entscheidung, user, kommentar, titel: x.titel }) }); }
  catch (e) { toast(e.message, true); return; }
  toast(t("„{t}“: {e}", { t: x.titel, e: GAP_DEC()[entscheidung] }));
  if (nachher) {                                         // z. B. aus dem BPMN-Graph: Ansicht behalten, nur Stand nachführen
    x.entscheidung = entscheidung;
    x.entschieden = { von: user, am: new Date().toISOString().slice(0, 10), ...(kommentar ? { kommentar } : {}) };
    renderGapList();
    nachher(x);
    return;
  }
  loadGaps();
}
// Kennung einer Anforderung bzw. Regel als Sprung in den Document Structure Viewer (Beleg aus den Sichten), sonst Text
function gapReqLink(id) {
  const s = state.gapSichten;
  if (s && state.gapReqIdx !== s) {
    state.gapReqMap = {};
    for (const k of s.oben || []) for (const e of k.eintraege) state.gapReqMap[e.id] = e;
    state.gapReqIdx = s;
  }
  const e = (state.gapReqMap || {})[id];
  const doc = e && e.block ? e.block.split(":")[0] : null;
  if (!e || !hasDocling(doc)) return id;
  return h("a", { class: "link docling-link", href: doclingUrl({ el: e.block, q: (e.zitat || "").slice(0, 120) }), target: "docling", rel: "noopener",
    title: `${id}: ${e.text || ""}`.slice(0, 300), text: `📄 ${id}` });
}
function gapVerbinde(teile, sep) { return teile.flatMap((x, i) => (i ? [sep, x] : [x])); }
function gapCard(x, nachher, innen = false) {        // innen: in einer anderen Karte (ohne verschachtelte Haupt-/Folgelücken)
  const note = h("input", { type: "text", class: "small", placeholder: t("Kommentar (optional)"), value: (x.entschieden || {}).kommentar || "" });
  const pill = { fehlt: "rel-rejected", abweichend: "rel-candidate", unvollstaendig: "rel-candidate" }[x.art] || "type";
  return h("div", { class: "card" },
    h("h2", {}, `${x.id} · ${x.titel}`),
    h("div", { class: "r-meta" }, h("span", { class: `pill ${pill}`, text: GAP_ART()[x.art] || x.art }),
      h("span", { class: "pill type", text: x.sicht === "beide" ? t("BPMN und Code") : x.sicht === "schnittstelle" ? t("Schnittstelle") : x.sicht.toUpperCase() }),
      ...gapTypPills(x),
      h("span", { class: `pill ${x.entscheidung === "bestaetigt" ? "rel-confirmed" : x.entscheidung === "falsch" ? "rel-rejected" : "type"}`, text: GAP_DEC()[x.entscheidung] || x.entscheidung }),
      x.entschieden ? h("span", { class: "muted small", text: `${x.entschieden.von || ""} ${x.entschieden.am || ""}` }) : null),
    h("p", { text: x.beschreibung }),
    (x.haengt_an || []).length ? h("div", { class: "gap-folge small" }, t("Folgelücke von {k} – sie besteht, weil die Hauptlücke besteht, und wird erst entschieden, wenn diese behoben ist.",
      { k: x.haengt_an.join(", ") }), " ", ...(innen ? [] : x.haengt_an.map((k) => gapMini(k)))) : null,
    (x.folgen || []).length ? h("details", { class: "gap-folge small" }, h("summary", { text: t("Folgelücken ({n}): {k} – werden mit dieser Lücke behoben bzw. danach geprüft", { n: x.folgen.length, k: x.folgen.join(", ") }) }),
      ...(innen ? [] : x.folgen.map((k) => gapMini(k)))) : null,
    x.anforderungen.length ? h("div", { class: "small" }, h("strong", { text: t("Anforderungen: ") }), gapVerbinde(x.anforderungen.map(gapReqLink), ", ")) : null,
    x.belege.length ? h("details", { class: "small" }, h("summary", { text: t("Belege ({n})", { n: x.belege.length }) }),
      h("ul", {}, ...x.belege.map((b) => h("li", { class: "mono" }, ...belegZeile(b))))) : null,
    innen ? null : h("div", { class: "small" }, h("a", { href: "#", text: t("→ im Lückenbaum mit Aufgabe"), onclick: (e) => {
      e.preventDefault(); const k = (x.haengt_an || [])[0] || x.id; state.baumOffen = k; zuAnsicht("gap", "baum"); } })),
    h("div", { class: "muted small", title: gapTypen(x).join(", "),          // Kennung (Regel des Abgleichs) nur im Tooltip
      text: t("Lückentyp: {r}", { r: gapTypen(x).map(gapTypName).join(", ") }) }),
    state.config.readonly ? null : h("div", { class: "el-bar" }, note,
      h("button", { type: "button", class: "small", onclick: () => gapDecide(x, "bestaetigt", note.value.trim() || null, nachher) }, t("Bestätigen")),
      h("button", { type: "button", class: "small", onclick: () => gapDecide(x, "falsch", note.value.trim() || null, nachher) }, t("Fehlalarm")),
      h("button", { type: "button", class: "small", onclick: () => gapDecide(x, "offen", note.value.trim() || null, nachher) }, t("Zurückstellen"))));
}
function gapAbgleich() {
  const b = state.gap.bpmn || {};
  return Object.entries(b).map(([pid, a]) => h("div", { class: "card" },
    h("h2", { text: `${a.name} ↔ ${a.vorhanden ? a.vorhanden.prozess : "–"}` }),
    a.vorhanden ? h("div", { class: "muted small mono", text: a.vorhanden.datei }) : null,
    h("div", { class: "table-wrap" }, h("table", { class: "paths review" },
      h("thead", {}, h("tr", {}, ...[t("Baustein"), t("Element"), t("Art"), t("vorhanden")].map((x) => h("th", { text: x })))),
      h("tbody", {}, ...a.elemente.map((z) => h("tr", {},
        h("td", { class: "small mono", text: z.baustein }), h("td", { text: z.name }), h("td", { text: z.art }),
        h("td", {}, z.vorhanden ? z.vorhanden_name : h("span", { class: "pill rel-rejected", text: t("fehlt") }))))))),
    a.nur_vorhanden.length ? h("div", { class: "small" }, h("strong", { text: t("Nur im vorhandenen BPMN: ") }),
      a.nur_vorhanden.map((x) => x.name || x.id).join("; ")) : null));
}
// Suche über Anforderung, Regel, Klasse/Methode, BPMN-Prozess/Aktivität (common/luecken.py suchindex); Felder UND-verknüpft
const GAP_SUCHE_LEER = () => ({ text: "", anf: "", regel: "", typ: "", dienst: "", paket: "", klasse: "", methode: "", modell: "", element: "", status: "" });
const gapNorm = (s) => (s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/ß/g, "ss");
function gapVolltext(x, voll, q) {
  // alle Wörter (UND) im Text einer Anforderung bzw. Regel der Lücke oder in Titel und Beschreibung der Lücke
  const w = gapNorm(q).split(/\s+/).filter(Boolean);
  if (!w.length) return null;
  const passt = (s) => { const n = gapNorm(s); return w.every((x) => n.includes(x)); };
  const texte = state.gapIndex.texte || {};
  const ids = [...x.anforderungen, ...x.regeln].filter((a) => passt(`${a} ${texte[a] || ""}`));
  const selbst = passt(`${voll.titel || ""} ${voll.beschreibung || ""}`);
  return ids.length || selbst ? { ids, selbst } : null;
}
function gapKennung(id, q) {
  // „A-4.3“ trifft A-4.3-1, A-4.3-2 …; „R-1“ nur R-1 (nicht R-10)
  const a = id.toLowerCase(), b = q.trim().toLowerCase();
  return !b || a === b || a.startsWith(b + "-") || a.startsWith(b + ".");
}
function gapTreffer(id, f) {
  const x = state.gapIndex.luecken[id];
  if (!x) return null;
  const voll = (state.gap.luecken || []).find((y) => y.id === id) || {};
  if (f.status && voll.entscheidung !== f.status) return null;
  if (f.typ && !gapTypen(voll).includes(f.typ)) return null;
  const voll_text = f.text.trim() ? gapVolltext(x, voll, f.text) : null;
  if (f.text.trim() && !voll_text) return null;
  const anf = f.anf.trim() ? x.anforderungen.filter((a) => gapKennung(a, f.anf)) : [];
  if (f.anf.trim() && !anf.length) return null;
  const reg = f.regel.trim() ? x.regeln.filter((a) => gapKennung(a, f.regel)) : [];
  if (f.regel.trim() && !reg.length) return null;
  const kl = f.klasse.trim().toLowerCase(), me = f.methode.trim().toLowerCase(), di = f.dienst, pa = f.paket.trim().toLowerCase();
  const code = kl || me || di || pa ? x.code.filter((c) => (!kl || c.klasse.toLowerCase().includes(kl)) && (!me || (c.methode || "").toLowerCase().includes(me))
    && (!di || c.dienst === di) && (!pa || (c.paket || "").toLowerCase().includes(pa))) : [];
  if ((kl || me || di || pa) && !code.length) return null;
  const bpmn = f.modell ? x.bpmn.filter((b) => b.modell === f.modell && (!f.element || b.element === f.element)) : [];
  if (f.modell && !bpmn.length) return null;
  return { anf, reg, code, bpmn, text: voll_text };
}
function gapSuche() {
  const ix = state.gapIndex;
  const f = state.gapSuche = { ...GAP_SUCHE_LEER(), ...(state.gapSuche || {}) };
  if (!ix) {
    api("/api/luecken/suche").then((r) => { state.gapIndex = r; if (state.gapCat === "suche") renderGaps("suche"); })
      .catch((e) => toast(e.message, true));
    return [h("div", { class: "muted small", text: t("Suchindex wird geladen …") })];
  }
  ix.texte = ix.texte || Object.fromEntries([...ix.anforderungen, ...ix.regeln].map((a) => [a.id, a.text || ""]));
  const ergebnis = h("div", {});
  const modelle = Object.fromEntries(ix.modelle.map((m) => [m.key, m]));
  const liste = (id, werte) => h("datalist", { id }, ...werte.map((w) => h("option", { value: w.id || w.name, label: w.label || "" })));
  const anzahlText = (n) => n ? ` (${n})` : "";
  const feld = (k, label, ph, dl, breit) => h("label", { class: "gap-such-feld" + (breit ? " breit" : "") }, h("span", { class: "small muted", text: label }),
    h("input", { type: "search", value: f[k], placeholder: ph, list: dl, autocomplete: "off",
      oninput: (e) => { f[k] = e.target.value; if (k === "klasse") methodenListe(); if (k === "paket") klassenListe(); zeige(); } }));
  // System/Microservice und Package: Auswahl der Dienste aus dem Code, Pakete und Klassen je nach Wahl eingegrenzt
  const dienste = ix.dienste || [];
  if (f.dienst && !dienste.some((d) => d.name === f.dienst)) f.dienst = "";
  const paketeDl = h("datalist", { id: "gs-pakete" }), klassenDl = h("datalist", { id: "gs-klassen" });
  const paketListe = () => paketeDl.replaceChildren(...dienste.filter((d) => !f.dienst || d.name === f.dienst).flatMap((d) => d.pakete)
    .map((p) => h("option", { value: p.name, label: p.anzahl ? t("{n} Lücken", { n: p.anzahl }) : "" })));
  const klassenListe = () => {
    const pa = f.paket.trim().toLowerCase();
    klassenDl.replaceChildren(...ix.klassen.filter((k) => (!f.dienst || k.dienst === f.dienst) && (!pa || (k.paket || "").toLowerCase().includes(pa)))
      .map((k) => h("option", { value: k.name, label: [k.dienst, k.anzahl ? t("{n} Lücken", { n: k.anzahl }) : ""].filter(Boolean).join(" · ") })));
  };
  paketListe(); klassenListe();
  const dienstWahl = h("select", { "aria-label": t("System/Microservice"), onchange: (e) => { f.dienst = e.target.value; paketListe(); klassenListe(); zeige(); } },
    h("option", { value: "", text: t("alle Systeme/Microservices") }),
    ...dienste.map((d) => h("option", { value: d.name, selected: d.name === f.dienst, text: `${d.name}${anzahlText(d.anzahl)}` })));
  const methoden = h("datalist", { id: "gs-methoden" });
  const methodenListe = () => {
    const kl = f.klasse.trim().toLowerCase();
    const ms = kl ? ix.klassen.filter((k) => k.name.toLowerCase() === kl || (k.name.toLowerCase().includes(kl) && kl.length > 2)).flatMap((k) => k.methoden) : [];
    methoden.replaceChildren(...[...new Map(ms.map((m) => [m.name, m])).values()].map((m) => h("option", { value: m.name, label: m.anzahl ? t("{n} Lücken", { n: m.anzahl }) : "" })));
  };
  methodenListe();
  const elementWahl = h("select", { "aria-label": t("Aktivität"), onchange: (e) => { f.element = e.target.value; zeige(); } });
  const elementListe = () => {
    const m = modelle[f.modell];
    elementWahl.disabled = !m;
    if (m && !m.elemente.some((e) => e.id === f.element)) f.element = "";
    elementWahl.replaceChildren(h("option", { value: "", text: m ? t("alle Elemente") : t("erst Prozess wählen") }),
      ...(m ? m.elemente : []).map((e) => h("option", { value: e.id, selected: e.id === f.element, text: `${e.name || e.id}${anzahlText(e.anzahl)}` })));
  };
  if (f.modell && !modelle[f.modell]) f.modell = "";
  elementListe();
  const modellWahl = h("select", { "aria-label": t("Prozess"), onchange: (e) => { f.modell = e.target.value; f.element = ""; elementListe(); zeige(); } },
    h("option", { value: "", text: t("alle Prozesse") }),
    ...["vorhanden", "abgeleitet"].map((art) => h("optgroup", { label: art === "vorhanden" ? t("vorhandenes BPMN (Code-Repository)") : t("abgeleitet aus dem Fachkonzept") },
      ...ix.modelle.filter((m) => m.art === art).map((m) => h("option", { value: m.key, selected: m.key === f.modell,
        text: `${m.name}${m.art === "vorhanden" ? " · " + m.datei.split("/").pop() : ""}${anzahlText(m.anzahl)}` })))));
  const typen = new Map();
  for (const x of state.gap.luecken || []) for (const r of gapTypen(x)) typen.set(r, (typen.get(r) || 0) + 1);
  if (f.typ && !typen.has(f.typ)) f.typ = "";
  const typWahl = h("select", { "aria-label": t("Lückentyp"), onchange: (e) => { f.typ = e.target.value; zeige(); } },
    h("option", { value: "", text: t("alle Lückentypen") }),
    ...[...typen.entries()].sort((a, b) => gapTypName(a[0]).localeCompare(gapTypName(b[0])))
      .map(([r, n]) => h("option", { value: r, selected: r === f.typ, text: `${gapTypName(r)} (${n})` })));
  const statusWahl = h("select", { "aria-label": t("Entscheidung"), onchange: (e) => { f.status = e.target.value; zeige(); } },
    h("option", { value: "", text: t("alle Entscheidungen") }),
    ...Object.entries(GAP_DEC()).map(([k, v]) => h("option", { value: k, selected: k === f.status, text: v })));
  const formular = h("div", { class: "card gap-such" },
    h("div", { class: "gap-such-zeile" },
      feld("text", t("Volltext"), t("Wörter aus dem Text der Anforderungen und Regeln oder der Lücke"), null, true)),
    h("div", { class: "gap-such-zeile" },
      feld("anf", t("Anforderung"), t("z. B. A-4.3 oder A-4.3-2"), "gs-anf"),
      feld("regel", t("Regel"), t("z. B. R-6"), "gs-regel")),
    h("div", { class: "gap-such-zeile" },
      h("label", { class: "gap-such-feld" }, h("span", { class: "small muted", text: t("Code: System/Microservice") }), dienstWahl),
      feld("paket", t("Package"), t("z. B. lending.patron oder Teil davon"), "gs-pakete")),
    h("div", { class: "gap-such-zeile" },
      feld("klasse", t("Klasse"), t("Name oder Teil davon"), "gs-klassen"),
      feld("methode", t("Methode (optional)"), t("Name oder Teil davon"), "gs-methoden")),
    h("div", { class: "gap-such-zeile" },
      h("label", { class: "gap-such-feld" }, h("span", { class: "small muted", text: t("BPMN: Prozess") }), modellWahl),
      h("label", { class: "gap-such-feld" }, h("span", { class: "small muted", text: t("Aktivität (optional)") }), elementWahl)),
    h("div", { class: "gap-such-zeile" },
      h("label", { class: "gap-such-feld" }, h("span", { class: "small muted", text: t("Lückentyp") }), typWahl),
      h("label", { class: "gap-such-feld" }, h("span", { class: "small muted", text: t("Entscheidung") }), statusWahl),
      h("div", { class: "gap-such-feld" }, h("span", { class: "small muted", text: "\u00a0" }),
        h("button", { type: "button", class: "small", onclick: () => { state.gapSuche = GAP_SUCHE_LEER(); renderGaps("suche"); } }, t("Felder leeren")))),
    liste("gs-anf", ix.anforderungen.map((a) => ({ id: a.id, label: `${a.anzahl ? t("{n} Lücken", { n: a.anzahl }) + " · " : ""}${a.text.slice(0, 80)}` }))),
    liste("gs-regel", ix.regeln.map((a) => ({ id: a.id, label: `${a.anzahl ? t("{n} Lücken", { n: a.anzahl }) + " · " : ""}${a.text.slice(0, 80)}` }))),
    paketeDl, klassenDl, methoden);
  const elName = (b) => { const m = modelle[b.modell]; const e = m && m.elemente.find((x) => x.id === b.element); return e ? e.name || e.id : b.element; };
  const zitat = (id) => {
    const s = ix.texte[id] || "";
    const w = gapNorm(f.text).split(/\s+/).filter(Boolean), n = gapNorm(s);
    const i = w.length ? Math.max(0, n.indexOf(w[0])) : 0;
    return [gapReqLink(id), `: „${i > 40 ? "…" : ""}${s.slice(Math.max(0, i - 40), i + 80)}${s.length > i + 80 ? "…" : ""}“`];
  };
  const grund = (r) => h("div", { class: "small muted gap-sub" }, t("Treffer: "), gapVerbinde([
    r.text ? gapVerbinde([...r.text.ids.map(zitat), ...(r.text.selbst ? [t("Titel bzw. Beschreibung der Lücke")] : [])], " · ") : null,
    r.anf.length || r.reg.length ? gapVerbinde([...r.anf, ...r.reg].map(gapReqLink), ", ") : null,
    r.code.length ? r.code.map((c) => `${c.dienst ? c.dienst + " › " : ""}${c.klasse}${c.methode ? "." + c.methode : ""}${c.fehlt ? " (" + t("fehlt") + ")" : ""}`).join(", ") : null,
    r.bpmn.length ? r.bpmn.map((b) => `${(modelle[b.modell] || {}).name || b.modell}${b.element ? " › " + elName(b) : ""}`).join(", ") : null]
    .filter((x) => x && (!Array.isArray(x) || x.length)), " · "));
  function zeige() {
    const leer = !f.text.trim() && !f.anf.trim() && !f.regel.trim() && !f.typ && !f.dienst && !f.paket.trim() && !f.klasse.trim() && !f.methode.trim() && !f.modell && !f.status;
    const ids = (state.gap.luecken || []).map((x) => x.id);
    const treffer = leer ? [] : ids.map((id) => [id, gapTreffer(id, f)]).filter(([, r]) => r);
    // Kopf: die gesuchte Anforderung bzw. Regel mit Text und Sprung ins Dokument
    const reqs = {};
    for (const k of (state.gapSichten || { oben: [] }).oben) for (const e of k.eintraege) reqs[e.id] = e;
    const kopf = [f.anf, f.regel].map((q) => q.trim()).filter((q) => reqs[q]).map((q) => gapReqLine(reqs[q], false));
    const imDokument = h("div", {});
    ergebnis.replaceChildren(...kopf,
      h("div", { class: "small", text: leer ? t("Mindestens ein Feld ausfüllen – die Felder werden UND-verknüpft.")
        : tp(treffer.length, "1 Lücke gefunden", "{n} Lücken gefunden") }),
      ...treffer.map(([id, r]) => h("div", { class: "gap-treffer" }, gapCodeOfGap(id), grund(r))), imDokument);
    if (f.text.trim()) volltextImDokument(f.text, imDokument, reqs);
  }
  // Volltext auch im Fachkonzept selbst: Anforderungen und Regeln ohne Lücke, Absätze mit Sprung ins Dokument
  function volltextImDokument(q, box, reqs) {
    const nr = (gapSuche.seq = (gapSuche.seq || 0) + 1);
    clearTimeout(gapSuche.tm);
    gapSuche.tm = setTimeout(async () => {
      let r;
      try { r = await api(`/api/luecken/volltext?${new URLSearchParams({ q })}`); } catch (e) { return; }
      if (nr !== gapSuche.seq) return;
      const w = gapNorm(q).split(/\s+/).filter(Boolean);
      const passt = (s) => { const n = gapNorm(s); return w.every((x) => n.includes(x)); };
      const ausschnitt = (s) => { const i = Math.max(0, gapNorm(s).indexOf(w[0])); return `${i > 60 ? "…" : ""}${s.slice(Math.max(0, i - 60), i + 160)}${s.length > i + 160 ? "…" : ""}`; };
      const eintraege = [...ix.anforderungen, ...ix.regeln].filter((a) => passt(`${a.id} ${a.text}`));
      box.replaceChildren(h("div", { class: "card" },
        h("h2", { text: t("Im Fachkonzept – auch ohne Lücke") }),
        h("div", { class: "small muted", text: t("{a} Anforderungen bzw. Regeln, {b} Absätze mit allen Wörtern", { a: eintraege.length, b: r.anzahl || 0 }) }),
        ...eintraege.map((a) => h("div", { class: "gap-treffer" }, reqs[a.id] ? gapReqLine(reqs[a.id], false) : h("div", { class: "small" }, h("strong", { class: "mono", text: a.id }), " ", a.text),
          h("div", { class: "small muted gap-sub", text: a.anzahl ? tp(a.anzahl, "1 Lücke", "{n} Lücken") : t("keine Lücke") }))),
        ...(r.treffer || []).map((b) => h("div", { class: "gap-treffer small" },
          h("span", { class: "muted", text: `${t("Abschnitt")} ${b.kapitel} ${b.titel} – ` }), ausschnitt(b.text), " ", gapDocLink(b.block, ausschnitt(b.text).replace(/^…|…$/g, "")))),
        r.mehr ? h("div", { class: "small muted", text: t("weitere Treffer – Suche eingrenzen") }) : null));
    }, 250);
  }
  zeige();
  return [formular, ergebnis];
}
// Von oben und von unten (common/luecken.py sichten): Kapitel → Anforderung/Regel → Lücke → Codestelle bzw. umgekehrt
// Sprung in die Quelltext-Ansicht (ganze Datei, kanonik.quelltext): art code (Code-Repository) oder schnittstelle (WSDL/XSD)
function quellLink(par, text) {
  if (STATIC || (par.art !== "schnittstelle" && state.config.readonly && !state.config.viewer)) return null;
  const q = new URLSearchParams(Object.entries(par).filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== 0));
  return h("a", { href: `/quelltext?${q}`, target: "_blank", rel: "noopener", class: "quell-link small", title: t("ganze Datei in der Quelltext-Ansicht") },
    text || t("ganze Datei ↗"));
}
const CODE_BELEG = /^([\w./\\-]+\.(?:java|bpmn|dmn|kt|groovy|xml|ya?ml|properties|json|ts|js|py)):\s*(.*)$/;
function belegZeile(b) {
  // Beleg „pfad/X.java: Klasse.methode …“: Text und Sprung in die ganze Datei (gesucht wird Klasse.methode bzw. das Element)
  const m = CODE_BELEG.exec(b || "");
  if (!m) return [b];
  const such = (m[2].match(/^[\w.$]+/) || [""])[0];
  return [b, " ", quellLink({ art: "code", datei: m[1], such })];
}
function gapDocLink(block, zitat) {
  const doc = block ? block.split(":")[0] : null;
  return hasDocling(doc) ? doclingLink({ el: block, q: (zitat || "").slice(0, 120) }, t("im Dokument")) : null;
}
function gapSectionLink(kap) {
  const doc = (state.gapSichten || {}).dokument;
  return kap && hasDocling(doc) ? doclingLink({ doc, section: kap }, t("Abschnitt im Dokument")) : null;
}
function gapCode(c) {
  // Codestelle: Knopf, der den Ausschnitt aus dem Code-Repository der Domäne lädt und mit Zeilennummern zeigt
  const box = h("div", { class: "gap-code" });
  const label = `${c.ziel || c.datei}${c.zeile ? ":" + c.zeile : ""}`;
  const btn = h("button", { type: "button", class: "small mono", title: c.datei, onclick: async () => {
    if (box.firstChild) { box.replaceChildren(); return; }
    let r;
    try { r = await api(`/api/luecken/code?${new URLSearchParams({ datei: c.datei, zeile: c.zeile || 0, such: c.such || "" })}`); }
    catch (e) { toast(e.message, true); return; }
    const pre = h("pre", { class: "code", tabindex: "0" }, ...r.zeilen.map((z, i) => h("div", {
      class: r.start + i === r.zeile ? "gap-code-hl" : "" }, h("span", { class: "muted", text: String(r.start + i).padStart(4) + "  " }), z)));
    box.replaceChildren(h("div", { class: "muted small mono" }, `${r.datei} (${r.gesamt} ${t("Zeilen")}) `,
      quellLink({ art: "code", datei: r.datei, zeile: r.zeile }, t("ganze Datei ↗"))), pre);
  } }, "⌨ " + label);
  // Ausschnitt: im Curator, in der Lese-Oberfläche und in der statischen Demo (dort vorab exportiert, tools/demo_lesen.py)
  const ausschnitt = (state.gapSichten || {}).code && (!state.config.readonly || state.config.viewer || STATIC);
  const github = c.url ? h("a", { href: c.url, target: "_blank", rel: "noopener", class: "quell-link small",
    title: t("Datei in der geprüften Fassung auf GitHub (Zeile markiert)"), text: t("auf GitHub ↗") }) : null;
  return h("span", { class: "code-stelle" }, ausschnitt ? btn : h("span", { class: "mono small", title: c.datei, text: label }),
    " ", quellLink({ art: "code", datei: c.datei, zeile: c.zeile, such: c.zeile ? "" : c.such || c.ziel }), " ", github, box);
}
function gapMini(id) {
  const x = (state.gapSichten || { luecken: {} }).luecken[id];
  if (!x) return h("div", { class: "muted small", text: id });
  const pill = { fehlt: "rel-rejected", abweichend: "rel-candidate", unvollstaendig: "rel-candidate" }[x.art] || "type";
  const full = (state.gap.luecken || []).find((y) => y.schluessel === x.schluessel) || x;
  return h("details", { class: "gap-mini" },
    h("summary", {}, h("span", { class: `pill ${pill}`, text: GAP_ART()[x.art] || x.art }), " ",
      h("span", { class: "pill type", text: x.sicht === "beide" ? t("BPMN und Code") : x.sicht === "schnittstelle" ? t("Schnittstelle") : x.sicht.toUpperCase() }), " ",
      ...gapTypPills(full).flatMap((p) => [p, " "]),
      h("strong", { text: `${x.id} · ${x.titel}` }), " ",
      (full.haengt_an || []).length ? h("span", { class: "pill type", title: t("Folgelücke von {k}", { k: full.haengt_an.join(", ") }), text: `↳ ${full.haengt_an.join(", ")}` }) : null, " ",
      h("span", { class: `pill ${full.entscheidung === "bestaetigt" ? "rel-confirmed" : full.entscheidung === "falsch" ? "rel-rejected" : "type"}`,
        text: GAP_DEC()[full.entscheidung] || full.entscheidung || "" })),
    gapCard(full, undefined, true));
}
function gapReqLine(e, mitLuecken) {
  return h("div", { class: "gap-req" },
    h("div", {}, h("span", { class: `pill ${e.art === "regel" ? "rel-candidate" : "type"}`, text: e.art === "regel" ? t("Regel") : e.art === "anforderung" ? t("Anforderung") : t("abgeleitet") }),
      " ", h("strong", { class: "mono", text: e.id }), e.grad ? h("span", { class: "muted small", text: ` ${e.grad.toUpperCase()}` }) : null,
      " ", e.text, " ", gapDocLink(e.block, e.zitat)),
    mitLuecken ? (e.luecken.length ? h("div", { class: "gap-sub" }, ...e.luecken.map(gapCodeOfGap))
      : h("div", { class: "muted small gap-sub", text: t("keine Lücke gefunden") })) : null);
}
function gapCodeOfGap(id) {
  const x = (state.gapSichten || { luecken: {} }).luecken[id] || { codestellen: [], dokumentstellen: [] };
  return h("div", {}, gapMini(id),
    x.codestellen.length ? h("div", { class: "gap-sub small" }, h("span", { class: "muted", text: t("Codestellen: ") }), ...x.codestellen.map(gapCode))
      : h("div", { class: "gap-sub muted small", text: t("keine Codestelle – fehlt im Code bzw. nur im BPMN") }),
    x.dokumentstellen.length ? h("div", { class: "gap-sub small" }, h("span", { class: "muted", text: t("Abschnitte: ") }),
      ...x.dokumentstellen.map((d) => h("span", {}, `${d.kapitel} ${d.titel} – ${d.text} `, gapSectionLink(d.kapitel)))) : null);
}
function gapOben() {
  const s = state.gapSichten;
  if (!s) return [];
  const nurMit = state.gapNurMit !== false;
  const schalter = h("label", { class: "small" }, h("input", { type: "checkbox", checked: nurMit,
    onchange: (ev) => { state.gapNurMit = ev.target.checked; renderGaps("oben"); } }), " " + t("nur Kapitel und Einträge mit Lücke"));
  const karten = s.oben.filter((k) => !nurMit || k.mit_luecke).map((k) => h("details", { class: "card", open: k.mit_luecke > 0 },
    h("summary", {}, `${k.kapitel} ${k.titel}`, h("span", { class: "muted small", text: `  ${t("{n} Einträge, {m} mit Lücke", { n: k.anzahl, m: k.mit_luecke })}` })),
    h("div", { class: "summary-aktionen small" }, gapSectionLink(k.kapitel)),
    ...k.eintraege.filter((e) => !nurMit || e.luecken.length).map((e) => gapReqLine(e, true))));
  if (s.ohne_bezug.length) karten.push(h("details", { class: "card", open: true },
    h("summary", { text: t("Ohne Bezug zu einer Anforderung oder Regel ({n})", { n: s.ohne_bezug.length }) }), ...s.ohne_bezug.map(gapCodeOfGap)));
  return [schalter, ...karten];
}
function gapUnten() {
  const s = state.gapSichten;
  if (!s) return [];
  const reqs = {};
  for (const k of s.oben) for (const e of k.eintraege) reqs[e.id] = e;
  const anf = (id) => {
    const x = s.luecken[id] || { anforderungen: [], dokumentstellen: [] };
    return h("div", { class: "gap-sub" }, gapMini(id),
      ...x.anforderungen.map((a) => reqs[a] ? h("div", { class: "gap-sub small" }, gapReqLine(reqs[a], false),
        h("span", { class: "muted", text: `${t("Abschnitt")} ${reqs[a].kapitel} ` }), gapSectionLink(reqs[a].kapitel)) : h("div", { class: "gap-sub small mono", text: a })),
      ...x.dokumentstellen.map((d) => h("div", { class: "gap-sub small" }, `${t("Abschnitt")} ${d.kapitel} ${d.titel} – ${d.text} `, gapSectionLink(d.kapitel))));
  };
  const karten = s.unten.map((d) => h("details", { class: "card", open: true },
    h("summary", {}, d.dienst, h("span", { class: "muted small", text: `  ${t("{n} Dateien", { n: d.dateien.length })}` })),
    ...d.dateien.map((f) => h("div", { class: "gap-file" }, h("div", { class: "mono small" }, f.datei, " ", quellLink({ art: "code", datei: f.datei })),
      ...f.stellen.map((st) => h("div", { class: "gap-sub" }, gapCode({ ...st, datei: f.datei }), ...st.luecken.map(anf)))))));
  if (s.ohne_code.length) karten.push(h("details", { class: "card", open: true },
    h("summary", { text: t("Ohne Codestelle: im Code fehlend oder nur im BPMN ({n})", { n: s.ohne_code.length }) }), ...s.ohne_code.map(anf)));
  return karten;
}
// Anforderungen und Regeln je System/Microservice, Package und Klasse (abgleich/zuordnung.py, heuristisch)
// ------------------------------------------------------------------ Architektur (ArchiMate, kanonik/archimate_sicht.py)
const AM_SCHICHT = () => ({ Strategy: t("Strategie"), Business: t("Geschäft"), Application: t("Anwendung"), Technology: t("Technologie"),
  Physical: t("Physisch"), ImplementationMigration: t("Umsetzung und Migration"), Motivation: t("Motivation"), Other: t("Übergreifend") });
const AM_ASPEKT = () => ({ ActiveStructure: t("Aktive Struktur"), Behavior: t("Verhalten"), PassiveStructure: t("Passive Struktur"),
  Motivation: t("Motivation"), Composite: t("Zusammensetzung") });
const AM_OHNE = "__ohne__";
const AM_ZWECK = () => ({ "model.xml": t("für Archi und andere ArchiMate-Werkzeuge (Datei → Importieren → Open Exchange XML Model)"),
  "model.ttl": t("für Triple-Stores und Ontologie-Werkzeuge"), "model.json": t("für eigene Auswertungen"),
  "load.cypher": t("für Neo4j: in den Graphen der Domäne laden") });
async function amHerunterladen(name) {
  try {
    const r = await fetch(`/api/archimate/datei?${new URLSearchParams({ name })}`);
    if (!r.ok) throw new Error(t("Datei nicht verfügbar: {f}", { f: name }));
    const a = h("a", { href: URL.createObjectURL(await r.blob()), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  } catch (e) { toast(e.message, true); }
}
function amAuswahl(m) {
  const f = state.amFilter;
  const q = (f.text || "").trim().toLowerCase();
  return m.elemente.filter((e) => e.typ !== "Grouping" && f.schichten.has(e.schicht)
    && (f.domaene === "" || (f.domaene === AM_OHNE ? !e.domaenen.length : e.domaenen.includes(f.domaene)))
    && (!q || e.name.toLowerCase().includes(q) || e.typ.toLowerCase().includes(q)));
}
function amDiagramm(m, els) {
  // Breite wie der Platz im Detailbereich (Schrift 1:1 lesbar), schmal: waagrecht scrollen
  const W = Math.max(720, Math.min(1800, (($("detail") || {}).clientWidth || 1200) - 80)), L = 110, BW = 150, BH = 40, G = 10, PAD = 14;
  const proZeile = Math.max(1, Math.floor((W - L - PAD) / (BW + G)));
  const ord = (a) => Math.max(0, m.aspekte.indexOf(a));
  const pos = {}, baender = [];
  let y = 0;
  for (const s of m.schichten.map((x) => x.id)) {
    const xs = els.filter((e) => e.schicht === s).sort((a, b) => ord(a.aspekt) - ord(b.aspekt) || a.typ.localeCompare(b.typ) || a.name.localeCompare(b.name));
    if (!xs.length) continue;
    const zeilen = Math.ceil(xs.length / proZeile), hoehe = zeilen * (BH + G) + PAD * 2 - G;
    baender.push({ s, y, hoehe, n: xs.length });
    xs.forEach((e, i) => { pos[e.id] = { x: L + PAD + (i % proZeile) * (BW + G), y: y + PAD + Math.floor(i / proZeile) * (BH + G), e }; });
    y += hoehe + 6;
  }
  if (!baender.length) return h("div", { class: "muted small", text: t("Keine Elemente für diese Auswahl.") });
  const svg = svgRoot(W, y, t("ArchiMate-Diagramm nach Schichten"));
  svg.setAttribute("class", "mm-svg am-svg");
  const namen = AM_SCHICHT();
  for (const b of baender) {
    svg.append(sv("rect", { x: 0, y: b.y, width: W, height: b.hoehe, rx: 8, class: `am-band am-${b.s}` }));
    svg.append(sv("text", { x: 10, y: b.y + 20, class: "am-band-titel" }, namen[b.s] || b.s));
    svg.append(sv("text", { x: 10, y: b.y + 36, class: "am-band-zahl" }, String(b.n)));
  }
  const kanten = sv("g", { class: "am-kanten" });
  const zeigen = state.amFilter.assoziation;
  for (const r of m.beziehungen) {
    const a = pos[r.quelle], b = pos[r.ziel];
    if (!a || !b || r.quelle === r.ziel || (!zeigen && r.typ === "Association")) continue;
    const ln = sv("line", { x1: a.x + BW / 2, y1: a.y + BH / 2, x2: b.x + BW / 2, y2: b.y + BH / 2, class: `am-kante am-k-${r.typ}`, "data-quelle": r.quelle, "data-ziel": r.ziel });
    ln.append(sv("title", {}, `${a.e.name} —${r.typ}→ ${b.e.name}`));
    kanten.append(ln);
  }
  svg.append(kanten);
  for (const p of Object.values(pos)) {
    const e = p.e;
    const g = sv("g", { class: `am-el am-${e.schicht}${e.knoten ? " am-link" : ""}`, tabindex: e.knoten ? "0" : "-1",
      role: e.knoten ? "link" : "img", "aria-label": `${e.name} (${e.typ})` });
    g.append(sv("title", {}, `${e.name}\n${e.typ} · ${AM_ASPEKT()[e.aspekt] || e.aspekt}${e.beschreibung ? "\n" + e.beschreibung : ""}`));
    g.append(sv("rect", { x: p.x, y: p.y, width: BW, height: BH, rx: e.aspekt === "Behavior" ? 12 : 3, class: "am-box" }));
    g.append(sv("text", { x: p.x + 6, y: p.y + 12, class: "am-typ" }, e.typ));
    const n = e.name.length > 23 ? e.name.slice(0, 22) + "…" : e.name;
    g.append(sv("text", { x: p.x + 6, y: p.y + 29, class: "am-name" }, n));
    const hl = (an) => kanten.querySelectorAll(`[data-quelle="${CSS.escape(e.id)}"],[data-ziel="${CSS.escape(e.id)}"]`).forEach((l) => l.classList.toggle("am-aktiv", an));
    g.addEventListener("mouseenter", () => hl(true)); g.addEventListener("mouseleave", () => hl(false));
    g.addEventListener("focus", () => hl(true)); g.addEventListener("blur", () => hl(false));
    if (e.knoten) {
      g.addEventListener("click", () => openNode(e.knoten));
      g.addEventListener("keydown", (ev) => { if (ev.key === "Enter") openNode(e.knoten); });
    }
    svg.append(g);
  }
  return h("div", { class: "am-diagramm" }, svg);
}
function gapArchitektur() {
  if (!state.archimate) {
    api("/api/archimate").then((r) => { state.archimate = r; if (state.gapCat === "architektur") renderGaps("architektur"); })
      .catch((e) => toast(e.message, true));
    return [h("div", { class: "muted small", text: t("ArchiMate-Modell wird geladen …") })];
  }
  const m = state.archimate;
  if (!m.verfuegbar) return [h("div", { class: "card muted", text: t("Noch kein ArchiMate-Modell – python make_out.py --only archimate") })];
  const namen = AM_SCHICHT();
  if (!state.amFilter) {
    const viele = m.elemente.length > 120;               // Motivation (Anforderungen, Einschränkungen) zuerst ausgeblendet
    state.amFilter = { domaene: "", text: "", assoziation: false,
      schichten: new Set(m.schichten.map((s) => s.id).filter((s) => !(viele && s === "Motivation"))) };
  }
  const f = state.amFilter, neu = () => renderGaps("architektur");
  const zahl = (wert, text) => h("div", { class: "sb-zahl" }, h("strong", { text: String(wert) }), h("span", { class: "muted small", text }));
  const zahlen = h("div", { class: "sb-zahlen" }, zahl(m.zahlen.elemente, t("Elemente")), zahl(m.zahlen.beziehungen, t("Beziehungen")),
    zahl(m.zahlen.typen, t("Elementtypen")), zahl(m.domaenen.length, t("Fachdomänen")),
    ...m.schichten.map((s) => zahl(s.elemente, namen[s.id] || s.id)));
  const laden = h("section", { class: "card sb-karte" }, h("h2", { text: t("Modell laden") }),
    h("p", { class: "small", text: t("Das Modell lässt sich in ein ArchiMate-Werkzeug laden, z. B. Archi: Datei → Importieren → „Open Exchange XML Model“, dann model.xml wählen. Die Sichten je Fachdomäne sind enthalten.") }),
    h("ul", { class: "am-dateien" }, ...m.dateien.map((d) => h("li", {},
      h("button", { type: "button", onclick: () => amHerunterladen(d.name), text: t("{f} herunterladen", { f: d.name }) }),
      h("span", { class: "small" }, ` ${d.format} · ${Math.max(1, Math.round(d.bytes / 1024))} KB · `),
      h("span", { class: "muted small", text: AM_ZWECK()[d.name] || "" })))));
  const sel = h("select", { "aria-label": t("Fachdomäne"), onchange: (e) => { f.domaene = e.target.value; neu(); } },
    h("option", { value: "", text: t("alle Fachdomänen") }),
    ...m.domaenen.map((d) => h("option", { value: d.id, text: `${d.name} (${d.elemente})` })),
    h("option", { value: AM_OHNE, text: t("ohne Fachdomäne") }));
  sel.value = f.domaene;
  const suche = h("input", { type: "search", value: f.text, placeholder: t("Element oder Typ filtern"), "aria-label": t("Element oder Typ filtern"),
    onchange: (e) => { f.text = e.target.value; neu(); } });
  const schalter = m.schichten.map((s) => h("label", { class: "small am-schalter" },
    h("input", { type: "checkbox", checked: f.schichten.has(s.id), onchange: (e) => { e.target.checked ? f.schichten.add(s.id) : f.schichten.delete(s.id); neu(); } }),
    ` ${namen[s.id] || s.id} (${s.elemente})`));
  const asso = h("label", { class: "small am-schalter" }, h("input", { type: "checkbox", checked: f.assoziation, onchange: (e) => { f.assoziation = e.target.checked; neu(); } }),
    ` ${t("Assoziationen zeigen")}`);
  const els = amAuswahl(m);
  const diag = h("section", { class: "card sb-karte" }, h("h2", { text: t("Diagramm nach Schichten") }),
    h("div", { class: "am-filter" }, sel, suche, ...schalter, asso),
    h("div", { class: "muted small", text: t("{n} Elemente · Zeiger auf ein Element hebt seine Beziehungen hervor; Klick öffnet den Knoten im Graphen.", { n: els.length }) }),
    amDiagramm(m, els),
    m.leere_schichten.length ? h("div", { class: "muted small", text: t("Ohne Elemente: {s}", { s: m.leere_schichten.map((s) => namen[s] || s).join(", ") }) }) : null);
  const dn = Object.fromEntries(m.domaenen.map((d) => [d.id, d.name]));
  const liste = h("details", { class: "card sb-karte" }, h("summary", {}, h("strong", { text: t("Elemente als Liste") }), ` (${els.length})`),
    h("div", { class: "tabelle" }, h("table", { class: "small" },
      h("thead", {}, h("tr", {}, ...[t("Element"), t("Typ"), t("Schicht"), t("Fachdomäne"), t("Kapitel")].map((x) => h("th", { text: x })))),
      h("tbody", {}, ...els.map((e) => h("tr", {},
        h("td", {}, e.knoten ? h("a", { href: nodeHash(e.knoten), text: e.name, onclick: (ev) => { ev.preventDefault(); openNode(e.knoten); } }) : e.name),
        h("td", { class: "mono", text: e.typ }), h("td", { text: namen[e.schicht] || e.schicht }),
        h("td", { text: e.domaenen.map((d) => dn[d] || d).join(", ") || "–" }), h("td", { text: e.kapitel.join(", ") || "–" })))))));
  return [h("div", { class: "muted small", text: t("Stand {s}", { s: m.stand }) }), zahlen, diag, laden, liste];
}
// ------------------------------------------------------------------ Traceability-Matrix (UC13, kanonik/traceability.py)
const TR_STUFE = () => ({ beleg: t("Belegstelle"), regel: t("Regel"), prozess: t("Prozess"), schnittstelle: t("Nachricht"), code: t("Klasse"), test: t("Test") });
function trCsv(m, zeilen) {
  const kopf = [t("Kennung"), t("Art"), t("Kapitel"), t("Text"), t("Belegstelle"), t("Regeln"), t("Prozess"), t("vorhandenes BPMN"),
    t("Nachricht"), t("Klasse"), t("Test"), t("Lücken"), t("Kette")];
  const feld = (s) => { s = String(s ?? ""); return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const reihe = (z) => [z.id, z.art === "regel" ? t("Regel") : t("Anforderung"), z.kapitel, z.text, z.belege.map((b) => b.block).join(", "),
    z.regeln.concat(z.lokale_regeln).join(", "), z.prozesse.map((p) => (p.element ? `${p.prozess} › ${p.element}` : `${p.prozess} (${t("Kapitel")})`)).join(", "),
    z.prozesse.filter((p) => p.vorhanden).map((p) => p.vorhanden).join(", "), z.nachrichten.map((n) => n.name).join(", "),
    z.klassen.map((k) => `${k.dienst}: ${k.klasse}`).join(", "), z.tests.map((x) => x.klasse).join(", "), z.luecken.map((x) => x.id).join(", "),
    m.stufen.map((s) => (z.stufen[s] ? "✓" : "·")).join("")];
  return "﻿" + [kopf, ...zeilen.map(reihe)].map((r) => r.map(feld).join(";")).join("\r\n") + "\r\n";
}
function trListe(xs, text, titel) {
  if (!xs.length) return h("span", { class: "muted", text: "–" });
  const zeig = xs.slice(0, 3);
  return h("div", { class: "tr-liste" }, ...zeig.map((x) => h("div", { title: titel ? titel(x) : null }, text(x))),
    xs.length > 3 ? h("div", { class: "muted", title: xs.slice(3).map(text).join("\n"), text: t("+{n} weitere", { n: xs.length - 3 }) }) : null);
}
function gapMatrix() {
  if (!state.trMatrix) {
    api("/api/traceability").then((r) => { state.trMatrix = r; if (state.gapCat === "matrix") renderGaps("matrix"); })
      .catch((e) => toast(e.message, true));
    return [h("div", { class: "muted small", text: t("Matrix wird geladen …") })];
  }
  const m = state.trMatrix, f = (state.trFilter ||= { text: "", art: "", kapitel: "", luecke: "" }), neu = () => renderGaps("matrix");
  const st = TR_STUFE(), n = m.zahlen.zeilen || 0;
  const zahl = (wert, text) => h("div", { class: "sb-zahl" }, h("strong", { text: String(wert) }), h("span", { class: "muted small", text }));
  const zahlen = h("div", { class: "sb-zahlen" }, zahl(m.zahlen.anforderungen, t("Anforderungen")), zahl(m.zahlen.regeln, t("Regeln")),
    ...m.stufen.map((s) => zahl(`${m.zahlen[s]}/${n}`, t("mit {s}", { s: st[s] }))), zahl(m.zahlen.mit_luecke, t("mit Lücke")));
  const kapitel = [...new Set(m.zeilen.map((z) => z.kapitel.split(".")[0]).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const q = f.text.trim().toLowerCase();
  const genutzt = m.stufen.filter((s) => m.zahlen[s] > 0);   // Stufen ohne jeden Eintrag (z. B. keine Tests) zählen nicht als Lücke
  const zeilen = m.zeilen.filter((z) => (!f.art || z.art === f.art) && (!f.kapitel || z.kapitel === f.kapitel || z.kapitel.startsWith(f.kapitel + "."))
    && (!f.luecke || (f.luecke === "kette" ? genutzt.some((s) => !z.stufen[s]) : f.luecke === "ohne_code" ? !z.stufen.code : z.luecken.length))
    && (!q || [z.id, z.text, ...z.klassen.map((k) => k.klasse), ...z.nachrichten.map((x) => x.name), ...z.prozesse.map((p) => p.prozess)].join(" ").toLowerCase().includes(q)));
  const wahl = (wert, setzen, label, ...opts) => { const s = h("select", { "aria-label": label, onchange: (e) => { setzen(e.target.value); neu(); } },
    ...opts.map(([v, x]) => h("option", { value: v, text: x }))); s.value = wert; return s; };
  const filter = h("div", { class: "am-filter" },
    h("input", { type: "search", value: f.text, placeholder: t("Kennung, Text, Klasse, Nachricht …"), "aria-label": t("Matrix filtern"), onchange: (e) => { f.text = e.target.value; neu(); } }),
    wahl(f.art, (v) => { f.art = v; }, t("Art"), ["", t("Anforderungen und Regeln")], ["anforderung", t("nur Anforderungen")], ["regel", t("nur Regeln")]),
    wahl(f.kapitel, (v) => { f.kapitel = v; }, t("Kapitel"), ["", t("alle Kapitel")], ...kapitel.map((k) => [k, t("Kapitel {k}", { k })])),
    wahl(f.luecke, (v) => { f.luecke = v; }, t("Auswahl"), ["", t("alle Einträge")], ["kette", t("Kette unvollständig")], ["ohne_code", t("ohne Klasse")], ["luecke", t("mit Lücke")]),
    h("button", { type: "button", onclick: () => {
      const a = h("a", { href: URL.createObjectURL(new Blob([trCsv(m, zeilen)], { type: "text/csv;charset=utf-8" })), download: "traceability.csv" });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    }, text: t("Als CSV herunterladen (Excel)") }));
  const kette = (z) => h("span", { class: "tr-kette", "aria-label": m.stufen.map((s) => `${st[s]}: ${z.stufen[s] ? t("ja") : t("nein")}`).join(", ") },
    ...m.stufen.map((s) => h("span", { class: z.stufen[s] ? "tr-ja" : "tr-nein", title: `${st[s]}: ${z.stufen[s] ? t("ja") : t("nein")}`, text: z.stufen[s] ? "●" : "○" })));
  const viaText = { anforderung: t("nennt die Anforderung"), aktivitaet: t("setzt die Aktivität um"), regel: t("prüft eine Regel des Kapitels"), kapitel: t("Prozess des Kapitels") };
  const tab = h("div", { class: "tabelle tr-tabelle" }, h("table", { class: "small" },
    h("thead", {}, h("tr", {}, ...[t("Kennung"), t("Kette"), t("Text"), t("Regeln"), t("Prozess"), t("Nachricht"), t("Klasse"), t("Test"), t("Lücken")]
      .map((x) => h("th", { scope: "col", text: x })))),
    h("tbody", {}, ...zeilen.map((z) => h("tr", {},
      h("td", { class: "mono" }, gapReqLink(z.id), " ", h("button", { type: "button", class: "imp-start", title: t("Auswirkungen einer Änderung"),
        "aria-label": t("Auswirkungen einer Änderung von {x}", { x: z.id }), onclick: () => zuImpact((z.art === "regel" ? "regel:" : "anf:") + z.id), text: "⇢" })),
      h("td", {}, kette(z)),
      h("td", { class: "tr-text", title: z.text, text: z.text.length > 140 ? z.text.slice(0, 139) + "…" : z.text }),
      h("td", {}, trListe(z.regeln.concat(z.lokale_regeln), (x) => x)),
      h("td", {}, trListe(z.prozesse, (p) => (p.element ? `${p.prozess} › ${p.element}` : `${p.prozess} (${t("Kapitel")})`),
        (p) => `${viaText[p.via] || p.via}${p.vorhanden ? "\n" + t("vorhanden: {v}", { v: p.vorhanden }) : ""}`)),
      h("td", {}, trListe(z.nachrichten, (x) => x.name, (x) => `${x.titel || ""} (${x.absender || "?"} → ${(x.empfaenger || []).join(", ")})${x.code ? "\n" + t("im Code gesendet") : ""}`)),
      h("td", {}, trListe(z.klassen, (k) => k.klasse, (k) => `${k.dienst} · ${k.paket || ""}\n${(k.gruende || []).join("; ")}`)),
      h("td", {}, trListe(z.tests, (x) => x.klasse, (x) => `${t("{n} Testfälle", { n: x.testfaelle })}\n${(x.beispiele || []).join("\n")}`)),
      h("td", {}, z.luecken.length ? h("div", { class: "tr-liste" }, ...z.luecken.map((x) => h("a", { href: "#", title: x.titel, text: x.id,
        onclick: (e) => { e.preventDefault(); zuAnsicht("gap", "suche"); } }))) : h("span", { class: "muted", text: "–" })))))));
  return [zahlen, h("section", { class: "card sb-karte" }, filter,
    h("div", { class: "muted small", text: t("{n} von {g} Einträgen · Zuordnung zu Klassen und Tests heuristisch (Begriffe, Domänenmodell, Nachrichten); Zeiger auf eine Zelle zeigt Grund und Rest.", { n: zeilen.length, g: n }) }),
    tab)];
}
// ------------------------------------------------------------------ Impact Analysis (UC6, kanonik/impact.py; Suche im Browser)
const IMP_ART = () => ({ anforderung: t("Anforderungen"), regel: t("Regeln"), begriff: t("Begriffe"), nachricht: t("Nachrichten"),
  prozess: t("Prozesselemente"), klasse: t("Klassen"), test: t("Tests"), luecke: t("Lücken") });
const IMP_BLATT = new Set(["test", "luecke"]);          // Endpunkte: nicht weiter verfolgen
function impNachbarn(g) {
  if (state.impAdj && state.impAdj.g === g) return state.impAdj.m;
  const m = {};
  const add = (x, y, k) => (m[x] ||= []).push({ n: y, k });
  for (const k of g.kanten) { add(k.b, k.a, k); if (!k.gerichtet) add(k.a, k.b, k); }   // gerichtet: ändert sich b, ist a betroffen
  state.impAdj = { g, m };
  return m;
}
function impSuchen(g, start, tiefe) {
  const nb = impNachbarn(g), seen = { [start]: { d: 0 } }, q = [start];
  while (q.length) {
    const x = q.shift(), s = seen[x], art = (g.knoten[x] || {}).art;
    if (s.d >= tiefe || (x !== start && (art === "begriff" || IMP_BLATT.has(art)))) continue;   // Begriffe nur vom Start aus
    for (const { n, k } of nb[x] || []) if (!seen[n]) { seen[n] = { d: s.d + 1, vor: x, k }; q.push(n); }
  }
  delete seen[start];
  return seen;
}
function impWeg(g, seen, key) {
  const schritte = [];
  for (let x = key; seen[x] && seen[x].vor !== undefined; x = seen[x].vor) schritte.unshift({ von: seen[x].vor, nach: x, grund: seen[x].k.grund });
  return schritte;
}
function impName(g, key) { const n = g.knoten[key] || {}; return n.name || key; }
function zuImpact(key) { state.impStart = key; zuAnsicht("gap", "impact"); if (state.gapCat === "impact") renderGaps("impact"); }
function gapImpact() {
  if (!state.impGraph) {
    api("/api/impact/graph").then((r) => { state.impGraph = r; if (state.gapCat === "impact") renderGaps("impact"); })
      .catch((e) => toast(e.message, true));
    return [h("div", { class: "muted small", text: t("Wirkungsgraph wird geladen …") })];
  }
  const g = state.impGraph, arten = IMP_ART(), tiefe = state.impTiefe || 2;
  const startbar = Object.entries(g.knoten).filter(([, n]) => ["anforderung", "regel", "begriff", "nachricht", "klasse", "prozess"].includes(n.art));
  const label = (k, n) => `${n.name}${n.text && n.art !== "nachricht" ? " – " + n.text.slice(0, 80) : n.text ? " – " + n.text : ""} (${arten[n.art] || n.art})`;
  const je = Object.fromEntries(startbar.map(([k, n]) => [label(k, n), k]));
  const liste = h("datalist", { id: "imp-liste" }, ...startbar.slice(0, 3000).map(([k, n]) => h("option", { value: label(k, n) })));
  const feld = h("input", { type: "search", list: "imp-liste", class: "imp-feld", placeholder: t("Anforderung, Regel, Begriff, Nachricht oder Klasse …"),
    "aria-label": t("Ausgangspunkt der Änderung"), value: state.impStart && g.knoten[state.impStart] ? label(state.impStart, g.knoten[state.impStart]) : "",
    onchange: (e) => { const k = je[e.target.value]; if (k) { state.impStart = k; renderGaps("impact"); } } });
  const tf = h("select", { "aria-label": t("Tiefe"), onchange: (e) => { state.impTiefe = Number(e.target.value); renderGaps("impact"); } },
    ...[1, 2, 3].map((d) => h("option", { value: String(d), text: t("Tiefe {d}", { d }) })));
  tf.value = String(tiefe);
  const kopf = h("section", { class: "card sb-karte" }, h("div", { class: "am-filter" }, feld, liste, tf),
    h("div", { class: "muted small", text: t("Wirkungen über Zuordnungen des Fachkonzepts, des abgeleiteten BPMN und des Codes (Nachrichten, Aufrufe, Tests); Klassen und Tests heuristisch zugeordnet. Begriffe wirken nur als Ausgangspunkt.") }));
  const s = state.impStart;
  if (!s || !g.knoten[s]) return [kopf, h("div", { class: "card muted", text: t("Ausgangspunkt wählen – oder in der Traceability-Matrix bei einer Kennung auf ⇢ klicken.") })];
  const n0 = g.knoten[s], seen = impSuchen(g, s, tiefe);
  const treffer = Object.keys(seen);
  const zahl = (wert, text) => h("div", { class: "sb-zahl" }, h("strong", { text: String(wert) }), h("span", { class: "muted small", text }));
  const zahlen = h("div", { class: "sb-zahlen" }, ...g.arten.map((a) => [a, treffer.filter((k) => g.knoten[k].art === a).length])
    .filter(([, c]) => c).map(([a, c]) => zahl(c, arten[a])));
  const startKarte = h("section", { class: "card sb-karte" }, h("h2", { text: t("Wenn sich {x} ändert …", { x: n0.name }) }),
    n0.text ? h("p", { class: "small", text: n0.text }) : null,
    h("div", { class: "muted small", text: t("{n} betroffene Einträge bis Tiefe {d}", { n: treffer.length, d: tiefe }) }));
  const name = (k) => {
    const n = g.knoten[k];
    if (n.art === "anforderung" || n.art === "regel") return gapReqLink(n.name);
    if (n.art === "luecke") return h("a", { href: "#", text: n.name, onclick: (e) => { e.preventDefault(); zuAnsicht("gap", "suche"); } });
    return h("span", { class: n.art === "klasse" || n.art === "test" || n.art === "nachricht" ? "mono" : "", text: n.name });
  };
  const gruppen = g.arten.map((a) => [a, treffer.filter((k) => g.knoten[k].art === a).sort((x, y) => seen[x].d - seen[y].d || impName(g, x).localeCompare(impName(g, y)))])
    .filter(([, xs]) => xs.length).map(([a, xs]) => h("details", { class: "card sb-karte", open: xs.length <= 25 },
      h("summary", {}, h("strong", { text: arten[a] }), ` (${xs.length})`),
      h("div", { class: "tabelle" }, h("table", { class: "small" },
        h("thead", {}, h("tr", {}, ...[t("Eintrag"), t("Stufe"), t("Weg und Grund"), ""].map((x) => h("th", { scope: "col", text: x })))),
        h("tbody", {}, ...xs.map((k) => {
          const n = g.knoten[k], weg = impWeg(g, seen, k);
          return h("tr", {},
            h("td", {}, name(k), n.text && n.art !== "anforderung" && n.art !== "regel" ? h("div", { class: "muted", text: n.text.slice(0, 120) }) : null,
              n.dienst ? h("div", { class: "muted", text: n.dienst }) : null),
            h("td", { text: String(seen[k].d) }),
            h("td", {}, h("div", { class: "imp-weg" }, ...weg.map((w, i) => h("div", {},
              h("span", { class: "muted", text: i === 0 ? "" : "→ " }), h("span", { text: impName(g, w.nach) }),
              h("span", { class: "muted", text: ` · ${w.grund}` }))))),
            h("td", {}, ["anforderung", "regel", "begriff", "nachricht", "klasse", "prozess"].includes(n.art)
              ? h("button", { type: "button", class: "imp-start", title: t("Als Ausgangspunkt nehmen"), "aria-label": t("{x} als Ausgangspunkt nehmen", { x: n.name }),
                onclick: () => zuImpact(k), text: "⇢" }) : null));
        }))))));
  return [kopf, startKarte, zahlen, ...gruppen];
}
// ------------------------------------------------------------------ Abdeckung (F11, kanonik/abdeckung.py)
const AB_ART = () => ({ Service: t("Dienste"), Operation: t("Operationen"), Message: t("Nachrichten"), Field: t("Felder"), DataElement: t("Datenelemente") });
function gapAbdeckung() {
  if (!state.abdeckung) {
    api("/api/abdeckung").then((r) => { state.abdeckung = r; if (state.gapCat === "abdeckung") renderGaps("abdeckung"); })
      .catch((e) => toast(e.message, true));
    return [h("div", { class: "muted small", text: t("Abdeckung wird berechnet …") })];
  }
  const m = state.abdeckung, z = m.zahlen, arten = AB_ART();
  const pz = (a, b) => (b ? `${Math.round((100 * a) / b)} %` : "–");
  const zahl = (wert, text) => h("div", { class: "sb-zahl" }, h("strong", { text: String(wert) }), h("span", { class: "muted small", text }));
  const zahlen = h("div", { class: "sb-zahlen" },
    zahl(`${z.bloecke_verknuepft}/${z.bloecke}`, t("Textblöcke verknüpft ({p})", { p: pz(z.bloecke_verknuepft, z.bloecke) })),
    ...Object.entries(m.schnittstelle.arten).map(([a, x]) => zahl(`${x.verknuepft}/${x.gesamt}`, t("{a} verknüpft", { a: arten[a] || a }))));
  const blockLink = (doc, b) => (hasDocling(doc) ? h("a", { class: "link docling-link", href: doclingUrl({ el: b.block, q: b.text.slice(0, 120) }),
    target: "docling", rel: "noopener", text: "📄" }) : null);
  const offenZelle = (d, k) => {
    if (!k.offen.length) return h("span", { class: "muted", text: "–" });
    const zeilen = k.offen.slice(0, 6).map((b) => h("div", { title: b.text }, blockLink(d.doc, b), " ",
      h("span", { class: "muted", text: `${b.art || ""}: ` }), b.text.length > 110 ? b.text.slice(0, 109) + "…" : b.text));
    if (k.offen.length > 6) zeilen.push(h("div", { class: "muted", text: t("+{n} weitere", { n: k.offen.length - 6 }) }));
    return h("div", { class: "tr-liste" }, ...zeilen);
  };
  const kapZeile = (d, k) => h("tr", {}, h("td", { text: `${k.nummer} ${k.titel || ""}` }), h("td", { text: String(k.bloecke) }),
    h("td", { class: k.verknuepft < k.bloecke ? "tr-nein" : "tr-ja", text: `${k.verknuepft} (${pz(k.verknuepft, k.bloecke)})` }),
    h("td", {}, offenZelle(d, k)));
  const kopfAb = h("thead", {}, h("tr", {}, ...[t("Kapitel"), t("Blöcke"), t("verknüpft"), t("nicht verknüpft")].map((x) => h("th", { scope: "col", text: x }))));
  const doks = m.dokumente.map((d) => h("section", { class: "card sb-karte" }, h("h2", { text: `${d.titel} – ${pz(d.verknuepft, d.bloecke)}` }),
    h("div", { class: "tabelle" }, h("table", { class: "small" }, kopfAb.cloneNode(true), h("tbody", {}, ...d.kapitel.map((k) => kapZeile(d, k)))))));
  const s = m.schnittstelle;
  const nachr = h("section", { class: "card sb-karte" }, h("h2", { text: t("Schnittstelle: Nachrichten und Felder") }),
    h("div", { class: "muted small", text: t("Verknüpft heißt: eine Kante zu einem Begriff, einer Regel oder einem anderen Wissensknoten (z. B. MEANS); ein Feld auch über sein Datenelement.") }),
    s.nachrichten.length ? h("div", { class: "tabelle" }, h("table", { class: "small" },
      h("thead", {}, h("tr", {}, ...[t("Nachricht"), t("verknüpft"), t("Felder verknüpft"), t("nicht verknüpfte Felder")].map((x) => h("th", { scope: "col", text: x })))),
      h("tbody", {}, ...s.nachrichten.map((n) => h("tr", {},
        h("td", { class: "mono" }, h("a", { href: nodeHash(n.id), text: n.name, onclick: (e) => { e.preventDefault(); openNode(n.id); } })),
        h("td", { class: n.verknuepft ? "tr-ja" : "tr-nein", text: n.verknuepft ? "●" : "○" }),
        h("td", { text: `${n.felder_verknuepft}/${n.felder}` }),
        h("td", { class: "small", title: n.offen.join(", "), text: n.offen.slice(0, 8).join(", ") + (n.offen.length > 8 ? " …" : "") }))))))
      : h("div", { class: "muted small", text: t("keine") }),
    s.offen.length ? h("details", {}, h("summary", { text: t("Dienste und Operationen ohne Verknüpfung ({n})", { n: s.offen.length }) }),
      h("div", { class: "small mono" }, s.offen.map((x) => `${arten[x.art] || x.art}: ${x.name}`).join(" · "))) : null);
  return [zahlen, ...doks, nachr];
}
// ------------------------------------------------------------------ Lückenbaum und Aufgaben (kanonik/aufgaben.py)
function mdDatei(name, text) {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" })), download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
async function mdKopieren(text) {
  try { await navigator.clipboard.writeText(text); toast(t("Aufgabe kopiert")); }
  catch { mdDatei("aufgabe.md", text); }
}
function baumLuecke(n) {
  const d = n.dazu, a = n.aufgabe, art = GAP_ART();
  const pill = { fehlt: "rel-rejected", abweichend: "rel-candidate", unvollstaendig: "rel-candidate" }[n.art] || "type";
  const liste = (titel, xs, f) => (xs.length ? h("div", { class: "baum-teil" }, h("strong", { text: `${titel} (${xs.length})` }),
    h("ul", { class: "small" }, ...xs.map((x) => h("li", {}, f(x))))) : null);
  const dazu = h("div", { class: "baum-dazu" },
    liste(t("Anforderungen und Regeln"), d.anforderungen, (x) => [gapReqLink(x.id), " ", h("span", { class: x.kern ? "" : "muted", text: x.text || "" })]),
    liste(t("Nachrichten"), d.nachrichten, (x) => [h("span", { class: "mono", text: x.name }), ` „${x.titel || ""}“ · ${x.absender || "?"} → ${(x.empfaenger || []).join(", ")}`,
      x.daten ? h("div", { class: "muted", text: t("Daten: {d}", { d: x.daten }) }) : null]),
    liste(t("Prozesselemente"), d.prozesse, (x) => x),
    liste(t("Klassen"), d.klassen, (x) => h("span", { class: "mono", text: x })),
    liste(t("Tests"), d.tests, (x) => [h("span", { class: "mono", text: x.klasse }), h("span", { class: "muted", text: ` · ${t("{n} Testfälle", { n: x.testfaelle })}` })]),
    liste(t("Codestellen und Modelle"), d.codestellen, (x) => h("span", { class: "mono", text: x })));
  const aufgabe = h("div", { class: "baum-aufgabe" },
    h("div", { class: "baum-kopf" }, h("strong", { text: t("Aufgabe: {t}", { t: a.titel }) }),
      h("button", { type: "button", class: "small", onclick: () => mdKopieren(a.markdown), text: t("Als Markdown kopieren") }),
      h("button", { type: "button", class: "small", onclick: () => mdDatei(`aufgabe-${n.id}.md`, a.markdown), text: t("Als .md") })),
    h("div", { class: "small muted", text: t("Schritte") }),
    h("ul", { class: "baum-check small" }, ...a.schritte.map((s) => h("li", { class: s.startsWith("  - ") ? "baum-unter" : "", text: s.replace(/^\s+-\s/, "") }))),
    h("div", { class: "small muted", text: t("Akzeptanzkriterien") }),
    h("ul", { class: "baum-check small" }, ...a.akzeptanz.map((s) => h("li", { text: s }))));
  return h("details", { class: "card baum-luecke", id: `baum-${n.id}`, open: state.baumOffen === n.id },
    h("summary", {}, h("span", { class: `pill ${pill}`, text: art[n.art] || n.art }), " ", ...gapTypPills(n).flatMap((p) => [p, " "]),
      h("strong", { text: `${n.id} · ${n.titel}` }), " ",
      n.folgen.length ? h("span", { class: "pill type", text: t("+{n} Folgelücken", { n: n.folgen.length }) }) : null, " ",
      h("span", { class: `pill ${n.entscheidung === "bestaetigt" ? "rel-confirmed" : n.entscheidung === "falsch" ? "rel-rejected" : "type"}`,
        text: GAP_DEC()[n.entscheidung] || n.entscheidung || "" })),
    h("p", { class: "small", text: n.beschreibung }),
    n.folgen.length ? h("div", { class: "baum-folgen" }, h("strong", { class: "small", text: t("Folgelücken") }), ...n.folgen.map((f) => gapMini(f.id))) : null,
    h("details", { class: "small", open: true }, h("summary", { text: t("Gehört dazu") }), dazu),
    aufgabe);
}
function gapBaum() {
  if (!state.baum) {
    api("/api/aufgaben").then((r) => { state.baum = r; if (state.gapCat === "baum") renderGaps("baum"); })
      .catch((e) => toast(e.message, true));
    return [h("div", { class: "muted small", text: t("Lückenbaum wird aufgebaut …") })];
  }
  const m = state.baum, z = m.zahlen;
  const alle = () => m.kapitel.map((k) => `# ${k.nummer} ${k.titel || ""}\n\n` + k.luecken.map((n) => n.aufgabe.markdown).join("\n")).join("\n");
  const kopf = h("div", { class: "card small" },
    h("div", { text: t("{h} Hauptlücken mit {f} Folgelücken in {k} Kapiteln. Je Hauptlücke: was dazugehört und ein Aufgabenvorschlag, der sie samt Folgelücken schließt – aus Fachkonzept, BPMN und Code abgeleitet, ohne Sprachmodell; vor dem Übernehmen prüfen.",
      { h: z.hauptluecken, f: z.folgeluecken, k: z.kapitel }) }),
    h("div", { class: "el-bar" }, h("button", { type: "button", onclick: () => mdDatei("aufgaben.md", alle()), text: t("Alle Aufgaben als Markdown herunterladen") }),
      h("button", { type: "button", onclick: () => document.querySelectorAll("#detail .baum-luecke").forEach((d) => { d.open = true; }), text: t("Alle aufklappen") })));
  const teile = m.kapitel.map((k) => h("details", { class: "baum-kapitel", open: true },
    h("summary", {}, h("strong", { text: `${k.nummer} ${k.titel || ""}`.trim() || t("ohne Kapitel") }),
      h("span", { class: "muted small", text: `  ${t("{n} Hauptlücken", { n: k.luecken.length })}` })),
    ...k.luecken.map(baumLuecke)));
  if (state.baumOffen) setTimeout(() => { const e = document.getElementById(`baum-${state.baumOffen}`); if (e) e.scrollIntoView({ block: "start" }); state.baumOffen = null; }, 50);
  return [kopf, ...teile];
}
// ------------------------------------------------------------------ Steckbrief der Domäne (UC1, kanonik/steckbrief.py)
function gapSteckbrief() {
  if (!state.steckbrief) {
    api("/api/steckbrief").then((r) => { state.steckbrief = r; if (state.gapCat === "steckbrief") renderGaps("steckbrief"); })
      .catch((e) => toast(e.message, true));
    return [h("div", { class: "muted small", text: t("Steckbrief wird geladen …") })];
  }
  const s = state.steckbrief, k = s.kennzahlen || {}, lz = k.luecken || {};
  const zahl = (wert, text) => h("div", { class: "sb-zahl" }, h("strong", { text: wert === undefined || wert === null ? "–" : String(wert) }), h("span", { class: "muted small", text }));
  const karte = (titel, ...inhalt) => h("section", { class: "card sb-karte" }, h("h2", { text: titel }), ...inhalt);
  const tabelle = (kopf, zeilen) => zeilen.length ? h("div", { class: "tabelle" }, h("table", { class: "small" },
    h("thead", {}, h("tr", {}, ...kopf.map((x) => h("th", { text: x })))), h("tbody", {}, ...zeilen.map((z) => h("tr", {}, ...z.map((c) => h("td", {}, c)))))))
    : h("div", { class: "muted small", text: t("keine") });
  const d = s.domaene || {}, q = s.quellen || {}, c = q.code || {};
  const kopf = karte(d.titel || d.name || t("Domäne"),
    d.beschreibung ? h("p", { text: d.beschreibung }) : null,
    h("div", { class: "small" }, h("strong", { text: t("Dokumente") + ": " }), (q.dokumente || []).map((x) => x.titel).join(", ") || "–"),
    c.url ? h("div", { class: "small" }, h("strong", { text: t("Code") + ": " }), h("a", { href: c.url, target: "_blank", rel: "noopener", text: c.url }),
      c.commit ? h("span", { class: "mono muted", text: ` @ ${String(c.commit).slice(0, 7)}` }) : null, c.rights ? ` · ${c.rights}` : null) : null);
  const zahlen = h("div", { class: "sb-zahlen" },
    zahl(k.anforderungen, t("Anforderungen")), zahl(k.regeln, t("Regeln")), zahl(k.begriffe, t("Begriffe")),
    zahl((s.systeme || []).length, t("Rollen und Systeme")), zahl(k.dienste, t("Dienste im Code")), zahl(k.klassen, t("Klassen")),
    zahl(k.eintraege ? `${k.zugeordnet}/${k.eintraege}` : null, t("Anforderungen mit Code")),
    zahl(lz.gesamt, t("Lücken")),
    ...[["regression", t("Trefferquote gegen geprüfte Funde")], ["unabhaengig", t("Trefferquote gegen unabhängig erhobene Lücken")]]
      .map(([a, text]) => ((k.orakel || {})[a] || {}).trefferquote != null ? zahl(`${Math.round(100 * k.orakel[a].trefferquote)} %`, text) : null));
  const sys = karte(t("Rollen und Systeme"), tabelle([t("Rolle bzw. System"), t("englisch"), t("Aufgabe"), t("Anforderungen")],
    (s.systeme || []).map((x) => [x.name, x.en || "–", x.aufgabe || "–", String(x.anforderungen || 0)])));
  const p = s.prozesse || {};
  const proz = karte(t("Prozesse"),
    h("div", { class: "small" }, t("{a} aus dem Fachkonzept abgeleitet, {v} Modelle im Code-Repository", { a: (p.abgeleitet || []).length, v: (p.vorhanden || []).length })),
    (p.vergleich || []).length ? tabelle([t("Prozess"), t("vorhanden"), t("Elemente"), t("gefunden")],
      p.vergleich.map((x) => [x.prozess, x.vorhanden || "–", String(x.elemente), String(x.gefunden)])) : null);
  const ss = s.schnittstellen || {};
  const sst = karte(t("Schnittstellen"),
    h("div", { class: "small" }, t("{n} Nachrichten laut Fachkonzept · im Code {r} REST-Operationen, {e} Ereignis-Operationen", { n: (ss.nachrichtentabelle || []).length, r: ss.rest || 0, e: ss.ereignisse || 0 })),
    tabelle([t("Nachricht"), t("von"), t("an")], (ss.nachrichtentabelle || []).map((x) => [x.name, x.absender || "–", (x.empfaenger || []).join(", ")])));
  const dien = karte(t("Dienste im Code"), tabelle([t("Dienst"), t("Klassen"), t("REST"), t("sendet"), t("empfängt"), t("Anforderungen")],
    (s.dienste || []).map((x) => [h("span", { class: "mono", text: x.dienst }), String(x.klassen), String(x.rest),
      (x.sendet || []).join(", ") || (x.worker || []).length ? (x.sendet || []).concat((x.worker || []).map((w) => `⚙ ${w}`)).join(", ") : "–",
      (x.empfaengt || []).join(", ") || "–", String(x.anforderungen)])));
  const art = GAP_ART(), sichtName = (v) => (v === "beide" ? t("BPMN und Code") : v === "schnittstelle" ? t("Schnittstelle") : String(v).toUpperCase());
  const lue = karte(t("Lücken"),
    h("div", { class: "small" }, [...Object.entries(lz.sicht || {}).map(([v, n]) => `${sichtName(v)} ${n}`),
      ...Object.entries(lz.art || {}).map(([v, n]) => `${art[v] || v} ${n}`)].join(" · ") || "–"),
    tabelle([t("Kennung"), t("Lücke"), t("Art"), t("Sicht"), t("Lückentyp")],
      (s.luecken || []).map((x) => [h("a", { href: "#", text: x.id, onclick: (e) => { e.preventDefault(); zuAnsicht("gap", "suche"); } }), x.titel,
        art[x.art] || x.art, sichtName(x.sicht), gapTypName(x.regel)])));
  return [kopf, zahlen, sys, proz, sst, dien, lue];
}
function gapZuordnungLaden(cat) {
  if (state.gapZuordnung) return true;
  api("/api/luecken/zuordnung").then((r) => { state.gapZuordnung = r; if (state.gapCat === cat) renderGaps(cat); })
    .catch((e) => toast(e.message, true));
  return false;
}
function gapZuordnungReq(id, klasse) {
  // Kennung mit Text als Hinweis (und warum zugeordnet); Sprung ins Dokument, wo es ihn gibt
  const z = state.gapZuordnung, a = (z.anforderungen || {})[id] || {};
  const k = klasse ? (a.klassen || []).find((x) => x.klasse === klasse) : null;
  const hinweis = `${id}: ${a.text || ""}${k ? "\n" + t("zugeordnet") + ` (${k.punkte}): ` + k.gruende.join("; ") : ""}`;
  const l = gapReqLink(id);
  return typeof l === "string" ? h("span", { class: `mono small gap-zu-req ${a.art === "regel" ? "regel" : ""}`, title: hinweis, text: id })
    : (l.title = hinweis, l);
}
function gapZuordnung() {
  if (!gapZuordnungLaden("zuordnung")) return [h("div", { class: "muted small", text: t("Zuordnung wird geladen …") })];
  const z = state.gapZuordnung;
  if (!(z.code || []).length) return [h("div", { class: "card muted", text: t("Keine Zuordnung – kein Code bzw. keine Anforderungen (python abgleich/zuordnung.py)") })];
  const f = state.gapZuFilter = state.gapZuFilter || { dienst: "", paket: "", klasse: "", nurMit: true };
  const box = h("div", {});
  // Regeln und Anforderungen des Fachkonzepts (A-…) vor den abgeleiteten (REQ-…), je natürlich sortiert
  const rang = (i) => (/^R-/.test(i) ? 0 : /^[A-Z]-/.test(i) ? 1 : 2);
  const nat = (a, b) => rang(a) - rang(b) || a.localeCompare(b, undefined, { numeric: true });
  const ids = (x) => [...x.anforderungen, ...x.regeln].sort(nat);
  const reqs = (x, klasse) => ids(x).length ? h("div", { class: "gap-zu-reqs" }, ...gapVerbinde(ids(x).map((i) => gapZuordnungReq(i, klasse)), " "))
    : h("span", { class: "muted small", text: t("keine") });
  const zahl = (x) => t("{a} Anforderungen, {r} Regeln", { a: x.anforderungen.length, r: x.regeln.length });
  function zeige() {
    const pa = f.paket, kl = f.klasse;                    // Auswahl: Package „Dienst|Package“, Klasse „Dienst|Package|Klasse“
    const karten = z.code.filter((d) => !f.dienst || d.dienst === f.dienst).map((d) => {
      const pakete = d.pakete.filter((p) => !pa || pa === `${d.dienst}|${p.paket}`).map((p) => {
        const klassen = p.klassen.filter((k) => (!kl || kl === `${d.dienst}|${p.paket}|${k.klasse}`) && (!f.nurMit || ids(k).length || kl));
        if (!klassen.length && (kl || f.nurMit)) return null;
        return h("details", { class: "gap-zu-paket", open: !!(pa || kl) },
          h("summary", {}, h("span", { class: "mono small", text: p.paket || t("(ohne Package)") }), h("span", { class: "muted small", text: `  ${zahl(p)}` })),
          reqs(p),
          ...klassen.map((k) => h("div", { class: "gap-zu-klasse" },
            h("div", {}, h("strong", { class: "mono small", text: k.klasse }),
              k.methoden.length ? h("span", { class: "muted small", text: `  ${k.methoden.slice(0, 6).join(", ")}${k.methoden.length > 6 ? " …" : ""}` }) : null,
              k.datei ? h("div", { class: "small" }, gapCode({ datei: k.datei, zeile: k.zeile, ziel: k.klasse, url: k.url })) : null),
            reqs(k, k.klasse))));
      }).filter(Boolean);
      if (!pakete.length && (pa || kl || (f.nurMit && !ids(d).length))) return null;
      return h("details", { class: "card", open: !!(f.dienst || pa || kl) },
        h("summary", {}, h("strong", { text: d.dienst }), h("span", { class: "muted small", text: `  ${zahl(d)}` })), reqs(d), ...pakete);
    }).filter(Boolean);
    box.replaceChildren(...(karten.length ? karten : [h("div", { class: "muted small", text: t("keine") })]));
  }
  // Package und Klasse als Auswahl, eingegrenzt durch System/Microservice bzw. Package (und „nur Klassen mit …“)
  const kurz = (p) => p.split(".").slice(-2).join(".");
  const paketWahl = h("select", { "aria-label": t("Package"), onchange: (e) => { f.paket = e.target.value; f.klasse = ""; listen(); zeige(); } });
  const klasseWahl = h("select", { "aria-label": t("Klasse"), onchange: (e) => { f.klasse = e.target.value; zeige(); } });
  function listen() {
    const ds = z.code.filter((d) => !f.dienst || d.dienst === f.dienst);
    const ps = ds.flatMap((d) => d.pakete.filter((p) => !f.nurMit || ids(p).length).map((p) => ({ d, p, key: `${d.dienst}|${p.paket}` })));
    if (f.paket && !ps.some((x) => x.key === f.paket)) f.paket = "";
    const ks = ps.filter((x) => !f.paket || x.key === f.paket).flatMap(({ d, p }) => p.klassen.filter((k) => !f.nurMit || ids(k).length)
      .map((k) => ({ d, p, k, key: `${d.dienst}|${p.paket}|${k.klasse}` }))).sort((a, b) => a.k.klasse.localeCompare(b.k.klasse));
    if (f.klasse && !ks.some((x) => x.key === f.klasse)) f.klasse = "";
    paketWahl.replaceChildren(h("option", { value: "", text: t("alle Packages") }),
      ...ps.map(({ d, p, key }) => h("option", { value: key, selected: key === f.paket, title: p.paket,
        text: `${f.dienst ? "" : d.dienst + " › "}${p.paket ? kurz(p.paket) : t("(ohne Package)")} (${ids(p).length})` })));
    klasseWahl.replaceChildren(h("option", { value: "", text: t("alle Klassen") }),
      ...ks.map(({ d, p, k, key }) => h("option", { value: key, selected: key === f.klasse, title: `${d.dienst} › ${p.paket}`,
        text: `${k.klasse}${f.paket ? "" : " · " + (p.paket ? kurz(p.paket) : d.dienst)} (${ids(k).length})` })));
  }
  listen();
  const wahl = (label, sel) => h("label", { class: "gap-such-feld" }, h("span", { class: "small muted", text: label }), sel);
  const st = z.stand || {};
  const kopf = h("div", { class: "card gap-such" },
    h("div", { class: "small muted", text: t("{z} von {n} Anforderungen und Regeln sind Code zugeordnet, {k} von {m} Klassen haben Anforderungen. Die Zuordnung ist heuristisch – der Hinweis an jeder Kennung nennt den Grund.",
      { z: st.zugeordnet || 0, n: st.eintraege || 0, k: st.klassen_mit || 0, m: st.klassen || 0 }) }),
    h("div", { class: "gap-such-zeile" },
      h("label", { class: "gap-such-feld" }, h("span", { class: "small muted", text: t("System/Microservice") }),
        h("select", { onchange: (e) => { f.dienst = e.target.value; listen(); zeige(); } }, h("option", { value: "", text: t("alle Systeme/Microservices") }),
          ...z.code.map((d) => h("option", { value: d.dienst, selected: d.dienst === f.dienst, text: `${d.dienst} (${ids(d).length})` })))),
      wahl(t("Package"), paketWahl), wahl(t("Klasse"), klasseWahl)),
    h("label", { class: "small" }, h("input", { type: "checkbox", checked: f.nurMit, onchange: (e) => { f.nurMit = e.target.checked; listen(); zeige(); } }),
      " " + t("nur Klassen mit Anforderungen bzw. Regeln")));
  const ohne = (z.ohne_code || []).length ? h("details", { class: "card" },
    h("summary", { text: t("Ohne Zuordnung zum Code ({n})", { n: z.ohne_code.length }) }), h("div", { class: "gap-zu-reqs" }, ...gapVerbinde(z.ohne_code.map((i) => gapZuordnungReq(i)), " "))) : null;
  zeige();
  return [kopf, box, ohne];
}
function gapRollen() {
  if (!gapZuordnungLaden("rollen")) return [h("div", { class: "muted small", text: t("Zuordnung wird geladen …") })];
  const sy = state.gapZuordnung.systeme || [];
  if (!sy.length) return [h("div", { class: "card muted", text: t("Keine Systeme mit Rollen – die Anforderungen nach Satzschablonen nennen kein System") })];
  return sy.map((s) => h("div", { class: "card" },
    h("h2", {}, s.system, s.en ? h("span", { class: "muted small", text: ` · ${s.en}` }) : null),
    s.aufgabe ? h("div", { class: "small muted", text: s.aufgabe }) : null,
    h("table", { class: "gap-rollen" }, h("thead", {}, h("tr", {}, h("th", { text: t("Rolle") }), h("th", { text: t("Anforderungen") }))),
      h("tbody", {}, ...s.rollen.map((r) => h("tr", {},
        h("td", {}, h("strong", { text: r.rolle }), r.aufgabe ? h("div", { class: "muted small", text: r.aufgabe }) : null),
        h("td", {}, h("span", { class: "muted small", text: `${r.anforderungen.length}  ` }), ...gapVerbinde(r.anforderungen.map((i) => gapZuordnungReq(i)), " "))))))));
}
function gapNachTyp() {
  const l = state.gap.luecken || [];
  const je = new Map();
  for (const x of l) for (const r of gapTypen(x)) { if (!je.has(r)) je.set(r, []); je.get(r).push(x); }
  const reihe = [...je.entries()].sort((a, b) => b[1].length - a[1].length || gapTypName(a[0]).localeCompare(gapTypName(b[0])));
  const zahl = (xs, e) => xs.filter((x) => x.entscheidung === e).length;
  return [h("div", { class: "card" }, h("table", { class: "gap-rollen" },
      h("thead", {}, h("tr", {}, ...[t("Lückentyp"), t("Lücken"), t("neu"), t("bestätigt"), t("Fehlalarm")].map((x) => h("th", { text: x })))),
      h("tbody", {}, ...reihe.map(([r, xs]) => h("tr", {},
        h("td", {}, h("a", { href: `#typ-${r}`, onclick: (e) => { e.preventDefault(); document.getElementById(`typ-${r}`)?.scrollIntoView({ block: "start" }); document.getElementById(`typ-${r}`).open = true; }, text: gapTypName(r) }),
          h("div", { class: "muted small mono", text: r })),
        h("td", { text: String(xs.length) }), h("td", { text: String(zahl(xs, "neu")) }),
        h("td", { text: String(zahl(xs, "bestaetigt")) }), h("td", { text: String(zahl(xs, "falsch")) })))))),
    ...reihe.map(([r, xs]) => h("details", { class: "card", id: `typ-${r}`, open: reihe.length <= 3 },
      h("summary", {}, h("strong", { text: gapTypName(r) }), h("span", { class: "muted small", text: `  ${tp(xs.length, "1 Lücke", "{n} Lücken")}` })),
      ...xs.map((x) => gapMini(x.id))))];
}
function renderGaps(cat) {
  $("detail").dataset.maske = "luecken";                 // Handbuch: passendes Kapitel (handbuch.js)
  state.gapCat = cat; state.gapShown = true;
  renderGapList();
  const [, title, hint] = GAP_CATS().find((x) => x[0] === cat);
  const parts = [h("div", { class: "node-head" }, h("h1", { text: title }), h("div", { class: "muted small", text: hint }))];
  if (cat === "steckbrief") parts.push(...gapSteckbrief());
  else if (cat === "architektur") parts.push(...gapArchitektur());
  else if (cat === "matrix") parts.push(...gapMatrix());
  else if (cat === "impact") parts.push(...gapImpact());
  else if (cat === "abdeckung") parts.push(...gapAbdeckung());
  else if (cat === "baum") parts.push(...gapBaum());
  else if (!state.gap.luecken.length && !Object.keys(state.gap.bpmn || {}).length)
    parts.push(h("div", { class: "card muted", text: t("Noch kein Abgleich – python make_out.py --only code abgleich") }));
  else if (cat === "abgleich") parts.push(...gapAbgleich());
  else if (cat === "graph") parts.push(...gapGraph());
  else if (cat === "suche") parts.push(...gapSuche());
  else if (cat === "oben") parts.push(...gapOben());
  else if (cat === "unten") parts.push(...gapUnten());
  else if (cat === "zuordnung") parts.push(...gapZuordnung());
  else if (cat === "typen") parts.push(...gapNachTyp());
  else if (cat === "rollen") parts.push(...gapRollen());
  else {
    const items = gapItems(cat);
    parts.push(...(items.length ? items.map(gapCard) : [h("div", { class: "muted small", text: t("keine") })]));
  }
  parts.push(h("div", { class: "muted small", text: t("Entscheidungen stehen in {f} (Repo der Domäne).", { f: state.gap.datei }) }));
  $("detail").replaceChildren(...parts);
}

// ------------------------------------------------------------------ Entscheidungen prüfen (kanonik/entscheidungen.py)
const DEC_CATS = () => [["geaendert", t("Grundlage geändert"), t("Letzte Entscheidung, deren Quellen sich seitdem geändert haben (Text der Dokumentstelle, Knoten bearbeitet oder gelöscht)")],
  ["zurueck", t("Zurückgenommen"), t("Entscheidungen, die später zurückgenommen bzw. umgekehrt wurden – worauf sie beruhten")],
  ["ohne_grundlage", t("Ohne Grundlage"), t("Letzte Entscheidungen ohne Grundlage, nach Herkunft des Vorschlags")],
  ["sammel", t("Sammelentscheidungen"), t("Mehrere Zuordnungen auf einmal entschieden bzw. eigenen Begriff angelegt – als Ganzes zurücknehmen")],
  ["verbesserungen", t("Verbesserungen"), t("Auswertung von Arbeitsweise und Graph mit Vorschlägen (Tester-Agent, ohne Sprachmodell)")],
  ["quellen", t("Auswertung je Quelle"), t("Je Herkunft und Verfahren des Vorschlags: bestätigt, abgelehnt, später zurückgenommen")]];
async function loadDecisions() {
  const seq = listLoading("dec");
  detailLoading(true);
  let res;
  try { [res, state.batches] = await Promise.all([api("/api/decisions"), api("/api/batches")]); } catch (e) { if (isSeq("dec", seq)) { listDone("dec"); detailLoading(false); toast(e.message, true); } return; }
  if (!isSeq("dec", seq)) return;
  listDone("dec"); detailLoading(false);
  if (state.tab !== "dec") return;
  state.dec = res;
  renderDecisions(state.decCat || "geaendert");
}
function decCount(c) { const d = state.dec; return c === "quellen" ? d.quellen.length : c === "sammel" ? (state.batches || { n: 0 }).n
  : c === "verbesserungen" ? (state.auswertung ? state.auswertung.vorschlaege.length : "…") : d[`n_${c}`]; }
const BATCH_ACTION = () => ({ "relation:confirm": t("bestätigt"), "relation:reject": t("abgelehnt"), "relation:reset": t("zurückgesetzt"),
  "retype:None": t("Beziehungsart geändert"), "link:add": t("Verknüpfung angelegt") });
async function undoBatch(b) {
  const user = $("user").value.trim();
  if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); $("user").focus(); return; }
  const what = b.node ? t("Begriff „{b}“ wieder entfernen und die Zuordnungen zurücksetzen?", { b: b.node.title })
    : t("{n} Entscheidungen dieser Sammelentscheidung zurücksetzen? Die Zuordnungen werden wieder Vorschläge.", { n: b.n });
  if (!window.confirm(what)) return;
  let res;
  try { res = await api("/api/batch/undo", { method: "POST", body: JSON.stringify({ batch: b.batch, user, comment: ($("comment") || {}).value || null }) }); }
  catch (e) { toast(e.message, true); return; }
  toast(t("{d} zurückgenommen", { d: res.done }) + (res.failed.length ? t(", {f} nicht möglich (inzwischen geändert?)", { f: res.failed.length }) : ""), res.failed.length > 0);
  if (res.failed.length) console.warn(res.failed);
  loadDecisions();
}
function batchItem(b) {
  const acts = Object.entries(b.actions).map(([k, n]) => `${n} × ${BATCH_ACTION()[k] || k}`).join(", ");
  const link = (id, txt) => h("a", { href: nodeHash(id, null), class: "link", onclick: (ev) => { if (ev.button || ev.ctrlKey || ev.metaKey) return; ev.preventDefault(); setTab("nodes"); openNode(id); } }, txt || id);
  const targets = b.targets || [];
  return h("div", { class: "hist" },
    h("div", {}, h("strong", { text: b.node ? t("Eigener Begriff angelegt") : b.kind === "transitiv" ? t("Transitiv erledigt") : b.kind === "agent" ? t("Empfehlungen des Agenten übernommen") : t("Sammelentscheidung") }), ` · ${fmtTs(b.ts)} · ${b.user || ""}`,
      b.undone_by ? [" ", h("span", { class: "pill rel-rejected", text: t("zurückgenommen") })] : null),
    h("div", { class: "small" }, b.node ? [link(b.node.id, `„${b.node.title}“`), " · "] : null, acts,
      targets.length ? [h("span", { class: "muted", text: " → " }), ...targets.flatMap((x, i) => [i ? ", " : "", link(x.id, x.title)])] : null),
    decBasis(b),
    b.undone_by || state.config.readonly || Object.keys(b.actions).every((k) => k === "relation:reset") ? null : h("div", { class: "el-bar" }, h("button", { type: "button", class: "small", onclick: () => undoBatch(b) },
      b.node ? t("Anlegen zurücknehmen") : t("Alle zurücksetzen"))));
}
function renderDecisionList() {
  const d = state.dec;
  $("result-info").textContent = tp(d.entscheidungen, "1 Entscheidung, {g} mit Grundlage", "{n} Entscheidungen, {g} mit Grundlage", { g: d.mit_grundlage });
  $("results").setAttribute("role", "listbox");
  $("results").replaceChildren(...DEC_CATS().map(([k, title, hint]) => h("li", {
    role: "option", tabindex: "0", "aria-selected": String(k === state.decCat), title: hint,
    onclick: () => zuAnsicht("dec", k), onkeydown: (e) => { if (e.key === "Enter") zuAnsicht("dec", k); },
  }, h("div", { class: "r-title", text: title }), h("div", { class: "r-meta" },
    h("span", { class: `pill ${decCount(k) && k !== "quellen" ? "rel-candidate" : "type"}`, text: String(decCount(k)) }), h("span", { class: "muted small", text: hint })))));
}
function decTarget(e) {
  // worüber entschieden wurde: Knoten bzw. Beziehung (Start → Ziel), anklickbar
  const link = (id) => h("a", { href: nodeHash(id, null), class: "link", onclick: (ev) => { if (ev.button || ev.ctrlKey || ev.metaKey) return; ev.preventDefault(); setTab("nodes"); openNode(id); } }, id);
  if (e.node_id) return h("span", {}, link(e.node_id));
  return h("span", {}, link(e.start), h("span", { class: "muted", text: ` –[${relTitle(e.type)}${e.to ? " → " + relTitle(e.to) : ""}]→ ` }), link(e.end));
}
function decAction(e) {
  const txt = e.kind === "node" ? (ACTION_DE[e.action] || e.action) : e.kind === "retype" ? t("Beziehungsart geändert")
    : ((e.kind === "link" ? LINK_ACTION_DE : REL_ACTION_DE)[e.action] || e.action);
  return h("span", {}, h("strong", { text: txt }), ` · ${fmtTs(e.ts)} · ${e.user || ""}`);
}
function decVorschlag(v) {
  if (!v) return null;
  return h("div", { class: "small muted" }, herkunftPills({ arten: v.herkunft || [], detail: v.detail }, true),
    ` ${[v.method ? methodInfo(v.method).title : null, v.score != null && !String(v.detail || "").includes("Score") ? `Score ${Number(v.score).toFixed(2)}` : null, v.evidence].filter(Boolean).join(" · ")}`,
    v.heute ? h("span", { title: t("älterer Eintrag: Vorschlag aus dem heutigen Graphen"), text: t(" (heute)") }) : null);
}
function decBasis(e) {
  return h("div", {}, e.comment ? h("div", { class: "small", text: t("Begründung: {c}", { c: e.comment }) }) : null,
    (e.grundlage || []).length ? h("div", { class: "bchips" }, ...e.grundlage.map((g) => basisChip(g))) : null);
}
function renderDecisions(cat) {
  $("detail").dataset.maske = "entscheidungen";                 // Handbuch: passendes Kapitel (handbuch.js)
  state.decCat = cat; state.decShown = true;
  renderDecisionList();
  const d = state.dec;
  const [, title, hint] = DEC_CATS().find((x) => x[0] === cat);
  const parts = [h("div", { class: "node-head" }, h("h1", { text: title }), h("div", { class: "muted small", text: hint }))];
  const more = (n, shown) => n > shown ? h("div", { class: "muted small", text: t("… {n} weitere", { n: n - shown }) }) : null;
  if (cat === "geaendert") {
    parts.push(h("div", { class: "card" }, ...(d.geaendert.length ? d.geaendert.map((e) => h("div", { class: "hist" },
      h("div", {}, decAction(e), " ", decTarget(e)),
      ...e.probleme.map((p) => h("div", { class: "small" }, h("span", { class: `pill ${p.grund === "fehlt" ? "rel-rejected" : "rel-candidate"}`, text: p.text }), " ", basisChip(p.quelle))),
      decBasis(e))) : [h("div", { class: "muted", text: t("keine – alle Grundlagen unverändert") })]), more(d.n_geaendert, d.geaendert.length)));
  } else if (cat === "zurueck") {
    parts.push(h("div", { class: "card" }, ...(d.zurueck.length ? d.zurueck.map((r) => h("div", { class: "hist" },
      h("div", {}, decAction(r.entscheidung), " ", decTarget(r.entscheidung)),
      decVorschlag(r.entscheidung.vorschlag), decBasis(r.entscheidung),
      h("div", { class: "small" }, "↩ ", decAction(r.spaeter), r.spaeter.comment ? h("span", { class: "muted", text: ` · „${r.spaeter.comment}“` }) : null),
      decBasis({ grundlage: r.spaeter.grundlage }))) : [h("div", { class: "muted", text: t("keine") })]), more(d.n_zurueck, d.zurueck.length)));
  } else if (cat === "verbesserungen") {
    const card = h("div", { class: "card" }, loadingEl());
    parts.push(card);
    const SW = { hoch: ["rel-rejected", t("hoch")], mittel: ["rel-candidate", t("mittel")], idee: ["type", t("Idee")] };
    const show = (r) => {
      state.auswertung = r;
      const kz = r.kennzahlen;
      card.replaceChildren(...[h("div", { class: "muted small", text: t("Stand {t} · {n} Begriffe, {e} Entscheidungen, {d} Dubletten, {w} Widersprüche, {k} Kreise, {o} transitiv offen",
        { t: fmtTs(r.ts), n: kz.begriffe, e: kz.entscheidungen, d: kz.dubletten, w: kz.widersprueche, k: kz.kreise_oberbegriff, o: kz.transitiv_offen }) }),
        ...(r.vorschlaege.length ? r.vorschlaege.map((v) => h("div", { class: "hist" },
          h("div", {}, h("span", { class: `pill ${(SW[v.schwere] || SW.idee)[0]}`, text: (SW[v.schwere] || SW.idee)[1] }), " ", h("strong", { text: v.titel })),
          h("div", { class: "small", text: v.text }),
          v.belege.length ? h("div", { class: "small" }, ...v.belege.filter((b) => b && String(b).includes(":")).slice(0, 8)
            .flatMap((b, i) => [i ? ", " : "", h("a", { href: nodeHash(b, null), class: "link", onclick: (ev) => { ev.preventDefault(); setTab("nodes"); openNode(b); } }, b)])) : null))
          : [h("div", { class: "muted", text: t("keine – alles im grünen Bereich") })])].filter(Boolean));
      renderDecisionList();
    };
    api("/api/agent/auswertung").then(show).catch((e) => card.replaceChildren(h("div", { class: "muted", text: e.message })));
  } else if (cat === "sammel") {
    const bs = state.batches || { n: 0, items: [] };
    parts.push(h("div", { class: "card" }, ...(bs.items.length ? bs.items.map(batchItem) : [h("div", { class: "muted", text: t("keine") }),
      h("div", { class: "small", text: t("Sammelentscheidungen entstehen bei: „Ausgewählte bestätigen/ablehnen“ in „Datenelemente zuordnen“ am Begriff, „Alle angezeigten bestätigen/ablehnen“ in einer gefilterten Liste der Beziehungsvorschläge, „Eigenen Begriff anlegen“, „Transitiv erledigte abschließen“ und beim Übernehmen von Empfehlungen des Agenten.") })]),
      more(bs.n, bs.items.length)));
  } else if (cat === "ohne_grundlage") {
    parts.push(h("div", { class: "card" }, h("h2", { text: t("Je Herkunft des Vorschlags") }),
      h("div", { class: "bchips" }, ...Object.entries(d.ohne_grundlage_je_herkunft).map(([k, n]) => h("span", {}, herkunftPills({ arten: [k] }, true) || k, ` ${n}`)))));
    parts.push(h("div", { class: "card" }, ...(d.ohne_grundlage.length ? d.ohne_grundlage.map((e) => h("div", { class: "hist" },
      h("div", {}, decAction(e), " ", decTarget(e), e.comment ? h("span", { class: "muted", text: ` · „${e.comment}“` }) : null), decVorschlag(e.vorschlag)))
      : [h("div", { class: "muted", text: t("keine") })]), more(d.n_ohne_grundlage, d.ohne_grundlage.length)));
  } else {
    const pct = (x) => `${Math.round(100 * x)} %`;
    parts.push(h("div", { class: "card" }, h("div", { class: "table-wrap" }, h("table", { class: "paths review" },
      h("thead", {}, h("tr", {}, ...[t("Herkunft"), t("Verfahren"), t("bestätigt"), t("abgelehnt"), t("transitiv erledigt"), t("zurückgenommen"), t("Anteil abgelehnt"), t("Anteil zurückgenommen")]
        .map((x, i) => h("th", { class: i >= 2 ? "num" : null, text: x })))),
      h("tbody", {}, ...d.quellen.map((r) => h("tr", {}, h("td", {}, herkunftPills({ arten: [r.herkunft] }, true) || r.herkunft),
        h("td", { text: r.verfahren ? methodInfo(r.verfahren).title : "–", title: r.verfahren || null }),
        h("td", { class: "num", text: String(r.bestaetigt) }), h("td", { class: "num", text: String(r.abgelehnt) }),
        h("td", { class: "num", text: String(r.transitiv || 0), title: t("ergibt sich schon aus bestätigten Verknüpfungen – kein Fehler der Quelle") }),
        h("td", { class: "num", text: String(r.zurueck), title: r.beispiele.map((b) => `${fmtTs(b.ts)} ${b.node_id || `${b.start} → ${b.end}`}`).join("\n") || null }),
        h("td", { class: "num", text: pct(r.quote_abgelehnt) }), h("td", { class: "num", text: pct(r.quote_zurueck) })))))),
      h("div", { class: "muted small", text: t("Hohe Anteile abgelehnter bzw. zurückgenommener Entscheidungen zeigen Quellen, deren Vorschläge genauer geprüft oder deren Schwellen angehoben werden sollten (configuration/).") })));
  }
  $("detail").replaceChildren(...parts);
}

// ------------------------------------------------------------------ Prüfstand je Dokument
async function loadReview() {
  const seq = listLoading("review");
  detailLoading(true);
  let res;
  try { res = await api("/api/review"); } catch (e) { if (isSeq("review", seq)) { listDone("review"); detailLoading(false); toast(e.message, true); } return; }
  if (!isSeq("review", seq)) return;
  listDone("review"); detailLoading(false);
  if (state.tab !== "review") return;
  state.review = res;
  renderReviewList();
  const cur = state.review.documents.find((d) => d.id === state.reviewDoc) || state.review.documents[0];
  if (cur) renderReview(cur.id);
}
function statusPills(st) {
  return Object.keys(STATUS_DE).filter((k) => st[k]).map((k) => h("span", { class: `pill st-${k}`, title: STATUS_DE[k], text: `${STATUS_DE[k]} ${st[k]}` }));
}
function progress(st, total) {
  const done = (st.confirmed || 0) + (st.rejected || 0);
  return total ? Math.round((100 * done) / total) : 0;
}
function renderReviewList() {
  if (state.tab !== "review") return;
  const ds = state.review.documents;
  $("result-info").textContent = t(ds.length === 1 ? "{n} Dokument" : "{n} Dokumente", { n: ds.length });
  $("results").setAttribute("role", "listbox");
  $("results").replaceChildren(...ds.map((d) => h("li", {
    role: "option", tabindex: "0", "aria-selected": String(d.id === state.reviewDoc),
    onclick: () => renderReview(d.id), onkeydown: (e) => { if (e.key === "Enter") renderReview(d.id); },
  }, h("div", { class: "r-title", text: d.title }),
     h("div", { class: "r-meta" }, docBadge({ doc: d.id, lang: d.lang }) || h("span", { class: "pill type", text: d.short || d.id }),
       h("span", { text: t("{n} Knoten, {p} % geprüft", { n: d.total, p: progress(d.status, d.total) }) }),
       d.proposals ? h("span", { class: "pill rel-candidate", text: tp(d.proposals, "1 Vorschlag", "{n} Vorschläge") }) : null))));
}
// Klick auf eine Zahl: Knotensuche mit Dokument, Typ und Status bzw. Kapitel
function reviewJump(doc, { type = "", status = "", q = "" } = {}) {
  if (doc !== "–") $("f-doc").value = doc;
  $("f-type").value = type; $("f-status").value = status; $("q").value = q;
  setTab("nodes"); search();
}
function reviewTable(rows, keyCol, keyOf, jump, statuses) {
  return h("div", { class: "table-wrap" }, h("table", { class: "paths review" },
    h("thead", {}, h("tr", {}, h("th", { text: keyCol }), ...statuses.map((s) => h("th", { class: "num", text: STATUS_DE[s] || s })),
      h("th", { class: "num", text: t("gesamt") }), h("th", { class: "num", text: t("geprüft") }))),
    h("tbody", {}, ...rows.map((r) => h("tr", {}, h("td", { text: keyOf(r) }),
      ...statuses.map((s) => h("td", { class: "num" }, r.status[s] ? h("button", { type: "button", class: "link", onclick: () => jump(r, s) }, String(r.status[s])) : "")),
      h("td", { class: "num" }, h("button", { type: "button", class: "link", onclick: () => jump(r, "") }, String(r.total))),
      h("td", { class: "num", text: `${progress(r.status, r.total)} %` }))))));
}
function renderReview(docId) {
  $("detail").dataset.maske = "pruefstand";                 // Handbuch: passendes Kapitel (handbuch.js)
  state.reviewDoc = docId; state.reviewShown = true;
  renderReviewList();
  const d = state.review.documents.find((x) => x.id === docId);
  if (!d) return;
  const sts = state.review.status_values || Object.keys(STATUS_DE);
  const parts = [h("div", { class: "node-head" }, h("h1", { text: d.title }),
    h("div", { class: "meta" }, docBadge({ doc: d.id, lang: d.lang }, false), h("span", { class: "mono", text: d.id }),
      ...statusPills(d.status),
      d.proposals ? h("button", { type: "button", class: "link", onclick: () => { $("p-doc").value = d.id === "–" ? "" : d.id; setTab("props"); } },
        tp(d.proposals, "1 offener Beziehungsvorschlag", "{n} offene Beziehungsvorschläge")) : null))];
  parts.push(replayCard());
  if (d.id !== "–" && !d.virtual) parts.push(readinessOverviewCard(d.id), dddAlignmentCard(d.id), chapterKindCard(d.id));
  parts.push(h("div", { class: "card" }, h("h2", { text: t("Knoten je Typ") }),
    reviewTable(d.types, t("Typ"), (r) => r.type, (r, s) => reviewJump(d.id, { type: r.type, status: s }), sts)));
  if (d.chapters.length) parts.push(h("div", { class: "card" }, h("h2", { text: t("Knoten je Kapitel (Prozesse, Aktivitäten, Regeln, Anforderungen …)") }),
    reviewTable(d.chapters, t("Kapitel"), (r) => r.chapter, (r, s) => reviewJump(d.id, { status: s, q: r.chapter }), sts),
    h("div", { class: "muted small", text: t("Begriffe und Rollen gehören zu keinem Kapitel; sie stehen unter „Knoten je Typ“.") })));
  $("detail").replaceChildren(...parts.filter(Boolean));
}
// ------------------------------------------------------------------ Kapitelart prüfen (Prozess oder Kapitel)
const KIND_DE = tr({ prozess: "Prozess", kapitel: "Kapitel" });
function chapterKindCard(docId) {
  const body = h("div", {}, loadingEl());
  const filter = h("select", { "aria-label": t("Anzeige") },
    h("option", { value: "prozess", text: t("alle Prozesse") }),
    h("option", { value: "unsure", text: t("Prozesse ohne Ablauf oder mit höchstens 2 Aktivitäten") }),
    h("option", { value: "kapitel", text: t("alle Kapitel") }), h("option", { value: "", text: t("alle") }));
  filter.value = storage("curator.kindFilter") ?? "prozess";
  const card = h("details", { class: "card", open: true }, h("summary", { text: t("Kapitelart prüfen") }),
    h("div", { class: "small", text: t("Kapitel ohne Ablauf (Vorbemerkungen, Begriffsbestimmungen, Aufbau von Nummern …) sind „Kapitel“, nicht „Prozess“. Ein Klick stellt die Art um; sie gilt sofort und bei jedem neuen Laden.") }),
    h("div", { class: "small" }, t("Anzeige") + ": ", filter), body);
  let data = null;
  const render = () => {
    const f = filter.value;
    const rows = data.items.filter((r) => !f || (f === "unsure" ? r.kind === "prozess" && (r.flows === 0 || r.activities <= 2) : r.kind === f));
    const head = h("div", { class: "muted small", text: t("{p} Prozesse, {k} Kapitel · {n} angezeigt", { p: data.counts.prozess, k: data.counts.kapitel, n: rows.length }) });
    const tbl = h("div", { class: "table-wrap" }, h("table", { class: "paths review kinds" },
      h("thead", {}, h("tr", {}, ...[t("Kapitel"), t("Art"), t("Grund"), t("Akt."), t("Ereign."), t("Abläufe"), t("Regeln"), ""].map((x, i) =>
        h("th", { class: i >= 3 && i <= 6 ? "num" : null, text: x })))),
      h("tbody", {}, ...rows.map((r) => {
        const other = r.kind === "prozess" ? "kapitel" : "prozess";
        const btn = h("button", { type: "button", class: "small" }, t("→ {k}", { k: KIND_DE[other] }));
        btn.addEventListener("click", async () => {
          const user = $("user").value.trim();
          if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); $("user").focus(); return; }
          btn.disabled = true;
          try {
            const res = await api("/api/node/action", { method: "POST", body: JSON.stringify({ id: r.id, action: "save", rev: r.rev, user, changes: { chapterKind: other } }) });
            Object.assign(r, { kind: other, rev: res.node.rev, label: res.node.label, reason: "Kurator" });
            data.counts[other] += 1; data.counts[r.kind === "prozess" ? "kapitel" : "prozess"] -= 1;
            toast(t("{c}: jetzt {k}", { c: r.title, k: KIND_DE[other] }));
            render();
          } catch (e) { toast(e.message, true); btn.disabled = false; }
        });
        return h("tr", {}, h("td", {}, nodeLink({ id: r.id, title: `${r.number} ${r.title}`, editable: true })),
          h("td", {}, h("span", { class: `pill kind-${r.kind}`, text: KIND_DE[r.kind] })),
          h("td", { class: "muted small", text: r.reason || "" }),
          ...[r.activities, r.events, r.flows, r.rules].map((x) => h("td", { class: "num", text: String(x) })),
          h("td", {}, btn));
      }))));
    body.replaceChildren(head, tbl);
  };
  filter.addEventListener("change", () => { storage("curator.kindFilter", filter.value); if (data) render(); });
  api(`/api/chapters?${new URLSearchParams({ doc: docId })}`).then((d) => { data = d; render(); })
    .catch((e) => body.replaceChildren(h("div", { class: "muted", text: e.message })));
  return card;
}
// ------------------------------------------------------------------ Einspielen und Zusammenführen (replay_links)
function replayCard() {
  const box = h("div", { class: "card replay" }, h("h2", { text: t("Einspielen und zusammenführen") }),
    h("div", { class: "small", text: state.config.mode === "demo"
      ? t("Führt bestätigte gleichbedeutende Begriffe und Rollen zusammen (wie beim Neustart der Demo). Benennungen und Beziehungen wandern in den bleibenden Knoten.")
      : t("Wie curator/replay_links.py: Kurationsprotokoll und Zuordnungsdatei in Neo4j einspielen, danach bestätigte gleichbedeutende Begriffe und Rollen zusammenführen. Benennungen und Beziehungen wandern in den bleibenden Knoten; das lässt sich nicht rückgängig machen (nur durch neues Laden des Graphen).") }));
  const out = h("div", {});
  const run = h("button", { type: "button", class: "primary", hidden: true }, t("Jetzt einspielen"));
  const prev = h("button", { type: "button" }, t("Vorschau: was wird zusammengeführt?"));
  prev.addEventListener("click", async () => {
    let r;
    try { r = await api("/api/replay/preview"); } catch (e) { toast(e.message, true); return; }
    out.replaceChildren(r.items.length
      ? h("div", {}, h("div", { class: "small", text: t("{n} Knoten gehen auf:", { n: r.items.length }) }),
        h("div", { class: "table-wrap" }, h("table", { class: "paths" },
          h("thead", {}, h("tr", {}, h("th", { text: t("geht auf") }), h("th", { text: t("in (bleibt)") }))),
          h("tbody", {}, ...r.items.map((x) => h("tr", {}, h("td", {}, nodeLink(x.from)), h("td", {}, nodeLink(x.into))))))))
      : h("div", { class: "muted small", text: t("Nichts zusammenzuführen.") }));
    run.hidden = false;
  });
  run.addEventListener("click", async () => {
    const user = $("user").value.trim();
    if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); $("user").focus(); return; }
    run.disabled = prev.disabled = true;
    run.textContent = t("läuft …");
    let r;
    try { r = await api("/api/replay", { method: "POST", body: JSON.stringify({ user }) }); }
    catch (e) { toast(e.message, true); run.disabled = prev.disabled = false; run.textContent = t("Jetzt einspielen"); return; }
    const n = Object.keys(r.zusammengefuehrt || {}).length;
    toast(t("Eingespielt: {n} Knoten zusammengeführt", { n }));
    out.replaceChildren(...[h("div", { class: "small", text: t("Eingespielt: {n} Knoten zusammengeführt", { n }) }),
      r.verweise_pruefen ? h("div", { class: "small warn", text: t("Verweise im Fachwissen prüfen: {f}", { f: Object.keys(r.verweise_pruefen).join(", ") }) }) : null].filter(Boolean));
    run.hidden = true; run.disabled = prev.disabled = false; run.textContent = t("Jetzt einspielen");
    loadStats();
    const cur = state.node && r.zusammengefuehrt && r.zusammengefuehrt[state.node.id];
    if (cur) openNode(cur, { force: true });
    try { state.review = await api("/api/review"); renderReviewList(); } catch (e) { /* Anzeige bleibt */ }
  });
  box.append(h("div", { class: "actions-row" }, prev, run), out);
  return box;
}
// ------------------------------------------------------------------ Chat über den Graphen (v61.4, kanonik/chat.py)
// Verlauf je Fenster (sessionStorage); Antworten mit [[Knoten-ID]] als Verweis; Antwort-Cache mit „neu fragen“
const CHAT = { msgs: [], status: null, busy: false };
function chatSave() { try { sessionStorage.setItem("curator.chat", JSON.stringify(CHAT.msgs.slice(-40))); } catch { /* privat */ } }
async function initChat() {
  try { CHAT.msgs = JSON.parse(sessionStorage.getItem("curator.chat") || "[]"); } catch { CHAT.msgs = []; }
  $("chat-btn").addEventListener("click", () => toggleChat());
  $("chat-close").addEventListener("click", () => toggleChat(false));
  $("chat-clear").addEventListener("click", () => { CHAT.msgs = []; chatSave(); renderChat(); $("chat-q").focus(); });
  $("chat-form").addEventListener("submit", (e) => { e.preventDefault(); chatAsk(); });
  $("chat-q").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); chatAsk(); } });
  if (storage("curator.chatOpen") === "1") toggleChat(true);
}
async function chatStatus() {
  try { CHAT.status = await api("/api/chat/status"); } catch (e) { CHAT.status = { enabled: false, grund: e.message }; }
  const s = CHAT.status;
  $("chat-model").textContent = s.modell ? `${s.modell}${s.cloud ? " · Cloud" : ""}` : "";
  $("chat-model").title = s.ziel ? t("Fragen und Ausschnitte aus dem Graphen gehen an: {z}", { z: s.ziel }) : "";
  const note = $("chat-note");
  note.replaceChildren();
  if (!s.enabled) {
    note.append(h("div", { class: "chat-warn", text: s.grund || t("Chat nicht verfügbar") }));
    if (s.key_needed) {
      const k = h("input", { type: "password", placeholder: t("API-Schlüssel"), autocomplete: "off", class: "chat-key" });
      note.append(h("form", { class: "chat-keyform", onsubmit: async (e) => { e.preventDefault();
        try { await api("/api/chat/key", { method: "POST", body: JSON.stringify({ key: k.value }) }); k.value = ""; await chatStatus(); }
        catch (err) { toast(err.message, true); } } }, k, h("button", { type: "submit", class: "small" }, t("übernehmen")),
        h("div", { class: "muted small", text: t("Nur am Rechner des Servers; bleibt im Speicher des Servers, bis er beendet wird.") })));
    }
  } else if (s.cloud) note.append(h("div", { class: "muted", text: t("Antworten nur aus dem Graphen; Fragen und Ausschnitte gehen an {z}.", { z: s.ziel }) }));
  $("chat-send").disabled = !s.enabled || CHAT.busy;
}
async function toggleChat(open) {
  const p = $("chat-panel"), on = open === undefined ? p.hidden : open;
  p.hidden = !on; document.body.classList.toggle("chat-open", on);
  $("chat-btn").setAttribute("aria-expanded", String(on));
  storage("curator.chatOpen", on ? "1" : "0");
  if (on) { await chatStatus(); renderChat(); $("chat-q").focus(); }
}
// Antworttext: Absätze, Listen, **fett**, `Code`, [[Knoten-ID]] als Verweis (nur IDs aus den Werkzeugergebnissen)
function chatInline(text, refs) {
  const out = [], rx = /\[\[([^\[\]]+?)\]\]|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0, m;
  while ((m = rx.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) {
      const r = refs[m[1].trim()];
      out.push(r && r.ok ? h("button", { type: "button", class: "link chat-ref", title: `${r.type || r.label || ""} · ${r.id}`,
        onclick: () => { if (!["nodes", "props"].includes(state.tab)) setTab("nodes"); openNode(r.id, { label: r.editable === false ? r.label : null }); } }, r.title || r.id)
        : h("span", { class: "chat-ref-bad", title: t("nicht aus den Werkzeugergebnissen – kein Verweis"), text: m[1] }));
    } else if (m[2]) out.push(h("b", { text: m[2] }));
    else out.push(h("code", { text: m[3] }));
    last = rx.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function chatBody(text, refsList) {
  const refs = Object.fromEntries((refsList || []).map((r) => [r.id, r]));
  const blocks = [];
  let list = null;
  for (const line of String(text || "").split("\n")) {
    const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (li) { if (!list) { list = h(/^\s*\d/.test(line) ? "ol" : "ul", {}); blocks.push(list); } list.append(h("li", {}, ...chatInline(li[1], refs))); continue; }
    list = null;
    if (!line.trim()) continue;
    const hd = line.match(/^#{1,4}\s+(.*)$/);
    blocks.push(hd ? h("div", { class: "chat-h" }, ...chatInline(hd[1], refs)) : h("p", {}, ...chatInline(line, refs)));
  }
  return blocks;
}
function chatMeta(m, i) {
  const u = m.usage || {};
  const tools = m.werkzeuge || [];
  return h("div", { class: "chat-meta small muted" },
    m.cached ? h("span", { class: "pill chat-cached", title: t("Gleiche Frage zum selben Datenstand – ohne neue Anfrage an das Modell") , text: t("aus dem Cache ({d})", { d: m.cached_at || "" }) }) : null,
    h("span", { text: [m.modell, m.dauer_s !== undefined ? `${m.dauer_s} s` : null,
      tools.length ? t("{n} Werkzeugaufrufe ({k} aus dem Cache)", { n: tools.length, k: tools.filter((x) => x.cache).length }) : null,
      u.input !== undefined && !m.cached ? t("Token: {i} ein, {o} aus, {r} aus dem Prompt-Cache", { i: u.input + (u.cache_read || 0) + (u.cache_write || 0), o: u.output, r: u.cache_read || 0 }) : null]
      .filter(Boolean).join(" · ") }),
    tools.length ? h("details", { class: "chat-tools" }, h("summary", { text: t("Werkzeuge") }),
      h("ul", {}, ...tools.map((x) => h("li", { class: "mono", text: `${x.werkzeug} ${JSON.stringify(x.eingabe)}${x.cache ? " (Cache)" : ""}` })))) : null,
    i === CHAT.msgs.length - 1 && !CHAT.busy ? h("button", { type: "button", class: "link small", title: t("Antwort-Cache übergehen und das Modell neu fragen"),
      onclick: () => chatAsk(true) }, t("neu fragen")) : null);
}
function renderChat() {
  const log = $("chat-log");
  log.replaceChildren(...[...(CHAT.msgs.length ? CHAT.msgs.map((m, i) => m.role === "user"
    ? h("div", { class: "chat-msg chat-user", text: m.content })
    : h("div", { class: `chat-msg chat-bot${m.error ? " chat-error" : ""}` }, ...(m.error ? [m.content] : chatBody(m.content, m.refs)), m.error ? null : chatMeta(m, i)))
    : [h("div", { class: "muted small chat-empty", text: t("Beispiele: {b}", { b: (state.config.chat_beispiele || []).map((x) => `„${x}“`).join(" · ") || "–" }) })]),
    CHAT.busy ? h("div", { class: "chat-msg chat-bot" }, loadingEl(t("sucht im Graphen …"))) : null].filter(Boolean));
  log.scrollTop = log.scrollHeight;
  if (CHAT.status) $("chat-send").disabled = !CHAT.status.enabled || CHAT.busy;
}
async function chatAsk(refresh = false) {
  if (CHAT.busy) return;
  if (refresh) { while (CHAT.msgs.length && CHAT.msgs[CHAT.msgs.length - 1].role !== "user") CHAT.msgs.pop(); }
  else {
    const q = $("chat-q").value.trim();
    if (!q) return;
    CHAT.msgs = CHAT.msgs.filter((m) => !m.error);
    CHAT.msgs.push({ role: "user", content: q });
    $("chat-q").value = "";
  }
  CHAT.busy = true; renderChat();
  try {
    const r = await api("/api/chat", { method: "POST", body: JSON.stringify({ neu: refresh,
      messages: CHAT.msgs.map((m) => ({ role: m.role, content: m.content })) }) });
    CHAT.msgs.push({ role: "assistant", content: r.antwort, refs: r.refs, modell: r.modell, usage: r.usage, werkzeuge: r.werkzeuge,
      dauer_s: r.dauer_s, cached: r.cached, cached_at: r.cached_at });
  } catch (e) {
    CHAT.msgs.push({ role: "assistant", content: e.message, error: true });
  } finally {
    CHAT.busy = false; chatSave(); renderChat();
  }
}
// ------------------------------------------------------------------ Fachontologie zum Lesen (v61.2, /api/onto/*)
async function loadOnto(force = false) {
  if (!state.onto || force) {
    const seq = listLoading("onto");
    let res;
    try { res = await api("/api/onto/tree"); } catch (e) { if (isSeq("onto", seq)) { listDone("onto"); toast(e.message, true); } return; }
    if (!isSeq("onto", seq)) return;
    listDone("onto");
    state.onto = res;
    state.ontoIdx = Object.fromEntries(res.classes.map((c) => [c.id, c]));
    if (state.tab !== "onto") return;
  }
  renderOntoList();
  if (!state.onto.classes.length) {
    $("detail").replaceChildren(h("div", { class: "card" }, h("h2", { text: t("Keine Fachontologie") }),
      h("p", { class: "muted", text: t("Weder out/ontology/klassen_knoten.json noch knowledge/ontology.yaml gefunden – die Ontologie entsteht im Ontologie-Curator (Schritt „Ontologie“ der Job-Steuerung).") })));
    return;
  }
  const sel = state.ontoSel && state.ontoIdx[state.ontoSel] ? state.ontoSel : null;
  if (sel) renderOnto(sel); else if (!state.node) renderOntoOverview();
}
async function openOnto(id) {
  state.ontoSel = id;
  if (state.tab !== "onto") setTab("onto"); else renderOnto(id);
}
function ontoTitle(c) { return c.de || c.en || c.id; }
function renderOntoList() {
  if (state.tab !== "onto" || !state.onto) return;
  const q = $("oq").value.trim().toLowerCase(), sv = $("o-sicht").value;
  const kids = {};
  for (const c of state.onto.classes) (kids[c.oberklasse || ""] = kids[c.oberklasse || ""] || []).push(c);
  const hay = (c) => `${c.de} ${c.en} ${c.id}`.toLowerCase();
  const match = (c) => !q || hay(c).includes(q) || (kids[c.id] || []).some(match);
  const items = [];
  let n = 0;
  const walk = (c, depth) => {
    if (!match(c)) return;
    n += 1;
    const sel = state.ontoShown && state.ontoSel === c.id;
    items.push(h("li", { role: "option", tabindex: "0", "aria-selected": String(sel), class: "onto-li", style: `padding-left:${12 + depth * 16}px`,
      onclick: () => renderOnto(c.id), onkeydown: (e) => { if (e.key === "Enter") renderOnto(c.id); } },
      h("span", { class: "r-title", text: ontoTitle(c) }),
      c.knoten_gesamt ? h("span", { class: "muted small", title: t("Knoten des Graphen (mit Unterklassen)"), text: ` ${c.knoten_gesamt}` }) : null,
      c.status && c.status !== "bestaetigt" ? h("span", { class: "pill ro mini", text: c.status }) : null));
    for (const k of kids[c.id] || []) walk(k, depth + 1);
  };
  for (const g of ["fachlich", "technisch", "offen"]) {
    if (sv && sv !== g) continue;
    const roots = (kids[""] || []).filter((c) => (c.sicht || "offen") === g && match(c));
    if (!roots.length) continue;
    items.push(h("li", { class: "group-head", role: "presentation" }, g === "offen" ? t("Sicht offen") : SICHT_TITLE()[g]));
    for (const r of roots) walk(r, 0);
  }
  $("result-info").textContent = t("{n} Klassen", { n }) + (state.onto.source ? ` · ${state.onto.source}` : "");
  $("results").setAttribute("role", "listbox");
  $("results").replaceChildren(...items);
}
function renderOntoOverview() {
  $("detail").dataset.maske = "ontologie";                 // Handbuch: passendes Kapitel (handbuch.js)
  const o = state.onto, cnt = o.counts || {};
  $("detail").replaceChildren(h("div", { class: "node-head" }, h("h1", { text: t("Fachontologie") }),
    h("div", { class: "meta" }, h("span", { text: t("{n} Klassen", { n: o.classes.length }) }), h("span", { text: t("{n} Eigenschaften", { n: o.props }) }),
      ...["fachlich", "technisch"].map((k) => cnt[k] ? [sichtPill(k), h("span", { text: String(cnt[k]) })] : null),
      cnt.offen ? h("span", { class: "pill ro", text: t("Sicht offen: {n}", { n: cnt.offen }) }) : null, h("span", { class: "mono", text: o.source }))),
    h("div", { class: "card" }, h("p", { text: t("Die Fachontologie trennt die fachliche Sicht (rechtlich und operativ: Dokumente, Vorgänge, Verfahren, Akteure) von der technischen Sicht (IT: Nachrichten, Datenelemente, Codelisten, Dienste). Zwischen den Sichten gibt es nur Brücken-Eigenschaften, z. B. Bestellung „wird übermittelt als“ Bestellung (Nachricht).") }),
      h("p", { class: "muted small", text: t("Links eine Klasse wählen. Nur lesen – bearbeitet wird die Ontologie im Ontologie-Curator.") })));
}
function ontoLink(r) {
  if (!r) return null;
  return [h("button", { type: "button", class: "link", onclick: () => renderOnto(r.id) }, r.title), r.sicht ? [" ", sichtPill(r.sicht, null, true)] : null];
}
async function renderOnto(id, offset = 0) {
  $("detail").dataset.maske = "ontologie";                 // Handbuch: passendes Kapitel (handbuch.js)
  state.ontoSel = id; state.ontoShown = true;
  renderOntoList();
  detailLoading(true);
  let c;
  try { c = await api(`/api/onto/class?${new URLSearchParams({ id, offset: String(offset) })}`); }
  catch (e) { toast(e.message, true); return; } finally { detailLoading(false); }
  if (state.ontoSel !== id || state.tab !== "onto") return;
  const row = (label, v) => v && (!Array.isArray(v) || v.length) ? h("tr", {}, h("th", { text: label }), h("td", { text: Array.isArray(v) ? v.join(" · ") : v })) : null;
  const propLi = (p, dir) => h("li", {}, dir === "out" ? [`${p.de || p.en} → `, ontoLink(p.nach)] : [ontoLink(p.von), ` ${p.de || p.en} → ${c.de || c.en}`],
    p.bruecke ? [" ", h("span", { class: "pill sicht s-bruecke mini", title: t("Brücke zwischen den Sichten"), text: t("Brücke") })] : null);
  const props = [...c.props_from.map((p) => propLi(p, "out")), ...c.props_to.map((p) => propLi(p, "in"))];
  const pg = c.members_total > 100 ? h("div", { class: "actions-row" },
    h("button", { type: "button", class: "small", disabled: c.offset <= 0, onclick: () => renderOnto(id, Math.max(0, c.offset - 100)) }, t("‹ zurück")),
    h("span", { class: "muted small", text: `${c.offset + 1}–${Math.min(c.members_total, c.offset + 100)} / ${c.members_total}` }),
    h("button", { type: "button", class: "small", disabled: c.offset + 100 >= c.members_total, onclick: () => renderOnto(id, c.offset + 100) }, t("weiter ›"))) : null;
  $("detail").replaceChildren(
    h("div", { class: "node-head" },
      c.ancestors.length ? h("div", { class: "crumbs small" }, ...c.ancestors.flatMap((a) => [h("button", { type: "button", class: "link", onclick: () => renderOnto(a.id) }, a.title), " › "]), c.de || c.en) : null,
      h("h1", { text: c.de || c.en }),
      h("div", { class: "meta" }, h("span", { class: "pill type", text: t("Klasse") }), sichtPill(c.sicht, c.eigene_sicht ? null : "geerbt"),
        c.en && c.de ? h("span", { text: c.en }) : null, h("span", { class: "mono", text: c.id }),
        c.status && c.status !== "bestaetigt" ? h("span", { class: "pill ro", text: c.status }) : null)),
    h("div", { class: "card" }, h("h2", { text: t("Bedeutung") }),
      c.definition_de || c.definition_en ? [c.definition_de ? h("p", { text: c.definition_de }) : null, c.definition_en ? h("p", { class: "muted", lang: "en", text: c.definition_en }) : null]
        : h("p", { class: "muted", text: t("ohne Definition") }),
      h("table", { class: "props view-props" }, h("tbody", {}, row(t("Synonyme"), c.synonyme_de), row(t("Synonyme englisch"), c.synonyme_en), row(t("Abkürzungen"), c.abkuerzungen)))),
    h("div", { class: "card" }, h("h2", { text: t("Unterklassen ({n})", { n: c.children.length }) }),
      c.children.length ? h("ul", { class: "plain" }, ...c.children.map((x) => h("li", {}, ontoLink(x)))) : h("div", { class: "muted", text: "–" })),
    h("div", { class: "card" }, h("h2", { text: t("Eigenschaften ({n})", { n: props.length }) }),
      props.length ? h("ul", { class: "plain" }, ...props) : h("div", { class: "muted", text: "–" }),
      c.props_inherited.length ? h("details", {}, h("summary", { class: "small", text: t("geerbt von Oberklassen ({n})", { n: c.props_inherited.length }) }),
        h("ul", { class: "plain small" }, ...c.props_inherited.map((p) => h("li", {}, ontoLink(p.von), ` ${p.de || p.en} → `, ontoLink(p.nach))))) : null),
    h("div", { class: "card" }, h("h2", { text: t("In der anderen Sicht ({n})", { n: c.andere_sicht.length }) }),
      c.andere_sicht.length ? h("ul", { class: "plain" }, ...c.andere_sicht.map((x) => h("li", {}, ontoLink(x), h("span", { class: "muted small", text: ` ${t("über")} ${x.via}` }))))
        : h("div", { class: "muted", text: c.sicht ? "–" : t("Klasse ohne Sicht") })),
    h("div", { class: "card" }, h("h2", { text: t("Knoten des Graphen ({n})", { n: c.members_total }) }),
      h("div", { class: "muted small", text: (c.members_sub ? t("dazu {n} in Unterklassen · ", { n: c.members_sub }) : "") + t("„~“ = über Oberbegriffe abgeleitet") }), pg,
      c.members.length ? h("ul", { class: "plain" }, ...c.members.map((m) => h("li", {},
        m.missing ? h("span", { class: "mono muted", text: m.id }) : h("button", { type: "button", class: "link", onclick: () => { setTab("nodes"); openNode(m.id, { label: m.editable === false ? m.label : null }); } }, m.title),
        m.direct ? null : " ~", m.doc ? [" ", docBadge({ doc: m.doc })] : null, m.label ? h("span", { class: "muted small", text: ` ${m.label}` }) : null)))
        : h("div", { class: "muted", text: "–" })));
  $("detail").scrollTop = 0;
}
// ------------------------------------------------------------------ Metamodell (Knoten- und Beziehungstypen, curator/metamodel.yaml)
async function loadMeta(force = false) {
  if (!state.meta || force) {
    const seq = listLoading("meta");
    let res;
    try { res = await api("/api/metamodel"); } catch (e) { if (isSeq("meta", seq)) { listDone("meta"); toast(e.message, true); } return; }
    if (!isSeq("meta", seq)) return;
    listDone("meta");
    state.meta = res;
    state.metaIdx = { node: {}, rel: {} };
    for (const n of state.meta.nodes) state.metaIdx.node[n.id] = n;
    for (const r of state.meta.relations) state.metaIdx.rel[r.id] = r;
    if (state.tab !== "meta") return;
  }
  renderMetaList();
  const sel = state.metaSel && state.metaIdx[state.metaSel.kind][state.metaSel.id] ? state.metaSel
    : { kind: "node", id: (state.meta.nodes.find((n) => n.count && n.curatable) || state.meta.nodes.find((n) => n.count) || state.meta.nodes[0] || {}).id };
  if (sel.id) renderMeta(sel.kind, sel.id);
}
async function openMeta(kind, id) {
  state.metaSel = { kind, id };
  if (state.tab !== "meta") setTab("meta");       // lädt und zeigt state.metaSel
  else if (state.meta) renderMeta(kind, id);
}
function metaMatches(x, q) {
  if (!q) return true;
  const hay = [x.id, L(x.title), L(x.description), L(x.example)].filter(Boolean).join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}
function metaItem(kind, x) {
  const sel = state.metaShown && state.metaSel && state.metaSel.kind === kind && state.metaSel.id === x.id;
  return h("li", {
    role: "option", tabindex: "0", "aria-selected": String(!!sel), class: x.count ? null : "unused",
    onclick: () => renderMeta(kind, x.id), onkeydown: (e) => { if (e.key === "Enter") renderMeta(kind, x.id); },
  }, h("div", { class: "r-title", text: L(x.title) }),
     h("div", { class: "r-meta" }, h("span", { class: kind === "rel" ? "pill type rel-type" : "pill type", text: kind === "rel" ? `:${x.id}` : x.id }),
       h("span", { text: x.count ? t("{n}×", { n: x.count }) : t("nicht im Graphen") }),
       x.described ? null : h("span", { class: "pill ro", text: t("ohne Beschreibung") })));
}
function renderMetaList() {
  if (state.tab !== "meta" || !state.meta) return;
  const q = $("mq").value.trim(), kind = $("m-kind").value, used = $("m-used").checked;
  const keep = (x) => metaMatches(x, q) && (!used || x.count);
  const items = [];
  let n = 0;
  for (const g of state.meta.groups) {
    const ns = kind === "rel" ? [] : state.meta.nodes.filter((x) => x.group === g.id && keep(x));
    const rs = kind === "node" ? [] : state.meta.relations.filter((x) => x.group === g.id && keep(x));
    if (!ns.length && !rs.length) continue;
    items.push(h("li", { class: "group-head", role: "presentation", text: L(g.title) }));
    if (ns.length && rs.length) items.push(h("li", { class: "sub-head", role: "presentation", text: t("Knotentypen") }));
    items.push(...ns.map((x) => metaItem("node", x)));
    if (ns.length && rs.length) items.push(h("li", { class: "sub-head", role: "presentation", text: t("Beziehungstypen") }));
    items.push(...rs.map((x) => metaItem("rel", x)));
    n += ns.length + rs.length;
  }
  $("result-info").textContent = t("{n} Typen", { n });
  $("results").setAttribute("role", "listbox");
  $("results").replaceChildren(...items);
}
function exampleBox(ex) {
  if (!ex) return null;
  return h("div", { class: "example" }, h("div", { class: "example-head", text: t("Beispiel") }),
    h("div", { class: "example-text", text: L(ex) }), relExampleSvg(L(ex)));
}
function metaTitle(kind, id) {
  const x = state.metaIdx[kind][id];
  return x ? L(x.title) : id;
}
function typeLink(id) {
  if (id === "?") return h("span", { class: "muted", title: t("Endknoten im Speicher nicht geladen (Demo)"), text: t("? (nicht geladen)") });
  if (!state.metaIdx.node[id]) return h("span", { class: "mono", text: id });
  return h("button", { type: "button", class: "link", title: metaTitle("node", id), onclick: () => renderMeta("node", id) }, id);
}
function relLink(id) {
  return h("button", { type: "button", class: "link mono", title: metaTitle("rel", id), onclick: () => renderMeta("rel", id) }, `:${id}`);
}
function patternTable(rows, cols) {
  if (!rows.length) return h("div", { class: "muted small", text: t("keine im Graphen") });
  return h("div", { class: "table-wrap" }, h("table", { class: "paths" },
    h("thead", {}, h("tr", {}, ...cols.map((c) => h("th", { class: c.num ? "num" : null, text: c.title })))),
    h("tbody", {}, ...rows.map((r) => h("tr", {}, ...cols.map((c) => h("td", { class: c.num ? "num" : null }, c.cell(r))))))));
}
function renderMeta(kind, id) {
  $("detail").dataset.maske = "metamodell";                 // Handbuch: passendes Kapitel (handbuch.js)
  const x = state.metaIdx[kind][id];
  if (!x) return;
  state.metaSel = { kind, id }; state.metaShown = true;
  renderMetaList();
  const grp = state.meta.groups.find((g) => g.id === x.group);
  const meta = [h("span", { class: kind === "rel" ? "pill type rel-type" : "pill type", text: kind === "rel" ? `:${x.id}` : x.id }),
    grp ? h("span", { text: L(grp.title) }) : null,
    h("span", { text: x.count ? t("{n}× im Graphen", { n: x.count }) : t("nicht im Graphen") }),
    x.curatable ? h("span", { class: "pill st-confirmed", text: kind === "rel" ? t("Zuordnung prüfbar") : t("bearbeitbar") }) : h("span", { class: "pill ro", text: t("nur lesen") }),
    x.linkable ? h("span", { class: "pill st-curated", text: t("im Curator anlegbar") }) : null];
  const parts = [h("div", { class: "node-head" }, h("h1", { text: L(x.title) }), h("div", { class: "meta" }, ...meta))];
  parts.push(h("div", { class: "card" }, h("h2", { text: t("Bedeutung") }),
    x.description ? h("p", { class: "meta-desc", text: L(x.description) }) : h("p", { class: "muted", text: t("Ohne Beschreibung – Eintrag in curator/metamodel.yaml ergänzen.") }),
    exampleBox(x.example)));
  if (kind === "node") {
    const outs = x.out, ins = x.in;
    if (outs.length || ins.length) parts.push(h("div", { class: "card" }, h("h2", { text: t("Beziehungen dieses Typs") }), egoSvg(x)));
    parts.push(h("div", { class: "card" }, h("h2", { text: t("Ausgehende Beziehungen") }),
      patternTable(outs, [{ title: t("Beziehung"), cell: (r) => relLink(r.rel) }, { title: t("zu Typ"), cell: (r) => typeLink(r.to) },
        { title: t("Anzahl"), num: true, cell: (r) => String(r.count) }])));
    parts.push(h("div", { class: "card" }, h("h2", { text: t("Eingehende Beziehungen") }),
      patternTable(ins, [{ title: t("von Typ"), cell: (r) => typeLink(r.from) }, { title: t("Beziehung"), cell: (r) => relLink(r.rel) },
        { title: t("Anzahl"), num: true, cell: (r) => String(r.count) }])));
    if (x.editable.length) parts.push(h("div", { class: "card" }, h("h2", { text: t("Im Curator bearbeitbare Felder") }),
      h("ul", { class: "plain" }, ...x.editable.map((f) => h("li", {}, h("span", { class: "mono", text: f.prop }), f.label ? ` – ${L(f.label)}` : "",
        f.type ? h("span", { class: "muted small", text: ` (${f.type})` }) : null)))));
    const searchable = (state.config.labels || {})[x.id] || (state.config.search_readonly || []).includes(x.id);
    if (searchable && x.count) parts.push(h("div", { class: "card" }, h("button", { type: "button", onclick: () => {
      $("f-type").value = x.id; storage("curator.type", x.id); $("q").value = ""; setTab("nodes"); search();
    } }, t("Knoten dieses Typs suchen"))));
  } else {
    parts.push(h("div", { class: "card" }, h("h2", { text: t("Verwendung im Graphen") }),
      patternTable(x.patterns, [{ title: t("von Typ"), cell: (r) => typeLink(r.from) }, { title: t("Beziehung"), cell: () => h("span", { class: "mono", text: `:${x.id}` }) },
        { title: t("zu Typ"), cell: (r) => typeLink(r.to) }, { title: t("Anzahl"), num: true, cell: (r) => String(r.count) }])));
    if (x.curatable || x.linkable) parts.push(h("div", { class: "muted small", text: x.linkable
      ? t("Diese Beziehung kann im Curator zwischen Begriffen angelegt, geprüft und in eine andere Art geändert werden.")
      : t("Vorschläge dieser Beziehung werden im Reiter „Beziehungsvorschläge“ bestätigt oder abgelehnt.") }));
  }
  if (state.meta.markers.length && kind === "node") parts.push(h("details", { class: "card" }, h("summary", { text: t("Kennzeichen (zusätzliche Labels)") }),
    h("ul", { class: "plain" }, ...state.meta.markers.map((m) => h("li", {}, h("span", { class: "pill type", text: m.id }), " ",
      h("strong", { text: L(m.title) }), m.count ? h("span", { class: "muted small", text: ` ${t("{n}×", { n: m.count })}` }) : null,
      h("div", { class: "small", text: L(m.description) }), m.example ? h("div", { class: "muted small", text: `${t("Beispiel")}: ${L(m.example)}` }) : null)))));
  $("detail").replaceChildren(...parts);
  $("detail").scrollTop = 0;
}

// --- kleine Diagramme (SVG, ohne Bibliothek; Texte als textContent)
const SVGNS = "http://www.w3.org/2000/svg";
function sv(tag, attrs = {}, text = null) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== null) el.textContent = text;
  return el;
}
function svgBox(g, x, y, w, label, cls = "") {
  g.append(sv("rect", { x, y, width: w, height: 26, rx: 6, class: `mm-box ${cls}` }));
  const txt = label.length > Math.floor(w / 7) ? label.slice(0, Math.floor(w / 7) - 1) + "…" : label;
  g.append(sv("text", { x: x + w / 2, y: y + 17, "text-anchor": "middle", class: "mm-label" }, txt));
}
function svgArrow(g, x1, y1, x2, y2, label, at = 0.5) {
  g.append(sv("line", { x1, y1, x2, y2, class: "mm-edge", "marker-end": "url(#mm-arrow)" }));
  if (label) g.append(sv("text", { x: x1 + (x2 - x1) * at, y: y1 + (y2 - y1) * at - 4, "text-anchor": "middle", class: "mm-rel" }, label));
}
function svgRoot(w, hgt, title) {
  const s = sv("svg", { viewBox: `0 0 ${w} ${hgt}`, width: w, class: "mm-svg", role: "img", "aria-label": title });
  const defs = sv("defs");
  const m = sv("marker", { id: "mm-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
  m.append(sv("path", { d: "M0,0 L10,5 L0,10 z", class: "mm-head" }));
  defs.append(m); s.append(defs);
  return s;
}
// „(Hörbuch)-[:BROADER]->(Medium)“, auch Ketten „(A)-[:X]->(B)-[:Y]->(C)“ und „(A)<-[:X]-(B)“
function relExampleSvg(text) {
  const m = String(text || "").match(/\(([^()]+)\)(?:\s*(<?)-\[:?([A-Z_a-z0-9]+)(?:\s*\{[^}]*\})?\]-(>?)\s*\(([^()]+)\))+/);
  if (!m) return null;
  const seq = [], rx = /\(([^()]+)\)|(<?)-\[:?([A-Z_a-z0-9]+)(\s*\{[^}]*\})?\]-(>?)/g;
  let k;
  while ((k = rx.exec(m[0]))) seq.push(k[1] !== undefined ? { box: k[1] } : { rel: k[3] + (k[4] ? " " + k[4].trim() : ""), back: k[2] === "<" });
  const boxes = seq.filter((x) => x.box).map((x) => x.box), rels = seq.filter((x) => x.rel);
  const bw = 150, gap = 130, W = boxes.length * bw + (boxes.length - 1) * gap + 20, H = 46;
  const s = svgRoot(W, H, text);
  boxes.forEach((b, i) => svgBox(s, 10 + i * (bw + gap), 10, bw, b));
  rels.slice(0, boxes.length - 1).forEach((r, i) => {
    const x1 = 10 + i * (bw + gap) + bw + 2, x2 = x1 + gap - 4;
    if (r.back) svgArrow(s, x2, 23, x1, 23, `:${r.rel}`); else svgArrow(s, x1, 23, x2, 23, `:${r.rel}`);
  });
  return h("div", { class: "mm-wrap" }, s);
}
// Typ in der Mitte, eingehende Beziehungen links, ausgehende rechts (je Nachbartyp, die häufigsten)
function egoSide(list, key) {
  const by = new Map();
  for (const r of list) {
    const k = r[key];
    if (!by.has(k)) by.set(k, { type: k, rels: [], count: 0 });
    const e = by.get(k); e.rels.push(r.rel); e.count += r.count;
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}
function egoSvg(x) {
  const MAX = 8;
  const insAll = egoSide(x.in, "from"), outsAll = egoSide(x.out, "to");
  const ins = insAll.slice(0, MAX), outs = outsAll.slice(0, MAX);
  const rows = Math.max(outs.length, ins.length, 1);
  const bw = 150, W = 820, H = rows * 40 + 20, cx = (W - bw) / 2, cy = H / 2 - 13;
  const s = svgRoot(W, H, x.id);
  const relText = (e) => { const t0 = e.rels.map((r) => `:${r}`).join(" "); return t0.length > 30 ? t0.slice(0, 29) + "…" : t0; };
  const side = (list, left) => list.forEach((e, i) => {
    const y = 10 + i * 40 + (rows - list.length) * 20;
    const bx = left ? 0 : W - bw;
    svgBox(s, bx, y, bw, e.type === "?" ? t("? (nicht geladen)") : e.type, e.type === x.id ? "mm-self" : "");
    if (left) svgArrow(s, bw + 2, y + 13, cx - 2, cy + 13, null);
    else svgArrow(s, cx + bw + 2, cy + 13, W - bw - 2, y + 13, null);
    const lbl = sv("text", { x: left ? bw + 6 : W - bw - 6, y: y + 8, class: `mm-rel ${left ? "mm-left" : "mm-right"}` }, relText(e));
    lbl.append(sv("title", {}, `${e.rels.map((r) => ":" + r).join(", ")} (${e.count})`));
    s.append(lbl);
  });
  side(ins, true); side(outs, false);
  svgBox(s, cx, cy, bw, x.id, "mm-center");
  const more = Math.max(0, insAll.length - MAX) + Math.max(0, outsAll.length - MAX);
  return h("div", { class: "mm-wrap" }, s, more ? h("div", { class: "muted small", text: t("{n} weitere Typen in den Tabellen", { n: more }) }) : null);
}
// ------------------------------------------------------------------ Regeln: Formen (SHACL, BPMN, ODRL) und Testfälle – nur Ansicht
const FORM_TABS = ["SHACL", "BPMN", "ODRL", "DMN", "TESTS"];
const ART_STATUS = tr({ "ausführbar": "ausführbar", "erzeugt": "erzeugt", "fehlt": "fehlt",
  "deaktiviert – nur gegen Vorgangsprotokoll prüfbar": "deaktiviert – nur gegen Vorgangsprotokoll prüfbar",
  "deaktiviert – keine Datenprüfung": "deaktiviert – keine Datenprüfung", "deaktiviert – Formalisierung fehlt": "deaktiviert – Formalisierung fehlt" });
const CASE_KIND = tr({ "gültig": "gültig", "verstoß": "Verstoß", "nicht betroffen": "nicht betroffen" });
const CASE_OUTCOME = tr({ "Meldung": "Meldung", "keine Meldung": "keine Meldung" });
function ruleFormsCard(n) {
  const card = h("div", { class: "card rule-forms" }, h("h2", { text: t("Formen und Testfälle") }), loadingEl());
  const cached = (state.ruleForms ||= {})[n.id];
  const fill = (d) => renderRuleForms(card, n, d);
  if (cached) fill(cached);
  else api(`/api/rule_forms?${new URLSearchParams({ id: n.id })}`).then((d) => { state.ruleForms[n.id] = d; if (state.node && state.node.id === n.id) fill(d); })
    .catch((e) => card.replaceChildren(h("h2", { text: t("Formen und Testfälle") }), h("div", { class: "muted", text: e.message })));
  return card;
}
function renderRuleForms(card, n, d) {
  const byForm = {};
  for (const a of d.artifacts) (byForm[a.form] ||= []).push(a);
  const tabs = FORM_TABS.filter((f) => f === "TESTS" ? true : byForm[f]);
  if (!d.artifacts.length && !d.tests.length) {
    card.replaceChildren(h("h2", { text: t("Formen und Testfälle") }),
      h("div", { class: "muted", text: t("Keine Formen erzeugt – va_pipeline/rule_forms.py und rule_tests.py ausführen.") }));
    return;
  }
  const cur = tabs.includes(state.ruleFormTab) ? state.ruleFormTab : tabs[0];
  const label = (f) => {
    if (f === "TESTS") return t("Testfälle ({n})", { n: d.tests.length });
    const as = byForm[f];
    const missing = as.every((a) => a.status === "fehlt");
    return missing ? t("{f} (fehlt)", { f }) : (as.length > 1 ? `${f} (${as.length})` : f);
  };
  const bar = h("div", { class: "tabs form-tabs", role: "tablist" }, ...tabs.map((f) => h("button", {
    type: "button", role: "tab", "aria-selected": String(f === cur),
    class: f !== "TESTS" && byForm[f].every((a) => a.status === "fehlt") ? "missing" : null,
    onclick: () => { state.ruleFormTab = f; renderRuleForms(card, n, d); } }, label(f))));
  const body = h("div", { class: "form-body" });
  if (cur === "TESTS") body.append(...testsView(d.tests));
  else for (const a of byForm[cur]) body.append(artifactView(a, d));
  card.replaceChildren(h("h2", { text: t("Formen und Testfälle") }),
    h("div", { class: "muted small", text: t("Erzeugt aus Formalisierung und Prozessmodell – nur Ansicht. Zielformalismen der Regel ohne Form erscheinen als „fehlt“.") }),
    bar, body);
}
function codeBlock(text) { return h("pre", { class: "code", tabindex: "0" }, h("code", { text })); }   // tabindex: scrollbar per Tastatur (BITV)
function artifactView(a, d) {
  const head = h("div", { class: "art-head" }, h("span", { class: `pill ${a.status === "fehlt" ? "rel-candidate" : a.status && a.status.startsWith("deaktiviert") ? "ro" : "st-confirmed"}`, text: ART_STATUS[a.status] || a.status || "" }),
    h("b", { text: a.title || a.form }), a.file && a.status !== "fehlt" ? h("span", { class: "muted small mono", text: a.file }) : null);
  if (a.status === "fehlt") return h("div", { class: "artifact" }, head, h("div", { class: "muted", text: a.summary || "" }));
  if (a.form === "SHACL") {
    const local = (a.ref || "").split(":").pop();
    return h("div", { class: "artifact" }, head,
      h("div", { class: "small", text: a.summary || "" }),
      h("div", { class: "small muted", text: t("{n} Prüfung(en)", { n: a.checks || 0 }) }),
      d.tests.length ? h("div", { class: "small" }, h("button", { type: "button", class: "link", onclick: () => { state.ruleFormTab = "TESTS"; renderDetail(); } },
        t("{n} Testfälle ansehen", { n: d.tests.length })),
        state.config.rules_page ? [" · ", h("a", { href: `/rules#${local}`, target: "_blank", rel: "noopener", text: t("in der Regel-Vorführung") })] : null) : null,
      codeBlock(a.snippet || ""));
  }
  if (a.form === "ODRL") {
    return h("div", { class: "artifact" }, head,
      h("div", { class: "odrl-sentence", text: a.summary || "" }),
      ...(a.notes || []).map((x) => h("div", { class: "small muted", text: `⚠ ${x}` })),
      h("details", {}, h("summary", { text: t("ODRL-Policy (JSON-LD)") }), codeBlock(a.snippet || "")));
  }
  if (a.form === "BPMN") {
    const box = h("div", { class: "bpmn-box" }, loadingEl(t("Diagramm lädt …")));
    const list = h("ul", { class: "bpmn-els" }, ...(a.elementIds || []).map((id, i) => h("li", {},
      h("button", { type: "button", class: "link", onclick: () => box._focus && box._focus(id) }, (a.elementNames || [])[i] || id),
      h("span", { class: "muted small mono", text: ` ${id} · ${(a.elementKinds || [])[i] || ""}` }))));
    const view = h("div", { class: "artifact" }, head, h("div", { class: "small", text: a.summary || "" }), list, box,
      h("div", { class: "small" }, h("a", { href: `/api/bpmn_xml?${new URLSearchParams({ file: a.bpmnFile })}`, download: a.bpmnFile, text: t("BPMN-Datei herunterladen") }),
        h("span", { class: "muted", text: t(" (z. B. im Camunda Modeler öffnen)") })));
    setTimeout(() => showBpmn(box, a), 0);
    return view;
  }
  if (a.form === "DMN" && a.decisionId) {
    const box = h("div", { class: "dmn-box" }, loadingEl(t("Entscheidungstabelle lädt …")));
    setTimeout(() => showDmn(box, a.decisionId), 0);
    return h("div", { class: "artifact" }, head, h("div", { class: "small", text: a.summary || "" }),
      h("div", { class: "small" }, t("Knoten") + ": ", nodeLink({ id: `${(state.node.id.split(":")[0])}:dmn:${a.decisionId}`, label: "DmnDecision", title: a.title })),
      box, h("div", { class: "small" }, h("a", { href: `/api/dmn_xml?${new URLSearchParams({ decision: a.decisionId })}`, download: a.dmnFile || `${a.decisionId}.dmn`, text: t("DMN-Datei herunterladen") })));
  }
  return h("div", { class: "artifact" }, head, h("div", { text: a.summary || "" }), a.snippet ? codeBlock(a.snippet) : null);
}
let bpmnJsLoading = null;
function loadBpmnJs() {
  if (window.BpmnJS) return Promise.resolve();
  if (bpmnJsLoading) return bpmnJsLoading;
  for (const css of ["diagram-js.css", "bpmn-js.css"]) document.head.append(h("link", { rel: "stylesheet", href: `${ASSET}vendor/bpmn-js/${css}` }));
  bpmnJsLoading = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = ASSET + "vendor/bpmn-js/bpmn-navigated-viewer.production.min.js";
    s.onload = res; s.onerror = () => { bpmnJsLoading = null; rej(new Error(t("BPMN-Viewer konnte nicht geladen werden"))); };
    document.head.append(s);
  });
  return bpmnJsLoading;
}
// ------------------------------------------------------------------ Regeln: Umsetzbarkeit im Code (Regelsteckbrief)
const STAGE_DE = tr({ formalisiert: "formalisiert", umsetzbar: "umsetzbar", fast: "fast umsetzbar", unklar: "unklar", "keine Regel": "keine Regel" });
function stagePill(st) { return h("span", { class: `pill stage-${(st || "").replace(/\s+/g, "-")}`, text: STAGE_DE[st] || st }); }
function readinessCard(n) {
  const card = h("details", { class: "card readiness", open: state.display.readinessOpen !== false },
    h("summary", { text: t("Umsetzbarkeit im Code") }), loadingEl());
  card.addEventListener("toggle", () => { state.display.readinessOpen = card.open; });
  api(`/api/rule_readiness?${new URLSearchParams({ id: n.id })}`).then((r) => { if (state.node && state.node.id === n.id) renderReadiness(card, r); })
    .catch((e) => card.replaceChildren(h("summary", { text: t("Umsetzbarkeit im Code") }), h("div", { class: "muted", text: e.message })));
  return card;
}
function renderReadiness(card, r) {
  const f = r.facets;
  const ok = (v) => v === null || v === undefined ? h("span", { class: "muted", text: "–" })
    : h("span", { class: v ? "ok-mark" : "no-mark", text: v ? "✓" : "✗" });
  const links = (xs) => xs.length ? xs.flatMap((x, i) => [i ? ", " : "", nodeLink(x)]) : [h("span", { class: "muted", text: t("keine") })];
  const need = (k) => r.needs.includes(k) ? h("span", { class: "muted small", text: ` (${t("nötig")})` }) : null;
  // offene Vorschläge (anchor_rules.py): hier nur zeigen, bestätigen in der Beziehungsliste bzw. den Beziehungsvorschlägen
  const props = (xs) => xs && xs.length ? h("div", { class: "small proposals-line" }, h("span", { class: "pill rel-candidate", text: t("Vorschlag") }), " ",
    ...xs.flatMap((x, i) => [i ? ", " : "", nodeLink(x)])) : null;
  const rows = [
    [t("Wo greift sie?"), "trigger", [...f.trigger.items.flatMap((x, i) => [i ? "; " : "", nodeLink(x.node),
      x.bpmn.length ? h("span", { class: "muted small" }, " → ", ...links(x.bpmn)) : h("span", { class: "muted small", text: ` (${t("kein BPMN-Element")})` })]),
      ...(f.trigger.enforced.length ? [h("div", { class: "small" }, t("umgesetzt von") + ": ", ...links(f.trigger.enforced))] : []),
      ...(!f.trigger.items.length && !f.trigger.enforced.length ? [h("span", { class: "muted", text: t("keine Aktivität / kein Ereignis") })] : []),
      props(f.trigger.proposals)]],
    [t("Worauf bezieht sie sich?"), "target", [
      f.target.items.length ? h("div", {}, t("Zielklasse") + ": ", ...f.target.items.slice(0, 4).flatMap((x, i) => [i ? ", " : "",
        nodeLink(x.node), h("span", { class: "muted small", text: ` ${x.node.context ? "(" + x.node.context + ") " : ""}${t("{a} Attribute, {p} Teilobjekte", { a: x.attributes, p: x.parts })}` })]))
        : h("div", { class: "muted", text: t("keine Zielklasse") }),
      f.target.concepts.length ? h("div", { class: "small" }, t("Begriffe") + ": ", ...f.target.concepts.flatMap((c, i) => [i ? "; " : "", nodeLink(c.node),
        c.via ? h("span", { class: "muted small", text: ` ${t("über")} ${c.via.title}` }) : null,
        c.domain.length ? h("span", { class: "muted small", text: ` → ${c.domain.length} DDD` }) : h("span", { class: "no-mark small", text: ` → ${t("kein Domänenobjekt")}` })]))
        : null, props(f.target.proposals)]],
    [t("Welche Daten?"), "data", [f.data.paths.length ? h("div", {}, ...f.data.paths.flatMap((x, i) => [i ? ", " : "",
      h("code", { text: x.path }), h("span", { class: "muted small", text: ` (${x.target}${x.part ? ", " + t("Teilobjekt") : ""})` })]))
      : h("span", { class: "muted", text: t("kein Attribut der Zielklasse im Regeltext") })]],
    [t("Wer?"), "role", [...links(f.role.items), props(f.role.proposals)]],
    [t("Bis wann?"), "deadline", [f.deadline.ok === null || f.deadline.ok === undefined ? h("span", { class: "muted", text: t("keine Frist") })
      : h("span", { text: `${f.deadline.text || "–"}${f.deadline.days ? " · " + t("{d} Tage", { d: f.deadline.days }) : ""}${f.deadline.reference ? "" : " · " + t("ohne Bezugsereignis")}` })]],
  ];
  const tbl = h("table", { class: "props readiness-tbl" }, h("tbody", {}, ...rows.map(([q, k, val]) =>
    h("tr", {}, h("td", {}, q, need(k)), h("td", { class: "mark" }, ok(f[k].ok)), h("td", {}, ...val)))));
  const blocking = r.gaps.filter((x) => x.severity === "blocking"), hints = r.gaps.filter((x) => x.severity === "hint");
  const gapList = (xs, cls) => h("ul", { class: `gaps ${cls}` }, ...xs.map((x) => h("li", {}, x.text,
    x.node && x.node.id !== r.id ? h("span", {}, " – ", nodeLink(x.node)) : null)));
  const parts = [h("summary", { text: t("Umsetzbarkeit im Code") }),
    h("div", { class: "meta" }, stagePill(r.stage), h("span", { class: "muted small", text: r.kind || "" }),
      r.formalizations ? h("span", { class: "muted small", text: t("{n} Formalisierung(en) in knowledge/rule_formal", { n: r.formalizations }) }) : null),
    tbl];
  if (blocking.length) parts.push(h("h3", { text: t("Was fehlt ({n})", { n: blocking.length }) }), gapList(blocking, "blocking"));
  if (hints.length) parts.push(h("h3", { text: t("Hinweise") }), gapList(hints, "hint"));
  if (r.draft) {
    const json = JSON.stringify(r.draft, null, 1);
    const copy = h("button", { type: "button", class: "small" }, t("Kopieren"));
    copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(json); toast(t("Entwurf kopiert")); } catch (e) { toast(e.message, true); } });
    const dl = h("a", { href: URL.createObjectURL(new Blob([json], { type: "application/json" })), download: `${r.section}_${r.rule}_entwurf.json`, text: t("herunterladen") });
    parts.push(h("h3", { text: t("Entwurf der Formalisierung") }),
      h("div", { class: "muted small", text: t("Prüfen, Platzhalter „?“ füllen und in knowledge/rule_formal/{s}.json unter formalizations übernehmen; danach rules_to_shacl.py, rule_forms.py, ddd/gen_java.py.", { s: r.section }) }),
      h("div", { class: "small" }, copy, " ", dl), codeBlock(json));
  }
  card.replaceChildren(...parts);
}
function readinessOverviewCard(docId) {
  const body = h("div", {}, loadingEl());
  const card = h("details", { class: "card", open: true }, h("summary", { text: t("Regeln: Umsetzbarkeit im Code") }),
    h("div", { class: "small", text: t("Was fehlt den Regeln, damit sie sich als Prüfung abbilden lassen? Klick auf eine Stufe bzw. Lücke filtert; die Lücke nennt den Knoten, an dem sie sich schließen lässt.") }), body);
  let data = null, fStage = storage("curator.rrStage") ?? "fast", fGap = "", page = 0;
  const PAGE_RR = 100;
  const render = () => {
    const sm = data.summary;
    const btn = (label, active, on) => h("button", { type: "button", class: `small${active ? " primary" : ""}`, onclick: on }, label);
    const stages = h("div", { class: "rr-filter" }, btn(t("alle ({n})", { n: sm.rules }), !fStage, () => { fStage = ""; page = 0; storage("curator.rrStage", ""); render(); }),
      ...Object.entries(sm.stages).map(([k, v]) => btn(`${STAGE_DE[k] || k} (${v})`, fStage === k, () => { fStage = k; page = 0; storage("curator.rrStage", k); render(); })));
    const gaps = h("div", { class: "rr-filter" }, h("span", { class: "muted small", text: t("Lücken") + ": " }),
      btn(t("alle"), !fGap, () => { fGap = ""; page = 0; render(); }),
      ...Object.entries(sm.blocking_gaps).map(([k, v]) => btn(`${data.gap_titles[k] || k} (${v})`, fGap === k, () => { fGap = k; page = 0; render(); })));
    const rows = data.rules.filter((r) => (!fStage || r.stage === fStage) && (!fGap || r.gaps.some((x) => x.code === fGap)));
    const tbl = h("div", { class: "table-wrap" }, h("table", { class: "paths review" },
      h("thead", {}, h("tr", {}, ...[t("Regel"), t("Art"), t("Stufe"), t("Was fehlt")].map((x) => h("th", { text: x })))),
      h("tbody", {}, ...rows.slice(page * PAGE_RR, (page + 1) * PAGE_RR).map((r) => h("tr", {},
        h("td", {}, nodeLink({ id: r.id, title: `${r.section} ${r.rule}: ${r.statement}`, editable: true })),
        h("td", { class: "small", text: r.rule_type }), h("td", {}, stagePill(r.stage), r.draft ? h("span", { class: "muted small", title: t("Entwurf der Formalisierung vorhanden"), text: " ✎" }) : null),
        h("td", { class: "small" }, ...r.gaps.flatMap((x, i) => [i ? h("br") : null, x.text, x.node && x.node.id !== r.id ? h("span", {}, " – ", nodeLink(x.node)) : null])))))));
    page = Math.min(page, Math.max(0, Math.ceil(rows.length / PAGE_RR) - 1));
    const pg = () => pagerEl(rows.length, page, PAGE_RR, (p) => { page = p; render(); card.scrollIntoView({ block: "start" }); });
    body.replaceChildren(...[stages, gaps, h("div", { class: "muted small", text: tp(rows.length, "1 Regel", "{n} Regeln") }), pg(), tbl, pg()].filter(Boolean));
  };
  api(`/api/rule_readiness/overview?${new URLSearchParams({ doc: docId })}`).then((d) => { data = d; render(); })
    .catch((e) => body.replaceChildren(h("div", { class: "muted", text: e.message })));
  return card;
}
// ------------------------------------------------------------------ Domänenmodell ↔ Prozesse und Regeln (je Bounded Context)
const daParts = () => [["activities", t("Aktivitäten")], ["events", t("Ereignisse")], ["concepts", t("Begriffe")], ["rules", t("Regeln")]];
function dddAlignmentCard(docId, contextId = null) {
  const title = t("Domänenmodell ↔ Prozesse und Regeln");
  const body = h("div", {}, loadingEl());
  const card = h("details", { class: "card ddd-align", open: contextId ? true : state.display.dddAlignOpen === true }, h("summary", { text: title }),
    h("div", { class: "small", text: t("Von oben nach unten je Bounded Context: was die Kapitel beschreiben (Aktivitäten, Ereignisse, Begriffe, Regeln) und ob das Domänenmodell es abbildet. „Vorschlag“: Verknüpfung zum Bestätigen am Domänenelement (Beziehungsvorschläge, „abgeleitet aus“). Vorschläge für knowledge/domain_model.yaml: ddd/align_ddd.py.") }), body);
  let data = null, sel = contextId || storage("curator.daCtx") || "", part = storage("curator.daPart") || "activities";
  const pct = (c, n) => (n ? Math.round((100 * c) / n) : null);
  const bar = (v) => h("span", { class: "nowrap" }, h("span", { class: "da-bar" }, h("span", { style: `width:${v || 0}%` })), h("b", { class: "small", text: v === null ? " –" : ` ${v} %` }));
  const cell = (p) => h("td", { class: "small nowrap" }, `${p.covered}/${p.total}`, p.proposed ? h("span", { class: "muted", title: t("Vorschläge zum Bestätigen"), text: ` +${p.proposed}` }) : null);
  const item = (m) => h("li", {}, nodeLink(m), m.uses ? h("span", { class: "muted small", text: ` (${m.uses})` }) : null,
    m.stage ? h("span", {}, " ", stagePill(m.stage)) : null,
    m.kind ? h("span", { class: "muted small", text: ` ${m.kind}` }) : null,
    m.proposal ? h("span", { class: "small" }, " – ", t("Vorschlag") + ": ", nodeLink(m.proposal)) : null,
    m.by ? h("span", { class: "small muted" }, " ← ", ...m.by.flatMap((b, i) => [i ? ", " : "", nodeLink(b)])) : null);
  const col = (head, items, total) => h("div", { class: "da-col" }, h("h3", { text: `${head} (${total ?? items.length})` }),
    items.length ? growList(h("ul", { class: "da-list" }), items, item, 100) : h("div", { class: "muted small", text: "–" }));
  const detail = (c) => {
    const p = c[part];
    const tabs = h("div", { class: "tabs form-tabs", role: "tablist" }, ...daParts().map(([k, lab]) => h("button", { type: "button", role: "tab",
      "aria-selected": String(k === part), onclick: () => { part = k; storage("curator.daPart", k); render(); } }, `${lab} ${c[k].covered}/${c[k].total}`)));
    const covered = (p.covered_items || []).map((x) => ({ ...x.node, by: x.by }));
    const only = part === "activities" ? c.only_ddd.filter((x) => x.kind === "Command") : part === "events" ? c.only_ddd.filter((x) => x.kind === "DomainEvent")
      : part === "concepts" ? c.only_ddd.filter((x) => x.kind === "AggregateRoot" || x.kind === "Entity") : [];
    return h("div", { class: "da-detail" }, h("h3", {}, nodeLink(c.context), h("span", { class: "muted small", text: ` – ${t("Kapitel")} ${c.chapters.join(", ") || "–"}, ${tp(c.elements, "1 Element", "{n} Elemente")}` })),
      tabs, h("div", { class: "da-cols" },
        col(t("abgedeckt"), part === "rules" ? [] : covered, p.covered),
        col(t("fehlt im Domänenmodell"), p.missing, p.total - p.covered),
        col(t("nur im Domänenmodell"), only)),
      part === "rules" ? h("div", { class: "muted small", text: t("Regeln gelten als abgedeckt, wenn sie formalisiert oder umsetzbar sind (Regelsteckbrief).") }) : null);
  };
  const render = () => {
    const ctxs = data.contexts.filter((c) => c.coverage !== null || c.elements);
    const sm = data.summary;
    const head = h("div", { class: "small" }, ...daParts().flatMap(([k, lab], i) => [i ? " · " : "", `${lab}: ${sm[k].covered}/${sm[k].total}`,
      sm[k].proposed ? h("span", { class: "muted", text: ` (+${sm[k].proposed} ${t("Vorschlag")})` }) : ""]));
    const cur = ctxs.find((c) => c.context.id === sel) || (contextId ? ctxs[0] : null);
    const tbl = contextId ? null : h("div", { class: "table-wrap" }, h("table", { class: "paths review" },
      h("thead", {}, h("tr", {}, ...[t("Bounded Context"), t("Abdeckung"), ...daParts().map(([, l]) => l), t("nur im Domänenmodell")].map((x) => h("th", { text: x })))),
      h("tbody", {}, ...ctxs.map((c) => h("tr", { class: cur && cur.context.id === c.context.id ? "sel" : "", style: "cursor:pointer",
        onclick: (e) => { if (e.target.closest("a")) return; sel = c.context.id; storage("curator.daCtx", sel); render(); } },
        h("td", {}, nodeLink(c.context)), h("td", {}, bar(c.coverage)), ...daParts().map(([k]) => cell(c[k])), h("td", { class: "small", text: String(c.only_ddd_total) }))))));
    body.replaceChildren(head, ...(tbl ? [tbl] : []), cur ? detail(cur) : h("div", { class: "muted small", text: t("Zeile wählen: Einzelheiten des Kontexts") }));
  };
  const load = () => {
    const q = new URLSearchParams({ doc: docId });
    if (contextId) q.set("context", contextId);
    api(`/api/ddd_alignment?${q}`).then((d) => { data = d; render(); }).catch((e) => body.replaceChildren(h("div", { class: "muted", text: e.message })));
  };
  if (card.open) load(); else card.addEventListener("toggle", () => { if (card.open && !data) load(); }, { once: false });
  card.addEventListener("toggle", () => { if (!contextId) state.display.dddAlignOpen = card.open; });
  return card;
}
// ------------------------------------------------------------------ Schnittstelle: Struktur und Dokument (WSDL/XSD)
const SCHEMA_LABELS = ["Service", "Operation", "Message", "Field", "DataElement", "DataType", "Codelist"];
function schemaCard(n, message = null) {
  const card = h("details", { class: "card schema", open: state.display.schemaOpen !== false },
    h("summary", { text: t("Schnittstelle: Struktur und Dokument") }), loadingEl());
  card.addEventListener("toggle", () => { state.display.schemaOpen = card.open; });
  const q = new URLSearchParams({ id: n.id });
  if (!n.type) q.set("label", n.label);
  if (message) q.set("message", message);
  api(`/api/schema?${q}`).then((d) => { if (state.node && state.node.id === n.id) renderSchema(card, n, d); })
    .catch((e) => card.replaceChildren(h("summary", { text: t("Schnittstelle: Struktur und Dokument") }), h("div", { class: "muted", text: e.message })));
  return card;
}
function renderSchema(card, n, d) {
  const tab = state.schemaTab || "tree";
  const body = h("div", { class: "schema-body" });
  const bar = h("div", { class: "tabs form-tabs", role: "tablist" }, ...[["tree", t("Struktur")], ["doc", t("Dokument")]].map(([k, lab]) =>
    h("button", { type: "button", role: "tab", "aria-selected": String(k === tab), onclick: () => { state.schemaTab = k; renderSchema(card, n, d); } }, lab)));
  let occ = null;
  if (d.occurrences.length && d.occurrences[0].message !== undefined) {
    const sel = h("select", { "aria-label": t("Nachricht") }, ...d.occurrences.map((o) => h("option", { value: o.message,
      text: `${o.message} – ${o.title} (${o.fields.length})` })));
    sel.value = d.message || "";
    sel.addEventListener("change", () => { const c = schemaCard(n, sel.value); card.replaceWith(c); });
    occ = h("div", { class: "small" }, t("Vorkommen in {n} Nachrichten", { n: d.occurrences.length }) + ": ", sel);
  } else if (d.occurrences.length) {
    occ = h("div", { class: "small" }, t("Empfangen von") + ": ", ...d.occurrences.flatMap((o, i) => [i ? ", " : "", nodeLink(o.operation)]));
  }
  if (tab === "tree") body.append(d.tree ? schemaTree(d) : h("div", { class: "muted small", text: t("Keine Struktur im Graphen (kg geladen?)") }));
  else body.append(schemaDocs(d));
  card.replaceChildren(...[h("summary", { text: t("Schnittstelle: Struktur und Dokument") }), occ, bar, body].filter(Boolean));
}
function schemaTree(d) {
  const hl = new Set(d.highlight || []);
  const box = h("div", { class: "schema-tree" });
  if (d.tree.field) {                                   // Feldbaum einer Nachricht
    const ancestors = new Set();
    const mark = (node, path) => {
      const hit = hl.has(node.field.id);
      let below = false;
      for (const c of node.children) below = mark(c, path) || below;
      if (below) ancestors.add(node.field.id);
      return hit || below;
    };
    mark(d.tree);
    let first = null;
    const row = (node, depth) => {
      const f = node.field;
      const kids = h("div", { class: "kids" });
      const open = depth < 1 || ancestors.has(f.id);
      let built = false;
      const build = () => { if (!built) { built = true; kids.append(...node.children.map((c) => row(c, depth + 1))); } };
      const tog = h("button", { type: "button", class: "tog", "aria-label": t("auf-/zuklappen"), text: node.children.length ? (open ? "▾" : "▸") : "·" });
      tog.addEventListener("click", () => { if (!node.children.length) return; build(); kids.hidden = !kids.hidden; tog.textContent = kids.hidden ? "▸" : "▾"; });
      const occurs = `${f.minOccurs ?? "?"}..${f.maxOccurs === "unbounded" ? "n" : (f.maxOccurs ?? "?")}`;
      const line = h("div", { class: `frow${hl.has(f.id) ? " hl" : ""}` }, tog,
        nodeLink({ id: f.id, label: "Field", title: f.nameDe || f.name || f.xmlName }),
        h("span", { class: "mono", text: f.xmlName || "" }),
        f.elementId ? nodeLink({ id: String(f.elementId), label: "DataElement", title: `${t("Datenelement")} ${f.elementId}` }) : null,
        f.format ? h("span", { class: "pill mini", text: f.format }) : null,
        h("span", { class: "muted small", text: occurs }),
        f.status ? h("span", { class: `pill mini st-${f.status}`, title: t("Status R = erforderlich, O = optional, C/D = bedingt"), text: f.status }) : null,
        f.codelists ? h("span", { class: "muted small", text: `CL ${Array.isArray(f.codelists) ? f.codelists.join(", ") : f.codelists}` }) : null);
      if (hl.has(f.id) && !first) first = line;
      kids.hidden = !open;
      if (open) build();
      return h("div", { class: "fnode" }, line, kids);
    };
    box.append(row(d.tree, 0));
    if (first) setTimeout(() => { box.scrollTop = Math.max(0, first.offsetTop - 60); }, 0);
  } else {                                              // Service -> Operationen -> Nachrichten
    const item = (x) => h("li", { class: hl.has(x.node.id) ? "hl" : null }, nodeLink(x.node),
      x.info ? h("span", { class: "muted small", text: `  ${x.info}` }) : null,
      x.children && x.children.length ? h("ul", {}, ...x.children.map(item)) : null);
    box.append(h("ul", { class: "svc-tree" }, item(d.tree)));
  }
  return box;
}
function schemaDocs(d) {
  const wrap = h("div", {});
  if (!d.docs.length) { wrap.append(h("div", { class: "muted small", text: t("Kein Dokument bekannt.") })); return wrap; }
  const sel = h("select", { "aria-label": t("Datei") }, ...d.docs.map((x, i) => h("option", { value: String(i),
    text: `${x.title}${x.available ? "" : " – " + t("nicht gefunden")}` })));
  const find = h("input", { type: "search", placeholder: t("Im Dokument suchen …"), "aria-label": t("Im Dokument suchen …") });
  const info = h("span", { class: "muted small" });
  const pre = h("div", { class: "xml-view" });
  const dl = h("a", { text: t("Datei herunterladen") });
  let lines = [], cur = -1;
  const show = async () => {
    const doc = d.docs[Number(sel.value)];
    dl.href = `/api/schema/file?${new URLSearchParams({ container: doc.container || "", file: doc.file })}`;
    dl.setAttribute("download", doc.file.split("/").pop());
    if (!doc.available) { pre.replaceChildren(h("div", { class: "muted small", text: t("Die Datei liegt nicht in den Eingaben (input/inputs.json, Rolle wsdl).") })); return; }
    pre.replaceChildren(loadingEl());
    let txt;
    try { const r = await fetch(dl.href); if (!r.ok) throw new Error(r.statusText); txt = await r.text(); }
    catch (e) { pre.replaceChildren(h("div", { class: "muted", text: e.message })); return; }
    lines = txt.split(/\r?\n/);
    const marks = new Set();
    for (const tx of doc.texts || []) lines.forEach((l, i) => { if (l.includes(tx)) marks.add(i); });
    for (const p of doc.paths || []) {                // Elementpfad im XSD nacheinander suchen
      let i = 0, ok = true;
      for (const seg of p.split("/")) {
        const k = lines.findIndex((l, j) => j >= i && l.includes(`name="${seg}"`));
        if (k < 0) { ok = false; break; }
        i = k + 1;
      }
      if (ok) marks.add(i - 1);
    }
    pre.innerHTML = lines.map((l, i) => `<div class="xl${marks.has(i) ? " mark" : ""}" data-n="${i + 1}">${xmlHighlight(l) || " "}</div>`).join("");
    info.textContent = marks.size ? t("{n} markierte Stellen", { n: marks.size }) : "";
    const first = pre.querySelector(".xl.mark");
    if (first) setTimeout(() => { pre.scrollTop = Math.max(0, first.offsetTop - 80); }, 0);
  };
  find.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = find.value.toLowerCase();
    if (!q) return;
    const rows = pre.querySelectorAll(".xl");
    for (let k = 1; k <= lines.length; k++) {
      const i = (cur + k) % lines.length;
      if (lines[i].toLowerCase().includes(q)) {
        pre.querySelectorAll(".xl.found").forEach((x) => x.classList.remove("found"));
        rows[i].classList.add("found"); cur = i;
        pre.scrollTop = Math.max(0, rows[i].offsetTop - 80);
        info.textContent = t("Zeile {n}", { n: i + 1 });
        return;
      }
    }
    info.textContent = t("nicht gefunden");
  });
  sel.addEventListener("change", () => { cur = -1; show(); });
  const voll = h("a", { target: "_blank", rel: "noopener", class: "small", text: t("vollständig ansehen ↗"), title: t("ganze Datei in der Quelltext-Ansicht") });
  const vollSetzen = () => { const doc = d.docs[Number(sel.value)];
    voll.href = `/quelltext?${new URLSearchParams({ art: "schnittstelle", container: doc.container || "", file: doc.file, such: ((doc.paths || [])[0] || "").split("/").pop() || (doc.texts || [])[0] || "" })}`; };
  sel.addEventListener("change", vollSetzen); vollSetzen();
  wrap.append(h("div", { class: "doc-bar" }, sel, find, info, dl, voll), pre);
  setTimeout(show, 0);
  return wrap;
}
function xmlHighlight(line) {
  const esc = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc       // erst Attribute, dann Tags (sonst träfe die Attributregel die eingefügten class="…")
    .replace(/([\w:.-]+)=("[^"]*")/g, '<span class="x-attr">$1</span>=<span class="x-val">$2</span>')
    .replace(/(&lt;\/?)([\w:.-]+)/g, '$1<span class="x-tag">$2</span>');
}
// ------------------------------------------------------------------ BPMN-Diagramm am Knoten
function hasDiagram(n) {
  return n.labels.includes("BpmnProcess") || n.labels.includes("BpmnElement")
    || (n.relations || []).some((r) => (r.other.labels || []).includes("BpmnElement"));
}
function diagramCard(n) {
  const card = h("details", { class: "card diagram", open: state.display.diagramOpen !== false },
    h("summary", { text: t("BPMN-Diagramm") }), loadingEl());
  card.addEventListener("toggle", () => { state.display.diagramOpen = card.open; });
  const q = new URLSearchParams({ id: n.id });
  if (!n.type) q.set("label", n.label);
  api(`/api/bpmn_diagrams?${q}`).then((d) => { if (state.node && state.node.id === n.id) renderDiagrams(card, n, d); })
    .catch((e) => card.replaceChildren(h("summary", { text: t("BPMN-Diagramm") }), h("div", { class: "muted", text: e.message })));
  return card;
}
function renderDiagrams(card, n, d) {
  const head = h("summary", { text: d.diagrams.length > 1 ? t("BPMN-Diagramm ({n} Prozesse)", { n: d.diagrams.length }) : t("BPMN-Diagramm") });
  if (!d.diagrams.length) { card.replaceChildren(head, h("div", { class: "muted small", text: t("Keine BPMN-Datei gefunden (bpmn/generate.py, load_bpmn.py).") })); return; }
  const key = `diagram:${n.id}`;
  let cur = Math.min(state[key] || 0, d.diagrams.length - 1);
  const body = h("div", {});
  const sel = d.diagrams.length > 1 ? h("select", { "aria-label": t("Prozess"), onchange: (e) => { state[key] = cur = Number(e.target.value); show(); } },
    ...d.diagrams.map((g, i) => h("option", { value: String(i), text: `${ttl(g.process)}${g.elementIds.length ? ` (${g.elementIds.length})` : ""}` }))) : null;
  if (sel) sel.value = String(cur);
  const show = () => {
    const g = d.diagrams[cur];
    const box = h("div", { class: "bpmn-box" }, loadingEl(t("Diagramm lädt …")));
    const els = g.elementIds.length && n.labels.includes("BpmnProcess") === false && !n.labels.includes("BpmnElement")
      ? h("ul", { class: "bpmn-els" }, ...g.elements.map((e) => h("li", {},
        nodeLink({ id: `${g.prefix}${g.processId}/${e.id}`, label: "BpmnElement", title: e.name }),
        h("span", { class: "muted small mono", text: ` ${e.id} ` }),
        h("button", { type: "button", class: "small", onclick: () => box._focus && box._focus(e.id) }, t("im Diagramm zeigen"))))) : null;
    body.replaceChildren(
      h("div", { class: "small diagram-head" }, t("Prozess") + ": ", nodeLink(g.process), " · ",
        h("a", { href: `/api/bpmn_xml?${new URLSearchParams({ file: g.file })}`, download: g.file, text: t("BPMN-Datei herunterladen") }),
        h("span", { class: "muted", text: " · " + t("Klick auf ein Element öffnet seinen Knoten (Strg/⌘: im Vergleichsfenster)") })),
      ...(els ? [els] : []), box, ...(n.labels.includes("DmnDecision") ? [] : dmnBlocks(g)));
    setTimeout(() => showBpmn(box, { bpmnFile: g.file, elementIds: g.elementIds }, { prefix: g.prefix }), 0);
  };
  card.replaceChildren(...[head, sel ? h("div", { class: "small" }, t("Prozess wählen") + ": ", sel) : null, body].filter(Boolean));
  show();
}
// ------------------------------------------------------------------ DMN-Entscheidungstabellen (dmn-js, nur Ansicht)
function dmnBlocks(g) {
  const ids = [...new Set((g.elements || []).map((e) => e.decision).filter(Boolean))];
  return ids.map((id) => {
    const box = h("div", { class: "dmn-box" }, loadingEl(t("Entscheidungstabelle lädt …")));
    const by = (g.elements || []).filter((e) => e.decision === id).map((e) => e.name).join(", ");
    setTimeout(() => showDmn(box, id), 0);
    return h("div", { class: "dmn-block" },
      h("h3", { text: t("DMN-Entscheidung {id}", { id }) }),
      h("div", { class: "muted small", text: t("aufgerufen von: {by}", { by }) }),
      box,
      h("div", { class: "small" }, h("a", { href: `/api/dmn_xml?${new URLSearchParams({ decision: id })}`, download: `${id}.dmn`, text: t("DMN-Datei herunterladen") })));
  });
}
function dmnCard(n) {
  const box = h("div", { class: "dmn-box" }, loadingEl(t("Entscheidungstabelle lädt …")));
  setTimeout(() => showDmn(box, n.props.decisionId), 0);
  return h("details", { class: "card", open: true }, h("summary", { text: t("DMN-Entscheidungstabelle") }),
    n.props.description ? h("div", { class: "small", text: n.props.description }) : null, box,
    h("div", { class: "small" }, h("a", { href: `/api/dmn_xml?${new URLSearchParams({ decision: n.props.decisionId })}`,
      download: n.props.file || `${n.props.decisionId}.dmn`, text: t("DMN-Datei herunterladen") })));
}
let dmnJsLoading = null;
function loadDmnJs() {
  if (window.DmnJS) return Promise.resolve();
  if (dmnJsLoading) return dmnJsLoading;
  for (const css of ["diagram-js.css", "dmn-js-shared.css", "dmn-js-drd.css", "dmn-js-decision-table.css", "dmn-js-literal-expression.css",
    "dmn-js-boxed-expression.css", "dmn-embedded.css"]) document.head.append(h("link", { rel: "stylesheet", href: `${ASSET}vendor/dmn-js/${css}` }));
  dmnJsLoading = new Promise((res, rej) => {
    const sc = document.createElement("script");
    sc.src = ASSET + "vendor/dmn-js/dmn-viewer.production.min.js";
    sc.onload = res; sc.onerror = () => { dmnJsLoading = null; rej(new Error(t("DMN-Viewer konnte nicht geladen werden"))); };
    document.head.append(sc);
  });
  return dmnJsLoading;
}
async function showDmn(box, decisionId) {
  try {
    await loadDmnJs();
    const res = await fetch(`/api/dmn_xml?${new URLSearchParams({ decision: decisionId })}`);
    if (!res.ok) throw new Error(t("DMN-Entscheidung {decision} nicht gefunden", { decision: decisionId }));
    const xml = await res.text();
    box.replaceChildren();
    const viewer = new window.DmnJS({ container: box });
    await viewer.importXML(xml);
    const views = viewer.getViews();
    const v = views.find((x) => x.element && x.element.id === decisionId && x.type !== "drd") || views.find((x) => x.type !== "drd") || views[0];
    if (v) await viewer.open(v);
  } catch (e) {
    box.replaceChildren(h("div", { class: "muted", text: e.message }));
  }
}
// Element im Diagramm -> Knoten: Prozess des Elements (Pool/Teilnehmer: referenzierter Prozess), ID prefix + Prozess + "/" + Element
function diagramNodeRef(el, prefix) {
  const bo = el.businessObject || {};
  if (bo.$type === "bpmn:Participant" && bo.processRef) return { id: `${prefix}${bo.processRef.id}`, label: "BpmnProcess" };
  if (bo.$type === "bpmn:Process") return { id: `${prefix}${bo.id}`, label: "BpmnProcess" };
  let p = bo.$parent;
  while (p && p.$type !== "bpmn:Process") p = p.$parent;
  if (!p) return null;
  return { id: `${prefix}${p.id}/${bo.id}`, label: "BpmnElement", title: bo.name || bo.id };
}
async function showBpmn(box, a, opts = {}) {
  try {
    await loadBpmnJs();
    const res = await fetch(`/api/bpmn_xml?${new URLSearchParams({ file: a.bpmnFile })}`);
    if (!res.ok) throw new Error(t("BPMN-Datei {file} nicht gefunden", { file: a.bpmnFile }));
    const xml = await res.text();
    box.replaceChildren();
    const viewer = new window.BpmnJS({ container: box });
    await viewer.importXML(xml);
    const canvas = viewer.get("canvas"), reg = viewer.get("elementRegistry");
    const ids = (a.elementIds || []).filter((id) => reg.get(id));
    for (const id of ids) canvas.addMarker(id, "rule-hl");
    canvas.zoom("fit-viewport");
    if (opts.prefix !== undefined) {
      viewer.get("eventBus").on("element.click", (ev) => {
        const ref = diagramNodeRef(ev.element, opts.prefix);
        if (!ref || ev.element.type === "label" || ev.element.waypoints) return;
        const oe = ev.originalEvent || {};
        if (oe.ctrlKey || oe.metaKey) openWindow({ ...ref, editable: false });
        else openNode(ref.id, { label: ref.label });
      });
      box.classList.add("clickable");
    }
    box._focus = (id) => {
      const el = reg.get(id);
      if (!el) return;
      const vb = canvas.viewbox(), z = Math.min(1, vb.outer.width / 900);
      const w = vb.outer.width / z, hh = vb.outer.height / z;      // Element in die Mitte, Maßstab höchstens 1
      canvas.viewbox({ x: el.x + (el.width || 0) / 2 - w / 2, y: el.y + (el.height || 0) / 2 - hh / 2, width: w, height: hh });
      for (const x of ids) canvas.removeMarker(x, "rule-focus");
      canvas.addMarker(id, "rule-focus");
    };
    if (ids.length) box._focus(ids[0]);
  } catch (e) {
    box.replaceChildren(h("div", { class: "muted", text: e.message }));
  }
}
function recordView(rec, label) {
  const items = (r) => Object.entries(r || {}).flatMap(([k, vals]) => (Array.isArray(vals) ? vals : [vals]).map((v) =>
    v && typeof v === "object" ? h("li", {}, h("span", { class: "mono muted", text: k }), " →", h("ul", { class: "rec" }, ...items(v)))
      : h("li", {}, h("span", { class: "mono muted", text: k }), ` = ${fmtCase(v)}`)));
  const li = items(rec);
  return h("div", { class: "small" }, h("b", { text: label }), h("ul", { class: "rec" }, ...(li.length ? li : [h("li", { class: "muted", text: t("(keine Angaben)") })])));
}
function fmtCase(v) {
  if (v === true) return t("ja");
  if (v === false) return t("nein");
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v.split("-").reverse().join(".");
  return typeof v === "string" ? `„${v}“` : String(v);
}
function testsView(tests) {
  if (!tests.length) return [h("div", { class: "muted", text: t("Keine Testfälle – die Regel ist nicht formalisiert (knowledge/rule_formal) oder nicht ausführbar.") })];
  const groups = {};
  for (const c of tests) (groups[c.formalization] ||= []).push(c);
  const ok = tests.filter((c) => c.ok).length;
  const out = [h("div", { class: `small ${ok === tests.length ? "" : "warn-text"}`, text: t("{ok} von {n} Fällen wie erwartet (pyshacl)", { ok, n: tests.length }) })];
  for (const [f, cs] of Object.entries(groups)) {
    const c0 = cs[0];
    out.push(h("div", { class: "formal small" }, h("span", { class: "muted", text: t("Formalisierung {f} – Zielklasse ", { f }) }), h("b", { text: c0.target }),
      c0.when ? h("div", {}, h("b", { text: t("Wenn") }), ` ${c0.when}`) : null, h("div", {}, h("b", { text: t("Dann") }), ` ${c0.then}`)));
    out.push(h("div", { class: "cases" }, ...cs.map((c) => {
      const cls = !c.ok ? "wrong" : (c.outcome === "Meldung" ? "hit" : "pass");
      const resText = !c.ok ? t("Unerwartet: {o} – Formalisierung oder Shape prüfen", { o: CASE_OUTCOME[c.outcome] || c.outcome })
        : c.outcome === "Meldung" ? t("Meldung: {m}", { m: (c.messages || [])[0] || "" }) : (c.kind === "nicht betroffen" ? t("Keine Meldung – Regel greift nicht") : t("Keine Meldung – Regel erfüllt"));
      return h("div", { class: `case ${cls}` }, h("div", {}, h("span", { class: "pill type", text: CASE_KIND[c.kind] || c.kind }), " ", h("b", { class: "small", text: c.title })),
        h("div", { class: "small muted", text: c.explain || "" }), recordView(c.record, c.target),
        h("div", { class: `res ${cls}`, text: resText }),
        h("details", {}, h("summary", { text: t("Daten (Turtle)") }), codeBlock(c.ttl || "")));
    })));
  }
  return out;
}
let propTimer = null;
function scheduleProposals() { clearTimeout(propTimer); propTimer = setTimeout(() => searchProposals(), 220); }
async function searchProposals(more = false, { keep = false } = {}) {
  // keep: nach einer Entscheidung neu laden, ohne Platzhalter und an derselben Stelle (Ableitungen, Zählungen aktuell)
  const seq = listLoading("props", !more && !keep);
  if (more) { const b = $("results").querySelector("li.more button"); if (b) { b.disabled = true; b.replaceChildren(loadingEl()); } }
  const shown = keep && state.proposals ? state.proposals.items.length : 0;
  const p = new URLSearchParams({ q: $("pq").value, status: $("p-status").value || "candidate", limit: String(keep ? Math.max(PAGE, shown) : PAGE),
    offset: String(more ? state.proposals.items.length : 0) });
  if ($("p-type").value) p.set("type", $("p-type").value);
  if ($("p-doc").value) p.set("doc", $("p-doc").value);
  if ($("p-method").value) p.set("method", $("p-method").value);
  if ($("p-herkunft").value) p.set("herkunft", $("p-herkunft").value);
  if ($("p-min").value !== "") p.set("min_score", $("p-min").value);
  if ($("p-weak").checked) p.set("weak", "hide");
  if ($("p-onto").checked) p.set("onto", "hide");
  if ($("p-sicht").value) p.set("sicht", $("p-sicht").value);
  if ($("p-agent").value) p.set("agent", $("p-agent").value);
  if ($("p-same").value) p.set("same", $("p-same").value);
  let res;
  try { res = await api(`/api/proposals?${p}`); } catch (e) { if (isSeq("props", seq)) { listDone("props"); toast(t("Suche fehlgeschlagen: {msg}", { msg: e.message }), true); } return; }
  if (!isSeq("props", seq)) return;                 // inzwischen neuere Suche
  listDone("props");
  const keepScroll = more || keep ? $("results").scrollTop : 0;
  state.proposals = more ? { ...res, items: state.proposals.items.concat(res.items) } : res;
  if (!$("p-type").value) fillOptions($("p-type"), res.types, t("alle Beziehungen"), relTitle);
  fillOptions($("p-method"), res.methods, t("alle Verfahren"), (m) => methodInfo(m).title, (m) => methodInfo(m).hint);   // Zahlen aktuell
  if (state.tab !== "props") return;
  renderProposals();
  if (more || keep) $("results").scrollTop = keepScroll;
}
function fillOptions(sel, counts, allText, title, hint = () => null) {
  const cur = sel.value;
  sel.replaceChildren(h("option", { value: "", text: allText }),
    ...Object.entries(counts).sort(([a], [b]) => title(a).localeCompare(title(b)))
      .map(([k, n]) => h("option", { value: k, text: `${title(k)} (${n})`, title: [hint(k), k].filter(Boolean).join(" · ") })));
  if (cur && !(cur in counts)) sel.append(h("option", { value: cur, text: `${title(cur)} (0)` }));   // gewählter Filter bleibt
  sel.value = cur;
}
async function closeAllTransitiv() {
  const user = $("user").value.trim();
  if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); $("user").focus(); return; }
  let res;
  try { res = await api("/api/transitiv/close", { method: "POST", body: JSON.stringify({ user, comment: ($("comment") || {}).value || null }) }); }
  catch (e) { toast(e.message, true); return; }
  if (res.done || res.failed.length) showTransitiv(res); else toast(t("keine"));
}
function renderProposals() {
  if (state.tab !== "props") return;
  const ul = $("results"), pr = state.proposals;
  ul.setAttribute("role", "list");                  // Vorschläge mit Knöpfen: eine Liste, keine Auswahl
  $("result-info").textContent = t(pr.total === 1 ? "{n} Beziehung" : "{n} Beziehungen", { n: pr.total }) + (pr.items.length < pr.total ? t(", {k} angezeigt", { k: pr.items.length }) : "")
    + (pr.implied && ($("p-status").value || "candidate") === "candidate" ? t(" · {i} transitiv bestätigt (ausgeblendet)", { i: pr.implied }) : "")
    + (pr.conflicts ? t(" · {c} Widersprüche", { c: pr.conflicts }) : "")
    + (pr.same ? t(" · {s} mit gleicher Benennung", { s: pr.same }) : "")
    + (pr.weak ? t(" · {w} schwache (ohne weiteren Beleg){h}", { w: pr.weak, h: $("p-weak").checked ? t(", ausgeblendet") : t(", hinten") }) : "")
    + (pr.bridges && !$("p-sicht").value ? t(" · {b} Brücken zwischen den Sichten", { b: pr.bridges }) : "")
    + (pr.onto_bad ? t(" · {o} gegen die Ontologie{h}", { o: pr.onto_bad, h: $("p-onto").checked ? t(", ausgeblendet") : t(", hinten") }) : "");
  const rows = pr.items.map((it) => {
    const st = it.status || "candidate";
    const btn = (action, label, cls) => h("button", { type: "button", class: `small ${cls || ""}`,
      onclick: () => doProposalAction(it, action) }, label);
    const ctl = h("div", { class: "curate" },
      h("span", { class: `pill rel-${st}`, text: REL_STATUS_DE[st] || st, title: st === "implied" ? impliedHint(it.implied_via) : null }),
      it.conflict ? h("span", { class: "pill conflict", title: CONFLICT_HINT(), text: t("Widerspruch") }) : null,
      it.same_name ? h("span", { class: "pill same", title: t("Beide Knoten haben eine gleiche Benennung (auch Synonym oder englisch)"), text: t("gleiche Benennung") }) : null,
      it.weak ? h("span", { class: "pill weak", title: t("Nur Embedding bzw. Abkürzung ohne weiteren Beleg"), text: t("schwach") }) : null,
      ontoPill(it.onto), agentPill(it.agent),
      it.score !== null && it.score !== undefined ? h("span", { class: "muted small", text: `Score ${Number(it.score).toFixed(2)}` }) : null,
      it.method ? h("span", { class: "muted small", title: [methodInfo(it.method).hint, it.method].filter(Boolean).join(" · "),
        text: methodInfo(it.method).title }) : null,
      herkunftPills(it.herkunft, true), decisionInfo(it.entscheidung),
      st !== "confirmed" && st !== "source" ? btn("confirm", t("Bestätigen"), "primary") : null,
      st !== "rejected" && st !== "source" ? btn("reject", t("Ablehnen"), "danger") : null,
      st === "confirmed" || st === "rejected" ? btn("reset", t("Zurücksetzen")) : null,
      ...retypeButtons(it.type, (to) => doProposalRetype(it, to), { a: it.start.labels || [], b: it.end.labels || [], bridge: !!it.bridge, views: it.views }),
      h("button", { type: "button", class: "small compare", title: t("Anfang hier, Ende im Vergleichsfenster öffnen"),
        onclick: () => { openWindow(it.end); openNode(it.start.id, { label: it.start.editable ? null : it.start.label }); } }, t("Nebeneinander")));
    return h("li", { class: "proposal" },
      h("div", { class: "p-ends" }, nodeLink(it.start), h("span", { class: "p-rel", text: `↓ ${relTitle(it.type)}` }), nodeLink(it.end)),
      it.evidence ? h("div", { class: "p-ev", title: it.evidence, text: it.evidence }) : null,
      st === "implied" ? h("div", { class: "p-ev implied" }, t("ergibt sich über") + " ",
        ...(it.implied_via || []).flatMap((x, i) => [i ? " → " : "", nodeLink(x)])) : null,
      it.reviewedBy ? h("div", { class: "muted small", text: `${it.reviewedBy}, ${fmtTs(it.reviewedAt)}` }) : null,
      ctl);
  });
  if (pr.items.length < pr.total) rows.push(h("li", { class: "more" }, h("button", { type: "button", class: "small", onclick: () => searchProposals(true) }, t("weitere laden"))));
  const bulk = bulkBar(pr);
  if (bulk) rows.unshift(bulk);
  const ab = agentBar(pr);
  if (ab) rows.unshift(ab);
  const fb = filteredBulkBar(pr);
  if (fb) rows.unshift(fb);
  if (pr.implied && !state.config.readonly && ($("p-status").value || "candidate") === "candidate") rows.unshift(h("li", { class: "bulk tr-bulk" },
    h("div", { class: "small", text: tp(pr.implied, "1 Vorschlag ergibt sich schon transitiv aus bestätigten Verknüpfungen (ausgeblendet).", "{i} Vorschläge ergeben sich schon transitiv aus bestätigten Verknüpfungen (ausgeblendet).", { i: pr.implied }) }),
    h("button", { type: "button", class: "small", onclick: closeAllTransitiv }, t("Transitiv erledigte abschließen ({n})", { n: pr.implied }))));
  const top = ul.scrollTop;                          // Position behalten (nach Bestätigen/Ablehnen neu gezeichnet)
  ul.replaceChildren(...rows);
  ul.scrollTop = top;
}
// Sammelbestätigung: nur bei „nur gleiche Benennung“, für die angezeigten offenen Vorschläge, mit Rückfrage im Knopf
// ------------------------------------------------------------------ Kurations-Agent (v63.0, common/agent.py)
// Empfehlungen (bestätigen/ablehnen/unklar) mit Begründung; der Agent entscheidet nicht – übernommen wird hier
const AGENT_DE = () => ({ bestaetigen: t("bestätigen"), ablehnen: t("ablehnen"), unklar: t("unklar") });
function agentPill(a) {
  if (!a) return null;
  const cls = a.empfehlung === "bestaetigen" ? "rel-confirmed" : a.empfehlung === "ablehnen" ? "rel-rejected" : "rel-candidate";
  return h("span", { class: `pill agent ${cls}`, title: [a.begruendung, `${a.modell || ""} · ${a.lauf || ""}`].filter(Boolean).join("\n"),
    text: `${t("Agent")}: ${AGENT_DE()[a.empfehlung] || a.empfehlung} ${a.sicherheit != null ? Number(a.sicherheit).toFixed(2) : ""}`.trim() });
}
function agentBar(pr) {
  const n = pr.agent || {};
  $("p-agent").hidden = !Object.keys(n).some((k) => k !== "ohne");
  if (state.config.readonly || $("p-agent").hidden) return null;
  const shown = (e) => pr.items.filter((it) => it.agent && it.agent.empfehlung === e && (it.status || "candidate") === "candidate");
  const take = async (e) => {
    const user = $("user").value.trim();
    if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); $("user").focus(); return; }
    const its = shown(e);
    if (!window.confirm(t("{n} Empfehlungen „{e}“ des Agenten übernehmen? Jede mit seiner Begründung im Protokoll; zurücknehmbar im Reiter Entscheidungen.", { n: its.length, e: AGENT_DE()[e] }))) return;
    let r;
    try { r = await api("/api/agent/uebernehmen", { method: "POST", body: JSON.stringify({ user, nur: e,
      items: its.map((it) => ({ start: it.start.id, type: it.type, end: it.end.id })) }) }); }
    catch (err) { toast(err.message, true); return; }
    toast(t("{d} übernommen", { d: r.done }) + (r.veraltet ? t(", {v} inzwischen entschieden", { v: r.veraltet }) : "")
      + (r.failed.length ? t(", {f} nicht möglich (inzwischen geändert?)", { f: r.failed.length }) : ""), r.failed.length > 0);
  };
  const b1 = shown("bestaetigen").length, b2 = shown("ablehnen").length;
  return h("li", { class: "bulk ag-bulk" },
    h("div", { class: "small", text: t("Kurations-Agent: {b} bestätigen · {a} ablehnen · {u} unklar · {o} ohne Empfehlung (in dieser Auswahl)",
      { b: n.bestaetigen || 0, a: n.ablehnen || 0, u: n.unklar || 0, o: n.ohne || 0 }) }),
    h("div", { class: "el-bar" },
      h("button", { type: "button", class: "small", disabled: !b1, onclick: () => take("bestaetigen") }, t("Bestätigungen übernehmen ({n})", { n: b1 })),
      h("button", { type: "button", class: "small", disabled: !b2, onclick: () => take("ablehnen") }, t("Ablehnungen übernehmen ({n})", { n: b2 })),
      h("span", { class: "muted small", text: t("gilt für die geladenen Einträge; Begründung als Grundlage, Stichproben vorher prüfen") })));
}
// v63.0.3: Sammelaktion für eine gefilterte Liste (Verfahren, Beziehungsart, Suchtext …) – zwei Klicks, als
// Sammelentscheidung zurücknehmbar (Befund des explorativen Tests: Vorschläge eines Verfahrens nur einzeln)
function filteredBulkBar(pr) {
  if (state.config.readonly || $("p-same").value === "only") return null;
  const filtered = ["pq", "p-type", "p-method", "p-herkunft", "p-doc", "p-sicht", "p-agent"].some((id) => $(id) && $(id).value) || ($("p-min").value || "") !== "";
  if (!filtered || ($("p-status").value || "candidate") !== "candidate") return null;
  const open = pr.items.filter((it) => (it.status || "candidate") === "candidate");
  if (!open.length) return null;
  let armed = null;
  const go = async (action, btn) => {
    const user = $("user").value.trim();
    if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); $("user").focus(); return; }
    if (armed !== action) { armed = action; btn.textContent = action === "confirm" ? t("Wirklich {n} bestätigen?", { n: open.length }) : t("Wirklich {n} ablehnen?", { n: open.length }); return; }
    let r;
    try { r = await api("/api/relation/bulk", { method: "POST", body: JSON.stringify({ action, user,
      items: open.map((it) => ({ start: it.start.id, type: it.type, end: it.end.id, start_label: it.start_label || null, expected_status: it.status ?? null })) }) }); }
    catch (e) { toast(e.message, true); return; }
    toast((action === "confirm" ? t("{d} bestätigt", { d: r.done }) : t("{d} abgelehnt", { d: r.done }))
      + (r.failed.length ? t(", {f} nicht möglich (inzwischen geändert?)", { f: r.failed.length }) : ""), r.failed.length > 0);
  };
  const b1 = h("button", { type: "button", class: "small" }, t("Alle {n} angezeigten bestätigen", { n: open.length }));
  const b2 = h("button", { type: "button", class: "small danger" }, t("Alle {n} angezeigten ablehnen", { n: open.length }));
  b1.addEventListener("click", () => go("confirm", b1)); b2.addEventListener("click", () => go("reject", b2));
  return h("li", { class: "bulk" }, h("div", { class: "el-bar" }, b1, b2),
    h("div", { class: "muted small", text: t("Sammelaktion für die gefilterte, geladene Liste – vorher Stichproben prüfen; zurücknehmbar im Reiter Entscheidungen unter „Sammelentscheidungen“.") }));
}
function bulkBar(pr) {
  if ($("p-same").value !== "only") return null;
  const open = pr.items.filter((it) => ["candidate", "implied"].includes(it.status || "candidate") && ["EXACT_MATCH", "CLOSE_MATCH"].includes(it.type));
  if (!open.length) return null;
  const label = () => t("Alle {n} angezeigten als gleichbedeutend bestätigen", { n: open.length });
  const btn = h("button", { type: "button", class: "small primary" }, label());
  const cancel = h("button", { type: "button", class: "small", hidden: true }, t("Abbrechen"));
  let armed = false;
  cancel.addEventListener("click", () => { armed = false; cancel.hidden = true; btn.textContent = label(); });
  btn.addEventListener("click", async () => {
    const user = $("user").value.trim();
    if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); $("user").focus(); return; }
    if (!armed) { armed = true; cancel.hidden = false; btn.textContent = t("Wirklich {n} als gleichbedeutend bestätigen?", { n: open.length }); return; }
    btn.disabled = cancel.disabled = true;
    const items = open.map((it) => ({ start: it.start.id, type: it.type, end: it.end.id, start_label: it.start_label || null,
      expected_status: it.status === "implied" ? "candidate" : (it.status ?? null) }));
    let r;
    try { r = await api("/api/relation/bulk", { method: "POST", body: JSON.stringify({ items, action: "confirm_exact", user }) }); }
    catch (e) { toast(e.message, true); btn.disabled = cancel.disabled = false; return; }
    toast(t("{d} bestätigt", { d: r.done }) + (r.failed.length ? t(", {f} nicht möglich (inzwischen geändert?)", { f: r.failed.length }) : ""), r.failed.length > 0);
    searchProposals();
  });
  return h("li", { class: "bulk" }, btn, " ", cancel,
    h("div", { class: "muted small", text: t("Gleichbedeutend und nahe Entsprechung (wird gleichbedeutend); gleichbedeutende Begriffe werden beim Einspielen zusammengeführt. Vorher Stichproben prüfen: gleiche Benennung heißt nicht immer gleiche Bedeutung.") }));
}
async function doProposalAction(it, action) {
  const user = $("user").value.trim();
  if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); $("user").focus(); return; }
  const payload = { start: it.start.id, type: it.type, end: it.end.id, action, user, start_label: it.start_label || null,
    expected_status: it.status === "implied" ? "candidate" : (it.status ?? null) };
  const n = state.node;
  if (n) { payload.view_id = n.id; payload.view_label = n.type ? null : n.label; }
  try {
    const res = await api("/api/relation/action", { method: "POST", body: JSON.stringify(payload) });
    toast(`${REL_ACTION_DE[action]}: ${ttl(it.start)} → ${ttl(it.end)}`);
    if (res.node && n && res.node.id === n.id) { applyNodeUpdate(res.node); renderDetail(); }
    // Liste behalten (Position), Eintrag aktualisieren; passt er nicht mehr zum Statusfilter, ausblenden
    it.status = res.status; it.reviewedBy = user; it.reviewedAt = new Date().toISOString();
    const want = $("p-status").value || "candidate";
    if (want !== "all" && it.status !== want) {
      state.proposals.items = state.proposals.items.filter((x) => x !== it);
      state.proposals.total -= 1;
    }
    renderProposals();                               // sofort; abgeleitete Änderungen (transitiv bestätigt, Widersprüche,
                                                     // Zählungen) lädt scheduleListRefresh nach
  } catch (e) { toast(e.message, true); if (e.status === 409) searchProposals(); }
}

// ------------------------------------------------------------------ Beziehungsart ändern (relations.retype)
// ctx {a, b (Labels von Start und Ende), bridge}: Brücken-Typen (REALIZED_BY, MEANS) nur bei Paaren aus verschiedenen
// Sichten und nur, wenn die Richtung zur Freigabe passt (fachlich -> technisch bzw. technisch -> Begriff), v61.5
function retypeButtons(type, onclick, ctx = null) {
  const bridges = new Set(relCfg().bridge_rels || []), ed = relCfg().editable || {};
  const dir = relCfg().bridge_dir || {};
  const fits = (to) => { const sp = ed[to] || {}, dv = dir[to];
    return !ctx || ((sp.from || []).some((l) => ctx.a.includes(l)) && (sp.to || []).some((l) => ctx.b.includes(l))
      && (!dv || !ctx.views || (ctx.views[0] === dv[0] && ctx.views[1] === dv[1]))); };
  return Object.entries((relCfg().retype || {})[type] || {})
    .filter(([to]) => !bridges.has(to) || (ctx && ctx.bridge && fits(to)))
    .map(([to, label]) => h("button", { type: "button", class: `small${bridges.has(to) ? " bridge-btn" : ""}`,
      title: `${relTitle(type)} → ${relTitle(to)}`, onclick: () => onclick(to) }, label));
}
// Sicht nach Labels (Ersatz, wenn die Ontologie keine Sichten liefert): technisch bei Labels der Schnittstelle/BPMN
function viewByLabels(labels) { const tl = new Set(relCfg().tech_labels || []); return (labels || []).some((l) => tl.has(l)) ? "technisch" : "fachlich"; }
async function postRetype(payload) {
  const user = $("user").value.trim();
  if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); $("user").focus(); return null; }
  const n = state.node;
  const body = { ...payload, user, comment: ($("comment") || {}).value || null };
  if (n) { body.view_id = n.id; body.view_label = n.type ? null : n.label; }
  try {
    const res = await api("/api/relation/retype", { method: "POST", body: JSON.stringify(body) });
    toast(t("Beziehungsart geändert: {a} → {b}", { a: relTitle(payload.type), b: relTitle(payload.to) }));
    if (res.node && n && res.node.id === n.id) { applyNodeUpdate(res.node); renderDetail(); loadHistory(n.id); }
    return res;
  } catch (e) { toast(e.message, true); return null; }
}
function doRetype(curate, to) {
  return postRetype({ start: curate.start, type: curate.type, end: curate.end, to, start_label: curate.start_label || null });
}
async function doProposalRetype(it, to) {
  const res = await postRetype({ start: it.start.id, type: it.type, end: it.end.id, to, start_label: it.start_label || null });
  if (res) searchProposals();
}

// ------------------------------------------------------------------ Anzeige-Einstellungen
function loadDisplay() {
  const def = relCfg().display_defaults || {};
  let saved = {};
  try { saved = JSON.parse(storage("curator.display") || "{}"); } catch { saved = {}; }
  state.display = { candidates: def.candidates || "all", min_score: def.min_score ?? 0, max_per_group: def.max_per_group || 50,
    ...saved, groups: { ...(def.groups || {}), ...(saved.groups || {}) }, hiddenTypes: saved.hiddenTypes || [] };
}
function saveDisplay() {
  storage("curator.display", JSON.stringify(state.display));
  if (state.node) renderDetail();
}
// Erscheinungsbild: KERN (Standard, UX-Standard der Verwaltung) oder Kanonik (klassisch) – common/static/design/design.js
function designWahl() {
  if (!window.kanonikDesign) return h("span", { class: "muted small", text: "–" });
  return window.kanonikDesign.wahl({ titel: t("Erscheinungsbild"), kern: t("KERN (UX-Standard der Verwaltung)"), klassisch: t("Kanonik (klassisch)") });
}
function renderDisplay() {
  const box = $("display-body");
  if (!box || !state.display) return;
  const d = state.display;
  const groups = [...relCfg().groups, { id: "evidence", title: t("Quellbelege") }];
  const check = (checked, label, onchange) => {
    const cb = h("input", { type: "checkbox" });
    cb.checked = checked;
    cb.addEventListener("change", () => onchange(cb.checked));
    return h("label", {}, cb, label);
  };
  const sel = h("select", { "aria-label": t("Zuordnungen (Brücke)") }, ...Object.entries(CANDIDATE_FILTER).map(([k, v]) => h("option", { value: k, text: v })));
  sel.value = d.candidates;
  sel.addEventListener("change", () => { d.candidates = sel.value; saveDisplay(); renderDisplay(); });
  const score = h("input", { type: "number", min: "0", max: "1", step: "0.05", class: "num", "aria-label": t("Mindestwert"), disabled: d.candidates !== "min_score" });
  score.value = d.min_score;
  score.addEventListener("change", () => { d.min_score = Number(score.value || 0); saveDisplay(); });
  const max = h("input", { type: "number", min: "5", max: "500", step: "5", class: "num", "aria-label": t("Höchstzahl je Gruppe") });
  max.value = d.max_per_group;
  max.addEventListener("change", () => { d.max_per_group = Math.max(5, Number(max.value || 50)); saveDisplay(); });
  const types = [...state.seenTypes].sort();
  box.replaceChildren(
    h("div", { class: "disp-sec" }, h("strong", { text: t("Gruppen") }),
      ...groups.map((g) => check(d.groups[g.id] !== false, g.title, (v) => { d.groups[g.id] = v; saveDisplay(); }))),
    h("div", { class: "disp-sec" }, h("strong", { text: t("Zuordnungen (Brücke)") }), sel,
      h("label", {}, t("Score ab") + " ", score)),
    h("div", { class: "disp-sec" }, h("strong", { text: t("Höchstzahl je Gruppe") }), max),
    h("div", { class: "disp-sec" }, h("strong", { text: t("Erscheinungsbild") }), designWahl()),
    h("div", { class: "disp-sec" }, h("strong", { text: t("Fenster") }),
      check(!!d.newWindowEach, t("„↗“ öffnet jedes Mal ein neues Fenster"), (v) => { d.newWindowEach = v; saveDisplay(); })),
    h("div", { class: "disp-sec types" }, h("strong", { text: t("Beziehungstypen") }),
      types.length ? null : h("span", { class: "muted small", text: t("erscheinen nach dem Öffnen von Knoten") }),
      ...types.map((rt) => check(!d.hiddenTypes.includes(rt), `${rt} (${relCfg().rel_groups && Object.entries(relCfg().rel_groups).find(([, ts]) => ts.includes(rt))?.[0] || relCfg().default_group || "va"})`,
        (v) => { d.hiddenTypes = v ? d.hiddenTypes.filter((x) => x !== rt) : [...d.hiddenTypes, rt]; saveDisplay(); }))),
    h("div", { class: "disp-sec" }, h("button", { type: "button", class: "small", onclick: () => {
      storage("curator.display", "{}"); loadDisplay(); renderDisplay(); if (state.node) renderDetail(); } }, t("Voreinstellungen"))));
}

async function loadHistory(id) {
  let entries = [];
  try { entries = await api(`/api/history?id=${encodeURIComponent(id)}`); } catch { return; }
  const box = $("history");
  state.histCache = { id, entries };
  if (!box || !state.node || state.node.id !== id) return;
  box.replaceChildren(...histParts(entries));
}
function histParts(entries) {
  const items = entries.map((e) => histDecision(e, histItem(e)));
  return [h("summary", { text: t("Änderungshistorie ({n})", { n: entries.length }) }), ...(items.length ? items : [h("div", { class: "muted", text: t("noch keine manuellen Änderungen") })])];
}
function histDecision(e, el) {
  // Grundlage, Begründung und was der Vorschlag selbst angab (Protokoll, kanonik/grundlage.py)
  if (e.grundlage && e.grundlage.length) el.append(h("div", { class: "bchips" }, h("span", { class: "muted small", text: t("Grundlage:") }), ...e.grundlage.map((g) => basisChip(g))));
  const v = e.vorschlag;
  if (v && (v.method || v.detail || v.evidence)) el.append(h("div", { class: "small muted",
    text: t("Vorschlag: {v}", { v: [v.herkunft ? v.herkunft.map(herkunftTitle).join(", ") : null, v.detail || (v.method ? methodInfo(v.method).title : null),
      v.score != null && !String(v.detail || "").includes("Score") ? `Score ${Number(v.score).toFixed(2)}` : null, v.evidence].filter(Boolean).join(" · ") }) }));
  return el;
}
function histItem(e) {
  if (e.kind === "evidence") return h("div", { class: "hist" },
    h("div", {}, h("strong", { text: e.action === "remove" ? t("Quellbeleg entfernt") : t("Quellbeleg wieder zugelassen") }), ` · ${fmtTs(e.ts)} · ${e.user}`,
      e.comment ? h("span", { class: "muted", text: ` · „${e.comment}“` }) : null),
    h("div", { class: "small mono", text: `${e.type} → ${e.end}` }));
  return e.kind === "retype" ? h("div", { class: "hist" },
    h("div", {}, h("strong", { text: t("Beziehungsart geändert") }), ` · ${fmtTs(e.ts)} · ${e.user}`,
      e.comment ? h("span", { class: "muted", text: ` · „${e.comment}“` }) : null),
    h("div", { class: "small" }, `${relTitle(e.type)} → ${relTitle(e.to)}`),
    h("div", { class: "small mono", text: `${e.start} -[${e.type} → ${e.to}]-> ${e.end}` })) : e.kind === "relation" || e.kind === "link" ? h("div", { class: "hist" },
    h("div", {}, h("strong", { text: (e.kind === "link" ? LINK_ACTION_DE : REL_ACTION_DE)[e.action] || e.action }), ` · ${fmtTs(e.ts)} · ${e.user}`,
      h("span", {}, " → ", h("span", { class: `pill rel-${e.status}`, text: REL_STATUS_DE[e.status] || e.status })),
      e.comment ? h("span", { class: "muted", text: ` · „${e.comment}“` }) : null),
    h("div", { class: "small mono", text: `${e.start} -[${e.type}]-> ${e.end}` })) : h("div", { class: "hist" },
    h("div", {}, h("strong", { text: ACTION_DE[e.action] || e.action }), ` · ${fmtTs(e.ts)} · ${e.user}`,
      e.status ? h("span", {}, " → ", pill(e.status)) : null, e.comment ? h("span", { class: "muted", text: ` · „${e.comment}“` }) : null),
    Object.keys(e.changes || {}).length ? h("ul", { class: "diff" }, ...Object.entries(e.changes).map(([k, c]) =>
      h("li", {}, h("span", { class: "mono", text: `${k}: ` }), h("del", { text: fmtVal(c.old) }), " → ", h("ins", { text: fmtVal(c.new) })))) : null);
}

// Aktionen am Knoten nacheinander: eine zweite Änderung, während die erste noch gespeichert wird, wartet und geht
// dann mit der neuen Version an den Server (sonst Konflikt). Was während des Speicherns eingegeben wurde, bleibt
// erhalten (Felder und Kommentar), ebenso der Fokus im gerade bearbeiteten Feld.
let actionChain = Promise.resolve();
function doAction(action) {
  const id = state.node && state.node.id;
  const vals = JSON.parse(JSON.stringify(state.values));          // Stand beim Auslösen (später Getipptes bleibt offen)
  const run = actionChain.then(() => (state.node && state.node.id === id ? doActionNow(action, vals) : false));
  actionChain = run.catch(() => false);
  return run;
}

function rerenderKeepFocus() {
  const a = document.activeElement;
  const fid = a && a.id && $("detail").contains(a) ? a.id : null;
  const sel = fid && "selectionStart" in a ? [a.selectionStart, a.selectionEnd] : null;
  const scroll = $("detail").scrollTop;
  renderDetail();
  $("detail").scrollTop = scroll;
  const b = fid && $(fid);
  if (b) { b.focus({ preventScroll: true }); if (sel) try { b.setSelectionRange(sel[0], sel[1]); } catch { /* kein Textfeld */ } }
}

async function doActionNow(action, vals = state.values) {
  const n = state.node;
  const user = $("user").value.trim();
  if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); $("user").focus(); return false; }
  if (Object.values(state.errors).some(Boolean) && (action === "save" || action === "verify")) { toast(t("Bitte die markierten Felder korrigieren."), true); return false; }
  const payload = { id: n.id, action, rev: n.rev, user, comment: ($("comment") || {}).value || null,
    changes: action === "save" || action === "verify" ? changes(vals) : {} };
  if (action === "save" && !Object.keys(payload.changes).length) return true;     // schon gespeichert (doppelt ausgelöst)
  const sent = JSON.parse(JSON.stringify(vals));
  try {
    const res = await api("/api/node/action", { method: "POST", body: JSON.stringify(payload) });
    toast(`${ttl(n).slice(0, 60)}: ${ACTION_DE[action]}${res.changed.length ? ` (${res.changed.join(", ")})` : ""}`);
    const r = state.results.find((x) => x.id === n.id);
    if (r) { r.status = res.node.status; r.title = res.node.title; r.titleEn = res.node.titleEn; r.subtitle = res.node.subtitle; r.rev = res.node.rev; }
    renderResults(); loadStats();
    if (!state.node || state.node.id !== n.id) return true;      // inzwischen anderer Knoten geöffnet: dort nichts überschreiben
    const comment = ($("comment") || {}).value || null;
    state.node = res.node;
    state.conflict = null;
    state.errors = {};
    for (const [k, spec] of Object.entries(res.node.editable)) {
      const server = normalize(spec, res.node.props[k]);
      const typedMeanwhile = k in state.values && !same(normalize(spec, state.values[k]), normalize(spec, sent[k]));
      state.original[k] = server;
      state.values[k] = typedMeanwhile ? state.values[k] : server;
    }
    if (!state.pending) {
      rerenderKeepFocus();
      if (comment !== payload.comment && $("comment")) $("comment").value = comment || "";   // neuer Kommentar während des Speicherns
    }
    loadHistory(n.id);
    return true;
  } catch (e) {
    if (e.status === 409) { state.conflict = e.message; renderDetail(); }
    else toast(e.message, true);
    return false;
  }
}

// ------------------------------------------------------------------ Start
// feste Texte in index.html: data-i18n (Text), data-i18n-placeholder, data-i18n-aria-label, data-i18n-title
function applyStaticTexts() {
  document.title = t(document.title);
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.textContent.trim());
  for (const attr of ["placeholder", "aria-label", "title"]) {
    for (const el of document.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.getAttribute(attr)));
  }
}
function renderLangSwitch() {
  const sel = $("lang");
  if (!sel) return;
  sel.replaceChildren(...Object.entries(LANGS).map(([k, v]) => h("option", { value: k, text: v })));
  sel.value = I18N.lang;
  sel.addEventListener("change", () => {
    storage("curator.lang", sel.value);
    location.reload();
  });
}
// Neo4j: Dokumente anderer Domänen im Graphen (gemeinsam genutzte Instanz) – sichtbar warnen, auf Wunsch entfernen
async function pruefeGraphDomaene() {
  let r;
  try { r = await api("/api/graph/domaene"); } catch (e) { return; }
  const alt = $("graph-fremd");
  if (alt) alt.remove();
  if (!r.pruefbar || !r.fremd.length) return;
  const n = r.fremd.reduce((s, f) => s + f.knoten, 0);
  const knopf = state.config.readonly || state.config.viewer ? null : h("button", { type: "button", class: "small", onclick: async () => {
    const user = $("user").value.trim();
    if (!user) { toast(t("Bitte oben einen Bearbeiternamen eintragen."), true); $("user").focus(); return; }
    if (!confirm(t("{n} Knoten der fremden Dokumente {d} endgültig aus Neo4j löschen? Die eigene Domäne bleibt unverändert.",
      { n, d: r.fremd.map((f) => f.dokument).join(", ") }))) return;
    try { await api("/api/graph/fremde_entfernen", { method: "POST", body: JSON.stringify({ user }) }); }
    catch (e) { toast(e.message, true); return; }
    toast(t("Fremde Dokumente entfernt – Ansicht wird neu geladen"));
    setTimeout(() => location.reload(), 800);
  } }, t("Fremde Dokumente entfernen"));
  document.querySelector("main.layout").before(h("div", { id: "graph-fremd", class: "banner error graph-fremd", role: "alert" },
    h("strong", { text: t("Graph enthält andere Domänen:") }),
    h("span", { text: r.fremd.map((f) => t("{d} ({n} Knoten)", { d: f.dokument, n: f.knoten })).join(", ") }),
    h("span", { class: "small", text: t("Domäne {d} nutzt eine Neo4j-Instanz, in die auch andere Domänen geladen wurden. Eigene Instanz je Domäne verwenden (Handbuch: Neo4j).", { d: r.domaene || "–" }) }),
    knopf));
}
// Quellen des Speichergraphen (curator --demo, curator/demo.py) mit verständlichem Namen statt Kürzel
function quelleName(k) {
  return { spezifikation: t("Spezifikation"), bpmn: "BPMN", ddd: t("Domänenmodell"), kg: t("Schnittstelle"), archimate: "ArchiMate" }[k] || k;
}
async function init() {
  await loadLang();
  applyStaticTexts();
  renderLangSwitch();
  try { state.config = localizeConfig(await api("/api/config")); } catch (e) { toast(t("Server nicht erreichbar: {msg}", { msg: e.message }), true); return; }
  await loadAbbr();
  $("mode").textContent = state.config.mode === "demo" ? t("Demo ohne Neo4j") + `${state.config.sources ? " · " + Object.keys(state.config.sources).map(quelleName).join(", ") : ""}` : "Neo4j";
  if (state.config.readonly) { document.body.classList.add("readonly"); $("ro-badge").hidden = false; }
  if (state.config.viewer) {                       // Lese-Oberfläche (v61.1): nur Suche und Anzeige, mit Document Structure Viewer
    document.body.classList.add("viewer");
    $("ro-badge").textContent = t("Lese-Oberfläche");
    $("ro-badge").title = t("Nur Suche und Anzeige – Änderungen sind hier nicht möglich (dafür der Curator)");
    $("brand-title").textContent = t("Kanonik lesen");
    document.title = t("Kanonik lesen");
  }
  if (!state.config.readonly || state.config.viewer) await loadDocling();
  renderQuellenMenu();
  if (state.config.readonly) $("basis-btn").hidden = true;
  if (STATIC) {                                    // öffentliche Demo: nur lesen, ohne Kuration, Chat und Code
    await window.KANONIK_STATIC.bereit;
    for (const id of ["tab-props", "tab-dec", "tab-src", "chat-btn", "adv", "f-herkunft"]) if ($(id)) $(id).hidden = true;
    $("mode").textContent = t("Öffentliche Demo");
  }
  $("basis-btn").addEventListener("click", () => { state.basisOpen = !state.basisOpen; renderBasis(); });
  $("tab-onto").hidden = !ontoAn();
  renderBasis(); listenDocling(); initChat();
  if (state.config.mode === "neo4j") pruefeGraphDomaene();
  if (state.config.about) $("about-link").hidden = false;
  if (state.config.rules_page) $("rules-link").hidden = false;
  loadDisplay();
  renderDisplay();
  $("f-herkunft").addEventListener("change", search);
  $("mode").title = state.config.log ? t("Protokoll: {log}", { log: state.config.log }) : "";
  for (const l of Object.keys(state.config.labels)) $("f-type").append(h("option", { value: l, text: l }));
  const ro = state.config.search_readonly || [];
  if (ro.length) $("f-type").append(h("optgroup", { label: t("Schnittstelle und BPMN (nur lesen)") },
    ...ro.map((l) => h("option", { value: l, text: t("{label} (nur lesen)", { label: l }) }))));
  for (const s of state.config.status_values || []) $("f-status").append(h("option", { value: s, text: STATUS_DE[s] || s }));
  for (const d of docs()) for (const id of ["f-doc", "p-doc"]) $(id).append(h("option", { value: d.id, text: `${d.short || d.id} (${(d.lang || "").toUpperCase()})`, title: d.title }));
  if (docs().length < 2) { $("f-doc").hidden = true; $("p-doc").hidden = true; }
  for (const [k, a] of Object.entries(state.config.herkunft || {}))
    for (const id of ["f-herkunft", "p-herkunft"]) $(id).append(h("option", { value: k, text: herkunftTitle(k), title: L(a.hint || "") }));
  const u = storage("curator.user") || state.config.default_user || "";
  $("user").value = u;
  $("user").addEventListener("change", () => storage("curator.user", $("user").value.trim()));
  const lastType = storage("curator.type");
  if (lastType !== null && (lastType === "" || state.config.labels[lastType] || ro.includes(lastType))) $("f-type").value = lastType;
  else if (state.config.labels.Requirement && !state.config.viewer) $("f-type").value = "Requirement";
  $("q").addEventListener("input", scheduleSearch);
  $("f-type").addEventListener("change", () => { storage("curator.type", $("f-type").value); search(); renderAdv(); });
  $("adv-add").addEventListener("click", () => { state.filters.push({ prop: "", op: "contains", value: "" }); $("adv").open = true; renderAdv(); });
  $("adv-clear").addEventListener("click", () => { state.filters = []; saveFilters(); renderAdv(); });
  $("adv").addEventListener("toggle", () => { if ($("adv").open && !state.filters.length) { state.filters.push({ prop: "", op: "contains", value: "" }); renderAdv(); } });
  renderAdv();
  $("f-status").addEventListener("change", search);
  $("f-doc").addEventListener("change", search);
  $("search-form").addEventListener("submit", (e) => { e.preventDefault(); search(); });
  for (const [k, v] of Object.entries(PROP_STATUS)) $("p-status").append(h("option", { value: k, text: v }));
  $("pq").addEventListener("input", scheduleProposals);
  $("p-min").addEventListener("input", scheduleProposals);
  $("p-weak").addEventListener("change", () => searchProposals());
  $("p-onto").addEventListener("change", () => searchProposals());
  $("p-sicht").addEventListener("change", () => searchProposals());
  $("p-agent").addEventListener("change", () => searchProposals());
  const lastSame = storage("curator.same");
  if (lastSame !== null) $("p-same").value = lastSame;
  $("p-same").addEventListener("change", () => { storage("curator.same", $("p-same").value); searchProposals(); });
  for (const id of ["p-type", "p-status", "p-method", "p-doc", "p-herkunft"]) $(id).addEventListener("change", () => searchProposals());
  $("prop-form").addEventListener("submit", (e) => { e.preventDefault(); searchProposals(); });
  $("tab-nodes").addEventListener("click", () => zuAnsicht("nodes"));
  $("tab-props").addEventListener("click", () => zuAnsicht("props"));
  $("tab-review").addEventListener("click", () => zuAnsicht("review"));
  $("tab-meta").addEventListener("click", () => zuAnsicht("meta"));
  $("tab-onto").addEventListener("click", () => zuAnsicht("onto"));
  $("oq").addEventListener("input", () => renderOntoList());
  $("o-sicht").addEventListener("change", () => renderOntoList());
  $("onto-form").addEventListener("submit", (e) => e.preventDefault());
  $("tab-dec").addEventListener("click", () => zuAnsicht("dec"));
  $("tab-src").addEventListener("click", () => zuAnsicht("src"));
  $("tab-gap").addEventListener("click", () => zuAnsicht("gap"));
  $("mq").addEventListener("input", () => renderMetaList());
  $("m-kind").addEventListener("change", () => renderMetaList());
  $("m-used").addEventListener("change", () => renderMetaList());
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (state.node && isDirty()) doAction("save"); }
  });
  window.addEventListener("beforeunload", (e) => { if (state.node && isDirty()) { e.preventDefault(); e.returnValue = ""; } });
  // Zurück/Vor und Sprungziel aus einem anderen Fenster (Vergleichsfenster wird wiederverwendet: nur der Hash ändert sich)
  const onHash = () => {
    const an = ansichtAusHash();
    if (an) { if (location.hash !== state.shownHash) zuAnsicht(an.tab, an.kat, false); return; }
    const hs = parseHash();
    if (hs && !(state.node && state.node.id === hs.id && location.hash === state.shownHash)) openNode(hs.id, { push: false, label: hs.label });
  };
  window.addEventListener("popstate", onHash);
  window.addEventListener("hashchange", onHash);
  // Fenster wieder sichtbar (z. B. nach Größenänderung, Wiederherstellen aus dem Cache): Inhalt an die eigene Adresse halten
  const heal = () => { const hs = parseHash(); if (hs && state.node && state.node.id !== hs.id) openNode(hs.id, { push: false, label: hs.label }); };
  window.addEventListener("pageshow", heal);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) heal(); });
  $("win-pin").addEventListener("click", togglePin);
  applyWinName();
  loadStats();
  state.tab = "nodes";
  await search();
  // Reiter: Ein Fenster, das mit einem Knoten geöffnet wurde (neues Fenster, „↗“, Link), zeigt den Knoten – der Browser
  // gibt neuen Fenstern eine Kopie des sessionStorage mit, sonst erbte es z. B. den Prüfstand des öffnenden Fensters.
  // Nur beim Neuladen bzw. Zurückkehren gilt der zuletzt gewählte Reiter dieses Fensters.
  const hs = parseHash();
  const nav = (performance.getEntriesByType && performance.getEntriesByType("navigation")[0]) || {};
  const restore = !hs || nav.type === "reload" || nav.type === "back_forward";
  const lastTab = restore ? storage("curator.tab") : null;
  if (lastTab === "props" || lastTab === "review" || lastTab === "meta" || lastTab === "onto") setTab(lastTab);
  else if (hs) storage("curator.tab", "nodes");
  if (hs) openNode(hs.id, { push: false, label: hs.label });
  const an = ansichtAusHash();                         // Ansicht aus der Adresse (#v=gap&k=suche – auch als Lesezeichen)
  if (an) zuAnsicht(an.tab, an.kat, false);
  // Sprungziel aus der Job-Steuerung: ?tab=props&type=EXACT_MATCH&same=first (danach aus der Adresse entfernt)
  const qs = new URLSearchParams(location.search), qt = qs.get("tab");
  if (["nodes", "props", "review", "meta", "onto", "dec", "src"].includes(qt)) {
    const ty = qs.get("type");
    if (ty) {
      if (![...$("p-type").options].some((o) => o.value === ty)) $("p-type").append(h("option", { value: ty, text: relTitle(ty) }));
      $("p-type").value = ty;
    }
    if (qs.get("same")) $("p-same").value = qs.get("same");
    setTab(qt);
    history.replaceState(history.state, "", location.pathname + location.hash);
  }
}
init();

// ------------------------------------------------------------------ Lücken: BPMN als Graph (luecken.bpmn_graph)
// Vorhandenes Modell (Code-Repository) und abgeleitete Modelle (aus dem Fachkonzept, out/bpmn/) als Diagramm; je Element
// gefärbt: passt (grün), fehlt im BPMN (rot, nur abgeleitete Seite), nur im BPMN (orange, nur vorhandene Seite),
// teilweise (gelb, Aufruf eines Bausteins im Hauptprozess); Kennungen der Lücken als Marke am Element.
const GG_STATUS = () => ({ passt: t("passt – hat ein Gegenstück"),
  anders: t("umgesetzt, anders modelliert (Verzweigung ohne eigenes Gateway)"), fehlt: t("fehlt im BPMN – im Fachkonzept beschrieben, nicht umgesetzt"),
  nur: t("nur im BPMN – im Fachkonzept nicht beschrieben"), teilweise: t("teilweise umgesetzt (Baustein)"), offen: t("nicht verglichen") });
function gapGraph() {
  const box = h("div", {}, h("div", { class: "muted small" }, h("span", { class: "spinner" }), t("lädt …")));
  (async () => {
    let g;
    try { g = state.gapGraph || (state.gapGraph = await api("/api/luecken/bpmn")); }
    catch (e) { box.replaceChildren(h("div", { class: "card warn", text: e.message })); return; }
    if (!g.prozesse.length) {                            // ohne BPMN (z. B. reine Ereignisdomäne): nur die Nachrichten mit Partnern
      const K = g.kommunikation || { nachrichten: [] };
      if (!K.nachrichten.length) { box.replaceChildren(h("div", { class: "muted small", text: t("keine") })); return; }
      const detail = h("div", { class: "gg-detail small" });
      const klick = (n) => gkSetze(detail,
        h("div", {}, h("strong", { text: n.name }), " ", h("span", { class: "muted", text: n.titel || "" })),
        ...n.abweichungen.map((x) => h("div", { class: "gk-abw", text: `≠ ${x.text}` })),
        h("div", { class: "mono gk-code" }, ...n.code.sendet.map((c) => h("div", {}, "→ ", ...belegZeile(c.beleg))), ...n.code.empfaengt.map((c) => h("div", {}, "← ", ...belegZeile(c.beleg)))),
        ...n.luecken.map((k) => gapInfo(k)).filter(Boolean));
      box.replaceChildren(h("div", { class: "card" }, h("div", { class: "muted small", text: t("Kein BPMN-Modell abgeleitet – Nachrichten mit Partnern im Code") }),
        ...gkTabelle(K, klick), detail));
      return;
    }
    const leg = h("div", { class: "gg-legende small" }, ...Object.entries(GG_STATUS()).map(([k, txt]) =>
      h("span", {}, h("span", { class: `gg-dot gg-dot-${k}` }), txt)), h("span", {}, h("span", { class: "gg-badge" }, "K01"), t("Lücke am Element")));
    box.replaceChildren(leg, ...g.prozesse.map(gapGraphProzess));
  })();
  return [box];
}
// Größe der Diagramme steuern: Zoom (−, +, Einpassen, 1:1, auch Strg+Mausrad), Höhe am unteren Rand ziehen (je Seite im
// Browser gemerkt), Vollbild (Esc beendet)
function ggSteuerung(container, canvas, seite) {
  seite = seite || container.dataset.seite || "x";
  const key = `luecken.graph.hoehe.${seite}`;
  try { const hh = Number(localStorage.getItem(key)); if (hh) container.style.height = `${hh}px`; } catch { /* nur Komfort */ }
  const zoom = (f) => { const z = canvas.zoom(); canvas.zoom(Math.max(0.1, Math.min(4, z * f)), "auto"); };
  const voll = (an) => {
    container.classList.toggle("gg-voll", an);
    document.body.classList.toggle("gg-voll-offen", an);
    if (an) { container._esc = (e) => { if (e.key === "Escape") voll(false); }; document.addEventListener("keydown", container._esc); }
    else if (container._esc) { document.removeEventListener("keydown", container._esc); container._esc = null; }
    knopfVoll.textContent = an ? "✕" : "⤢"; knopfVoll.title = an ? t("Vollbild beenden (Esc)") : t("Vollbild");
    requestAnimationFrame(() => { canvas.resized(); canvas.zoom("fit-viewport", "auto"); });
  };
  const knopf = (txt, title, fn) => h("button", { type: "button", class: "small", title, "aria-label": title, onclick: (e) => { e.stopPropagation(); fn(); } }, txt);
  const knopfVoll = knopf("⤢", t("Vollbild"), () => voll(!container.classList.contains("gg-voll")));
  const leiste = h("div", { class: "gg-zoom" },
    knopf("−", t("verkleinern"), () => zoom(1 / 1.25)), knopf("+", t("vergrößern"), () => zoom(1.25)),
    knopf(t("Einpassen"), t("ganzes Diagramm zeigen"), () => canvas.zoom("fit-viewport", "auto")),
    knopf("1:1", t("Originalgröße"), () => canvas.zoom(1, "auto")), knopfVoll);
  container.appendChild(leiste);
  let warte = null;
  if (container._ro) container._ro.disconnect();
  container._ro = new ResizeObserver(() => {
    clearTimeout(warte);
    warte = setTimeout(() => {
      canvas.resized();
      if (!container.classList.contains("gg-voll") && container.offsetHeight > 120)
        try { localStorage.setItem(key, String(container.offsetHeight)); } catch { /* nur Komfort */ }
    }, 120);
  });
  container._ro.observe(container);
}
async function ggViewer(container, xml, info, onClick, opts = {}) {
  await loadBpmnJs();
  container.replaceChildren();
  const viewer = new window.BpmnJS({ container });
  await viewer.importXML(xml);
  const canvas = viewer.get("canvas"), reg = viewer.get("elementRegistry"), ov = viewer.get("overlays");
  for (const [id, st] of Object.entries(info.status || {})) if (st !== "offen" && st !== "–" && reg.get(id)) canvas.addMarker(id, opts.komm ? `gk-${st}` : `gg-${st}`);
  if (opts.komm)                                         // Kommunikation: alles ohne Nachrichtenbezug abblenden
    for (const el of reg.getAll()) if (!(el.id in info.status) && el.type !== "label" && el.type !== "bpmn:Participant" && el.type !== "bpmn:Lane"
      && el.type !== "bpmn:Process" && el.type !== "bpmn:Collaboration" && el.type !== "bpmn:MessageFlow") canvas.addMarker(el.id, "gk-dim");
  for (const [id, ks] of Object.entries(info.luecken || {}))
    if (ks.length && reg.get(id)) ov.add(id, { position: { top: -12, right: 14 }, html: `<span class="gg-badge gg-badge-klick" data-k="${ks.map((k) => String(k).replace(/[&<>" ]/g, "")).join(" ")}" title="${t("Lücke anzeigen")}">${ks.map((k) => String(k).replace(/[&<>"]/g, "")).join(" ")}</span>` });
  container._marke = opts.marke || null;                 // Klick auf eine Marke: die Lücken anzeigen
  if (!container._markeHoerer) {
    container._markeHoerer = true;
    container.addEventListener("click", (e) => {
      const m = e.target.closest && e.target.closest(".gg-badge-klick");
      if (m && container._marke) { e.stopPropagation(); container._marke(m.dataset.k.split(" ")); }
    });
  }
  canvas.zoom("fit-viewport");
  ggSteuerung(container, canvas, opts.seite);
  viewer.get("eventBus").on("element.click", (ev) => {
    const el = ev.element.type === "label" ? ev.element.labelTarget : ev.element;
    if (!el || el.waypoints || !el.businessObject || el.type === "bpmn:Process" || el.type === "bpmn:Collaboration") return;
    onClick(el.id, el.businessObject.name || el.id, el.type.replace("bpmn:", ""));
  });
  container.classList.add("clickable");
  let fokus = null;
  return {
    fokus(id) {
      const el = reg.get(id);
      if (!el) return;
      if (fokus) canvas.removeMarker(fokus, "gg-fokus");
      canvas.addMarker(id, "gg-fokus"); fokus = id;
      const vb = canvas.viewbox(), z = Math.min(1, vb.outer.width / 900), w = vb.outer.width / z, hh = vb.outer.height / z;
      canvas.viewbox({ x: el.x + (el.width || 0) / 2 - w / 2, y: el.y + (el.height || 0) / 2 - hh / 2, width: w, height: hh });
    },
  };
}
// Ansicht „Kommunikation“: Nachrichten mit Partnern (luecken.kommunikation) – sendende/empfangende Elemente und
// Nachrichtenflüsse nach Gesamtstand gefärbt, übrige Elemente abgeblendet, Liste der Nachrichten neben dem Diagramm.
const GK_STAND = () => ({ ok: t("gesendet und empfangen"), fehlt: t("fehlt im BPMN oder im Code"), abweichend: t("Partner abweichend"),
  teilweise: t("teilweise"), "–": t("nicht modelliert") });
const GK_ZEICHEN = { ok: "✓", fehlt: "✗", teilweise: "◐", abweichend: "≠", "–": "–" };
function gkInfo(nachrichten, seite, baustein) {
  const status = {}, luecken = {}, je = {};
  for (const n of nachrichten) {
    const els = seite === "v" ? n.vorhanden.map((x) => x.id) : n.abgeleitet.filter((x) => x.baustein === baustein).map((x) => x.element);
    for (const id of els) {
      status[id] = status[id] && status[id] !== n.gesamt ? "teilweise" : n.gesamt;
      if (seite === "a") status[`MsgFlow_${id}`] = status[id];
      luecken[id] = [...new Set([...(luecken[id] || []), ...n.luecken])];
      (je[id] = je[id] || []).push(n);
      if (seite === "a" && n.luecken.length) luecken.Participant_Teilnehmer = [...new Set([...(luecken.Participant_Teilnehmer || []), ...n.luecken])];
    }
  }
  return { status, luecken, je };
}
function gkTabelle(K, nachricht) {
  return [
    h("h3", { text: t("Nachrichten mit Partnern") }),
    h("div", { class: "muted small", text: t("laut Kapitel {k}; Stand im vorhandenen BPMN und im Code", { k: K.kapitel || "–" }) }),
    K.nachrichten.length ? h("table", { class: "paths review gk-tab" },
      h("thead", {}, h("tr", {}, ...[t("Nachricht") + " · " + t("Sender → Empfänger"), "BPMN", "Code", t("Partner")].map((x) => h("th", { text: x })))),
      h("tbody", {}, ...K.nachrichten.map((n) => h("tr", { "data-n": n.name, class: `gk-${n.gesamt}`, tabindex: "0", onclick: () => nachricht(n),
        onkeydown: (e) => { if (e.key === "Enter") nachricht(n); } },
        h("td", {}, h("div", {}, h("span", { class: `gg-dot gk-dot-${n.gesamt}` }), n.name,
          n.luecken.length ? h("span", { class: "gg-badge gk-badge", text: n.luecken.join(" ") }) : null),
          h("div", { class: "muted gk-weg", text: `${n.von} → ${n.an.join(", ")}` })),
        ...["bpmn", "code", "partner"].map((k) => h("td", { class: `gk-z gk-z-${n.stand[k]}`, title: k === "partner" ? (n.abweichungen.map((x) => x.text).join("; ") || t("wie im Fachkonzept")) : "",
          text: k === "partner" ? (n.stand.partner === "abweichend" ? "≠" : "✓") : GK_ZEICHEN[n.stand[k]] || n.stand[k] }))))))
      : h("div", { class: "muted small", text: t("keine Nachrichtentabelle im Fachkonzept") })];
}
// Lücke im BPMN-Graph: Karte mit Entscheidung (Ansicht bleibt stehen), dazu was die Entscheidung stützt –
// Anforderungen mit Text, Abschnitte im Dokument, Codestellen mit Ausschnitt und Sprung in die ganze Datei
function gapInfo(id) {
  const x = (state.gap.luecken || []).find((y) => y.id === id);
  if (!x) return null;
  const sx = ((state.gapSichten || {}).luecken || {})[id] || { codestellen: [], dokumentstellen: [] };
  const reqs = {};
  for (const k of (state.gapSichten || { oben: [] }).oben || []) for (const e of k.eintraege) reqs[e.id] = { ...e, kapitel: k.kapitel };
  const box = h("div", { class: "gg-luecke" });
  const bauen = () => gkSetze(box, gapCard(x, () => bauen()),
    x.anforderungen.length ? h("div", { class: "gap-sub small" }, h("strong", { text: t("Anforderungen: ") }),
      ...x.anforderungen.map((a) => reqs[a] ? gapReqLine(reqs[a], false) : h("div", { class: "mono", text: a }))) : null,
    sx.dokumentstellen.length ? h("div", { class: "gap-sub small" }, h("strong", { text: t("Abschnitte: ") }),
      ...sx.dokumentstellen.map((d) => h("div", {}, `${d.kapitel} ${d.titel || ""} – ${d.text} `, gapSectionLink(d.kapitel)))) : null,
    sx.codestellen.length ? h("div", { class: "gap-sub small" }, h("strong", { text: t("Codestellen: ") }), ...sx.codestellen.map(gapCode)) : null);
  bauen();
  return box;
}
function gkSetze(el, ...xs) { el.replaceChildren(...xs.flat().filter((x) => x !== null && x !== undefined && x !== false)); }
function gapGraphProzess(p) {
  const v = p.vorhanden, ab = p.abgeleitet, K = (state.gapGraph.kommunikation || { nachrichten: [] });
  const zahl = (z) => [["passt", t("passt")], ["anders", t("anders modelliert")], ["fehlt", t("fehlt")], ["nur", t("nur im BPMN")], ["teilweise", t("teilweise")]]
    .filter(([k]) => z[k]).map(([k, txt]) => h("span", { class: `pill gg-pill-${k}`, text: `${z[k]} ${txt}` }));
  const boxV = h("div", { class: "bpmn-box gg-canvas", "data-seite": "v" }), boxA = h("div", { class: "bpmn-box gg-canvas", "data-seite": "a" });
  const detail = h("div", { class: "gg-detail small muted", text: t("Ein Element anklicken: Kennzeichen, Gegenstück und Lücken") });
  const wahl = h("select", { "aria-label": t("Abgeleitetes Modell") },
    ...ab.map((b) => h("option", { value: b.baustein, text: `${b.titel}${b.baustein === p.prozess ? " – " + t("Hauptprozess") : ""}`
      + ` (${b.zahl.passt} ${t("passt")}, ${b.zahl.fehlt + b.zahl.teilweise} ${t("fehlt")})` })));
  const zahlA = h("span", {}), zahlV = h("span", {});
  const liste = h("div", { class: "gk-liste" });
  const body = h("div", { class: "gg-body" });
  // Ansicht Kommunikation auch per Adresse (#v=gap&k=graph&m=kommunikation – Tour der Demo)
  let vw = null, aw = null, aktuell = null, modus = new URLSearchParams(location.hash.slice(1)).get("m") === "kommunikation" ? "kommunikation" : "ablauf";
  const komm = () => modus === "kommunikation";
  const lueckenListe = (ks) => ks.map((k) => gapInfo(k)).filter(Boolean);
  const zeigeLuecken = (ks) => { gkSetze(detail, ...lueckenListe(ks)); detail.scrollIntoView({ block: "nearest", behavior: "smooth" }); };
  const zeigen = (id, name, art, st, ks, gegen) => gkSetze(detail, 
    h("div", {}, h("strong", { text: name }), " ", h("span", { class: "muted", text: `${art} · ${id}` })),
    h("div", {}, h("span", { class: `gg-dot gg-dot-${st}` }), GG_STATUS()[st] || st),
    gegen ? h("div", {}, h("button", { type: "button", class: "small", onclick: gegen.los }, gegen.text)) : null,
    ...(ks && ks.length ? lueckenListe(ks) : []));
  const nachricht = (n) => {
    for (const r of liste.querySelectorAll("tr[data-n]")) r.classList.toggle("an", r.dataset.n === n.name);
    const a0 = n.abgeleitet[0], v0 = n.vorhanden[0];
    gkSetze(detail, 
      h("div", {}, h("strong", { text: n.name }), " ", h("span", { class: "muted", text: n.titel || "" })),
      h("div", {}, t("laut Kapitel {k}: {von} → {an}", { k: K.kapitel || "–", von: n.von, an: n.an.join(", ") })),
      h("div", {}, h("span", { class: `gg-dot gk-dot-${n.gesamt}` }), GK_STAND()[n.gesamt] || n.gesamt, " · ",
        `BPMN ${GK_ZEICHEN[n.stand.bpmn] || n.stand.bpmn} · Code ${GK_ZEICHEN[n.stand.code] || n.stand.code} · ${t("Partner")} ${GK_ZEICHEN[n.stand.partner] || "✓"}`),
      ...n.abweichungen.map((x) => h("div", { class: "gk-abw", text: `≠ ${x.text}` })),
      n.code.sendet.length || n.code.empfaengt.length ? h("div", { class: "mono gk-code" },
        ...n.code.sendet.map((c) => h("div", {}, "→ ", ...belegZeile(c.beleg))), ...n.code.empfaengt.map((c) => h("div", {}, "← ", ...belegZeile(c.beleg)))) : null,
      h("div", { class: "actions" },
        a0 ? h("button", { type: "button", class: "small", onclick: () => ladeA(a0.baustein, a0.element) }, t("im abgeleiteten Modell zeigen")) : null,
        v0 && vw ? h("button", { type: "button", class: "small", onclick: () => vw.fokus(v0.id) }, t("im vorhandenen BPMN zeigen")) : null),
      ...lueckenListe(n.luecken));
  };
  const elementKomm = (id, name, art, info) => {
    const ns = info.je[id] || (id === "Participant_Teilnehmer" ? K.nachrichten.filter((n) => n.abgeleitet.some((x) => x.baustein === aktuell?.baustein)) : []);
    if (ns.length === 1) return nachricht(ns[0]);
    gkSetze(detail, h("div", {}, h("strong", { text: name }), " ", h("span", { class: "muted", text: `${art} · ${id}` })),
      ns.length ? h("div", { class: "actions" }, ...ns.map((n) => h("button", { type: "button", class: "small", onclick: () => nachricht(n) }, n.name)))
        : h("div", { class: "muted", text: t("keine Nachricht mit Partnern") }));
  };
  const ladeA = async (baustein, fokus) => {
    const b = ab.find((x) => x.baustein === baustein); if (!b) return;
    wahl.value = baustein; aktuell = b; zahlA.replaceChildren(...(komm() ? [] : zahl(b.zahl)));
    boxA.replaceChildren(h("div", { class: "muted", text: t("lädt …") }));
    try {
      const r = await fetch(`/api/bpmn_xml?${new URLSearchParams({ file: b.datei })}`);
      if (!r.ok) throw new Error(t("BPMN-Datei {file} nicht gefunden", { file: b.datei }));
      const info = komm() ? gkInfo(K.nachrichten, "a", b.baustein) : b;
      aw = await ggViewer(boxA, await r.text(), info, (id, name, art) => {
        if (b.aufrufe[id]) { ladeA(b.aufrufe[id]); return; }
        if (komm()) return elementKomm(id, name, art, info);
        const g = b.gegen[id];
        zeigen(id, name, art, b.status[id] || "offen", b.luecken[id],
          g && vw ? { text: t("im vorhandenen BPMN zeigen"), los: () => vw.fokus(g) } : null);
      }, { komm: komm(), marke: zeigeLuecken });
      if (fokus) aw.fokus(fokus);
    } catch (e) { boxA.replaceChildren(h("div", { class: "muted", text: e.message })); }
  };
  const ladeV = async () => {
    zahlV.replaceChildren(...(v && !komm() ? zahl(v.zahl) : []));
    if (!v) { boxV.replaceChildren(h("div", { class: "muted", text: t("kein vorhandenes BPMN-Modell zugeordnet") })); return; }
    try {
      const r = await fetch(`/api/luecken/bpmn_vorhanden?${new URLSearchParams({ datei: v.datei })}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      const info = komm() ? gkInfo(K.nachrichten, "v") : v;
      vw = await ggViewer(boxV, await r.text(), info, (id, name, art) => {
        if (komm()) return elementKomm(id, name, art, info);
        const g = v.gegen[id];
        zeigen(id, name, art, v.status[id] || "offen", v.luecken[id],
          g ? { text: t("im abgeleiteten Modell zeigen"), los: () => (aktuell && aktuell.baustein === g.baustein ? aw && aw.fokus(g.element) : ladeA(g.baustein, g.element)) } : null);
      }, { komm: komm(), marke: zeigeLuecken });
    } catch (e) { boxV.replaceChildren(h("div", { class: "muted", text: e.message })); }
  };
  const listeZeigen = () => liste.replaceChildren(...gkTabelle(K, nachricht));
  const schalter = h("div", { class: "modes gg-modus", role: "tablist" },
    ...[["ablauf", t("Ablauf")], ["kommunikation", t("Kommunikation")]].map(([k, txt]) => h("button", {
      type: "button", role: "tab", "aria-selected": String(k === modus), onclick: (e) => {
        if (modus === k) return;
        modus = k;
        for (const b of schalter.children) b.setAttribute("aria-selected", String(b === e.currentTarget));
        body.classList.toggle("komm", komm()); liste.hidden = !komm();
        legende.replaceChildren(...legendeTeile());
        gkSetze(detail, document.createTextNode(komm() ? t("Eine Nachricht oder ein Element anklicken") : t("Ein Element anklicken: Kennzeichen, Gegenstück und Lücken")));
        ladeV(); if (aktuell) ladeA(aktuell.baustein);
      } }, txt)));
  const legendeTeile = () => komm()
    ? [...Object.entries(GK_STAND()).filter(([k]) => k !== "–").map(([k, txt]) => h("span", {}, h("span", { class: `gg-dot gk-dot-${k}` }), txt)),
       h("span", { class: "muted", text: t("übrige Elemente abgeblendet") })]
    : [];
  const legende = h("div", { class: "gg-legende small" });
  liste.hidden = !komm();
  body.classList.toggle("komm", komm());
  legende.replaceChildren(...legendeTeile());
  listeZeigen();
  (async () => { await ladeV(); const erst = ab.find((b) => b.baustein === p.prozess) || ab[0]; if (erst) ladeA(erst.baustein); })();
  body.append(h("div", { class: "gg-diagramme" },
    h("div", { class: "gg-kopf" }, h("strong", { text: t("Vorhandenes BPMN (Code)") }), v ? h("span", { class: "muted small mono", text: v.datei }) : null,
      v ? quellLink({ art: "code", datei: v.datei }, t("XML ansehen ↗")) : null, zahlV),
    boxV,
    h("div", { class: "gg-kopf" }, h("strong", { text: t("Aus dem Fachkonzept abgeleitet") }), wahl, zahlA),
    boxA, detail), liste);
  wahl.addEventListener("change", () => ladeA(wahl.value));
  return h("div", { class: "card gg-prozess" },
    h("div", { class: "gg-kopf" }, h("h2", { text: `${p.name || p.prozess} ↔ ${v ? v.prozess || "–" : "–"}` }), schalter),
    legende, body);
}
