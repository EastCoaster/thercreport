import { dbInit, add, put, get, getAll, remove, generateId, queryIndex, normalizeSetupData, clearAllStores, resetDatabase } from './db.js';
import { diffObjects } from './diff.js';
import { parseLap, aggregateRuns, groupRunsByEvent } from './stats.js';
import { renderLineChart, renderBarChart } from './charts.js';
import * as Calculators from './tools/calculators.js';

// Global app state and UI helpers
const state = {
  currentRoute: '',
  installPrompt: null,
};

// Chart instances used by Analytics page
let analyticsCharts = { best: null, avg: null, track: null };
// Analytics UI defaults and cache
let analyticsTrackMetric = 'avg';
let analyticsInvertY = true;
let analyticsDataCache = null;
let analyticsLastFiltersKey = null;

// Dev flag + chart version log guard
const isDev = (typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) || false;
let chartVersionLogged = false;

// Preferred unit helpers (persisted)
function getPreferredUnit() {
  try {
    return localStorage.getItem('rc_report_unit') || 'in';
  } catch (e) {
    return 'in';
  }
}

function setPreferredUnit(unit) {
  try {
    localStorage.setItem('rc_report_unit', unit);
    toast('Preferred unit saved');
  } catch (e) {
    console.error('Failed to persist preferred unit', e);
  }
}

// Minimal toast helper (transient message)
function toast(msg, timeout = 3000) {
  try {
    const existing = document.getElementById('app-toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.id = 'app-toast';
    el.style.position = 'fixed';
    el.style.bottom = '20px';
    el.style.left = '50%';
    el.style.transform = 'translateX(-50%)';
    el.style.background = 'rgba(0,0,0,0.8)';
    el.style.color = '#fff';
    el.style.padding = '8px 12px';
    el.style.borderRadius = '6px';
    el.style.zIndex = 9999;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), timeout);
  } catch (e) {
    console.log('TOAST:', msg);
  }
}

// Parse time input (seconds, MM:SS(.mmm), or HH:MM:SS(.mmm)) into seconds
function parseTimeInputToSeconds(s) {
  if (!s) return null;
  s = String(s).trim();
  // Plain seconds (e.g. "12.345")
  if (/^\d+(?:\.\d+)?$/.test(s)) return parseFloat(s);

  // HH:MM:SS(.mmm)
  let m = s.match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (m) {
    const hours = parseInt(m[1], 10);
    const minutes = parseInt(m[2], 10);
    const seconds = parseInt(m[3], 10);
    const millis = m[4] ? parseFloat('0.' + m[4]) : 0;
    if ([hours, minutes, seconds].every(Number.isFinite)) {
      return hours * 3600 + minutes * 60 + seconds + millis;
    }
  }

  // MM:SS(.mmm)
  m = s.match(/^(\d+):(\d{2})(?:\.(\d+))?$/);
  if (m) {
    const minutes = parseInt(m[1], 10);
    const seconds = parseInt(m[2], 10);
    const millis = m[3] ? parseFloat('0.' + m[3]) : 0;
    if ([minutes, seconds].every(Number.isFinite)) {
      return minutes * 60 + seconds + millis;
    }
  }

  return null;
}

// Parse a date string from an `<input type="date">` (YYYY-MM-DD) as a local Date
function parseDateStringAsLocal(s) {
  if (!s) return null;
  // If it's a date-only string (YYYY-MM-DD), construct local Date to avoid UTC shift
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(s);
}

// Format lap time in seconds to human readable string
function formatLapTime(val) {
  if (val === null || val === undefined) return '-';
  const n = Number(val);
  if (!Number.isFinite(n)) return '-';
  // If minutes
  if (n >= 60) {
    const minutes = Math.floor(n / 60);
    const secs = n - minutes * 60;
    const secInt = Math.floor(secs);
    const millis = Math.round((secs - secInt) * 1000);
    return `${minutes}:${String(secInt).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }
  // Seconds with milliseconds
  const seconds = Math.floor(n);
  const millis = Math.round((n - seconds) * 1000);
  return `${seconds}.${String(millis).padStart(3, '0')}s`;
}

// Format a date string for display, handling date-only inputs as local dates
function formatDateForDisplay(s, locale = undefined, options = undefined) {
  const d = parseDateStringAsLocal(s);
  if (!d) return '-';
  return locale ? d.toLocaleDateString(locale, options) : d.toLocaleDateString(undefined, options);
}

// Error Boundary
window.addEventListener('error', (event) => {
  console.error('❌ Global error:', event.error);
  toast('An error occurred. Check console for details.');
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('❌ Unhandled promise rejection:', event.reason);
  toast('An error occurred. Check console for details.');
});

// Router
const routes = {
  '/garage': renderGaragePage,
  '/events': renderEventsPage,
  '/tracks': renderTracksPage,
  '/analytics': renderAnalyticsPage,
  '/analytics/track': renderAnalyticsTrackDrilldownPage,  // Dynamic route for /analytics/track/{id}
  '/settings': renderSettingsPage,
  '/car': renderCarDetailPage,  // Dynamic route for /car/{id}
  '/setup': renderSetupDetailPage,  // Dynamic route for /setup/{id}
  '/track': renderTrackDetailPage,  // Dynamic route for /track/{id}
  '/event': renderEventDetailPage,  // Dynamic route for /event/{id}
  '/compare': renderComparePage  // Compare page with query params
  ,'/tools': renderToolsPage
};

// Debounce utility
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Route handler
function router() {
  try {
    const previousRoute = state.currentRoute || '';
    const hash = window.location.hash.slice(1) || '/garage';
    const leavingAnalytics = previousRoute === '/analytics' && hash !== '/analytics';
    state.currentRoute = hash;
    if (leavingAnalytics) {
      destroyAnalyticsCharts();
    }
    
    // Check for exact match first
    let routeHandler = routes[hash];
    
    // If no exact match, check for dynamic routes
    if (!routeHandler) {
      for (const route in routes) {
        if (hash.startsWith(route + '/')) {
          routeHandler = routes[route];
          break;
        }
      }
    }
    
    if (routeHandler) {
      routeHandler();
    } else {
      // Redirect to default route if not found
      window.location.hash = '#/garage';
      return;
    }
    
    // Update active nav item (use base route)
    const baseRoute = '/' + hash.split('/')[1];
    updateActiveNav(baseRoute);
  } catch (error) {
    console.error('❌ Router error:', error);
    toast('Failed to load page');
  }
}

// Debounced router to prevent multiple rapid route changes
const debouncedRouter = debounce(router, 50);

// Update active navigation item
function updateActiveNav(route) {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    const itemRoute = '/' + item.dataset.route;
    if (itemRoute === route) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });
}

// Render functions for each page
async function renderGaragePage() {
  const app = document.getElementById('app');
  
  // Show loading skeleton
  app.innerHTML = `
    <div class="page">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h2 style="margin: 0;">Garage</h2>
      </div>
      ${renderLoadingSkeleton()}
    </div>
  `;
  
  try {
    // Load cars from database
    const cars = await getAll('cars');
    
    // Sort by name
    cars.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    
    // Render page
    app.innerHTML = `
      <div class="page">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h2 style="margin: 0;">Garage</h2>
          <button class="btn" id="addCarBtn">+ Add Car</button>
        </div>
        <!-- Preferences removed from Garage (moved to Settings) -->
        
        <!-- Car Form (hidden by default) -->
        <div id="carForm" style="display: none;" class="page-content" style="margin-bottom: 16px;">
          <h3 id="formTitle">Add Car</h3>
          <form id="carFormElement">
            <input type="hidden" id="carId" value="">
            <div class="form-group">
              <label for="carName">Name *</label>
              <input type="text" id="carName" required placeholder="e.g. My TLR 22 5.0">
            </div>
            <div class="form-group">
              <label for="carClass">Class</label>
              <input type="text" id="carClass" placeholder="e.g. 2WD Buggy">
            </div>
            <div class="form-group">
              <label for="carChassis">Chassis</label>
              <input type="text" id="carChassis" placeholder="e.g. TLR 22 5.0">
            </div>
            <div class="form-group">
              <label for="carMotor">Motor</label>
              <input type="text" id="carMotor" placeholder="e.g. Reedy 17.5T">
            </div>
            <div class="form-group">
              <label for="carEsc">ESC</label>
              <input type="text" id="carEsc" placeholder="e.g. Reedy SC1000">
            </div>
            <div class="form-group">
              <label for="carTransponder">Transponder</label>
              <input type="text" id="carTransponder" placeholder="e.g. 1234567">
            </div>
            <div class="form-group">
              <label for="carNotes">Notes</label>
              <textarea id="carNotes" rows="3" placeholder="Additional notes..."></textarea>
            </div>
            <div class="form-group">
              <label for="carImage">Car Photo</label>
              <input type="file" id="carImage" accept="image/*" capture="environment" style="display: none;">
              <div id="carImagePreview" style="margin-top: 8px;"></div>
              <div style="display: flex; gap: 8px; margin-top: 8px;">
                <button type="button" class="btn btn-secondary" id="captureImageBtn">📷 Take Photo</button>
                <button type="button" class="btn btn-secondary" id="removeImageBtn" style="display: none;">Remove Photo</button>
              </div>
            </div>
            <div style="display: flex; gap: 8px;">
              <button type="submit" class="btn">Save</button>
              <button type="button" class="btn btn-secondary" id="cancelBtn">Cancel</button>
            </div>
          </form>
        </div>
        
        <!-- Car List -->
        <div id="carList">
          ${cars.length === 0 ? `
            <div class="empty-state">
              <div class="empty-state-icon">🏎️</div>
              <p class="empty-state-text">No cars in your garage yet</p>
            </div>
          ` : `
            <div class="car-list">
              ${cars.map(car => `
                <div class="car-item" data-id="${car.id}">
                  ${car.image ? `
                    <div class="car-thumbnail">
                      <img src="${car.image}" alt="${escapeHtml(car.name)}" style="width: 80px; height: 80px; object-fit: cover; border-radius: 8px;">
                    </div>
                  ` : ''}
                  <div class="car-info">
                    <h3 class="car-name">${escapeHtml(car.name)}</h3>
                    ${car.class ? `<p class="car-detail">${escapeHtml(car.class)}</p>` : ''}
                    ${car.chassis ? `<p class="car-detail"><small>${escapeHtml(car.chassis)}</small></p>` : ''}
                    ${car.transponder ? `<p class="car-detail"><small>Transponder: ${escapeHtml(car.transponder)}</small></p>` : ''}
                  </div>
                  <div class="car-actions">
                    
                    <button class="btn-icon" data-action="edit" data-id="${car.id}" title="Edit">✏️</button>
                    <button class="btn-icon" data-action="delete" data-id="${car.id}" title="Delete">🗑️</button>
                  </div>
                </div>
              `).join('')}
            </div>
          `}
        </div>
      </div>
    `;
    
    
    
    
    
    // Attach event listeners
    document.getElementById('addCarBtn')?.addEventListener('click', () => showCarForm());
    document.getElementById('cancelBtn')?.addEventListener('click', hideCarForm);
    document.getElementById('carFormElement')?.addEventListener('submit', handleCarSubmit);

    // If coming from Edit Car on details page, open the form in edit mode after render
    if (window.pendingEditCarId) {
      const editId = window.pendingEditCarId;
      window.pendingEditCarId = null;
      setTimeout(() => editCar(editId), 0);
    }
    
    // Attach action buttons
    document.querySelectorAll('.btn-icon').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = e.currentTarget.dataset.action;
        const id = e.currentTarget.dataset.id;
        
        if (action === 'view') {
          window.location.hash = `#/car/${id}`;
        } else if (action === 'edit') {
          editCar(id);
        } else if (action === 'delete') {
          deleteCar(id);
        }
      });
    });

    // Make the whole car item clickable to view the car, but ignore clicks
    // that originate from the action buttons area so those still perform
    // their individual actions.
    document.querySelectorAll('.car-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.car-actions')) return; // allow action buttons
        const id = item.dataset.id;
        if (id) window.location.hash = `#/car/${id}`;
      });
      // Improve affordance
      item.style.cursor = 'pointer';
    });
    
  } catch (error) {
    console.error('❌ Failed to load garage:', error);
    app.innerHTML = '<div class="page"><p>Failed to load cars. Please try again.</p></div>';
    toast('Failed to load cars');
  }
}

// Car Form Helpers
function showCarForm(car = null) {
  const form = document.getElementById('carForm');
  const formTitle = document.getElementById('formTitle');
  
  if (car) {
    // Edit mode
    formTitle.textContent = 'Edit Car';
    document.getElementById('carId').value = car.id;
    document.getElementById('carName').value = car.name || '';
    document.getElementById('carClass').value = car.class || '';
    document.getElementById('carChassis').value = car.chassis || '';
    document.getElementById('carMotor').value = car.motor || '';
    document.getElementById('carEsc').value = car.esc || '';
    document.getElementById('carNotes').value = car.notes || '';
    document.getElementById('carTransponder').value = car.transponder || '';
    
    // Handle existing image
    currentCarImage = car.image || null;
    const preview = document.getElementById('carImagePreview');
    const removeBtn = document.getElementById('removeImageBtn');
    if (car.image) {
      preview.innerHTML = `<img src="${car.image}" alt="Car photo" style="max-width: 100%; border-radius: 8px;">`;
      if (removeBtn) removeBtn.style.display = 'inline-block';
    } else {
      preview.innerHTML = '';
      if (removeBtn) removeBtn.style.display = 'none';
    }
  } else {
    // Add mode
    formTitle.textContent = 'Add Car';
    document.getElementById('carFormElement').reset();
    document.getElementById('carId').value = '';
    document.getElementById('carTransponder').value = '';
    currentCarImage = null;
    const previewEl = document.getElementById('carImagePreview');
    const removeBtnEl = document.getElementById('removeImageBtn');
    if (previewEl) previewEl.innerHTML = '';
    if (removeBtnEl) removeBtnEl.style.display = 'none';
  }
  
  form.style.display = 'block';
  document.getElementById('carName').focus();
  
  // Setup image capture handlers
  setupImageCapture();
}

function hideCarForm() {
  document.getElementById('carForm').style.display = 'none';
  document.getElementById('carFormElement').reset();
}

async function handleCarSubmit(e) {
  e.preventDefault();
  
  const id = document.getElementById('carId').value;
  const carData = {
    id: id || generateId('car'),
    name: document.getElementById('carName').value.trim(),
    class: document.getElementById('carClass').value.trim(),
    chassis: document.getElementById('carChassis').value.trim(),
    motor: document.getElementById('carMotor').value.trim(),
    esc: document.getElementById('carEsc').value.trim(),
    transponder: document.getElementById('carTransponder').value.trim(),
    notes: document.getElementById('carNotes').value.trim(),
    image: currentCarImage || null,
    updatedAt: new Date().toISOString()
  };
  
  // Add createdAt for new cars
  if (!id) {
    carData.createdAt = carData.updatedAt;
  }
  
  try {
    await put('cars', carData);
    toast(id ? 'Car updated!' : 'Car added!');
    hideCarForm();
    renderGaragePage();
  } catch (error) {
    console.error('❌ Failed to save car:', error);
    toast('Failed to save car');
  }
}

async function editCar(id) {
  try {
    const car = await get('cars', id);
    if (car) {
      showCarForm(car);
    } else {
      toast('Car not found');
    }
  } catch (error) {
    console.error('❌ Failed to load car:', error);
    toast('Failed to load car');
  }
}

async function deleteCar(id) {
  if (!confirm('Are you sure you want to delete this car?')) {
    return;
  }
  
  try {
    await remove('cars', id);
    toast('Car deleted');
    renderGaragePage();
  } catch (error) {
    console.error('❌ Failed to delete car:', error);
    toast('Failed to delete car');
  }
}

// Image utilities
let currentCarImage = null;

async function resizeImage(file, maxWidth = 320, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        
        // Scale to fit within maxWidth x maxWidth maintaining aspect ratio
        if (width > maxWidth || height > maxWidth) {
          if (width > height) {
            height = (height * maxWidth) / width;
            width = maxWidth;
          } else {
            width = (width * maxWidth) / height;
            height = maxWidth;
          }
        }
        
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        
        canvas.toBlob((blob) => {
          if (blob) {
            const resizedReader = new FileReader();
            resizedReader.onloadend = () => resolve(resizedReader.result);
            resizedReader.onerror = reject;
            resizedReader.readAsDataURL(blob);
          } else {
            reject(new Error('Failed to create blob'));
          }
        }, 'image/jpeg', quality);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function setupImageCapture() {
  const fileInput = document.getElementById('carImage');
  const captureBtn = document.getElementById('captureImageBtn');
  const removeBtn = document.getElementById('removeImageBtn');
  const preview = document.getElementById('carImagePreview');
  
  if (!fileInput || !captureBtn) return;
  
  captureBtn.addEventListener('click', () => fileInput.click());
  
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    try {
      const resizedDataUrl = await resizeImage(file, 320, 0.75);
      currentCarImage = resizedDataUrl;
      preview.innerHTML = `<img src="${resizedDataUrl}" style="max-width: 100%; max-height: 200px; border-radius: 6px; box-shadow: var(--shadow-sm);">`;
      if (removeBtn) {
        removeBtn.style.display = 'inline-block';
      }
      toast('Photo captured');
    } catch (error) {
      console.error('Failed to process image:', error);
      toast('Failed to process image');
    }
  });
  
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      currentCarImage = null;
      preview.innerHTML = '';
      fileInput.value = '';
      removeBtn.style.display = 'none';
      toast('Photo removed');
    });
  }
}

// HTML escape helper
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
window.escapeHtml = escapeHtml;

// Loading skeleton helper
function renderLoadingSkeleton(count = 3) {
  return Array.from({ length: count }, () => `
    <div class="skeleton-item">
      <div class="skeleton skeleton-title"></div>
      <div class="skeleton skeleton-text"></div>
    </div>
  `).join('');
}
window.renderLoadingSkeleton = renderLoadingSkeleton;

