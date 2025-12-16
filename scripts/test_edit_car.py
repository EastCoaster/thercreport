#!/usr/bin/env python3
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

from playwright.sync_api import sync_playwright

URL = 'http://localhost:8000'
CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

print("Starting Edit Car button test...")

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME_PATH, headless=True)
    page = p.chromium.launch(headless=True).new_context().new_page()
    
    # Disable console messages to avoid encoding issues
    page.goto(URL)
    page.wait_for_timeout(1000)
    
    try:
        # Go to garage
        print("1. Navigating to garage...")
        page.goto(URL + '/#/garage')
        page.wait_for_timeout(800)
        
        # Add a car
        print("2. Adding a test car...")
        page.wait_for_selector('#addCarBtn', timeout=3000)
        page.click('#addCarBtn')
        page.wait_for_timeout(400)
        page.fill('#carName', 'EditCarTest')
        page.click('#carFormElement button[type=submit]')
        page.wait_for_timeout(800)
        
        # View the car details
        print("3. Viewing car details...")
        page.wait_for_selector('.car-item', timeout=3000)
        page.click('.car-item')
        page.wait_for_timeout(800)
        
        # Click Edit Car button
        print("4. Clicking Edit Car button...")
        page.wait_for_selector('#editCarBtn', timeout=3000)
        page.click('#editCarBtn')
        page.wait_for_timeout(1500)
        
        # Check if form is visible
        print("5. Checking if form is visible...")
        is_visible = page.is_visible('#carForm')
        if is_visible:
            print("SUCCESS: Edit Car form is now visible!")
        else:
            print("FAILURE: Edit Car form is NOT visible")
            # Try to see what's on the page
            current_url = page.url
            print(f"Current URL: {current_url}")
            has_form = page.query_selector('#carForm') is not None
            print(f"Form element exists: {has_form}")
            
    except Exception as e:
        print(f"ERROR: {e}")
    finally:
        browser.close()

print("Test complete")
