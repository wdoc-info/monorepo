# WDOC Webapp

The crew is tired of bowing to PDFs. This Angular 20 web app is our guerrilla reader for `.wdoc` archives—zipped HTML bundles meant to replace the old format and let us hack, remix, and ship documents without the heavy armor.

## Quick start (load the ammo)
1. Clone the repo:
   ```bash
   git clone <this repo>
   cd wdoc-webapp
   ```
2. Install dependencies (Node 20+ recommended):
   ```bash
   npm install
   ```
3. Fire up the dev server:
   ```bash
   npm start
   ```
   Hit `http://localhost:4200` and the hot reload loop keeps you in the fight.

## Features that help us topple PDFs
- **Native `.wdoc` loader**: open zipped HTML locally or via `?url=` query param; finds `index.html` even when tucked in a folder.
- **Drag, drop, done**: drop a `.wdoc` anywhere on the viewport, or select it from the side nav.
- **Form capture & re-packaging**: edit forms inside the doc, then save a fresh `filled.wdoc` with inputs and uploaded files written under `wdoc-form/`.
- **Safe rendering**: strips external scripts/iframes and inlines archive images so nothing sneaks past.
- **Zoom & responsive layout**: side nav auto-switches between drawer and inline, and pages auto-fit the viewport.

## Development server
Run `npm start` (alias for `ng serve`) to launch the local server. The app rebuilds and reloads as you edit.

## Code scaffolding
Need a new widget for the rebellion? Generate it with Angular CLI:
```bash
ng generate component component-name
```
Use `ng generate --help` to see all schematics.

## Building for deployment
Produce a production build with:
```bash
npm run build
```
Artifacts land in `dist/`—ready for static hosting or being bundled with your favorite ops toolkit.

## Unit tests
Run the Karma/Jasmine suite headless:
```bash
npm test
```

## End-to-end tests
We keep Playwright in the holster:
```bash
npm run e2e
```
Start the dev server first if the test scenario needs it.

## Coverage gizmo
Get the numbers before shipping more ammo:
```bash
npm test -- --code-coverage
```
Open `coverage/index.html` (or the generated project folder under `coverage/`) to inspect the report.

## More angular firepower
Check the [Angular CLI documentation](https://angular.dev/tools/cli) for every command and option. When in doubt, we prototype fast, test hard, and keep iterating—because mighty PDF won’t overthrow itself.

## Local folders

For direct local-folder access, linked-file saving, and browser fallbacks, see
[Local folders in the web app](../docs/local-files.md).

## Document fonts

Use standard `@font-face` declarations for archive-local font files or HTTPS font
URLs. The WYSIWYG toolbar's **Search Google Fonts** and **Font** controls browse
the bundled Google Fonts catalog by name and apply a family to the selected text
or subsequent typing. Only selected families are downloaded; their available
regular, bold, and italic styles are requested through Google's CSS2 API without
an API key. Already loaded families remain available under **Document fonts**.
The **Add an external font** control also accepts a direct font file or a font
stylesheet URL.
Google Fonts, Bunny Fonts, and Fontsource's dedicated CDN paths load automatically.
**Font settings** manages browser-local origin permissions and explicit blocks.
The reader reports loading failures separately and keeps text readable with a
fallback font. Export and signing pin remote font bytes in
`content.externalFonts`; existing signed source bytes are never silently replaced.
**Include fonts for offline viewing** adds verified copies without changing
content signatures. Adding copies can obsolete a previous whole-archive seal.
Local font declarations and binaries survive editing and export.

The catalog is a local snapshot of Google Fonts family names and supported styles,
so opening or searching the picker makes no catalog requests. To refresh it:

```sh
curl -fLsS https://fonts.google.com/metadata/fonts -o /tmp/google-fonts-metadata.json
node scripts/update-google-fonts.mjs /tmp/google-fonts-metadata.json
```

See [`google_fonts.wdoc`](../examples.wdoc.info/unit_test/google_fonts.wdoc) and its
[HTML source](../examples.wdoc.info/unpacked/unit_test/google_fonts/index.html) for
a six-family example without bundled font files.

## Embedded version history

The editor stores local Git history inside each `.wdoc`, with 30-second autosave
branches, browser draft recovery, real merge commits on Save, restore-as-draft and
visual merging of another document copy. Linked files are updated directly.
There is no remote Git synchronization. See [the version history guide](../docs/version-history.md)
for operation and signature boundaries.
