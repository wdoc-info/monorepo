import { Buffer } from 'buffer';

/** A private, inert filesystem. There are no host files, links, hooks or processes. */
export class MemoryFs {
  readonly files = new Map<string, Uint8Array>();
  private dirs = new Set(['/', '/document', '/document/.git']);
  private path(path: string): string {
    if (!path.startsWith('/document/') || path.split('/').some(p => p === '..' || p === '.')) {
      if (path === '/' || path === '/document') return path;
      throw new Error('Unsafe Git filesystem path');
    }
    return path.replace(/\/$/, '');
  }
  private error(code: string): never { throw Object.assign(new Error(code), { code }); }
  readonly promises = {
    readFile: async (path: string, options?: any): Promise<any> => {
      const data = this.files.get(this.path(path));
      if (!data) return this.error('ENOENT');
      return (typeof options === 'string' ? options : options?.encoding) ? new TextDecoder().decode(data) : Buffer.from(data);
    },
    writeFile: async (path: string, data: string | Uint8Array): Promise<void> => {
      path = this.path(path);
      this.files.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
      const parts = path.split('/');
      for (let n = 2; n < parts.length; n++) this.dirs.add(parts.slice(0, n).join('/'));
    },
    mkdir: async (path: string): Promise<void> => { this.dirs.add(this.path(path)); },
    rmdir: async (path: string): Promise<void> => { this.dirs.delete(this.path(path)); },
    unlink: async (path: string): Promise<void> => { if (!this.files.delete(this.path(path))) this.error('ENOENT'); },
    readdir: async (path: string): Promise<string[]> => {
      path = this.path(path);
      if (!this.dirs.has(path)) return this.error('ENOENT');
      return [...new Set([...this.files.keys(), ...this.dirs].filter(p => p.startsWith(path + '/')).map(p => p.slice(path.length + 1).split('/')[0]))];
    },
    stat: async (path: string): Promise<any> => this.stat(path),
    lstat: async (path: string): Promise<any> => this.stat(path),
    readlink: async (): Promise<never> => this.error('EINVAL'),
    symlink: async (): Promise<never> => this.error('EPERM'),
    chmod: async (): Promise<void> => undefined,
  };
  private stat(path: string): any {
    path = this.path(path);
    const directory = this.dirs.has(path), data = this.files.get(path);
    if (!directory && !data) return this.error('ENOENT');
    return { type: directory ? 'dir' : 'file', mode: directory ? 0o40755 : 0o100644, size: data?.length ?? 0, mtimeMs: 0, ctimeMs: 0, uid: 0, gid: 0, ino: 0, dev: 0,
      isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false };
  }
}
