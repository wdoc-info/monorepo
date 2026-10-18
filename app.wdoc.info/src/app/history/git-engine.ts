import { Buffer } from 'buffer';
import { unpack } from './git-pack';
import * as git from 'isomorphic-git';
import { MemoryFs } from './memory-fs';
import { archiveBudget, safePath } from '../signatures/validation';

export type Snapshot = Record<string, Uint8Array>;
export interface HistoryEntry { oid: string; parents: string[]; message: string; author: string; date: number; autosave: boolean }
export interface HistoryResult { files: Snapshot; entries: HistoryEntry[]; main: string; draft: string | null }
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
const decode = new TextDecoder('utf-8', { fatal: true });
const tracked = (path: string) => !path.startsWith('.git/') && !path.startsWith('seals/');
const author = () => ({ name: 'Local editor (unverified)', email: 'local@wdoc.invalid', timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 });

/** Git plumbing only. No checkout, executable configuration, hooks, remotes or network. */
export class GitEngine {
  private fs = new MemoryFs();
  private options = { fs: this.fs, dir: '/document' };
  private roots: Snapshot = {};
  private session = '';
  private backup?: { files: Map<string, Uint8Array>; roots: Snapshot };
  confirm(): void { this.backup = undefined; }
  async rollback(): Promise<HistoryResult> {
    if (this.backup) {
      const backup = this.backup; this.fs = new MemoryFs(); this.options = { fs: this.fs, dir: '/document' };
      for (const [path, bytes] of backup.files) await this.fs.promises.writeFile(path, bytes);
      this.roots = backup.roots; this.backup = undefined;
    }
    return this.result();
  }
  async open(files: Snapshot, session: string): Promise<HistoryResult> {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(session)) throw new Error('Invalid history session');
    this.fs = new MemoryFs(); this.options = { fs: this.fs, dir: '/document' }; this.session = session;
    this.roots = Object.fromEntries(Object.entries(files).filter(([path]) => !path.startsWith('.git/')));
    archiveBudget(Object.entries(files).map(([path, bytes]) => [path, bytes.length]));
    for (const [path, bytes] of Object.entries(files)) {
      if (!safePath(path)) throw new Error('Unsafe history path');
      if (path.startsWith('.git/')) {
        if (!path.startsWith('.git/objects/') && bytes.length > 1_000_000) throw new Error('Git metadata exceeds limits');
        await this.fs.promises.writeFile('/document/' + path, bytes);
      }
    }
    await this.checkObjects();
    await this.unpackObjects();
    await this.checkObjects();
    if (!this.fs.files.has('/document/.git/HEAD')) {
      if (Object.keys(files).some(p => p.startsWith('.git/'))) throw new Error('Incomplete Git history');
      await git.init({ ...this.options, defaultBranch: 'main' });
      const oid = await this.commit(this.roots, [], 'Initial document');
      await this.ref('main', oid);
    }
    if (decode.decode(await this.fs.promises.readFile('/document/.git/HEAD')).trim() !== 'ref: refs/heads/main') throw new Error('Unsupported Git HEAD');
    await this.cleanup();
    return this.result();
  }
  private async ref(branch: string, oid: string): Promise<void> {
    await git.writeRef({ ...this.options, ref: 'refs/heads/' + branch, value: oid, force: true });
  }
  private async resolve(ref: string): Promise<string> { return git.resolveRef({ ...this.options, ref }); }
  private async maybe(ref: string): Promise<string | null> { try { return await this.resolve(ref); } catch { return null; } }
  private async tree(files: Snapshot): Promise<string> {
    const build = async (prefix: string): Promise<string> => {
      const entries: git.TreeEntry[] = [], directories = new Set<string>();
      for (const [path, bytes] of Object.entries(files)) {
        if (!safePath(path)) throw new Error('Unsafe snapshot path');
        if (!tracked(path) || !path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length), slash = rest.indexOf('/');
        if (slash >= 0) directories.add(rest.slice(0, slash));
        else entries.push({ path: rest, mode: '100644', type: 'blob', oid: await git.writeBlob({ ...this.options, blob: bytes }) });
      }
      for (const path of directories) entries.push({ path, mode: '040000', type: 'tree', oid: await build(prefix + path + '/') });
      return git.writeTree({ ...this.options, tree: entries });
    };
    return build('');
  }
  private async commit(files: Snapshot, parents: string[], message: string): Promise<string> {
    const tree = await this.tree(files), identity = author();
    return git.writeCommit({ ...this.options, commit: { tree, parent: parents, author: identity, committer: identity, message: message + '\n' } });
  }
  async autosave(files: Snapshot): Promise<HistoryResult> {
    const before = new Map(this.fs.files);
    try { return await this.commitDraft(files); }
    catch (error) {
      this.fs = new MemoryFs(); this.options = { fs: this.fs, dir: '/document' };
      for (const [path, bytes] of before) await this.fs.promises.writeFile(path, bytes);
      throw error;
    }
  }
  private async commitDraft(files: Snapshot): Promise<HistoryResult> {
    const branch = 'tmp/' + this.session, parent = await this.maybe(branch) ?? await this.resolve('main');
    const tree = await this.tree(files), previous = await git.readCommit({ ...this.options, oid: parent });
    if (tree !== previous.commit.tree) await this.ref(branch, await this.commit(files, [parent], 'Autosave'));
    await this.checkObjects(); return this.result();
  }
  async publish(files: Snapshot, other?: string): Promise<HistoryResult> {
    this.backup ??= { files: new Map(this.fs.files), roots: this.roots };
    await this.autosave(files);
    const main = await this.resolve('main'), draft = await this.maybe('tmp/' + this.session);
    const parents = [...new Set([main, ...(draft && draft !== main ? [draft] : []), ...(other ? [other] : [])])];
    if (parents.length > 1 || (await git.readCommit({ ...this.options, oid: main })).commit.tree !== await this.tree(files)) {
      await this.ref('main', await this.commit(files, parents, other ? 'Merge document version' : 'Save document'));
    }
    this.roots = Object.fromEntries(Object.entries(files).filter(([path]) => !path.startsWith('.git/')));
    await this.ref('tmp/' + this.session, await this.resolve('main'));
    await this.checkObjects(); return this.result();
  }
  async snapshot(oid: string): Promise<Snapshot> {
    if (!/^[a-f0-9]{40}$/.test(oid)) throw new Error('Invalid Git object ID');
    const commit = await git.readCommit({ ...this.options, oid });
    const files: Snapshot = Object.create(null); let count = 0;
    const visit = async (oid: string, prefix: string, depth: number): Promise<void> => {
      if (depth > 64) throw new Error('Git tree nesting exceeds limits');
      for (const entry of (await git.readTree({ ...this.options, oid })).tree) {
        const path = prefix + entry.path;
        if (++count > 10000 || !safePath(path) || !tracked(path)) throw new Error('Unsafe Git tree');
        if (entry.type === 'tree' && entry.mode === '040000') await visit(entry.oid, path + '/', depth + 1);
        else if (entry.type === 'blob' && entry.mode === '100644') files[path] = (await git.readBlob({ ...this.options, oid: entry.oid })).blob;
        else throw new Error('Git links and executable entries are unsupported');
      }
    };
    await visit(commit.commit.tree, '', 0);
    archiveBudget(Object.entries(files).map(([path, bytes]) => [path, bytes.length]));
    return files;
  }
  async importVersion(files: Snapshot): Promise<{ theirs: string; base: Snapshot | null; ours: Snapshot; incoming: Snapshot }> {
    const original = this.fs;
    const incomingEngine = new GitEngine();
    await incomingEngine.open(files, crypto.randomUUID());
    const incoming = await incomingEngine.publish(files);
    incomingEngine.confirm();
    for (const [path, bytes] of incomingEngine.fs.files) if (path.startsWith('/document/.git/objects/')) await original.promises.writeFile(path, bytes);
    await this.checkObjects();
    const theirs = incoming.main;
    await this.ref('import/' + crypto.randomUUID(), theirs);
    const main = await this.resolve('main');
    const bases = await git.findMergeBase({ ...this.options, oids: [main, theirs] });
    return { theirs, base: bases.length ? await this.snapshot(bases[0]) : null, ours: this.roots, incoming: await this.snapshot(theirs) };
  }
  private async entries(): Promise<HistoryEntry[]> {
    const queue = await Promise.all((await git.listBranches(this.options)).map(branch => this.resolve(branch)));
    const seen = new Set<string>(), entries: HistoryEntry[] = [];
    while (queue.length) {
      const oid = queue.shift()!; if (seen.has(oid)) continue; seen.add(oid);
      if (seen.size > 10000) throw new Error('Git commit count exceeds limits');
      const { commit } = await git.readCommit({ ...this.options, oid });
      entries.push({ oid, parents: commit.parent, message: commit.message.trim(), author: commit.author.name, date: commit.author.timestamp * 1000, autosave: commit.message.trim() === 'Autosave' });
      queue.push(...commit.parent);
    }
    return entries.sort((a, b) => b.date - a.date);
  }
  private async result(): Promise<HistoryResult> {
    const files: Snapshot = { ...this.roots };
    for (const [path, bytes] of this.fs.files) if (path.startsWith('/document/.git/')) files[path.slice('/document/'.length)] = bytes;
    await this.compact(files);
    archiveBudget(Object.entries(files).map(([path, bytes]) => [path, bytes.length]));
    return { files, entries: await this.entries(), main: await this.resolve('main'), draft: await this.maybe('tmp/' + this.session) };
  }
  private async unpackObjects(): Promise<void> {
    const loose = new Map<string, Uint8Array>();
    // Existing loose objects are checked before they can serve as delta bases.
    const packs = [...this.fs.files].filter(([path]) => path.endsWith('.pack') && path.startsWith('/document/.git/objects/pack/'));
    if (!packs.length) return;
    for (const [path, bytes] of this.fs.files) {
      const match = /\/objects\/([a-f0-9]{2})\/([a-f0-9]{38})$/.exec(path);
      if (!match) continue;
      const reader = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 30_000_128) throw new Error('Git object exceeds limits'); chunks.push(next.value); } }
      finally { await reader.cancel().catch(() => undefined); }
      const wrapped = new Uint8Array(size); let at = 0; for (const chunk of chunks) { wrapped.set(chunk, at); at += chunk.length; }
      loose.set(match[1] + match[2], wrapped);
    }
    const budget = { bytes: [...loose.values()].reduce((sum, bytes) => sum + bytes.length, 0), objects: loose.size };
    for (const [path, bytes] of packs) {
      for (const object of await unpack(bytes, loose, budget)) {
        loose.set(object.oid, object.wrapped);
        if (loose.size > 10000 || [...loose.values()].reduce((sum, bytes) => sum + bytes.length, 0) > 100_000_000) throw new Error('Decoded Git objects exceed limits');
        await this.fs.promises.writeFile('/document/.git/objects/' + object.oid.slice(0, 2) + '/' + object.oid.slice(2), object.compressed);
      }
      this.fs.files.delete(path); this.fs.files.delete(path.replace(/\.pack$/, '.idx'));
    }
  }
  private async compact(files: Snapshot): Promise<void> {
    const oids = [...this.fs.files.keys()].map(path => /\/objects\/([a-f0-9]{2})\/([a-f0-9]{38})$/.exec(path)).filter(match => !!match).map(match => match![1] + match![2]);
    if (oids.length < 32) return;
    const packed = await git.packObjects({ ...this.options, oids, write: false });
    const fs = new MemoryFs(), filepath = '.git/objects/pack/' + packed.filename;
    await fs.promises.writeFile('/document/' + filepath, packed.packfile!);
    await git.indexPack({ fs, dir: '/document', filepath });
    for (const path of Object.keys(files)) if (path.startsWith('.git/objects/')) delete files[path];
    for (const [path, bytes] of fs.files) files[path.slice('/document/'.length)] = bytes;
  }
  private async checkObjects(): Promise<void> {
    let total = 0, count = 0;
    for (const [path, bytes] of this.fs.files) {
      if (!path.startsWith('/document/.git/objects/')) continue;
      if (/^\/document\/\.git\/objects\/pack\/pack-[a-f0-9]{40}\.(pack|idx)$/.test(path)) continue;
      if (!/^\/document\/\.git\/objects\/[a-f0-9]{2}\/[a-f0-9]{38}$/.test(path)) throw new Error('Only bounded loose Git objects are supported');
      if (++count > 10000) throw new Error('Git object count exceeds limits');
      const reader = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          total += next.value.length; size += next.value.length;
          if (total > 100_000_000 || size > 30_000_128) throw new Error('Decoded Git objects exceed limits');
          chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const body = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
      const zero = body.indexOf(0), header = decode.decode(body.slice(0, zero));
      if (zero < 0 || !/^(blob|tree|commit|tag) [0-9]+$/.test(header) || Number(header.split(' ')[1]) !== body.length - zero - 1) throw new Error('Invalid Git object');
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', body)), b => b.toString(16).padStart(2, '0')).join('');
      if (!path.endsWith(digest.slice(0, 2) + '/' + digest.slice(2))) throw new Error('Git object hash mismatch');
    }
  }
  private async cleanup(): Promise<void> {
    const cutoff = Date.now() - 30 * 86400000;
    for (const branch of await git.listBranches(this.options)) {
      if (!branch.startsWith('tmp/') || branch === 'tmp/' + this.session) continue;
      const tip = await git.readCommit({ ...this.options, oid: await this.resolve(branch) });
      if (tip.commit.committer.timestamp * 1000 < cutoff) await git.deleteBranch({ ...this.options, ref: branch });
    }
    // Mark all objects reachable from retained refs; main ancestry is never rewritten.
    const reachable = new Set<string>();
    const visit = async (oid: string): Promise<void> => {
      if (reachable.has(oid)) return; reachable.add(oid);
      if (reachable.size > 10000) throw new Error('Git object count exceeds limits');
      const object = await git.readObject({ ...this.options, oid, format: 'parsed' });
      if (object.type === 'commit') { const c = object.object as git.CommitObject; await visit(c.tree); for (const parent of c.parent) await visit(parent); }
      if (object.type === 'tag') await visit((object.object as git.TagObject).object);
      if (object.type === 'tree') for (const entry of object.object as git.TreeEntry[]) await visit(entry.oid);
    };
    for (const branch of await git.listBranches(this.options)) await visit(await this.resolve(branch));
    for (const path of this.fs.files.keys()) if (path.startsWith('/document/.git/refs/')) await visit(await this.resolve(path.slice('/document/.git/'.length)));
    const packedRefs = this.fs.files.get('/document/.git/packed-refs');
    if (packedRefs) for (const line of decode.decode(packedRefs).split('\n')) {
      const match = /^([a-f0-9]{40}) (refs\/[^ ]+)$/.exec(line);
      if (match) { if (!safePath(match[2])) throw new Error('Unsafe packed Git reference'); await visit(match[1]); }
    }
    for (const path of [...this.fs.files.keys()]) {
      const m = /\/objects\/([a-f0-9]{2})\/([a-f0-9]{38})$/.exec(path);
      if (m && !reachable.has(m[1] + m[2])) this.fs.files.delete(path);
    }
  }
}
