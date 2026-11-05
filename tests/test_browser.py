"""Browser checks with Playwright against a real server. Optional: needs `pip install playwright` and `playwright install firefox`.

Run: python3 -m unittest tests/test_browser.py   (set SPEND_TRACKER_SCREENSHOTS=/some/dir to keep screenshots)
"""

import os
import re
import unittest
from pathlib import Path

from server import PASSWORD, Server, build

try:
    from playwright.sync_api import expect, sync_playwright
except ImportError:  # Playwright is a development-only tool.
    sync_playwright = None

TABS = ["Transactions", "Calendar", "Stats", "People", "Events", "History", "Manage"]


@unittest.skipIf(sync_playwright is None, "Playwright is not installed")
class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        build()
        cls.server = Server()
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.firefox.launch()
        cls.screenshots = Path(os.environ["SPEND_TRACKER_SCREENSHOTS"]) if os.environ.get("SPEND_TRACKER_SCREENSHOTS") else None

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.stop()

    def new_page(self, **options):
        context = self.browser.new_context(**options)
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        self.addCleanup(lambda: self.assertEqual(errors, [], "browser errors"))
        return page

    def shot(self, page, name):
        if self.screenshots:
            self.screenshots.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(self.screenshots / f"{name}.png"), full_page=False)

    def log_in(self, page):
        page.goto(self.server.url + "/")
        if not (self.server.data_dir / "auth.json").exists():
            expect(page.locator("#setupTokenGroup")).to_be_visible()
            page.fill("#setupToken", self.server.token)
            page.fill("#password", PASSWORD)
            page.fill("#confirmPassword", PASSWORD)
            page.click("#loginButton")
        else:
            page.fill("#password", PASSWORD)
            page.click("#loginButton")
        expect(page.locator("#statusLeft")).to_have_text("Ready")

    def pick(self, page, host, label):
        page.click(f"{host} .retro-select")
        page.locator(f"{host} .menu-dropdown button", has_text=label).first.click()

    KIND_LABELS = {"Purchase": "Purchase", "Refund": "Refund / return", "Payback": "Payback to me"}

    def set_checks(self, page, host, names):
        """Makes exactly these items checked in a multi-select dropdown, then closes it."""
        page.click(f"{host} .retro-select")
        for item in page.locator(f"{host} .menu-dropdown button").all():
            wanted = item.inner_text().strip() in names
            if (item.get_attribute("aria-checked") == "true") != wanted:
                item.click()
        page.keyboard.press("Escape")

    def add_transaction(self, page, kind="Purchase", amount=None, merchant=None, description=None, people=None, person=None, linked=None):
        """Fills only the given fields, so values the editor copies from a linked purchase are kept."""
        page.click("#newTransactionButton")
        self.pick(page, "#txKind", self.KIND_LABELS[kind])
        if people:
            self.set_checks(page, "#txPeople", people)
        if person:
            self.pick(page, "#txPerson", person)
        if linked:
            self.pick(page, "#txLinked", linked)
        for selector, value in (("#txAmount", amount), ("#txMerchant", merchant), ("#txDescription", description)):
            if value is not None:
                page.fill(selector, value)
        page.click("#txSaveButton")
        expect(page.locator("#txError")).to_have_text("")
        expect(page.locator("#transactionDialog")).not_to_be_visible()

    def test_full_workflow_in_both_themes_and_phone_width(self):
        page = self.new_page(viewport={"width": 1280, "height": 900})
        self.log_in(page)

        # Manage: add a person and a tag.
        page.click('.tabs [data-tab="manage"]')
        page.fill('form[data-add="people"] input', "Alex")
        page.click('form[data-add="people"] button')
        expect(page.locator("#peopleManageTable")).to_contain_text("Alex")
        page.fill('form[data-add="tags"] input', "food")
        page.click('form[data-add="tags"] button')
        expect(page.locator("#tagsTable")).to_contain_text("food")

        # Transactions: purchase for me (with a tag), purchase for Alex, refund, payback.
        page.click('.tabs [data-tab="transactions"]')
        page.click("#newTransactionButton")
        page.fill("#txAmount", "12.17")
        page.fill("#txMerchant", "BK")
        page.fill("#txDescription", "food")
        expect(page.locator("#txNewTag")).to_have_count(0)  # tags are only created under Manage
        self.set_checks(page, "#txTags", ["food"])
        expect(page.locator("#txTags .retro-select")).to_have_text("food▼")
        page.click("#txSaveButton")
        expect(page.locator("#transactionsTable")).to_contain_text("BK — food")

        self.add_transaction(page, amount="$40", merchant="Diner", description="dinner", people=["Alex"])
        self.add_transaction(page, kind="Refund", linked="Diner")
        page.locator("#transactionsTable tbody tr", has_text="Refund:").first.wait_for()
        self.add_transaction(page, kind="Payback", amount="10", description="Venmo", person="Alex")
        expect(page.locator("#monthCards")).to_contain_text("$12.17")  # net: 12.17 + 40 - 40 refund
        expect(page.locator("#transactionsTable tfoot")).to_contain_text("$12.17")

        # Invalid input shows the server's message and keeps the dialog open.
        page.click("#newTransactionButton")
        page.fill("#txAmount", "5")
        page.click("#txSaveButton")
        expect(page.locator("#txError")).to_contain_text("merchant or a description")
        page.click("#txCancelButton")

        self.shot(page, "transactions-light")
        for theme in ["light", "dark"]:
            if theme == "dark":
                page.click("#viewMenuButton")
                page.locator("#viewMenu button", has_text="Dark").click()
                expect(page.locator("html")).to_have_attribute("data-theme-effective", "dark")
            for tab in TABS:
                page.click(f'.tabs button:text-is("{tab}")')
                expect(page.locator(f'.tab-panel[data-panel="{tab.lower()}"]')).to_be_visible()
                if tab == "History":
                    expect(page.locator("#historyTable")).to_contain_text("Created")
                self.shot(page, f"{tab.lower()}-{theme}")

        page.click('.tabs [data-tab="stats"]')
        expect(page.locator("#statsTotals")).to_contain_text("$52.17")  # spent
        expect(page.locator("#statsTagsTable")).to_contain_text("Untagged")

        page.click('.tabs [data-tab="people"]')
        expect(page.locator("#peopleTable")).to_contain_text("overpaid")  # refunded in full, then paid $10 back
        page.locator("#peopleTable tbody tr", has_text="Alex").click()
        expect(page.locator("#personDialog")).to_be_visible()
        self.shot(page, "person-dialog-dark")
        page.keyboard.press("Escape")

        page.click('.tabs [data-tab="calendar"]')
        page.locator("#monthCalendar button.calendar-day", has_text="$").first.click()
        expect(page.locator("#dayDialog")).to_be_visible()
        page.keyboard.press("Escape")

        # Phone width: no sideways page scrolling, and the editor fits.
        page.set_viewport_size({"width": 390, "height": 844})
        for tab in TABS:
            page.click(f'.tabs button:text-is("{tab}")')
            overflow = page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
            self.assertLessEqual(overflow, 0, f"{tab} scrolls sideways on a phone")
        page.click("#newTransactionButton")
        box = page.locator("#transactionDialog").bounding_box()
        self.assertLessEqual(box["x"] + box["width"], 390)
        self.shot(page, "editor-phone-dark")
        page.click("#txCancelButton")

        # Download a backup, change the data, then restore it through the UI.
        page.set_viewport_size({"width": 1280, "height": 900})
        page.click('.tabs [data-tab="transactions"]')
        page.click("#fileMenuButton")
        with page.expect_download() as download_info:
            page.click("#backupButton")
        download = download_info.value
        self.assertRegex(download.suggested_filename, r"^spend-tracker-\d{8}-\d{6}\.zip$")
        backup_path = Path(download.path())
        self.add_transaction(page, amount="99", merchant="After backup")
        expect(page.locator("#transactionsTable")).to_contain_text("After backup")
        page.click("#fileMenuButton")
        page.set_input_files("#restoreFileInput", str(backup_path))
        page.click("#confirmOkButton")
        expect(page.locator("#statusLeft")).to_contain_text("Restored 4 transactions")
        expect(page.locator("#transactionsTable")).not_to_contain_text("After backup")
        expect(page.locator("#transactionsTable")).to_contain_text("BK — food")

        # Logging out returns to the login page and protects the app.
        page.click("#fileMenuButton")
        page.click("#logoutButton")
        page.wait_for_url(re.compile(r"/login\.html"))
        page.goto(self.server.url + "/")
        page.wait_for_url(re.compile(r"/login\.html"))

    def test_split_purchase_in_editor(self):
        page = self.new_page(viewport={"width": 1280, "height": 900})
        self.log_in(page)
        page.click("#newTransactionButton")
        page.fill("#txAmount", "30.01")
        page.fill("#txMerchant", "Pizza")
        self.set_checks(page, "#txPeople", ["Me", "Alex"])
        expect(page.locator("#txShares")).to_be_visible()
        page.locator("#txShares button", has_text="Split Evenly").click()
        expect(page.locator("#txShares input").nth(0)).to_have_value("15.01")  # the first person listed gets the leftover cent
        expect(page.locator("#txShares input").nth(1)).to_have_value("15.00")
        expect(page.locator("#txShareTotal")).to_have_text("Assigned $30.01 of $30.01")
        page.locator("#txShares input").nth(1).fill("10.00")
        expect(page.locator("#txShareTotal")).to_contain_text("$5.00 left")
        page.click("#txSaveButton")
        expect(page.locator("#txError")).to_contain_text("add up to $25.01")
        page.locator("#txShares input").nth(0).fill("20.01")
        page.click("#txSaveButton")
        expect(page.locator("#transactionDialog")).not_to_be_visible()
        expect(page.locator("#transactionsTable tbody tr", has_text="Pizza")).to_contain_text("Me, Alex")
        page.click('.tabs [data-tab="people"]')
        page.locator("#peopleTable tbody tr", has_text="Alex").click()
        expect(page.locator("#personTable tbody tr", has_text="Pizza")).to_contain_text("$10.00")
        expect(page.locator("#personTable tbody tr", has_text="Pizza")).to_contain_text("share of $30.01")
        self.shot(page, "split-people")

    def test_stats_for_a_known_month(self):
        page = self.new_page(viewport={"width": 1280, "height": 900})
        self.log_in(page)
        api = self.server.logged_in_client()
        snapshot = api.get("/api/snapshot")
        me = next(p["id"] for p in snapshot["people"] if p["isSelf"])
        cash, card = snapshot["paymentMethods"][0]["id"], snapshot["paymentMethods"][1]["id"]
        friend = api.post("/api/people", {"name": "Jordan"})["id"]
        groceries = api.post("/api/tags", {"name": "groceries"})["id"]

        def add(kind, date, cents, method, person=None, linked=None, merchant="", tags=()):
            shares = [{"personId": person, "amountCents": cents}] if kind == "Purchase" else []
            return api.post("/api/transactions", {
                "kind": kind, "date": date, "amountCents": cents, "paymentMethodId": method, "personId": None if kind == "Purchase" else person,
                "linkedId": linked, "merchant": merchant, "description": "x", "note": "", "tagIds": list(tags), "shares": shares})

        # March 2025 has 31 days. Purchases on the 1st, 10th, and 31st; a refund on the 12th is not spending.
        add("Purchase", "2025-03-01", 1000, cash, me, merchant="Market")
        add("Purchase", "2025-03-01", 500, card, friend, merchant="Cafe")
        big = add("Purchase", "2025-03-10", 2000, card, me, merchant="market", tags=[groceries])
        add("Refund", "2025-03-12", 500, card, me, linked=big["id"], merchant="Returned desk")
        add("Purchase", "2025-03-31", 100, cash, me, merchant="Market")

        page.click("#fileMenuButton")
        page.click("#refreshButton")
        page.click('.tabs [data-tab="stats"]')
        self.pick(page, "#statsPeriodSelect", "March 2025")
        expect(page.locator("#titleScope")).to_have_text("Stats · March 2025")

        totals = page.locator("#statsTotals")
        expect(totals).to_contain_text("Spent$36.00")
        expect(totals).to_contain_text("Refunds$5.00")
        expect(totals).to_contain_text("Net spent$31.00")
        expect(totals).to_contain_text("Spent for others$5.00")

        daily = page.locator("#statsDaily")
        expect(daily).to_contain_text("Days counted31 days")
        expect(daily).to_contain_text("Average per day$1.00")
        expect(daily).to_contain_text("Average per spending day$10.33")
        expect(daily).to_contain_text("No-spend days28")
        expect(daily).to_contain_text("Longest no-spend streak20 days (03/11/2025 – 03/30/2025)")
        expect(daily).not_to_contain_text("Current no-spend streak")  # the period is over

        records = page.locator("#statsRecords")
        expect(records).to_contain_text("Highest day$20.00 on 03/10/2025")
        expect(records).to_contain_text("Highest week$15.00 (03/01/2025 – 03/02/2025)")  # clipped Mon 02/24 week
        expect(records).to_contain_text("Lowest full month$31.00 in March 2025")

        # Refunds count under their purchase's tag and merchant, regardless of the refund's own merchant text.
        expect(page.locator("#statsTagsTable tbody tr", has_text="groceries")).to_contain_text("$20.00$5.00$15.00")
        expect(page.locator("#statsTagsTable tbody tr", has_text="Untagged")).to_contain_text("3$16.00$0.00$16.00")
        expect(page.locator("#statsMerchantsTable tbody tr").first).to_contain_text("Market3$31.00$5.00$26.00$10.33")
        expect(page.locator("#statsMerchantsTable")).not_to_contain_text("Returned desk")
        self.shot(page, "stats-march-2025")


if __name__ == "__main__":
    unittest.main()
