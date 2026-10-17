import { TestBed } from '@angular/core/testing';
import JSZip from 'jszip';
import { APP_VERSION } from '../config/app.config';
import { AuthService } from './auth.service';
import { FormManagerService } from './form-manager.service';
import { WdocManifest, generateManifest } from './manifest-builder';
import { CompactSign, generateKeyPair, exportJWK } from 'jose';
import { commitment, newNonce, encoder, jcs, documentDigest, verifyDocument, type Manifest } from '../signatures/core';

interface FormDriveEntry {
  role: string;
  mime: string;
}

describe('FormManagerService', () => {
  let service: FormManagerService;
  let authService: jasmine.SpyObj<AuthService>;

  beforeEach(() => {
    authService = jasmine.createSpyObj<AuthService>('AuthService', [
      'getCurrentUserEmail',
    ]);
    authService.getCurrentUserEmail.and.returnValue('form@example.com');

    TestBed.configureTestingModule({
      providers: [{ provide: AuthService, useValue: authService }],
    });
    service = TestBed.inject(FormManagerService);
  });

  it('populates forms from wdoc-form folder', async () => {
    const html =
      '<html><head></head><body><form id="f1"><input name="username"/><input type="file" name="photo"/></form><wdoc-page></wdoc-page></body></html>';
    const zip = new JSZip();
    zip.file('index.html', html);
    const folder = zip.folder('wdoc-form')!;
    folder.file(
      'f1.json',
      JSON.stringify({ username: 'bob', photo: 'img.txt' })
    );
    folder.file('img.txt', 'data');

    const doc = new DOMParser().parseFromString(html, 'text/html');
    await service.populateFormsFromZip(zip, doc);

    expect(
      (doc.querySelector('input[name="username"]') as HTMLInputElement).value
    ).toBe('bob');
    const link = doc.querySelector(
      'input[name="photo"] + a'
    ) as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.textContent).toBe('img.txt');
    expect(link.getAttribute('download')).toBe('img.txt');
    expect(link.getAttribute('href')!.startsWith('blob:')).toBeTrue();
  });

  it('populates named form entries with text and file data', async () => {
    const html = `
      <html><body>
        <form id="login">
          <label for="username">username *</label>
          <input type="text" required name="username" />
          <label for="picture" required>picture *</label>
          <input type="file" required name="picture" />
        </form>
      </body></html>
    `;
    const zip = new JSZip();
    zip.file('index.html', html);
    const folder = zip.folder('wdoc-form')!;
    folder.file('login.json', JSON.stringify({ username: 'test', picture: 'nous deux.jpg' }));
    folder.file('nous deux.jpg', 'imgbytes');

    const doc = new DOMParser().parseFromString(html, 'text/html');
    await service.populateFormsFromZip(zip, doc);

    const username = doc.querySelector('input[name="username"]') as HTMLInputElement;
    expect(username.value).toBe('test');
    expect(username.getAttribute('value')).toBe('test');

    const pictureLink = doc.querySelector('input[name="picture"] + a') as HTMLAnchorElement;
    expect(pictureLink?.textContent).toBe('nous deux.jpg');
  });

  it('removes an existing file link when a new file is selected', async () => {
    const html = `
      <html><body>
        <form id="upload">
          <input type="file" name="attachment" />
        </form>
      </body></html>
    `;
    const zip = new JSZip();
    zip.file('index.html', html);
    const folder = zip.folder('wdoc-form')!;
    folder.file('upload.json', JSON.stringify({ attachment: 'old.txt' }));
    folder.file('old.txt', 'previous');

    const doc = new DOMParser().parseFromString(html, 'text/html');
    await service.populateFormsFromZip(zip, doc);

    const input = doc.querySelector('input[name="attachment"]') as HTMLInputElement;
    expect(input.nextElementSibling instanceof HTMLAnchorElement).toBeTrue();

    const dt = new DataTransfer();
    dt.items.add(new File(['fresh'], 'new.txt'));
    Object.defineProperty(input, 'files', { value: dt.files });
    input.dispatchEvent(new Event('change'));

    expect(input.nextElementSibling instanceof HTMLAnchorElement).toBeFalse();
    expect(input.dataset['savedFile']).toBe('old.txt');
  });

  it('restores checkbox and radio controls from saved data', async () => {
    const html = `
      <html><body>
        <form id="preferences">
          <input type="checkbox" name="subscribe">
          <input type="radio" name="color" value="red">
          <input type="radio" name="color" value="blue">
          <textarea name="notes"></textarea>
        </form>
      </body></html>
    `;
    const zip = new JSZip();
    zip.file('index.html', html);
    const formFolder = zip.folder('wdoc-form')!;
    formFolder.file(
      'preferences.json',
      JSON.stringify({ subscribe: 'true', color: 'blue', notes: 'saved' }),
    );

    const doc = new DOMParser().parseFromString(html, 'text/html');
    await service.populateFormsFromZip(zip, doc);

    const form = doc.getElementById('preferences') as HTMLFormElement;
    expect((form.querySelector('[name="subscribe"]') as HTMLInputElement).checked).toBeTrue();
    const radios = form.querySelectorAll<HTMLInputElement>('input[type="radio"][name="color"]');
    expect(radios[0].checked).toBeFalse();
    expect(radios[1].checked).toBeTrue();
    expect((form.querySelector('textarea[name="notes"]') as HTMLTextAreaElement).value).toBe(
      'saved',
    );
  });

  it('saves form data and attachments back into a wdoc archive', async () => {
    const initialZip = new JSZip();
    initialZip.file('index.html', '<html></html>');
    initialZip.folder('wdoc-form');
    const buffer = await initialZip.generateAsync({ type: 'arraybuffer' });

    const container = document.createElement('div');
    container.innerHTML = `
      <form id="form1">
        <input name="name" value="Ada" />
        <input type="checkbox" name="agree" checked />
        <input type="radio" name="size" value="s" />
        <input type="radio" name="size" value="m" checked />
        <input type="file" name="attachment" />
      </form>
    `;

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['hello'], 'note.txt', { type: 'text/plain' }));
    Object.defineProperty(fileInput, 'files', { value: dataTransfer.files });

    const createObjectUrlSpy = spyOn(URL, 'createObjectURL').and.callFake(() => 'blob:filled');
    const revokeSpy = spyOn(URL, 'revokeObjectURL');
    const clickSpy = spyOn(HTMLAnchorElement.prototype, 'click');

    const saved = await service.saveForms(container, buffer);

    expect(saved).toBeTrue();

    expect(clickSpy).toHaveBeenCalled();
    expect(revokeSpy).toHaveBeenCalledWith('blob:filled');

    const blobArg = createObjectUrlSpy.calls.mostRecent().args[0] as Blob;
    const savedZip = await JSZip.loadAsync(await blobArg.arrayBuffer());

    const savedForm = JSON.parse(
      await savedZip.file('wdoc-form/form1.json')!.async('text'),
    ) as Record<string, string>;
    expect(savedForm['name']).toBe('Ada');
    expect(savedForm['agree']).toBe('on');
    expect(savedForm['size']).toBe('m');
    expect(savedForm['attachment']).toBe('note.txt');

    const attachment = await savedZip.file('wdoc-form/note.txt')!.async('text');
    expect(attachment).toBe('hello');

    const manifest = JSON.parse(
      await savedZip.file('manifest.json')!.async('text'),
    ) as any;

    expect(manifest.content.files['index.html']).toBeDefined();
    expect(manifest.meta.appVersion).toBe(APP_VERSION);
    expect(manifest.meta.creator).toBe('form@example.com');
    expect(manifest.meta.docVersion).toBe('1.0.0');
    expect(
      manifest.runtime.forms.default.files['wdoc-form/form1.json'],
    ).toBeDefined();
    expect(manifest.runtime.forms.default.files['wdoc-form/note.txt']).toBeDefined();
  });

  it('saves drafts from a manifestless enclosing folder at logical document paths', async () => {
    const source = new JSZip(); source.file('Report/index.html', '<form id="approval"><input name="name"></form>', { createFolders: false });
    const root = document.createElement('div'); root.innerHTML = '<form id="approval"><input name="name" value="Alice"></form>';
    const create = spyOn(URL, 'createObjectURL').and.returnValue('blob:draft'); spyOn(URL, 'revokeObjectURL'); spyOn(HTMLAnchorElement.prototype, 'click');
    expect(await service.saveForms(root, await source.generateAsync({ type: 'arraybuffer' }))).toBeTrue();
    const output = await JSZip.loadAsync(await (create.calls.mostRecent().args[0] as Blob).arrayBuffer());
    expect(output.file('index.html')).not.toBeNull(); expect(output.file('Report/index.html')).toBeNull();
    expect(JSON.parse(await output.file('wdoc-form/approval.json')!.async('text'))).toEqual({name:'Alice'});
    const manifest = JSON.parse(await output.file('manifest.json')!.async('text'));
    expect(manifest.content.files['index.html']).toBeDefined(); expect(manifest.signatures).toEqual({document:[],forms:[]});
    expect(manifest.runtime.forms.default.hashAlgorithm).toBe('SHA-256');
    expect(manifest.runtime.forms.default.files['wdoc-form/approval.json']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(manifest.content.contentDigest).toBeUndefined(); expect(manifest.meta.creationDate).toBeUndefined();
  });

  it('replaces previously saved attachments when a new file is uploaded', async () => {
    const initialZip = new JSZip();
    const html = '<html><body><form id="form1"><input type="file" name="attachment" /></form></body></html>';
    initialZip.file('index.html', html);
    const formsFolder = initialZip.folder('wdoc-form')!;
    formsFolder.file('form1.json', JSON.stringify({ attachment: 'old.txt' }));
    formsFolder.file('old.txt', 'outdated');
    const buffer = await initialZip.generateAsync({ type: 'arraybuffer' });

    const doc = new DOMParser().parseFromString(html, 'text/html');
    await service.populateFormsFromZip(await JSZip.loadAsync(buffer), doc);

    const fileInput = doc.querySelector('input[type="file"]') as HTMLInputElement;
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['fresh'], 'new.txt', { type: 'text/plain' }));
    Object.defineProperty(fileInput, 'files', { value: dataTransfer.files });
    fileInput.dispatchEvent(new Event('change'));

    const createObjectUrlSpy = spyOn(URL, 'createObjectURL').and.callFake(() => 'blob:updated');
    spyOn(HTMLAnchorElement.prototype, 'click');
    spyOn(URL, 'revokeObjectURL');

    const saved = await service.saveForms(doc, buffer);
    expect(saved).toBeTrue();

    const blobArg = createObjectUrlSpy.calls.mostRecent().args[0] as Blob;
    const savedZip = await JSZip.loadAsync(await blobArg.arrayBuffer());

    const savedData = JSON.parse(
      await savedZip.file('wdoc-form/form1.json')!.async('text'),
    ) as Record<string, string>;
    expect(savedData['attachment']).toBe('new.txt');
    expect(savedZip.file('wdoc-form/new.txt')).toBeTruthy();
    expect(savedZip.file('wdoc-form/old.txt')).toBeNull();

    const manifest = JSON.parse(
      await savedZip.file('manifest.json')!.async('text'),
    ) as WdocManifest;
    expect(manifest.runtime.forms['default'].files['wdoc-form/new.txt']).toBeDefined();
    expect(manifest.runtime.forms['default'].files['wdoc-form/old.txt']).toBeUndefined();
  });

  it('blocks saving when HTML form validation fails', async () => {
    const initialZip = new JSZip();
    initialZip.file('index.html', '<html></html>');
    initialZip.folder('wdoc-form');
    const buffer = await initialZip.generateAsync({ type: 'arraybuffer' });

    const container = document.createElement('div');
    container.innerHTML = `
      <form>
        <input name="name" required />
      </form>
    `;

    const createObjectUrlSpy = spyOn(URL, 'createObjectURL');
    const clickSpy = spyOn(HTMLAnchorElement.prototype, 'click');

    const saved = await service.saveForms(container, buffer);

    expect(saved).toBeFalse();
    expect(createObjectUrlSpy).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
  });
  it('preserves the signed original scope and immutable submissions when saving a draft', async () => {
    const zip = new JSZip(); zip.file('index.html', '<form id="contract"><input name="answer"></form>');
    const manifest = await generateManifest(zip) as unknown as Manifest;
    const pair = await generateKeyPair('ES256', { extractable: true });
    const kid = 'https://sig.wdoc.info/info/test'; const now = new Date().toISOString();
    const nonce = newNonce();
    const jws = await new CompactSign(encoder.encode(jcs({ type: 'wdoc-document-signature', proofMode: 'digest-only', documentCommitment: await commitment('document', await documentDigest(manifest), nonce), signedAt: now, signer: {userId:'alice',displayName:'Alice'}, evidence: {scope:'commitment-only',method:'authenticated-session',consent:'wdoc-sign-v1'} }))).setProtectedHeader({ alg: 'ES256', typ: 'wdoc-document+jws', kid }).sign(pair.privateKey);
    manifest.signatures.document.push({ signatureId: 'sig', nonce, jws });
    zip.file('submissions/s1/answers.json', '{"answer":"original"}');
    zip.file('manifest.json', jcs(manifest)); const digest = await documentDigest(manifest);
    const root = document.createElement('div'); root.innerHTML = '<form id=contract><input name=answer value=changed></form>';
    let downloaded!: Blob;
    spyOn(URL, 'createObjectURL').and.callFake(blob => { downloaded = blob as Blob; return 'blob:draft'; }); spyOn(URL, 'revokeObjectURL'); spyOn(HTMLAnchorElement.prototype, 'click');
    expect(await service.saveForms(root, await zip.generateAsync({ type: 'arraybuffer' }))).toBeTrue();
    const saved = await JSZip.loadAsync(await downloaded.arrayBuffer()); const updated = JSON.parse(await saved.file('manifest.json')!.async('text')) as Manifest;
    expect(await documentDigest(updated)).toBe(digest); expect(updated.signatures.document[0].jws).toBe(jws);
    expect(await saved.file('submissions/s1/answers.json')!.async('text')).toBe('{"answer":"original"}');
    expect(await saved.file('wdoc-form/contract.json')!.async('text')).toContain('changed');
    const bytes = { 'index.html': await saved.file('index.html')!.async('uint8array'), 'submissions/s1/answers.json': await saved.file('submissions/s1/answers.json')!.async('uint8array'), 'wdoc-form/contract.json': await saved.file('wdoc-form/contract.json')!.async('uint8array') };
    expect((await verifyDocument(updated, bytes, [{ kid, jwk: await exportJWK(pair.publicKey), trusted: true, status: 'active', authority: 'platform', owner: 'wdoc' }])).document[0].status).toBe('valid-trusted');
  });

  it('round-trips mixed named and unnamed forms and prefers exact IDs over positional names', async () => {
    const zip = new JSZip();
    const html = '<form id="named"><input name="answer" value="Named"></form><form><input name="answer" value="Unnamed"></form><form id="form-99"><input name="answer" value="Explicit"></form>';
    zip.file('index.html',html);
    const root = document.createElement('div'); root.innerHTML = html;
    let blob!: Blob;
    spyOn(URL,'createObjectURL').and.callFake(value => {blob=value as Blob;return 'blob:forms';});
    spyOn(URL,'revokeObjectURL'); spyOn(HTMLAnchorElement.prototype,'click');
    expect(await service.saveForms(root,await zip.generateAsync({type:'arraybuffer'}))).toBeTrue();
    const saved = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(saved.file('wdoc-form/form-2.json')).not.toBeNull(); expect(saved.file('wdoc-form/form-1.json')).toBeNull();
    const doc = new DOMParser().parseFromString(html.replace(/value="[^"]*"/g,'value=""'),'text/html');
    await service.populateFormsFromZip(saved,doc);
    expect(Array.from(doc.querySelectorAll<HTMLInputElement>('input')).map(i=>i.value)).toEqual(['Named','Unnamed','Explicit']);
  });

  it('does not restore ambiguous JSON or treat answer names as selectors', async () => {
    const doc = new DOMParser().parseFromString('<form id="safe"><input name="answer" value="Unchanged"></form>','text/html');
    const input = doc.querySelector('input')!; input.name = 'a"quoted]name';
    const zip = new JSZip(); zip.file('wdoc-form/safe.json',JSON.stringify({'a"quoted]name':'Restored'}));
    await service.populateFormsFromZip(zip,doc); expect(input.value).toBe('Restored');
    zip.file('wdoc-form/safe.json','{"a":1,"\\u0061":2}');
    await service.populateFormsFromZip(zip,doc); expect(input.value).toBe('Restored');
    zip.file('wdoc-form/safe.json','[]'); await service.populateFormsFromZip(zip,doc); expect(input.value).toBe('Restored');
  });

  it('rejects draft ID collisions before producing a download', async () => {
    const zip = new JSZip(); zip.file('index.html','<p>Document</p>');
    const root = document.createElement('div'); root.innerHTML = '<form id="form-2"></form><form></form>';
    const click = spyOn(HTMLAnchorElement.prototype,'click');
    await expectAsync(service.saveForms(root,await zip.generateAsync({type:'arraybuffer'}))).toBeRejectedWithError('Ambiguous draft form IDs.');
    expect(click).not.toHaveBeenCalled();
  });
});