// Car Detail Page with Setups
async function renderCarDetailPage() {
  const app = document.getElementById('app');
  const hash = window.location.hash.slice(1);
  const carId = hash.split('/')[2];
  
  if (!carId) {
    window.location.hash = '#/garage';
    return;
  }
  
  app.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  
  try {
    const car = await get('cars', carId);
    
    if (!car) {
      app.innerHTML = `
        <div class="page">
          <p>Car not found</p>
          <button class="btn" onclick="window.location.hash='#/garage'">Back to Garage</button>
        </div>
      `;
      return;
    }
    
    // Load setups for this car
    const setups = await queryIndex('setups', 'carId', carId);
    
    // Sort by createdAt, newest first
    setups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    // Load tracks for the select dropdown
    const tracks = await getAll('tracks');
    tracks.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Load analytics/run data to compute car-specific statistics
    let carStats = null;
    try {
      const analytics = await loadAnalyticsData();
      const enrichedRuns = analytics.enrichedRuns || [];

      // Filter runs for this car
      const carRuns = enrichedRuns.filter(r => r.carId === carId);

      // Use aggregateRuns helper to compute KPIs
      const agg = aggregateRuns({ runs: carRuns, events: analytics.events || [], tracks: analytics.tracks || [], cars: analytics.cars || [], filters: { carId } });
      const kpis = agg.kpis || {};

      // Parse finish positions into numbers where possible (e.g., '1st', 'P2' -> 2)
      const parsePositionToNumber = (pos) => {
        if (!pos) return null;
        const m = String(pos).match(/(\d+)/);
        return m ? parseInt(m[1], 10) : null;
      };

      const positions = carRuns.map(r => parsePositionToNumber(r.position)).filter(n => Number.isFinite(n));
      const bestFinishNum = positions.length > 0 ? Math.min(...positions) : null;
      const podiumCount = positions.filter(n => n <= 3).length;

      const ordinal = (n) => {
        if (!n && n !== 0) return '';
        const s = ["th","st","nd","rd"], v = n % 100;
        return n + (s[(v-20)%10] || s[v] || s[0]);
      };

      carStats = {
        runCount: kpis.runCount || 0,
        raceCount: kpis.eventCount || 0,
        bestLap: kpis.bestLapMin || null,
        avgLap: kpis.avgLapMean || null,
        bestFinish: bestFinishNum ? ordinal(bestFinishNum) : null,
        podiumCount
      };
    } catch (err) {
      console.warn('Failed to compute car stats', err);
      carStats = null;
    }
    
    app.innerHTML = `
      <div class="page">
        <button class="btn-back" onclick="window.location.hash='#/garage'">← Back to Garage</button>
        
        <!-- Car Summary -->
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
          <h2 style="margin: 0;">${escapeHtml(car.name)}</h2>
        </div>
        ${car.image ? `
          <div style="margin-bottom: 16px; text-align: center;">
            <img src="${car.image}" alt="${escapeHtml(car.name)}" style="max-width: 100%; max-height: 300px; border-radius: 8px; box-shadow: var(--shadow-md);">
          </div>
        ` : ''}
        <div class="page-content" style="margin-bottom: 24px;">
          <div class="detail-row">
            <strong>Class:</strong> ${car.class ? escapeHtml(car.class) : '-'}
          </div>
          <div class="detail-row">
            <strong>Chassis:</strong> ${car.chassis ? escapeHtml(car.chassis) : '-'}
          </div>
          <div class="detail-row">
            <strong>Motor:</strong> ${car.motor ? escapeHtml(car.motor) : '-'}
          </div>
          <div class="detail-row">
            <strong>ESC:</strong> ${car.esc ? escapeHtml(car.esc) : '-'}
          </div>
          <div class="detail-row">
            <strong>Transponder:</strong> ${car.transponder ? escapeHtml(car.transponder) : '-'}
          </div>
        </div>
        
        <!-- Car Statistics -->
        ${carStats ? `
          <div class="page-content" style="margin-bottom: 24px;">
            <h3 style="margin-top: 0;">Statistics</h3>
            <div class="detail-row"><strong>Number of Runs:</strong> ${carStats.runCount}</div>
            <div class="detail-row"><strong>Number of Races:</strong> ${carStats.raceCount}</div>
            <div class="detail-row"><strong>Best Lap:</strong> ${carStats.bestLap ? carStats.bestLap.toFixed ? carStats.bestLap.toFixed(3) + ' s' : carStats.bestLap : '-'}</div>
            <div class="detail-row"><strong>Average Lap:</strong> ${carStats.avgLap ? carStats.avgLap.toFixed(3) + ' s' : '-'}</div>
            <div class="detail-row"><strong>Best Finish:</strong> ${carStats.bestFinish || '-'}</div>
            <div class="detail-row"><strong>Podium Finishes:</strong> ${carStats.podiumCount || 0}</div>
          </div>
        ` : ''}
        
        <!-- Setups Section -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h3 style="margin: 0;">Setups</h3>
          <div style="display: flex; gap: 8px;">
            ${setups.length >= 2 ? `<button class="btn btn-secondary" onclick="window.location.hash='#/compare?carId=${carId}'">Compare Setups</button>` : ''}
            <button class="btn" id="addSetupBtn">+ Add Setup</button>
          </div>
        </div>
        
        <!-- Setup Form (hidden by default) -->
        <div id="setupForm" style="display: none;" class="page-content" style="margin-bottom: 16px;">
          <h4 id="setupFormTitle">Add Setup</h4>
          <form id="setupFormElement">
            <input type="hidden" id="setupId" value="">
            <input type="hidden" id="setupCarId" value="${carId}">
            <div class="form-group">
              <label for="setupTrackId">Track *</label>
              ${tracks.length === 0 ? `
                <p style="color: var(--text-secondary); font-size: 14px; margin: 8px 0;">
                  No tracks available. <a href="#/tracks" style="color: var(--primary-color);">Add tracks first</a>
                </p>
              ` : `
                <select id="setupTrackId" required>
                  <option value="">Select a track...</option>
                  ${tracks.map(track => `<option value="${track.id}">${escapeHtml(track.name)}</option>`).join('')}
                </select>
              `}
            </div>
            <div class="form-group">
              <label for="setupVersionLabel">Version Label</label>
              <input type="text" id="setupVersionLabel" placeholder="e.g. Baseline, Q1, Main, Race A">
            </div>
            <!-- Chassis -->
            <h4 style="margin: 20px 0 12px 0; color: var(--primary-color);">Chassis</h4>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
              <div class="form-group">
                <label for="rideHeightF">Ride Height Front</label>
                <input type="text" id="rideHeightF" placeholder="e.g. 20mm">
              </div>
              <div class="form-group">
                <label for="rideHeightR">Ride Height Rear</label>
                <input type="text" id="rideHeightR" placeholder="e.g. 20mm">
              </div>
              <div class="form-group">
                <label for="droopF">Droop Front</label>
                <input type="text" id="droopF" placeholder="e.g. 1mm">
              </div>
              <div class="form-group">
                <label for="droopR">Droop Rear</label>
                <input type="text" id="droopR" placeholder="e.g. 1mm">
              </div>
            </div>
            <div class="form-group">
              <label for="weightBalanceNotes">Weight Balance Notes</label>
              <input type="text" id="weightBalanceNotes" placeholder="Weight distribution, battery position, etc.">
            </div>

            <!-- Suspension -->
            <h4 style="margin: 20px 0 12px 0; color: var(--primary-color);">Suspension</h4>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
              <div class="form-group">
                <label for="springsF">Springs Front</label>
                <input type="text" id="springsF" placeholder="e.g. 4.4">
              </div>
              <div class="form-group">
                <label for="springsR">Springs Rear</label>
                <input type="text" id="springsR" placeholder="e.g. 4.6">
              </div>
              <div class="form-group">
                <label for="pistonsF">Pistons Front</label>
                <input type="text" id="pistonsF" placeholder="e.g. 1.3x6">
              </div>
              <div class="form-group">
                <label for="pistonsR">Pistons Rear</label>
                <input type="text" id="pistonsR" placeholder="e.g. 1.3x6">
              </div>
              <div class="form-group">
                <label for="shockOilF">Shock Oil Front</label>
                <input type="text" id="shockOilF" placeholder="e.g. 35wt">
              </div>
              <div class="form-group">
                <label for="shockOilR">Shock Oil Rear</label>
                <input type="text" id="shockOilR" placeholder="e.g. 35wt">
              </div>
              <div class="form-group">
                <label for="shockPosF">Shock Position Front</label>
                <input type="text" id="shockPosF" placeholder="e.g. Middle">
              </div>
              <div class="form-group">
                <label for="shockPosR">Shock Position Rear</label>
                <input type="text" id="shockPosR" placeholder="e.g. Middle">
              </div>
              <div class="form-group">
                <label for="camberF">Camber Front</label>
                <input type="text" id="camberF" placeholder="e.g. -2°">
              </div>
              <div class="form-group">
                <label for="camberR">Camber Rear</label>
                <input type="text" id="camberR" placeholder="e.g. -1.5°">
              </div>
              <div class="form-group">
                <label for="toeF">Toe Front</label>
                <input type="text" id="toeF" placeholder="e.g. 0°">
              </div>
              <div class="form-group">
                <label for="toeR">Toe Rear</label>
                <input type="text" id="toeR" placeholder="e.g. 1°">
              </div>
            </div>

            <!-- Drivetrain -->
            <h4 style="margin: 20px 0 12px 0; color: var(--primary-color);">Drivetrain</h4>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
              <div class="form-group">
                <label for="pinion">Pinion</label>
                <input type="text" id="pinion" placeholder="e.g. 28T">
              </div>
              <div class="form-group">
                <label for="spur">Spur</label>
                <input type="text" id="spur" placeholder="e.g. 81T">
              </div>
              <div class="form-group">
                <label for="diffType">Diff Type</label>
                <input type="text" id="diffType" placeholder="e.g. Gear, Ball">
              </div>
              <div class="form-group">
                <label for="fdrNotes">FDR Notes</label>
                <input type="text" id="fdrNotes" placeholder="Final drive ratio notes">
              </div>
              <div class="form-group">
                <label for="diffOilF">Diff Oil Front</label>
                <input type="text" id="diffOilF" placeholder="e.g. 7000cst">
              </div>
              <div class="form-group">
                <label for="diffOilR">Diff Oil Rear</label>
                <input type="text" id="diffOilR" placeholder="e.g. 7000cst">
              </div>
            </div>
            <div class="form-group">
              <label for="centerDiffOil">Center Diff Oil</label>
              <input type="text" id="centerDiffOil" placeholder="e.g. 5000cst (4WD only)">
            </div>

            <!-- Tires -->
            <h4 style="margin: 20px 0 12px 0; color: var(--primary-color);">Tires</h4>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
              <div class="form-group">
                <label for="tireBrand">Tire Brand</label>
                <input type="text" id="tireBrand" placeholder="e.g. Pro-Line">
              </div>
              <div class="form-group">
                <label for="tireCompound">Compound</label>
                <input type="text" id="tireCompound" placeholder="e.g. M4">
              </div>
              <div class="form-group">
                <label for="insert">Insert</label>
                <input type="text" id="insert" placeholder="e.g. Closed Cell">
              </div>
              <div class="form-group">
                <label for="sauce">Sauce</label>
                <input type="text" id="sauce" placeholder="e.g. Green Sauce">
              </div>
            </div>
            <div class="form-group">
              <label for="prepNotes">Prep Notes</label>
              <input type="text" id="prepNotes" placeholder="Tire prep and treatment notes">
            </div>

            <!-- Electronics -->
            <h4 style="margin: 20px 0 12px 0; color: var(--primary-color);">Electronics</h4>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
              <div class="form-group">
                <label for="escProfile">ESC Profile</label>
                <input type="text" id="escProfile" placeholder="e.g. Blinky 13.5">
              </div>
              <div class="form-group">
                <label for="timing">Timing</label>
                <input type="text" id="timing" placeholder="e.g. 15°">
              </div>
              <div class="form-group">
                <label for="punch">Punch</label>
                <input type="text" id="punch" placeholder="e.g. 5">
              </div>
            </div>
            <div class="form-group">
              <label for="motorNotes">Motor Notes</label>
              <input type="text" id="motorNotes" placeholder="Motor setup and observations">
            </div>

            <!-- General -->
            <h4 style="margin: 20px 0 12px 0; color: var(--primary-color);">General</h4>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
              <div class="form-group">
                <label for="trackCondition">Track Condition</label>
                <input type="text" id="trackCondition" placeholder="e.g. High bite, dusty">
              </div>
              <div class="form-group">
                <label for="temp">Temperature</label>
                <input type="text" id="temp" placeholder="e.g. 75°F">
              </div>
            </div>
            <div class="form-group">
              <label for="setupNotes">Notes</label>
              <textarea id="setupNotes" rows="3" placeholder="General setup notes and observations..."></textarea>
            </div>

            <div style="display: flex; gap: 8px;">
              <button type="submit" class="btn" ${tracks.length === 0 ? 'disabled' : ''}>Save Setup</button>
              <button type="button" class="btn btn-secondary" id="cancelSetupBtn">Cancel</button>
            </div>
          </form>
        </div>
        <!-- Setup List -->
        <div id="setupList"></div>
      </div>
    `;

    // Attach event listeners
    document.getElementById('addSetupBtn')?.addEventListener('click', () => showSetupForm(carId));
    document.getElementById('cancelSetupBtn')?.addEventListener('click', hideSetupForm);
    document.getElementById('setupFormElement')?.addEventListener('submit', handleSetupSubmit);

    // Render setup list
    const setupListDiv = document.getElementById('setupList');
    if (setupListDiv) {
      if (setups.length === 0) {
        setupListDiv.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">🔧</div>
            <p class="empty-state-text">No setups recorded yet</p>
          </div>
        `;
      } else {
        setupListDiv.innerHTML = `
          <div class="setup-list">
            ${await Promise.all(setups.map(async setup => {
              const track = await get('tracks', setup.trackId);
              const trackName = track ? track.name : 'Unknown Track';
              return `
                <div class="setup-item" data-id="${setup.id}">
                  <div class="setup-info">
                    <h4 class="setup-label">${escapeHtml(trackName)}${setup.versionLabel ? ` - ${escapeHtml(setup.versionLabel)}` : ''}</h4>
                    <p class="setup-date">${new Date(setup.createdAt).toLocaleString()}</p>
                  </div>
                  <div class="setup-actions">
                    <button class="btn-icon" data-action="view" data-id="${setup.id}" title="View">👁️</button>
                    <button class="btn-icon" data-action="edit" data-id="${setup.id}" title="Edit">✏️</button>
                    <button class="btn-icon" data-action="compare" data-id="${setup.id}" title="Compare">⚖️</button>
                    <button class="btn-icon" data-action="delete" data-id="${setup.id}" title="Delete">🗑️</button>
                  </div>
                </div>
              `;
            })).then(items => items.join(''))}
          </div>
        `;
      }
      // Attach setup action buttons
      setupListDiv.querySelectorAll('.setup-item .btn-icon').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const action = e.currentTarget.dataset.action;
          const id = e.currentTarget.dataset.id;
          if (action === 'view') {
            window.location.hash = `#/setup/${id}`;
          } else if (action === 'edit') {
            editSetup(id);
          } else if (action === 'compare') {
            window.location.hash = `#/compare?carId=${carId}&a=${id}`;
          } else if (action === 'delete') {
            deleteSetup(id, carId);
          }
        });
      });
    }

    // Append Edit Car button at the very bottom after all content
    const pageDiv = app.querySelector('.page');
    if (pageDiv) {
      const btnDiv = document.createElement('div');
      btnDiv.style.marginTop = '32px';
      btnDiv.style.textAlign = 'center';
      btnDiv.innerHTML = '<button class="btn btn-secondary" id="editCarBtn">Edit Car</button>';
      pageDiv.appendChild(btnDiv);
      const editBtn = btnDiv.querySelector('#editCarBtn');
      if (editBtn) {
        editBtn.addEventListener('click', () => {
          window.pendingEditCarId = carId;
          window.location.hash = '#/garage';
        });
      }
    }

  } catch (error) {
    console.error('❌ Failed to load car details:', error);
    app.innerHTML = '<div class="page"><p>Failed to load car details</p></div>';
    toast('Failed to load car');
  }
}

