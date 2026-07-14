import os
import time
from playwright.sync_api import sync_playwright

# Create output folder
SAVE_DIR = "./images/midj"
os.makedirs(SAVE_DIR, exist_ok=True)

"""
This script only scraps grabs (scrape) the images that loads when you you navigate to `https://www.midjourney.com/explore?tab=top` (without login)
"""


def run():
    with sync_playwright() as p:
        # Launch browser (headed=True lets you watch it happen)
        browser = p.chromium.launch(headless=False)
        page = browser.new_page()

        # Listen to all background network responses
        def handle_response(response):
            # Check if the network request is one of the .webp thumbnail images
            if ".webp" in response.url and response.status == 200:
                try:
                    # Create a unique filename based on the URL signature
                    filename = response.url.split("/")[-1].split("?")[0]
                    # Sometimes names collide, so using timestamps or unique counters is safer:
                    unique_name = f"{int(time.time_ns())}_{filename}"
                    
                    filepath = os.path.join(SAVE_DIR, unique_name)
                    
                    # Save the raw image bytes directly to your drive
                    with open(filepath, "wb") as f:
                        f.write(response.body())
                except Exception:
                    pass # Skip if image fails to unpack

        # Bind the network listener to the page instance
        page.on("response", handle_response)

        # Navigate to the target page
        page.goto("https://www.midjourney.com/explore?tab=top")
        page.wait_for_timeout(5000) # Wait 5 seconds for initial load

        print("Scraper active! Auto-scrolling down to collect images...")
        
        # Infinite scroll loop: scrolls down, waits for new images to fetch, repeats
        for _ in range(100): # Adjust range to scroll more or less
            page.evaluate("window.scrollTo(0, document.body.scrollHeight);")
            page.wait_for_timeout(1500) # Give the CDN 1.5 seconds to load the next block

        browser.close()
        print("Scraping sequence complete!")

if __name__ == "__main__":
    run()