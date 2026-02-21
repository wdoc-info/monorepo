import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { lastValueFrom } from 'rxjs';
import { HtmlProcessingService } from './html-processing.service';
import { DialogService } from './dialog.service';
import { ManifestSection, WdocManifest } from './manifest-builder';
import { StreamedZip, type StreamedZipEntry } from './zip-reader';

export interface WdocLoadResult {
  html: string;
  documentTitle: string;
  originalArrayBuffer: ArrayBuffer;
  attachments: LoadedFile[];
  formAnswers: LoadedFile[];
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

  static async computeSha256(data: Uint8Array): Promise<string> {
    const buffer = data.slice().buffer as ArrayBuffer;
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const bytes = Array.from(new Uint8Array(digest));
    return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

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
      const indexFile = this.findIndexFile(zip);
      if (!indexFile) {
        closeLoading();
        await this.dialogService.openAlert(
          'index.html not found in the archive.',
          'Missing entry',
        );
        return null;
      }
      const html = (await indexFile.async('text')) as string;
      const processed = await this.htmlProcessingService.processHtml(zip, html, {
        defaultTitle,
      });
      const attachments = await this.extractFiles(zip, 'wdoc-attachment');
      const formAnswers = await this.extractFiles(zip, 'wdoc-form');
      closeLoading();
      return {
        html: processed.html,
        documentTitle: processed.documentTitle,
        originalArrayBuffer: arrayBuffer,
        attachments,
        formAnswers,
      };
    } catch (error) {
      console.error('Error processing zip file:', error);
      await this.dialogService.openAlert(
        'Error processing .wdoc file.',
        'Processing error',
      );
      closeLoading();
      return null;
    }
  }

  private findIndexFile(zip: StreamedZip): StreamedZipEntry | null {
    let indexFile = zip.file('index.html');
    if (!indexFile) {
      const folderNames = new Set<string>();
      for (const entry of zip.entries()) {
        if (entry.dir) {
          const segments = entry.name.split('/').filter(Boolean);
          if (segments.length === 1) {
            folderNames.add(`${segments[0]}/`);
          }
        }
      }
      const firstFolder = Array.from(folderNames).sort()[0];
      indexFile = firstFolder ? zip.file(`${firstFolder}index.html`) : null;
    }
    return indexFile ?? null;
  }

  private async verifyContentManifest(zip: StreamedZip): Promise<boolean> {
    const manifestFile = zip.file('manifest.json');
    if (!manifestFile) {
      return true;
    }

    let manifest: any;
    try {
      const manifestText = (await manifestFile.async('text')) as string;
      manifest = JSON.parse(manifestText);
    } catch (error) {
      console.error('Failed to parse manifest.json', error);
      await this.dialogService.openAlert(
        'The document content could not be verified and will not be opened.',
        'Verification failed',
      );
      return false;
    }

    const manifestShapeValid =
      typeof manifest === 'object' &&
      manifest !== null &&
      typeof manifest.content === 'object' &&
      manifest.content !== null &&
      typeof manifest.runtime === 'object' &&
      manifest.runtime !== null;

    if (!manifestShapeValid) {
      await this.dialogService.openAlert(
        'The document manifest uses an unsupported format and will not be opened.',
        'Unsupported manifest',
      );
      return false;
    }

    const mismatches: string[] = [];
    await this.verifyManifestSection(zip, manifest.content, mismatches);

    const forms = (manifest as WdocManifest).runtime?.forms ?? {};
    for (const section of Object.values(forms)) {
      await this.verifyManifestSection(zip, section, mismatches);
    }

    if (mismatches.length > 0) {
      await this.dialogService.openAlert(
        'The document content does not match its manifest and will not be opened.',
        'Verification failed',
      );
      return false;
    }

    return true;
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

  private async verifyManifestSection(
    zip: StreamedZip,
    section: ManifestSection,
    mismatches: string[],
  ): Promise<void> {
    if (
      !section ||
      section.hashAlgorithm !== 'sha256' ||
      typeof section.files !== 'object' ||
      section.files === null
    ) {
      mismatches.push('manifest.json');
      return;
    }

    const digestPayload = Object.entries(section.files).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const digestSource = digestPayload
      .map(([path, hash]) => `${path}:${hash}`)
      .join('\n');
    const computedDigest = await WdocLoaderService.computeSha256(
      new TextEncoder().encode(digestSource),
    );
    if (section.contentDigest !== computedDigest) {
      mismatches.push('manifest.json');
    }

    for (const [path, expectedHash] of Object.entries(section.files)) {
      const entry = zip.file(path);
      if (!entry || typeof expectedHash !== 'string') {
        mismatches.push(path);
        continue;
      }

      try {
        const data = (await entry.async('uint8array')) as Uint8Array;
        const sha256 = await WdocLoaderService.computeSha256(data);
        if (sha256 !== expectedHash) {
          mismatches.push(path);
        }
      } catch (error) {
        console.error('Failed to verify manifest entry', path, error);
        mismatches.push(path);
      }
    }
  }
}
