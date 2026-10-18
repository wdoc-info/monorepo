import { Injectable } from '@angular/core';
import { runtimePath } from '../signatures/core';
import { WdocSignatureService } from '../signatures/signature.service';
import { DocumentAsset, DocumentCreatorService } from './document-creator.service';

export interface EditedArchive {
  html: string;
  title: string;
  version: string;
  assets: DocumentAsset[];
  includeFonts: boolean;
  original: ArrayBuffer | null;
}

/** Preserve archive resources and signed history when replacing a linked local file. */
@Injectable({ providedIn: 'root' })
export class EditedArchiveService {
  constructor(private creator: DocumentCreatorService, private signatures: WdocSignatureService) {}

  async build(input: EditedArchive): Promise<Blob> {
    const original = input.original ? await this.signatures.read(input.original) : null;
    const assets: DocumentAsset[] = [];
    if (original) {
      for (const [path, bytes] of Object.entries(this.signatures.bytes(original))) {
        if (path !== 'index.html' && path !== 'manifest.json' && !runtimePath(path)) {
          assets.push({ path, file: new Blob([new Uint8Array(bytes)]) });
        }
      }
    }
    assets.push(...input.assets.filter(asset => !runtimePath(asset.path)));
    let html = input.html;
    if (original) {
      const source = new DOMParser().parseFromString(new TextDecoder().decode(this.signatures.bytes(original)['index.html']), 'text/html');
      // Styles remain part of the editable document even when TipTap omits head nodes.
      html = [...new Set([...source.querySelectorAll('style,link[rel="stylesheet"]')].map(node => node.outerHTML))].join('\n') + html;
    }
    const blob = await this.creator.buildWdocBlob(html, input.version, input.title, assets, input.includeFonts);
    if (!original) return blob;
    let edited = await this.signatures.read(await blob.arrayBuffer());
    const history = original.manifest.signatures.document.length || original.manifest.signatures.forms.length
      || original.manifest.runtime.revisions.length || Object.keys(original.manifest.runtime.submissions).length
      || Object.keys(original.files).some(path => path.startsWith('seals/'));
    if (history) {
      edited = await this.signatures.reviseUnsigned(original, {
        files: Object.fromEntries(Object.entries(edited.files).filter(([path]) => !runtimePath(path))),
        externalFonts: edited.manifest.content.externalFonts,
        appVersion: edited.manifest.meta.appVersion, docTitle: input.title,
      });
    } else {
      edited.manifest.meta.docId = original.manifest.meta.docId;
      edited.manifest.meta.createdAt = original.manifest.meta.createdAt;
      edited.manifest.runtime = structuredClone(original.manifest.runtime);
      delete edited.manifestText;
      for (const [path, bytes] of Object.entries(original.files)) if (runtimePath(path)) edited.files[path] = bytes;
    }
    return new Blob([await this.signatures.archive(edited, input.includeFonts)], { type: 'application/zip' });
  }
}
