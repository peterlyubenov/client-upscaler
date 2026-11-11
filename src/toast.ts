const host = () => document.getElementById('toasts')!;

export interface Toast {
  el: HTMLElement;
  update(o: { title?: string; sub?: string; pct?: number }): void;
  close(): void;
}

interface Opts {
  kind: 'busy' | 'done' | 'fail';
  title: string;
  sub?: string;
  pct?: number;
  actions?: { label: string; run: () => void }[];
  autoClose?: number;
}


export function toast(o: Opts): Toast {
  const el = document.createElement('div');
  el.className = `glass strong toast${o.kind === 'fail' ? ' fail' : ''}`;
  el.setAttribute('role', o.kind === 'fail' ? 'alert' : 'status');
  const icon = o.kind === 'busy' ? '<span class="spin" aria-hidden="true"></span>' : o.kind === 'done' ? '<span class="ok" aria-hidden="true">✓</span>' : '<span class="bad" aria-hidden="true">✕</span>';
  el.innerHTML = `<div class="t-row">${icon}<span class="t-title"></span></div><div class="t-sub"></div>${o.pct !== undefined ? '<div class="bar"><div></div></div>' : ''}<div class="t-act"></div>`;
  const title = el.querySelector('.t-title') as HTMLElement;
  const sub = el.querySelector('.t-sub') as HTMLElement;
  const fill = el.querySelector('.bar > div') as HTMLElement | null;
  const act = el.querySelector('.t-act') as HTMLElement;
  title.textContent = o.title;
  sub.textContent = o.sub ?? '';
  sub.hidden = !o.sub;
  if (fill) fill.style.width = `${(o.pct ?? 0) * 100}%`;
  let timer = 0;
  const t: Toast = {
    el,
    update(u) {
      if (u.title !== undefined) title.textContent = u.title;
      if (u.sub !== undefined) {
        sub.textContent = u.sub;
        sub.hidden = !u.sub;
      }
      if (u.pct !== undefined && fill) fill.style.width = `${Math.min(1, Math.max(0, u.pct)) * 100}%`;
    },
    close() {
      clearTimeout(timer);
      el.remove();
    },
  };
  for (const a of o.actions ?? []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = a.label;
    b.onclick = () => a.run();
    act.appendChild(b);
  }
  act.hidden = !o.actions?.length;
  if (o.kind !== 'busy') {
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Dismiss';
    dismiss.onclick = () => t.close();
    act.appendChild(dismiss);
    act.hidden = false;
  }
  if (o.autoClose) timer = window.setTimeout(() => t.close(), o.autoClose);
  host().appendChild(el);
  return t;
}
