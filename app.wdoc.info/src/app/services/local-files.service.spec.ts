import { TestBed } from '@angular/core/testing';
import { FILE_SYSTEM_ACCESS, FileSystemAccess, LocalDirectoryHandle, LocalFileHandle, LocalFilesService, LocalFolderStore } from './local-files.service';

describe('LocalFilesService', () => {
  let browser: FileSystemAccess;
  let service: LocalFilesService;
  let store: jasmine.SpyObj<LocalFolderStore>;
  let file: File;
  let handle: jasmine.SpyObj<LocalFileHandle>;
  let folder: jasmine.SpyObj<LocalDirectoryHandle>;
  let writable: { write: jasmine.Spy; close: jasmine.Spy; abort: jasmine.Spy };

  beforeEach(() => {
    file = new File(['original'], 'Report.wdoc', { lastModified: 1 });
    writable = jasmine.createSpyObj('writable', ['write', 'close', 'abort']);
    writable.write.and.resolveTo(); writable.close.and.resolveTo(); writable.abort.and.resolveTo();
    handle = jasmine.createSpyObj('file', ['getFile', 'createWritable', 'queryPermission', 'requestPermission'], { kind: 'file', name: file.name });
    handle.getFile.and.callFake(async () => file);
    handle.createWritable.and.resolveTo(writable);
    handle.queryPermission.and.resolveTo('granted'); handle.requestPermission.and.resolveTo('granted');
    folder = jasmine.createSpyObj('directory', ['values', 'resolve', 'queryPermission', 'requestPermission'], { kind: 'directory', name: 'Documents' });
    folder.values.and.callFake(async function* () { yield handle; });
    folder.resolve.and.resolveTo([file.name]);
    folder.queryPermission.and.resolveTo('granted'); folder.requestPermission.and.resolveTo('granted');
    browser = { showDirectoryPicker: jasmine.createSpy().and.resolveTo(folder), showSaveFilePicker: jasmine.createSpy().and.resolveTo(handle) };
    store = jasmine.createSpyObj('store', ['read', 'write']); store.read.and.resolveTo(undefined); store.write.and.resolveTo();
    TestBed.configureTestingModule({ providers: [{ provide: FILE_SYSTEM_ACCESS, useValue: browser }, { provide: LocalFolderStore, useValue: store }] });
    service = TestBed.inject(LocalFilesService);
  });

  it('lists only immediate wdoc files, case-insensitively, in filename order', async () => {
    const named = (name: string) => ({ ...handle, kind: 'file' as const, name });
    folder.values.and.callFake(async function* () {
      yield named('z.wdoc'); yield named('report10.WDOC'); yield named('report2.wdoc');
      yield named('notes.txt'); yield named('archive.zip'); yield folder;
    });
    await service.chooseFolder();
    expect(browser.showDirectoryPicker).toHaveBeenCalledWith({ id: 'wdoc-folder', mode: 'readwrite' });
    expect(service.files().map(file => file.name)).toEqual(['report2.wdoc', 'report10.WDOC', 'z.wdoc']);
    expect(store.write).toHaveBeenCalledWith(folder);
  });

  it('restores a remembered folder without requesting permission or a picker', async () => {
    store.read.and.resolveTo(folder);
    await service.restoreFolder();
    expect(service.files()).toEqual([handle]);
    expect(browser.showDirectoryPicker).not.toHaveBeenCalled();
    expect(folder.requestPermission).not.toHaveBeenCalled();
  });

  it('requires a reconnect click when a remembered folder has lost permission', async () => {
    store.read.and.resolveTo(folder); folder.queryPermission.and.resolveTo('prompt');
    await service.restoreFolder();
    expect(service.needsPermission()).toBeTrue(); expect(service.files()).toEqual([]);
    expect(folder.requestPermission).not.toHaveBeenCalled();
    folder.queryPermission.and.resolveTo('granted');
    await service.reconnect();
    expect(folder.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(service.needsPermission()).toBeFalse(); expect(service.files()).toEqual([handle]);
  });

  it('reports a denied reconnect and unavailable directory', async () => {
    await service.chooseFolder();
    folder.requestPermission.and.resolveTo('denied'); await service.reconnect();
    expect(service.error()).toContain('not allowed');
    folder.values.and.callFake(async function* () { throw new Error('Folder removed'); });
    await service.refresh(); expect(service.error()).toContain('unavailable'); expect(service.files()).toEqual([]);
  });

  it('ignores cancelled folder selection and retains the previous folder', async () => {
    await service.chooseFolder();
    (browser.showDirectoryPicker as jasmine.Spy).and.rejectWith(new DOMException('Cancelled', 'AbortError'));
    await service.chooseFolder();
    expect(service.directory()).toBe(folder); expect(service.error()).toBe(''); expect(service.busy()).toBeFalse();
  });

  it('continues browsing when browser persistence is unavailable', async () => {
    store.write.and.rejectWith(new Error('Storage disabled'));
    await service.chooseFolder();
    expect(service.files()).toEqual([handle]);
    store.read.and.rejectWith(new Error('Storage disabled')); await service.restoreFolder();
    expect(service.error()).toBe('');
  });

  it('does not restore an old folder after the user disconnects', async () => {
    let finish!: (value: LocalDirectoryHandle) => void;
    store.read.and.returnValue(new Promise(resolve => finish = resolve));
    const restoring = service.restoreFolder();
    await service.disconnect(); finish(folder); await restoring;
    expect(service.directory()).toBeNull(); expect(service.activeFile()).toBeNull();
    expect(store.write).toHaveBeenCalledWith(null);
  });

  it('prepares a linked file without showing a picker or requesting an existing permission', async () => {
    service.attach(handle, file);
    const target = await service.prepareSave('new-title.wdoc');
    expect(target?.handle).toBe(handle);
    expect(browser.showSaveFilePicker).not.toHaveBeenCalled(); expect(handle.requestPermission).not.toHaveBeenCalled();
  });

  it('requests a missing write permission from the save action and rejects refusal', async () => {
    service.attach(handle, file); handle.queryPermission.and.resolveTo('prompt');
    await service.prepareSave('report.wdoc');
    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    handle.requestPermission.and.resolveTo('denied');
    await expectAsync(service.prepareSave('report.wdoc')).toBeRejectedWithError(/Write access/);
    expect(handle.createWritable).not.toHaveBeenCalled();
  });

  it('selects a new destination for Save as even when a file is already linked', async () => {
    await service.chooseFolder(); service.attach(handle, file);
    const target = await service.prepareSave('copy.wdoc', true);
    expect(browser.showSaveFilePicker).toHaveBeenCalledWith(jasmine.objectContaining({ suggestedName: 'copy.wdoc', startIn: folder }));
    expect(target?.handle).toBe(handle);
  });

  it('commits bytes only through write and close, then returns the new file baseline', async () => {
    service.attach(handle, file);
    const target = (await service.prepareSave('report.wdoc'))!;
    const blob = new Blob(['edited']);
    writable.close.and.callFake(async () => { file = new File([blob], file.name, { lastModified: 2 }); });
    const saved = await service.write(target, blob);
    expect(writable.write).toHaveBeenCalledWith(blob); expect(writable.close).toHaveBeenCalled();
    expect(await saved.text()).toBe('edited'); expect(saved.lastModified).toBe(2);
    expect(writable.abort).not.toHaveBeenCalled();
  });

  it('aborts a failed write and leaves the linked baseline unchanged', async () => {
    service.attach(handle, file); const original = service.activeFile();
    writable.write.and.rejectWith(new Error('Disk full'));
    await expectAsync(service.write((await service.prepareSave('report.wdoc'))!, new Blob(['edited']))).toBeRejectedWithError('Disk full');
    expect(writable.abort).toHaveBeenCalled(); expect(writable.close).not.toHaveBeenCalled();
    expect(service.activeFile()).toBe(original);
  });

  it('does not report success when closing the file fails', async () => {
    service.attach(handle, file); writable.close.and.rejectWith(new Error('Close failed'));
    await expectAsync(service.write((await service.prepareSave('report.wdoc'))!, new Blob(['edited']))).toBeRejectedWithError('Close failed');
    expect(writable.abort).toHaveBeenCalled();
  });

  it('rejects an externally changed file before opening a write stream', async () => {
    service.attach(handle, file);
    const target = (await service.prepareSave('report.wdoc'))!;
    file = new File(['External changes'], file.name, { lastModified: 10 });
    await expectAsync(service.write(target, new Blob(['edited']))).toBeRejectedWithError(/changed outside/);
    expect(handle.createWritable).not.toHaveBeenCalled();
  });

  it('highlights a linked file only when it belongs directly to the selected folder', async () => {
    await service.chooseFolder(); service.attach(handle, file); await service.refresh();
    expect(service.activeFolderFile()).toBe(file.name);
    folder.resolve.and.resolveTo(null); await service.refresh(); expect(service.activeFolderFile()).toBeNull();
    service.detach(); expect(service.hasLocalTarget()).toBeTrue();
    await service.disconnect(); expect(service.hasLocalTarget()).toBeFalse();
  });
});
