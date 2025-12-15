/**
 * charts.js - Minimal canvas-based charts (no external dependencies)
 * Provides simple, responsive line and bar charts
 */

/**
 * Render a line chart on a canvas element
 * @param {HTMLCanvasElement} canvas - Canvas element to draw on
 * @param {Object} options - Chart options
 * @param {string} options.title - Chart title
 * @param {Array} options.points - Data points array
 * @param {string} options.xKey - Key for x-axis values
 * @param {string} options.yKey - Key for y-axis values
 * @param {string} options.yLabel - Label for y-axis
 * @param {Function} options.formatY - Function to format y-axis values
 */
export function renderLineChart(canvas, { title, points, xKey, yKey, yLabel, formatY }) {
  if (!canvas || !canvas.getContext) {
    console.error('Invalid canvas element');
    return;
  }

  const ctx = canvas.getContext('2d');
  
  // Set up responsive resizing
  const resizeObserver = new ResizeObserver(() => {
    drawLineChart(canvas, ctx, { title, points, xKey, yKey, yLabel, formatY });
  });
  resizeObserver.observe(canvas.parentElement);
  
  // Store observer for cleanup
  if (!canvas._resizeObserver) {
    canvas._resizeObserver = resizeObserver;
  }
  
  // Initial draw
  drawLineChart(canvas, ctx, { title, points, xKey, yKey, yLabel, formatY });
}

/**
 * Render a bar chart on a canvas element
 * @param {HTMLCanvasElement} canvas - Canvas element to draw on
 * @param {Object} options - Chart options
 * @param {string} options.title - Chart title
 * @param {Array} options.bars - Data bars array
 * @param {string} options.labelKey - Key for bar labels
 * @param {string} options.valueKey - Key for bar values
 * @param {Function} options.formatValue - Function to format values
 */
export function renderBarChart(canvas, { title, bars, labelKey, valueKey, formatValue }) {
  if (!canvas || !canvas.getContext) {
    console.error('Invalid canvas element');
    return;
  }

  const ctx = canvas.getContext('2d');
  
  // Set up responsive resizing
  const resizeObserver = new ResizeObserver(() => {
    drawBarChart(canvas, ctx, { title, bars, labelKey, valueKey, formatValue });
  });
  resizeObserver.observe(canvas.parentElement);
  
  // Store observer for cleanup
  if (!canvas._resizeObserver) {
    canvas._resizeObserver = resizeObserver;
  }
  
  // Initial draw
  drawBarChart(canvas, ctx, { title, bars, labelKey, valueKey, formatValue });
}

/**
 * Internal: Draw line chart
 */
