import { deflate } from 'pako';
import { objectId } from './git-pack';
import { GitEngine, type Snapshot } from './git-engine';
const encode = (html: string): Snapshot => ({ 'index.html': new TextEncoder().encode(html) });
describe('Embedded Git engine', () => {
  it('retains autosave commits as parents of a real save merge and restores exact bytes', async () => {
    const engine = new GitEngine(), initial = encode('<p>Initial</p>');
    const opened = await engine.open(initial, 'session');
    const first = await engine.autosave(encode('<p>First</p>'));
    const second = await engine.autosave(encode('<p>Second</p>'));
    const saved = await engine.publish(encode('<p>Second</p>'));
    const main = saved.entries.find(entry => entry.oid === saved.main)!;
    expect(main.parents).toEqual([opened.main, second.draft!]);
    expect(saved.entries.filter(entry => entry.autosave).length).toBe(2);
    expect(await engine.snapshot(first.draft!)).toEqual(encode('<p>First</p>'));
    const reopened = await new GitEngine().open(saved.files, 'another-session');
    expect(reopened.main).toBe(saved.main);
    expect(reopened.entries.length).toBe(4);
  });
  it('does not commit identical content and excludes Git and seals from trees', async () => {
    const engine = new GitEngine(), files = { ...encode('one'), 'seals/proof.jws': new Uint8Array([1]) };
    const opened = await engine.open(files, 'session');
    const saved = await engine.autosave(files);
    expect(saved.entries.length).toBe(1);
    expect(await engine.snapshot(opened.main)).toEqual(encode('one'));
  });
  it('finds common ancestors between independently edited document copies', async () => {
    const engine = new GitEngine(), initial = await engine.open(encode('base'), 'first');
    const copy = new GitEngine(); await copy.open(initial.files, 'second');
    const incoming = await copy.publish(encode('incoming'));
    await engine.publish(encode('ours'));
    const imported = await engine.importVersion(incoming.files);
    expect(imported.base).toEqual(encode('base'));
    const merged = await engine.publish(encode('merged'), imported.theirs);
    expect(merged.entries.find(entry => entry.oid === merged.main)!.parents).toContain(imported.theirs);
  });
  it('imports actual root bytes when another writer has not committed its file changes', async () => {
    const engine = new GitEngine(); const base = await engine.open(encode('base'), 'session');
    const changed = { ...base.files, ...encode('External edit') };
    const imported = await engine.importVersion(changed);
    expect(new TextDecoder().decode(imported.incoming['index.html'])).toBe('External edit');
    expect(imported.base).toEqual(encode('base'));
  });
  it('compacts larger histories into indexed packs without changing commit identities', async () => {
    const engine = new GitEngine(); await engine.open(encode('base'), 'session');
    let saved = await engine.autosave(encode('first'));
    for (let n = 0; n < 12; n++) saved = await engine.autosave(encode(`draft ${n}`));
    expect(Object.keys(saved.files).some(path => path.endsWith('.pack'))).toBeTrue();
    expect(Object.keys(saved.files).some(path => path.endsWith('.idx'))).toBeTrue();
    const reopened = await new GitEngine().open(saved.files, 'next');
    expect(reopened.entries.map(entry => entry.oid).sort()).toEqual(saved.entries.map(entry => entry.oid).sort());
  });
  it('does not remove autosave ancestors merged into main after the retention period', async () => {
    const engine = new GitEngine(); await engine.open(encode('base'), 'session');
    const old = Date.now() - 31 * 86400000; spyOn(Date, 'now').and.returnValue(old);
    await engine.autosave(encode('old autosave')); const saved = await engine.publish(encode('old autosave'));
    (Date.now as jasmine.Spy).and.returnValue(old + 32 * 86400000);
    const reopened = await new GitEngine().open(saved.files, 'next');
    expect(reopened.entries.length).toBe(saved.entries.length);
  });
  it('retains annotated tags and all objects reachable from retained refs', async () => {
    const initial = await new GitEngine().open(encode('base'), 'initial');
    const body = new TextEncoder().encode(`object ${initial.main}\ntype commit\ntag release\ntagger Local <local@wdoc.invalid> 1 +0000\n\nRelease\n`);
    const header = new TextEncoder().encode(`tag ${body.length}\0`), wrapped = new Uint8Array(header.length + body.length);
    wrapped.set(header); wrapped.set(body, header.length);
    const oid = await objectId(wrapped);
    initial.files[`.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`] = deflate(wrapped);
    initial.files['.git/refs/tags/release'] = new TextEncoder().encode(oid + '\n');
    const reopened = await new GitEngine().open(initial.files, 'next');
    expect(reopened.files['.git/refs/tags/release']).toBeDefined();
    expect(reopened.files[`.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`]).toBeDefined();
  });
  it('rejects corrupt compressed objects before Git can decode them', async () => {
    const engine = new GitEngine(), opened = await engine.open(encode('base'), 'first');
    const path = Object.keys(opened.files).find(path => /objects\/[a-f0-9]{2}\//.test(path))!;
    opened.files[path] = new Uint8Array([0]);
    await expectAsync(new GitEngine().open(opened.files, 'second')).toBeRejected();
  });
  it('removes abandoned old tmp refs without deleting main ancestors', async () => {
    const engine = new GitEngine(); await engine.open(encode('base'), 'first');
    const now = Date.now(); spyOn(Date, 'now').and.returnValue(now - 31 * 86400000);
    const draft = await engine.autosave(encode('abandoned'));
    (Date.now as jasmine.Spy).and.returnValue(now);
    const reopened = await new GitEngine().open(draft.files, 'new-session');
    expect(Object.keys(reopened.files)).not.toContain('.git/refs/heads/tmp/first');
    expect(reopened.entries.length).toBe(1);
    expect(new TextDecoder().decode(reopened.files['index.html'])).toBe('base');
  });
});