// Setup Form Helpers
function showSetupForm(carId, setup = null) {
  const form = document.getElementById('setupForm');
  const formTitle = document.getElementById('setupFormTitle');
  
  if (setup) {
    // Edit mode
    formTitle.textContent = 'Edit Setup';
    document.getElementById('setupId').value = setup.id;
    document.getElementById('setupCarId').value = setup.carId;
    document.getElementById('setupTrackId').value = setup.trackId || '';
    document.getElementById('setupVersionLabel').value = setup.versionLabel || '';
    
    // Setup data fields (normalized for backward compatibility)
    const setupData = normalizeSetupData(setup);
    const chassis = setupData.chassis;
    const suspension = setupData.suspension;
    const drivetrain = setupData.drivetrain;
    const tires = setupData.tires;
    const electronics = setupData.electronics;
    const general = setupData.general;
    
    // Chassis
    document.getElementById('rideHeightF').value = chassis.rideHeightF || '';
    document.getElementById('rideHeightR').value = chassis.rideHeightR || '';
    document.getElementById('droopF').value = chassis.droopF || '';
    document.getElementById('droopR').value = chassis.droopR || '';
    document.getElementById('weightBalanceNotes').value = chassis.weightBalanceNotes || '';
    
    // Suspension
    document.getElementById('springsF').value = suspension.springsF || '';
    document.getElementById('springsR').value = suspension.springsR || '';
    document.getElementById('pistonsF').value = suspension.pistonsF || '';
    document.getElementById('pistonsR').value = suspension.pistonsR || '';
    document.getElementById('shockOilF').value = suspension.shockOilF || '';
    document.getElementById('shockOilR').value = suspension.shockOilR || '';
    document.getElementById('shockPosF').value = suspension.shockPosF || '';
    document.getElementById('shockPosR').value = suspension.shockPosR || '';
    document.getElementById('camberF').value = suspension.camberF || '';
    document.getElementById('camberR').value = suspension.camberR || '';
    document.getElementById('toeF').value = suspension.toeF || '';
    document.getElementById('toeR').value = suspension.toeR || '';
    
    // Drivetrain
    document.getElementById('pinion').value = drivetrain.pinion || '';
    document.getElementById('spur').value = drivetrain.spur || '';
    document.getElementById('fdrNotes').value = drivetrain.fdrNotes || '';
    document.getElementById('diffType').value = drivetrain.diffType || '';
    document.getElementById('diffOilF').value = drivetrain.diffOilF || '';
    document.getElementById('diffOilR').value = drivetrain.diffOilR || '';
    document.getElementById('centerDiffOil').value = drivetrain.centerDiffOil || '';
    
    // Tires
    document.getElementById('tireBrand').value = tires.tireBrand || '';
    document.getElementById('tireCompound').value = tires.tireCompound || '';
    document.getElementById('insert').value = tires.insert || '';
    document.getElementById('sauce').value = tires.sauce || '';
    document.getElementById('prepNotes').value = tires.prepNotes || '';
    
    // Electronics
    document.getElementById('escProfile').value = electronics.escProfile || '';
    document.getElementById('timing').value = electronics.timing || '';
    document.getElementById('punch').value = electronics.punch || '';
    document.getElementById('motorNotes').value = electronics.motorNotes || '';
    
    // General
    document.getElementById('trackCondition').value = general.trackCondition || '';
    document.getElementById('temp').value = general.temp || '';
    document.getElementById('setupNotes').value = general.notes || '';
  } else {
    // Add mode
    formTitle.textContent = 'Add Setup';
    document.getElementById('setupFormElement').reset();
    document.getElementById('setupId').value = '';
    document.getElementById('setupCarId').value = carId;
  }
  
  form.style.display = 'block';
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideSetupForm() {
  document.getElementById('setupForm').style.display = 'none';
  document.getElementById('setupFormElement').reset();
}

async function handleSetupSubmit(e) {
  e.preventDefault();
  
  const id = document.getElementById('setupId').value;
  const carId = document.getElementById('setupCarId').value;
  
  const setupData = {
    id: id || generateId('setup'),
    carId: carId,
    trackId: document.getElementById('setupTrackId').value,
    versionLabel: document.getElementById('setupVersionLabel').value.trim(),
    setupSchemaVersion: 2,
    setupData: {
      chassis: {
        rideHeightF: document.getElementById('rideHeightF').value.trim(),
        rideHeightR: document.getElementById('rideHeightR').value.trim(),
        droopF: document.getElementById('droopF').value.trim(),
        droopR: document.getElementById('droopR').value.trim(),
        weightBalanceNotes: document.getElementById('weightBalanceNotes').value.trim()
      },
      suspension: {
        springsF: document.getElementById('springsF').value.trim(),
        springsR: document.getElementById('springsR').value.trim(),
        pistonsF: document.getElementById('pistonsF').value.trim(),
        pistonsR: document.getElementById('pistonsR').value.trim(),
        shockOilF: document.getElementById('shockOilF').value.trim(),
        shockOilR: document.getElementById('shockOilR').value.trim(),
        shockPosF: document.getElementById('shockPosF').value.trim(),
        shockPosR: document.getElementById('shockPosR').value.trim(),
        camberF: document.getElementById('camberF').value.trim(),
        camberR: document.getElementById('camberR').value.trim(),
        toeF: document.getElementById('toeF').value.trim(),
        toeR: document.getElementById('toeR').value.trim()
      },
      drivetrain: {
        pinion: document.getElementById('pinion').value.trim(),
        spur: document.getElementById('spur').value.trim(),
        fdrNotes: document.getElementById('fdrNotes').value.trim(),
        diffType: document.getElementById('diffType').value.trim(),
        diffOilF: document.getElementById('diffOilF').value.trim(),
        diffOilR: document.getElementById('diffOilR').value.trim(),
        centerDiffOil: document.getElementById('centerDiffOil').value.trim()
      },
      tires: {
        tireBrand: document.getElementById('tireBrand').value.trim(),
        tireCompound: document.getElementById('tireCompound').value.trim(),
        insert: document.getElementById('insert').value.trim(),
        sauce: document.getElementById('sauce').value.trim(),
        prepNotes: document.getElementById('prepNotes').value.trim()
      },
      electronics: {
        escProfile: document.getElementById('escProfile').value.trim(),
        timing: document.getElementById('timing').value.trim(),
        punch: document.getElementById('punch').value.trim(),
        motorNotes: document.getElementById('motorNotes').value.trim()
      },
      general: {
        trackCondition: document.getElementById('trackCondition').value.trim(),
        temp: document.getElementById('temp').value.trim(),
        notes: document.getElementById('setupNotes').value.trim()
      }
    },
    updatedAt: new Date().toISOString()
  };
  
  // Add createdAt for new setups
  if (!id) {
    setupData.createdAt = setupData.updatedAt;
  }
  
  try {
    await put('setups', setupData);
    toast(id ? 'Setup updated!' : 'Setup added!');
    hideSetupForm();
    renderCarDetailPage();
  } catch (error) {
    console.error('❌ Failed to save setup:', error);
    toast('Failed to save setup');
  }
}

async function editSetup(id) {
  try {
    const setup = await get('setups', id);
    if (setup) {
      showSetupForm(setup.carId, setup);
    } else {
      toast('Setup not found');
    }
  } catch (error) {
    console.error('❌ Failed to load setup:', error);
    toast('Failed to load setup');
  }
}

async function deleteSetup(id, carId) {
  if (!confirm('Are you sure you want to delete this setup?')) {
    return;
  }
  
  try {
    await remove('setups', id);
    toast('Setup deleted');
    renderCarDetailPage();
  } catch (error) {
    console.error('❌ Failed to delete setup:', error);
    toast('Failed to delete setup');
  }
}

// Setup Detail Page
async function renderSetupDetailPage() {
  const app = document.getElementById('app');
  const hash = window.location.hash.slice(1);
  const setupId = hash.split('/')[2];
  
  if (!setupId) {
    window.location.hash = '#/garage';
    return;
  }
  
  app.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  
  try {
    const setup = await get('setups', setupId);
    
    if (!setup) {
      app.innerHTML = `
        <div class="page">
          <p>Setup not found</p>
          <button class="btn" onclick="window.location.hash='#/garage'">Back to Garage</button>
        </div>
      `;
      return;
    }
    
    // Load related data
    const car = await get('cars', setup.carId);
    const track = await get('tracks', setup.trackId);
    const allSetupsForCar = await queryIndex('setups', 'carId', setup.carId);
    const otherSetups = allSetupsForCar
      .filter(s => s.id !== setup.id)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const latestOther = otherSetups[0];
    const trackMap = {};
    await Promise.all(otherSetups.map(async s => {
      if (!trackMap[s.trackId]) {
        trackMap[s.trackId] = await get('tracks', s.trackId);
      }
    }));
    const setupData = normalizeSetupData(setup);
    
    const chassis = setupData.chassis;
    const suspension = setupData.suspension;
    const drivetrain = setupData.drivetrain;
    const tires = setupData.tires;
    const electronics = setupData.electronics;
    const general = setupData.general;
    
    // Helper to render a detail row only if value exists
    const renderRow = (label, value) => value ? `<div class="detail-row"><strong>${label}:</strong> ${escapeHtml(value)}</div>` : '';
    
    app.innerHTML = `
      <div class="page">
        <button class="btn-back" onclick="window.location.hash='#/car/${setup.carId}'">← Back to Car</button>
        
        <h2>Setup Details</h2>
        
        <div class="page-content" style="margin-bottom: 16px;">
          <div class="detail-row">
            <strong>Car:</strong> 
            <a href="#/car/${setup.carId}" style="color: var(--primary-color);">
              ${car ? escapeHtml(car.name) : 'Unknown Car'}
            </a>
          </div>
          <div class="detail-row">
            <strong>Track:</strong> ${track ? escapeHtml(track.name) : 'Unknown Track'}
          </div>
          ${setup.versionLabel ? `
            <div class="detail-row">
              <strong>Version:</strong> ${escapeHtml(setup.versionLabel)}
            </div>
          ` : ''}
          <div class="detail-row">
            <strong>Created:</strong> ${new Date(setup.createdAt).toLocaleString()}
          </div>
        </div>
        
        ${otherSetups.length ? `
          <div class="page-content" style="margin-bottom: 16px;">
            <div class="form-group">
              <label for="compareWithSelect">Compare with…</label>
              <select id="compareWithSelect" class="form-control">
                <option value="">Select setup</option>
                ${otherSetups.map(s => {
                  const t = trackMap[s.trackId];
                  const label = `${new Date(s.createdAt).toLocaleDateString()} — ${t ? t.name : 'Unknown Track'}${s.versionLabel ? ' — ' + s.versionLabel : ''}`;
                  return `<option value="${s.id}">${escapeHtml(label)}</option>`;
                }).join('')}
              </select>
            </div>
            ${latestOther ? `<button class="btn btn-secondary" id="compareLatestBtn">Compare to Latest</button>` : ''}
          </div>
        ` : `
          <div class="page-content" style="margin-bottom: 16px;">
            <p style="margin: 0; color: var(--text-secondary);">No other setups to compare.</p>
          </div>
        `}
        
        <!-- Chassis Section -->
        ${chassis.rideHeightF || chassis.rideHeightR || chassis.droopF || chassis.droopR || chassis.weightBalanceNotes ? `
          <h3 style="margin-top: 20px; color: var(--primary-color);">Chassis</h3>
          <div class="page-content" style="margin-bottom: 16px;">
            ${renderRow('Ride Height Front', chassis.rideHeightF)}
            ${renderRow('Ride Height Rear', chassis.rideHeightR)}
            ${renderRow('Droop Front', chassis.droopF)}
            ${renderRow('Droop Rear', chassis.droopR)}
            ${renderRow('Weight Balance', chassis.weightBalanceNotes)}
          </div>
        ` : ''}
        
        <!-- Suspension Section -->
        ${suspension.springsF || suspension.springsR || suspension.pistonsF || suspension.pistonsR || suspension.shockOilF || suspension.shockOilR || suspension.shockPosF || suspension.shockPosR || suspension.camberF || suspension.camberR || suspension.toeF || suspension.toeR ? `
          <h3 style="margin-top: 20px; color: var(--primary-color);">Suspension</h3>
          <div class="page-content" style="margin-bottom: 16px;">
            ${renderRow('Springs Front', suspension.springsF)}
            ${renderRow('Springs Rear', suspension.springsR)}
            ${renderRow('Pistons Front', suspension.pistonsF)}
            ${renderRow('Pistons Rear', suspension.pistonsR)}
            ${renderRow('Shock Oil Front', suspension.shockOilF)}
            ${renderRow('Shock Oil Rear', suspension.shockOilR)}
            ${renderRow('Shock Position Front', suspension.shockPosF)}
            ${renderRow('Shock Position Rear', suspension.shockPosR)}
            ${renderRow('Camber Front', suspension.camberF)}
            ${renderRow('Camber Rear', suspension.camberR)}
            ${renderRow('Toe Front', suspension.toeF)}
            ${renderRow('Toe Rear', suspension.toeR)}
          </div>
        ` : ''}
        
        <!-- Drivetrain Section -->
        ${drivetrain.pinion || drivetrain.spur || drivetrain.fdrNotes || drivetrain.diffType || drivetrain.diffOilF || drivetrain.diffOilR || drivetrain.centerDiffOil ? `
          <h3 style="margin-top: 20px; color: var(--primary-color);">Drivetrain</h3>
          <div class="page-content" style="margin-bottom: 16px;">
            ${renderRow('Pinion', drivetrain.pinion)}
            ${renderRow('Spur', drivetrain.spur)}
            ${renderRow('FDR Notes', drivetrain.fdrNotes)}
            ${renderRow('Diff Type', drivetrain.diffType)}
            ${renderRow('Diff Oil Front', drivetrain.diffOilF)}
            ${renderRow('Diff Oil Rear', drivetrain.diffOilR)}
            ${renderRow('Center Diff Oil', drivetrain.centerDiffOil)}
          </div>
        ` : ''}
        
        <!-- Tires Section -->
        ${tires.tireBrand || tires.tireCompound || tires.insert || tires.sauce || tires.prepNotes ? `
          <h3 style="margin-top: 20px; color: var(--primary-color);">Tires</h3>
          <div class="page-content" style="margin-bottom: 16px;">
            ${renderRow('Tire Brand', tires.tireBrand)}
            ${renderRow('Compound', tires.tireCompound)}
            ${renderRow('Insert', tires.insert)}
            ${renderRow('Sauce', tires.sauce)}
            ${renderRow('Prep Notes', tires.prepNotes)}
          </div>
        ` : ''}
        
        <!-- Electronics Section -->
        ${electronics.escProfile || electronics.timing || electronics.punch || electronics.motorNotes ? `
          <h3 style="margin-top: 20px; color: var(--primary-color);">Electronics</h3>
          <div class="page-content" style="margin-bottom: 16px;">
            ${renderRow('ESC Profile', electronics.escProfile)}
            ${renderRow('Timing', electronics.timing)}
            ${renderRow('Punch', electronics.punch)}
            ${renderRow('Motor Notes', electronics.motorNotes)}
          </div>
        ` : ''}
        
        <!-- General Section -->
        ${general.trackCondition || general.temp || general.notes ? `
          <h3 style="margin-top: 20px; color: var(--primary-color);">General</h3>
          <div class="page-content" style="margin-bottom: 16px;">
            ${renderRow('Track Condition', general.trackCondition)}
            ${renderRow('Temperature', general.temp)}
            ${general.notes ? `<div class="detail-row"><strong>Notes:</strong><br><span style="white-space: pre-wrap;">${escapeHtml(general.notes)}</span></div>` : ''}
          </div>
        ` : ''}
        
        <div style="margin-top: 16px; display: flex; gap: 8px;">
          <button class="btn" onclick="window.location.hash='#/car/${setup.carId}'; setTimeout(() => window.editSetup('${setup.id}'), 100)">Edit</button>
        </div>
      </div>
    `;

    if (otherSetups.length) {
      const compareSelect = document.getElementById('compareWithSelect');
      compareSelect?.addEventListener('change', (e) => {
        const val = e.target.value;
        if (val) {
          window.location.hash = `#/compare?carId=${setup.carId}&a=${setup.id}&b=${val}`;
        }
      });
      const compareLatestBtn = document.getElementById('compareLatestBtn');
      if (compareLatestBtn && latestOther) {
        compareLatestBtn.addEventListener('click', () => {
          window.location.hash = `#/compare?carId=${setup.carId}&a=${setup.id}&b=${latestOther.id}`;
        });
      }
    }
  } catch (error) {
    console.error('❌ Failed to load setup:', error);
    app.innerHTML = '<div class="page"><p>Failed to load setup details</p></div>';
    toast('Failed to load setup');
  }
}

// Compare Page
async function renderComparePage() {
  const app = document.getElementById('app');
  const urlParams = new URLSearchParams(window.location.hash.split('?')[1]);
  const carId = urlParams.get('carId');
  const preselectedA = urlParams.get('a');
  const preselectedB = urlParams.get('b');
  
  if (!carId) {
    app.innerHTML = `
      <div class="page">
        <p>No car specified for comparison</p>
        <button class="btn" onclick="window.location.hash='#/garage'">Back to Garage</button>
      </div>
    `;
    return;
  }
  
  app.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  
  try {
    const car = await get('cars', carId);
    if (!car) {
      app.innerHTML = `
        <div class="page">
          <p>Car not found</p>
          <button class="btn" onclick="window.location.hash='#/garage'">Back to Garage</button>
        </div>
      `;
      return;
    }
    
    // Load all setups for this car
    const setups = await queryIndex('setups', 'carId', carId);
    setups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    if (setups.length < 2) {
      app.innerHTML = `
        <div class="page">
          <button class="btn-back" onclick="window.location.hash='#/car/${carId}'">← Back to Car</button>
          <h2>Compare Setups</h2>
          <div class="empty-state">
            <div class="empty-state-icon">⚖️</div>
            <p class="empty-state-text">Need at least 2 setups to compare</p>
            <button class="btn" onclick="window.location.hash='#/car/${carId}'">Back to Car</button>
          </div>
        </div>
      `;
      return;
    }
    
    // Prepare setup options with labels
    const setupOptions = await Promise.all(setups.map(async setup => {
      const track = await get('tracks', setup.trackId);
      const trackName = track ? track.name : 'Unknown Track';
      const date = new Date(setup.createdAt).toLocaleString('en-US', { 
        month: 'short', 
        day: 'numeric', 
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      const versionLabel = setup.versionLabel ? ` — ${setup.versionLabel}` : '';
      return {
        id: setup.id,
        label: `${date} — ${trackName}${versionLabel}`
      };
    }));
    
    const renderDropdownOptions = (selectedId, excludeId) => {
      return `
        <option value="">Select setup...</option>
        ${setupOptions.map(opt => {
          const selected = opt.id === selectedId ? 'selected' : '';
          const disabled = opt.id === excludeId ? 'disabled' : '';
          return `<option value="${opt.id}" ${selected} ${disabled}>${escapeHtml(opt.label)}</option>`;
        }).join('')}
      `;
    };
    
    app.innerHTML = `
      <div class="page">
        <button class="btn-back" onclick="window.location.hash='#/car/${carId}'">← Back to Car</button>
        <h2>Compare Setups: ${escapeHtml(car.name)}</h2>
        
        <!-- Setup Selectors -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px;">
          <div class="form-group">
            <label for="setupA">Setup A</label>
            <select id="setupA" class="form-control">
              ${renderDropdownOptions(preselectedA, preselectedB)}
            </select>
          </div>
          
          <div class="form-group">
            <label for="setupB">Setup B</label>
            <select id="setupB" class="form-control">
              ${renderDropdownOptions(preselectedB, preselectedA)}
            </select>
          </div>
        </div>
        
        <div class="compare-controls">
          <label class="compare-toggle">
            <input type="checkbox" id="showChangesToggle"> Show only changes
          </label>
          <input type="search" id="compareSearch" class="form-control" placeholder="Search fields..." aria-label="Search fields">
        </div>

        <div class="compare-summary">
          <div class="compare-summary-actions">
            <button class="btn btn-secondary" id="generateSummaryBtn">Generate Change Summary</button>
            <button class="btn btn-secondary" id="copySummaryBtn">Copy to Clipboard</button>
            <button class="btn" id="cloneBBtn">Clone B as New Setup</button>
            <button class="btn" id="applyChangesBtn">Apply B changes to A → New</button>
          </div>
          <textarea id="summaryText" rows="6" readonly placeholder="Summary will appear here" aria-label="Change summary"></textarea>
        </div>
        
        <!-- Comparison Container -->
        <div id="comparisonContainer"></div>
      </div>
    `;
    
    // Attach event listeners
    const setupASelect = document.getElementById('setupA');
    const setupBSelect = document.getElementById('setupB');
    const showChangesToggle = document.getElementById('showChangesToggle');
    const searchInput = document.getElementById('compareSearch');
    const generateSummaryBtn = document.getElementById('generateSummaryBtn');
    const copySummaryBtn = document.getElementById('copySummaryBtn');
    const summaryTextArea = document.getElementById('summaryText');
    const cloneBBtn = document.getElementById('cloneBBtn');
    const applyChangesBtn = document.getElementById('applyChangesBtn');

    // Last computed data for actions
    let lastSetupA = null;
    let lastSetupB = null;
    let lastDataA = null;
    let lastDataB = null;
    let lastDiffRows = [];
    
    // Update URL query params without full page refresh
    const updateUrlParams = (aId, bId) => {
      const params = new URLSearchParams();
      params.set('carId', carId);
      if (aId) params.set('a', aId);
      if (bId) params.set('b', bId);
      
      const newHash = `#/compare?${params.toString()}`;
      history.replaceState(null, '', newHash);
    };
    
    // Update dropdown options to disable selected value in the other dropdown
    const updateDropdowns = () => {
      const aValue = setupASelect.value;
      const bValue = setupBSelect.value;
      
      // Update Setup A dropdown
      setupASelect.innerHTML = renderDropdownOptions(aValue, bValue);
      
      // Update Setup B dropdown
      setupBSelect.innerHTML = renderDropdownOptions(bValue, aValue);
    };

    const handleFilterChange = () => {
      renderComparison();
    };

    showChangesToggle.addEventListener('change', handleFilterChange);
    searchInput.addEventListener('input', handleFilterChange);
    generateSummaryBtn.addEventListener('click', () => {
      renderComparison();
      toast('Summary generated');
    });
    copySummaryBtn.addEventListener('click', async () => {
      const txt = summaryTextArea.value || '';
      try {
        await navigator.clipboard.writeText(txt);
        toast('Summary copied');
      } catch (err) {
        console.error('Clipboard copy failed', err);
        toast('Copy failed');
      }
    });

    const setDeepValue = (obj, path, value) => {
      const parts = path.split('.');
      let cur = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
        cur = cur[p];
      }
      cur[parts[parts.length - 1]] = value;
    };

    const saveNewSetup = async ({ baseSetup, data, versionLabel, notes }) => {
      if (!baseSetup) {
        toast('No setup selected');
        return;
      }
      const newSetup = {
        id: generateId('setup'),
        carId: baseSetup.carId,
        trackId: baseSetup.trackId,
        versionLabel: versionLabel || 'Derived',
        notes: notes || '',
        setupData: data,
        setupSchemaVersion: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await put('setups', newSetup);
      toast('New setup created');
    };

    cloneBBtn.addEventListener('click', async () => {
      if (!lastSetupB || !lastDataB) {
        toast('Compare two setups first');
        return;
      }
      const summary = summaryTextArea.value || '';
      const versionLabel = lastSetupB.versionLabel ? `Derived from ${lastSetupB.versionLabel}` : 'Derived';
      const notes = `${summary}\n\nCompared vs A on ${new Date().toLocaleString()}`;
      await saveNewSetup({ baseSetup: lastSetupB, data: structuredClone(lastDataB), versionLabel, notes });
    });

    applyChangesBtn.addEventListener('click', async () => {
      if (!lastSetupA || !lastDataA || !lastDiffRows.length) {
        toast('Compare two setups first');
        return;
      }
      const merged = structuredClone(lastDataA);
      lastDiffRows.filter(r => r.changed).forEach(r => setDeepValue(merged, r.path, r.bValue));
      const summary = summaryTextArea.value || '';
      const notes = `${summary}\n\nCompared vs B on ${new Date().toLocaleString()}`;
      await saveNewSetup({ baseSetup: lastSetupA, data: merged, versionLabel: 'A + B changes', notes });
    });
    
    const renderComparison = async () => {
      const setupAId = setupASelect.value;
      const setupBId = setupBSelect.value;
      const container = document.getElementById('comparisonContainer');
      
      // Update URL params
      updateUrlParams(setupAId, setupBId);
      
      // Update dropdowns to disable conflicting options
      updateDropdowns();
      
      if (!setupAId || !setupBId) {
        container.innerHTML = `
          <div class="empty-state">
            <p class="empty-state-text">Select two setups to compare</p>
          </div>
        `;
        return;
      }
      
      if (setupAId === setupBId) {
        container.innerHTML = `
          <div class="empty-state">
            <p class="empty-state-text">Please select different setups</p>
          </div>
        `;
        return;
      }
      
      const setupA = await get('setups', setupAId);
      const setupB = await get('setups', setupBId);
      
      if (!setupA || !setupB) {
        container.innerHTML = '<p>Failed to load setups</p>';
        return;
      }
      
      const trackA = await get('tracks', setupA.trackId);
      const trackB = await get('tracks', setupB.trackId);
      
      const normalizeSetup = (setup) => {
        const data = setup.setupData || {};
        const chassis = data.chassis || {};
        const suspension = data.suspension || {};
        const drivetrain = data.drivetrain || {};
        const tires = data.tires || {};
        const electronics = data.electronics || {};
        const general = data.general || {};
        return {
          chassis: {
            rideHeightF: chassis.rideHeightF || data.rideHeight || '',
            rideHeightR: chassis.rideHeightR || '',
            droopF: chassis.droopF || '',
            droopR: chassis.droopR || '',
            weightBalanceNotes: chassis.weightBalanceNotes || ''
          },
          suspension: {
            springsF: suspension.springsF || data.springs || '',
            springsR: suspension.springsR || '',
            pistonsF: suspension.pistonsF || '',
            pistonsR: suspension.pistonsR || '',
            shockOilF: suspension.shockOilF || data.shockOil || '',
            shockOilR: suspension.shockOilR || '',
            shockPosF: suspension.shockPosF || '',
            shockPosR: suspension.shockPosR || '',
            camberF: suspension.camberF || '',
            camberR: suspension.camberR || '',
            toeF: suspension.toeF || '',
            toeR: suspension.toeR || ''
          },
          drivetrain: {
            pinion: drivetrain.pinion || '',
            spur: drivetrain.spur || '',
            fdrNotes: drivetrain.fdrNotes || '',
            diffType: drivetrain.diffType || '',
            diffOilF: drivetrain.diffOilF || '',
            diffOilR: drivetrain.diffOilR || '',
            centerDiffOil: drivetrain.centerDiffOil || ''
          },
          tires: {
            tireBrand: tires.tireBrand || '',
            tireCompound: tires.tireCompound || '',
            insert: tires.insert || '',
            sauce: tires.sauce || '',
            prepNotes: tires.prepNotes || ''
          },
          electronics: {
            escProfile: electronics.escProfile || '',
            timing: electronics.timing || '',
            punch: electronics.punch || '',
            motorNotes: electronics.motorNotes || ''
          },
          general: {
            trackCondition: general.trackCondition || '',
            temp: general.temp || '',
            notes: general.notes || ''
          }
        };
      };
      
      const dataA = normalizeSetupData(setupA);
      const dataB = normalizeSetupData(setupB);
      lastSetupA = setupA;
      lastSetupB = setupB;
      lastDataA = dataA;
      lastDataB = dataB;
      
      const searchQuery = (document.getElementById('compareSearch').value || '').toLowerCase();
      const showOnlyChanges = document.getElementById('showChangesToggle').checked;
      
      const diffRows = diffObjects(dataA, dataB, { ignorePaths: [] });
      lastDiffRows = diffRows;
      const filteredRows = diffRows.filter(row => {
        if (showOnlyChanges && !row.changed) return false;
        if (searchQuery) {
          const hay = `${row.label} ${row.path}`.toLowerCase();
          if (!hay.includes(searchQuery)) return false;
        }
        return true;
      });

      // Build change summary text (all changed rows, regardless of search/filter)
      const buildSummary = (rows) => {
        const changed = rows.filter(r => r.changed);
        if (!changed.length) return 'No differences.';
        const byGroup = groupOrder.map(group => ({
          group,
          name: groupNames[group],
          rows: changed.filter(r => r.group === group)
        })).filter(g => g.rows.length);

        const fmt = (val) => (val === '' || val === null || val === undefined) ? '-' : String(val);

        const lines = [];
        byGroup.forEach(g => {
          lines.push(`${g.name}:`);
          g.rows.forEach(r => {
            lines.push(`- ${r.label || r.path}: ${fmt(r.aValue)} → ${fmt(r.bValue)}`);
          });
          lines.push('');
        });
        return lines.join('\n').trim();
      };

      if (summaryTextArea) {
        summaryTextArea.value = buildSummary(diffRows);
      }
      
      const groupOrder = ['chassis', 'suspension', 'drivetrain', 'tires', 'electronics', 'general'];
      const groupNames = {
        chassis: 'Chassis',
        suspension: 'Suspension',
        drivetrain: 'Drivetrain',
        tires: 'Tires',
        electronics: 'Electronics',
        general: 'General'
      };
      
      const formatValue = (val) => (val === '' || val === null || val === undefined)
        ? '<span class="muted">-</span>'
        : escapeHtml(String(val));
      
      const renderRow = (row) => `
        <div class="diff-row ${row.changed ? 'diff-changed' : ''}">
          <div class="diff-label">${escapeHtml(row.label || row.path)}</div>
          <div class="diff-values">
            <div class="diff-value diff-a"><span class="diff-chip">A</span>${formatValue(row.aValue)}</div>
            <div class="diff-value diff-b"><span class="diff-chip">B</span>${formatValue(row.bValue)}</div>
          </div>
        </div>
      `;
      
      const groupHtml = groupOrder.map(group => {
        const rows = filteredRows.filter(r => r.group === group);
        if (!rows.length) return '';
        const changedCount = rows.filter(r => r.changed).length;
        const summaryText = changedCount ? `${groupNames[group]} (${changedCount} change${changedCount === 1 ? '' : 's'})` : groupNames[group];
        return `
          <details class="diff-group" open>
            <summary>${summaryText}</summary>
            <div class="diff-rows">
              ${rows.map(renderRow).join('')}
            </div>
          </details>
        `;
      }).join('');
      
      const headerHtml = `
        <div class="compare-meta">
          <div>
            <div class="compare-meta-title">Setup A</div>
            <div class="compare-meta-sub">${trackA ? escapeHtml(trackA.name) : 'Unknown Track'}${setupA.versionLabel ? ' - ' + escapeHtml(setupA.versionLabel) : ''}</div>
            <div class="compare-meta-date">${new Date(setupA.createdAt).toLocaleString()}</div>
          </div>
          <div>
            <div class="compare-meta-title">Setup B</div>
            <div class="compare-meta-sub">${trackB ? escapeHtml(trackB.name) : 'Unknown Track'}${setupB.versionLabel ? ' - ' + escapeHtml(setupB.versionLabel) : ''}</div>
            <div class="compare-meta-date">${new Date(setupB.createdAt).toLocaleString()}</div>
          </div>
        </div>
      `;
      
      container.innerHTML = headerHtml + (groupHtml || `
        <div class="empty-state">
          <p class="empty-state-text">No fields match the current filters.</p>
        </div>
      `);
    };
    
    // Event handler function
    const handleSelectionChange = async () => {
      await renderComparison();
    };
    
    setupASelect.addEventListener('change', handleSelectionChange);
    setupBSelect.addEventListener('change', handleSelectionChange);
    
    // Initial render if both preselected
    if (preselectedA || preselectedB) {
      await renderComparison();
    }
    
  } catch (error) {
    console.error('❌ Failed to load compare page:', error);
    app.innerHTML = '<div class="page"><p>Failed to load comparison</p></div>';
    toast('Failed to load comparison');
  }
}

// Track Form Helpers
function showTrackForm(track = null) {
  const form = document.getElementById('trackForm');
  const formTitle = document.getElementById('trackFormTitle');
  
  if (track) {
    // Edit mode
    formTitle.textContent = 'Edit Track';
    document.getElementById('trackId').value = track.id;
    document.getElementById('trackName').value = track.name || '';
    document.getElementById('trackAddress').value = track.address || '';
    // Remove lat/lng fields
    // document.getElementById('trackLat').value = track.lat || '';
    // document.getElementById('trackLng').value = track.lng || '';
    document.getElementById('trackWebsiteUrl').value = track.websiteUrl || '';
    document.getElementById('trackSurface').value = track.surface || '';
    document.getElementById('trackLiveRcUrl').value = track.liveRcUrl || '';
    document.getElementById('trackNotes').value = track.notes || '';
  } else {
    // Add mode
    formTitle.textContent = 'Add Track';
    document.getElementById('trackFormElement').reset();
    document.getElementById('trackId').value = '';
    document.getElementById('trackWebsiteUrl').value = '';
  }
  
  form.style.display = 'block';
  document.getElementById('trackName').focus();
}

function hideTrackForm() {
  document.getElementById('trackForm').style.display = 'none';
  document.getElementById('trackFormElement').reset();
}

async function handleTrackSubmit(e) {
  e.preventDefault();
  
  const id = document.getElementById('trackId').value;
  const trackData = {
    id: id || generateId('track'),
    name: document.getElementById('trackName').value.trim(),
    address: document.getElementById('trackAddress').value.trim(),
    websiteUrl: document.getElementById('trackWebsiteUrl').value.trim(),
    surface: document.getElementById('trackSurface').value.trim(),
    liveRcUrl: document.getElementById('trackLiveRcUrl').value.trim(),
    notes: document.getElementById('trackNotes').value.trim(),
    updatedAt: new Date().toISOString()
  };
  
  // Add createdAt for new tracks
  if (!id) {
    trackData.createdAt = trackData.updatedAt;
  }
  
  try {
    await put('tracks', trackData);
    toast(id ? 'Track updated!' : 'Track added!');
    hideTrackForm();
    renderTracksPage();
  } catch (error) {
    console.error('❌ Failed to save track:', error);
    toast('Failed to save track');
  }
}

async function editTrack(id) {
  try {
    const track = await get('tracks', id);
    if (track) {
      showTrackForm(track);
    } else {
      toast('Track not found');
    }
  } catch (error) {
    console.error('❌ Failed to load track:', error);
    toast('Failed to load track');
  }
}

async function deleteTrack(id) {
  if (!confirm('Are you sure you want to delete this track?')) {
    return;
  }
  
  try {
    await remove('tracks', id);
    toast('Track deleted');
    renderTracksPage();
  } catch (error) {
    console.error('❌ Failed to delete track:', error);
    toast('Failed to delete track');
  }
}

// Track Detail Page
async function renderTrackDetailPage() {
  const app = document.getElementById('app');
  const hash = window.location.hash.slice(1);
  const trackId = hash.split('/')[2];
  
  if (!trackId) {
    window.location.hash = '#/tracks';
    return;
  }
  
  app.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  
  try {
    const track = await get('tracks', trackId);
    
    if (!track) {
      app.innerHTML = `
        <div class="page">
          <p>Track not found</p>
          <button class="btn" onclick="window.location.hash='#/tracks'">Back to Tracks</button>
        </div>
      `;
      return;
    }
    
    // Generate maps URLs
    let appleMapsUrl = '';
    let googleMapsUrl = '';
    
    if (track.address) {
      // Use address for search
      const searchQuery = encodeURIComponent(`${track.name} ${track.address}`);
      appleMapsUrl = `https://maps.apple.com/?q=${searchQuery}`;
      googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${searchQuery}`;
    }
    
    app.innerHTML = `
      <div class="page">
        <button class="btn-back" onclick="window.location.hash='#/tracks'">← Back to Tracks</button>
        
        <h2>${escapeHtml(track.name)}</h2>
        
        <div class="page-content" style="margin-bottom: 16px;">
          ${track.surface ? `
            <div class="detail-row">
              <strong>Surface:</strong> ${escapeHtml(track.surface)}
            </div>
          ` : ''}
          ${track.address ? `
            <div class="detail-row">
              <strong>Address:</strong> ${escapeHtml(track.address)}
            </div>
          ` : ''}
          ${track.websiteUrl ? `
            <div class="detail-row">
              <strong>Website:</strong> <a href="${escapeHtml(track.websiteUrl)}" target="_blank" rel="noopener noreferrer" style="color: var(--primary-color); word-break: break-all;">${escapeHtml(track.websiteUrl)}</a>
            </div>
          ` : ''}
          <!-- Coordinates removed -->
          ${track.notes ? `
            <div class="detail-row">
              <strong>Notes:</strong><br>
              <p style="margin-top: 8px; white-space: pre-wrap;">${escapeHtml(track.notes)}</p>
            </div>
          ` : ''}
        </div>
        
        <!-- Action Buttons -->
        <div style="display: flex; flex-direction: column; gap: 12px;">
          ${appleMapsUrl ? `
            <div>
              <h3 style="font-size: 16px; margin-bottom: 8px;">Open in Maps</h3>
              <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                <a href="${appleMapsUrl}" target="_blank" class="btn" style="text-decoration: none;">🍎 Apple Maps</a>
                <a href="${googleMapsUrl}" target="_blank" class="btn" style="text-decoration: none;">🌎 Google Maps</a>
              </div>
            </div>
          ` : ''}
          
          ${track.websiteUrl ? `
            <div>
              <h3 style="font-size: 16px; margin-bottom: 8px;">Track Website</h3>
              <a href="${escapeHtml(track.websiteUrl)}" target="_blank" rel="noopener noreferrer" class="btn" style="text-decoration: none;">
                🌐 Visit Website
              </a>
            </div>
          ` : ''}
          
          ${track.liveRcUrl ? `
            <div>
              <h3 style="font-size: 16px; margin-bottom: 8px;">Live Stream</h3>
              <a href="${escapeHtml(track.liveRcUrl)}" target="_blank" rel="noopener noreferrer" class="btn" style="text-decoration: none;">
                📺 Open LiveRC
              </a>
            </div>
          ` : ''}
          
          <div style="margin-top: 8px;">
            <button class="btn" onclick="window.location.hash='#/tracks'; setTimeout(() => window.editTrack('${track.id}'), 100)">Edit Track</button>
          </div>
        </div>
        
        ${track.createdAt ? `
          <div style="margin-top: 24px;">
            <small style="color: var(--text-secondary);">Created: ${new Date(track.createdAt).toLocaleString()}</small>
          </div>
        ` : ''}
        
        <!-- Track Usage & Stats -->
        <div class="page-content" style="margin-top: 24px;">
          <h3>Track Usage & Stats</h3>

          <div class="analytics-kpi-grid" style="margin-bottom: 12px;">
            <div class="kpi-card">
              <div class="kpi-label">Best Lap</div>
              <div class="kpi-value" id="trackBestLapKpi">-</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label">Avg Lap</div>
              <div class="kpi-value" id="trackAvgLapKpi">-</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label"># Runs</div>
              <div class="kpi-value" id="trackRunCountKpi">0</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label"># Events</div>
              <div class="kpi-value" id="trackEventCountKpi">0</div>
            </div>
          </div>

          <div style="margin-top: 12px;">
            <h4>Top Cars</h4>
            <div id="trackTopCarsTable" style="overflow-x: auto;"></div>
          </div>
        </div>
      </div>
    `;
    
    // Load analytics for this track and render stats/charts (non-blocking, track-scoped)
    (async () => {
      try {
        console.log('🔄 Analytics IIFE starting for trackId:', trackId);
        const analytics = await loadAnalyticsData({ forceRefresh: false });
        const { cars, events, tracks, enrichedRuns, carsById } = analytics;
        
        console.log('📊 Loaded analytics, enrichedRuns count:', enrichedRuns.length);

        const { filteredRuns, kpis, trendSeries } = aggregateRuns({
          runs: enrichedRuns,
          events,
          tracks,
          cars,
          filters: { trackId }  // <- Track-specific filter
        });

        console.log('📈 Aggregation result:', { filteredRuns: filteredRuns.length, kpis });
        console.log('📊 Trend series:', {
          trendArray: trendSeries?.length || 0
        });

        // Populate KPI fields
        const bestEl = document.getElementById('trackBestLapKpi');
        if (bestEl) {
          const bestText = kpis.bestLapMin !== null ? formatLapTime(kpis.bestLapMin) : '-';
          console.log('✏️ Setting bestEl.textContent to:', bestText);
          bestEl.textContent = bestText;
        }

        const avgEl = document.getElementById('trackAvgLapKpi');
        if (avgEl) {
          const avgText = kpis.avgLapMean !== null ? formatLapTime(kpis.avgLapMean) : '-';
          avgEl.textContent = avgText;
        }

        const runCountEl = document.getElementById('trackRunCountKpi');
        if (runCountEl) {
          runCountEl.textContent = String(kpis.runCount || 0);
        }

        const eventCountEl = document.getElementById('trackEventCountKpi');
        if (eventCountEl) {
          eventCountEl.textContent = String(kpis.eventCount || 0);
        }

        // Render top cars table
        const byCarId = {};
        filteredRuns.forEach(run => {
          if (run.carId) {
            byCarId[run.carId] = (byCarId[run.carId] || 0) + 1;
          }
        });
        
        if (filteredRuns.length > 0 && Object.keys(byCarId).length > 0) {
          const topCars = Object.entries(byCarId)
            .map(([carId, count]) => ({ carId, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

          if (topCars.length > 0) {
            const tableContainer = document.getElementById('trackTopCarsTable');
            if (tableContainer) {
              const tableHtml = `
                <table style="width: 100%; border-collapse: collapse;">
                  <thead style="background: var(--surface-secondary);">
                    <tr>
                      <th style="text-align: left; padding: 8px; border-bottom: 1px solid var(--border-color);">Car</th>
                      <th style="text-align: right; padding: 8px; border-bottom: 1px solid var(--border-color);">Runs</th>
                      <th style="text-align: right; padding: 8px; border-bottom: 1px solid var(--border-color);">Best Lap</th>
                      <th style="text-align: right; padding: 8px; border-bottom: 1px solid var(--border-color);">Avg Lap</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${topCars.map(({ carId, count }) => {
                      const car = cars.find(c => c.id === carId);
                      const carRuns = filteredRuns.filter(r => r.carId === carId);
                      const carBest = carRuns.length > 0 
                        ? Math.min(...carRuns.map(r => parseLap(r.bestLap)).filter(b => b !== null && b !== undefined))
                        : null;
                      const carAvg = carRuns.length > 0
                        ? carRuns.reduce((sum, r) => sum + (parseLap(r.avgLap) || 0), 0) / carRuns.length
                        : null;

                      return `
                        <tr style="border-bottom: 1px solid var(--border-color);">
                          <td style="padding: 8px;">
                            <a href="#/car/${carId}" style="color: var(--primary-color); text-decoration: none;">
                              ${car ? escapeHtml(car.name) : carId}
                            </a>
                          </td>
                          <td style="text-align: right; padding: 8px;">${count}</td>
                          <td style="text-align: right; padding: 8px;">${carBest !== null ? formatLapTime(carBest) : '-'}</td>
                          <td style="text-align: right; padding: 8px;">${carAvg !== null ? formatLapTime(carAvg) : '-'}</td>
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                </table>
              `;
              tableContainer.innerHTML = tableHtml;
            }
          }
        }

        console.log('✅ Track analytics loaded and rendered successfully');
      } catch (err) {
        console.warn('❌ Failed to load track analytics in track detail:', err);
      }
    })();
    
  } catch (error) {
    console.error('❌ Failed to load track:', error);
    app.innerHTML = '<div class="page"><p>Failed to load track details</p></div>';
    toast('Failed to load track');
  }
}

// Event Form Helpers
function showEventForm(event = null) {
  const form = document.getElementById('eventForm');
  const formTitle = document.getElementById('eventFormTitle');
  
  if (event) {
    // Edit mode
    formTitle.textContent = 'Edit Event';
    document.getElementById('eventId').value = event.id;
    document.getElementById('eventTitle').value = event.title || '';
    document.getElementById('eventTrackId').value = event.trackId || '';
    document.getElementById('eventDate').value = event.date || '';
    document.getElementById('eventStartTime').value = event.startTime || '';
    document.getElementById('eventLiveRcUrl').value = event.liveRcEventUrl || '';
    document.getElementById('eventNotes').value = event.notes || '';
  } else {
    // Add mode
    formTitle.textContent = 'Add Event';
    document.getElementById('eventFormElement').reset();
    document.getElementById('eventId').value = '';
  }

  // Sync car selections for the event (add: none selected; edit: selected IDs checked)
  const carCheckboxes = document.querySelectorAll('input[name="eventCars"]');
  if (carCheckboxes && carCheckboxes.length > 0) {
    const selectedIds = Array.isArray(event?.carIds) ? event.carIds : [];
    carCheckboxes.forEach(cb => {
      cb.checked = selectedIds.includes(cb.value);
    });
  }
  
  form.style.display = 'block';
  document.getElementById('eventTitle').focus();
}

function hideEventForm() {
  document.getElementById('eventForm').style.display = 'none';
  document.getElementById('eventFormElement').reset();
}

async function handleEventSubmit(e) {
  e.preventDefault();
  
  const id = document.getElementById('eventId').value;
  const selectedCarIds = Array.from(document.querySelectorAll('input[name="eventCars"]:checked')).map(cb => cb.value);
  const eventData = {
    id: id || generateId('event'),
    title: document.getElementById('eventTitle').value.trim(),
    trackId: document.getElementById('eventTrackId').value,
    date: document.getElementById('eventDate').value,
    startTime: document.getElementById('eventStartTime').value,
    liveRcEventUrl: document.getElementById('eventLiveRcUrl').value.trim(),
    notes: document.getElementById('eventNotes').value.trim(),
    carIds: selectedCarIds,
    updatedAt: new Date().toISOString()
  };
  
  // Add createdAt for new events
  if (!id) {
    eventData.createdAt = eventData.updatedAt;
  }
  
  try {
    await put('events', eventData);
    toast(id ? 'Event updated!' : 'Event added!');
    hideEventForm();
    renderEventsPage();
  } catch (error) {
    console.error('❌ Failed to save event:', error);
    toast('Failed to save event');
  }
}

async function editEvent(id) {
  try {
    const event = await get('events', id);
    if (event) {
      showEventForm(event);
    } else {
      toast('Event not found');
    }
  } catch (error) {
    console.error('❌ Failed to load event:', error);
    toast('Failed to load event');
  }
}

async function deleteEvent(id) {
  if (!confirm('Are you sure you want to delete this event?')) {
    return;
  }
  
  try {
    await remove('events', id);
    toast('Event deleted');
    renderEventsPage();
  } catch (error) {
    console.error('❌ Failed to delete event:', error);
    toast('Failed to delete event');
  }
}

// ICS Calendar Export Helper
function createIcs(event, track) {
  // Parse the date
  const eventDate = parseDateStringAsLocal(event.date);
  
  // Set start time (default to 09:00 if not provided)
  const startTime = event.startTime || '09:00';
  const [hours, minutes] = startTime.split(':').map(Number);
  eventDate.setHours(hours, minutes, 0, 0);
  
  // Calculate end time (8 hours later)
  const endDate = new Date(eventDate);
  endDate.setHours(endDate.getHours() + 8);
  
  // Format dates for ICS (YYYYMMDDTHHmmss)
  const formatIcsDate = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const sec = String(date.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}T${hour}${min}${sec}`;
  };
  
  const dtstart = formatIcsDate(eventDate);
  const dtend = formatIcsDate(endDate);
  const dtstamp = formatIcsDate(new Date());
  
  // Build location string
  let location = '';
  if (track) {
    location = track.name;
    if (track.address) {
      location += `, ${track.address}`;
    }
  }
  
  // Escape special characters for ICS
  const escapeIcs = (str) => {
    return str.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  };
  
  // Build ICS content
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RC Race Program//Event//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.id}@rcprogram.local`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `SUMMARY:${escapeIcs(event.title)}`,
    location ? `LOCATION:${escapeIcs(location)}` : '',
    event.notes ? `DESCRIPTION:${escapeIcs(event.notes)}` : '',
    event.liveRcEventUrl ? `URL:${event.liveRcEventUrl}` : '',
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(line => line).join('\r\n');
  
  return ics;
}

// Download ICS file
function downloadIcs(event, track) {
  const icsContent = createIcs(event, track);
  const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${event.title.replace(/[^a-z0-9]/gi, '_')}.ics`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  toast('Calendar file downloaded!');
}

// CSV Export Helper
function downloadCsv(filename, rows) {
  // Escape CSV field (handle quotes, commas, newlines)
  const escapeCsvField = (field) => {
    if (field === null || field === undefined) {
      return '';
    }
    
    const str = String(field);
    
    // If field contains comma, quote, or newline, wrap in quotes and escape internal quotes
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    
    return str;
  };
  
  // Convert rows to CSV format
  const csvContent = rows.map(row => 
    row.map(field => escapeCsvField(field)).join(',')
  ).join('\n');
  
  // Trigger browser download
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  toast('CSV file downloaded!');
}

  // Export analytics filtered data to CSV
  function exportAnalyticsCsv(filteredRuns, analyticsContext, filters) {
    const { carsById, tracksById, eventsById } = analyticsContext;
  
    // Build header row
    const header = ['Event Date', 'Track', 'Car', 'Session Type', 'Best Lap', 'Avg Lap', 'Setup ID', 'Notes'];
  
    // Map filtered runs to data rows
    const dataRows = filteredRuns.map(run => {
      const event = eventsById[run.eventId] || {};
      const track = tracksById[event.trackId] || {};
      const car = carsById[run.carId] || {};
    
      // Format date
      const eventDate = event.date ? formatDateForDisplay(event.date) : '';
    
      // Format lap times
      const bestLap = run.bestLapNum ? run.bestLapNum.toFixed(3) : '';
      const avgLap = run.avgLapNum ? run.avgLapNum.toFixed(3) : '';
    
      return [
        eventDate,
        track.name || '',
        car.name || '',
        run.sessionType || '',
        bestLap,
        avgLap,
        run.setupId || '',
        run.notes || ''
      ];
    });
  
    // Combine header and data
    const csvRows = [header, ...dataRows];
  
    // Generate filename with date and filter summary
    const today = new Date().toISOString().split('T')[0];
    let filterSummary = '';
  
    if (filters.carId) {
      const car = carsById[filters.carId];
      filterSummary += '_car-' + (car?.name || filters.carId).replace(/\s+/g, '-');
    }
    if (filters.trackId) {
      const track = tracksById[filters.trackId];
      filterSummary += '_track-' + (track?.name || filters.trackId).replace(/\s+/g, '-');
    }
    if (filters.sessionType) {
      filterSummary += '_' + filters.sessionType;
    }
    if (filters.dateFrom || filters.dateTo) {
      filterSummary += '_dates';
    }
  
    const filename = `analytics_${today}${filterSummary || '_all'}.csv`;
  
    // Trigger download
    downloadCsv(filename, csvRows);
  }

// Event Detail Page with Run Logs
async function renderEventDetailPage() {
  const app = document.getElementById('app');
  const hash = window.location.hash.slice(1);
  const eventId = hash.split('/')[2];
  
  if (!eventId) {
    window.location.hash = '#/events';
    return;
  }
  
  app.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  
  try {
    const event = await get('events', eventId);
    
    if (!event) {
      app.innerHTML = `
        <div class="page">
          <p>Event not found</p>
          <button class="btn" onclick="window.location.hash='#/events'">Back to Events</button>
        </div>
      `;
      return;
    }
    
    // Load track data
    const track = await get('tracks', event.trackId);
    
    // Load cars for the select dropdown
    const cars = await getAll('cars');
    cars.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    const eventCars = Array.isArray(event.carIds) ? cars.filter(car => event.carIds.includes(car.id)) : [];
    const allowedCars = eventCars.length > 0 ? eventCars : cars;
    
    // Load run logs for this event
    let runLogs = await queryIndex('runLogs', 'eventId', eventId);
    
    // Sort by createdAt, newest first
    runLogs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    // Get selected car filter from state
    const selectedCarFilter = state.runLogCarFilter || '';
    
    // Filter by car if selected
    const filteredRunLogs = selectedCarFilter 
      ? runLogs.filter(log => log.carId === selectedCarFilter)
      : runLogs;
    
    // Format date (parse date-only strings as local dates to avoid timezone shift)
    const eventDate = parseDateStringAsLocal(event.date);
    const dateStr = eventDate ? eventDate.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }) : '';
    
    app.innerHTML = `
      <div class="page">
        <button class="btn-back" onclick="window.location.hash='#/events'">← Back to Events</button>
        
        <h2>${escapeHtml(event.title)}</h2>
        
        <div class="page-content" style="margin-bottom: 16px;">
          <div class="detail-row">
            <strong>Track:</strong> 
            ${track ? `<a href="#/track/${track.id}" style="color: var(--primary-color);">${escapeHtml(track.name)}</a>` : 'Unknown Track'}
          </div>
          <div class="detail-row">
            <strong>Date:</strong> ${dateStr}
          </div>
          ${event.startTime ? `
            <div class="detail-row">
              <strong>Start Time:</strong> ${event.startTime}
            </div>
          ` : ''}
          ${track && track.address ? `
            <div class="detail-row">
              <strong>Location:</strong> ${escapeHtml(track.address)}
            </div>
          ` : ''}
          ${event.notes ? `
            <div class="detail-row">
              <strong>Notes:</strong><br>
              <p style="margin-top: 8px; white-space: pre-wrap;">${escapeHtml(event.notes)}</p>
            </div>
          ` : ''}
          <div class="detail-row">
            <strong>Event Cars:</strong><br>
            ${eventCars.length ? `
              <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:6px;">
                ${eventCars.map(car => `
                  <span style="border:1px solid var(--border-color); border-radius:12px; padding:6px 10px; display:inline-flex; gap:6px; align-items:center;">
                    ${escapeHtml(car.name)}
                    ${car.transponder ? `<span style="color: var(--text-secondary); font-size:12px;">(${escapeHtml(car.transponder)})</span>` : ''}
                  </span>
                `).join('')}
              </div>
            ` : `<span style="color: var(--text-secondary);">No cars selected for this event.</span>`}
          </div>
        </div>
        
        <!-- Action Buttons -->
        <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 24px;">
          <button class="btn" id="exportIcsBtn">📅 Export to Calendar</button>
          <button class="btn" onclick="window.location.hash='#/events'; setTimeout(() => window.editEvent('${event.id}'), 100)">Edit Event</button>
          ${event.liveRcEventUrl ? `
            <a href="${escapeHtml(event.liveRcEventUrl)}" target="_blank" rel="noopener noreferrer" class="btn" style="text-decoration: none;">
              📺 Open LiveRC
            </a>
          ` : ''}
        </div>

        <!-- LiveRC Link -->
        ${event.liveRcEventUrl ? `
          <div class="page-content" style="margin-bottom: 24px;">
            <h3 style="margin-bottom: 12px;">LiveRC Event</h3>
            <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 8px;">
              Quick reference link to the LiveRC event page.
            </p>
            <a href="${escapeHtml(event.liveRcEventUrl)}" target="_blank" rel="noopener noreferrer" class="btn" style="text-decoration: none;">
              📺 View on LiveRC
            </a>
          </div>
        ` : ''}
        
        <!-- Run Logs Section -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h3 style="margin: 0;">Run Logs</h3>
          <button class="btn" id="addRunLogBtn">+ Add Run Log</button>
        </div>
        
        <!-- Run Log Form (hidden by default) -->
        <div id="runLogForm" style="display: none;" class="page-content" style="margin-bottom: 16px;">
          <h4 id="runLogFormTitle">Add Run Log</h4>
          <div id="runLogEditIndicator" style="color: var(--text-secondary); font-size: 13px; margin-bottom: 8px; display: none;">Editing existing log</div>
          <form id="runLogFormElement">
            <input type="hidden" id="runLogId" value="">
            <input type="hidden" id="runLogEventId" value="${eventId}">
            <div class="form-group">
              <label for="runLogCarId">Car *</label>
              ${allowedCars.length === 0 ? `
                <p style="color: var(--text-secondary); font-size: 14px; margin: 8px 0;">
                  No cars available. <a href="#/garage" style="color: var(--primary-color);">Add cars first</a>
                </p>
              ` : `
                <select id="runLogCarId" required>
                  <option value="">Select a car...</option>
                  ${allowedCars.map(car => `<option value="${car.id}">${escapeHtml(car.name)}</option>`).join('')}
                </select>
                <div id="runLogCarHint" class="form-hint" style="display:none;">Locked during edit to keep log consistent.</div>
              `}
            </div>
            <div class="form-group">
              <label for="runLogSessionType">Session Type *</label>
              <select id="runLogSessionType" required>
                <option value="">Select session...</option>
                <option value="Practice">Practice</option>
                <option value="Q1">Q1</option>
                <option value="Q2">Q2</option>
                <option value="Q3">Q3</option>
                <option value="Main">Main</option>
                <option value="Other">Other</option>
              </select>
              <div id="runLogSessionHint" class="form-hint" style="display:none;">Locked during edit; choose the right session when adding.</div>
            </div>
            <div class="form-group">
              <label for="runLogSetupId">Setup Used (optional)</label>
              <select id="runLogSetupId">
                <option value="">No setup recorded</option>
              </select>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
              <div class="form-group">
                <label for="runLogBestLap">Best Lap</label>
                <input type="text" id="runLogBestLap" placeholder="e.g. 15.2">
              </div>
              <div class="form-group">
                <label for="runLogTime">Time</label>
                <input type="text" id="runLogTime" placeholder="e.g. 5:01.121 or 375.5">
              </div>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
              <div class="form-group">
                <label for="runLogTotalLaps">Total Laps</label>
                <input type="number" id="runLogTotalLaps" min="0" placeholder="e.g. 25">
              </div>
              <div class="form-group">
                <label for="runLogPosition">Position</label>
                <input type="text" id="runLogPosition" placeholder="e.g. 1st, P2, DNF">
              </div>
            </div>
            <div class="form-group">
              <label for="runLogNotes">Notes</label>
              <textarea id="runLogNotes" rows="3" placeholder="Run notes, observations, issues..."></textarea>
            </div>
            <div style="display: flex; gap: 8px;">
              <button type="submit" id="runLogSubmitBtn" class="btn" ${cars.length === 0 ? 'disabled' : ''}>Save Run Log</button>
              <button type="button" class="btn btn-secondary" id="cancelRunLogBtn">Cancel</button>
            </div>
          </form>
        </div>
        
        <!-- Car Filter -->
        ${runLogs.length > 0 ? `
          <div class="form-group" style="margin-bottom: 16px;">
            <label for="carFilter">Filter by Car</label>
            <select id="carFilter">
              <option value="">All Cars</option>
              ${(eventCars.length ? eventCars : cars).map(car => `<option value="${car.id}" ${selectedCarFilter === car.id ? 'selected' : ''}>${escapeHtml(car.name)}</option>`).join('')}
            </select>
          </div>
        ` : ''}
        
        <!-- Run Logs List -->
        <div id="runLogList">
          ${filteredRunLogs.length === 0 ? `
            <div class="empty-state">
              <div class="empty-state-icon">🏁</div>
              <p class="empty-state-text">${runLogs.length === 0 ? 'No run logs recorded yet' : 'No run logs for selected car'}</p>
            </div>
          ` : `
            <div class="runlog-list">
              ${await Promise.all(filteredRunLogs.map(async log => {
                const car = await get('cars', log.carId);
                const carName = car ? car.name : 'Unknown Car';
                return `
                  <div class="runlog-item" data-id="${log.id}">
                    <div class="runlog-info">
                      <h4 class="runlog-header">${escapeHtml(carName)} - ${escapeHtml(log.sessionType)}</h4>
                      <div class="runlog-stats">
                        ${log.bestLap ? `<span class="stat-badge">Best: ${escapeHtml(log.bestLap)}</span>` : ''}
                        ${log.time ? `<span class="stat-badge">Time: ${log.time.toFixed(2)}s</span>` : ''}
                        ${log.totalLaps ? `<span class="stat-badge">${log.totalLaps} laps</span>` : ''}
                        ${log.avgLap ? `<span class="stat-badge">Avg: ${escapeHtml(log.avgLap)}</span>` : ''}
                        ${log.position ? `<span class="stat-badge">Position: ${escapeHtml(log.position)}</span>` : ''}
                      </div>
                      ${log.notes ? `<p class="runlog-notes">${escapeHtml(log.notes)}</p>` : ''}
                      <p class="runlog-date">${new Date(log.createdAt).toLocaleString()}</p>
                    </div>
                    <div class="runlog-actions">
                      <button class="btn-icon" data-action="edit" data-id="${log.id}" title="Edit">✏️</button>
                      <button class="btn-icon" data-action="delete" data-id="${log.id}" title="Delete">🗑️</button>
                    </div>
                  </div>
                `;
              })).then(items => items.join(''))}
            </div>
          `}
        </div>
      </div>
    `;
    
    // Attach export button listener
    document.getElementById('exportIcsBtn')?.addEventListener('click', () => {
      downloadIcs(event, track);
    });
    
    // Attach run log event listeners
    document.getElementById('addRunLogBtn')?.addEventListener('click', () => showRunLogForm(eventId));
    document.getElementById('cancelRunLogBtn')?.addEventListener('click', hideRunLogForm);
    document.getElementById('runLogFormElement')?.addEventListener('submit', handleRunLogSubmit);
    
    // Setup dropdown population when car changes
    document.getElementById('runLogCarId')?.addEventListener('change', async (e) => {
      const carId = e.target.value;
      const setupSelect = document.getElementById('runLogSetupId');
      
      if (!carId || !setupSelect) return;
      
      try {
        const setups = await queryIndex('setups', 'carId', carId);
        setups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        setupSelect.innerHTML = `
          <option value="">No setup recorded</option>
          ${setups.map(setup => `
            <option value="${setup.id}">${escapeHtml(setup.name || 'Unnamed Setup')} (${new Date(setup.createdAt).toLocaleDateString()})</option>
          `).join('')}
        `;
      } catch (error) {
        console.error('Failed to load setups:', error);
      }
    });
    
    // Attach car filter listener
    document.getElementById('carFilter')?.addEventListener('change', (e) => {
      state.runLogCarFilter = e.target.value;
      renderEventDetailPage();
    });
    
    // Attach run log action buttons (edit/delete)
    document.querySelectorAll('.runlog-item .btn-icon').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = e.currentTarget.dataset.action;
        const id = e.currentTarget.dataset.id;
        
        if (action === 'delete') {
          deleteRunLog(id, eventId);
        } else if (action === 'edit') {
          const runLog = (typeof filteredRunLogs !== 'undefined' ? filteredRunLogs.find(l => l.id === id) : null) 
            || (typeof runLogs !== 'undefined' ? runLogs.find(l => l.id === id) : null);
          if (runLog) {
            showRunLogForm(eventId, runLog);
          } else {
            toast('Run log not found');
          }
        }
      });
    });
    
  } catch (error) {
    console.error('❌ Failed to load event:', error);
    app.innerHTML = '<div class="page"><p>Failed to load event details</p></div>';
    toast('Failed to load event');
  }
}

// Run Log Form Helpers
function showRunLogForm(eventId, runLog = null) {
  const form = document.getElementById('runLogForm');
  const formTitle = document.getElementById('runLogFormTitle');
  const submitBtn = document.getElementById('runLogSubmitBtn');
  const cancelBtn = document.getElementById('cancelRunLogBtn');
  const editIndicator = document.getElementById('runLogEditIndicator');
  const carEl = document.getElementById('runLogCarId');
  const sessionEl = document.getElementById('runLogSessionType');
  const carHint = document.getElementById('runLogCarHint');
  const sessionHint = document.getElementById('runLogSessionHint');
  
  if (runLog) {
    // Edit mode
    formTitle.textContent = 'Edit Run Log';
    if (submitBtn) submitBtn.textContent = 'Update Run Log';
    if (cancelBtn) cancelBtn.textContent = 'Cancel Edit';
    if (editIndicator) editIndicator.style.display = 'block';
    if (carEl) carEl.disabled = true;
    if (sessionEl) sessionEl.disabled = true;
    if (carEl) carEl.title = 'Disabled while editing to keep log consistent';
    if (sessionEl) sessionEl.title = 'Disabled while editing to keep log consistent';
    if (carHint) carHint.style.display = 'block';
    if (sessionHint) sessionHint.style.display = 'block';
    document.getElementById('runLogId').value = runLog.id;
    document.getElementById('runLogEventId').value = runLog.eventId;
    document.getElementById('runLogCarId').value = runLog.carId || '';
    document.getElementById('runLogSessionType').value = runLog.sessionType || '';
    document.getElementById('runLogBestLap').value = runLog.bestLap || '';
    document.getElementById('runLogTime').value = runLog.time || '';
    document.getElementById('runLogTotalLaps').value = runLog.totalLaps || '';
    document.getElementById('runLogPosition').value = runLog.position || '';
    document.getElementById('runLogNotes').value = runLog.notes || '';
    
    // Load setups for the car and set setupId
    if (runLog.carId) {
      queryIndex('setups', 'carId', runLog.carId).then(setups => {
        setups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const setupSelect = document.getElementById('runLogSetupId');
        if (setupSelect) {
          setupSelect.innerHTML = `
            <option value="">No setup recorded</option>
            ${setups.map(setup => `
              <option value="${setup.id}" ${runLog.setupId === setup.id ? 'selected' : ''}>${escapeHtml(setup.name || 'Unnamed Setup')} (${new Date(setup.createdAt).toLocaleDateString()})</option>
            `).join('')}
          `;
        }
      });
    }
  } else {
    // Add mode
    formTitle.textContent = 'Add Run Log';
    if (submitBtn) submitBtn.textContent = 'Save Run Log';
    if (cancelBtn) cancelBtn.textContent = 'Cancel';
    if (editIndicator) editIndicator.style.display = 'none';
    if (carEl) carEl.disabled = false;
    if (sessionEl) sessionEl.disabled = false;
    if (carEl) carEl.title = '';
    if (sessionEl) sessionEl.title = '';
    if (carHint) carHint.style.display = 'none';
    if (sessionHint) sessionHint.style.display = 'none';
    document.getElementById('runLogFormElement').reset();
    document.getElementById('runLogId').value = '';
    document.getElementById('runLogEventId').value = eventId;
  }
  
  form.style.display = 'block';
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideRunLogForm() {
  document.getElementById('runLogForm').style.display = 'none';
  document.getElementById('runLogFormElement').reset();
}

async function handleRunLogSubmit(e) {
  e.preventDefault();
  
  const id = document.getElementById('runLogId').value;
  const eventId = document.getElementById('runLogEventId').value;
  
  const timeInputRaw = document.getElementById('runLogTime').value.trim();
  const timeSeconds = parseTimeInputToSeconds(timeInputRaw);
  const totalLaps = document.getElementById('runLogTotalLaps').value ? parseInt(document.getElementById('runLogTotalLaps').value) : null;

  // Lightweight validation
  if (timeSeconds === null) {
    toast('Enter time as seconds or MM:SS(.mmm)');
    document.getElementById('runLogTime').focus();
    return;
  }
  if (!Number.isFinite(totalLaps) || totalLaps <= 0) {
    toast('Enter total laps (> 0)');
    document.getElementById('runLogTotalLaps').focus();
    return;
  }
  
  // Calculate avgLap from time and totalLaps
  let avgLap = '';
  if (timeSeconds !== null && totalLaps && totalLaps > 0) {
    avgLap = (timeSeconds / totalLaps).toFixed(3);
  }
  
  const runLogData = {
    id: id || generateId('runlog'),
    eventId: eventId,
    carId: document.getElementById('runLogCarId').value,
    sessionType: document.getElementById('runLogSessionType').value,
    setupId: document.getElementById('runLogSetupId').value || null,
    bestLap: document.getElementById('runLogBestLap').value.trim(),
    avgLap: avgLap,
    totalLaps: totalLaps,
    time: timeSeconds,
    position: document.getElementById('runLogPosition').value.trim(),
    notes: document.getElementById('runLogNotes').value.trim(),
    updatedAt: new Date().toISOString()
  };
  
  // Add createdAt for new run logs
  if (!id) {
    runLogData.createdAt = runLogData.updatedAt;
  }
  
  try {
    await put('runLogs', runLogData);
    toast(id ? 'Run log updated!' : 'Run log added!');
    hideRunLogForm();
    renderEventDetailPage();
  } catch (error) {
    console.error('❌ Failed to save run log:', error);
    toast('Failed to save run log');
  }
}

async function deleteRunLog(id, eventId) {
  if (!confirm('Are you sure you want to delete this run log?')) {
    return;
  }
  
  try {
    await remove('runLogs', id);
    toast('Run log deleted');
    renderEventDetailPage();
  } catch (error) {
    console.error('❌ Failed to delete run log:', error);
    toast('Failed to delete run log');
  }
}

// LiveRC helpers
function parseLiveRcEvent(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const racesMap = new Map(); // race name -> Set of drivers
  const allDriversSet = new Set();

  // Look for Entry List structure: tabs/sections with race names and driver tables
  // Try multiple selector patterns to find race sections
  const raceSections = doc.querySelectorAll('.tab-pane, .race-section, [id*="race"], [class*="race"]');
  
  raceSections.forEach((section) => {
    // Find race title/name in this section
    const raceTitle = section.querySelector('h3, h4, .race-title, .tab-title');
    let raceName = raceTitle ? raceTitle.textContent.trim() : null;
    
    // Fallback: check for "Race X:" pattern in any text within section
    if (!raceName) {
      const sectionText = section.textContent || '';
      const raceMatch = sectionText.match(/Race\s+\d+:\s*[^(\n]+/i);
      if (raceMatch) {
        raceName = raceMatch[0].trim();
      }
    }
    
    if (raceName && raceName.length > 3 && raceName.length < 150) {
      if (!racesMap.has(raceName)) {
        racesMap.set(raceName, new Set());
      }
      
      // Find driver tables in this section
      const tables = section.querySelectorAll('table');
      tables.forEach((table) => {
        const rows = table.querySelectorAll('tr');
        rows.forEach((tr) => {
          const cells = Array.from(tr.children).map((c) => c.textContent.trim()).filter(Boolean);
          if (cells.length > 0) {
            // First cell is typically driver name
            const name = cells[0].replace(/\s+/g, ' ').trim();
            // Filter out headers and invalid names
            if (name && name.length >= 3 && name.length <= 80 && /[A-Za-z]/.test(name) && 
                !name.match(/^(pos|position|name|driver|time|laps|class|#|no\.)$/i)) {
              racesMap.get(raceName).add(name);
              allDriversSet.add(name);
            }
          }
        });
      });
    }
  });

  // Fallback: if no races found via sections, try the old method
  if (racesMap.size === 0) {
    const racesSet = new Set();
    const elements = Array.from(doc.querySelectorAll('a,td,th,div,span,li,p,h3,h4'));
    elements.forEach((el) => {
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (!t) return;
      const raceMatch = t.match(/Race\s+\d+:\s*[^(\n]+/i);
      if (raceMatch) {
        racesSet.add(raceMatch[0].trim());
      }
    });

    doc.querySelectorAll('table tr').forEach((tr) => {
      const cells = Array.from(tr.children).map((c) => c.textContent.trim()).filter(Boolean);
      if (cells.length > 0) {
        const name = cells[0].replace(/\s+/g, ' ').trim();
        if (name && name.length >= 3 && name.length <= 80 && /[A-Za-z]/.test(name) &&
            !name.match(/^(pos|position|name|driver|time|laps|class|#|no\.)$/i)) {
          allDriversSet.add(name);
        }
      }
    });

    racesSet.forEach((raceName) => {
      racesMap.set(raceName, new Set());
    });
  }

  // Build final race/driver structure
  const races = Array.from(racesMap.entries()).map(([name, drivers], idx) => ({
    id: `race_${idx}`,
    name,
    driverCount: drivers.size
  }));

  const drivers = Array.from(allDriversSet).slice(0, 300);

  return { races, drivers };
}

// Backup & Restore Functions
async function exportBackup() {
  try {
    toast('Exporting backup...');
    
    // Get all data from all stores
    const backup = {
      version: '1.0.0',
      exportDate: new Date().toISOString(),
      data: {
        cars: await getAll('cars'),
        setups: await getAll('setups'),
        tracks: await getAll('tracks'),
        events: await getAll('events'),
        runLogs: await getAll('runLogs')
      }
    };
    
    // Create JSON blob
    const jsonString = JSON.stringify(backup, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    // Create download link
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `rc-program-backup-${timestamp}.json`;
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    
    toast('✅ Backup exported successfully!');
    console.log('✅ Backup exported:', backup);
  } catch (error) {
    console.error('❌ Export backup failed:', error);
    toast('❌ Failed to export backup');
  }
}

async function handleImportBackup(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  try {
    // Read file
    const text = await file.text();
    const backup = JSON.parse(text);
    
    // Validate backup structure
    if (!backup.data || typeof backup.data !== 'object') {
      throw new Error('Invalid backup file format');
    }
    
    // Show confirmation dialog
    const totalRecords = Object.values(backup.data).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
    const confirmMessage = `This will import ${totalRecords} records and may overwrite existing data.\n\nBackup from: ${backup.exportDate ? new Date(backup.exportDate).toLocaleString() : 'Unknown'}\n\nContinue?`;
    
    if (!confirm(confirmMessage)) {
      toast('Import cancelled');
      event.target.value = ''; // Reset file input
      return;
    }
    
    toast('Importing backup...');
    
    // Import data to each store
    let importedCount = 0;
    
    // Import cars
    if (Array.isArray(backup.data.cars)) {
      for (const item of backup.data.cars) {
        await put('cars', item);
        importedCount++;
      }
    }
    
    // Import setups
    if (Array.isArray(backup.data.setups)) {
      for (const item of backup.data.setups) {
        await put('setups', item);
        importedCount++;
      }
    }
    
    // Import tracks
    if (Array.isArray(backup.data.tracks)) {
      for (const item of backup.data.tracks) {
        await put('tracks', item);
        importedCount++;
      }
    }
    
    // Import events
    if (Array.isArray(backup.data.events)) {
      for (const item of backup.data.events) {
        await put('events', item);
        importedCount++;
      }
    }
    
    // Import runLogs
    if (Array.isArray(backup.data.runLogs)) {
      for (const item of backup.data.runLogs) {
        await put('runLogs', item);
        importedCount++;
      }
    }
    
    toast(`✅ Imported ${importedCount} records successfully!`);
    console.log(`✅ Backup imported: ${importedCount} records`);
    
    // Reset file input
    event.target.value = '';
    
    // Refresh settings page to show updated stats
    renderSettingsPage();
    
  } catch (error) {
    console.error('❌ Import backup failed:', error);
    toast('❌ Failed to import backup: ' + error.message);
    event.target.value = ''; // Reset file input
  }
}

// Load sample backup JSON bundled with the app (development-only helper)
async function loadSampleData() {
  try {
    const resp = await fetch('rc-program-backup-2025-12-15T23-48-14.json');
    if (!resp.ok) throw new Error('Failed to fetch sample backup: ' + resp.statusText);
    const backup = await resp.json();

    if (!backup || !backup.data) throw new Error('Invalid backup structure');

    // Import without triggering file input logic
    let importedCount = 0;

    if (Array.isArray(backup.data.cars)) {
      for (const item of backup.data.cars) {
        await put('cars', item);
        importedCount++;
      }
    }

    if (Array.isArray(backup.data.setups)) {
      for (const item of backup.data.setups) {
        await put('setups', item);
        importedCount++;
      }
    }

    if (Array.isArray(backup.data.tracks)) {
      for (const item of backup.data.tracks) {
        await put('tracks', item);
        importedCount++;
      }
    }

    if (Array.isArray(backup.data.events)) {
      for (const item of backup.data.events) {
        await put('events', item);
        importedCount++;
      }
    }

    if (Array.isArray(backup.data.runLogs)) {
      for (const item of backup.data.runLogs) {
        await put('runLogs', item);
        importedCount++;
      }
    }

    console.log(`✅ Sample backup imported: ${importedCount} records`);
    return importedCount;
  } catch (error) {
    console.error('❌ loadSampleData error:', error);
    throw error;
  }
}

// Make functions available globally for onclick handlers
window.editCar = editCar;
window.editSetup = editSetup;
window.editTrack = editTrack;
window.editEvent = editEvent;

async function renderEventsPage() {
  const app = document.getElementById('app');
  
  // Show loading skeleton
  app.innerHTML = `
    <div class="page">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h2 style="margin: 0;">Events</h2>
      </div>
      ${renderLoadingSkeleton()}
    </div>
  `;
  
  try {
    // Load events from database
    const events = await getAll('events');
    
    // Leave events unsorted for now; we'll sort per-section after grouping
    
    // Load tracks for the select dropdown
    const tracks = await getAll('tracks');
    tracks.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Load cars for event selection
    const cars = await getAll('cars');
    cars.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    
    // Render page
    app.innerHTML = `
      <div class="page">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h2 style="margin: 0;">Events</h2>
          <button class="btn" id="addEventBtn">+ Add Event</button>
        </div>
        
        <!-- Event Form (hidden by default) -->
        <div id="eventForm" style="display: none;" class="page-content" style="margin-bottom: 16px;">
          <h3 id="eventFormTitle">Add Event</h3>
          <form id="eventFormElement">
            <input type="hidden" id="eventId" value="">
            <div class="form-group">
              <label for="eventTitle">Title *</label>
              <input type="text" id="eventTitle" required placeholder="e.g. Club Race, Practice Day">
            </div>
            <div class="form-group">
              <label for="eventTrackId">Track *</label>
              ${tracks.length === 0 ? `
                <p style="color: var(--text-secondary); font-size: 14px; margin: 8px 0;">
                  No tracks available. <a href="#/tracks" style="color: var(--primary-color);">Add tracks first</a>
                </p>
              ` : `
                <select id="eventTrackId" required>
                  <option value="">Select a track...</option>
                  ${tracks.map(track => `<option value="${track.id}">${escapeHtml(track.name)}</option>`).join('')}
                </select>
              `}
            </div>
            <div class="form-group">
              <label for="eventDate">Date *</label>
              <input type="date" id="eventDate" required>
            </div>
            <div class="form-group">
              <label for="eventStartTime">Start Time (optional)</label>
              <input type="time" id="eventStartTime" placeholder="HH:MM">
            </div>
            <div class="form-group">
              <label>Cars for this event</label>
              ${cars.length === 0 ? `
                <p style="color: var(--text-secondary); font-size: 14px; margin: 8px 0;">
                  No cars available. <a href="#/garage" style="color: var(--primary-color);">Add cars first</a>
                </p>
              ` : `
                <div style="display:flex; flex-wrap:wrap; gap:8px;">
                  ${cars.map(car => `
                    <label style="display:inline-flex; align-items:center; gap:6px; border:1px solid var(--border-color); border-radius:12px; padding:6px 10px;">
                      <input type="checkbox" name="eventCars" value="${car.id}" style="margin:0;">
                      <span>${escapeHtml(car.name)}${car.transponder ? `<span style="color: var(--text-secondary); font-size:12px;"> (${escapeHtml(car.transponder)})</span>` : ''}</span>
                    </label>
                  `).join('')}
                </div>
                <div class="form-hint" style="margin-top:6px;font-size:12px;color:var(--text-secondary);">Select the cars you'll run at this event.</div>
              `}
            </div>
            <div class="form-group">
              <label for="eventLiveRcUrl">LiveRC Event URL</label>
              <input type="url" id="eventLiveRcUrl" placeholder="https://liverchobby.tv/events/...">
            </div>
            <div class="form-group">
              <label for="eventNotes">Notes</label>
              <textarea id="eventNotes" rows="3" placeholder="Event details, schedule, etc."></textarea>
            </div>
            <div style="display: flex; gap: 8px;">
              <button type="submit" class="btn" ${tracks.length === 0 ? 'disabled' : ''}>Save Event</button>
              <button type="button" class="btn btn-secondary" id="cancelEventBtn">Cancel</button>
            </div>
          </form>
        </div>
        
        <!-- Event List -->
        <div id="eventList">
          ${events.length === 0 ? `
            <div class="empty-state">
              <div class="empty-state-icon">📅</div>
              <p class="empty-state-text">No events scheduled</p>
            </div>
          ` : `
            <div class="event-list">
              ${await Promise.all(events.map(async event => {
                const track = await get('tracks', event.trackId);
                const trackName = track ? track.name : 'Unknown Track';
                const eventDate = parseDateStringAsLocal(event.date);
                const dateStr = eventDate ? eventDate.toLocaleDateString() : '';
                return `
                  <div class="event-item" data-id="${event.id}">
                    <div class="event-info">
                      <h3 class="event-title">${escapeHtml(event.title)}</h3>
                      <p class="event-detail">🏁 ${escapeHtml(trackName)}</p>
                      <p class="event-detail">📅 ${dateStr}${event.startTime ? ` at ${event.startTime}` : ''}</p>
                    </div>
                    <div class="event-actions">
                      
                      <button class="btn-icon" data-action="edit" data-id="${event.id}" title="Edit">✏️</button>
                      <button class="btn-icon" data-action="delete" data-id="${event.id}" title="Delete">🗑️</button>
                    </div>
                  </div>
                `;
              })).then(items => items.join(''))}
            </div>
          `}
        </div>
      </div>
    `;
    
    // Attach event listeners
    document.getElementById('addEventBtn')?.addEventListener('click', () => showEventForm());
    document.getElementById('cancelEventBtn')?.addEventListener('click', hideEventForm);
    document.getElementById('eventFormElement')?.addEventListener('submit', handleEventSubmit);
    
    // Attach action buttons
    document.querySelectorAll('.event-item .btn-icon').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = e.currentTarget.dataset.action;
        const id = e.currentTarget.dataset.id;
        
        if (action === 'view') {
          window.location.hash = `#/event/${id}`;
        } else if (action === 'edit') {
          editEvent(id);
        } else if (action === 'delete') {
          deleteEvent(id);
        }
      });
    });
    // Make whole event item clickable to view event, but ignore clicks on action buttons
    document.querySelectorAll('.event-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.event-actions')) return;
        const id = item.dataset.id;
        if (id) window.location.hash = `#/event/${id}`;
      });
      item.style.cursor = 'pointer';
    });
    
  } catch (error) {
    console.error('❌ Failed to load events:', error);
    app.innerHTML = '<div class="page"><p>Failed to load events. Please try again.</p></div>';
    toast('Failed to load events');
  }
}

