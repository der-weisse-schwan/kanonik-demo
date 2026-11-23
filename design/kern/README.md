# KERN UX-Standard (Auszug)

Für das Erscheinungsbild „KERN“ aller Oberflächen (`common/static/design/design-kern.css`, ausgeliefert unter `/design/`):

| Datei | Herkunft | Lizenz |
|---|---|---|
| `kern-tokens.css` | `@kern-ux/native` 2.9.0, `dist/kern.css` Zeilen 159–1023 (nur Gestaltungsvariablen), unverändert | EUPL-1.2 (`LICENSE.md`) |
| `fira-sans.css`, `fonts/*.woff2` | `@kern-ux/native` 2.9.0, `dist/fonts/fira-sans` (Regular, Italic, SemiBold, Bold) | SIL Open Font License 1.1 (`OFL-fira-sans.txt`) |

Aktualisieren: Paket laden (`npm pack @kern-ux/native`), den Bereich der Variablen in `dist/kern.css` neu bestimmen
(erste `:root`-Regel bis vor `_layers.scss`) und hier ersetzen. Projekt: https://gitlab.opencode.de/kern-ux
