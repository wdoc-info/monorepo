import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import JSZip from 'jszip';
import { readDocumentArchive } from '../signatures/archive';
import type { HistoryEntry, HistoryResult, Snapshot } from './git-engine';
export interface RecoveryDraft { buffer: ArrayBuffer; savedAt: number; title: string; key?: string }
export interface ImportedVersion { theirs: string; base: Snapshot | null; ours: Snapshot; incoming: Snapshot }

export const HISTORY_WORKER_FACTORY = new InjectionToken<() => Worker>('History worker', { providedIn: 'root', factory: () => () => new Worker(new URL('./history.worker', import.meta.url), { type: 'module' }) });

@Injectable({ providedIn: 'root' })
export class HistoryService {
  readonly entries = signal<HistoryEntry[]>([]);
  readonly error = signal('');
  readonly status = signal('');
  readonly recovery = signal<RecoveryDraft | null>(null);
  readonly main = signal('');
  private worker?: Worker;
  private workerFactory = inject(HISTORY_WORKER_FACTORY);
  private nextId = 0;
  private pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
  private session = crypto.randomUUID();
  private key = '';
  private ready = false;
  private opening?: Promise<void>;
  private generation = 0;
  private request<T>(method: string, parameters: object = {}): Promise<T> {
    if (!this.worker) {
      this.worker = this.workerFactory();
      this.worker.onmessage = ({ data }) => {
        const request = this.pending.get(data.id); this.pending.delete(data.id);
        if (data.error) request?.reject(new Error(data.error)); else request?.resolve(data.result);
      };
      this.worker.onerror = () => { for (const request of this.pending.values()) request.reject(new Error('History worker stopped')); this.pending.clear(); this.resetWorker(); };
    }
    return new Promise((resolve, reject) => { const id = ++this.nextId; this.pending.set(id, { resolve, reject }); this.worker!.postMessage({ id, method, ...parameters }); });
  }
  private resetWorker(): void { this.worker?.terminate(); this.worker = undefined; this.ready = false; }
  reset(): void {
    ++this.generation;
    this.resetWorker(); for (const request of this.pending.values()) request.reject(new Error('Document changed')); this.pending.clear();
    this.entries.set([]); this.error.set(''); this.status.set(''); this.recovery.set(null); this.key = ''; this.main.set(''); this.opening = undefined;
  }
  open(buffer: ArrayBuffer): Promise<void> {
    this.reset();
    this.opening = this.initialize(buffer, this.generation);
    return this.opening;
  }
  private async initialize(buffer: ArrayBuffer, generation: number): Promise<void> {
    const files = (await readDocumentArchive(buffer)).files;
    if (generation !== this.generation) return;
    try { this.key = JSON.parse(new TextDecoder().decode(files['manifest.json'])).meta.docId; } catch { this.key = 'new-document'; }
    try {
      const result = await this.request<HistoryResult>('open', { files, session: this.session });
      if (generation !== this.generation) return;
      this.accept(result); this.ready = true;
      const draft = await this.storage('readonly').catch(() => undefined);
      if (generation === this.generation) this.recovery.set(draft ?? null);
    } catch (error) { if (generation === this.generation) this.error.set(`History unavailable: ${(error as Error).message}. The document and its signatures can still be inspected.`); }
  }
  private accept(result: HistoryResult): void { this.entries.set(result.entries); this.main.set(result.main); }
  static async archive(files: Snapshot): Promise<ArrayBuffer> {
    const zip = new JSZip(); for (const [path, bytes] of Object.entries(files)) zip.file(path, bytes, { createFolders: false });
    return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
  }
  async restoreLastDraft(): Promise<void> {
    const generation = this.generation;
    const draft = await this.storage('readonly', undefined, 'last-draft').catch(() => undefined);
    if (generation === this.generation && !this.key && draft) this.recovery.set(draft);
  }
  async saveDraft(buffer: ArrayBuffer, title: string): Promise<void> {
    if (!this.key) {
      const files = (await readDocumentArchive(buffer)).files;
      try { this.key = JSON.parse(new TextDecoder().decode(files['manifest.json'])).meta.docId; } catch { this.key = 'new-document'; }
    }
    const draft = { buffer, title, savedAt: Date.now(), key: this.key };
    await this.storage('readwrite', draft);
    await this.storage('readwrite', draft, 'last-draft');
    this.status.set('Draft retained in this browser');
  }
  async autosave(buffer: ArrayBuffer): Promise<ArrayBuffer> {
    await this.opening;
    if (!this.ready) throw new Error(this.error() || 'History is not ready');
    const files = (await readDocumentArchive(buffer)).files;
    const result = await this.request<HistoryResult>('autosave', { files }); this.accept(result);
    this.status.set('Draft committed in memory');
    return HistoryService.archive(result.files);
  }
  async publish(buffer: ArrayBuffer, other?: string): Promise<ArrayBuffer> {
    await this.opening;
    if (!this.ready) {
      if (this.error()) throw new Error(this.error());
      await this.open(buffer);
      if (!this.ready) throw new Error(this.error());
    }
    const files = (await readDocumentArchive(buffer)).files;
    const result = await this.request<HistoryResult>('publish', { files, other }); this.accept(result);
    return HistoryService.archive(result.files);
  }
  async failed(): Promise<void> { if (this.ready) this.accept(await this.request<HistoryResult>('rollback')); }
  async saved(): Promise<void> {
    if (this.ready) await this.request('confirm');
    await this.storage('readwrite', null).catch(() => undefined);
    const last = await this.storage('readonly', undefined, 'last-draft').catch(() => undefined);
    if (last?.key === this.key || !this.key) await this.storage('readwrite', null, 'last-draft').catch(() => undefined);
    this.recovery.set(null); this.error.set(''); this.status.set('Saved to main · autosave history retained');
  }
  async snapshot(oid: string): Promise<ArrayBuffer> { return HistoryService.archive(await this.request<Snapshot>('snapshot', { oid })); }
  async import(buffer: ArrayBuffer): Promise<ImportedVersion> {
    await this.opening;
    if (!this.ready) throw new Error('Open or save a document before merging');
    return this.request<ImportedVersion>('import', { files: (await readDocumentArchive(buffer)).files });
  }
  async exclusive<T>(run: () => Promise<T>): Promise<T> {
    return typeof navigator.locks?.request === 'function' ? navigator.locks.request('wdoc-document-' + this.key, { mode: 'exclusive' }, run) : run();
  }
  private async storage(mode: IDBTransactionMode, value?: RecoveryDraft | null, key = this.key): Promise<RecoveryDraft | undefined> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('wdoc-history-drafts', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('drafts');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('drafts', mode), store = transaction.objectStore('drafts');
        const request = mode === 'readonly' ? store.get(key) : value ? store.put(value, key) : store.delete(key);
        transaction.oncomplete = () => resolve(mode === 'readonly' ? request.result : undefined);
        transaction.onabort = () => reject(transaction.error); transaction.onerror = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }
}