async function renderTracksPage() {
  const app = document.getElementById('app');
  
  // Show loading skeleton
  app.innerHTML = `
    <div class="page">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h2 style="margin: 0;">Tracks</h2>
      </div>
      ${renderLoadingSkeleton()}
    </div>
  `;
  
  try {
    // Load tracks from database
    const tracks = await getAll('tracks');
    
    // Sort by name
    tracks.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    
    // Render page
    app.innerHTML = `
      <div class="page">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h2 style="margin: 0;">Tracks</h2>
          <button class="btn" id="addTrackBtn">+ Add Track</button>
        </div>
        
        <!-- Track Form (hidden by default) -->
        <div id="trackForm" style="display: none;" class="page-content" style="margin-bottom: 16px;">
          <h3 id="trackFormTitle">Add Track</h3>
          <form id="trackFormElement">
            <input type="hidden" id="trackId" value="">
            <div class="form-group">
              <label for="trackName">Name *</label>
              <input type="text" id="trackName" required placeholder="e.g. Silver Dollar Raceway">
            </div>
            <div class="form-group">
              <label for="trackAddress">Address</label>
              <input type="text" id="trackAddress" placeholder="Street address or location">
            </div>
            <div class="form-group">
              <label for="trackWebsiteUrl">Website URL</label>
              <input type="url" id="trackWebsiteUrl" placeholder="https://example.com/">
            </div>
            <div class="form-group">
              <label for="trackSurface">Surface</label>
              <input type="text" id="trackSurface" placeholder="e.g. Astroturf, Carpet, Clay, Dirt">
            </div>
            <div class="form-group">
              <label for="trackLiveRcUrl">LiveRC URL</label>
              <input type="url" id="trackLiveRcUrl" placeholder="https://liverchobby.tv/...">
            </div>
            <div class="form-group">
              <label for="trackNotes">Notes</label>
              <textarea id="trackNotes" rows="3" placeholder="Track details, amenities, etc."></textarea>
            </div>
            <div style="display: flex; gap: 8px;">
              <button type="submit" class="btn">Save</button>
              <button type="button" class="btn btn-secondary" id="cancelTrackBtn">Cancel</button>
            </div>
          </form>
        </div>
        
        <!-- Track List -->
        <div id="trackList">
          ${tracks.length === 0 ? `
            <div class="empty-state">
              <div class="empty-state-icon">📍</div>
              <p class="empty-state-text">No tracks added</p>
            </div>
          ` : `
            <div class="track-list">
              ${tracks.map(track => `
                <div class="track-item" data-id="${track.id}">
                  <div class="track-info">
                    <h3 class="track-name">${escapeHtml(track.name)}</h3>
                    ${track.address ? `<div class="track-detail">${escapeHtml(track.address)}</div>` : ''}
                    ${track.surface ? `<div class="track-detail">Surface: ${escapeHtml(track.surface)}</div>` : ''}
                    ${track.websiteUrl ? `<div class="track-detail"><a href="${escapeHtml(track.websiteUrl)}" target="_blank" rel="noopener noreferrer" style="color: var(--primary-color); text-decoration: none;">🌐 Website</a></div>` : ''}
                  </div>
                  <div class="track-actions">
                    
                    <button class="btn-icon" data-action="edit" data-id="${track.id}" title="Edit">✏️</button>
                    <button class="btn-icon" data-action="delete" data-id="${track.id}" title="Delete">🗑️</button>
                  </div>
                </div>
              `).join('')}
            </div>
          `}
        </div>
      `;
      document.getElementById('trackFormElement')?.addEventListener('submit', handleTrackSubmit);
      // Show/hide track form controls
      document.getElementById('addTrackBtn')?.addEventListener('click', () => showTrackForm());
      document.getElementById('cancelTrackBtn')?.addEventListener('click', hideTrackForm);
    
    // Attach action buttons
    document.querySelectorAll('.track-item .btn-icon').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = e.currentTarget.dataset.action;
        const id = e.currentTarget.dataset.id;
        
        if (action === 'view') {
          window.location.hash = `#/track/${id}`;
        } else if (action === 'edit') {
          editTrack(id);
        } else if (action === 'delete') {
          deleteTrack(id);
        }
      });
    });
    // Make whole track item clickable to view track, but ignore clicks on action buttons
    document.querySelectorAll('.track-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.track-actions')) return;
        const id = item.dataset.id;
        if (id) window.location.hash = `#/track/${id}`;
      });
      item.style.cursor = 'pointer';
    });
    
  } catch (error) {
    console.error('❌ Failed to load tracks:', error);
    app.innerHTML = '<div class="page"><p>Failed to load tracks. Please try again.</p></div>';
    toast('Failed to load tracks');
  }
}

