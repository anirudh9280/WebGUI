// Parses a .slp off the main thread. A File is mounted with WORKERFS (read lazily, never copied
// whole into memory); an ArrayBuffer (UrlSource) is written to the in-memory FS.
import * as h5 from "../../vendor/h5wasm/hdf5_hl.js";
import { parseSlp } from "./slp-parse.js";

let n = 0;

self.onmessage = async ({ data }) => {
  const { id, input } = data;
  let dir = null, path;
  try {
    await h5.ready;
    const FS = h5.FS;
    if (input instanceof Blob) {
      dir = `/w${++n}`;
      FS.mkdir(dir);
      FS.mount(FS.filesystems.WORKERFS, { files: [input] }, dir);
      path = `${dir}/${input.name}`;
    } else {
      path = `/m${++n}.slp`;
      FS.writeFile(path, new Uint8Array(input));
    }
    const file = new h5.File(path, "r");
    let slp;
    try { slp = parseSlp(h5, file); } finally { file.close(); }
    self.postMessage({ id, ok: true, slp }, [slp.frameStart.buffer, slp.track.buffer, slp.points.buffer]);
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.stack ?? e) });
  } finally {
    try {
      if (dir) { h5.FS.unmount(dir); h5.FS.rmdir(dir); } else if (path) h5.FS.unlink(path);
    } catch { /* best effort */ }
  }
};
