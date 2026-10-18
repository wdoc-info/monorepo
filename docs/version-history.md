# Local document version history

Open or edit a document and expand **Version history**. Saved versions are shown
by default; enable **Show autosaves** to inspect the intermediate commits.
**Restore as draft** preserves main and creates new editable content.

Every 30 seconds, changed editor content is retained in browser recovery storage
and committed to a private session branch. When a file is linked and write access
is already granted, wdoc updates the same archive while leaving its published
content at main. Browser timers are best effort. Save flushes the draft and makes
a real merge commit; all intermediate commits remain reachable.

**Merge another version** accepts another `.wdoc`. Related versions use a common
ancestor to merge independent changes. Resolve every remaining visual conflict
with **Keep yours**, **Keep incoming**, or the simple text resolution field, then
preview and use the result as a draft. Save publishes it. Signatures from the
other version remain attached to that exact version. The result is unsigned.

An external file change stops automatic replacement. Use **Merge changed local file** to inspect and merge its actual current bytes.
After accepting the result, Save writes against the imported file baseline and
checks again for subsequent changes. **Merge another version** also accepts any
separately selected copy. Save as keeps a separate archive. Access revocation and storage saturation also pause persistence;
the editor keeps its unsaved state. Main history is never truncated automatically.
Abandoned temporary branches older than 30 days are removed when opening history.

The history is local metadata, not an authenticated audit log. Author labels and
dates can be changed by anyone who edits the archive. Verify document signatures
separately. A whole-archive seal becomes obsolete after Git changes, so apply the
seal after the final save. Git commits themselves are not signed.
