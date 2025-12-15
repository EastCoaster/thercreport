/**
 * stats.js - Analytics data aggregation module
 * Provides utilities for processing run log data for analytics
 */

/**
 * Parse a lap time value into a number (seconds)
 * @param {string|number} value - Lap time (e.g., "15.234", 15.234)
 * @returns {number|null} - Parsed lap time in seconds, or null if invalid
 */
export function parseLap(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  
  const num = typeof value === 'string' ? parseFloat(value) : value;
  
  if (isNaN(num) || num <= 0) {
    return null;
  }
  
  return num;
}

/**
 * Check if a date falls within a specified range
 * @param {string} dateStr - Date to check (ISO string)
 * @param {string|null} startStr - Start date (ISO string or null)
 * @param {string|null} endStr - End date (ISO string or null)
 * @returns {boolean} - True if date is within range
 */
export function withinDateRange(dateStr, startStr, endStr) {
  if (!dateStr) return false;
  
  const date = new Date(dateStr);
  
  if (startStr) {
    const startDate = new Date(startStr);
    if (date < startDate) return false;
  }
  
  if (endStr) {
    const endDate = new Date(endStr);
    // Include the entire end day
    endDate.setHours(23, 59, 59, 999);
    if (date > endDate) return false;
  }
  
  return true;
}