// Analyze setup changes vs performance
function analyzeSetupChanges(runs, analyticsContext) {
  const comparisons = [];
  
  // Group runs by car and track, sorted by date
  const runsByCarTrack = {};
  
  runs.forEach(run => {
    if (!run.setupId || !run.bestLapNum) return; // Only analyze runs with setup and valid lap time
    
    const key = `${run.carId}_${run.trackId || 'unknown'}`;
    if (!runsByCarTrack[key]) {
      runsByCarTrack[key] = [];
    }
    runsByCarTrack[key].push(run);
  });
  
  // For each car/track combination, compare consecutive runs
  Object.values(runsByCarTrack).forEach(carTrackRuns => {
    // Sort by date
    carTrackRuns.sort((a, b) => new Date(a.eventDate || a.createdAt) - new Date(b.eventDate || b.createdAt));
    
    for (let i = 1; i < carTrackRuns.length; i++) {
      const currentRun = carTrackRuns[i];
      const previousRun = carTrackRuns[i - 1];
      
      // Skip if same setup
      if (currentRun.setupId === previousRun.setupId) continue;
      
      // Get setup objects
      const currentSetup = analyticsContext.setupsById.get(currentRun.setupId);
      const previousSetup = analyticsContext.setupsById.get(previousRun.setupId);
      
      if (!currentSetup || !previousSetup) continue;
      
      // Use diff engine to count changes
      const diff = diffObjects(
        normalizeSetupData(previousSetup),
        normalizeSetupData(currentSetup)
      );
      
      const changeCount = diff.filter(d => d.changeType !== 'none').length;
      
      // Calculate performance delta
      const bestLapDelta = currentRun.bestLapNum - previousRun.bestLapNum;
      
      // Get track name
      const track = analyticsContext.tracksById.get(currentRun.trackId);
      const trackName = track ? track.name : 'Unknown Track';
      
      // Build notes
      let notes = '';
      if (bestLapDelta < 0) {
        notes = `Improved by ${Math.abs(bestLapDelta).toFixed(3)}s`;
      } else if (bestLapDelta > 0) {
        notes = `Slower by ${bestLapDelta.toFixed(3)}s`;
      } else {
        notes = 'No change';
      }
      
      comparisons.push({
        date: currentRun.eventDate || currentRun.createdAt,
        trackName,
        changeCount,
        bestLapDelta,
        notes
      });
    }
  });
  
  // Generate insights
  const insights = [];
  
  if (comparisons.length >= 3) {
    // Group by change count ranges
    const smallChanges = comparisons.filter(c => c.changeCount >= 1 && c.changeCount <= 3);
    const mediumChanges = comparisons.filter(c => c.changeCount >= 4 && c.changeCount <= 10);
    const largeChanges = comparisons.filter(c => c.changeCount > 10);
    
    if (smallChanges.length > 0) {
      const avgDelta = smallChanges.reduce((sum, c) => sum + c.bestLapDelta, 0) / smallChanges.length;
      insights.push(`Average Best Lap Δ when 1–3 changes: ${avgDelta >= 0 ? '+' : ''}${avgDelta.toFixed(3)}s (${smallChanges.length} comparison${smallChanges.length > 1 ? 's' : ''})`);
    }
    
    if (mediumChanges.length > 0) {
      const avgDelta = mediumChanges.reduce((sum, c) => sum + c.bestLapDelta, 0) / mediumChanges.length;
      insights.push(`Average Best Lap Δ when 4–10 changes: ${avgDelta >= 0 ? '+' : ''}${avgDelta.toFixed(3)}s (${mediumChanges.length} comparison${mediumChanges.length > 1 ? 's' : ''})`);
    }
    
    if (largeChanges.length > 0) {
      const avgDelta = largeChanges.reduce((sum, c) => sum + c.bestLapDelta, 0) / largeChanges.length;
      insights.push(`Average Best Lap Δ when 10+ changes: ${avgDelta >= 0 ? '+' : ''}${avgDelta.toFixed(3)}s (${largeChanges.length} comparison${largeChanges.length > 1 ? 's' : ''})`);
    }
  } else if (comparisons.length > 0) {
    insights.push(`${comparisons.length} setup comparison${comparisons.length > 1 ? 's' : ''} available. More data needed for trend analysis.`);
  }
  
  return {
    comparisons,
    insights
  };
}

