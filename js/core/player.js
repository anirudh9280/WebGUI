// Video canvas: a gray frame plus skeletons coloured by (corrected) track.
// Wheel zooms about the cursor, drag pans, click picks the nearest animal.

const PALETTE = ["#4fc3f7", "#ff8a65", "#aed581", "#ba68c8", "#ffd54f", "#f06292", "#4db6ac", "#9575cd", "#e57373"];
export const trackColor = (t) => (t < 0 ? "#b0b0b0" : PALETTE[t % PALETTE.length]);

export class Player {
  constructor(canvas, { onPick }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onPick = onPick;
    this.view = null; // {s, tx, ty}: screen = video * s + t
    this.lut = new Uint8Array(256).map((_, i) => i);
    this.last = null;
    this.frameCanvas = document.createElement("canvas");
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.bindMouse();
  }

  setVideo(w, h) {
    this.w = w;
    this.h = h;
    this.frameCanvas.width = w;
    this.frameCanvas.height = h;
    this.fctx = this.frameCanvas.getContext("2d");
    this.image = this.fctx.createImageData(w, h);
    this.lastY = null;
    this.fit();
  }

  setLevels(black, white) {
    const span = Math.max(1, white - black);
    this.lut = new Uint8Array(256).map((_, i) => Math.max(0, Math.min(255, Math.round(((i - black) * 255) / span))));
    this.lastY = null;
    this.redraw();
  }

  resize() {
    const dpr = devicePixelRatio || 1;
    const { clientWidth: cw, clientHeight: ch } = this.canvas;
    this.canvas.width = Math.max(1, cw * dpr);
    this.canvas.height = Math.max(1, ch * dpr);
    if (this.w) this.fit();
  }

  fit() {
    if (!this.w) return;
    const s = Math.min(this.canvas.width / this.w, this.canvas.height / this.h);
    this.view = { s, tx: (this.canvas.width - this.w * s) / 2, ty: (this.canvas.height - this.h * s) / 2 };
    this.redraw();
  }

  toVideo(ev) {
    const r = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / r.width;
    const sx = (ev.clientX - r.left) * dpr, sy = (ev.clientY - r.top) * dpr;
    return [(sx - this.view.tx) / this.view.s, (sy - this.view.ty) / this.view.s, sx, sy];
  }

  bindMouse() {
    const c = this.canvas;
    c.addEventListener("wheel", (ev) => {
      if (!this.view) return;
      ev.preventDefault();
      const [, , sx, sy] = this.toVideo(ev);
      const k = Math.exp(-ev.deltaY * 0.0015);
      const v = this.view;
      v.tx = sx - (sx - v.tx) * k;
      v.ty = sy - (sy - v.ty) * k;
      v.s *= k;
      this.redraw();
    }, { passive: false });
    let drag = null;
    c.addEventListener("pointerdown", (ev) => {
      if (!this.view) return;
      drag = { x: ev.clientX, y: ev.clientY, tx: this.view.tx, ty: this.view.ty, moved: false };
      c.setPointerCapture(ev.pointerId);
    });
    c.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      const dpr = this.canvas.width / this.canvas.getBoundingClientRect().width;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      if (drag.moved) {
        this.view.tx = drag.tx + dx * dpr;
        this.view.ty = drag.ty + dy * dpr;
        this.redraw();
      }
    });
    c.addEventListener("pointerup", (ev) => {
      if (drag && !drag.moved) this.pick(ev);
      drag = null;
    });
    c.addEventListener("dblclick", () => this.fit());
  }

  pick(ev) {
    if (!this.last) return;
    const [x, y] = this.toVideo(ev);
    const radius = 40 / Math.max(this.view.s, 0.25) + 20;
    let best = null, bestD = Infinity;
    for (const inst of this.last.instances) {
      if (inst.deleted && !this.last.showDeleted) continue;
      for (let n = 0; n < inst.pts.length / 2; n++) {
        const px = inst.pts[2 * n], py = inst.pts[2 * n + 1];
        if (Number.isNaN(px)) continue;
        const d = Math.hypot(px - x, py - y);
        if (d < bestD) { bestD = d; best = inst; }
      }
    }
    this.onPick(bestD < radius ? best : null, ev);
  }

  // state: {y, instances: [{k, i, pts, track, deleted, selected}], edges, showPoses, showDeleted, name(t)}
  draw(state) {
    this.last = state;
    this.redraw();
  }

  redraw() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const st = this.last;
    if (!st || !this.view) return;
    if (st.y && st.y !== this.lastY) {
      const d = this.image.data, y = st.y, lut = this.lut;
      for (let i = 0, j = 0; i < y.length; i++, j += 4) {
        const g = lut[y[i]];
        d[j] = d[j + 1] = d[j + 2] = g;
        d[j + 3] = 255;
      }
      this.fctx.putImageData(this.image, 0, 0);
      this.lastY = st.y;
    }
    const { s, tx, ty } = this.view;
    ctx.setTransform(s, 0, 0, s, tx, ty);
    ctx.imageSmoothingEnabled = s < 1;
    if (st.y) ctx.drawImage(this.frameCanvas, 0, 0);
    if (!st.showPoses) return;
    const lw = 2 / s;
    for (const inst of st.instances) {
      if (inst.deleted && !st.showDeleted) continue;
      const color = inst.deleted ? "#777" : trackColor(inst.track);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = inst.selected ? lw * 2 : lw;
      ctx.setLineDash(inst.deleted ? [6 / s, 4 / s] : []);
      const p = inst.pts;
      ctx.beginPath();
      for (const [a, b] of st.edges) {
        if (Number.isNaN(p[2 * a]) || Number.isNaN(p[2 * b])) continue;
        ctx.moveTo(p[2 * a], p[2 * a + 1]);
        ctx.lineTo(p[2 * b], p[2 * b + 1]);
      }
      ctx.stroke();
      let cx = 0, cy = 0, m = 0;
      for (let n = 0; n < p.length / 2; n++) {
        if (Number.isNaN(p[2 * n])) continue;
        ctx.beginPath();
        ctx.arc(p[2 * n], p[2 * n + 1], (inst.selected ? 4 : 2.5) / s, 0, 2 * Math.PI);
        ctx.fill();
        cx += p[2 * n]; cy += p[2 * n + 1]; m++;
      }
      if (m) {
        ctx.setLineDash([]);
        ctx.font = `${13 / s}px system-ui, sans-serif`;
        const label = inst.deleted ? "deleted" : st.name(inst.track);
        ctx.lineWidth = 3 / s;
        ctx.strokeStyle = "rgba(0,0,0,0.8)";
        ctx.strokeText(label, cx / m + 8 / s, cy / m - 8 / s);
        ctx.fillText(label, cx / m + 8 / s, cy / m - 8 / s);
      }
    }
    ctx.setLineDash([]);
  }
}
