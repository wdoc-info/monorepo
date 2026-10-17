import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const validator = path.join(root, 'validator.wdoc.info');
const copies = ['core.ts', 'validation.ts', 'archive.ts'].map(name => [
  `app.wdoc.info/src/app/signatures/${name}`, `src/app/format/${name}`,
]);
for (const name of await readdir(path.join(root, 'spec/schemas'))) {
  if (name.endsWith('.schema.json')) copies.push([`spec/schemas/${name}`, `src/app/format/schemas/${name}`]);
}
for (const name of ['wdoc-format.md', 'attestation-protocol.md']) copies.push([`spec/${name}`, `public/spec/${name}`]);
const check = process.argv.includes('--check');
for (const [source, target] of copies) {
  const bytes = await readFile(path.join(root, source));
  const destination = path.join(validator, target);
  if (check) {
    const actual = await readFile(destination).catch(() => null);
    if (!actual?.equals(bytes)) throw new Error(`Format mirror differs: ${target}. Run npm run format:sync.`);
  } else {
    await mkdir(path.dirname(destination), {recursive:true});
    await writeFile(destination, bytes);
  }
}
console.log(`${check ? 'Checked' : 'Updated'} ${copies.length} format/specification mirrors.`);
