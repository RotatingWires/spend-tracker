'use strict';

/*
 * Minimal canvas bar chart with hover/tap tooltips. Several series draw as grouped bars, each in its own theme color
 * (--chart-series-1 to -8). Money series use the left axis; counts use the right one when money is shown too.
 */

const Charts = (() => {
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
      const row = document.createElement('div');
      if (line.strong) row.className = 'chart-tooltip-strong';
      if (line.series != null) {
        const swatch = document.createElement('span');
        swatch.className = `chart-swatch series-${line.series}`;
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

  /** Rounds a raw gridline spacing up to 1, 2, 2.5, or 5 times a power of ten (cents for money, units for counts). */
  function niceStep(rough) {
    if (rough <= 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const factor = [1, 2, 2.5, 5, 10].find(f => f * magnitude >= rough);
    return Math.max(1, Math.round(factor * magnitude));
  }

  /** Gridlines covering every value of the given series and zero. */
  function scale(seriesList, minimumStep) {
    const values = seriesList.flatMap(series => series.values);
    const high = Math.max(0, ...values);
    const low = Math.min(0, ...values);
    const step = Math.max(minimumStep, niceStep((high - low) / 4));
    return { step, max: Math.ceil(high / step) * step || step, min: Math.floor(low / step) * step };
  }

  /**
   * labels: one per bar group. titles: tooltip heading per group. series: [{ label, color (1-8), values, count,
   * format }]. Hovering a group lists every series' value there, the hovered bar in bold.
   */
  function bars(canvas, { labels, titles, series }) {
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

    context.font = '11px Tahoma, Arial, sans-serif';
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
    const groupWidth = Math.max(2, Math.min(36 * Math.max(1, series.length), slot * 0.8));
    const barWidth = groupWidth / Math.max(1, series.length);
    series.forEach((s, seriesIndex) => {
      const axis = axisOf(s);
      context.fillStyle = themeColor(`--chart-series-${s.color}`);
      s.values.forEach((value, index) => {
        const x = padding.left + slot * index + (slot - groupWidth) / 2 + barWidth * seriesIndex;
        const top = y(Math.max(0, value), axis);
        const bottom = y(Math.min(0, value), axis);
        context.fillRect(x, top, Math.max(1, barWidth - (series.length > 1 ? 1 : 0)), Math.max(value === 0 ? 0 : 1, bottom - top));
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
      const hovered = Math.floor((offset - slot * index - (slot - groupWidth) / 2) / barWidth);
      showTooltip([
        { text: titles[index], strong: true },
        ...series.map((s, seriesIndex) => ({ text: `${s.label}: ${s.format(s.values[index])}`, series: s.color, strong: seriesIndex === hovered }))
      ], event.clientX, event.clientY);
    };
    canvas.onpointerleave = hideTooltip;
  }

  return { bars, hideTooltip };
})();
