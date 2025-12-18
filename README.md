# 🏁 RC Report App

A powerful, mobile-first Progressive Web App (PWA) for tracking RC car racing events, performance analytics, and garage management. Built with vanilla JavaScript, IndexedDB, and service workers for offline-first capabilities.

---

## ✨ Features

### 🏎️ Garage Management
- **Add & Edit Cars** – Create detailed car profiles with photos (capture or upload)
- **Car Statistics** – Track performance metrics, best laps, race history
- **Setup Library** – Manage multiple setups per car (Chassis, Suspension, Drivetrain, Tires, Electronics, General)
- **Photo Management** – Upload or capture photos with automatic resizing (320px width, 0.75 JPEG quality)
- **Transponder Tracking** – Store and display transponder IDs for race registration
- **Safe Deletion** – Slide-to-delete gesture with confirmation dialog (70% drag threshold)

### 📅 Event Management
- **Event Creation** – Add events linked to tracks with date, time, and notes
- **Car Selection** – Button-based car picker (mobile-friendly, shows transponder IDs)
- **Track Integration** – Auto-populated track website and LiveRC URLs
- **Event Analytics** – View events by status (past, upcoming) with track info
- **Edit & Delete** – Full lifecycle management with safe deletion workflows

### 📍 Track Management
- **Track Database** – Create and manage race track profiles
- **Website URLs** – Link to official track websites and LiveRC event pages
- **Surface Info** – Track type (Astroturf, Carpet, Clay, Dirt, etc.)
- **Address Storage** – Full location details for navigation and reference
- **Smart Links** – Clickable website links on track cards and event details

### 📊 Analytics Dashboard
- **Run Statistics** – Aggregate data across events and cars
- **Best Lap Tracking** – See your fastest lap times and averages
- **Performance Trends** – Track consistency and improvement over time
- **Event History** – View all past races with positions and lap counts
- **Car Comparison** – Side-by-side performance metrics

### 🛠️ Tools
- **Gear Ratio Calculator** – Compute drivetrain ratios for performance tuning
- **Battery Calculator** – Estimate run times and discharge rates
- **Lap Time Calculator** – Convert between different time formats
- **Performance Estimator** – Project outcomes based on historical data

### ⚙️ Settings & Data
- **Sample Data Loader** – Populate the app with demo data for testing
- **Data Export** – Export event logs and analytics as CSV/JSON
- **Local Storage** – All data persists locally via IndexedDB (no cloud sync)
- **Offline Support** – Full app functionality without internet

### 🎨 User Experience
- **Mobile-First UI** – Responsive design optimized for phones and tablets
- **Dark Mode Support** – Native dark theme via CSS variables
- **Form Validation** – Auto-scroll to first empty required field with visual feedback
- **Toast Notifications** – Non-intrusive user feedback for actions
- **Smooth Animations** – Gesture feedback and slide-to-delete interactions
- **Touch Gestures** – Desktop + mobile event handling for all interactions
- **Progressive Enhancement** – Works offline, caches assets, installable as app

---

## 🚀 Getting Started

### Prerequisites
- Modern web browser (Chrome, Firefox, Safari, Edge)
- No backend or account required – 100% local-first

### Installation

1. **Clone or download** the repository
   ```bash
   git clone <repo-url>
   cd thercreport
   ```

2. **Start a local web server**
   ```bash
   # Using Python 3
   python -m http.server 8000
   
   # Or Node.js
   npx http-server
   ```

3. **Open in browser**
   ```
   http://localhost:8000
   ```

4. **Install as PWA** (optional)
   - Click the install button in your browser's address bar, or
   - Use the menu → "Install RC Report App"

---

## 📱 Usage Guide

### Adding a Car
1. Navigate to **Garage** → Click **+ Add Car**
2. Fill in **Car Name** (required) and optional details
3. Click **📷 Take Photo** (mobile) or **🖼️ Upload Photo** (desktop + mobile)
4. Click **Save** – validation will scroll to any empty required fields

### Creating an Event
1. Go to **Events** → Click **+ Add Event**
2. Fill in **Title** (required), select **Track** (required), set **Date** (required)
3. Tap car buttons to select which cars are racing
4. Click **Save Event**

### Viewing Race Analytics
1. Navigate to **Analytics**
2. Explore aggregate stats: total races, best laps, run counts
3. Filter by car or track (when implemented)
4. Export data via **Settings** → **Export**

