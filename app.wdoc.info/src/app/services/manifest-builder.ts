import JSZip from 'jszip';
import { APP_VERSION } from '../config/app.config';
import { WdocLoaderService } from './wdoc-loader.service';

export interface ManifestSection {
  hashAlgorithm: 'sha256';
  lastUpdateDate: string;
  files: Record<string, string>;
  contentDigest: string;
}

export interface WdocManifest {
  meta: {
    docTitle: string;
    creator?: string;
    appVersion: string;
    creationDate: string;
    lastUpdateDate: string;
    docVersion: string;
  };
  content: ManifestSection;
  runtime: {
    forms: Record<string, ManifestSection>;
  };
}

export interface ManifestMetaOverrides {
  docTitle?: string;
  creator?: string;
  appVersion?: string;
  creationDate?: string;
  docVersion?: string;
}

const TEXT_ENCODER = new TextEncoder();

export async function generateManifest(
  zip: JSZip,
  metaOverrides?: ManifestMetaOverrides,
): Promise<WdocManifest> {
  const now = new Date().toISOString();

  const contentFiles: Record<string, string> = {};
  const runtimeFormFiles: Record<string, string> = {};

  const entries = Object.values(zip.files);
  for (const entry of entries) {
    if (entry.dir || entry.name === 'manifest.json') {
      continue;
    }

    const data = await entry.async('uint8array');
    const hash = await WdocLoaderService.computeSha256(data);

    if (entry.name.startsWith('wdoc-form/')) {
      runtimeFormFiles[entry.name] = hash;
    } else {
      contentFiles[entry.name] = hash;
    }
  }

  const baseMeta = {
    docTitle: metaOverrides?.docTitle ?? 'WDOC document',
    ...(metaOverrides?.creator ? { creator: metaOverrides.creator } : {}),
    creationDate: metaOverrides?.creationDate ?? now,
    appVersion: metaOverrides?.appVersion ?? APP_VERSION,
    docVersion: metaOverrides?.docVersion ?? '1.0.0',
  } satisfies Omit<WdocManifest['meta'], 'lastUpdateDate' | 'creator'> & {
    creator?: string;
  };

  return {
    meta: {
      ...baseMeta,
      lastUpdateDate: now,
    },
    content: await buildSection(contentFiles, now),
    runtime: {
      forms:
        Object.keys(runtimeFormFiles).length > 0
          ? { default: await buildSection(runtimeFormFiles, now) }
          : {},
    },
  };
}

export function serializeManifest(manifest: WdocManifest): string {
  return JSON.stringify(manifest, null, 2);
}

async function buildSection(
  files: Record<string, string>,
  lastUpdateDate: string,
): Promise<ManifestSection> {
  return {
    hashAlgorithm: 'sha256',
    lastUpdateDate,
    files,
    contentDigest: await computeDigest(files),
  };
}

async function computeDigest(files: Record<string, string>): Promise<string> {
  const sorted = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  const payload = sorted.map(([path, hash]) => `${path}:${hash}`).join('\n');
  return WdocLoaderService.computeSha256(TEXT_ENCODER.encode(payload));
}
