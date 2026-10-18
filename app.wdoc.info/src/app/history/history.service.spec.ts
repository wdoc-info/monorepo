import { TestBed } from '@angular/core/testing';
import { HISTORY_WORKER_FACTORY, HistoryService } from './history.service';
import { GitEngine } from './git-engine';
import { readDocumentArchive } from '../signatures/archive';

class EngineWorker {
  onmessage?: (event: any) => void;
  onerror?: () => void;
  terminated = false;
  private engine = new GitEngine();
  postMessage(data: any): void {
    const execute = async () => {
      switch (data.method) {
        case 'open': return this.engine.open(data.files, data.session);
        case 'autosave': return this.engine.autosave(data.files);
        case 'publish': return this.engine.publish(data.files, data.other);
        case 'snapshot': return this.engine.snapshot(data.oid);
        case 'rollback': return this.engine.rollback();
        case 'confirm': return this.engine.confirm();
        case 'import': return this.engine.importVersion(data.files);
        default: throw new Error('Unsupported request');
      }
    };
    void execute().then(result => this.onmessage?.({ data: { id: data.id, result } }), error => this.onmessage?.({ data: { id: data.id, error: error.message } }));
  }
  terminate(): void { this.terminated = true; }
}
const archive = (html: string, id = crypto.randomUUID()) => HistoryService.archive({ 'index.html': new TextEncoder().encode(html), 'manifest.json': new TextEncoder().encode(JSON.stringify({ meta: { docId: id } })) });
describe('History orchestration', () => {
  let service: HistoryService, worker: EngineWorker;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [{ provide: HISTORY_WORKER_FACTORY, useValue: () => { worker = new EngineWorker(); return worker as unknown as Worker; } }] });
    service = TestBed.inject(HistoryService);
  });
  afterEach(() => service.reset());
  it('retains exact browser recovery bytes and clears them only after a successful save', async () => {
    const id = crypto.randomUUID(), buffer = await archive('published', id), draft = await archive('draft', id);
    await service.open(buffer); await service.saveDraft(draft, 'Recovery');
    await service.open(buffer);
    expect(service.recovery()?.title).toBe('Recovery'); expect(service.recovery()?.buffer).toEqual(draft);
    await service.saved(); await service.open(buffer); expect(service.recovery()).toBeNull();
  });
  it('keeps root content published during autosave and rolls back an unpersisted main merge', async () => {
    const id = crypto.randomUUID(), buffer = await archive('published', id), draft = await archive('draft', id);
    await service.open(buffer); const before = service.main();
    const autosaved = await service.autosave(draft);
    expect(new TextDecoder().decode((await readDocumentArchive(autosaved)).files['index.html'])).toBe('published');
    await service.publish(draft); expect(service.main()).not.toBe(before);
    await service.failed(); expect(service.main()).toBe(before);
    expect(new TextDecoder().decode((await readDocumentArchive(await service.snapshot(before))).files['index.html'])).toBe('published');
    const saved = await service.publish(draft); await service.saved();
    await service.open(saved); expect(service.entries().some(entry => entry.message === 'Save document')).toBeTrue();
  });
  it('lazily initializes a new document and imports an unrelated version for manual merge', async () => {
    const saved = await service.publish(await archive('ours')); await service.saved();
    expect(service.main()).toBeTruthy();
    const imported = await service.import(await archive('theirs'));
    expect(imported.base).toBeNull(); expect(imported.theirs).toMatch(/^[a-f0-9]{40}$/);
    const result = await service.exclusive(() => Promise.resolve('serialized')); expect(result).toBe('serialized');
    expect(saved.byteLength).toBeGreaterThan(0);
  });
  it('reports optional history errors and refuses to silently replace corrupt repositories', async () => {
    const buffer = await HistoryService.archive({ 'index.html': new TextEncoder().encode('safe'), '.git/HEAD': new TextEncoder().encode('ref: refs/heads/missing') });
    await service.open(buffer); expect(service.error()).toContain('History unavailable');
    await expectAsync(service.autosave(buffer)).toBeRejected(); await expectAsync(service.publish(buffer)).toBeRejected();
    service.reset(); expect(worker.terminated).toBeTrue(); expect(service.entries()).toEqual([]);
  });
});
