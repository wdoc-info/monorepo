import { generateKeyPair, exportJWK } from 'jose';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function main() {
  const [directory, kid] = process.argv.slice(2);
  if (!directory || !kid || !/^https:\/\/[^/]+\/info\/[\w-]+$/.test(kid)) throw new Error('Usage: bun run src/signatures/keygen.ts output-directory https://your-key-domain/info/unique-key-id');
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const privateJwk = await exportJWK(privateKey); const jwk = await exportJWK(publicKey);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(resolve(directory, 'private.jwk.json'), JSON.stringify(privateJwk), { mode: 0o600, flag: 'wx' });
  await writeFile(resolve(directory, 'registry.json'), JSON.stringify({ allowedOrigins: [new URL(kid).origin], keys: [{ kid, jwk, status: 'active', trusted: true, authority: 'platform', owner: 'wdoc' }] }, null, 2), { mode: 0o600, flag: 'wx' });
  console.log('Created private.jwk.json (server only) and registry.json in the requested directory.');
}
main().catch(e => { console.error((e as Error).message); process.exitCode = 1; });
