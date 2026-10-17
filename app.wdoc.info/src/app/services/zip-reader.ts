import { readDocumentArchive } from '../signatures/archive';
import { decodeUtf8, type Files } from '../signatures/core';
import type { JSZipObject } from 'jszip';

export type ZipEntryType = 'text' | 'arraybuffer' | 'uint8array' | 'blob';

export interface StreamedZipEntry {
  name: string;
  dir: boolean;
  async(type: ZipEntryType): Promise<string | ArrayBuffer | Uint8Array | Blob>;
}

export interface ZipEntryLike {
  name: string;
  dir: boolean;
  async(type: string): Promise<unknown>;
}

export interface StreamedZipFolder {
  filter(predicate: (path: string, file: StreamedZipEntry) => boolean): StreamedZipEntry[];
  file(path: string): StreamedZipEntry | null;
  readonly root?: string;
}

export interface ZipFolderLike {
  filter(predicate: (path: string, file: ZipEntryLike) => boolean): ZipEntryLike[];
  file(path: string): ZipEntryLike | null;
  readonly root?: string;
}

export interface ZipContainer {
  file(path: string): ZipEntryLike | null;
  folder(path: string): ZipFolderLike | null;
}

export class StreamedZip implements ZipContainer {
  private constructor(
    private readonly files: Files,
    private readonly entryMap: Map<string, JSZipObject>,
  ) {}

  static async fromArrayBuffer(buffer: ArrayBuffer): Promise<StreamedZip> {
    const {zip, files} = await readDocumentArchive(buffer);
    const entryMap = new Map<string, JSZipObject>();
    Object.values(zip.files).forEach((entry) => entryMap.set(entry.name, entry));
    return new StreamedZip(files, entryMap);
  }

  entries(): StreamedZipEntry[] {
    return Array.from(this.entryMap.values()).map((entry) => this.wrapEntry(entry));
  }

  file(path: string): StreamedZipEntry | null {
    const entry = this.entryMap.get(path);
    if (!entry) {
      return null;
    }
    return this.wrapEntry(entry);
  }

  folder(prefix: string): StreamedZipFolder | null {
    const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;
    const matches = Array.from(this.entryMap.values()).filter((entry) =>
      entry.name.startsWith(normalized),
    );
    if (matches.length === 0) {
      return null;
    }

    return {
      root: normalized,
      filter: (predicate) =>
        matches
          .filter((entry) => predicate(entry.name, this.wrapEntry(entry)))
          .map((entry) => this.wrapEntry(entry)),
      file: (path: string) => {
        const entry = this.entryMap.get(`${normalized}${path}`);
        return entry ? this.wrapEntry(entry) : null;
      },
    } satisfies StreamedZipFolder;
  }

  private wrapEntry(entry: JSZipObject): StreamedZipEntry {
    return {
      name: entry.name,
      dir: entry.dir,
      async: async (type: ZipEntryType) => {
        const bytes = this.files[entry.name] ?? new Uint8Array();
        switch (type) {
          case 'text': return decodeUtf8(bytes);
          case 'arraybuffer': return bytes.slice().buffer as ArrayBuffer;
          case 'uint8array': return bytes.slice();
          case 'blob': return new Blob([new Uint8Array(bytes)]);
        }
      },
    };
  }
}
