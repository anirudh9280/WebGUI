// Where labels live: <labels>/<dataset>/<stem>/<annotator>.json plus an append-only
// <annotator>.log.jsonl of every change. FolderStore writes into a folder the user picks
// (e.g. a shared labels folder on VAST); ServerStore goes through the lab server.
// Both: save(labels, log) -> new `updated` stamp; ConflictError if the file changed elsewhere.

export function safeName(s) { // same rule as safe_name in tools/webgui_tools/server.py
  return String(s).trim().replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^\.+/, "") || "anonymous";
}

export class ConflictError extends Error {}
const CONFLICT = "These labels were changed in another tab or window.";

// Remember picked folders between visits (File System Access handles live in IndexedDB).
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("webgui", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("handles");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("handles", mode);
      const req = fn(tx.objectStore("handles"));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
export const rememberHandle = (key, handle) => idb("readwrite", (s) => s.put(handle, key)).catch(() => {});
export const recallHandle = (key) => idb("readonly", (s) => s.get(key)).catch(() => null);

async function readJson(fileHandle) {
  return JSON.parse(await (await fileHandle.getFile()).text());
}

export class FolderStore {
  constructor(dir) {
    this.dir = dir;
    this.name = dir.name;
    this.exportsOnServer = false;
  }

  async _itemDir(dataset, stem, create) {
    const d = await this.dir.getDirectoryHandle(safeName(dataset), { create });
    return d.getDirectoryHandle(safeName(stem), { create });
  }

  async load(dataset, stem, annotator) {
    try {
      const d = await this._itemDir(dataset, stem, false);
      return await readJson(await d.getFileHandle(`${safeName(annotator)}.json`));
    } catch (e) {
      if (e.name === "NotFoundError") return null;
      throw e;
    }
  }

  async save(labels, log) {
    const d = await this._itemDir(labels.dataset, labels.stem, true);
    const who = safeName(labels.annotator);
    const fh = await d.getFileHandle(`${who}.json`, { create: true });
    const file = await fh.getFile();
    const current = file.size ? JSON.parse(await file.text()) : null;
    if ((current?.updated ?? null) !== (labels.updated ?? null)) throw new ConflictError(CONFLICT);
    const updated = new Date().toISOString();
    const out = { ...labels, updated };
    const w = await fh.createWritable(); // written to a temp file, swapped in on close
    await w.write(JSON.stringify(out, null, 1));
    await w.close();
    const lh = await d.getFileHandle(`${who}.log.jsonl`, { create: true });
    const size = (await lh.getFile()).size;
    const lw = await lh.createWritable({ keepExistingData: true });
    await lw.seek(size);
    const entry = { at: updated, ...log };
    if (log?.snapshot) entry.labels = out;
    await lw.write(JSON.stringify(entry) + "\n");
    await lw.close();
    return updated;
  }

  // stem -> [{annotator, events, done, updated}]
  async status(dataset) {
    const out = {};
    let ds;
    try { ds = await this.dir.getDirectoryHandle(safeName(dataset)); } catch { return out; }
    for await (const [stem, d] of ds.entries()) {
      if (d.kind !== "directory") continue;
      for await (const [name, fh] of d.entries()) {
        if (fh.kind !== "file" || !name.endsWith(".json")) continue;
        try {
          const l = await readJson(fh);
          (out[stem] ??= []).push({ annotator: l.annotator, events: l.events.length, done: !!l.done, updated: l.updated });
        } catch { /* half-written or foreign file: skip */ }
      }
    }
    return out;
  }
}

const enc = encodeURIComponent;

export class ServerStore {
  constructor() { this.exportsOnServer = true; }

  url(dataset, stem, annotator) {
    return `api/labels/${enc(dataset)}/${enc(stem)}?annotator=${enc(annotator)}`;
  }

  async load(dataset, stem, annotator) {
    const r = await fetch(this.url(dataset, stem, annotator), { cache: "no-store" });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`loading labels: HTTP ${r.status}`);
    return r.json();
  }

  async save(labels, log) {
    const base = labels.updated ? `&base=${enc(labels.updated)}` : "";
    const r = await fetch(this.url(labels.dataset, labels.stem, labels.annotator) + base, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels, log }),
    });
    if (r.status === 409) throw new ConflictError(CONFLICT);
    if (!r.ok) throw new Error(`saving labels: ${(await r.json().catch(() => null))?.detail ?? `HTTP ${r.status}`}`);
    return (await r.json()).updated;
  }

  async status(dataset) {
    const r = await fetch(`api/datasets/${enc(dataset)}/status`, { cache: "no-store" });
    return r.ok ? r.json() : {};
  }

  exportUrl(labels, what) {
    return `api/export/${enc(labels.dataset)}/${enc(labels.stem)}/${what}?annotator=${enc(labels.annotator)}`;
  }
}
