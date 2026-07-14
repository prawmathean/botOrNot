import os
import json
import re
import requests
import time

"""
This script scrapes the images from a subreddits json api
"""

HEADERS = {
    "User-Agent": "botOrNot-scraper/0.1 by u/theOneWhoIsStuck"
}


def fetch_json(subreddit ,  after=None, limit=100, sort="top", t="month"):
    url=f"https://reddit.com/r/{subreddit}/{sort}.json"
    params = {
        "limit" : limit,
        "t" : t
    }

    if after:
        params["after"] = after

    resp = requests.get(url , headers=HEADERS , params=params)
    resp.raise_for_status()
    return resp.json()

def scrape_posts(subreddit , max_posts=500 ):
    posts = []
    after = None
    while len(posts) < max_posts:

        data = fetch_json(subreddit , after=after)
        children = data["data"]["children"]

        if not children:
            break

        posts.extend(children)

        after = data["data"]["after"]

        if after is None:
            break

        time.sleep(1)   # to avoid rate limit

    return posts

def extract_img_urls(posts):
    urls = []

    for post in posts:
        data = post["data"]
        if data.get("post_hint") == "image":  # use `and not d.get(ove)` to skip nsfw images :)
            urls.append( {
                "id" : data["id"],
                "url" : data["url"],
                "title" : data["title"]
            })

    return urls

def download_img( img_list , op_dir):
    os.makedirs(op_dir , exist_ok=True)

    for img in img_list:
        ext = img["url"].split(".")[-1].split("?")[0]   # get the last parameter from the url (i.e. , the extension)

        if ext not in ("jpg" , "jpeg" , "png" , "webp"):
            continue        # if the url isn't a image , skip

        file_path = os.path.join( op_dir , f"{img['id']}.{ext}" )    # filepath

        r = requests.get(img["url"] , headers=HEADERS)

        if r.status_code == 200:
            with open(file_path , "wb") as img_file:
                img_file.write(r.content)

        time.sleep(0.25)

# ___ function calls ____

posts = scrape_posts(subreddit="blursedimages" , max_posts=50)
imgs = extract_img_urls(posts)
download_img(img_list=imgs , op_dir="images/reddit_blursed_images")