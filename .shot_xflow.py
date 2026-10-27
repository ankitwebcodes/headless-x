import asyncio, pathlib
from playwright.async_api import async_playwright

TOK = pathlib.Path(".tok.tmp").read_text().strip()

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 390, "height": 844},
                                  device_scale_factor=2)
        await ctx.add_cookies([{"name": "xp_session", "value": TOK,
                                "domain": "repostops.xyz", "path": "/"}])
        pg = await ctx.new_page()
        await pg.goto("https://repostops.xyz/xflow", wait_until="networkidle", timeout=60000)
        await pg.wait_for_timeout(2500)
        print("title:", await pg.title())
        print("has report table:", await pg.locator("text=Report").count())
        await pg.screenshot(path="logs_xflow_phone.png", full_page=True)
        await b.close()

asyncio.run(main())
