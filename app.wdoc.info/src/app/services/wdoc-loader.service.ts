import { DocumentLayoutError } from '../signatures/archive';
import { verifyDocument, type Manifest, type Files, safePath, parseJson, decodeUtf8, isRecord } from '../signatures/core';
import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { lastValueFrom } from 'rxjs';
import { HtmlProcessingService } from './html-processing.service';
import { DialogService } from './dialog.service';
import { StreamedZip } from './zip-reader';
import type { DocumentAsset } from './document-creator.service';

export interface WdocLoadResult {
  html: string;
  documentTitle: string;
  originalArrayBuffer: ArrayBuffer;
  attachments: LoadedFile[];
  formAnswers: LoadedFile[];
  assets?: DocumentAsset[];
}

export interface LoadedFile {
  name: string;
  blob: Blob;
}

@Injectable({ providedIn: 'root' })
export class WdocLoaderService {
  constructor(
    private http: HttpClient,
    private htmlProcessingService: HtmlProcessingService,
    private dialogService: DialogService,
  ) {}

  async fetchAndLoadWdoc(url: string): Promise<WdocLoadResult | null> {
    try {
      const arrayBuffer = await lastValueFrom(
        this.http.get(url, { responseType: 'arraybuffer' }),
      );
      return await this.loadWdocFromArrayBuffer(arrayBuffer);
    } catch (error) {
      console.error(`Error downloading .wdoc/.zip file from ${url}:`, error);
      await this.dialogService.openAlert(
        'Error downloading .wdoc/.zip file from URL.',
        'Download failed',
      );
      return null;
    }
  }

  async loadWdocFromArrayBuffer(
    arrayBuffer: ArrayBuffer,
    defaultTitle = 'WDOC viewer',
  ): Promise<WdocLoadResult | null> {
    const closeLoading = this.dialogService.openLoading('Please wait while the file is opening...');
    try {
      const zip = await StreamedZip.fromArrayBuffer(arrayBuffer);
      const manifestValid = await this.verifyContentManifest(zip);
      if (!manifestValid) {
        closeLoading();
        return null;
      }
      const html = (await zip.file('index.html')!.async('text')) as string;
      const basePath = '';
      const processed = await this.htmlProcessingService.processHtml(zip, html, {
        defaultTitle,
        basePath,
      });
      const attachments = await this.extractFiles(zip, `${basePath}wdoc-attachment`);
      const formAnswers = await this.extractFiles(zip, `${basePath}wdoc-form`);
      closeLoading();
      return {
        html: processed.html,
        documentTitle: processed.documentTitle,
        originalArrayBuffer: arrayBuffer,
        attachments,
        formAnswers,
        assets: processed.assets,
      };
    } catch (error) {
      console.error('Error processing zip file:', error);
      await this.dialogService.openAlert(
        error instanceof DocumentLayoutError ? error.message : 'Error processing .wdoc file.',
        error instanceof DocumentLayoutError ? 'Invalid archive layout' : 'Processing error',
      );
      closeLoading();
      return null;
    }
  }

  private async verifyContentManifest(zip: StreamedZip): Promise<boolean> {
    const manifestFile = zip.file('manifest.json');
    if (!manifestFile) {
      return true;
    }

    try {
      const manifest = parseJson(decodeUtf8(await manifestFile.async('uint8array') as Uint8Array));
      if (!isRecord(manifest) || manifest['manifestVersion'] !== '0.1') {
        await this.dialogService.openAlert('The document manifest uses an unsupported format and will not be opened.', 'Unsupported manifest');
        return false;
      }
      const files: Files = Object.create(null);
      for (const entry of zip.entries()) if (!entry.dir) {
        if (!safePath(entry.name)) throw new Error('Unsafe archive path');
        files[entry.name] = await entry.async('uint8array') as Uint8Array;
      }
      const report = await verifyDocument(manifest as unknown as Manifest, files, []);
      if (report.content.status === 'file-modified') throw new Error('Original content was modified');
      // Cryptographic trust is displayed separately by the signature panel.
      return true;
    } catch {
      await this.dialogService.openAlert('The document content does not match its manifest and will not be opened.', 'Verification failed');
      return false;
    }
  }

  private async extractFiles(
    zip: StreamedZip,
    folderName: string,
    predicate: (name: string) => boolean = () => true,
  ): Promise<LoadedFile[]> {
    const folder = zip.folder(folderName);
    if (!folder) {
      return [];
    }

    const entries = folder.filter(
      (path, file) =>
        !file.dir && !this.isNoiseFile(path) && predicate(path),
    );
    const root: string | undefined = folder.root;
    const files: LoadedFile[] = [];

    for (const entry of entries) {
      const relativeName =
        root && entry.name.startsWith(root) ? entry.name.slice(root.length) : entry.name;
      const buffer = (await entry.async('arraybuffer')) as ArrayBuffer;
      const mime = this.guessMimeType(relativeName);
      const blob = new Blob([buffer], mime ? { type: mime } : undefined);
      files.push({ name: relativeName, blob });
    }

    return files;
  }

  private isNoiseFile(path: string): boolean {
    const normalized = path.replace(/^\/+/, '');
    const segments = normalized.split('/');
    return segments.some((segment) => {
      const lower = segment.toLowerCase();
      return (
        segment === '__MACOSX' ||
        segment === '.DS_Store' ||
        segment.startsWith('._') ||
        lower === 'thumbs.db' ||
        lower === 'desktop.ini'
      );
    });
  }

  private guessMimeType(name: string): string | undefined {
    const ext = name.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'html':
        return 'text/html';
      case 'css':
        return 'text/css';
      case 'js':
        return 'application/javascript';
      case 'json':
        return 'application/json';
      case 'png':
        return 'image/png';
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'gif':
        return 'image/gif';
      case 'pdf':
        return 'application/pdf';
      case 'txt':
        return 'text/plain';
      default:
        return undefined;
    }
  }

}
