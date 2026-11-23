"use strict";
// Erscheinungsbild aller Oberflächen (common/static/design, ausgeliefert unter /design/): KERN (UX-Standard der
// öffentlichen Verwaltung) ist Standard, „Kanonik (klassisch)“ wählbar. Im <head> vor dem ersten Zeichnen laden –
// setzt <html data-design="kern">. Wahl: ?design=kern|klassisch in der Adresse bzw. je Browser gespeichert.
// Auswahlfeld: kanonikDesign.wahl() bzw. automatisch in ein Element mit id="design-wahl".
(function () {
  const KEY = "kanonik.design", root = document.documentElement;
  let d = null;
  try { d = new URLSearchParams(location.search).get("design") || localStorage.getItem(KEY); } catch (e) { /* ohne Speicher */ }
  const setzen = (v, merken) => {
    if (v === "klassisch") delete root.dataset.design; else root.dataset.design = "kern";
    if (merken) try { localStorage.setItem(KEY, v === "klassisch" ? "klassisch" : "kern"); } catch (e) { /* nur Komfort */ }
  };
  setzen(d === "klassisch" ? "klassisch" : "kern", false);
  const ZEICHEN = '<svg class="logo-zeichen" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><g style="stroke:var(--logo-a,#2044aa);stroke-width:5;stroke-linecap:round;fill:none"><path d="M18 14V50"/><path d="M18 32L46 14"/><path d="M18 32L46 50" style="stroke:var(--logo-b,#007155)"/></g><g style="fill:var(--logo-a,#2044aa)"><circle cx="18" cy="14" r="6.5"/><circle cx="18" cy="32" r="6.5"/><circle cx="18" cy="50" r="6.5"/><circle cx="46" cy="14" r="6.5"/></g><circle cx="46" cy="50" r="6.5" style="fill:var(--logo-grund,#fff);stroke:var(--logo-b,#007155);stroke-width:4"/></svg>';   // = common/logo.py ZEICHEN (Test)
  const de = { titel: "Erscheinungsbild", kern: "KERN (UX-Standard der Verwaltung)", klassisch: "Kanonik (klassisch)" };
  window.kanonikDesign = {
    zeichen: ZEICHEN,
    aktuell: () => (root.dataset.design === "kern" ? "kern" : "klassisch"),
    setzen: (v) => setzen(v, true),
    // texte: {titel, kern, klassisch} – übersetzt von der Oberfläche (sonst deutsch)
    wahl(texte) {
      const t = Object.assign({}, de, texte || {});
      const sel = document.createElement("select");
      sel.setAttribute("aria-label", t.titel);
      sel.title = t.titel;
      for (const k of ["kern", "klassisch"]) { const o = document.createElement("option"); o.value = k; o.textContent = t[k]; sel.append(o); }
      sel.value = this.aktuell();
      sel.addEventListener("change", () => this.setzen(sel.value));
      return sel;
    },
  };
  // Logo: Bildzeichen (common/static/design/logo) inline vor jedem Element mit data-logo, Farben aus dem
  // Erscheinungsbild (hell/dunkel); Favicon und App-Symbol im <head>
  const basis = ((document.currentScript && document.currentScript.src) || "").replace(/design\.js(\?.*)?$/, "");
  if (basis && !document.querySelector('link[rel="icon"]')) {
    for (const [rel, datei, typ] of [["icon", "favicon.svg", "image/svg+xml"], ["icon", "favicon-32.png", "image/png"], ["apple-touch-icon", "apple-touch-icon.png", ""]]) {
      const l = document.createElement("link"); l.rel = rel; l.href = basis + "logo/" + datei; if (typ) l.type = typ;
      document.head.append(l);
    }
  }
  document.addEventListener("DOMContentLoaded", () => {
    const z = document.getElementById("design-wahl");
    if (z && !z.querySelector("select")) z.append(window.kanonikDesign.wahl());
    for (const el of document.querySelectorAll("[data-logo]")) {
      if (!el.querySelector(".logo-zeichen")) el.insertAdjacentHTML("afterbegin", ZEICHEN);
    }
  });
})();