// Parse a date-only string (YYYY-MM-DD) as a local Date and return YYYY-MM-DD key
function dateKeyFromLocal(dateStr) {
  if (!dateStr) return null;
  let d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [y, m, day] = dateStr.split('-').map(Number);
    d = new Date(y, m - 1, day);
  } else {
    d = new Date(dateStr);
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

// Parse a date string as local Date object (handles YYYY-MM-DD as local)
function parseDateAsLocal(dateStr) {
  if (!dateStr) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Aggregate run log data based on filters
 * @param {Object} options - Aggregation options
 * @param {Array} options.runs - All run logs
 * @param {Array} options.events - All events
 * @param {Array} options.tracks - All tracks
 * @param {Array} options.cars - All cars
 * @param {Object} options.filters - Filter criteria
 * @param {string|null} options.filters.carId - Filter by car ID
 * @param {string|null} options.filters.trackId - Filter by track ID
 * @param {string|null} options.filters.dateFrom - Start date filter
 * @param {string|null} options.filters.dateTo - End date filter
 * @param {string|null} options.filters.sessionType - Session type filter
 * @returns {Object} - Aggregated data
 */
export function aggregateRuns({ runs, events, tracks, cars, filters = {} }) {
  // Apply filters
  const filteredRuns = runs.filter(run => {
    // Filter by car
    if (filters.carId && run.carId !== filters.carId) {
      return false;
    }
    
    // Filter by track
    if (filters.trackId) {
      const event = events.find(e => e.id === run.eventId);
      if (!event || event.trackId !== filters.trackId) {
        return false;
      }
    }
    
    // Filter by date range
    if (filters.dateFrom || filters.dateTo) {
      if (!withinDateRange(run.createdAt, filters.dateFrom, filters.dateTo)) {
        return false;
      }
    }
    
    // Filter by session type
    if (filters.sessionType && run.sessionType !== filters.sessionType) {
      return false;
    }
    
    return true;
  });
  
  // Calculate KPIs
  const kpis = calculateKPIs(filteredRuns);
  
  // Build trend series
  const trendSeries = buildTrendSeries(filteredRuns, events);
  
  // Calculate per-track summary
  const byTrack = calculateByTrack(filteredRuns, events, tracks);
  
  return {
    filteredRuns,
    kpis,
    trendSeries,
    byTrack
  };
}

/**
 * Calculate key performance indicators
 * @param {Array} runs - Filtered run logs
 * @returns {Object} - KPI object
 */
function calculateKPIs(runs) {
  // Extract valid best lap times
  const bestLapTimes = runs
    .map(run => parseLap(run.bestLap))
    .filter(lap => lap !== null);
  
  // Extract valid average lap times
  const avgLapTimes = runs
    .map(run => parseLap(run.avgLap))
    .filter(lap => lap !== null);
  
  // Calculate best lap (minimum)
  const bestLapMin = bestLapTimes.length > 0 
    ? Math.min(...bestLapTimes) 
    : null;
  
  // Calculate average lap (mean of averages)
  let avgLapMean = null;
  if (avgLapTimes.length > 0) {
    avgLapMean = avgLapTimes.reduce((sum, lap) => sum + lap, 0) / avgLapTimes.length;
  } else if (bestLapTimes.length > 0) {
    // Fallback: use mean of bestLap for display purposes
    avgLapMean = bestLapTimes.reduce((sum, lap) => sum + lap, 0) / bestLapTimes.length;
  }
  
  // Count runs and unique events
  const runCount = runs.length;
  const eventCount = new Set(runs.map(r => r.eventId).filter(Boolean)).size;
  
  return {
    bestLapMin,
    avgLapMean,
    runCount,
    eventCount
  };
}

/**
 * Build trend series sorted by date
 * @param {Array} runs - Filtered run logs
 * @param {Array} events - All events
 * @returns {Array} - Trend data points
 */
function buildTrendSeries(runs, events) {
  // Group runs by date (day)
  const runsByDate = {};
  
  runs.forEach(run => {
    // Try to get event date first, fallback to run createdAt
    let dateKey;
    const event = events.find(e => e.id === run.eventId);
    if (event && event.date) {
      dateKey = dateKeyFromLocal(event.date);
    } else if (run.createdAt) {
      dateKey = new Date(run.createdAt).toISOString().split('T')[0];
    } else {
      return; // Skip runs without dates
    }
    
    if (!runsByDate[dateKey]) {
      runsByDate[dateKey] = [];
    }
    runsByDate[dateKey].push(run);
  });
  
  // Build trend points
  const trendPoints = Object.entries(runsByDate).map(([dateKey, dateRuns]) => {
    const bestLaps = dateRuns
      .map(r => parseLap(r.bestLap))
      .filter(lap => lap !== null);
    
    const avgLaps = dateRuns
      .map(r => parseLap(r.avgLap))
      .filter(lap => lap !== null);
    
    return {
      x: dateKey,
      bestLap: bestLaps.length > 0 ? Math.min(...bestLaps) : null,
      avgLap: avgLaps.length > 0 
        ? avgLaps.reduce((sum, lap) => sum + lap, 0) / avgLaps.length 
        : null
    };
  });
  
  // Sort by date
  trendPoints.sort((a, b) => new Date(a.x) - new Date(b.x));
  
  return trendPoints;
}

/**
 * Calculate per-track performance summary
 * @param {Array} runs - Filtered run logs
 * @param {Array} events - All events
 * @param {Array} tracks - All tracks
 * @returns {Array} - Track performance summary
 */
function calculateByTrack(runs, events, tracks) {
  const trackData = {};
  
  runs.forEach(run => {
    const event = events.find(e => e.id === run.eventId);
    if (!event || !event.trackId) return;
    
    const track = tracks.find(t => t.id === event.trackId);
    if (!track) return;
    
    if (!trackData[track.id]) {
      trackData[track.id] = {
        trackId: track.id,
        trackName: track.name,
        bestLaps: [],
        avgLaps: [],
        runCount: 0
      };
    }
    
    const bestLap = parseLap(run.bestLap);
    const avgLap = parseLap(run.avgLap);
    
    if (bestLap !== null) {
      trackData[track.id].bestLaps.push(bestLap);
    }
    if (avgLap !== null) {
      trackData[track.id].avgLaps.push(avgLap);
    }
    
    trackData[track.id].runCount++;
  });
  
  // Calculate summary statistics
  const trackSummary = Object.values(trackData).map(td => {
    const bestLapMin = td.bestLaps.length > 0 
      ? Math.min(...td.bestLaps) 
      : null;
    
    const avgLapMean = td.avgLaps.length > 0
      ? td.avgLaps.reduce((sum, lap) => sum + lap, 0) / td.avgLaps.length
      : null;
    
    return {
      trackId: td.trackId,
      trackName: td.trackName,
      bestLapMin,
      avgLapMean,
      runCount: td.runCount
    };
  });
  
  // Sort by track name
  trackSummary.sort((a, b) => (a.trackName || '').localeCompare(b.trackName || ''));
  
  return trackSummary;
}

/**
 * Group runs by event
 * @param {Array} runs - Run logs
 * @param {Array} events - All events
 * @returns {Array} - Events with grouped runs
 */
export function groupRunsByEvent(runs, events) {
  const eventMap = {};
  
  // Initialize event map
  events.forEach(event => {
    eventMap[event.id] = {
      event,
      runs: []
    };
  });
  
  // Group runs by event
  runs.forEach(run => {
    if (run.eventId && eventMap[run.eventId]) {
      eventMap[run.eventId].runs.push(run);
    }
  });
  
  // Convert to array and sort by event date
  const grouped = Object.values(eventMap)
    .filter(item => item.runs.length > 0)
    .sort((a, b) => {
      const dateA = parseDateAsLocal(a.event.date) || new Date(0);
      const dateB = parseDateAsLocal(b.event.date) || new Date(0);
      return dateB - dateA; // Most recent first
    });
  
  return grouped;
}
