from playwright.sync_api import sync_playwright

URL = 'http://localhost:8000'
TRACK_ID = 'track_326ac525-6c54-4372-b393-1b636df427b8'
CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

with sync_playwright() as p:
    try:
        browser = p.chromium.launch(executable_path=CHROME_PATH, headless=True)
    except Exception:
        browser = p.chromium.launch(headless=True)

    context = browser.new_context()
    page = context.new_page()

    def _on_console(msg):
        try:
            print('PAGE LOG:', msg.text())
        except Exception:
            print('PAGE LOG:', msg)
    
    page.on('console', _on_console)
    page.on('pageerror', lambda err: print('PAGE ERROR:', err))

    page.goto(URL)
    page.wait_for_timeout(800)

    # Load sample data
    try:
        page.goto(f"{URL}/#/settings")
        page.wait_for_selector('#loadSampleDataBtn', timeout=3000)
        page.on('dialog', lambda dialog: dialog.accept())
        page.click('#loadSampleDataBtn')
        page.wait_for_timeout(1200)
        print('✓ Loaded sample data')
    except Exception as e:
        print('✗ Could not load sample data:', e)

    # Open track detail
    page.goto(f"{URL}/#/track/{TRACK_ID}")
    page.wait_for_timeout(1500)  # Increased wait time
    
    # Check trendSeries from console
    try:
        trend_info = page.evaluate("""() => {
            // Access the last analytics result from console logs
            return {
                trendSeriesExists: window.__lastTrendSeries !== undefined,
                message: 'Checking trend series...'
            };
        }""")
        print(f'Trend Series: {trend_info}')
    except Exception as e:
        print(f'Could not check trend series:', e)

    # Get KPI values
    def get_text(selector):
        try:
            el = page.query_selector(selector)
            return el.inner_text().strip() if el else None
        except Exception:
            return None

    best = get_text('#trackBestLapKpi')
    avg = get_text('#trackAvgLapKpi')
    runs = get_text('#trackRunCountKpi')
    events = get_text('#trackEventCountKpi')
    print(f'KPIs: Best={best}, Avg={avg}, Runs={runs}, Events={events}')
    
    # Check if charts are rendered
    def chart_has_data(selector):
        try:
            canvas = page.query_selector(selector)
            if not canvas:
                return False
            # Check if canvas has pixel data (non-empty)
            result = page.evaluate(f"""() => {{
                const canvas = document.querySelector('{selector}');
                if (!canvas) return false;
                const ctx = canvas.getContext('2d');
                const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                // If canvas has any non-transparent pixels, it has data
                return Array.from(data).some(val => val > 0);
            }}""")
            return result
        except Exception as e:
            print(f'Chart check error for {selector}:', e)
            return False
    
    best_chart_rendered = chart_has_data('#trackDetailBestChart')
    avg_chart_rendered = chart_has_data('#trackDetailAvgChart')
    car_chart_rendered = chart_has_data('#trackDetailCarUsageChart')
    print(f'Charts: Best={best_chart_rendered}, Avg={avg_chart_rendered}, CarUsage={car_chart_rendered}')
    
    # Check if table has data
    table_html = page.query_selector('#trackTopCarsTable')
    table_has_rows = table_html and '<tr style' in page.evaluate('() => document.querySelector("#trackTopCarsTable").innerHTML') if table_html else False
    print(f'Table: has_rows={table_has_rows}')

    # Inspect DB
    try:
        js_code = """() => new Promise((resolve) => {
            const req = indexedDB.open('rc_program');
            req.onsuccess = (ev) => {
              const db = ev.target.result;
              const tx = db.transaction(['events','runLogs'], 'readonly');
              const eventsStore = tx.objectStore('events');
              const runsStore = tx.objectStore('runLogs');
              const getAll = (store) => new Promise(res => { 
                const r = store.getAll(); 
                r.onsuccess = () => res(r.result); 
              });
              Promise.all([getAll(eventsStore), getAll(runsStore)]).then(([events, runs]) => {
                const trackId = '""" + TRACK_ID + """';
                const matchedRuns = runs.filter(r => { 
                  const ev = events.find(e => e.id === r.eventId); 
                  return ev && ev.trackId === trackId; 
                });
                resolve({ events: events.length, runs: runs.length, matchedRuns: matchedRuns.length });
              });
            };
            req.onerror = () => resolve({error: 'db-open-failed'});
        })"""
        db_info = page.evaluate(js_code)
        print(f'DB: events={db_info["events"]}, runs={db_info["runs"]}, matchedRuns={db_info["matchedRuns"]}')
    except Exception as e:
        print('✗ DB inspect failed:', e)

    # Snapshot
    path = f'scripts/screenshots/debug_track_{TRACK_ID}.png'
    page.screenshot(path=path, full_page=True)
    print('✓ Snapshot:', path)

    browser.close()

print('Done')
