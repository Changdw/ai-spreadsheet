import { t } from './i18n';
export type ColorProperty = 'color' | 'background';
type Paint = string | null;

const themeRows = [
  'FFFFFF 000000 E7E6E6 44546A 4472C4 ED7D31 A5A5A5 FFC000 5B9BD5 70AD47',
  'F2F2F2 7F7F7F D0CECE D6DCE4 D9E2F3 FBE5D6 EDEDED FFF2CC DEEBF7 E2EFDA',
  'D9D9D9 595959 AEAAAA ADB9CA B4C6E7 F8CBAD DBDBDB FFE699 BDD7EE C6E0B4',
  'BFBFBF 404040 757171 8497B0 8EA9DB F4B183 C9C9C9 FFD966 9DC3E6 A9D18E',
  'A6A6A6 262626 3A3838 333F50 2F5597 C55A11 7B7B7B BF9000 2E75B6 548235',
  '808080 0D0D0D 161616 222A35 203864 843C0C 525252 806000 1F4E78 375623',
];
const standard = 'C00000 FF0000 FFC000 FFFF00 92D050 00B050 00B0F0 0070C0 002060 7030A0';
const names = { color: 'fontColor', background: 'fillColor' } as const;
const defaults = { color: 'automatic', background: 'noFill' } as const;

export function createColorPalette(apply: (property: ColorProperty, color: Paint) => void) {
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const panel = el('colorPalette'),
    reset = el<HTMLButtonElement>('colorDefault');
  const custom = el<HTMLInputElement>('customColor');
  const current: Record<ColorProperty, Paint> = { color: null, background: null };
  const last: Record<ColorProperty, Paint> = { color: '#FF0000', background: '#FFFF00' };
  let property: ColorProperty = 'color';
  let recent: string[] = [];

  function updateButtons(key: ColorProperty) {
    const tool = el(key + 'Tool'),
      menu = el(key + 'Menu');
    tool.style.setProperty('--apply-color', last[key] ?? 'transparent');
    tool.style.setProperty('--current-color', current[key] ?? 'transparent');
    tool.classList.toggle('default-current', current[key] === null);
    tool.classList.toggle('default-apply', last[key] === null);
    el(key).title = t('applyColorHint', {
      action: t(key === 'color' ? 'applyFontColor' : 'applyFill'),
      color: last[key] ?? t(defaults[key]),
    });
    menu.title = t('pickColorHint', {
      action: t(key === 'color' ? 'chooseFontColor' : 'chooseFill'),
      color: current[key] ?? t(defaults[key]),
    });
  }
  function swatches(host: HTMLElement, colors: string[]) {
    host.replaceChildren(
      ...colors.map((color) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'swatch';
        b.dataset.color = color;
        b.style.backgroundColor = color;
        b.title = color;
        b.setAttribute('aria-label', color);
        return b;
      }),
    );
  }
  const hex = (row: string) => row.split(' ').map((s) => '#' + s);
  swatches(el('themeSwatches'), themeRows.flatMap(hex));
  swatches(el('standardSwatches'), hex(standard));

  function markCurrent() {
    reset.textContent = t(defaults[property]);
    reset.setAttribute('aria-pressed', String(!current[property]));
    for (const b of panel.querySelectorAll<HTMLButtonElement>('.swatch'))
      b.setAttribute('aria-pressed', String(b.dataset.color === current[property]));
    custom.value = current[property] ?? last[property] ?? '#000000';
  }
  function choose(color: Paint) {
    if (color) recent = [color, ...recent.filter((c) => c !== color)].slice(0, 10);
    last[property] = color;
    updateButtons(property);
    panel.hidePopover();
    el(property + 'Menu').focus({ preventScroll: true });
    apply(property, color);
  }
  for (const key of ['color', 'background'] as const) {
    const menu = el<HTMLButtonElement>(key + 'Menu');
    menu.popoverTargetElement = panel;
    menu.setAttribute('aria-controls', panel.id);
    updateButtons(key);
    el(key).onclick = () => apply(key, last[key]);
    menu.onclick = (event) => {
      event.preventDefault();
      if (panel.matches(':popover-open') && property === key) {
        panel.hidePopover();
        return;
      }
      property = key;
      panel.setAttribute('aria-label', t(names[key]));
      el('recentColors').hidden = recent.length === 0;
      swatches(el('recentSwatches'), recent);
      markCurrent();
      panel.showPopover({ source: menu });
      const rect = el(key + 'Tool').getBoundingClientRect();
      panel.style.left =
        Math.max(4, Math.min(rect.left, innerWidth - panel.offsetWidth - 4)) + 'px';
      panel.style.top =
        (rect.bottom + panel.offsetHeight < innerHeight
          ? rect.bottom + 3
          : Math.max(4, rect.top - panel.offsetHeight - 3)) + 'px';
      for (const k of ['color', 'background'])
        el(k + 'Menu').setAttribute('aria-expanded', String(k === key));
      (panel.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? reset).focus({
        preventScroll: true,
      });
    };
  }
  panel.addEventListener('toggle', () => {
    if (!panel.matches(':popover-open'))
      for (const k of ['color', 'background'])
        el(k + 'Menu').setAttribute('aria-expanded', 'false');
  });
  panel.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (b === reset) choose(null);
    else if (b?.dataset.color) choose(b.dataset.color);
  });
  panel.addEventListener('keydown', (e) => {
    const offset: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -10,
      ArrowDown: 10,
    };
    if (!(e.key in offset)) return;
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.offsetWidth,
    );
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, i + offset[e.key]))].focus();
  });
  custom.onchange = () => choose(custom.value.toUpperCase());
  function sync(key: ColorProperty, value?: string | null) {
    const color = value?.toUpperCase() ?? null;
    if (current[key] === color) return;
    current[key] = color;
    updateButtons(key);
    if (key === property && panel.matches(':popover-open')) markCurrent();
  }
  function translate() {
    updateButtons('color');
    updateButtons('background');
    if (panel.matches(':popover-open')) {
      panel.setAttribute('aria-label', t(names[property]));
      markCurrent();
    }
  }
  return { sync, translate };
}