function drawLineChart(canvas, ctx, { title, points, xKey, yKey, yLabel, formatY }) {
  // Match container width
  const parent = canvas.parentElement;
  const width = parent.clientWidth;
  const height = 300; // Fixed height for consistency
  
  // Set canvas size (accounting for device pixel ratio for crisp rendering)
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.scale(dpr, dpr);
  
  // Clear canvas
  ctx.clearRect(0, 0, width, height);
  
  // Handle empty data
  if (!points || points.length === 0) {
    ctx.fillStyle = '#666';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data available', width / 2, height / 2);
    return;
  }
  
  // Chart margins
  const margin = { top: 40, right: 20, bottom: 40, left: 60 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  
  // Draw title
  ctx.fillStyle = '#333';
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(title, width / 2, 20);
  
  // Extract and filter valid points
  const validPoints = points
    .map(p => ({ x: p[xKey], y: p[yKey] }))
    .filter(p => p.y !== null && p.y !== undefined && !isNaN(p.y));
  
  if (validPoints.length === 0) {
    ctx.fillStyle = '#666';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No valid data points', width / 2, height / 2);
    return;
  }
  
  // Find min/max for scaling
  const yValues = validPoints.map(p => p.y);
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);
  const yRange = yMax - yMin || 1;
  const yPadding = yRange * 0.1; // 10% padding
  
  // Scale functions
  const xScale = (index) => margin.left + (index / Math.max(1, validPoints.length - 1)) * chartWidth;
  const yScale = (value) => margin.top + chartHeight - ((value - yMin + yPadding) / (yRange + 2 * yPadding)) * chartHeight;
  
  // Draw axes
  ctx.strokeStyle = '#999';
  ctx.lineWidth = 1;
  
  // Y-axis
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, height - margin.bottom);
  ctx.stroke();
  
  // X-axis
  ctx.beginPath();
  ctx.moveTo(margin.left, height - margin.bottom);
  ctx.lineTo(width - margin.right, height - margin.bottom);
  ctx.stroke();
  
  // Draw Y-axis ticks and labels
  ctx.fillStyle = '#666';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const value = yMin - yPadding + (i / yTicks) * (yRange + 2 * yPadding);
    const y = yScale(value);
    
    // Tick mark
    ctx.beginPath();
    ctx.moveTo(margin.left - 5, y);
    ctx.lineTo(margin.left, y);
    ctx.stroke();
    
    // Label
    const label = formatY ? formatY(value) : value.toFixed(2);
    ctx.fillText(label, margin.left - 10, y + 4);
  }
  
  // Draw Y-axis label
  ctx.save();
  ctx.translate(15, height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#333';
  ctx.font = '12px sans-serif';
  ctx.fillText(yLabel || '', 0, 0);
  ctx.restore();
  
  // Draw X-axis labels (show first, middle, last)
  ctx.textAlign = 'center';
  const labelIndices = validPoints.length > 2 
    ? [0, Math.floor(validPoints.length / 2), validPoints.length - 1]
    : validPoints.map((_, i) => i);
  
  labelIndices.forEach(i => {
    const x = xScale(i);
    const label = String(validPoints[i].x);
    ctx.fillText(label, x, height - margin.bottom + 20);
  });
  
  // Draw line
  ctx.strokeStyle = '#4a90e2';
  ctx.lineWidth = 2;
  ctx.beginPath();
  validPoints.forEach((point, i) => {
    const x = xScale(i);
    const y = yScale(point.y);
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
  
  // Draw points
  ctx.fillStyle = '#4a90e2';
  validPoints.forEach((point, i) => {
    const x = xScale(i);
    const y = yScale(point.y);
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, 2 * Math.PI);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  });
}

/**
 * Internal: Draw bar chart
 */
function drawBarChart(canvas, ctx, { title, bars, labelKey, valueKey, formatValue }) {
  // Match container width
  const parent = canvas.parentElement;
  const width = parent.clientWidth;
  const height = 300; // Fixed height for consistency
  
  // Set canvas size (accounting for device pixel ratio)
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.scale(dpr, dpr);
  
  // Clear canvas
  ctx.clearRect(0, 0, width, height);
  
  // Handle empty data
  if (!bars || bars.length === 0) {
    ctx.fillStyle = '#666';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data available', width / 2, height / 2);
    return;
  }
  
  // Chart margins
  const margin = { top: 40, right: 20, bottom: 60, left: 60 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  
  // Draw title
  ctx.fillStyle = '#333';
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(title, width / 2, 20);
  
  // Extract and filter valid bars
  const validBars = bars
    .map(b => ({ label: b[labelKey], value: b[valueKey] }))
    .filter(b => b.value !== null && b.value !== undefined && !isNaN(b.value));
  
  if (validBars.length === 0) {
    ctx.fillStyle = '#666';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No valid data', width / 2, height / 2);
    return;
  }
  
  // Find max value for scaling
  const maxValue = Math.max(...validBars.map(b => b.value));
  const valuePadding = maxValue * 0.1;
  
  // Scale function
  const yScale = (value) => (value / (maxValue + valuePadding)) * chartHeight;
  
  // Draw axes
  ctx.strokeStyle = '#999';
  ctx.lineWidth = 1;
  
  // Y-axis
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, height - margin.bottom);
  ctx.stroke();
  
  // X-axis
  ctx.beginPath();
  ctx.moveTo(margin.left, height - margin.bottom);
  ctx.lineTo(width - margin.right, height - margin.bottom);
  ctx.stroke();
  
  // Draw Y-axis ticks and labels
  ctx.fillStyle = '#666';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const value = (i / yTicks) * (maxValue + valuePadding);
    const y = height - margin.bottom - yScale(value);
    
    // Tick mark
    ctx.strokeStyle = '#999';
    ctx.beginPath();
    ctx.moveTo(margin.left - 5, y);
    ctx.lineTo(margin.left, y);
    ctx.stroke();
    
    // Label
    const label = formatValue ? formatValue(value) : value.toFixed(0);
    ctx.fillText(label, margin.left - 10, y + 4);
  }
  
  // Calculate bar width and spacing
  const barSpacing = 10;
  const barWidth = Math.max(20, (chartWidth - (validBars.length - 1) * barSpacing) / validBars.length);
  
  // Draw bars
  validBars.forEach((bar, i) => {
    const x = margin.left + i * (barWidth + barSpacing);
    const barHeight = yScale(bar.value);
    const y = height - margin.bottom - barHeight;
    
    // Bar
    ctx.fillStyle = '#4a90e2';
    ctx.fillRect(x, y, barWidth, barHeight);
    
    // Bar border
    ctx.strokeStyle = '#357abd';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, barWidth, barHeight);
    
    // Value label on top of bar
    ctx.fillStyle = '#333';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    const valueLabel = formatValue ? formatValue(bar.value) : bar.value.toFixed(1);
    ctx.fillText(valueLabel, x + barWidth / 2, y - 5);
    
    // X-axis label
    ctx.save();
    ctx.translate(x + barWidth / 2, height - margin.bottom + 15);
    ctx.rotate(-Math.PI / 4);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#666';
    ctx.font = '11px sans-serif';
    const label = String(bar.label);
    const truncated = label.length > 15 ? label.substring(0, 15) + '...' : label;
    ctx.fillText(truncated, 0, 0);
    ctx.restore();
  });
}
