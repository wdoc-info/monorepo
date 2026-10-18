import { inspectGitHistory, readDocumentArchive } from './archive';
import { decodeUtf8, parseJson, verifyDocument, type KeyRecord, type Manifest } from './core';
import { fields } from './validation';
import { KeyResolverService } from './services';

// Offline verifier. The registry must be obtained independently from a trusted operator.
async function main() {
  const [archivePath, registryPath] = process.argv.slice(2);
  if (!archivePath || !registryPath) throw new Error('Usage: bun run src/signatures/verify.ts archive.wdoc trusted-keys.json');
  const registry = parseJson(decodeUtf8(new Uint8Array(await Bun.file(registryPath).arrayBuffer()))) as { keys: KeyRecord[]; allowedOrigins: string[] };
  fields(registry, ['keys', 'allowedOrigins']);
  const resolver = new KeyResolverService(registry.keys, registry.allowedOrigins);
  const archive = Bun.file(archivePath);
  const { files } = await readDocumentArchive(await archive.arrayBuffer());
  if (!files['manifest.json']) {
    console.log(JSON.stringify({ documentDigest: null, content: { status: 'unsigned', detail: 'No manifest or authenticated integrity claim.' }, document: [{ status: 'unsigned' }], forms: [], revisions: [], seals: [], history: inspectGitHistory(files) }, null, 2));
    return;
  }
  const manifest = parseJson(decodeUtf8(files['manifest.json'])) as Manifest;
  const report = await verifyDocument(manifest, files, resolver.records);
  console.log(JSON.stringify({ ...report, history: inspectGitHistory(files) }, null, 2));
  const checks = [...report.document, ...report.forms, ...report.revisions, ...report.seals];
  // No final seal means completeness has not been established, but original/submission verification still works.
  if (report.content.status === 'file-modified' || report.fontResources?.some(font => font.status === 'invalid-cache') || checks.some(c => c.status !== 'valid-trusted' && c.status !== 'unsigned' && !(c.status === 'archive-changed' && report.seals.some(s => s.status === 'valid-trusted')))) process.exitCode = 1;
}
main().catch(e => { console.error((e as Error).message); process.exitCode = 1; });
