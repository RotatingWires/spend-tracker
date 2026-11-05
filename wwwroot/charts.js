'use strict';

/* Minimal canvas bar chart with hover/tap tooltips. Colors come from the theme tokens. */

const Charts = (() => {
  let tooltip = null;

  function themeColor(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function hideTooltip() {
    if (tooltip) tooltip.hidden = true;
  }

  function showTooltip(text, x, y) {
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'chart-tooltip';
      tooltip.setAttribute('role', 'status');
      document.body.append(tooltip);
    }
    tooltip.textContent = text;
    tooltip.hidden = false;
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, x - width / 2))}px`;
    tooltip.style.top = `${y - height - 12 < 8 ? y + 16 : y - height - 12}px`;
  }

  /** Rounds a raw gridline spacing (in cents) up to 1, 2, 2.5, or 5 times a power of ten dollars-and-cents. */
  function niceStep(rough) {
    if (rough <= 0) return 100;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const factor = [1, 2, 2.5, 5, 10].find(f => f * magnitude >= rough);
    return Math.max(1, Math.round(factor * magnitude));
  }

  /** bars: [{ label, value (cents), tooltip }]. Negative values (more refunds than purchases) draw below the zero line. */
  function bar(canvas, bars) {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const padding = { top: 14, right: 12, bottom: 34, left: 70 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const step = niceStep((Math.max(0, ...bars.map(b => b.value)) - Math.min(0, ...bars.map(b => b.value))) / 4);
    const max = Math.ceil(Math.max(0, ...bars.map(b => b.value)) / step) * step || step;
    const min = Math.floor(Math.min(0, ...bars.map(b => b.value)) / step) * step;
    const y = value => padding.top + plotHeight * (max - value) / (max - min);

    context.font = '11px Tahoma, Arial, sans-serif';
    context.textBaseline = 'middle';
    context.fillStyle = themeColor('--chart-text');
    context.lineWidth = 1;
    for (let value = max; value >= min; value -= step) {
      const lineY = Math.round(y(value)) + 0.5;
      context.strokeStyle = themeColor(value === 0 ? '--chart-axis' : '--chart-grid');
      context.beginPath();
      context.moveTo(padding.left, lineY);
      context.lineTo(width - padding.right, lineY);
      context.stroke();
      context.textAlign = 'right';
      context.fillText(formatMoney(Math.round(value)), padding.left - 6, lineY);
    }

    const slot = bars.length ? plotWidth / bars.length : plotWidth;
    const barWidth = Math.max(2, Math.min(36, slot * 0.7));
    const labelEvery = Math.max(1, Math.ceil(bars.length / Math.max(1, Math.floor(plotWidth / 44))));
    context.fillStyle = themeColor('--chart-bar');
    bars.forEach((b, index) => {
      const x = padding.left + slot * index + (slot - barWidth) / 2;
      const top = y(Math.max(0, b.value));
      const bottom = y(Math.min(0, b.value));
      context.fillRect(x, top, barWidth, Math.max(b.value === 0 ? 0 : 1, bottom - top));
    });

    context.fillStyle = themeColor('--chart-text');
    context.textAlign = 'center';
    context.textBaseline = 'top';
    bars.forEach((b, index) => {
      if (index % labelEvery !== 0) return;
      context.fillText(b.label, padding.left + slot * index + slot / 2, height - padding.bottom + 8);
    });

    context.strokeStyle = themeColor('--chart-axis');
    context.beginPath();
    context.moveTo(padding.left + 0.5, padding.top);
    context.lineTo(padding.left + 0.5, height - padding.bottom);
    context.lineTo(width - padding.right, height - padding.bottom);
    context.stroke();

    canvas.onpointermove = event => {
      const rect = canvas.getBoundingClientRect();
      const index = Math.floor((event.clientX - rect.left - padding.left) / slot);
      if (index < 0 || index >= bars.length) {
        hideTooltip();
        return;
      }
      showTooltip(bars[index].tooltip, event.clientX, event.clientY);
    };
    canvas.onpointerleave = hideTooltip;
  }

  return { bar, hideTooltip };
})();
