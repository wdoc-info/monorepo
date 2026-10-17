import JSZip from 'jszip';
import { assertManifest, inventory, runtimePath, type Files, type Manifest } from '../signatures/core';
import { APP_VERSION } from '../config/app.config';

export interface ManifestSection {
  hashAlgorithm: 'SHA-256';
  files: Record<string, string>;
}

export interface WdocManifest extends Manifest {
  runtime: Manifest['runtime'] & { forms: Record<string, ManifestSection> };
}

export interface ManifestMetaOverrides {
  docTitle?: string;
  creator?: string;
  appVersion?: string;
  docVersion?: string;
}

export async function generateManifest(
  zip: JSZip,
  metaOverrides?: ManifestMetaOverrides,
): Promise<WdocManifest> {
  const now = new Date().toISOString();
  const originals: Files = Object.create(null), drafts: Files = Object.create(null);
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || entry.name === 'manifest.json') continue;
    if (entry.name.startsWith('wdoc-form/')) drafts[entry.name] = await entry.async('uint8array');
    else if (!runtimePath(entry.name)) originals[entry.name] = await entry.async('uint8array');
  }
  const manifest: WdocManifest = {
    manifestVersion: '1.0',
    meta: {
      docId: crypto.randomUUID(),
      docTitle: metaOverrides?.docTitle ?? 'WDOC document',
      ...(metaOverrides?.creator ? { creator: metaOverrides.creator } : {}),
      appVersion: metaOverrides?.appVersion ?? APP_VERSION,
      docVersion: metaOverrides?.docVersion ?? '1.0.0',
      createdAt: now,
      contentUpdatedAt: now,
    },
    content: { hashAlgorithm: 'SHA-256', files: await inventory(originals) },
    runtime: {
      submissions: {},
      revisions: [],
      updatedAt: now,
      forms: Object.keys(drafts).length ? { default: { hashAlgorithm: 'SHA-256', files: await inventory(drafts) } } : {},
    },
    signatures: { document: [], forms: [] },
  };
  assertManifest(manifest);
  return manifest;
}

export function serializeManifest(manifest: Manifest): string {
  return JSON.stringify(manifest, null, 2);
}
