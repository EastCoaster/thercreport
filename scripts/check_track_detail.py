from playwright.sync_api import sync_playwright
import sys

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

    # Navigate to root so helper functions are available
    page.goto(URL)
    page.wait_for_timeout(800)

    # Use settings UI to load sample data (handles non-global helper + confirm dialog)
    try:
        page.goto(f"{URL}/#/settings")
        page.wait_for_selector('#loadSampleDataBtn', timeout=3000)
        page.on('dialog', lambda dialog: dialog.accept())
        page.click('#loadSampleDataBtn')
        page.wait_for_timeout(1200)
        print('Clicked loadSampleDataBtn')
    except Exception as e:
        print('Could not trigger loadSampleDataBtn:', e)

    page.goto(f"{URL}/#/track/{TRACK_ID}")
        page.wait_for_timeout(1200)

        # Debug: inspect raw DB counts for events and runLogs tied to this track
        try:
                js = '''() => new Promise((resolve) => {
                        const req = indexedDB.open('rc_program');
                        req.onsuccess = (ev) => {
                            const db = ev.target.result;
                            try {
                                const tx = db.transaction(['events','runLogs'], 'readonly');
                                const eventsStore = tx.objectStore('events');
                                const runsStore = tx.objectStore('runLogs');
                                const getAll = (store) => new Promise(res => { const r = store.getAll(); r.onsuccess = () => res(r.result); });
                                Promise.all([getAll(eventsStore), getAll(runsStore)]).then(([events, runs]) => {
                                    const matchedRuns = runs.filter(r => { const ev = events.find(e => e.id === r.eventId); return ev && ev.trackId === '__TRACK_ID__'; });
                                    resolve({ events: events.length, runs: runs.length, matchedRuns: matchedRuns.length });
                                }).catch(err => resolve({error: String(err)}));
                            } catch (err) { resolve({error: String(err)}) }
                        };
                        req.onerror = () => resolve({error: 'db-open-failed'});
                    })'''
                js = js.replace('__TRACK_ID__', TRACK_ID)
                db_info = page.evaluate(js)
                print('DB info:', db_info)
        except Exception as e:
                print('DB inspect failed:', e)
    # capture KPI values
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
    print('KPIs -> Best:', best, 'Avg:', avg, '#Runs:', runs, '#Events:', events)

    # Debug: print app inner HTML snippet
    try:
        app_html = page.eval_on_selector('#app', 'el => el.innerHTML')
        print('APP HTML snippet:', app_html[:400])
    except Exception as e:
        print('Failed to read #app innerHTML:', e)

    # snapshot
    path = f'scripts/screenshots/track_direct_{TRACK_ID}.png'
    page.screenshot(path=path, full_page=True)
    print('SNAPSHOT:', path)

    browser.close()

print('Done')