from playwright.sync_api import sync_playwright
import sys

URL = 'http://localhost:8000'
CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

with sync_playwright() as p:
    browser = None
    try:
        # Try launching Chromium via Playwright using system Chrome executable
        browser = p.chromium.launch(executable_path=CHROME_PATH, headless=True)
    except Exception as e:
        print('Failed to launch system Chrome via Playwright:', e, file=sys.stderr)
        try:
            print('Attempting default launch...', file=sys.stderr)
            browser = p.chromium.launch(headless=True)
        except Exception as e2:
            print('Default Playwright launch failed:', e2, file=sys.stderr)
            sys.exit(2)

    context = browser.new_context()
    page = context.new_page()

    def _on_console(msg):
        try:
            text = msg.text()
        except TypeError:
            # Some Playwright versions expose text as a property
            text = getattr(msg, 'text', str(msg))
        print('PAGE LOG:', text)
    page.on('console', _on_console)
    page.on('pageerror', lambda err: print('PAGE ERROR:', err))

    print('Navigating to', URL)
    page.goto(URL)
    page.wait_for_timeout(800)

    screenshots = []

    def snap(name):
        path = f'scripts/screenshots/{name}.png'
        page.screenshot(path=path, full_page=True)
        screenshots.append(path)
        print('SNAPSHOT:', path)

    # Pages to visit and basic interactions
    routes = [
        ('garage', '/#/garage'),
        ('events', '/#/events'),
        ('tracks', '/#/tracks'),
        ('analytics', '/#/analytics'),
        ('tools', '/#/tools'),
        ('settings', '/#/settings'),
    ]

    # Ensure screenshots dir exists (in-page mkdir fallback)
    import os
    os.makedirs('scripts/screenshots', exist_ok=True)

    # Visit each route and capture a screenshot
    for name, hashPath in routes:
        print('Visiting', hashPath)
        page.goto(URL + hashPath)
        page.wait_for_timeout(1200)
        snap(name)

    # Garage: open Add Car form then cancel
    try:
        page.goto(URL + '/#/garage')
        page.wait_for_selector('#addCarBtn', timeout=2000)
        page.click('#addCarBtn')
        page.wait_for_timeout(400)
        snap('garage_add_car')
        page.click('#cancelBtn')
        page.wait_for_timeout(300)
    except Exception as e:
        print('Garage add flow failed:', e)

    # Tracks: add a simple track
    try:
        page.goto(URL + '/#/tracks')
        page.wait_for_selector('#addTrackBtn', timeout=2000)
        page.click('#addTrackBtn')
        page.fill('#trackName', 'SmokeTest Track')
        page.fill('#trackAddress', '123 Test Rd')
        page.click('#trackFormElement button[type=submit]')
        page.wait_for_timeout(600)
        snap('tracks_after_add')
    except Exception as e:
        print('Tracks add flow failed:', e)

    # Events: add a simple event (select the first track)
    try:
        page.goto(URL + '/#/events')
        page.wait_for_selector('#addEventBtn', timeout=2000)
        page.click('#addEventBtn')
        page.wait_for_selector('#eventTitle')
        page.fill('#eventTitle', 'SmokeTest Event')
        # choose a track if available
        if page.query_selector('#eventTrackId option:nth-child(2)'):
            # select second option (first is placeholder)
            val = page.eval_on_selector('#eventTrackId option:nth-child(2)', 'el => el.value')
            page.select_option('#eventTrackId', val)
        # set date to today
        import datetime
        today = datetime.date.today().isoformat()
        page.fill('#eventDate', today)
        page.click('#eventFormElement button[type=submit]')
        page.wait_for_timeout(600)
        snap('events_after_add')
    except Exception as e:
        print('Events add flow failed:', e)

    # Settings: click Load Sample Data if present
    try:
        page.goto(URL + '/#/settings')
        page.wait_for_timeout(500)
        if page.query_selector('#loadSampleDataBtn'):
            page.click('#loadSampleDataBtn')
            page.wait_for_timeout(1200)
            snap('settings_after_load_sample')
    except Exception as e:
        print('Settings sample data flow failed:', e)

    # Analytics: wait for charts to render
    try:
        page.goto(URL + '/#/analytics')
        page.wait_for_timeout(1200)
        snap('analytics')
    except Exception as e:
        print('Analytics visit failed:', e)

    # Tools: check calculators present
    try:
        page.goto(URL + '/#/tools')
        page.wait_for_timeout(800)
        snap('tools')
    except Exception as e:
        print('Tools visit failed:', e)

    print('Captured screenshots:', screenshots)

    browser.close()

print('Smoke test complete')
