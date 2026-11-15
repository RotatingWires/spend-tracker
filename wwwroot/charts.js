/** The page font (Tahoma, or Good Old DOS with View → Use Retro Font) for text drawn on charts. */
import { el } from './app.js';

const chartFont = () => getComputedStyle(document.documentElement).getPropertyValue('--ui-font').trim() || 'Tahoma, Arial, sans-serif';

/*
 * Minimal canvas bar chart with hover/tap tooltips. Several series stack into one bar per day or month, each section
 * in its own theme color (--chart-series-1 to -8); negative values stack below the zero line. Money series use the
 * left axis. Counts cannot share that scale, so when both are shown counts stack in a second, narrower bar beside it,
 * on the right axis. A line chart draws running totals and balances, one line per series, dashed ones for comparisons.
 */

export const Charts = (() => {
  let tooltip = null;

  function themeColor(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function hideTooltip() {
    if (tooltip) tooltip.hidden = true;
  }

  /** lines: [{ text, series, strong }]. A line with a series color index gets that series' color square. */
  function showTooltip(lines, x, y) {
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'chart-tooltip';
      tooltip.setAttribute('role', 'status');
      document.body.append(tooltip);
    }
    tooltip.replaceChildren(...lines.map(line => {
      const row = el('div');
      if (line.strong) row.className = 'chart-tooltip-strong';
      if (line.series != null) {
        const swatch = el('span', `chart-swatch series-${line.series}`);
        row.append(swatch);
      }
      row.append(line.text);
      return row;
    }));
    tooltip.hidden = false;
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    // Below the pointer, as in TaskList Stats, or above it near the bottom of the window.
    tooltip.style.left = `${Math.max(10, Math.min(window.innerWidth - width - 10, x - width / 2))}px`;
    tooltip.style.top = `${y + 12 + height + 10 > window.innerHeight ? Math.max(10, y - height - 12) : y + 12}px`;
  }

  /** With onSelect, clicking (or tapping) a bar's or point's column calls it with that index; the pointer shows it. */
  function selectable(canvas, onSelect, indexAt, count) {
    canvas.style.cursor = onSelect ? 'pointer' : '';
    canvas.onclick = onSelect ? event => {
      const index = indexAt(event.clientX - canvas.getBoundingClientRect().left);
      if (index >= 0 && index < count) {
        hideTooltip();
        onSelect(index);
      }
    } : null;
  }

  /** Rounds a raw gridline spacing up to 1, 2, 2.5, or 5 times a power of ten (cents for money, units for counts). */
  function niceStep(rough) {
    if (rough <= 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const factor = [1, 2, 2.5, 5, 10].find(f => f * magnitude >= rough);
    return Math.max(1, Math.round(factor * magnitude));
  }

  /** Gridlines covering zero and every stacked total of the given series: positives added up, and negatives. */
  function scale(seriesList, minimumStep) {
    const slots = seriesList[0]?.values.length ?? 0;
    const sum = (index, keep) => seriesList.reduce((total, series) => total + (keep(series.values[index]) ? series.values[index] : 0), 0);
    const high = Math.max(0, ...Array.from({ length: slots }, (_, index) => sum(index, value => value > 0)));
    const low = Math.min(0, ...Array.from({ length: slots }, (_, index) => sum(index, value => value < 0)));
    const step = Math.max(minimumStep, niceStep((high - low) / 4));
    return { step, max: Math.ceil(high / step) * step || step, min: Math.floor(low / step) * step };
  }

  /**
   * labels: one per bar. titles: tooltip heading per bar. series: [{ label, color (1-8), values, count, format }].
   * Hovering a bar lists every series' value there, the hovered section in bold, then any details lines given for that
   * bar. onSelect(index) opens what a bar stands for.
   */
  function bars(canvas, { labels, titles, series, details = null, onSelect = null }) {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const money = series.filter(s => !s.count);
    const counts = series.filter(s => s.count);
    const rightAxis = money.length > 0 && counts.length > 0;
    const padding = { top: 14, right: rightAxis ? 56 : 12, bottom: 34, left: 70 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const left = scale(money.length ? money : counts, money.length ? 100 : 1);
    const right = rightAxis ? scale(counts, 1) : null;
    if (right && left.min < 0) {
      // Line the count axis's zero up with the money axis's zero, so every bar starts from the same baseline.
      const below = -left.min / left.max;
      right.min = -Math.ceil((right.max * below) / right.step) * right.step;
    }
    const y = (value, axis) => padding.top + plotHeight * (axis.max - value) / (axis.max - axis.min);
    const axisOf = s => (right && s.count ? right : left);

    context.font = `11px ${chartFont()}`;
    context.textBaseline = 'middle';
    context.lineWidth = 1;
    const leftFormat = (money[0] ?? counts[0])?.format ?? String;
    for (let value = left.max; value >= left.min; value -= left.step) {
      const lineY = Math.round(y(value, left)) + 0.5;
      context.strokeStyle = themeColor(value === 0 ? '--chart-axis' : '--chart-grid');
      context.beginPath();
      context.moveTo(padding.left, lineY);
      context.lineTo(width - padding.right, lineY);
      context.stroke();
      context.fillStyle = themeColor('--chart-text');
      context.textAlign = 'right';
      context.fillText(leftFormat(value), padding.left - 6, lineY);
    }
    if (right) {
      context.textAlign = 'left';
      for (let value = right.max; value >= right.min; value -= right.step)
        context.fillText(counts[0].format(value), width - padding.right + 6, Math.round(y(value, right)) + 0.5);
    }

    const slot = labels.length ? plotWidth / labels.length : plotWidth;
    const stacks = right ? [money, counts] : [series];
    const stackWidth = Math.max(2, Math.min(36, (slot * 0.8) / stacks.length));
    // Each drawn section, kept so hovering can find the one under the pointer.
    const sections = [];
    stacks.forEach((stack, stackIndex) => {
      const axis = axisOf(stack[0]);
      labels.forEach((_, index) => {
        const x = padding.left + slot * index + (slot - stackWidth * stacks.length) / 2 + stackWidth * stackIndex;
        let above = 0;
        let below = 0;
        for (const s of stack) {
          const value = s.values[index];
          if (!value) continue;
          const from = value > 0 ? above : below;
          const to = from + value;
          if (value > 0) above = to;
          else below = to;
          const top = y(Math.max(from, to), axis);
          const bottom = y(Math.min(from, to), axis);
          context.fillStyle = themeColor(`--chart-series-${s.color}`);
          context.fillRect(x, top, stackWidth, Math.max(1, bottom - top));
          sections.push({ index, series: s, left: x, right: x + stackWidth, top, bottom });
        }
      });
    });

    const labelEvery = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(plotWidth / 44))));
    context.fillStyle = themeColor('--chart-text');
    context.textAlign = 'center';
    context.textBaseline = 'top';
    labels.forEach((label, index) => {
      if (index % labelEvery === 0) context.fillText(label, padding.left + slot * index + slot / 2, height - padding.bottom + 8);
    });

    context.strokeStyle = themeColor('--chart-axis');
    context.beginPath();
    context.moveTo(padding.left + 0.5, padding.top);
    context.lineTo(padding.left + 0.5, height - padding.bottom);
    context.lineTo(width - padding.right, height - padding.bottom);
    if (right) context.lineTo(width - padding.right + 0.5, padding.top);
    context.stroke();

    canvas.onpointermove = event => {
      const offset = event.clientX - canvas.getBoundingClientRect().left - padding.left;
      const index = Math.floor(offset / slot);
      if (index < 0 || index >= labels.length) {
        hideTooltip();
        return;
      }
      const pointerX = event.clientX - canvas.getBoundingClientRect().left;
      const pointerY = event.clientY - canvas.getBoundingClientRect().top;
      const hovered = sections.find(section => section.index === index && pointerX >= section.left && pointerX <= section.right
        && pointerY >= section.top - 1 && pointerY <= section.bottom + 1)?.series;
      showTooltip([
        { text: titles[index], strong: true },
        ...series.map(s => ({ text: `${s.label}: ${s.format(s.values[index])}`, series: s.color, strong: s === hovered })),
        ...(details?.[index] ?? []).map(text => ({ text }))
      ], event.clientX, event.clientY);
    };
    canvas.onpointerleave = hideTooltip;
    // What the bars show, for screen readers: "Market: $26.00; groceries: $15.00".
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', titles.map((title, index) => `${title}: ${series.map(s => s.format(s.values[index])).join(', ')}`).join('; '));
    selectable(canvas, onSelect, pointerX => Math.floor((pointerX - padding.left) / slot), labels.length);
  }

  /**
   * labels: one per point. titles: tooltip heading per point. series: [{ label, color (1-8), values, format, dashed, count }].
   * A null value leaves a gap, so a period still in progress stops at today while the one it is compared with goes on.
   * As in bars, counts shown together with money get their own axis on the right, and onSelect(index) opens a point.
   */
  function lines(canvas, { labels, titles, series, onSelect = null }) {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const money = series.filter(s => !s.count);
    const counts = series.filter(s => s.count);
    const rightAxis = money.length > 0 && counts.length > 0;
    const padding = { top: 14, right: rightAxis ? 56 : 12, bottom: 34, left: 70 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const range = (list, minimumStep) => {
      const values = list.flatMap(s => s.values.filter(value => value != null));
      const high = Math.max(0, ...values);
      const low = Math.min(0, ...values);
      const step = Math.max(minimumStep, niceStep((high - low) / 4));
      return { step, max: Math.ceil(high / step) * step || step, min: Math.floor(low / step) * step };
    };
    const axis = range(money.length ? money : counts, money.length ? 100 : 1);
    const right = rightAxis ? range(counts, 1) : null;
    if (right && axis.min < 0) right.min = -Math.ceil((right.max * -axis.min / axis.max) / right.step) * right.step;
    const step = axis.step;
    const yOn = (value, scale) => padding.top + plotHeight * (scale.max - value) / (scale.max - scale.min);
    const y = value => yOn(value, axis);
    const slot = labels.length > 1 ? plotWidth / (labels.length - 1) : plotWidth;
    const x = index => padding.left + (labels.length > 1 ? slot * index : plotWidth / 2);

    context.font = `11px ${chartFont()}`;
    context.textBaseline = 'middle';
    context.lineWidth = 1;
    const format = (money[0] ?? counts[0])?.format ?? String;
    if (right) {
      context.fillStyle = themeColor('--chart-text');
      context.textAlign = 'left';
      for (let value = right.max; value >= right.min; value -= right.step)
        context.fillText(counts[0].format(value), width - padding.right + 6, Math.round(yOn(value, right)) + 0.5);
    }
    for (let value = axis.max; value >= axis.min; value -= step) {
      const lineY = Math.round(y(value)) + 0.5;
      context.strokeStyle = themeColor(value === 0 ? '--chart-axis' : '--chart-grid');
      context.beginPath();
      context.moveTo(padding.left, lineY);
      context.lineTo(width - padding.right, lineY);
      context.stroke();
      context.fillStyle = themeColor('--chart-text');
      context.textAlign = 'right';
      context.fillText(format(value), padding.left - 6, lineY);
    }

    for (const s of series) {
      context.strokeStyle = themeColor(`--chart-series-${s.color}`);
      context.lineWidth = 2;
      context.setLineDash(s.dashed ? [6, 4] : []);
      context.beginPath();
      let drawing = false;
      s.values.forEach((value, index) => {
        if (value == null) {
          drawing = false;
          return;
        }
        const pointY = yOn(value, right && s.count ? right : axis);
        if (drawing) context.lineTo(x(index), pointY);
        else context.moveTo(x(index), pointY);
        drawing = true;
      });
      context.stroke();
      // A point with no neighbor (a single month, say) gets a dot, since it has no line to draw.
      context.fillStyle = context.strokeStyle;
      s.values.forEach((value, index) => {
        if (value != null && s.values[index - 1] == null && s.values[index + 1] == null)
          context.fillRect(x(index) - 3, yOn(value, right && s.count ? right : axis) - 3, 6, 6);
      });
    }
    context.setLineDash([]);
    context.lineWidth = 1;

    // Empty labels are skipped, and a label too close to the last one drawn is left out.
    context.fillStyle = themeColor('--chart-text');
    context.textAlign = 'center';
    context.textBaseline = 'top';
    let lastLabelX = -Infinity;
    labels.forEach((label, index) => {
      if (!label || x(index) - lastLabelX < 50) return;
      // Labels at the ends stay inside the canvas instead of being cut off.
      const half = context.measureText(label).width / 2;
      context.fillText(label, Math.min(width - half - 2, Math.max(half + 2, x(index))), height - padding.bottom + 8);
      lastLabelX = x(index);
    });

    context.strokeStyle = themeColor('--chart-axis');
    context.beginPath();
    context.moveTo(padding.left + 0.5, padding.top);
    context.lineTo(padding.left + 0.5, height - padding.bottom);
    context.lineTo(width - padding.right, height - padding.bottom);
    if (right) context.lineTo(width - padding.right + 0.5, padding.top);
    context.stroke();

    canvas.onpointermove = event => {
      const offset = event.clientX - canvas.getBoundingClientRect().left - padding.left;
      const index = labels.length > 1 ? Math.round(offset / slot) : 0;
      if (index < 0 || index >= labels.length) {
        hideTooltip();
        return;
      }
      showTooltip([
        { text: titles[index], strong: true },
        ...series.map(s => ({ text: `${s.label}: ${s.values[index] == null ? '—' : s.format(s.values[index])}`, series: s.color }))
      ], event.clientX, event.clientY);
    };
    canvas.onpointerleave = hideTooltip;
    selectable(canvas, onSelect, pointerX => (labels.length > 1 ? Math.round((pointerX - padding.left) / slot) : 0), labels.length);
  }

  return { bars, lines, hideTooltip };
})();
