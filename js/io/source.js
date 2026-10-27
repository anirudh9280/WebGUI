// Random-access byte sources. FileSource wraps a File from the File System Access API (the
// user's mounted VAST share); UrlSource uses HTTP Range requests (dev server, tests).

export class FileSource {
  constructor(file) {
    this.file = file;
    this.name = file.name;
    this.size = file.size;
  }

  async read(offset, length) {
    return new Uint8Array(await this.file.slice(offset, offset + length).arrayBuffer());
  }

  async all() {
    return this.file;
  }
}

export class UrlSource {
  constructor(url, size) {
    this.url = url;
    this.name = decodeURIComponent(new URL(url, location.href).pathname.split("/").pop());
    this.size = size;
  }

  static async open(url) {
    const r = await fetch(url, { method: "HEAD" });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return new UrlSource(url, Number(r.headers.get("content-length")));
  }

  async read(offset, length) {
    const end = Math.min(offset + length, this.size) - 1;
    const r = await fetch(this.url, { headers: { Range: `bytes=${offset}-${end}` } });
    if (r.status !== 206) throw new Error(`${this.url}: server ignored Range (HTTP ${r.status})`);
    return new Uint8Array(await r.arrayBuffer());
  }

  async all() {
    const r = await fetch(this.url);
    if (!r.ok) throw new Error(`${this.url}: HTTP ${r.status}`);
    return r.arrayBuffer();
  }
}
