// A dataset is a folder of <stem>.mp4 + <stem>[.tracked|.predictions].slp pairs. Two ways in:
//  - folder mode (GitHub Pages): a folder the user picks on their mounted VAST share
//    (File System Access API, Chrome/Edge);
//  - server mode: folders listed by the lab server (tools/webgui_tools/server.py), streamed
//    read-only with HTTP Range.

import { FileSource, UrlSource } from "../io/source.js";

const SLP_PREFERENCE = [".tracked.slp", ".slp", ".predictions.slp"];

// Same rule as pair_items in tools/webgui_tools/server.py.
export function pairItems(names) {
  const set = new Set(names);
  const items = [];
  for (const mp4 of set) {
    if (!mp4.toLowerCase().endsWith(".mp4") || mp4.startsWith(".")) continue;
    const stem = mp4.slice(0, -4);
    const slp = SLP_PREFERENCE.map((suf) => stem + suf).find((n) => set.has(n));
    if (slp) items.push({ stem, mp4, slp });
  }
  return items.sort((a, b) => a.stem.localeCompare(b.stem, undefined, { numeric: true }));
}

export async function datasetFromHandle(dir) {
  const files = new Map();
  for await (const [name, h] of dir.entries()) if (h.kind === "file") files.set(name, h);
  const items = pairItems([...files.keys()]).map((it) => ({
    ...it,
    open: async () => ({
      mp4: new FileSource(await files.get(it.mp4).getFile()),
      slp: new FileSource(await files.get(it.slp).getFile()),
    }),
  }));
  return { name: dir.name, items };
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${(await r.json().catch(() => null))?.detail ?? `HTTP ${r.status}`}`);
  return r.json();
}

// Resolves to the server's dataset list, or null when there is no server (e.g. GitHub Pages).
export async function serverDatasets() {
  try {
    const r = await fetch("api/datasets", { cache: "no-store" });
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function openServerDataset(name) {
  const ds = encodeURIComponent(name);
  const items = (await getJson(`api/datasets/${ds}/items`)).map((it) => ({
    ...it,
    open: async () => ({
      mp4: new UrlSource(`data/${ds}/${encodeURIComponent(it.mp4)}`, it.mp4_size),
      slp: await UrlSource.open(`data/${ds}/${encodeURIComponent(it.slp)}`),
    }),
  }));
  return { name, items };
}
