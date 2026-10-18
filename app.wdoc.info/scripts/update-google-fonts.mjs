import { readFile, writeFile } from 'node:fs/promises';

// The Google Fonts website metadata is an input to this build-time snapshot,
// never a runtime dependency of the editor. See README.md for the refresh command.
const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/update-google-fonts.mjs <metadata.json>');
const metadata = JSON.parse((await readFile(path, 'utf8')).replace(/^\)\]\}'\s*/, ''));
if (!Array.isArray(metadata.familyMetadataList)) throw new Error('Missing Google Fonts family metadata.');

const families = metadata.familyMetadataList.map(({ family, fonts }) => {
  if (typeof family !== 'string' || !family || /[\r\n{};"'\\<>]/.test(family)) throw new Error('Invalid font family.');
  const variants = Object.keys(fonts);
  if (!variants.length || variants.some(style => !/^(?:[1-9]\d{0,2}|1000)i?$/.test(style))) throw new Error(`Invalid styles for ${family}.`);
  const tuples = [];
  for (const italic of [0, 1]) {
    const weights = variants.filter(style => style.endsWith('i') === Boolean(italic)).map(Number.parseFloat);
    if (!weights.length) continue;
    // Include regular and bold where available, or the closest available regular.
    const regular = weights.reduce((best, weight) => Math.abs(weight - 400) < Math.abs(best - 400) ? weight : best);
    for (const weight of [...new Set([regular, ...weights.filter(weight => weight === 700)])].sort((a, b) => a - b)) {
      tuples.push(`${italic},${weight}`);
    }
  }
  return [family, tuples.join(';')];
}).sort(([a], [b]) => a.localeCompare(b, 'en'));
if (new Set(families.map(([family]) => family)).size !== families.length) throw new Error('Duplicate font families.');

const source = `// Generated from https://fonts.google.com/metadata/fonts on ${new Date().toISOString().slice(0, 10)}.\n`
  + '// Refresh with scripts/update-google-fonts.mjs; contains names and supported regular/bold styles only.\n'
  + 'export const GOOGLE_FONT_CATALOG: readonly (readonly [family: string, styles: string])[] = [\n'
  + families.map(font => `  ${JSON.stringify(font)},`).join('\n') + '\n];\n';
await writeFile(new URL('../src/app/config/google-fonts.catalog.ts', import.meta.url), source);
console.log(`Updated ${families.length} Google Fonts families.`);