async function loadAnalyticsData({ forceRefresh = false } = {}) {
  if (!forceRefresh && analyticsDataCache) {
    return analyticsDataCache;
  }
  
  const [cars, events, runLogs, tracks, setups] = await Promise.all([
    getAll('cars'),
    getAll('events'),
    getAll('runLogs'),
    getAll('tracks'),
    getAll('setups')
  ]);
  
  const carsById = new Map(cars.map(car => [car.id, car]));
  const tracksById = new Map(tracks.map(track => [track.id, track]));
  const eventsById = new Map(events.map(event => [event.id, event]));
  const setupsById = new Map(setups.map(setup => [setup.id, setup]));
  
  const enrichedRuns = runLogs.map(run => {
    const event = eventsById.get(run.eventId);
    const trackId = event?.trackId || null;
    return {
      ...run,
      eventDate: event ? event.date : null,
      trackId,
      bestLapNum: parseLap(run.bestLap),
      avgLapNum: parseLap(run.avgLap)
    };
  });
  
  analyticsDataCache = {
    cars,
    events,
    runLogs,
    tracks,
    setups,
    carsById,
    tracksById,
    eventsById,
    setupsById,
    enrichedRuns
  };
  
  return analyticsDataCache;
}

function invalidateAnalyticsDataCache() {
  analyticsDataCache = null;
}

// Analytics filter helpers
function getAnalyticsFilters() {
  try {
    const stored = localStorage.getItem('analyticsFilters');
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    console.warn('Failed to load analytics filters from localStorage:', error);
  }
  
  // Default filters
  return {
    carId: null,
    trackId: null,
    dateFrom: null,
    dateTo: null,
    sessionType: null
  };
}

function setAnalyticsFilters(filters) {
  try {
    localStorage.setItem('analyticsFilters', JSON.stringify(filters));
  } catch (error) {
    console.warn('Failed to save analytics filters to localStorage:', error);
  }
}

function chartJsAvailable() {
  if (window.Chart && Chart.version && Chart.version !== 'stub') {
    if (isDev && !chartVersionLogged) {
      console.log('Chart.js loaded', Chart?.version);
      chartVersionLogged = true;
    }
    return true;
  }
  return false;
}

function destroyAnalyticsCharts() {
  Object.keys(analyticsCharts).forEach(key => {
    const chart = analyticsCharts[key];
    if (chart && typeof chart.destroy === 'function') {
      chart.destroy();
    }
    analyticsCharts[key] = null;
  });
}

function setChartMessage(containerId, message) {
  const container = document.getElementById(containerId);
  if (!container) return;
  let msgEl = container.querySelector('.chart-message');
  if (!msgEl) {
    msgEl = document.createElement('div');
    msgEl.className = 'chart-message';
    msgEl.style.textAlign = 'center';
    msgEl.style.color = 'var(--text-secondary)';
    msgEl.style.padding = '12px';
  }
  msgEl.textContent = message;
  const canvas = container.querySelector('canvas');
  if (canvas) canvas.style.display = 'none';
  if (!msgEl.parentElement) {
    container.appendChild(msgEl);
  }
}

function clearChartMessage(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const msgEl = container.querySelector('.chart-message');
  if (msgEl) msgEl.remove();
  const canvas = container.querySelector('canvas');
  if (canvas) canvas.style.display = 'block';
}

async function renderAnalyticsPage(options = {}) {
  const { useCache = false, filtersOverride = null } = options;
  const app = document.getElementById('app');
  destroyAnalyticsCharts();
  
  const previousTrackMetric = analyticsTrackMetric;
  
  // Show loading skeleton
  app.innerHTML = `
    <div class="page">
      <h2>Analytics</h2>
      ${renderLoadingSkeleton(3)}
    </div>
  `;
  
  try {
    if (isDev) console.time('analytics:loadData');
    const data = await loadAnalyticsData({ forceRefresh: !(useCache && analyticsDataCache) });
    if (isDev) console.timeEnd('analytics:loadData');
    
    const { cars, events, tracks, setups, carsById, tracksById, eventsById, setupsById, enrichedRuns } = data;
    
    const analyticsContext = {
      carsById,
      tracksById,
      eventsById,
      setupsById,
      enrichedRuns
    };
    
    // Load filters from localStorage (persistent across sessions)
    const filters = filtersOverride || getAnalyticsFilters();
    analyticsLastFiltersKey = JSON.stringify(filters);
    
    // Use stats module to aggregate data with enriched runs
    if (isDev) console.time('analytics:aggregate');
    const { filteredRuns, kpis, trendSeries, byTrack } = aggregateRuns({
      runs: analyticsContext.enrichedRuns,
      events,
      tracks,
      cars,
      filters
    });
    if (isDev) console.timeEnd('analytics:aggregate');
    
    // Format trend series for display
    const trendData = trendSeries.map(point => ({
      date: new Date(point.x).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      bestLap: point.bestLap,
      avgLap: point.avgLap
    }));
    
    // Format track stats for display
    const trackStats = byTrack.map(track => ({
      name: track.trackName,
      bestLap: track.bestLapMin,
      avgLap: track.avgLapMean,
      laps: track.runCount
    }));
    
    // Calculate data quality metrics
    const totalRuns = filteredRuns.length;
    const runsWithAvgLap = filteredRuns.filter(r => r.avgLapNum !== null).length;
    const runsWithBestLap = filteredRuns.filter(r => r.bestLapNum !== null).length;
    const missingAvgLapPercent = totalRuns > 0 ? ((totalRuns - runsWithAvgLap) / totalRuns) * 100 : 0;
    const invalidLapCount = filteredRuns.filter(r => r.bestLapNum === null && r.avgLapNum === null).length;
    
    // Build data quality hints
    const dataQualityHints = [];
    if (missingAvgLapPercent > 30) {
      dataQualityHints.push('Many runs missing avg lap—trend uses best lap where needed.');
    }
    if (invalidLapCount > 0) {
      dataQualityHints.push(`${invalidLapCount} run${invalidLapCount > 1 ? 's' : ''} with invalid lap values.`);
    }
    
    // Analyze setup changes vs performance
    const setupChanges = analyzeSetupChanges(filteredRuns, analyticsContext);
    const insightCards = buildInsightCards(filteredRuns, analyticsContext);
    const hasRuns = filteredRuns.length > 0;
    
    // Render page
    app.innerHTML = `
      <div class="page">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h2 style="margin: 0;">Analytics</h2>
          <button class="btn btn-secondary" id="exportCsvBtn">📊 Export CSV</button>
        </div>
        
        <!-- Filters Card -->
        <div class="page-content" style="margin-bottom: 16px;">
          <h3>Filters</h3>
          <div class="analytics-filters">
            <div class="form-group">
              <label for="filterCar">Car</label>
              <select id="filterCar" class="analytics-filter">
                <option value="">All Cars</option>
                ${cars.map(car => `
                  <option value="${car.id}" ${filters.carId === car.id ? 'selected' : ''}>
                    ${escapeHtml(car.name)}
                  </option>
                `).join('')}
              </select>
            </div>
            <div class="form-group">
              <label for="filterTrack">Track</label>
              <select id="filterTrack" class="analytics-filter">
                <option value="">All Tracks</option>
                ${tracks.map(track => `
                  <option value="${track.id}" ${filters.trackId === track.id ? 'selected' : ''}>
                    ${escapeHtml(track.name)}
                  </option>
                `).join('')}
              </select>
            </div>
            <div class="form-group">
              <label for="filterDateFrom">Date From</label>
              <input type="date" id="filterDateFrom" class="analytics-filter" value="${filters.dateFrom || ''}">
            </div>
            <div class="form-group">
              <label for="filterDateTo">Date To</label>
              <input type="date" id="filterDateTo" class="analytics-filter" value="${filters.dateTo || ''}">
            </div>
            <div class="form-group">
              <label for="filterSessionType">Session Type</label>
              <select id="filterSessionType" class="analytics-filter">
                <option value="">All Sessions</option>
                <option value="practice" ${filters.sessionType === 'practice' ? 'selected' : ''}>Practice</option>
                <option value="qualifying" ${filters.sessionType === 'qualifying' ? 'selected' : ''}>Qualifying</option>
                <option value="main" ${filters.sessionType === 'main' ? 'selected' : ''}>Main</option>
              </select>
            </div>
          </div>
          <div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap;">
            <button class="btn" id="applyFiltersBtn">Apply Filters</button>
            <button class="btn btn-secondary" id="resetFiltersBtn">Reset Filters</button>
          </div>
        </div>
        
        ${!hasRuns ? `
          <div class="page-content" style="text-align: center;">
            <p style="margin-bottom: 12px;">No race logs yet. Add run logs in Events → Event Detail.</p>
            <a class="btn" href="#/events">Go to Events</a>
          </div>
        ` : ''}
        
        ${hasRuns ? `
          <!-- KPI Cards -->
          <div class="analytics-kpi-grid">
            <div class="kpi-card">
              <div class="kpi-label">Best Lap</div>
              <div class="kpi-value">${kpis.bestLapMin !== null ? formatLapTime(kpis.bestLapMin) : '-'}</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label">Avg Lap</div>
              <div class="kpi-value">${kpis.avgLapMean !== null ? formatLapTime(kpis.avgLapMean) : '-'}</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label"># Runs</div>
              <div class="kpi-value">${kpis.runCount}</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label"># Events</div>
              <div class="kpi-value">${kpis.eventCount}</div>
            </div>
          </div>
        ` : ''}
        
        ${hasRuns && insightCards.length > 0 ? `
          <div class="page-content" style="margin-top: 16px;">
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px;">
              ${insightCards.map(card => `
                <div class="kpi-card" style="padding: 12px 14px;">
                  <div class="kpi-label">${escapeHtml(card.title)}</div>
                  <div class="kpi-value" style="font-size: 20px;">${escapeHtml(card.value)}</div>
                  ${card.detail ? `<div style="color: var(--text-secondary); font-size: 13px; margin-top: 4px;">${escapeHtml(card.detail)}</div>` : ''}
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
        
        ${hasRuns && dataQualityHints.length > 0 ? `
          <!-- Data Quality Hints -->
          <div class="data-quality-hints">
            ${dataQualityHints.map(hint => `<div class="data-quality-hint">ℹ️ ${escapeHtml(hint)}</div>`).join('')}
          </div>
        ` : ''}
        
        ${hasRuns ? `
          <div class="page-content" style="margin-top: 8px; display: flex; align-items: center; gap: 8px;">
            <label for="invertYToggle" style="font-size: 14px; color: var(--text-secondary);">Invert Y (lower is better)</label>
            <input type="checkbox" id="invertYToggle" ${analyticsInvertY ? 'checked' : ''}>
          </div>
          
          <!-- Best Lap Trend Chart -->
          <div class="page-content" style="margin-top: 16px;">
            <div id="bestLapChartContainer" style="width: 100%; min-height: 240px;">
              <canvas id="bestLapChart"></canvas>
            </div>
          </div>
          
          <!-- Avg Lap Trend Chart -->
          <div class="page-content" style="margin-top: 16px;">
            <div id="avgLapChartContainer" style="width: 100%; min-height: 240px;">
              <canvas id="avgLapChart"></canvas>
            </div>
          </div>
          
          <!-- Per-Track Performance Chart -->
          <div class="page-content" style="margin-top: 16px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
              <h3 style="margin: 0;">Per-Track Performance</h3>
              <div style="display: flex; gap: 8px; align-items: center;">
                <label style="font-size: 14px; color: var(--text-secondary);">Chart uses:</label>
                <select id="trackChartMetric" class="analytics-filter" style="width: auto;">
                  <option value="avg" ${analyticsTrackMetric === 'avg' ? 'selected' : ''}>Avg Lap</option>
                  <option value="best" ${analyticsTrackMetric === 'best' ? 'selected' : ''}>Best Lap</option>
                </select>
              </div>
            </div>
            <div id="trackChartContainer" style="width: 100%; min-height: 260px;">
              <canvas id="trackChart"></canvas>
            </div>
            
            <!-- Track Performance Table -->
            ${byTrack.length > 0 ? `
              <div style="margin-top: 16px; overflow-x: auto;">
                <table class="analytics-track-table">
                  <thead>
                    <tr>
                      <th class="sortable" data-sort="trackName">Track <span class="sort-indicator"></span></th>
                      <th class="sortable" data-sort="runCount">Runs <span class="sort-indicator"></span></th>
                      <th class="sortable" data-sort="bestLapMin">Best Lap <span class="sort-indicator"></span></th>
                      <th class="sortable" data-sort="avgLapMean">Avg Lap <span class="sort-indicator"></span></th>
                    </tr>
                  </thead>
                  <tbody id="trackTableBody">
                    
                  </tbody>
                </table>
              </div>
            ` : ''}
          </div>
          
          <!-- Insights Section -->
          <div class="page-content" style="margin-top: 16px;">
            <h3>Insights</h3>
            <div class="insights-list">
              ${generateInsights(filteredRuns, kpis, trackStats)}
            </div>
          </div>
          
          <!-- Setup Changes vs Performance -->
          ${setupChanges.comparisons.length > 0 ? `
            <div class="page-content" style="margin-top: 16px;">
              <h3>Setup Changes vs Performance</h3>
              <p style="color: var(--text-secondary); font-size: 13px; margin-bottom: 12px;">
                <em>Directional analysis only - correlations shown here are not scientific proof of causation.</em>
              </p>
              
              <div style="overflow-x: auto; margin-top: 12px;">
                <table class="analytics-track-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Track</th>
                      <th># Changes</th>
                      <th>Best Lap Δ</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody id="setupChangesBody">
                    
                  </tbody>
                </table>
              </div>
              
              ${setupChanges.insights.length > 0 ? `
                <div class="insights-list" style="margin-top: 16px;">
                  ${setupChanges.insights.map(insight => `<div class="insight-item">💡 ${escapeHtml(insight)}</div>`).join('')}
                </div>
              ` : ''}
            </div>
          ` : ''}
        ` : ''}
      </div>
    `;
    
    const renderTrackTableBody = (tracksData) => {
      const tbody = document.getElementById('trackTableBody');
      if (!tbody) return;
      const fragment = document.createDocumentFragment();
      tracksData.forEach(track => {
        const row = document.createElement('tr');
        row.className = 'track-row';
        row.dataset.trackId = track.trackId;
        row.style.cursor = 'pointer';
        row.innerHTML = `
          <td><strong>${escapeHtml(track.trackName)}</strong></td>
          <td>${track.runCount}</td>
          <td>${track.bestLapMin !== null ? formatLapTime(track.bestLapMin) : '-'}</td>
          <td>${track.avgLapMean !== null ? formatLapTime(track.avgLapMean) : '-'}</td>
        `;
        row.addEventListener('click', () => {
          window.location.hash = `#/analytics/track/${track.trackId}`;
        });
        fragment.appendChild(row);
      });
      tbody.innerHTML = '';
      tbody.appendChild(fragment);
    };
    
    if (byTrack.length > 0) {
      renderTrackTableBody(byTrack);
    }
    
    const renderSetupChangesBody = () => {
      const tbody = document.getElementById('setupChangesBody');
      if (!tbody) return;
      const fragment = document.createDocumentFragment();
      setupChanges.comparisons.forEach(comp => {
        const row = document.createElement('tr');
        const dateStr = comp.date ? formatDateForDisplay(comp.date) : '-';
        row.innerHTML = `
          <td>${dateStr}</td>
          <td>${escapeHtml(comp.trackName)}</td>
          <td>${comp.changeCount}</td>
          <td style="color: ${comp.bestLapDelta < 0 ? 'green' : comp.bestLapDelta > 0 ? 'red' : 'inherit'};">
            ${comp.bestLapDelta !== null ? (comp.bestLapDelta >= 0 ? '+' : '') + comp.bestLapDelta.toFixed(3) + 's' : '-'}
          </td>
          <td style="font-size: 12px; color: var(--text-secondary);">${escapeHtml(comp.notes)}</td>
        `;
        fragment.appendChild(row);
      });
      tbody.innerHTML = '';
      tbody.appendChild(fragment);
    };
    
    if (setupChanges.comparisons.length > 0) {
      renderSetupChangesBody();
    }
    
    // Export CSV button
    document.getElementById('exportCsvBtn')?.addEventListener('click', () => {
      exportAnalyticsCsv(filteredRuns, analyticsContext, filters);
    });
    
    const getFiltersFromUI = () => ({
      carId: document.getElementById('filterCar').value || null,
      trackId: document.getElementById('filterTrack').value || null,
      dateFrom: document.getElementById('filterDateFrom').value || null,
      dateTo: document.getElementById('filterDateTo').value || null,
      sessionType: document.getElementById('filterSessionType').value || null
    });
    
    const applyFilterChange = ({ showToast = false } = {}) => {
      const newFilters = getFiltersFromUI();
      const newKey = JSON.stringify(newFilters);
      if (newKey === analyticsLastFiltersKey) return;
      analyticsLastFiltersKey = newKey;
      setAnalyticsFilters(newFilters);
      renderAnalyticsPage({ useCache: true, filtersOverride: newFilters });
      if (showToast) toast('Filters applied');
    };
    
    const debouncedFilters = debounce(() => applyFilterChange(), 250);
    document.querySelectorAll('.analytics-filter').forEach(el => {
      el.addEventListener('input', debouncedFilters);
      el.addEventListener('change', debouncedFilters);
    });
    
    // Attach event listeners for filters
    document.getElementById('applyFiltersBtn')?.addEventListener('click', () => {
      applyFilterChange({ showToast: true });
    });
    
    document.getElementById('resetFiltersBtn')?.addEventListener('click', () => {
      // Clear filters from localStorage
      const defaultFilters = {
        carId: null,
        trackId: null,
        dateFrom: null,
        dateTo: null,
        sessionType: null
      };
      setAnalyticsFilters(defaultFilters);
      analyticsLastFiltersKey = JSON.stringify(defaultFilters);
      
      const filterCar = document.getElementById('filterCar');
      const filterTrack = document.getElementById('filterTrack');
      const filterDateFrom = document.getElementById('filterDateFrom');
      const filterDateTo = document.getElementById('filterDateTo');
      const filterSessionType = document.getElementById('filterSessionType');
      if (filterCar) filterCar.value = '';
      if (filterTrack) filterTrack.value = '';
      if (filterDateFrom) filterDateFrom.value = '';
      if (filterDateTo) filterDateTo.value = '';
      if (filterSessionType) filterSessionType.value = '';
      
      renderAnalyticsPage({ useCache: true, filtersOverride: defaultFilters });
      toast('Filters reset');
    });
    
    const trackMetricSelect = document.getElementById('trackChartMetric');
    if (trackMetricSelect) {
      trackMetricSelect.value = previousTrackMetric;
      analyticsTrackMetric = trackMetricSelect.value;
    }
    
    const invertToggle = document.getElementById('invertYToggle');
    if (invertToggle) {
      invertToggle.checked = analyticsInvertY;
    }
    
    const triggerChartRender = () => {
      renderAnalyticsCharts(trendSeries, byTrack, analyticsTrackMetric, analyticsInvertY);
    };
    
    // Render charts only if we have runs
    if (hasRuns) {
      if (isDev) console.time('analytics:charts');
      triggerChartRender();
      if (isDev) console.timeEnd('analytics:charts');
    }
    
    // Track chart metric toggle
    trackMetricSelect?.addEventListener('change', (e) => {
      analyticsTrackMetric = e.target.value;
      triggerChartRender();
    });
    
    // Invert toggle
    invertToggle?.addEventListener('change', (e) => {
      analyticsInvertY = e.target.checked;
      triggerChartRender();
    });
    
    // Track table sorting
    let currentSort = { key: null, direction: 'asc' };
    document.querySelectorAll('.analytics-track-table .sortable').forEach(header => {
      header.addEventListener('click', () => {
        const sortKey = header.dataset.sort;
        
        // Toggle direction if clicking same column
        if (currentSort.key === sortKey) {
          currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
        } else {
          // Default sort direction based on column
          currentSort.key = sortKey;
          currentSort.direction = sortKey === 'runCount' ? 'desc' : 'asc';
        }
        
        // Sort the data
        const sortedTracks = [...byTrack].sort((a, b) => {
          let aVal = a[sortKey];
          let bVal = b[sortKey];
          
          // Handle null values
          if (aVal === null) return 1;
          if (bVal === null) return -1;
          
          // String comparison for trackName
          if (sortKey === 'trackName') {
            return currentSort.direction === 'asc' 
              ? aVal.localeCompare(bVal)
              : bVal.localeCompare(aVal);
          }
          
          // Numeric comparison
          return currentSort.direction === 'asc' ? aVal - bVal : bVal - aVal;
        });
        
        // Update table body with fragment
        renderTrackTableBody(sortedTracks);
        
        // Update sort indicators
        document.querySelectorAll('.analytics-track-table .sort-indicator').forEach(ind => {
          ind.textContent = '';
        });
        header.querySelector('.sort-indicator').textContent = currentSort.direction === 'asc' ? ' ▲' : ' ▼';
      });
    });
    
  } catch (error) {
    console.error('❌ Failed to load analytics:', error);
    app.innerHTML = '<div class="page"><p>Failed to load analytics. Please try again.</p></div>';
    toast('Failed to load analytics');
  }
}

// Render all analytics charts using Chart.js
function renderAnalyticsCharts(trendSeries, byTrack, trackMetric = 'avg', invertY = true) {
  const bestContainerId = 'bestLapChartContainer';
  const avgContainerId = 'avgLapChartContainer';
  const trackContainerId = 'trackChartContainer';
  if (!chartJsAvailable()) {
    setChartMessage(bestContainerId, 'Chart.js missing. Go to Settings → Reload app.');
    setChartMessage(avgContainerId, 'Chart.js missing. Go to Settings → Reload app.');
    setChartMessage(trackContainerId, 'Chart.js missing. Go to Settings → Reload app.');
    destroyAnalyticsCharts();
    return;
  }
  
  const sortedTrend = [...trendSeries].sort((a, b) => new Date(a.x) - new Date(b.x));
  const labels = sortedTrend.map(p => new Date(p.x).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  const bestData = sortedTrend.map(p => p.bestLap !== null ? p.bestLap : null);
  const avgData = sortedTrend.map(p => p.avgLap !== null ? p.avgLap : null);
  
  updateLineChart('best', 'bestLapChart', bestContainerId, labels, bestData, 'Best Lap', invertY);
  updateLineChart('avg', 'avgLapChart', avgContainerId, labels, avgData, 'Avg Lap', invertY);
  updateTrackBarChart(byTrack, trackMetric, invertY);
}

function updateLineChart(key, canvasId, containerId, labels, data, label, invertY) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const hasData = data.some(v => v !== null && !Number.isNaN(v));
  if (!hasData) {
    if (analyticsCharts[key]) {
      analyticsCharts[key].destroy();
      analyticsCharts[key] = null;
    }
    setChartMessage(containerId, 'No data');
    return;
  }
  clearChartMessage(containerId);
  const ctx = canvas.getContext('2d');
  const dataset = {
    label,
    data,
    borderColor: undefined,
    backgroundColor: undefined,
    tension: 0.2,
    spanGaps: true,
    pointRadius: 3
  };
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'nearest', intersect: false },
    scales: {
      x: { ticks: { maxRotation: 0, autoSkip: true } },
      y: {
        reverse: invertY,
        ticks: {
          callback: (value) => formatLapTime(Number(value))
        }
      }
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (context) => {
            const val = context.raw;
            return val === null || Number.isNaN(val) ? 'No data' : formatLapTime(Number(val));
          }
        }
      }
    }
  };
  if (!analyticsCharts[key]) {
    analyticsCharts[key] = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets: [dataset] },
      options
    });
  } else {
    const chart = analyticsCharts[key];
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.options.scales.y.reverse = invertY;
    chart.update();
  }
}

