import { computed, inject, Injectable, InjectionToken, signal } from '@angular/core';

interface LocalPermissions {
  queryPermission(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}
export interface LocalWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
export interface LocalFileHandle extends LocalPermissions {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<LocalWritable>;
}
export interface LocalDirectoryHandle extends LocalPermissions {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<LocalFileHandle | LocalDirectoryHandle>;
  resolve(handle: LocalFileHandle): Promise<string[] | null>;
}
export interface FileSystemAccess {
  showDirectoryPicker?: (options: { id: string; mode: 'readwrite' }) => Promise<LocalDirectoryHandle>;
  showSaveFilePicker?: (options: {
    id: string;
    suggestedName: string;
    startIn?: LocalDirectoryHandle;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<LocalFileHandle>;
}
export const FILE_SYSTEM_ACCESS = new InjectionToken<FileSystemAccess>('File System Access', {
  providedIn: 'root', factory: () => typeof window === 'undefined' ? {} : window as unknown as FileSystemAccess,
});
export interface LocalFileBinding { handle: LocalFileHandle; size: number; lastModified: number }
export interface LocalSaveTarget { handle: LocalFileHandle; previous: LocalFileBinding | null }

/** Only the user-selected directory handle is persisted, never document contents. */
@Injectable({ providedIn: 'root' })
export class LocalFolderStore {
  private async access(mode: IDBTransactionMode, value?: LocalDirectoryHandle | null): Promise<LocalDirectoryHandle | undefined> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('wdoc-local-files', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('handles');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('handles', mode);
        const store = transaction.objectStore('handles');
        const request = mode === 'readonly' ? store.get('folder') : value ? store.put(value, 'folder') : store.delete('folder');
        transaction.oncomplete = () => resolve(mode === 'readonly' ? request.result : undefined);
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }
  read(): Promise<LocalDirectoryHandle | undefined> { return this.access('readonly'); }
  async write(handle: LocalDirectoryHandle | null): Promise<void> { await this.access('readwrite', handle); }
}

@Injectable({ providedIn: 'root' })
export class LocalFilesService {
  private readonly browser = inject(FILE_SYSTEM_ACCESS);
  private readonly store = inject(LocalFolderStore);
  readonly supported = typeof this.browser.showDirectoryPicker === 'function';
  readonly canSaveAs = typeof this.browser.showSaveFilePicker === 'function';
  readonly directory = signal<LocalDirectoryHandle | null>(null);
  readonly files = signal<LocalFileHandle[]>([]);
  readonly activeFile = signal<LocalFileBinding | null>(null);
  readonly activeFolderFile = signal<string | null>(null);
  readonly needsPermission = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly status = signal('');
  readonly hasLocalTarget = computed(() => !!this.activeFile() || (!!this.directory() && this.canSaveAs));
  private generation = 0;

  async restoreFolder(): Promise<void> {
    if (!this.supported) return;
    const generation = this.generation;
    try {
      const handle = await this.store.read();
      if (generation !== this.generation || !handle) return;
      this.directory.set(handle);
      await this.refresh();
    } catch { /* Remembering folders is optional when browser storage is unavailable. */ }
  }

  async chooseFolder(): Promise<void> {
    if (!this.browser.showDirectoryPicker || this.busy()) return;
    this.busy.set(true); this.error.set('');
    ++this.generation;
    try {
      const handle = await this.browser.showDirectoryPicker({ id: 'wdoc-folder', mode: 'readwrite' });
      this.directory.set(handle); this.files.set([]); this.needsPermission.set(false);
      await this.store.write(handle).catch(() => undefined);
      await this.refresh();
    } catch (error) { if (!this.cancelled(error)) this.error.set('The folder could not be opened. Please try again.'); }
    finally { this.busy.set(false); }
  }

  async reconnect(): Promise<void> {
    const handle = this.directory();
    if (!handle) return;
    try {
      if (await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Folder access was not allowed.');
      await this.refresh();
    } catch { this.error.set('Folder access was not allowed. Choose the folder again or retry.'); }
  }

  async refresh(): Promise<void> {
    const directory = this.directory();
    if (!directory) return;
    try {
      if (await directory.queryPermission({ mode: 'read' }) !== 'granted') {
        if (directory === this.directory()) { this.needsPermission.set(true); this.files.set([]); }
        return;
      }
      const files: LocalFileHandle[] = [];
      for await (const entry of directory.values()) if (entry.kind === 'file' && /\.wdoc$/i.test(entry.name)) files.push(entry);
      if (directory !== this.directory()) return;
      this.files.set(files.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' })));
      this.needsPermission.set(false); this.error.set('');
      await this.updateActiveFolderFile();
    } catch {
      if (directory === this.directory()) { this.files.set([]); this.error.set('The folder is unavailable. Reconnect it or choose another folder.'); }
    }
  }

  async disconnect(): Promise<void> {
    ++this.generation;
    this.directory.set(null); this.files.set([]); this.needsPermission.set(false); this.error.set('');
    this.detach();
    await this.store.write(null).catch(() => undefined);
  }

  attach(handle: LocalFileHandle, file: File): void {
    this.activeFile.set({ handle, size: file.size, lastModified: file.lastModified });
    this.status.set(`Linked to ${handle.name}`);
    void this.updateActiveFolderFile();
  }
  detach(): void { this.activeFile.set(null); this.activeFolderFile.set(null); this.status.set(''); }

  /** Call from the save click, before asynchronous archive/font work consumes user activation. */
  async prepareSave(filename: string, saveAs = false): Promise<LocalSaveTarget | null> {
    const previous = saveAs ? null : this.activeFile();
    if (previous) {
      if (await previous.handle.queryPermission({ mode: 'readwrite' }) !== 'granted'
        && await previous.handle.requestPermission({ mode: 'readwrite' }) !== 'granted') {
        throw new Error('Write access was not allowed. Retry Save or use Save as to keep a copy.');
      }
      return { handle: previous.handle, previous };
    }
    if (!this.browser.showSaveFilePicker) return null;
    const handle = await this.browser.showSaveFilePicker({
      id: 'wdoc-save', suggestedName: filename,
      ...(this.directory() ? { startIn: this.directory()! } : {}),
      types: [{ description: 'wdoc document', accept: { 'application/zip': ['.wdoc'] } }],
    });
    const existing = await handle.getFile();
    return { handle, previous: { handle, size: existing.size, lastModified: existing.lastModified } };
  }

  async write(target: LocalSaveTarget, blob: Blob): Promise<File> {
    const current = await target.handle.getFile();
    if (target.previous && (current.size !== target.previous.size || current.lastModified !== target.previous.lastModified)) {
      throw new Error('This file changed outside wdoc. Reopen it or use Save as to keep your changes in another file.');
    }
    const writable = await target.handle.createWritable();
    try { await writable.write(blob); await writable.close(); }
    catch (error) { await writable.abort().catch(() => undefined); throw error; }
    return target.handle.getFile();
  }
  cancelled(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError'; }

  private async updateActiveFolderFile(): Promise<void> {
    const directory = this.directory(), active = this.activeFile();
    this.activeFolderFile.set(null);
    if (!directory || !active) return;
    try {
      const path = await directory.resolve(active.handle);
      if (directory === this.directory() && active === this.activeFile() && path?.length === 1) this.activeFolderFile.set(path[0]);
    } catch { /* An individually linked file may be outside the selected folder. */ }
  }
}
