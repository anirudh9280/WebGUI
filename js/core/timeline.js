// Track timeline: an overview strip of the whole clip, then one lane per track showing where
// it has live instances, plus event markers, "cannot tell" spans and reviewed spans.
// Click seeks, drag selects a range, wheel zooms about the cursor, drag the overview to pan.

import { trackColor } from "./player.js";

const LABEL_W = 110;
const OVERVIEW_H = 16;
const LANE_H = 20;
const EVENTS_H = 16;
const ACTION_COLOR = { swap: "#ce93d8", relabel: "#64b5f6", delete: "#ef5350", instance: "#ffb74d", uncertain: "#fff176" };

export class Timeline {
  constructor(canvas, { onSeek, onSelect, onLane }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    Object.assign(this, { onSeek, onSelect, onLane });
    this.data = null;
    this.frame = 0;
    this.range = null;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.bindMouse();
  }

  // data: {nFrames, lanes: [{track, name, runs}], events, reviewed}
  setData(data) {
    const first = !this.data || this.data.nFrames !== data.nFrames;
    this.data = data;
    if (first) this.v = [0, data.nFrames];
    this.canvas.style.height = `${OVERVIEW_H + 4 + data.lanes.length * LANE_H + EVENTS_H + 22}px`;
    this.resize();
  }

  setFrame(f) {
    this.frame = f;
    const [v0, v1] = this.v ?? [0, 0];
    if (f < v0 || f >= v1) { // keep the playhead in view
      const w = v1 - v0;
      this.v = [Math.max(0, f - w * 0.1), 0];
      this.v[1] = this.v[0] + w;
    }
    this.draw();
  }

  setRange(r) { this.range = r; this.draw(); }

  visible() { return this.v.map(Math.round); }

  resize() {
    const dpr = devicePixelRatio || 1;
    this.canvas.width = Math.max(1, this.canvas.clientWidth * dpr);
    this.canvas.height = Math.max(1, this.canvas.clientHeight * dpr);
    this.dpr = dpr;
    this.draw();
  }

  xOf(f) { const [v0, v1] = this.v; return LABEL_W + ((f - v0) / (v1 - v0)) * (this.cssW() - LABEL_W); }
  fOf(x) { const [v0, v1] = this.v; return v0 + ((x - LABEL_W) / (this.cssW() - LABEL_W)) * (v1 - v0); }
  cssW() { return this.canvas.width / this.dpr; }

