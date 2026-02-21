import { TestBed } from '@angular/core/testing';
import JSZip from 'jszip';
import { APP_VERSION } from '../config/app.config';
import { AuthService } from './auth.service';
import { FormManagerService } from './form-manager.service';
import { WdocLoaderService } from './wdoc-loader.service';
import { WdocManifest } from './manifest-builder';

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
});
