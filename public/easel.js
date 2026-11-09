const HISTORY_LIMIT = 40;

export class Easel {
  tool = 'pen';
  color = '#111111';
  widths = { pen: 8, eraser: 48 };
  locked = false;
  drawing = false;

  #history = [];
  #index = 0;
  #pointerId = null;
  #rect = null;
  #scale = 1;
  #last = null;
  #mid = null;
  #width = 0;
  #erasing = false;
  #pending = 0;
  #paintId = 0;
  #penSeenAt = 0;

  constructor({ canvas, brush, onChange, onHistory }) {
    this.canvas = canvas;
    this.brush = brush;
    this.onChange = onChange;
    this.onHistory = onHistory;
    this.ctx = canvas.getContext('2d');
    this.blank = canvas.toDataURL('image/png');
    this.#history = [this.blank];

    canvas.addEventListener('pointerdown', (e) => this.#down(e));
    canvas.addEventListener('pointermove', (e) => this.#move(e));
    canvas.addEventListener('pointerup', (e) => this.#up(e));
    canvas.addEventListener('pointercancel', (e) => this.#up(e));
    canvas.addEventListener('pointerleave', () => {
      if (!this.drawing) brush.hidden = true;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get width() {
    return this.widths[this.tool];
  }

  set width(value) {
    this.widths[this.tool] = value;
  }

  get canUndo() {
    return !this.locked && this.#index > 0;
  }

  get canRedo() {
    return !this.locked && this.#index < this.#history.length - 1;
  }

  get current() {
    return this.#history[this.#index];
  }

  setLocked(locked) {
    if (locked === this.locked) return;
    this.locked = locked;
    this.canvas.classList.toggle('ready', !locked);
    if (locked) {
      this.brush.hidden = true;
      if (this.drawing) {
        this.drawing = false;
        this.#pointerId = null;
        this.#paint(this.current);
      }
    }
    this.onHistory();
  }

  // 履歴ごと置き換える（入室時、リセット時、サーバーの内容に合わせる時）
  load(url) {
    this.drawing = false;
    this.#pointerId = null;
    this.#history = [url ?? this.blank];
    this.#index = 0;
    this.#paint(this.current);
    this.onHistory();
  }

  clear() {
    if (this.locked || this.drawing || this.#pending) return;
    this.#erase();
    this.#commit();
  }

  undo() {
    if (this.canUndo && !this.drawing) this.#go(this.#index - 1);
  }

  redo() {
    if (this.canRedo && !this.drawing) this.#go(this.#index + 1);
  }

  #go(index) {
    this.#index = index;
    this.#paint(this.current);
    this.onChange(this.current);
    this.onHistory();
  }

  #erase() {
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  async #paint(url) {
    const id = ++this.#paintId;
    this.#pending += 1;
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
      if (id === this.#paintId) {
        this.#erase();
        this.ctx.drawImage(image, 0, 0);
      }
    } finally {
      this.#pending -= 1;
    }
  }

  #commit() {
    const url = this.canvas.toDataURL('image/png');
    this.#history.splice(this.#index + 1);
    this.#history.push(url);
    if (this.#history.length > HISTORY_LIMIT) this.#history.shift();
    this.#index = this.#history.length - 1;
    this.onChange(url);
    this.onHistory();
  }

  #point(e) {
    return {
      x: (e.clientX - this.#rect.left) * this.#scale,
      y: (e.clientY - this.#rect.top) * this.#scale,
    };
  }

  #measure() {
    this.#rect = this.canvas.getBoundingClientRect();
    this.#scale = this.canvas.width / this.#rect.width;
  }

  #targetWidth(e) {
    const base = this.#erasing ? this.widths.eraser : this.widths.pen;
    if (e.pointerType !== 'pen' || this.#erasing) return base;
    return Math.max(1, base * (0.15 + 0.85 * e.pressure));
  }

  #down(e) {
    if (e.pointerType === 'pen') this.#penSeenAt = performance.now();
    // ペン使用中に手のひらが触れても描かない
    if (e.pointerType === 'touch' && performance.now() - this.#penSeenAt < 2000) return;
    const isEraserTip = e.button === 5 || (e.buttons & 32) !== 0;
    if (e.button !== 0 && !isEraserTip) return;
    if (this.locked || this.drawing || this.#pending) return;

    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.#measure();
    this.drawing = true;
    this.#pointerId = e.pointerId;
    this.#erasing = this.tool === 'eraser' || isEraserTip;
    this.#width = this.#targetWidth(e);

    const { ctx } = this;
    ctx.globalCompositeOperation = this.#erasing ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ctx.fillStyle = this.color;
    ctx.lineCap = ctx.lineJoin = 'round';

    const p = this.#point(e);
    this.#last = this.#mid = p;
    ctx.beginPath();
    ctx.arc(p.x, p.y, this.#width / 2, 0, Math.PI * 2);
    ctx.fill();
    this.#showBrush(e);
  }

  #move(e) {
    this.#showBrush(e);
    if (!this.drawing || e.pointerId !== this.#pointerId) return;
    const events = e.getCoalescedEvents?.() ?? [];
    for (const ev of events.length ? events : [e]) this.#segment(ev);
  }

  #segment(e) {
    const { ctx } = this;
    const p = this.#point(e);
    const mid = { x: (this.#last.x + p.x) / 2, y: (this.#last.y + p.y) / 2 };
    this.#width += (this.#targetWidth(e) - this.#width) * 0.4;
    ctx.lineWidth = this.#width;
    ctx.beginPath();
    ctx.moveTo(this.#mid.x, this.#mid.y);
    ctx.quadraticCurveTo(this.#last.x, this.#last.y, mid.x, mid.y);
    ctx.stroke();
    this.#last = p;
    this.#mid = mid;
  }

  #up(e) {
    if (!this.drawing || e.pointerId !== this.#pointerId) return;
    const { ctx } = this;
    ctx.lineWidth = this.#width;
    ctx.beginPath();
    ctx.moveTo(this.#mid.x, this.#mid.y);
    ctx.lineTo(this.#last.x, this.#last.y);
    ctx.stroke();
    this.drawing = false;
    this.#pointerId = null;
    this.#commit();
  }

  #showBrush(e) {
    if (this.locked || e.pointerType === 'touch') return;
    this.#measure();
    const size = (this.drawing && this.#erasing ? this.widths.eraser : this.width) / this.#scale;
    const { brush } = this;
    brush.hidden = false;
    brush.style.width = brush.style.height = `${size}px`;
    brush.style.transform = `translate(${e.clientX - this.#rect.left - size / 2}px, ${e.clientY - this.#rect.top - size / 2}px)`;
  }
}
