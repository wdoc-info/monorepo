import { VisualMerge, preview } from './visual-merge';
const files = (html: string) => ({ 'index.html': new TextEncoder().encode(`<html><head></head><body>${html}</body></html>`) });
const html = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
describe('Visual merge', () => {
  it('merges edits in independent paragraphs', () => {
    const merge = new VisualMerge(files('<p>A</p><p>B</p>'), files('<p>A changed</p><p>B</p>'), files('<p>A</p><p>B changed</p>'));
    expect(merge.conflicts.length).toBe(0);
    expect(html(merge.resolve()['index.html'])).toContain('<p>A changed</p><p>B changed</p>');
  });
  it('requires explicit conflict choices and escapes edited text', () => {
    const merge = new VisualMerge(files('<p>Base</p>'), files('<p>Ours</p>'), files('<p>Theirs</p>'));
    expect(() => merge.resolve()).toThrow();
    merge.conflicts[0].choice = 'ours'; merge.conflicts[0].text = '<script>safe text</script>';
    expect(html(merge.resolve()['index.html'])).toContain('&lt;script&gt;safe text&lt;/script&gt;');
  });
  it('keeps tables as whole visual choices and preserves deletions', () => {
    const merge = new VisualMerge(files('<table><tbody><tr><td>base</td></tr></tbody></table>'), files('<table><tbody><tr><td>ours</td></tr></tbody></table>'), files('<table><tbody><tr><td>theirs</td></tr></tbody></table>'));
    merge.conflicts[0].choice = 'theirs'; expect(html(merge.resolve()['index.html'])).toContain('theirs');
    const deletion = new VisualMerge({ ...files('base'), 'image.png': new Uint8Array([1]) }, files('base'), { ...files('base'), 'image.png': new Uint8Array([1]) });
    expect(deletion.resolve()['image.png']).toBeUndefined();
  });
  it('requires manual comparison without a common ancestor', () => {
    const merge = new VisualMerge(null, files('a'), files('b'));
    expect(merge.conflicts.length).toBe(1); merge.conflicts[0].choice = 'theirs'; expect(html(merge.resolve()['index.html'])).toContain('b');
  });
  it('previews local CSS, font references and recovered form values without external requests', () => {
    const source = { ...files('<link rel="stylesheet" href="styles/main.css"><form id="draft"><input name="name"><input type="checkbox" name="accepted" value="yes"><textarea name="notes"></textarea><select name="color"><option value="red">Red</option></select></form>'),
      'styles/main.css': new TextEncoder().encode('@import "nested.css"; body { color: navy; background: url(../pixel.png); }'),
      'styles/nested.css': new TextEncoder().encode('p { color: green }'),
      'pixel.png': new Uint8Array([1, 2]),
      'wdoc-form/draft.json': new TextEncoder().encode(JSON.stringify({ name: 'Alice', accepted: 'yes', notes: 'Draft text', color: 'red' })) };
    const output = preview(source);
    expect(output).toContain('color: navy'); expect(output).toContain('color: green'); expect(output).toContain('data:image/png;base64,');
    expect(output).toContain('value="Alice"'); expect(output).toContain('Draft text'); expect(output).toContain('checked'); expect(output).toContain('selected');
  });
  it('resolves font metadata as a whole inventory without merging cryptographic JSON', () => {
    const source = (font: string) => ({ ...files('<p>Same</p>'), 'manifest.json': new TextEncoder().encode(JSON.stringify({ content: { externalFonts: { [font]: 'digest' } }, signatures: { document: ['original proof'] } })) });
    const merge = new VisualMerge(source('base'), source('ours'), source('theirs'));
    expect(merge.conflicts.length).toBe(1); expect(merge.conflicts[0].fonts).toBeTrue();
    merge.conflicts[0].choice = 'theirs';
    const manifest = JSON.parse(html(merge.resolve()['manifest.json']));
    expect(manifest.content.externalFonts).toEqual({ theirs: 'digest' });
    expect(manifest.signatures.document).toEqual(['original proof']);
    const independent = new VisualMerge(source('base'), source('base'), source('theirs'));
    expect(independent.conflicts.length).toBe(0);
    expect(JSON.parse(html(independent.resolve()['manifest.json'])).content.externalFonts).toEqual({ theirs: 'digest' });
  });
  it('blocks active content and remote resources in previews', () => {
    const output = preview(files('<script>alert(1)</script><img src="https://evil.invalid/tracker"><form action="https://evil.invalid">Secret</form>'));
    expect(output).not.toContain('<script'); expect(output).not.toContain('src="https:'); expect(output).toContain("default-src 'none'");
  });
});
