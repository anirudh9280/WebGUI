// Frame-exact video access with WebCodecs. Frames are decoded a segment (keyframe to next
// keyframe) at a time and cached as 8-bit luma planes: HCM video is grayscale, and luma alone
// is exactly what ffmpeg/OpenCV call the gray frame, so hashes can be compared with Python.

import { parseMp4 } from "./mp4-parse.js";

const CACHE_FRAMES = 200; // ~260 MB at 1280x1024

export class VideoReader {
  static async open(source) {
    const meta = await parseMp4((o, l) => source.read(o, l), source.size);
    if (!meta.entryType.startsWith("avc") && !meta.entryType.startsWith("hvc")) {
      throw new Error(`${source.name}: codec "${meta.entryType}" can't be decoded in the browser; ` +
        "convert it with tools/webgui_tools/transcode.py");
    }
    const config = {
      codec: meta.codec,
      description: meta.description,
      codedWidth: meta.width,
      codedHeight: meta.height,
      optimizeForLatency: true,
    };
    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) throw new Error(`${source.name}: this browser can't decode ${meta.codec}`);
    return new VideoReader(source, meta, config);
  }

  constructor(source, meta, config) {
    this.source = source;
    this.meta = meta;
    this.config = config;
    this.nFrames = meta.nFrames;
    this.width = meta.width;
    this.height = meta.height;
    this.fps = meta.fps;
    this.cache = new Map(); // frame -> Uint8Array luma (LRU by insertion order)
    this.pending = new Map(); // segment -> Promise
    this.chain = Promise.resolve();
    this.decoder = null;
  }

  cached(f) {
    const y = this.cache.get(f);
    if (y) { this.cache.delete(f); this.cache.set(f, y); }
    return y ?? null;
  }

  async getFrame(f) {
    f = Math.max(0, Math.min(this.nFrames - 1, f));
    const hit = this.cached(f);
    if (hit) return hit;
    await this.decodeSegment(this.meta.segOfFrame[f]);
    return this.cache.get(f) ?? null;
  }

  // Decode the segment after f's in the background (smooth playback).
  prefetch(f) {
    const g = this.meta.segOfFrame[Math.min(this.nFrames - 1, f)] + 1;
    if (g < this.meta.segments.length && !this.cache.has(this.meta.segments[g].f0)) {
      this.decodeSegment(g).catch(() => {});
    }
  }

  decodeSegment(g) {
    if (!this.pending.has(g)) {
      const p = this.chain.then(() => this._decode(g));
      this.chain = p.catch(() => {}); // one failed segment must not block the rest
      this.pending.set(g, p);
      p.finally(() => this.pending.delete(g));
    }
    return this.pending.get(g);
  }

  async _decode(g) {
    const seg = this.meta.segments[g];
    if (this.cache.has(seg.f0) && this.cache.has(seg.f1 - 1)) return;
    const { offset, size, isKey, sampleToFrame } = this.meta;
    let lo = Infinity, hi = 0;
    for (let s = seg.s0; s < seg.s1; s++) { lo = Math.min(lo, offset[s]); hi = Math.max(hi, offset[s] + size[s]); }
    const bytes = await this.source.read(lo, hi - lo);

    const copies = [];
    let error = null;
    const decoder = new VideoDecoder({
      output: (frame) => copies.push(this._store(frame)),
      error: (e) => { error = e; },
    });
    decoder.configure(this.config);
    for (let s = seg.s0; s < seg.s1; s++) {
      decoder.decode(new EncodedVideoChunk({
        type: isKey[s] || s === seg.s0 ? "key" : "delta",
        timestamp: sampleToFrame[s], // carried through to the output frame = our frame index
        data: bytes.subarray(offset[s] - lo, offset[s] - lo + size[s]),
      }));
    }
    await decoder.flush();
    decoder.close();
    await Promise.all(copies);
    if (error) throw error;
    // Evict least-recently-used frames, but never this segment's (it can exceed the cap:
    // the rig's hour files have a keyframe only every 250 frames).
    const cap = Math.max(CACHE_FRAMES, seg.f1 - seg.f0);
    for (const k of this.cache.keys()) {
      if (this.cache.size <= cap) break;
      if (k < seg.f0 || k >= seg.f1) this.cache.delete(k);
    }
  }

  async _store(frame) {
    try {
      const rect = frame.visibleRect;
      const w = rect.width, h = rect.height;
      const buf = new Uint8Array(frame.allocationSize({ rect }));
      const layout = await frame.copyTo(buf, { rect });
      const y = new Uint8Array(w * h);
      const fmt = frame.format ?? "";
      if (/^(I4|NV12)/.test(fmt)) {
        const { offset, stride } = layout[0];
        for (let r = 0; r < h; r++) y.set(buf.subarray(offset + r * stride, offset + r * stride + w), r * w);
      } else { // RGBA/BGRA etc.: take the green channel as gray
        const { offset, stride } = layout[0];
        for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) y[r * w + c] = buf[offset + r * stride + c * 4 + 1];
        this.nonLumaFormat = fmt;
      }
      this.cache.set(frame.timestamp, y);
    } finally {
      frame.close();
    }
  }
}

export async function sha1Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