function updateTrackBarChart(byTrack, metric, invertY) {
  const canvas = document.getElementById('trackChart');
  const containerId = 'trackChartContainer';
  if (!canvas) return;
  const filtered = byTrack
    .filter(t => metric === 'avg' ? t.avgLapMean !== null : t.bestLapMin !== null);
  if (filtered.length === 0) {
    if (analyticsCharts.track) {
      analyticsCharts.track.destroy();
      analyticsCharts.track = null;
    }
    setChartMessage(containerId, 'No data');
    return;
  }
  clearChartMessage(containerId);
  const labels = filtered.map(t => t.trackName);
  const data = filtered.map(t => metric === 'avg' ? t.avgLapMean : t.bestLapMin);
  const ctx = canvas.getContext('2d');
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { ticks: { autoSkip: true, maxRotation: 45 } },
      y: {
        reverse: invertY,
        ticks: {
          callback: (value) => formatLapTime(Number(value))
        }
      }
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (context) => {
            const val = context.raw;
            return val === null || Number.isNaN(val) ? 'No data' : formatLapTime(Number(val));
          }
        }
      }
    }
  };
  const dataset = {
    label: metric === 'avg' ? 'Average Lap' : 'Best Lap',
    data,
    backgroundColor: undefined
  };
  if (!analyticsCharts.track) {
    analyticsCharts.track = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [dataset] },
      options
    });
  } else {
    const chart = analyticsCharts.track;
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.options.scales.y.reverse = invertY;
    chart.data.datasets[0].label = dataset.label;
    chart.update();
  }
}

