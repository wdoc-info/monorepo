# Agent Guide for WDOC Project

## 1. Project Overview

This project is an **Angular 20+** application serving as a viewer for **.wdoc** files.
**What is a .wdoc?** It is a zipped archive containing:

- `index.html` (The entry point).
- `manifest.json` (Security verification and metadata).
- Assets (Images, CSS) referenced relatively.
- `wdoc-form/` (JSON data for form state persistence).

The viewer is designed as an "anti-PDF," rendering HTML/CSS natively in the browser while maintaining pagination and portability.

## 2. Tech Stack & Key Libraries

- **Framework:** Angular (Standalone Components used exclusively).
- **Build System:** Angular CLI.
- **Testing:**
  - **Unit:** Jasmine/Karma (`*.spec.ts` files).
- **Core Dependencies:**
  - `jszip`: For reading/writing .wdoc archives.
  - `dompurify`: For strict HTML sanitization.
  - `jsbarcode` & `qrcode`: For rendering barcode tags dynamically.
- **UI:** Angular Material (Sidenav, Dialogs).

## 3. Architecture & Data Flow

### Loading a Document

1. **Input:** File input or Drag-and-Drop.
2. **Loader:** `WdocLoaderService` reads the ArrayBuffer.
3. **Verification:** Validates `manifest.json` SHA-256 hashes before processing. **Fail if mismatch.**.
4. **Processing:** `HtmlProcessingService` sanitizes HTML and handles asset injection.

### Pagination Logic (Critical Complexity)

The viewer does **client-side pagination**. It does not use standard CSS print media queries for the view mode.

- **Splitter:** `HtmlPageSplitter` iterates through DOM nodes.
- **Logic:** It fills a temporary container until `clientHeight` > `pageHeight` (default 1122px), then breaks.
- **Custom Elements:** The output is wrapped in `<wdoc-container>` containing multiple `<wdoc-page>` elements.

### Form Handling

- Forms are **not** standard Angular Reactive Forms.
- We map JSON files from `wdoc-form/` in the zip to HTML `<input>` elements by `name` attribute.
- **Saving:** When saving, we read the DOM values and write new JSON files back into the Zip buffer.
- File inputs keep track of the previously saved attachment name; when a new file is uploaded, remove the old link and drop the
  old file from the archive before hashing.

## 4. Coding Standards & Rules

### Angular Patterns

- **Standalone:** All components must be `standalone: true`.
- **Change Detection:** Prefer `OnPush` where possible
- **Communication:** Use `Output()` emitters for child-to-parent communication (e.g., `Navbar` -> `App`).

### Custom Elements

The viewer injects specific custom elements. Do not remove these from sanitization allow-lists:

- `wdoc-page`, `wdoc-container`, `wdoc-content`
- `wdoc-header`, `wdoc-footer`
- `wdoc-barcode` (rendered dynamically via service).

### Manifest rules

- Use the shared `APP_VERSION` constant (`src/app/config/app.config.ts`) when writing `manifest.json` and surface it under `meta.appVersion`.
- Only set `meta.creator` when an authenticated user email is available; omit the field entirely otherwise.

## 5. Testing Guidelines

### Unit Tests (Jasmine)

- Use `fakeAsync` and `tick()` for timing-dependent logic (e.g., zoom debounce, layout calc).
- Mock `HttpClient` and `MatDialog` using `Jasmine.createSpyObj`.
- **Do not** test private methods directly; test the public side-effects.
- For code coverage be at least 1% over the limit to ensure merge successfull and still meeting coverage theshold.

## 6. Common Pitfalls for Agents

1. **Layout Thrashing:** The pagination logic causes reflows. When modifying `splitHtmlToPages.ts`, be extremely careful not to introduce infinite loops or excessive synchronous layout reads.
2. **Zip Async:** `JSZip` operations are async. Always `await` them.
3. **CSS Isolation:** The viewer styles (`src/assets/wdoc-styles.css`) are global. When adding UI components, ensure their styles do not bleed into the `wdoc-page` content.
