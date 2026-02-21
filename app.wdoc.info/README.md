# WDOC Webapp

The crew is tired of bowing to PDFs. This Angular 20 web app is our guerrilla reader for `.wdoc` archives—zipped HTML bundles meant to replace the old format and let us hack, remix, and ship documents without the heavy armor.

## Quick start (load the ammo)
1. Clone the repo and pull the example payloads:
   ```bash
   git clone <this repo>
   cd wdoc-webapp
   git submodule update --init --recursive  # grab ./examples
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

## Working with the example docs
The `examples/` directory is a git submodule. Initialize or refresh it whenever you clone:
```bash
git submodule update --init --recursive
```
Point the viewer at those `.wdoc` files to demo the app or to debug new behaviors.

## More angular firepower
Check the [Angular CLI documentation](https://angular.dev/tools/cli) for every command and option. When in doubt, we prototype fast, test hard, and keep iterating—because mighty PDF won’t overthrow itself.