// Analytics Track Drill-down Page
async function renderAnalyticsTrackDrilldownPage() {
  const app = document.getElementById('app');
  const hash = window.location.hash.slice(1);
  const trackId = hash.split('/')[3];
  
  if (!trackId) {
    window.location.hash = '#/analytics';
    return;
  }
  
  app.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  
  try {
    // Load all required data
    const [track, cars, events, runLogs] = await Promise.all([
      get('tracks', trackId),
      getAll('cars'),
      getAll('events'),
      getAll('runLogs')
    ]);
    
    if (!track) {
      app.innerHTML = `
        <div class="page">
          <p>Track not found</p>
          <button class="btn" onclick="window.location.hash='#/analytics'">Back to Analytics</button>
        </div>
      `;
      return;
    }
    
    // Build lookup maps
    const carsById = new Map(cars.map(car => [car.id, car]));
    const eventsById = new Map(events.map(event => [event.id, event]));
    
    // Filter runs for this track
    const trackEvents = events.filter(e => e.trackId === trackId);
    const trackEventIds = new Set(trackEvents.map(e => e.id));
    const trackRuns = runLogs
      .filter(run => trackEventIds.has(run.eventId))
      .map(run => ({
        ...run,
        eventDate: eventsById.get(run.eventId)?.date || null,
        bestLapNum: parseLap(run.bestLap),
        avgLapNum: parseLap(run.avgLap)
      }));
    
    // Aggregate data for this track
    if (isDev) console.time('analytics:trackDrill:aggregate');
    const { kpis, trendSeries } = aggregateRuns({
      runs: trackRuns,
      events: trackEvents,
      tracks: [track],
      cars,
      filters: {}
    });
    if (isDev) console.timeEnd('analytics:trackDrill:aggregate');
    
    // Sort runs by date (most recent first)
    const recentRuns = [...trackRuns]
      .sort((a, b) => new Date(b.eventDate || b.createdAt) - new Date(a.eventDate || a.createdAt))
      .slice(0, 20); // Show last 20 runs
    
    // Render page
    app.innerHTML = `
      <div class="page">
        <button class="btn-back" onclick="window.location.hash='#/analytics'">← Back to Analytics</button>
        
        <h2>${escapeHtml(track.name)} - Performance Analysis</h2>
        
        <!-- Track Summary -->
        <div class="page-content" style="margin-bottom: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <p><strong>Location:</strong> ${track.location ? escapeHtml(track.location) : 'Not specified'}</p>
              <p><strong>Surface:</strong> ${track.surface ? escapeHtml(track.surface) : 'Not specified'}</p>
            </div>
            <a href="#/track/${trackId}" class="btn btn-secondary">Open Track Details</a>
          </div>
        </div>
        
        <!-- KPI Cards -->
        <div class="analytics-kpi-grid">
          <div class="kpi-card">
            <div class="kpi-label">Best Lap</div>
            <div class="kpi-value">${kpis.bestLapMin !== null ? formatLapTime(kpis.bestLapMin) : '-'}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Avg Lap</div>
            <div class="kpi-value">${kpis.avgLapMean !== null ? formatLapTime(kpis.avgLapMean) : '-'}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label"># Runs</div>
            <div class="kpi-value">${kpis.runCount}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label"># Events</div>
            <div class="kpi-value">${kpis.eventCount}</div>
          </div>
        </div>
        
        <!-- Best Lap Trend Chart -->
        <div class="page-content" style="margin-top: 16px;">
          <h3>Best Lap Time Trend</h3>
          <div id="trackDrillBestLapContainer" style="width: 100%;">
            <canvas id="trackDrillBestLapChart"></canvas>
          </div>
        </div>
        
        <!-- Avg Lap Trend Chart -->
        <div class="page-content" style="margin-top: 16px;">
          <h3>Average Lap Time Trend</h3>
          <div id="trackDrillAvgLapContainer" style="width: 100%;">
            <canvas id="trackDrillAvgLapChart"></canvas>
          </div>
        </div>
        
        <!-- Recent Runs -->
        <div class="page-content" style="margin-top: 16px;">
          <h3>Recent Runs</h3>
          ${recentRuns.length > 0 ? `
            <div style="overflow-x: auto;">
              <table class="analytics-track-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Car</th>
                    <th>Session</th>
                    <th>Best Lap</th>
                    <th>Avg Lap</th>
                  </tr>
                </thead>
                <tbody>
                  ${recentRuns.map(run => {
                    const car = carsById.get(run.carId);
                    const event = eventsById.get(run.eventId);
                    return `
                      <tr>
                        <td>${run.eventDate ? formatDateForDisplay(run.eventDate) : '-'}</td>
                        <td>${car ? escapeHtml(car.name) : 'Unknown'}</td>
                        <td>${run.sessionType || '-'}</td>
                        <td>${run.bestLapNum !== null ? formatLapTime(run.bestLapNum) : '-'}</td>
                        <td>${run.avgLapNum !== null ? formatLapTime(run.avgLapNum) : '-'}</td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          ` : '<p style="color: var(--text-secondary);">No runs recorded for this track yet.</p>'}
        </div>
      </div>
    `;
    
    // Render charts
    const drillChartsTimer = isDev ? 'analytics:trackDrill:charts' : null;
    if (drillChartsTimer) console.time(drillChartsTimer);
    const bestLapCanvas = document.getElementById('trackDrillBestLapChart');
    if (bestLapCanvas) {
      const bestLapPoints = trendSeries
        .filter(p => p.bestLap !== null)
        .map(p => ({
          date: new Date(p.x).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          lap: p.bestLap
        }));
      
      renderLineChart(bestLapCanvas, {
        title: 'Best Lap Time Trend',
        points: bestLapPoints,
        xKey: 'date',
        yKey: 'lap',
        yLabel: 'Lap Time (s)',
        formatY: (val) => formatLapTime(val)
      });
    }
    
    const avgLapCanvas = document.getElementById('trackDrillAvgLapChart');
    if (avgLapCanvas) {
      const avgLapPoints = trendSeries
        .filter(p => p.avgLap !== null)
        .map(p => ({
          date: new Date(p.x).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          lap: p.avgLap
        }));
      
      renderLineChart(avgLapCanvas, {
        title: 'Average Lap Time Trend',
        points: avgLapPoints,
        xKey: 'date',
        yKey: 'lap',
        yLabel: 'Lap Time (s)',
        formatY: (val) => formatLapTime(val)
      });
    }
    if (drillChartsTimer) console.timeEnd(drillChartsTimer);
    
  } catch (error) {
    console.error('❌ Failed to load track drill-down:', error);
    app.innerHTML = '<div class="page"><p>Failed to load track data. Please try again.</p></div>';
    toast('Failed to load track data');
  }
}

// Helper function to render a simple line chart
function renderSimpleLineChart(data) {
  if (data.length === 0) return '<p>No data</p>';
  
  // Use bestLap for charting (primary metric)
  const lapTimes = data.map(d => d.bestLap || d.avgLap).filter(lap => lap !== null);
  if (lapTimes.length === 0) return '<p>No valid lap times</p>';
  
  const maxLap = Math.max(...lapTimes);
  const minLap = Math.min(...lapTimes);
  const range = maxLap - minLap || 1;
  
  return `
    <div class="chart-points">
      ${data.map((d, i) => {
        const lapTime = d.bestLap || d.avgLap;
        if (lapTime === null) return '';
        const height = ((maxLap - lapTime) / range) * 100;
        return `
          <div class="chart-point" style="left: ${(i / Math.max(1, data.length - 1)) * 100}%; bottom: ${height}%;" title="${d.date}: ${formatLapTime(lapTime)}">
            <div class="chart-dot"></div>
          </div>
        `;
      }).join('')}
    </div>
    <div class="chart-labels">
      ${data.length > 0 ? `<span>${data[0].date}</span>` : ''}
      ${data.length > 1 ? `<span>${data[data.length - 1].date}</span>` : ''}
    </div>
  `;
}

// Helper function to generate insights
function generateInsights(runs, kpis, trackStats) {
  const insights = [];
  
  if (runs.length === 0) {
    return '<p style="color: var(--text-secondary);">No data available to generate insights.</p>';
  }
  
  // Insight 1: Best lap vs avg improvement potential
  if (kpis.bestLapMin && kpis.avgLapMean) {
    const improvement = ((kpis.avgLapMean - kpis.bestLapMin) / kpis.avgLapMean * 100).toFixed(1);
    insights.push(`Your best lap is ${improvement}% faster than your average - there's room for consistency improvement.`);
  }
  
  // Insight 2: Most practiced track
  if (trackStats.length > 0) {
    const mostPracticed = trackStats.reduce((a, b) => a.laps > b.laps ? a : b);
    insights.push(`You've run the most laps at ${escapeHtml(mostPracticed.name)} (${mostPracticed.laps} laps).`);
  }
  
  // Insight 3: Best track performance
  if (trackStats.length > 1) {
    const bestTrack = trackStats.reduce((a, b) => 
      (a.bestLap !== null && b.bestLap !== null && a.bestLap < b.bestLap) ? a : b
    );
    if (bestTrack.bestLap) {
      insights.push(`Your fastest performance was at ${escapeHtml(bestTrack.name)} with a ${formatLapTime(bestTrack.bestLap)} lap.`);
    }
  }
  
  // Insight 4: Recent trend analysis
  const recentRuns = runs
    .map(r => ({ ...r, bestLap: parseLap(r.bestLap) }))
    .filter(r => r.bestLap !== null)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5);
  
  if (recentRuns.length >= 3 && kpis.bestLapMin) {
    const recentAvg = recentRuns.reduce((sum, r) => sum + r.bestLap, 0) / recentRuns.length;
    if (recentAvg < kpis.bestLapMin * 1.05) { // Within 5% of best
      const improvement = ((kpis.avgLapMean - recentAvg) / kpis.avgLapMean * 100).toFixed(1);
      insights.push(`🎉 Your recent 5 runs average ${formatLapTime(recentAvg)} - you're performing ${improvement}% better than overall average!`);
    } else if (kpis.avgLapMean && recentAvg > kpis.avgLapMean) {
      insights.push(`Your recent runs are slower than average - consider reviewing your setup or driving technique.`);
    }
  }
  
  if (insights.length === 0) {
    return '<p style="color: var(--text-secondary);">Not enough data to generate insights yet.</p>';
  }
  
  return insights.map(insight => `<div class="insight-item">💡 ${insight}</div>`).join('');
}

function buildInsightCards(filteredRuns, analyticsContext) {
  const cards = [];
  if (!filteredRuns || filteredRuns.length === 0) return cards;
  const { carsById, tracksById } = analyticsContext;
  
  // Best track by lowest avg lap
  const trackAgg = new Map();
  filteredRuns.forEach(run => {
    if (!run.trackId || run.avgLapNum === null || Number.isNaN(run.avgLapNum)) return;
    const entry = trackAgg.get(run.trackId) || { sum: 0, count: 0 };
    entry.sum += run.avgLapNum;
    entry.count += 1;
    trackAgg.set(run.trackId, entry);
  });
  let bestTrack = null;
  trackAgg.forEach((val, trackId) => {
    if (val.count === 0) return;
    const avg = val.sum / val.count;
    if (!bestTrack || avg < bestTrack.avg) {
      const track = tracksById.get(trackId);
      if (track?.name) {
        bestTrack = { name: track.name, avg };
      }
    }
  });
  if (bestTrack) {
    cards.push({
      title: 'Best Track',
      value: bestTrack.name,
      detail: `Avg Lap ${formatLapTime(bestTrack.avg)}`
    });
  }
  
  // Most-used car
  const carCounts = new Map();
  filteredRuns.forEach(run => {
    if (!run.carId) return;
    carCounts.set(run.carId, (carCounts.get(run.carId) || 0) + 1);
  });
  let topCar = null;
  carCounts.forEach((count, carId) => {
    const car = carsById.get(carId);
    if (!car?.name) return;
    if (!topCar || count > topCar.count) {
      topCar = { name: car.name, count };
    }
  });
  if (topCar) {
    cards.push({
      title: 'Most-used Car',
      value: topCar.name,
      detail: `${topCar.count} run${topCar.count > 1 ? 's' : ''}`
    });
  }
  
  // Most-improved day (largest negative delta vs previous run)
  const runsWithBest = filteredRuns
    .filter(r => r.bestLapNum !== null && !Number.isNaN(r.bestLapNum) && (r.eventDate || r.createdAt))
    .sort((a, b) => new Date(a.eventDate || a.createdAt) - new Date(b.eventDate || b.createdAt));
  let bestDelta = null;
  for (let i = 1; i < runsWithBest.length; i++) {
    const prev = runsWithBest[i - 1];
    const curr = runsWithBest[i];
    if (prev.bestLapNum === null || curr.bestLapNum === null) continue;
    const delta = curr.bestLapNum - prev.bestLapNum;
    if (delta < 0 && (bestDelta === null || delta < bestDelta.delta)) {
      bestDelta = {
        delta,
        date: curr.eventDate || curr.createdAt
      };
    }
  }
  if (bestDelta) {
    cards.push({
      title: 'Most-improved Day',
      value: bestDelta.date ? formatDateForDisplay(bestDelta.date) : 'Unknown date',
      detail: `${bestDelta.delta.toFixed(3)}s vs prior run`
    });
  }
  
  return cards;
}

async function renderSettingsPage() {
  const app = document.getElementById('app');
  
  // Show loading skeleton
  app.innerHTML = `
    <div class="page">
      <h2>Settings</h2>
      ${renderLoadingSkeleton(2)}
    </div>
  `;
  
  try {
    // Get database statistics
    const stats = {
      cars: (await getAll('cars')).length,
      setups: (await getAll('setups')).length,
      tracks: (await getAll('tracks')).length,
      events: (await getAll('events')).length,
      runLogs: (await getAll('runLogs')).length
    };
    
    const installButton = state.installPrompt 
      ? '<button class="btn" id="installBtn">📱 Install App</button>'
      : '<p style="color: var(--text-secondary); font-size: 14px;">App is already installed or not installable</p>';
    
    app.innerHTML = `
      <div class="page">
        <h2>Settings</h2>
        
        <!-- App Info -->
        <div class="page-content" style="margin-bottom: 16px;">
          <h3 style="margin-bottom: 12px;">App Information</h3>
          <div class="detail-row">
            <strong>Version:</strong> 1.1.2
          </div>
          <div class="detail-row">
            <strong>Database:</strong> rc_program v1
          </div>
        </div>
        <!-- Preferences -->
        <div class="page-content" style="margin-bottom: 16px;">
          <h3 style="margin-bottom: 12px;">Preferences</h3>
          <div class="form-group">
            <label for="preferredUnitSetting">Preferred Wheel Unit</label>
            <div style="display:flex; gap:8px; align-items:center;">
              <select id="preferredUnitSetting">
                <option value="in">inches</option>
                <option value="mm">mm</option>
              </select>
              <button class="btn" id="savePreferredUnit">Save</button>
            </div>
            <div class="form-hint" style="margin-top:6px;font-size:12px;color:var(--text-secondary);">This controls the default unit for calculators.</div>
          </div>
        </div>
        
        <!-- Database Statistics -->
        <div class="page-content" style="margin-bottom: 16px;">
          <h3 style="margin-bottom: 12px;">Database Statistics</h3>
          <div class="detail-row">
            <strong>Cars:</strong> ${stats.cars}
          </div>
          <div class="detail-row">
            <strong>Setups:</strong> ${stats.setups}
          </div>
          <div class="detail-row">
            <strong>Tracks:</strong> ${stats.tracks}
          </div>
          <div class="detail-row">
            <strong>Events:</strong> ${stats.events}
          </div>
          <div class="detail-row">
            <strong>Run Logs:</strong> ${stats.runLogs}
          </div>
          <div class="detail-row">
            <strong>Total Records:</strong> ${Object.values(stats).reduce((a, b) => a + b, 0)}
          </div>
        </div>
        
        <!-- Install App -->
        <div class="page-content" style="margin-bottom: 16px;">
          <h3 style="margin-bottom: 12px;">Install App</h3>
          <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 12px;">
            Install this app to your device for offline access and a native app experience.
          </p>
          ${installButton}
        </div>
        
        <!-- Backup & Restore -->
        <div class="page-content" style="margin-bottom: 16px;">
          <h3 style="margin-bottom: 12px;">Backup & Restore</h3>
          <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 12px;">
            Export your data as a JSON file for backup or import to restore from a previous backup.
            All operations work offline.
          </p>
          <div style="display: flex; flex-direction: column; gap: 12px;">
            <button class="btn" id="exportBackupBtn">💾 Export Backup</button>
            <div>
              <label for="importBackupFile" class="btn" style="cursor: pointer; display: inline-block;">
                📂 Import Backup
              </label>
              <input type="file" id="importBackupFile" accept=".json" style="display: none;">
            </div>
          </div>
        </div>

        <!-- Developer Tools -->
        <div class="page-content" style="margin-bottom: 16px;">
          <h3 style="margin-bottom: 12px;">Developer Tools</h3>
          <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 12px;">
            Use these during development to clear local data when schemas change. These actions only affect this device.
          </p>
          <div style="display: flex; flex-direction: column; gap: 12px;">
            <button class="btn" id="deleteDataBtn" style="background-color: #b71c1c; color: #fff;">Delete Data (keep schema)</button>
            <button class="btn" id="resetAppBtn" style="background-color: #6a1b9a; color: #fff;">Reset App (drop DB)</button>
            <button class="btn" id="loadSampleDataBtn" style="background-color: #1565c0; color: #fff;">Load Sample Data (dev)</button>
          </div>
        </div>
        
        <!-- About -->
        <div class="page-content">
          <h3 style="margin-bottom: 12px;">About</h3>
          <p style="color: var(--text-secondary); font-size: 14px;">
            RC Race Program - Track your RC racing adventures with cars, setups, tracks, and events.
            All data is stored locally on your device using IndexedDB.
          </p>
        </div>
      </div>
    `;

    // Initialize preferences control
    const prefSelect = document.getElementById('preferredUnitSetting');
    if (prefSelect) {
      prefSelect.value = getPreferredUnit();
      document.getElementById('savePreferredUnit').addEventListener('click', () => {
        const val = prefSelect.value;
        setPreferredUnit(val);
        toast('Preferred unit saved');
      });
    }
    
    // Attach event listener for install button if available
    if (state.installPrompt) {
      const btn = document.getElementById('installBtn');
      if (btn) {
        btn.addEventListener('click', handleInstallClick);
      }
    }
    
    // Attach backup/restore event listeners
    document.getElementById('exportBackupBtn')?.addEventListener('click', exportBackup);
    document.getElementById('importBackupFile')?.addEventListener('change', handleImportBackup);

    // Developer tools
    document.getElementById('deleteDataBtn')?.addEventListener('click', handleDeleteUserData);
    document.getElementById('resetAppBtn')?.addEventListener('click', handleResetApp);
    // Load sample JSON backup from project root (development only)
    document.getElementById('loadSampleDataBtn')?.addEventListener('click', async () => {
      if (!confirm('This will import sample test data from the bundled backup file and may overwrite existing data. Continue?')) return;
      try {
        toast('Loading sample data...');
        await loadSampleData();
        toast('✅ Sample data imported');
        renderSettingsPage();
      } catch (err) {
        console.error('❌ Failed to load sample data:', err);
        toast('❌ Failed to load sample data');
      }
    });
    
    
  } catch (error) {
    console.error('❌ Failed to load settings:', error);
    app.innerHTML = '<div class="page"><p>Failed to load settings. Please try again.</p></div>';
    toast('Failed to load settings');
  }
}

// Tools Page
function renderToolsPage() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="page">
      <h2>Tools</h2>

      <div class="page-content" style="margin-bottom:16px;">
        <h3>Gear Ratio / Rollout Calculator</h3>
        <p style="color: var(--text-secondary);">Simple calculator: enter a pinion and spur to compute final drive ratio and rollout for a single-stage setup.</p>
        <form id="gearSimpleForm">
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
            <div class="form-group">
              <label>Pinion</label>
              <input id="simplePinion" type="number" min="1" placeholder="e.g. 13">
            </div>
            <div class="form-group">
              <label>Spur</label>
              <input id="simpleSpur" type="number" min="1" placeholder="e.g. 65">
            </div>
          </div>
          <div class="form-group">
            <label>Wheel Diameter</label>
            <div style="display:flex; gap:8px; align-items:center;">
              <input id="simpleWheelDiameter" type="number" min="0.1" step="0.01" placeholder="e.g. 2.6">
              <select id="simpleUnit" title="Unit" style="width:110px;">
                <option value="in" selected>inches</option>
                <option value="mm">mm</option>
              </select>
            </div>
          </div>
          <div style="display:flex; gap:8px;">
            <button class="btn" type="submit">Calculate</button>
            <button class="btn btn-secondary" type="button" id="simpleReset">Reset</button>
          </div>
        </form>
        <div id="gearSimpleResult" style="margin-top:12px;"></div>
        <hr style="margin:16px 0;">
        <h3>Compare - Gear Ratio / Rollout Calculator</h3>
        <p style="color: var(--text-secondary);">Enter your before and after gearing and wheel diameter to compare final drive and rollout.</p>
        <form id="gearForm">
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
            <div class="form-group">
              <label>Before Pinion</label>
              <input id="beforePinion" type="number" min="1" placeholder="e.g. 13">
            </div>
            <div class="form-group">
              <label>Before Spur</label>
              <input id="beforeSpur" type="number" min="1" placeholder="e.g. 65">
            </div>
            <div class="form-group">
              <label>After Pinion</label>
              <input id="afterPinion" type="number" min="1" placeholder="e.g. 14">
            </div>
            <div class="form-group">
              <label>After Spur</label>
              <input id="afterSpur" type="number" min="1" placeholder="e.g. 65">
            </div>
          </div>
          <div class="form-group">
            <label>Wheel Diameter</label>
            <div style="display:flex; gap:8px; align-items:center;">
              <input id="gearWheelDiameter" type="number" min="0.1" step="0.01" placeholder="e.g. 2.6">
              <select id="gearUnit" title="Unit" style="width:110px;">
                <option value="in" selected>inches</option>
                <option value="mm">mm</option>
              </select>
            </div>
            <div class="form-hint" style="margin-top:6px;font-size:12px;color:var(--text-secondary);">Default: inches. Enter wheel diameter with mounted tire.</div>
          </div>
          <div style="display:flex; gap:8px;">
            <button class="btn" type="submit">Compare Gearing</button>
            <button class="btn btn-secondary" type="button" id="gearReset">Reset</button>
          </div>
        </form>
        <div id="gearResult" style="margin-top:12px;"></div>
      </div>

      <div class="page-content">
        <h3>Top Speed Estimator</h3>
        <p style="color: var(--text-secondary);">Estimate theoretical top speed for brushless electric cars.</p>
        <form id="topSpeedForm">
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
            <div class="form-group">
              <label>Motor KV</label>
              <input id="kv" type="number" step="1" min="1" placeholder="e.g. 4000">
            </div>
            <div class="form-group">
              <label>Battery Voltage (V)</label>
              <input id="voltage" type="number" step="0.1" min="1" placeholder="e.g. 14.8">
            </div>
            <div class="form-group">
              <label>Final Drive Ratio (motor revs per wheel rev)</label>
              <input id="finalDrive" type="number" step="0.01" min="0.01" placeholder="e.g. 4.5">
            </div>
            <div class="form-group">
              <label>Wheel Diameter</label>
              <div style="display:flex; gap:8px; align-items:center;">
                <input id="wheelDiameter" type="number" step="0.01" min="0.1" placeholder="e.g. 2.6">
                <select id="topUnit" title="Unit" style="width:110px;">
                  <option value="in" selected>inches</option>
                  <option value="mm">mm</option>
                </select>
              </div>
              <div class="form-hint" style="margin-top:6px;font-size:12px;color:var(--text-secondary);">Default: inches. Enter wheel diameter with mounted tire.</div>
            </div>
          </div>
          <div class="form-group">
            <label>Drivetrain Efficiency (0-1)</label>
            <input id="efficiency" type="number" step="0.01" min="0.5" max="1" value="0.95">
          </div>
          <div style="display:flex; gap:8px;">
            <button class="btn" type="submit">Estimate Top Speed</button>
            <button class="btn btn-secondary" type="button" id="topReset">Reset</button>
          </div>
        </form>
        <div id="topSpeedResult" style="margin-top:12px;"></div>
      </div>

      <div class="page-content">
        <h3>Shock Oil Conversion</h3>
        <p style="color: var(--text-secondary);">Convert between CST, Associated, and Losi shock oil weights.</p>
        <form id="shockOilForm">
          <div class="form-group">
            <label>Oil Weight</label>
            <input id="shockOilValue" type="number" step="0.5" min="0" placeholder="e.g. 300">
          </div>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
            <div class="form-group">
              <label>From</label>
              <select id="shockOilFrom">
                <option value="cst">CST</option>
                <option value="associated">Associated</option>
                <option value="losi">Losi</option>
              </select>
            </div>
            <div class="form-group">
              <label>To</label>
              <select id="shockOilTo">
                <option value="associated">Associated</option>
                <option value="losi">Losi</option>
                <option value="cst">CST</option>
              </select>
            </div>
          </div>
          <div style="display:flex; gap:8px;">
            <button class="btn" type="submit">Convert</button>
            <button class="btn btn-secondary" type="button" id="shockOilReset">Reset</button>
          </div>
        </form>
        <div id="shockOilResult" style="margin-top:12px;"></div>
      </div>
    </div>
  `;

  // Initialize unit selectors from preferences
  (function initUnitSelectors(){
    const pref = getPreferredUnit();
    const gearUnitElInit = document.getElementById('gearUnit');
    const topUnitElInit = document.getElementById('topUnit');
    const simpleUnitElInit = document.getElementById('simpleUnit');
    const gearInputInit = document.getElementById('gearWheelDiameter');
    const topInputInit = document.getElementById('wheelDiameter');
    const simpleInputInit = document.getElementById('simpleWheelDiameter');
    if (gearUnitElInit) gearUnitElInit.value = pref;
    if (topUnitElInit) topUnitElInit.value = pref;
    if (simpleUnitElInit) simpleUnitElInit.value = pref;
    if (gearInputInit) {
      if (pref === 'in') { gearInputInit.placeholder = 'e.g. 2.6'; gearInputInit.step = '0.01'; }
      else { gearInputInit.placeholder = 'e.g. 66'; gearInputInit.step = '1'; }
    }
    if (topInputInit) {
      if (pref === 'in') { topInputInit.placeholder = 'e.g. 2.6'; topInputInit.step = '0.01'; }
      else { topInputInit.placeholder = 'e.g. 66'; topInputInit.step = '1'; }
    }
    if (simpleInputInit) {
      if (pref === 'in') { simpleInputInit.placeholder = 'e.g. 2.6'; simpleInputInit.step = '0.01'; }
      else { simpleInputInit.placeholder = 'e.g. 66'; simpleInputInit.step = '1'; }
    }
  })();

  // Handlers
  document.getElementById('gearForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const beforePinion = Number(document.getElementById('beforePinion').value) || null;
    const beforeSpur = Number(document.getElementById('beforeSpur').value) || null;
    const afterPinion = Number(document.getElementById('afterPinion').value) || null;
    const afterSpur = Number(document.getElementById('afterSpur').value) || null;
    const wheelDiameterRaw = document.getElementById('gearWheelDiameter').value;
    const wheelDiameter = wheelDiameterRaw ? Number(wheelDiameterRaw) : null;
    const gearUnit = document.getElementById('gearUnit') ? document.getElementById('gearUnit').value : 'in';
    const wheelDiameterMm = (wheelDiameter && gearUnit === 'in') ? wheelDiameter * 25.4 : wheelDiameter;

    const beforeSpec = { pinion: beforePinion, spur: beforeSpur, wheelDiameterMm: wheelDiameterMm };
    const afterSpec = { pinion: afterPinion, spur: afterSpur, wheelDiameterMm: wheelDiameterMm };

    const result = window.Calculators.compareGearing(beforeSpec, afterSpec);
    const out = document.getElementById('gearResult');
    if (!result || !result.before.finalDriveRatio || !result.after.finalDriveRatio) {
      out.innerHTML = '<div class="data-quality-hint">Enter valid pinion and spur values for both before and after.</div>';
      return;
    }

    // Show rollout in preferred unit (inches default)
    const beforeRolloutMm = result.before.rolloutMm;
    const afterRolloutMm = result.after.rolloutMm;
    const beforeRolloutIn = beforeRolloutMm ? (beforeRolloutMm / 25.4) : null;
    const afterRolloutIn = afterRolloutMm ? (afterRolloutMm / 25.4) : null;

    const rolloutLabelFirst = gearUnit === 'in' ? 'inches' : 'mm';
    out.innerHTML = `
      <div class="detail-row"><strong>Before Final Drive:</strong> ${result.before.finalDriveRatio.toFixed(3)}</div>
      <div class="detail-row"><strong>After Final Drive:</strong> ${result.after.finalDriveRatio.toFixed(3)}</div>
      <div class="detail-row"><strong>Final Drive Change:</strong> ${result.change.finalDrivePercent !== null ? result.change.finalDrivePercent.toFixed(2) + '%' : 'N/A'}</div>
      <div class="detail-row"><strong>Before Rollout:</strong> ${gearUnit === 'in' ? (beforeRolloutIn ? beforeRolloutIn.toFixed(3) + ' in' : 'N/A') : (beforeRolloutMm ? beforeRolloutMm.toFixed(2) + ' mm' : 'N/A')} ${gearUnit === 'in' ? `(${beforeRolloutMm ? beforeRolloutMm.toFixed(2) + ' mm' : 'N/A'})` : `(${beforeRolloutIn ? beforeRolloutIn.toFixed(3) + ' in' : 'N/A'})`}</div>
      <div class="detail-row"><strong>After Rollout:</strong> ${gearUnit === 'in' ? (afterRolloutIn ? afterRolloutIn.toFixed(3) + ' in' : 'N/A') : (afterRolloutMm ? afterRolloutMm.toFixed(2) + ' mm' : 'N/A')} ${gearUnit === 'in' ? `(${afterRolloutMm ? afterRolloutMm.toFixed(2) + ' mm' : 'N/A'})` : `(${afterRolloutIn ? afterRolloutIn.toFixed(3) + ' in' : 'N/A'})`}</div>
      <div class="detail-row"><strong>Rollout Change:</strong> ${result.change.rolloutPercent !== null ? result.change.rolloutPercent.toFixed(2) + '%' : 'N/A'}</div>
    `;
  });

  document.getElementById('gearReset').addEventListener('click', () => {
    document.getElementById('beforePinion').value = '';
    document.getElementById('beforeSpur').value = '';
    document.getElementById('afterPinion').value = '';
    document.getElementById('afterSpur').value = '';
    document.getElementById('gearWheelDiameter').value = '';
    document.getElementById('gearResult').innerHTML = '';
  });

  // Simple gear calculator handlers
  document.getElementById('gearSimpleForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const pinion = Number(document.getElementById('simplePinion').value) || null;
    const spur = Number(document.getElementById('simpleSpur').value) || null;
    const wheelDiameterRaw = document.getElementById('simpleWheelDiameter').value;
    const wheelDiameter = wheelDiameterRaw ? Number(wheelDiameterRaw) : null;
    const unit = document.getElementById('simpleUnit') ? document.getElementById('simpleUnit').value : 'in';
    const wheelDiameterMm = (wheelDiameter && unit === 'in') ? wheelDiameter * 25.4 : wheelDiameter;

    const out = document.getElementById('gearSimpleResult');
    if (!pinion || !spur) {
      out.innerHTML = '<div class="data-quality-hint">Enter valid pinion and spur values.</div>';
      return;
    }

    const ratio = window.Calculators.computeGearRatio(pinion, spur);
    const rolloutMm = ratio && wheelDiameterMm ? window.Calculators.computeRolloutMm(ratio, wheelDiameterMm) : null;
    const rolloutIn = rolloutMm ? rolloutMm / 25.4 : null;

    out.innerHTML = `
      <div class="detail-row"><strong>Final Drive (motor revs per wheel rev):</strong> ${ratio ? ratio.toFixed(3) : 'N/A'}</div>
      <div class="detail-row"><strong>Rollout:</strong> ${unit === 'in' ? (rolloutIn ? rolloutIn.toFixed(3) + ' in' : 'N/A') : (rolloutMm ? rolloutMm.toFixed(2) + ' mm' : 'N/A')}</div>
    `;
  });

  document.getElementById('simpleReset').addEventListener('click', () => {
    document.getElementById('simplePinion').value = '';
    document.getElementById('simpleSpur').value = '';
    document.getElementById('simpleWheelDiameter').value = '';
    document.getElementById('gearSimpleResult').innerHTML = '';
  });

  document.getElementById('topSpeedForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const kv = Number(document.getElementById('kv').value) || null;
    const voltage = Number(document.getElementById('voltage').value) || null;
    const finalDrive = Number(document.getElementById('finalDrive').value) || null;
    const wheelDiameterRaw = document.getElementById('wheelDiameter').value;
    const wheelDiameter = wheelDiameterRaw ? Number(wheelDiameterRaw) : null;
    const topUnit = document.getElementById('topUnit') ? document.getElementById('topUnit').value : 'in';
    const wheelDiameterMm = (wheelDiameter && topUnit === 'in') ? wheelDiameter * 25.4 : wheelDiameter;
    const efficiency = Number(document.getElementById('efficiency').value) || 0.95;

    const res = window.Calculators.estimateTopSpeed({ kv, voltage, finalDriveRatio: finalDrive, wheelDiameterMm: wheelDiameterMm, efficiency });
    const out = document.getElementById('topSpeedResult');
    if (!res) {
      out.innerHTML = '<div class="data-quality-hint">Enter valid inputs for KV, voltage, final drive and wheel diameter.</div>';
      return;
    }

    // Display wheel circumference unit-aware
    const wheelMm = wheelDiameterMm;
    const wheelIn = wheelMm ? (wheelMm / 25.4) : null;
    out.innerHTML = `
      <div class="detail-row"><strong>Estimated Top Speed:</strong> ${res.speedKph} km/h (${res.speedMph} mph)</div>
      <div class="detail-row"><strong>Motor RPM:</strong> ${res.motorRpm}</div>
      <div class="detail-row"><strong>Wheel RPM:</strong> ${res.wheelRpm}</div>
      <div class="detail-row"><strong>Wheel Diameter:</strong> ${topUnit === 'in' ? (wheelIn ? wheelIn.toFixed(3) + ' in' : 'N/A') : (wheelMm ? wheelMm.toFixed(2) + ' mm' : 'N/A')} ${topUnit === 'in' ? `(${wheelMm ? wheelMm.toFixed(2) + ' mm' : 'N/A'})` : `(${wheelIn ? wheelIn.toFixed(3) + ' in' : 'N/A'})`}</div>
    `;
  });

  document.getElementById('topReset').addEventListener('click', () => {
    document.getElementById('kv').value = '';
    document.getElementById('voltage').value = '';
    document.getElementById('finalDrive').value = '';
    document.getElementById('wheelDiameter').value = '';
    document.getElementById('efficiency').value = '0.95';
    document.getElementById('topSpeedResult').innerHTML = '';
  });

  // Shock Oil Conversion handlers
  document.getElementById('shockOilForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = Number(document.getElementById('shockOilValue').value) || null;
    const fromUnit = document.getElementById('shockOilFrom').value;
    const toUnit = document.getElementById('shockOilTo').value;

    const out = document.getElementById('shockOilResult');
    if (!value || value <= 0) {
      out.innerHTML = '<div class="data-quality-hint">Enter a valid oil weight value.</div>';
      return;
    }

    if (fromUnit === toUnit) {
      out.innerHTML = '<div class="data-quality-hint">Please select different units to convert.</div>';
      return;
    }

    const result = window.Calculators.convertShockOil(value, fromUnit, toUnit);
    if (!result) {
      out.innerHTML = '<div class="data-quality-hint">Unable to convert. Value may be out of range.</div>';
      return;
    }

    const fromLabel = fromUnit.toUpperCase();
    const toLabel = toUnit.toUpperCase();
    out.innerHTML = `
      <div class="detail-row"><strong>${value} ${fromLabel}</strong> ≈ <strong>${result} ${toLabel}</strong></div>
      <div class="form-hint" style="margin-top:8px;font-size:12px;color:var(--text-secondary);">Conversion based on closest match in standard oil weight chart.</div>
    `;
  });

  document.getElementById('shockOilReset').addEventListener('click', () => {
    document.getElementById('shockOilValue').value = '';
    document.getElementById('shockOilResult').innerHTML = '';
  });

  // Unit toggle behavior: update placeholders when switching units
  const gearUnitEl = document.getElementById('gearUnit');
  if (gearUnitEl) {
    gearUnitEl.addEventListener('change', (e) => {
      const unit = e.target.value;
      setPreferredUnit(unit);
      const input = document.getElementById('gearWheelDiameter');
      if (!input) return;
      if (unit === 'in') {
        input.placeholder = 'e.g. 2.6';
        input.step = '0.01';
      } else {
        input.placeholder = 'e.g. 66';
        input.step = '1';
      }
      // keep other selector in sync
      const other = document.getElementById('topUnit');
      if (other && other.value !== unit) other.value = unit;
    });
  }

  const topUnitEl = document.getElementById('topUnit');
  if (topUnitEl) {
    topUnitEl.addEventListener('change', (e) => {
      const unit = e.target.value;
      setPreferredUnit(unit);
      const input = document.getElementById('wheelDiameter');
      if (!input) return;
      if (unit === 'in') {
        input.placeholder = 'e.g. 2.6';
        input.step = '0.01';
      } else {
        input.placeholder = 'e.g. 66';
        input.step = '1';
      }
      // keep other selector in sync
      const other = document.getElementById('gearUnit');
      if (other && other.value !== unit) other.value = unit;
    });
  }
}

// Developer helpers for data reset
async function handleDeleteUserData() {
  const confirmed = window.confirm('Delete all user data? This keeps the database schema but removes all records on this device.');
  if (!confirmed) return;

  try {
    await clearAllStores();
    analyticsDataCache = null;
    analyticsLastFiltersKey = null;
    analyticsCharts = { best: null, avg: null, track: null };
    destroyAnalyticsCharts();
    toast('All local data deleted.');
    // Re-render settings to update stats
    if (state.currentRoute === '/settings') {
      renderSettingsPage();
    }
  } catch (error) {
    console.error('❌ Failed to delete data:', error);
    toast('Failed to delete data. See console.');
  }
}

async function handleResetApp() {
  const confirmed = window.confirm('Reset the app? This drops the local database, recreates it, and reloads the app.');
  if (!confirmed) return;

  try {
    await resetDatabase();
    analyticsDataCache = null;
    analyticsLastFiltersKey = null;
    analyticsCharts = { best: null, avg: null, track: null };
    destroyAnalyticsCharts();
    await dbInit();
    toast('App reset complete. Reloading...');
    setTimeout(() => window.location.reload(), 400);
  } catch (error) {
    console.error('❌ Failed to reset app:', error);
    toast('Failed to reset app. See console.');
  }
}

// Handle PWA Install
function handleInstallClick() {
  if (!state.installPrompt) return;
  
  // Show the install prompt
  state.installPrompt.prompt();
  
  // Wait for the user to respond
  state.installPrompt.userChoice.then((choiceResult) => {
    if (choiceResult.outcome === 'accepted') {
      toast('App installed successfully!');
    } else {
      toast('App installation dismissed');
    }
    // Clear the saved prompt since it can't be used again
    state.installPrompt = null;
    // Re-render settings to hide the button
    if (state.currentRoute === '/settings') {
      renderSettingsPage();
    }
  });
}

// Bootstrap application
async function bootstrap() {
  console.log('🚀 Bootstrapping RC Report App...');
  
  // Initialize database
  try {
    await dbInit();
    console.log('✅ Database initialized');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    toast('Database initialization failed');
  }
  
  // Register service worker
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js');
      console.log('✅ Service Worker registered:', registration.scope);
      
      // Show toast when service worker is installed and ready
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'activated') {
            toast('✅ Offline ready');
          }
        });
      });
      
      // If already active, show ready message
      if (registration.active) {
        toast('✅ Offline ready');
      }
    } catch (error) {
      console.error('❌ Service Worker registration failed:', error);
    }
  }
  
  // Set up router with debouncing
  window.addEventListener('hashchange', debouncedRouter);
  
  // Capture the install prompt event
  window.addEventListener('beforeinstallprompt', (event) => {
    // Prevent the mini-infobar from appearing
    event.preventDefault();
    // Save the event so it can be triggered later
    state.installPrompt = event;
    console.log('💾 Install prompt captured');
    // Update settings page if currently viewing it
    if (state.currentRoute === '/settings') {
      renderSettingsPage();
    }
  });
  
  // Log when app is installed
  window.addEventListener('appinstalled', () => {
    console.log('✅ PWA installed');
    state.installPrompt = null;
  });
  
  // Initial route
  router();
  
  console.log('✅ App ready!');
}

// Start the app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

// Export state and helpers for use in other modules
export { state, toast };