  bindMouse() {
    const c = this.canvas;
    const pos = (ev) => { const r = c.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
    const clampF = (f) => Math.max(0, Math.min(this.data.nFrames - 1, Math.floor(f)));
    c.addEventListener("wheel", (ev) => {
      if (!this.data) return;
      ev.preventDefault();
      const [x] = pos(ev);
      const [v0, v1] = this.v;
      if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) { // trackpad sideways = pan
        const df = (ev.deltaX / (this.cssW() - LABEL_W)) * (v1 - v0);
        this.pan(df);
        return;
      }
      const at = x > LABEL_W ? this.fOf(x) : (v0 + v1) / 2;
      const k = Math.exp(ev.deltaY * 0.002);
      const w = Math.max(20, Math.min(this.data.nFrames, (v1 - v0) * k));
      const t = (at - v0) / (v1 - v0);
      this.v = [at - t * w, at - t * w + w];
      this.pan(0);
    }, { passive: false });

    let drag = null;
    c.addEventListener("pointerdown", (ev) => {
      if (!this.data) return;
      const [x, y] = pos(ev);
      c.setPointerCapture(ev.pointerId);
      if (y < OVERVIEW_H + 2) { drag = { kind: "overview" }; this.overviewTo(x); return; }
      if (x < LABEL_W) {
        const lane = this.data.lanes[Math.floor((y - OVERVIEW_H - 4) / LANE_H)];
        if (lane) this.onLane(lane.track, ev);
        return;
      }
      drag = { kind: "range", x0: x, f0: clampF(this.fOf(x)), moved: false };
    });
    c.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      const [x] = pos(ev);
      if (drag.kind === "overview") { this.overviewTo(x); return; }
      if (Math.abs(x - drag.x0) > 4) drag.moved = true;
      if (drag.moved) {
        const f = clampF(this.fOf(x));
        this.onSelect([Math.min(drag.f0, f), Math.max(drag.f0, f) + 1]);
      }
    });
    c.addEventListener("pointerup", () => {
      if (drag?.kind === "range" && !drag.moved) this.onSeek(drag.f0);
      drag = null;
    });
  }

  overviewTo(x) {
    const [v0, v1] = this.v;
    const f = ((x - LABEL_W) / (this.cssW() - LABEL_W)) * this.data.nFrames;
    this.pan(f - (v0 + v1) / 2);
  }

  pan(df) {
    const n = this.data.nFrames;
    let [v0, v1] = this.v;
    const w = v1 - v0;
    v0 = Math.max(0, Math.min(n - w, v0 + df));
    this.v = [v0, v0 + w];
    this.draw();
  }

  draw() {
    const d = this.data;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const W = this.cssW(), H = this.canvas.height / this.dpr;
    ctx.fillStyle = "#1b1b1f";
    ctx.fillRect(0, 0, W, H);
    if (!d) return;
    const [v0, v1] = this.v;
    const plotW = W - LABEL_W;
    const n = d.nFrames;
    const X = (f) => this.xOf(f);
    const clipX = (f) => Math.max(LABEL_W, Math.min(W, X(f)));

    // overview: whole clip, reviewed spans, the visible window
    ctx.fillStyle = "#2a2a30";
    ctx.fillRect(LABEL_W, 0, plotW, OVERVIEW_H);
    ctx.fillStyle = "rgba(102,187,106,0.6)";
    for (const r of d.reviewed) ctx.fillRect(LABEL_W + (r.f0 / n) * plotW, 0, Math.max(1, ((r.f1 - r.f0) / n) * plotW), OVERVIEW_H);
    ctx.strokeStyle = "#ddd";
    ctx.strokeRect(LABEL_W + (v0 / n) * plotW + 0.5, 0.5, Math.max(2, ((v1 - v0) / n) * plotW), OVERVIEW_H - 1);
    ctx.fillStyle = "#fff";
    ctx.fillRect(LABEL_W + (this.frame / n) * plotW, 0, 1, OVERVIEW_H);

    const top = OVERVIEW_H + 4;
    // reviewed spans in the main view
    ctx.fillStyle = "rgba(102,187,106,0.10)";
    for (const r of d.reviewed) if (r.f1 > v0 && r.f0 < v1) ctx.fillRect(clipX(r.f0), top, clipX(r.f1) - clipX(r.f0), d.lanes.length * LANE_H);

    ctx.font = "12px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    d.lanes.forEach((lane, li) => {
      const y = top + li * LANE_H;
      ctx.fillStyle = li % 2 ? "#202026" : "#25252b";
      ctx.fillRect(LABEL_W, y, plotW, LANE_H);
      ctx.fillStyle = lane.selected ? "#3a3a46" : "#1b1b1f";
      ctx.fillRect(0, y, LABEL_W, LANE_H);
      ctx.fillStyle = trackColor(lane.track);
      ctx.fillText(lane.label, 8, y + LANE_H / 2);
      for (const [a, b] of lane.runs) {
        if (b <= v0 || a >= v1) continue;
        const xa = clipX(a), xb = clipX(b);
        ctx.fillRect(xa, y + 4, Math.max(1, xb - xa), LANE_H - 8);
      }
    });

    // uncertain spans hatched across lanes; event ticks on the events row
    const evY = top + d.lanes.length * LANE_H + 2;
    for (const ev of d.events) {
      const action = ev.kind === "uncertain" ? "uncertain" : ev.kind === "instance" ? "instance" : ev.action;
      const f0 = ev.kind === "instance" ? ev.f : ev.f0;
      const f1 = ev.kind === "instance" ? ev.f + 1 : ev.f1 ?? n;
      if (f1 <= v0 || f0 >= v1) continue;
      ctx.fillStyle = ACTION_COLOR[action] ?? "#ccc";
      if (ev.kind === "uncertain") {
        ctx.globalAlpha = 0.18;
        ctx.fillRect(clipX(f0), top, clipX(f1) - clipX(f0), d.lanes.length * LANE_H);
        ctx.globalAlpha = 1;
        ctx.fillRect(clipX(f0), evY + EVENTS_H - 4, Math.max(2, clipX(f1) - clipX(f0)), 3);
      } else {
        if (f0 >= v0) ctx.fillRect(X(f0) - 1, evY, 3, EVENTS_H - 2);
        if (ev.kind === "map" && ev.f1 != null && ev.f1 < v1) { ctx.globalAlpha = 0.5; ctx.fillRect(X(ev.f1) - 1, evY, 2, EVENTS_H - 2); ctx.globalAlpha = 1; }
      }
    }
    ctx.fillStyle = "#888";
    ctx.fillText("events", 8, evY + EVENTS_H / 2);

    // selection range and playhead
    const bottom = evY + EVENTS_H;
    if (this.range) {
      const [a, b] = this.range;
      if (b > v0 && a < v1) {
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.fillRect(clipX(a), top, clipX(b) - clipX(a), bottom - top);
        ctx.strokeStyle = "rgba(255,255,255,0.6)";
        ctx.strokeRect(clipX(a) + 0.5, top + 0.5, clipX(b) - clipX(a) - 1, bottom - top - 1);
      }
    }
    if (this.frame >= v0 && this.frame < v1) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(X(this.frame), top, 1.5, bottom - top);
    }
    // frame ticks
    ctx.fillStyle = "#777";
    ctx.textBaseline = "top";
    const fps = d.fps || 50;
    const step = [1, 5, 10, 25, 50, 250, 500, 1500, 3000, 15000, 30000, 90000].find((s) => (s / (v1 - v0)) * plotW > 70) ?? 180000;
    for (let f = Math.ceil(v0 / step) * step; f < v1; f += step) {
      const x = X(f);
      ctx.fillRect(x, bottom, 1, 4);
      const t = f / fps;
      ctx.fillText(step >= fps ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}` : `${f}`, x + 2, bottom);
    }
  }
}
