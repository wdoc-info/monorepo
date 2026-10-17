import JSZip from 'jszip';
import { readArchive, validateArchive } from './archive';

describe('Signature ZIP profile', () => {
  it('accepts UTF-8 paths and rejects duplicates, encryption, traversal and excessive expansion', async () => {
    const zip = new JSZip(); zip.file('index.html', 'hello'); zip.file('assets/épreuve.txt', 'preuve');
    const buffer = await zip.generateAsync({ type: 'arraybuffer' }); expect(() => validateArchive(buffer)).not.toThrow();
    expect(() => validateArchive(new ArrayBuffer(0))).toThrow();
    const bad = new JSZip(); bad.file('../bad', 'bad');
    const traversal = await bad.generateAsync({ type: 'arraybuffer' }); expect(() => validateArchive(traversal)).toThrow();
    const view = new DataView(buffer.slice(0)); const eocd = view.byteLength - 22; const central = view.getUint32(eocd + 16, true);
    view.setUint16(central + 8, view.getUint16(central + 8, true) | 1, true); expect(() => validateArchive(view.buffer)).toThrow();
    const huge = new DataView(buffer.slice(0)); huge.setUint32(central + 24, 10000001, true); expect(() => validateArchive(huge.buffer)).toThrow();
    const multi = new DataView(buffer.slice(0)); multi.setUint16(eocd + 4, 1, true); expect(() => validateArchive(multi.buffer)).toThrow();
    const two = new JSZip(); two.file('aaa', 'a'); two.file('bbb', 'b'); const duplicate = await two.generateAsync({ type: 'arraybuffer' }); const d = new DataView(duplicate);
    const start = d.getUint32(duplicate.byteLength - 6, true); const second = start + 46 + 3;
    new Uint8Array(duplicate).set(new TextEncoder().encode('aaa'), second + 46); expect(() => validateArchive(duplicate)).toThrow();
  });

  it('decodes validated stored, deflated and streamed entries with exact Unicode and binary bytes', async () => {
    for (const compression of ['STORE', 'DEFLATE'] as const) for (const streamFiles of [false, true]) {
      const zip = new JSZip(); zip.file('index.html', '<p>Document 😀</p>');
      zip.file('assets/\ufeffproof.bin', new Uint8Array([0, 255, 127]));
      const result = await readArchive(await zip.generateAsync({type:'arraybuffer',compression,streamFiles}));
      expect(Array.from(result.files['assets/\ufeffproof.bin'])).toEqual([0,255,127]);
      expect(new TextDecoder().decode(result.files['index.html'])).toBe('<p>Document 😀</p>');
      expect(await result.zip.file('index.html')!.async('text')).toBe('<p>Document 😀</p>');
    }
  });

  it('rejects local-header aliases, file/directory collisions and unsupported compression', async () => {
    const zip = new JSZip(); zip.file('index.html','Original');
    const original = await zip.generateAsync({type:'arraybuffer'});
    const central = new DataView(original).getUint32(original.byteLength - 6,true);
    const localName = original.slice(0); new Uint8Array(localName)[30] = 0x78;
    expect(() => validateArchive(localName)).toThrow();
    const compression = original.slice(0), d = new DataView(compression);
    d.setUint16(central+10,99,true); d.setUint16(8,99,true);
    expect(() => validateArchive(compression)).toThrow();
    const localSize = original.slice(0); new DataView(localSize).setUint32(22,1,true);
    expect(() => validateArchive(localSize)).toThrow();
    const collision = new JSZip(); collision.file('parent','File'); collision.file('parent/child.txt','Child',{createFolders:false});
    const collisionBytes = await collision.generateAsync({type:'arraybuffer'});
    expect(() => validateArchive(collisionBytes)).toThrow();
    const symlink = new JSZip(); symlink.file('link','target',{unixPermissions:0o120777});
    const symlinkBytes = await symlink.generateAsync({type:'arraybuffer',platform:'UNIX'});
    expect(() => validateArchive(symlinkBytes)).toThrow();
    const many = new JSZip(); for (let i=0;i<1001;i++) many.file(`file-${i}`,'');
    const manyBytes = await many.generateAsync({type:'arraybuffer'});
    expect(() => validateArchive(manyBytes)).toThrow();
  });

  it('checks actual CRC and aborts expansion beyond a dishonest declared size', async () => {
    const stored = new JSZip(); stored.file('index.html','Original');
    const damaged = await stored.generateAsync({type:'arraybuffer'});
    const record = validateArchive(damaged)[0]; new Uint8Array(damaged)[record.end-record.compressedSize] ^= 1;
    await expectAsync(readArchive(damaged)).toBeRejectedWithError('ZIP size or CRC mismatch.');
    const zip = new JSZip(); zip.file('index.html',new Uint8Array(64_000));
    const dishonest = await zip.generateAsync({type:'arraybuffer',compression:'DEFLATE'});
    const view = new DataView(dishonest), central = view.getUint32(dishonest.byteLength-6,true);
    view.setUint32(22,1,true); view.setUint32(central+24,1,true);
    expect(() => validateArchive(dishonest)).not.toThrow();
    await expectAsync(readArchive(dishonest)).toBeRejectedWithError('Expanded archive exceeds limits.');
  });
});
