# Local folders in the web app

The web app progressively enhances its file workflow with the browser's
[File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access).
Folder access requires a browser that exposes `showDirectoryPicker` in a secure
context, such as HTTPS or localhost. The app detects the capability at runtime.

## Open and edit a folder document

1. Open **Local folder** in the left navigation and choose **Open folder**.
2. Select a folder and grant the browser's read/write permission.
3. Select a `.wdoc` file, then choose **Update document**.
4. Use **Save document** or **Ctrl/Cmd+S** to replace that same file.

The list includes immediate `.wdoc` files, with case-insensitive extensions, and
excludes subfolders and other file types. **Refresh** updates the list; returning
focus to the app and successful saves also refresh it. **Disconnect** forgets the
folder and detaches the current file without changing any files on disk.

The directory handle is remembered in IndexedDB on this browser and origin.
Document bytes and filenames are not uploaded. On reload the app lists the folder
only if permission is still granted; otherwise **Reconnect folder** requests access
from a user click. The current document is not automatically reopened or linked
after a reload. Browser storage restrictions can prevent folder persistence while
still allowing folder access during the current session.

## Save destinations

An existing linked file is written directly without an application confirmation or
another destination picker. A title change does not rename the linked file.
The browser may request permission again if access has expired or been revoked.
The write stream must close successfully before the app marks the document saved.

With a folder selected, the first save of a new or unlinked document opens the
native save picker, starting in that folder. Subsequent saves reuse the chosen
file. **Save as…**, where available, chooses a different destination and makes it
the document's new linked file. Cancelling a picker retains the current draft.
Opening through the ordinary file input does not infer a writable link from a
matching filename. Installed-app file launches retain their supplied file handle.

Without a linked file or selected folder, **Save document** keeps the existing
download workflow. Browsers without folder access retain file opening and
downloads; the local-folder tab explains that direct access is unavailable.

## Archive preservation and errors

Local saves retain original resource paths, embedded assets, attachments, and form
draft files. Runtime blob URLs used by the viewer are restored to archive paths.
For an unsigned document without immutable history, saves retain its `docId` and
`createdAt` and rebuild the current manifest without accumulating historical copies.
When signatures, submissions, seals, or previous revisions exist, a normal edit
uses the existing `0.1` revision profile: historical originals and their signatures
are retained, and the edited current scope is unsigned. Signing remains a separate
explicit action. Existing seals can become obsolete when the archive changes.
Signed revision saves also replace a linked local file after signing succeeds.

Before writing an existing destination, the app compares its current size and
last-modified time with the last version it opened or saved. A detected external
change stops the write and offers **Save as…** through the normal toolbar; the app
does not overwrite the other version automatically. This is a metadata comparison,
not a filesystem lock or a merge mechanism.

Permission denial, an unavailable file, a full disk, or a failed stream close
leaves the document dirty. The editor shows the error and keeps its changes so
the user can retry or save another copy. Edits made during an in-progress save
remain dirty after that earlier version is written.

These are browser storage and UI behaviors. No file-system handles, local folder
permissions, or synchronization metadata are added to the wdoc archive or API.