### Editing a Car/Event/Track
1. Click **✏️ Edit** on any card
2. Modify fields as needed
3. To delete: Scroll to bottom and **Slide the red thumb** to the right (70% threshold)
4. Confirm deletion in the dialog

---

## 🛠️ Developer Guide

### Project Structure
```
thercreport/
├── index.html           # Single-page app shell
├── app.js               # Main SPA logic, all pages & features (~6000 lines)
├── db.js                # IndexedDB schema & CRUD operations
├── styles.css           # UI theme, flexbox layouts, dark mode
├── manifest.json        # PWA metadata
├── sw.js                # Service worker for offline & caching
├── scripts/
│   └── py_smoketest.py  # Automated browser testing (Playwright)
└── README.md            # This file
```

### Architecture Highlights

#### **Database (db.js)**
- IndexedDB with v1.1 schema (upgrades from v1)
- Object stores: `cars`, `tracks`, `events`, `setups`, `runLogs`
- Indexes on `carId`, `trackId`, `eventId` for fast queries
- All async operations via Promises

#### **App Logic (app.js)**
- **Single-Page Router** – Hash-based routing (#/garage, #/events, etc.)
- **Form Validation** – `validateFormFields()` helper scrolls to first empty required field
- **Image Processing** – `resizeImage()` utility (canvas-based JPEG compression)
- **Analytics Engine** – `aggregateRuns()` computes KPIs from run logs
- **Gesture Handling** – Slide-to-delete using mouse/touch dual-mode listeners

#### **Key Functions**
| Function | Purpose |
|----------|---------|
| `renderGaragePage()` | Render car list, forms, edit mode |
| `renderEventsPage()` | Render event list with car picker buttons |
| `renderTracksPage()` | Render track list with website links |
| `renderAnalyticsPage()` | Aggregate & display performance KPIs |
| `validateFormFields()` | Check required fields, scroll to first empty |
| `resizeImage()` | Resize photos to 320px, compress JPEG |
| `loadAnalyticsData()` | Load and enrich event/run data |
| `aggregateRuns()` | Compute statistics from run logs |

### State Management
- **Global Variables:**
  - `currentCarImage` – Stores resized car photo data URL
  - `window.pendingEditCarId` – Flag for navigation-based edit flows
  - `localStorage` – Persists UI preferences
- **Form State:** Cleared on cancel/hide, populated on edit
- **Database State:** All data lives in IndexedDB, synced after saves

### Form Validation Flow
```
User clicks Save
    ↓
validateFormFields(formId, requiredFields)
    ↓
Find first empty field
    ↓
YES → Scroll + Focus + Red outline + Toast → Block submit
    ↓
NO → Proceed with save → DB operation → Success toast
```

### Slide-to-Delete Implementation
```
User presses down on delete thumb
    ↓
Track mouse/touch move events
    ↓
Calculate distance = currentX - startX
    ↓
If distance ≥ 70% of container width:
    ↓
Show confirmation → Delete or reset
    ↓
If distance < 70%:
    ↓
Reset slide position
```

---

## 🧪 Testing

### Automated Smoke Test
A Python/Playwright test suite (`scripts/py_smoketest.py`) validates core flows:

```bash
cd thercreport
python scripts/py_smoketest.py
```

**Test Coverage:**
- ✅ App initialization & DB schema upgrade
- ✅ Navigation across all pages (Garage, Events, Tracks, Analytics, Tools, Settings)
- ✅ Add car flow with form submission
- ✅ Add track flow
- ✅ Add event flow
- ✅ Edit car button navigation
- ✅ Sample data loading
- ✅ Analytics aggregation

**Output:** Screenshots saved to `scripts/screenshots/` and exit code 0 on success.

**Requirements:**
```bash
pip install playwright
playwright install chromium
```

### Manual Testing Checklist
- [ ] Add car without name → Validate scrolls to name field
- [ ] Upload car photo (desktop) → Verify resize & preview
- [ ] Capture car photo (mobile) → Verify capture dialog
- [ ] Edit car → Verify slide-to-delete appears at bottom
- [ ] Drag delete thumb 70%+ → Confirm deletion
- [ ] Create event with car selection → Verify button-based UI
- [ ] View event detail → Check track links (website, LiveRC)
- [ ] Analytics page → Check KPI calculations
- [ ] Offline mode → Close internet, verify app still works

---

## 🌐 Browser Compatibility
- **Chrome/Edge:** ✅ Full support
- **Firefox:** ✅ Full support
- **Safari:** ✅ Full support (iOS 12+)
- **Mobile Browsers:** ✅ Full support

---

## 📦 Data Schema

### Cars
```javascript
{
  id: "car_xxx",
  name: "TLR 22 5.0",          // Required
  class: "2WD Buggy",
  chassis: "TLR 22 5.0",
  motor: "Reedy 17.5T",
  esc: "Reedy SC1000",
  transponder: "1234567",      // For race registration
  notes: "...",
  image: "data:image/jpeg...", // Resized to 320px
  createdAt: "2025-12-17T...",
  updatedAt: "2025-12-17T..."
}
```

### Events
```javascript
{
  id: "event_xxx",
  title: "Club Race",           // Required
  trackId: "track_xxx",         // Required
  date: "2025-12-20",           // Required
  startTime: "18:00",
  carIds: ["car_1", "car_2"],   // Selected cars
  trackWebsite: "https://...",  // From track
  liveRcEventUrl: "https://...",
  notes: "...",
  createdAt: "...",
  updatedAt: "..."
}
```

### Tracks
```javascript
{
  id: "track_xxx",
  name: "Local RC Park",        // Required
  address: "123 Main St",
  websiteUrl: "https://...",
  surface: "Astroturf",
  liveRcUrl: "https://liverchobby.tv/...",
  notes: "...",
  createdAt: "...",
  updatedAt: "..."
}
```

---

## 🎯 Roadmap

### Planned Features
- 📡 **Cloud Sync** – Optional Firebase/Supabase integration
- 🎬 **Video Support** – Embed race video clips
- 📊 **Advanced Charts** – Lap time trends, position heatmaps
- 🏆 **Leaderboards** – Per-track, per-car rankings
- 🔔 **Push Notifications** – Remind upcoming events
- 🌍 **Multi-Language** – i18n support (ES, FR, DE, JP)
- 🎨 **Theme Customization** – User-defined color schemes
- ⚡ **Service Worker** – Better offline UX, background sync

---

## 🐛 Known Issues & Limitations
- **No cloud backup** – Data only persists locally (use export to backup)
- **No real-time sync** – No collaboration features yet
- **No file import** – Manual data entry only (CSV import coming soon)
- **Safari quirks** – Some PWA features limited on iOS

---

## 🤝 Contributing

Want to improve RC Report? Pull requests welcome!

### Quick Start for Developers
1. Fork the repo
2. Make changes in `app.js`, `db.js`, or `styles.css`
3. Test locally: `python -m http.server 8000`
4. Run smoke test: `python scripts/py_smoketest.py`
5. Submit a PR with a description of your changes

### Code Guidelines
- Vanilla JS (no frameworks)
- Arrow functions for callbacks, `async/await` for promises
- Comments for complex logic
- IndexedDB queries use wrapper functions (`get`, `put`, `remove`, `query`)

---

## 📄 License
MIT License – Use freely for personal or commercial projects.

---

## 💡 Tips & Tricks

### Performance
- **Offline First** – App works without internet; data syncs when available
- **Image Optimization** – Photos auto-resize to 320px for storage efficiency
- **Lazy Loading** – Pages render only when navigated to

### Best Practices
1. **Regular Backups** – Export data monthly via Settings
2. **Sample Data** – Load sample data to explore features before racing
3. **Mobile Installation** – Add to home screen for quick access
4. **Browser Storage** – Clear cache/storage if you encounter bugs

---

## 🆘 Support

### Troubleshooting
| Issue | Solution |
|-------|----------|
| App won't load | Clear browser cache & reload |
| Data disappeared | Check IndexedDB (DevTools → Application) |
| Photos won't save | Check disk space & browser storage quota |
| Offline mode not working | Service worker may not be registered; reload page |
| Slide-to-delete not responsive | Use faster, more deliberate swipe motion |

### Debug Mode
Open browser DevTools (F12) and check:
- **Console** for errors
- **Application → IndexedDB** to inspect database
- **Network** to monitor requests
- **Application → Service Workers** for PWA status

---

## 📞 Contact & Feedback
Found a bug? Have a feature idea? Create an issue on GitHub or reach out directly!

---

**Built with ❤️ for RC Racing Enthusiasts**

*Last updated: December 17, 2025*
