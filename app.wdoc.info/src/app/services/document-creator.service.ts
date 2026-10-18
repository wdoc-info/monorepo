import { Injectable } from '@angular/core';
import JSZip from 'jszip';
import { APP_VERSION } from '../config/app.config';
import { AuthService } from './auth.service';
import { ExternalFontService } from './external-font.service';
import { runtimePath, safePath, verifyDocument, type Files } from '../signatures/core';
import {
  ManifestMetaOverrides,
  generateManifest,
  serializeManifest,
} from './manifest-builder';
import {
  DEFAULT_DOCUMENT_LINE_HEIGHT,
} from '../layout/layout.constants';

export interface DocumentAsset {
  path: string;
  file: Blob;
  objectUrl?: string;
}

@Injectable({ providedIn: 'root' })
export class DocumentCreatorService {
  constructor(private authService: AuthService, private fonts: ExternalFontService) {}

  async downloadWdocFromHtml(
    html: string,
    docVersion: string,
    docTitle: string,
    filename?: string,
    assets: DocumentAsset[] = [],
    includeFonts = false,
  ) {
    const normalizedTitle = docTitle?.trim() || 'WDOC document';
    const resolvedFilename =
      filename ?? `${this.buildFilenameFromTitle(normalizedTitle)}.wdoc`;
    const blob = await this.buildWdocBlob(
      html,
      docVersion,
      normalizedTitle,
      assets,
      includeFonts,
    );
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = resolvedFilename;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async buildWdocBlob(
    html: string,
    docVersion: string,
    docTitle: string,
    assets: DocumentAsset[] = [],
    includeFonts = false,
  ): Promise<Blob> {
    const zip = new JSZip();
    const normalizedHtml = this.replaceAssetUrls(this.fonts.restoreFamilies(html), assets);
    const wrapped = this.wrapHtml(normalizedHtml, docTitle);
    zip.file('index.html', wrapped);
    for (const [path, bytes] of Object.entries(this.fonts.localAssets)) zip.file(path, bytes, { createFolders: false });
    zip.folder('wdoc-form');
    zip.folder('wdoc-assets');
    assets.forEach((asset) => {
      if (!safePath(asset.path) || runtimePath(asset.path) || ['index.html', 'manifest.json'].includes(asset.path)) throw new Error('Invalid document asset path.');
      zip.file(asset.path, asset.file, { createFolders: false });
    });
    const source: Files = Object.create(null);
    for (const entry of Object.values(zip.files)) if (!entry.dir) source[entry.name] = await entry.async('uint8array');
    const prepared = await this.fonts.prepare(source, includeFonts ? 'embed' : 'pin');
    for (const [path, bytes] of Object.entries(prepared.files)) zip.file(path, bytes, { createFolders: false });
    const manifest = await generateManifest(zip, this.buildManifestMeta(docVersion, docTitle));
    if (Object.keys(prepared.externalFonts).length) manifest.content.externalFonts = prepared.externalFonts;
    if ((await verifyDocument(manifest, prepared.files, [])).content.status === 'file-modified') throw new Error('The document contains unsupported or unprotected rendering resources.');
    zip.file('manifest.json', serializeManifest(manifest));
    return zip.generateAsync({ type: 'blob' });
  }

  private replaceAssetUrls(
    html: string,
    assets: DocumentAsset[],
  ): string {
    if (!assets?.length) {
      return html;
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const assetMap = new Map<string, string>(
      assets.map((asset) => [asset.objectUrl ?? asset.path, asset.path]),
    );

    Array.from(doc.querySelectorAll('img')).forEach((img) => {
      const dataSrc = img.getAttribute('data-asset-src');
      const src = img.getAttribute('src') || '';
      const replacement =
        (dataSrc && assetMap.get(dataSrc)) || assetMap.get(src);

      if (replacement) {
        img.setAttribute('src', replacement);
      }
    });

    for (const element of Array.from(doc.querySelectorAll('[href], [src], [style]'))) {
      for (const attribute of ['href', 'src', 'style']) {
        let value = element.getAttribute(attribute);
        if (!value) continue;
        for (const [url, path] of assetMap) if (url.startsWith('blob:')) value = value.replaceAll(url, path);
        element.setAttribute(attribute, value);
      }
    }

    return [...doc.head.querySelectorAll('style,link[rel="stylesheet"]')].map(node => node.outerHTML).join('\n') + (doc.body.innerHTML || '');
  }

  private wrapHtml(content: string, title: string): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${this.escapeHtml(title)}</title>
  <style>
    ${this.fonts.authoringCss.replace(/<\/style/gi, '<\\/style')}
    .wdoc-document { font-family: ${this.fonts.restoreFamilies(this.fonts.defaultFamily()).replace(/<\/style/gi, '<\\/style')}; margin: 32px; line-height: ${DEFAULT_DOCUMENT_LINE_HEIGHT}; word-break: normal; overflow-wrap: break-word; white-space: normal; }
    .wdoc-document h1, .wdoc-document h2, .wdoc-document h3, .wdoc-document h4 { margin-top: 1.6em; }
    .wdoc-document p { margin: 0.8em 0; }
    .wdoc-document p:empty::before,
    .wdoc-document li:empty::before,
    .wdoc-document h1:empty::before,
    .wdoc-document h2:empty::before,
    .wdoc-document h3:empty::before,
    .wdoc-document h4:empty::before,
    .wdoc-document h5:empty::before,
    .wdoc-document h6:empty::before { content: "\\200B"; }
  </style>
</head>
<body>
<div class="wdoc-document">
${content}
</div>
</body>
</html>`;
  }

  private async generateManifest(
    zip: JSZip,
    docVersion: string,
    docTitle: string,
  ): Promise<string> {
    const manifest = await generateManifest(
      zip,
      this.buildManifestMeta(docVersion, docTitle),
    );
    return serializeManifest(manifest);
  }

  private buildManifestMeta(
    docVersion: string,
    docTitle: string,
  ): ManifestMetaOverrides {
    const creator = this.authService.getCurrentUserEmail();
    return {
      docTitle: docTitle?.trim() || 'WDOC document',
      appVersion: APP_VERSION,
      docVersion,
      ...(creator ? { creator } : {}),
    };
  }

  private escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (char) => {
      switch (char) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        case "'":
          return '&#39;';
        default:
          return char;
      }
    });
  }

  private buildFilenameFromTitle(title: string): string {
    const safeTitle = title.trim() || 'document';
    const slug = safeTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '');
    return slug || 'document';
  }
}
