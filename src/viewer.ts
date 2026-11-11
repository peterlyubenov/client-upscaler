/**
 * Before/after compare viewer with wheel/pinch zoom, drag pan and a draggable
 * split handle. Both layers share one transform; the "before" layer is clipped
 * in screen space so the split stays put while you pan and zoom.
 */
export class Viewer {
  private vp: HTMLElement;
  private beforeWrap: HTMLElement;
  private beforeStage: HTMLElement;
  private afterStage: HTMLElement;
  private handle: HTMLElement;
  private readout: HTMLElement;
  private chips: HTMLElement;
  private empty: HTMLElement;

  private before: HTMLCanvasElement | null = null;
  private after: HTMLCanvasElement | null = null;
  private W = 0;
  private H = 0;
  private z = 1;
  private tx = 0;
  private ty = 0;
  private split = 0.5;
  private fitZ = 1;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { d: number; z: number } | null = null;

  constructor(root: HTMLElement) {
    this.vp = root;
    root.innerHTML = `
      <div class="empty"><div class="empty-in"><div class="empty-big">Before / after</div><div>Add an image to preview it here.<br>After upscaling, drag the handle to compare.</div></div></div>
      <div class="layer after"><div class="stage"></div></div>
      <div class="layer before"><div class="stage"></div></div>
      <div class="chips"><span class="chip">Before</span><span class="chip right">After</span></div>
      <div class="handle" role="slider" tabindex="0" aria-label="Before and after split" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"><div class="grip">↔</div></div>
      <div class="zoombar glass">
        <button data-z="out" aria-label="Zoom out">−</button>
        <span class="mono readout">100%</span>
        <button data-z="in" aria-label="Zoom in">+</button>
        <button data-z="fit" aria-label="Fit to view">Fit</button>
        <button data-z="1" aria-label="Actual pixels, 1 to 1">1:1</button>
      </div>`;
    const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
    this.empty = q('.empty');
    this.beforeWrap = q('.layer.before');
    this.beforeStage = q('.layer.before .stage');
    this.afterStage = q('.layer.after .stage');
    this.handle = q('.handle');
    this.readout = q('.readout');
    this.chips = q('.chips');

    root.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    root.addEventListener('pointerdown', (e) => this.onDown(e));
    root.addEventListener('pointermove', (e) => this.onMove(e));
    root.addEventListener('pointerup', (e) => this.onUp(e));
    root.addEventListener('pointercancel', (e) => this.onUp(e));
    root.addEventListener('dblclick', (e) => {
      if (!(e.target as HTMLElement).closest('.handle, .zoombar')) this.fit();
    });
    this.handle.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowLeft' ? -0.02 : e.key === 'ArrowRight' ? 0.02 : 0;
      if (d) {
        e.preventDefault();
        this.setSplit(this.split + d * (e.shiftKey ? 5 : 1));
      }
    });
    root.querySelector('.zoombar')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      const r = this.vp.getBoundingClientRect();
      const cx = r.width / 2;
      const cy = r.height / 2;
      const k = b.dataset.z;
      if (k === 'in') this.zoomAt(cx, cy, this.z * 1.5);
      else if (k === 'out') this.zoomAt(cx, cy, this.z / 1.5);
      else if (k === 'fit') this.fit();
      else this.zoomAt(cx, cy, 1);
    });
    new ResizeObserver(() => this.onResize()).observe(root);
    this.render();
  }

  /** `before` is shown at the size of `after` (or at its own size when there is no result yet). */
  show(before: HTMLCanvasElement | null, after: HTMLCanvasElement | null) {
    this.before = before;
    this.after = after;
    this.afterStage.replaceChildren();
    this.beforeStage.replaceChildren();
    const ref = after ?? before;
    this.empty.style.display = ref ? 'none' : '';
    if (!ref) {
      this.W = this.H = 0;
      this.render();
      return;
    }
    this.W = ref.width;
    this.H = ref.height;
    if (before) {
      before.style.width = `${this.W}px`;
      before.style.height = `${this.H}px`;
      (after ? this.beforeStage : this.afterStage).appendChild(before);
    }
    if (after) {
      after.style.width = `${this.W}px`;
      after.style.height = `${this.H}px`;
      this.afterStage.appendChild(after);
    }
    for (const s of [this.beforeStage, this.afterStage]) {
      s.style.width = `${this.W}px`;
      s.style.height = `${this.H}px`;
    }
    this.fit();
  }

  private get comparing() {
    return !!(this.before && this.after);
  }

  private vpSize() {
    const r = this.vp.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  private onResize() {
    if (!this.W) return;
    const wasFit = Math.abs(this.z - this.fitZ) < 1e-6;
    this.computeFit();
    if (wasFit) this.fit();
    else this.render();
  }

  private computeFit() {
    const { w, h } = this.vpSize();
    this.fitZ = Math.min((w - 24) / this.W, (h - 24) / this.H);
  }

  fit() {
    if (!this.W) return;
    this.computeFit();
    const { w, h } = this.vpSize();
    this.z = this.fitZ;
    this.tx = (w - this.W * this.z) / 2;
    this.ty = (h - this.H * this.z) / 2;
    this.render();
  }

  private clampZ(z: number) {
    return Math.min(48, Math.max(this.fitZ * 0.5, z));
  }

  private zoomAt(cx: number, cy: number, z: number) {
    if (!this.W) return;
    z = this.clampZ(z);
    const k = z / this.z;
    this.tx = cx - (cx - this.tx) * k;
    this.ty = cy - (cy - this.ty) * k;
    this.z = z;
    this.render();
  }

  private setSplit(p: number) {
    this.split = Math.min(1, Math.max(0, p));
    this.render();
  }

  private onWheel(e: WheelEvent) {
    if ((e.target as HTMLElement).closest('.zoombar')) return;
    e.preventDefault();
    const r = this.vp.getBoundingClientRect();
    const unit = e.deltaMode === 1 ? 16 : 1;
    this.zoomAt(e.clientX - r.left, e.clientY - r.top, this.z * Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0018)));
  }

  private dragging: 'pan' | 'split' | null = null;

  private onDown(e: PointerEvent) {
    const t = e.target as HTMLElement;
    if (t.closest('.zoombar')) return;
    this.vp.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: this.z };
      this.dragging = 'pan';
      return;
    }
    this.dragging = t.closest('.handle') && this.comparing ? 'split' : 'pan';
    if (this.dragging === 'split') this.handle.focus({ preventScroll: true });
    this.vp.classList.toggle('grabbing', this.dragging === 'pan');
  }

  private onMove(e: PointerEvent) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    const r = this.vp.getBoundingClientRect();
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      this.zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, (this.pinch.z * d) / this.pinch.d);
      return;
    }
    if (this.dragging === 'split') this.setSplit((e.clientX - r.left) / r.width);
    else if (this.dragging === 'pan' && this.W) {
      this.tx += dx;
      this.ty += dy;
      this.render();
    }
  }

  private onUp(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (!this.pointers.size) {
      this.dragging = null;
      this.vp.classList.remove('grabbing');
    }
  }

  private render() {
    const tf = `translate(${this.tx}px,${this.ty}px) scale(${this.z})`;
    this.afterStage.style.transform = tf;
    this.beforeStage.style.transform = tf;
    const cmp = this.comparing;
    this.beforeWrap.style.display = cmp ? '' : 'none';
    this.beforeWrap.style.clipPath = `inset(0 ${(1 - this.split) * 100}% 0 0)`;
    this.handle.style.display = cmp ? '' : 'none';
    this.handle.style.left = `${this.split * 100}%`;
    this.handle.setAttribute('aria-valuenow', String(Math.round(this.split * 100)));
    this.chips.style.display = cmp ? '' : 'none';
    // Crisp, un-interpolated pixels once zoomed past ~1.5 screen px per source pixel.
    const crisp = (c: HTMLCanvasElement | null, k: number) => {
      if (c) c.style.imageRendering = this.z * k > 1.5 ? 'pixelated' : 'auto';
    };
    crisp(this.after, 1);
    crisp(this.before, this.before && this.W ? this.W / this.before.width : 1);
    this.readout.textContent = this.W ? `${Math.round(this.z * 100)}%` : '–';
  }
}
