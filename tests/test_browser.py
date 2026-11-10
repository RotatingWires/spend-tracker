"""Browser checks with Playwright against a real server. Optional: needs `pip install playwright` and `playwright install firefox`.

Run: python3 -m unittest tests/test_browser.py   (set SPEND_TRACKER_SCREENSHOTS=/some/dir to keep screenshots)
"""

import os
from datetime import date
import re
import unittest
from pathlib import Path

from server import PASSWORD, Server, build

try:
    from playwright.sync_api import expect, sync_playwright
except ImportError:  # Playwright is a development-only tool.
    sync_playwright = None

TABS = ["Transactions", "Calendar", "Stats", "People", "Payment Methods", "Tags", "Collections", "Merchants", "History"]


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
        # The assertions expect US-style dates and dollars, so the browser reads in American English.
        context = self.browser.new_context(**{'locale': 'en-US', **options})
        self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" and not self.aborted_by_navigation(message.text) else None)
        self.addCleanup(lambda: self.assertEqual(errors, [], "browser errors"))
        return page

    @staticmethod
    def aborted_by_navigation(text):
        """Firefox logs this when the page navigates (restore, log out) while the service worker is still fetching a file
        for it, such as the icon, before that file is cached. The request is simply abandoned; nothing fails for the user."""
        return "A ServiceWorker intercepted the request and encountered an unexpected error" in text

    def api_client(self):
        """One API session for the whole class, so the tests stay under the login rate limit (5 a minute)."""
        if not hasattr(type(self), "api"):
            type(self).api = self.server.logged_in_client()
        return type(self).api

    def shot(self, page, name):
        if self.screenshots:
            self.screenshots.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(self.screenshots / f"{name}.png"), full_page=False)

    def log_in(self, page):
        """The first test runs first-run setup in the page; later ones reuse the API session's cookie (login allows 5 a minute)."""
        if not (self.server.data_dir / "auth.json").exists():
            page.goto(self.server.url + "/")
            expect(page.locator("#setupTokenGroup")).to_be_visible()
            page.fill("#setupToken", self.server.token)
            page.fill("#password", PASSWORD)
            page.fill("#confirmPassword", PASSWORD)
            page.click("#loginButton")
            # A new database asks to restore a backup first, in the same box as TaskList: Cancel-like first.
            expect(page.locator("#firstRunDialog")).to_be_visible()
            expect(page.locator("#firstRunDialog .dialog-buttons button")).to_have_text(["Start Fresh", "Import/Export..."])
            page.click("#firstRunContinue")
            expect(page.locator("#firstRunDialog")).not_to_be_visible()
        else:
            page.context.add_cookies([{"name": cookie.name, "value": cookie.value, "url": self.server.url} for cookie in self.api_client().cookies])
            page.goto(self.server.url + "/")
        expect(page.locator("#statusLeft")).to_have_text("Ready")

    def pick(self, page, host, label):
        page.click(f"{host} .retro-select")
        page.locator(f"{host} .menu-dropdown button", has_text=label).first.click()

    KIND_LABELS = {"Purchase": "Purchase", "Refund": "Refund / return", "Payback": "Payback to me"}

    @staticmethod
    def bar(page, chart, name):
        """Where the bar for `name` is in a bar chart, found from the chart's label ("Market: $26.00; groceries: $15.00")."""
        parts = page.locator(chart).get_attribute("aria-label").split("; ")
        index = next(i for i, part in enumerate(parts) if part.startswith(name + ":"))
        box = page.locator(chart).bounding_box()
        slot = (box["width"] - 70 - 12) / len(parts)  # the chart's left and right padding
        return {"x": 70 + slot * (index + 0.5), "y": box["height"] - 40}

    def set_checks(self, page, host, names):
        """Makes exactly these items checked in a multi-select dropdown, then closes it."""
        page.click(f"{host} .retro-select")
        for item in page.locator(f"{host} .menu-dropdown button").all():
            wanted = item.inner_text().strip() in names
            if (item.get_attribute("aria-checked") == "true") != wanted:
                item.click()
        page.keyboard.press("Escape")

    def choose_time_frame(self, page, labels):
        """Months sit under their year in the dropdown, so the wanted years are expanded first."""
        page.click("#timeFrameSelect .retro-select")
        for year in sorted({label.split()[-1] for label in labels if label != "All time"}):
            heading = page.locator(f'#timeFrameSelect .menu-group[data-group="{year}"]')
            if heading.get_attribute("aria-expanded") == "false":
                heading.click()
        page.keyboard.press("Escape")
        self.choose_checks(page, "#timeFrameSelect", labels)

    def choose_checks(self, page, host, labels):
        """Checks exactly these entries of a dropdown that keeps at least one checked, checking the wanted ones first.
        The menu re-renders after each click, so items are found again each time."""
        page.click(f"{host} .retro-select")
        # Year headings (whose text changes with the count) are not choices.
        items = page.locator(f"{host} .menu-dropdown button:not(.menu-group)")
        for label in labels:
            item = items.filter(has_text=re.compile(f"^{re.escape(label)}$"))
            if item.get_attribute("aria-checked") != "true":
                item.click()
        for label in [text.strip() for text in items.all_inner_texts()]:
            item = items.filter(has_text=re.compile(f"^{re.escape(label)}$"))
            if label not in labels and item.get_attribute("aria-checked") == "true":
                item.click()
        page.keyboard.press("Escape")

    def merchant_id(self, name):
        """The ID of the merchant with this name, adding it through the API if needed; "" means no merchant."""
        if not name:
            return None
        api = self.api_client()
        found = next((m["id"] for m in api.get("/api/snapshot")["merchants"] if m["name"] == name), None)
        return found or api.post("/api/merchants", {"name": name})["id"]

    def add_transaction(self, page, kind="Purchase", amount=None, merchant=None, description=None, people=None, person=None, linked=None):
        """Fills only the given fields, so values the editor copies from a linked purchase are kept."""
        page.click("#newTransactionButton")
        self.pick(page, "#txKind", self.KIND_LABELS[kind])
        if people:
            self.set_checks(page, "#txPeople", people)
        if person:
            # A payback's payers are a multi-select (several people can pay back at once); a refund picks one share.
            if kind == "Payback":
                self.set_checks(page, "#txPayers", [person])
            else:
                self.pick(page, "#txPerson", person)
        if linked:
            self.pick(page, "#txLinked", linked)
        if merchant:
            self.pick(page, "#txMerchant", merchant)
        for selector, value in (("#txAmount", amount), ("#txDescription", description)):
            if value is not None:
                page.fill(selector, value)
        page.click("#txSaveButton")
        expect(page.locator("#txError")).to_have_text("")
        expect(page.locator("#transactionDialog")).not_to_be_visible()

    def test_fresh_start_dialog(self):
        # Clears only change history and recovery backups, so the entries other tests check stay; the API tests cover the rest.
        # Adding and deleting a tag leaves history to clear without changing any totals.
        api = self.api_client()
        tag = api.post("/api/tags", {"name": "fresh-start-check"})["id"]
        api.request("DELETE", f"/api/tags/{tag}")
        page = self.new_page(viewport={"width": 1280, "height": 900})
        self.log_in(page)
        page.click("#fileMenuButton")
        labels = [text.strip() for text in page.locator("#fileMenu button").all_inner_texts()]
        self.assertEqual(labels[-2:], ["Log Out", "Fresh Start..."])  # kept apart from everyday commands
        page.click("#freshStartMenuItem")
        dialog = page.locator("#freshStartDialog")
        self.assertEqual(dialog.bounding_box()["width"], 620)  # NewsReview's Fresh start dialog width
        self.assertEqual(dialog.locator('[data-fresh-start="history"]').evaluate("e => getComputedStyle(e).appearance"), "none")
        expect(dialog.locator('[data-fresh-count="history"]')).to_have_text(re.compile(r"^\(\d+ changes?\)$"))
        expect(dialog.locator('[data-fresh-start="history"]')).to_be_checked()
        expect(dialog.locator('[data-fresh-start="recoveryBackups"]')).to_be_checked()
        for option in ("archivedEntries", "allEntries", "unusedLabels"):
            expect(dialog.locator(f'[data-fresh-start="{option}"]')).not_to_be_checked()
        self.shot(page, "fresh-start-dialog")
        page.evaluate("document.documentElement.dataset.theme = 'dark'")
        self.shot(page, "fresh-start-dialog-dark")
        page.evaluate("document.documentElement.dataset.theme = 'light'")
        page.click("#freshStartButton")
        expect(page.locator("#freshStartError")).to_have_text("Type RESET SELECTED to confirm.")
        expect(dialog).to_be_visible()
        page.fill("#freshStartConfirmation", "RESET SELECTED")
        page.click("#freshStartButton")
        expect(dialog).not_to_be_visible()
        expect(page.locator("#statusLeft")).to_have_text(re.compile(r"^Fresh start: removed \d+ history changes?; freed "))
        self.assertEqual(api.get("/api/history")["entries"], [])

        page.set_viewport_size({"width": 390, "height": 760})
        page.click("#fileMenuButton")
        page.click("#freshStartMenuItem")
        box = dialog.bounding_box()
        self.assertLessEqual(box["x"] + box["width"], 390)
        self.assertLessEqual(box["y"] + box["height"], 760)
        self.shot(page, "fresh-start-dialog-phone")
        page.keyboard.press("Escape")

    def test_full_workflow_in_both_themes_and_phone_width(self):
        page = self.new_page(viewport={"width": 1280, "height": 900})
        self.log_in(page)

        # Each kind of item is added on its own tab: a person, a tag, and merchants.
        expect(page.locator('.tabs [data-tab="manage"]')).to_have_count(0)
        page.click('.tabs [data-tab="people"]')
        page.fill('form[data-add="people"] input', "Alex")
        page.click('form[data-add="people"] button')
        expect(page.locator("#peopleTable")).to_contain_text("Alex")
        expect(page.locator("#peopleTable tbody tr").first).to_contain_text("Me (you)")
        page.click('.tabs [data-tab="tags"]')
        page.fill('form[data-add="tags"] input', "food")
        page.click('form[data-add="tags"] button')
        expect(page.locator("#tagsTable")).to_contain_text("food")
        box, button = (page.locator(f'form[data-add="tags"] {part}').bounding_box() for part in ("input", "button"))
        self.assertEqual(box["height"], button["height"], "the Add box is as tall as its Add button")
        # A tag's row opens its dialog, which holds Rename, Archive, and Delete. Rename asks with Cancel, then Save; Enter saves.
        expect(page.locator("#tagsTable button")).to_have_count(0)
        page.locator("#tagsTable tbody tr", has_text="food").click()
        expect(page.locator("#scopeActions button")).to_have_text(["Rename", "Archive", "Delete"])
        page.locator("#scopeActions button", has_text="Rename").click()
        expect(page.locator("#promptDialog .dialog-buttons button")).to_have_text(["Cancel", "Save"])
        page.fill("#promptInput", "groceries")
        page.keyboard.press("Enter")
        expect(page.locator("#tagsTable")).to_contain_text("groceries")
        expect(page.locator("#scopeDialogTitle")).to_have_text("Tag: groceries")
        page.locator("#scopeActions button", has_text="Rename").click()
        page.fill("#promptInput", "food")
        page.locator("#promptDialog button", has_text="Save").click()
        expect(page.locator("#tagsTable")).to_contain_text("food")
        page.locator("#scopeDialog button", has_text="Close").click()
        # The editor only chooses merchants from the ones added on the Merchants tab.
        page.click('.tabs [data-tab="merchants"]')
        for name in ("BK", "Diner", "After backup"):
            page.fill('form[data-add="merchants"] input', name)
            page.click('form[data-add="merchants"] button')
            expect(page.locator("#merchantsTable")).to_contain_text(name)

        # Transactions: purchase for me (with a tag), purchase for Alex, refund, payback.
        page.click('.tabs [data-tab="transactions"]')
        page.click("#newTransactionButton")
        page.fill("#txAmount", "12.17")
        self.pick(page, "#txMerchant", "BK")
        page.fill("#txDescription", "food")
        expect(page.locator("#txNewTag")).to_have_count(0)  # tags are only created on the Tags tab
        self.set_checks(page, "#txTags", ["food"])
        expect(page.locator("#txTags .retro-select")).to_have_text("food▼")
        page.click("#txSaveButton")
        expect(page.locator("#transactionsTable")).to_contain_text("BK — food")

        self.add_transaction(page, amount="$40", merchant="Diner", description="dinner", people=["Alex"])
        self.add_transaction(page, kind="Refund", linked="Diner")
        page.locator("#transactionsTable tbody tr", has_text="Refund:").first.wait_for()
        self.add_transaction(page, kind="Payback", amount="10", description="Venmo", person="Alex")
        expect(page.locator("#monthCards")).to_have_count(0)  # Stats has the totals; the ledger has its Totals row
        expect(page.locator("#transactionsTable tfoot")).to_contain_text("$12.17")  # net: 12.17 + 40 - 40 refund
        # Net Spent is its own column: each row's effect on net spent, with the total in the footer.
        expect(page.locator("#transactionsTable thead th").last).to_have_text("Net Spent")
        expect(page.locator("#transactionsTable tfoot td").last).to_have_text("$12.17")
        expect(page.locator("#transactionsTable tbody tr", has_text="Venmo").locator("td").last).to_have_text("—")
        # Linked To: a refund shows the purchase it is for, and the purchase shows its refund. Selecting one opens
        # that entry, not the row's own.
        refund_row = page.locator("#transactionsTable tbody tr", has_text="Refund:")
        diner_row = page.locator("#transactionsTable tbody tr", has_text="Diner — dinner").filter(has_not_text="Refund:")
        refund_id = refund_row.locator("td").first.inner_text().strip("#")
        expect(diner_row.locator(".linked-entry")).to_have_text(f"Refund #{refund_id}")
        diner_row.locator(".linked-entry").click()
        expect(page.locator("#transactionDialogTitle")).to_have_text(f"Edit Refund #{refund_id}")
        page.click("#txCancelButton")
        linked = refund_row.locator(".linked-entry")
        expect(linked).to_contain_text("Diner — dinner")
        linked.click()
        expect(page.locator("#transactionDialogTitle")).to_contain_text("Edit Purchase")
        # View Entry in Time shows the entry in the ledger, highlighted like TaskList's visited task.
        page.click("#txViewButton")
        expect(page.locator("#transactionDialog")).not_to_be_visible()
        expect(page.locator("#transactionsTable tr.visit-highlight")).to_have_count(1)
        expect(page.locator("#transactionsTable tr.visit-highlight")).to_contain_text("Diner — dinner")
        expect(page.locator("#transactionsTable tr.visit-highlight")).not_to_contain_text("Refund:")

        # The ledger's search box looks anywhere in merchant, description, note, tags, collections, and amount, but not
        # type, method, or people, among the entries in the time frame. It runs on Search or Enter, not while typing.
        rows = page.locator("#transactionsTable tbody tr:not(.empty-row)")
        for query, expected in (("h", 0), ("inn", 2), ("DINER dinner", 2), ("enm", 1), ("12.17", 1), ("$40", 2), ("foo", 1),
                                ("cash", 0), ("purchase", 0), ("alex", 0), ("zzz", 0)):
            page.fill("#ledgerSearch", query)
            page.click("#ledgerSearchForm button")
            expect(rows).to_have_count(expected)
        expect(page.locator("#transactionsTable tbody")).to_contain_text('matches "zzz"')
        page.fill("#ledgerSearch", "inn")
        page.wait_for_timeout(200)
        expect(rows).to_have_count(0)  # still showing the last search ("zzz") until Search or Enter
        page.keyboard.press("Enter")
        expect(rows).to_have_count(2)
        expect(page.locator("#transactionsTable tfoot td").last).to_have_text("$0.00")  # Diner $40 and its $40 refund
        page.fill("#ledgerSearch", "")
        page.keyboard.press("Enter")
        expect(rows).to_have_count(4)
        expect(page.locator("#fileMenu")).not_to_contain_text("Search")  # File > Search... is gone

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
                expect(page.locator("html")).to_have_attribute("data-theme", "dark")
            for tab in TABS:
                page.click(f'.tabs button:text-is("{tab}")')
                panel = page.locator(".tabs button", has_text=re.compile(f"^{tab}$")).get_attribute("data-tab")
                expect(page.locator(f'.tab-panel[data-panel="{panel}"]')).to_be_visible()
                if tab == "History":
                    expect(page.locator("#historyTable")).to_contain_text("Created")
                self.shot(page, f"{tab.lower()}-{theme}")

        page.click('.tabs [data-tab="stats"]')
        expect(page.locator("#statsTotals")).to_contain_text("$52.17")  # spent
        page.click('[data-stats-tab="places"]')
        expect(page.locator("#statsTagsChart")).to_have_attribute("aria-label", re.compile(r"\bUntagged: "))
        page.click('[data-stats-tab="overview"]')

        page.click('.tabs [data-tab="people"]')
        expect(page.locator("#peopleTable")).to_contain_text("overpaid")  # refunded in full, then paid $10 back
        page.locator("#peopleTable tbody tr", has_text="Alex").click()
        expect(page.locator("#personDialog")).to_be_visible()
        self.shot(page, "person-dialog-dark")
        page.keyboard.press("Escape")

        page.click('.tabs [data-tab="calendar"]')
        page.locator("#calendarMonths button.calendar-day", has_text="$").first.click()
        expect(page.locator("#dayDialog")).to_be_visible()
        page.keyboard.press("Escape")

        # Phone width: no sideways page scrolling, and the editor fits.
        page.set_viewport_size({"width": 390, "height": 844})
        for tab in TABS:
            page.click(f'.tabs button:text-is("{tab}")')
            overflow = page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
            self.assertLessEqual(overflow, 0, f"{tab} scrolls sideways on a phone")
        page.click('.tabs [data-tab="transactions"]')
        page.click("#newTransactionButton")
        box = page.locator("#transactionDialog").bounding_box()
        self.assertLessEqual(box["x"] + box["width"], 390)
        self.shot(page, "editor-phone-dark")
        page.click("#txCancelButton")

        # Download a backup, change the data, then restore it through the UI.
        page.set_viewport_size({"width": 1280, "height": 900})
        page.click('.tabs [data-tab="transactions"]')
        page.click("#fileMenuButton")
        page.click("#transferMenuItem")
        self.shot(page, "import-export-dialog")
        with page.expect_download() as download_info:
            page.click("#backupButton")
        download = download_info.value
        self.assertRegex(download.suggested_filename, r"^spendtracker-backup-\d{8}-\d{6}\.zip$")
        backup_path = Path(download.path())
        page.locator("#transferDialog").get_by_role("button", name="OK").click()
        self.add_transaction(page, amount="99", merchant="After backup")
        expect(page.locator("#transactionsTable")).to_contain_text("After backup")
        page.set_input_files("#restoreFileInput", str(backup_path))
        page.click("#confirmOkButton")
        expect(page.locator("#statusLeft")).to_contain_text("Restored 4 transactions")
        expect(page.locator("#transactionsTable")).not_to_contain_text("After backup")
        expect(page.locator("#transactionsTable")).to_contain_text("BK — food")

        # Opening a menu does not leave its first item highlighted (focus stays on the menu button).
        page.click("#fileMenuButton")
        self.assertFalse(page.evaluate("Boolean(document.activeElement.closest('.menu-dropdown'))"))
        page.click("#fileMenuButton")

        # Logging out returns to the login page and protects the app.
        page.click("#fileMenuButton")
        page.click("#logoutButton")
        page.wait_for_url(re.compile(r"/login\.html"))
        page.goto(self.server.url + "/")
        page.wait_for_url(re.compile(r"/login\.html"))

    def test_split_defaults_zero_shares_and_paybacks_from_several_people(self):
        page = self.new_page(viewport={"width": 1280, "height": 900})
        self.log_in(page)
        api = self.api_client()
        new_people = {api.post("/api/people", {"name": name})["id"] for name in ("Dana", "Eli")}
        page.reload()
        expect(page.locator("#statusLeft")).to_have_text("Ready")

        # Adding someone gives you the whole amount and them a blank box ($0.00, with 0.00 as its hint); your box follows the
        # amount until you change one.
        page.click("#newTransactionButton")
        page.fill("#txAmount", "30")
        self.set_checks(page, "#txPeople", ["Me (you)", "Dana"] if page.locator("#txPeople .menu-dropdown button", has_text="(you)").count() else ["Me", "Dana"])
        shares = page.locator("#txShares input[data-person]")
        # A heading says what the boxes are: each person's share of the cost, not what they paid.
        expect(page.locator("#txShares .share-heading")).to_contain_text("Share of the cost")
        expect(shares.nth(0)).to_have_value("30.00")
        expect(shares.nth(1)).to_have_value("")
        expect(shares.nth(1)).to_have_attribute("placeholder", "0.00")
        page.fill("#txAmount", "40")
        expect(shares.nth(0)).to_have_value("40.00")
        # 0 is a valid share; it is left blank like a new box, so typing an amount there needs no clearing first.
        shares.nth(1).fill("0")
        shares.nth(1).blur()
        expect(shares.nth(1)).to_have_value("")
        shares.nth(1).fill("")
        page.fill("#txDescription", "Groceries")
        page.click("#txSaveButton")
        expect(page.locator("#statusLeft")).to_contain_text("Added purchase")
        purchase = max(api.get("/api/snapshot")["transactions"], key=lambda tx: tx["id"])
        self.assertEqual([share["amountCents"] for share in purchase["shares"]], [4000, 0])  # Dana stays on it at $0.00

        # A payback from two people saves one payback each.
        page.click("#newTransactionButton")
        self.pick(page, "#txKind", "Payback to me")
        page.fill("#txAmount", "25")
        self.set_checks(page, "#txPayers", ["Dana", "Eli"])
        payers = page.locator("#txPayerShares input[data-person]")
        expect(page.locator("#txPayerShares .share-heading")).to_contain_text("Amount paid back")
        expect(payers.nth(0)).to_have_value("25.00")
        expect(payers.nth(1)).to_have_value("")
        page.click("#txPayerShares button:has-text('Split Evenly')")
        page.fill("#txDescription", "Venmo")
        page.click("#txSaveButton")
        expect(page.locator("#statusLeft")).to_contain_text("Saved 2 paybacks")
        # Other tests share this server, so only Dana's and Eli's paybacks count here.
        paybacks = [tx for tx in api.get("/api/snapshot")["transactions"] if tx["kind"] == "Payback" and tx["personId"] in new_people]
        self.assertEqual(sorted(tx["amountCents"] for tx in paybacks), [1250, 1250])

        # Any purchase the payer is on can be linked, paid off or not, and the list has a search box (by #ID too).
        page.click("#newTransactionButton")
        self.pick(page, "#txKind", "Payback to me")
        self.set_checks(page, "#txPayers", ["Dana"])
        page.click("#txLinked .retro-select")
        expect(page.locator("#txLinked .menu-search")).to_be_visible()
        page.fill("#txLinked .menu-search input", f"#{purchase['id']}")
        expect(page.locator("#txLinked .menu-list [role=menuitemradio]")).to_have_count(1)
        expect(page.locator("#txLinked .menu-list [role=menuitemradio]")).to_contain_text("Groceries")
        page.keyboard.press("Escape")
        page.click("#txCancelButton")

    def test_phone_menus_open_in_place_and_dialogs_open_at_the_top(self):
        page = self.new_page(viewport={"width": 390, "height": 700}, has_touch=True)
        self.log_in(page)
        page.click("#newTransactionButton")
        body = page.locator("#transactionDialog .dialog-body")
        # On a touch screen a menu in a dialog opens under its button, not floating, so a phone's keyboard cannot move it.
        if page.evaluate("matchMedia('(pointer: coarse)').matches"):
            page.click("#txMethod > button")
            expect(page.locator("#txMethod .menu-dropdown")).to_have_class(re.compile("in-place-menu"))
            page.click("#txMethod > button")
        # Paid with always has a search box, however few cards there are.
        page.click("#txMethod > button")
        expect(page.locator("#txMethod .menu-search")).to_be_visible()
        page.fill("#txMethod .menu-search input", "deb")
        expect(page.locator("#txMethod .menu-list [role=menuitemradio]")).to_have_text(["Debit Card"])
        page.locator("#txMethod .menu-list [role=menuitemradio]").click()
        # A dialog that was scrolled down opens at its top the next time.
        body.evaluate("box => box.scrollTop = 200")
        self.assertGreater(body.evaluate("box => box.scrollTop"), 0)
        page.locator("#transactionDialog button", has_text="Cancel").click()
        page.click("#newTransactionButton")
        self.assertEqual(body.evaluate("box => box.scrollTop"), 0)
        page.locator("#transactionDialog button", has_text="Cancel").click()
        # What and Linked To keep room to read on a phone; the ledger scrolls sideways instead.
        widths = page.evaluate("[...document.querySelectorAll('#transactionsTable th.wide-text')].map(th => th.getBoundingClientRect().width)")
        self.assertTrue(all(width >= 190 for width in widths), widths)

    def test_split_purchase_in_editor(self):
        page = self.new_page(viewport={"width": 1280, "height": 900})
        self.merchant_id("Pizza")
        self.log_in(page)
        page.click("#newTransactionButton")
        # Amounts are formatted when you leave the box.
        page.fill("#txAmount", "1234.5")
        page.keyboard.press("Tab")
        expect(page.locator("#txAmount")).to_have_value("1,234.50")
        page.fill("#txAmount", "30.01")
        self.pick(page, "#txMerchant", "Pizza")
        # The share rows wait until the For who dropdown closes, so the editor does not resize while people are checked.
        page.click("#txPeople .retro-select")
        page.locator("#txPeople .menu-dropdown button", has_text="Alex").click()
        expect(page.locator("#txPeople .menu-dropdown")).to_be_visible()
        expect(page.locator("#txShares")).to_be_hidden()
        page.keyboard.press("Escape")
        expect(page.locator("#txShares")).to_be_visible()
        expect(page.locator("#txShares .share-row")).to_have_count(2)
        page.locator("#txShares button", has_text="Split Evenly").click()
        expect(page.locator("#txShares input").nth(0)).to_have_value("15.01")  # the first person listed gets the leftover cent
        expect(page.locator("#txShares input").nth(1)).to_have_value("15.00")
        expect(page.locator("#txShareTotal")).to_have_text("Assigned $30.01 of $30.01")
        page.locator("#txShares input[type=checkbox]").check()
        self.shot(page, "editor-split")
        page.locator("#txShares input[type=checkbox]").uncheck()
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
        page.locator("#personDialog button", has_text="Close").click()

    def test_gifts_and_adding_from_the_editor(self):
        page = self.new_page(viewport={"width": 1280, "height": 900})
        self.log_in(page)
        # New Transaction... stays in the top left on every tab.
        positions = set()
        for tab in TABS:
            page.click(f'.tabs button:text-is("{tab}")')
            box = page.locator("#newTransactionButton").bounding_box()
            positions.add((box["x"], box["y"]))
        self.assertEqual(len(positions), 1, "New Transaction... moved between tabs")
        page.click('.tabs [data-tab="transactions"]')

        # Every editor dropdown can add a new item, which is then chosen.
        page.click("#newTransactionButton")
        page.fill("#txAmount", "25")
        page.click("#txMerchant .retro-select")
        page.locator("#txMerchant .menu-dropdown button", has_text="Add New...").click()
        expect(page.locator("#promptTitle")).to_have_text("New merchant")
        page.fill("#promptInput", "Florist")
        page.keyboard.press("Enter")
        expect(page.locator("#txMerchant .retro-select")).to_have_text("Florist▼")
        page.click("#txPeople .retro-select")
        page.locator("#txPeople .menu-dropdown button", has_text="Add New...").click()
        page.fill("#promptInput", "Sam")
        page.keyboard.press("Enter")
        self.set_checks(page, "#txPeople", ["Sam"])
        page.click("#txTags .retro-select")
        page.locator("#txTags .menu-dropdown button", has_text="Add New...").click()
        page.fill("#promptInput", "gifts")
        page.keyboard.press("Enter")
        expect(page.locator("#txTags .retro-select")).to_have_text("gifts▼")

        # A gift share is bought for them but stays off their balance unless Include gifts is checked.
        page.locator("#txShares input[type=checkbox]").check()  # Sam alone: one Gift box, no amount boxes
        page.click("#txSaveButton")
        expect(page.locator("#transactionDialog")).not_to_be_visible()
        expect(page.locator("#transactionsTable tbody tr", has_text="Florist")).to_contain_text("Sam (gift)")
        page.click('.tabs [data-tab="people"]')
        row = page.locator("#peopleTable tbody tr", has_text="Sam")
        expect(row).to_contain_text("$25.00$25.00")  # bought for them, all of it a gift
        expect(row).to_contain_text("Settled")
        page.check("#includeGifts")
        expect(row).to_contain_text("$25.00 owed to you")
        page.uncheck("#includeGifts")
        expect(row).to_contain_text("Settled")
        row.click()
        expect(page.locator("#personTable tbody tr", has_text="Florist")).to_contain_text("Gift")
        page.locator("#personDialog button", has_text="Close").click()

    def test_time_frames_and_collections(self):
        page = self.new_page(viewport={"width": 1280, "height": 900})
        self.log_in(page)
        api = self.api_client()
        snapshot = api.get("/api/snapshot")
        me = next(p["id"] for p in snapshot["people"] if p["isSelf"])
        card = snapshot["paymentMethods"][1]["id"]
        trip = api.post("/api/collections", {"name": "Beach trip"})["id"]

        def add(kind, date, cents, merchant, linked=None, collections=()):
            return api.post("/api/transactions", {
                "kind": kind, "date": date, "amountCents": cents, "paymentMethodId": card, "personId": None if kind == "Purchase" else me,
                "linkedId": linked, "merchantId": self.merchant_id(merchant), "description": "", "note": "", "tagIds": [], "collectionIds": list(collections),
                "shares": [{"personId": me, "amountCents": cents}] if kind == "Purchase" else []})

        # January and February 2024 belong to this test alone; amounts stay large for the Stats test's lowest month.
        hotel = add("Purchase", "2024-01-20", 60000, "Hotel", collections=[trip])
        add("Purchase", "2024-02-03", 70000, "Groceries")
        add("Refund", "2024-02-05", 10000, "Hotel", linked=hotel["id"])
        page.click("#fileMenuButton")
        page.click("#refreshButton")

        # Several months show together, and All time shows everything.
        self.choose_time_frame(page, ["January 2024", "February 2024"])
        expect(page.locator("#titleScope")).to_have_text("Jan 2024, Feb 2024")
        # The dropdown nests months under their year; a year with checked months shows how many and starts open.
        page.click("#timeFrameSelect .retro-select")
        heading = page.locator('#timeFrameSelect .menu-group[data-group="2024"]')
        expect(heading).to_have_text("2024 (2)")
        heading.click()
        expect(heading).to_have_attribute("aria-expanded", "false")
        expect(page.locator("#timeFrameSelect .menu-dropdown button", has_text="January 2024")).to_have_count(0)
        expect(page.locator("#timeFrameSelect .menu-dropdown")).to_be_visible()  # expanding or collapsing keeps it open
        heading.click()
        expect(page.locator("#timeFrameSelect .menu-dropdown button", has_text="January 2024")).to_have_attribute("aria-checked", "true")
        page.keyboard.press("Escape")
        expect(page.locator("#timeFrameSelect .retro-select")).to_have_text("2 months▼")  # several months show as a count
        expect(page.locator("#transactionsTable tbody tr")).to_have_count(3)
        expect(page.locator("#transactionsTable tfoot td").last).to_have_text("$1,200.00")  # $600 + $700 − $100 refund
        expect(page.locator("#transactionsTable tbody tr", has_text="Hotel").first).to_contain_text("Beach trip")
        page.click("#nextMonthButton")
        expect(page.locator("#titleScope")).to_have_text("Feb 2024, Mar 2024")
        page.click("#previousMonthButton")
        page.click('.tabs [data-tab="calendar"]')
        expect(page.locator("#calendarMonths legend")).to_have_text(["February 2024", "January 2024"])
        expect(page.locator('#calendarMonths [data-month="2024-01"] .calendar-day', has_text="Beach trip")).to_have_count(1)
        # A day's entries have their own Net Spent column, as in the ledger.
        page.locator('#calendarMonths [data-date="2024-02-05"]').click()  # the refund
        expect(page.locator("#dayTable thead th").last).to_have_text("Net Spent")
        expect(page.locator("#dayTable tbody td").last).to_have_text("−$100.00")
        expect(page.locator("#dayAddButton")).to_have_text("Add to This Day")
        self.shot(page, "day-dialog")
        # A collection's name opens it in the calendar: the months it spans, with its days outlined.
        # Days with no entries are not buttons, so they cannot be selected.
        expect(page.locator('#calendarMonths div[data-date="2024-02-04"]')).to_have_count(1)
        expect(page.locator('#calendarMonths button[data-date="2024-02-04"]')).to_have_count(0)
        # Opened in a new tab, the link goes to the collection's entries on the Collections tab.
        link = page.locator("#dayDialogCollections .collection-link", has_text="Beach trip")
        linked = page.context.new_page()
        linked.goto(self.server.url + link.get_attribute("href"))
        expect(linked.locator('.tabs [data-tab="collections"]')).to_have_attribute("aria-selected", "true")
        expect(linked.locator("#scopeDialogTitle")).to_have_text("Collection: Beach trip")
        self.assertEqual(linked.evaluate("location.pathname"), "/")
        linked.close()
        link.click()
        expect(page.locator("#dayDialog")).not_to_be_visible()
        expect(page.locator("#titleScope")).to_have_text("Jan 2024, Feb 2024")
        expect(page.locator("#calendarMonths .collection-focus")).to_have_count(2)
        self.shot(page, "collection-calendar")
        self.choose_time_frame(page, ["All time"])
        expect(page.locator("#titleScope")).to_have_text("All time")
        expect(page.locator("#previousMonthButton")).to_be_disabled()
        self.shot(page, "calendar-all-time")
        self.choose_time_frame(page, ["January 2024"])
        expect(page.locator("#calendarMonths legend")).to_have_text(["January 2024"])
        # Today appears away from this month and goes back to it.
        page.click("#todayButton")
        expect(page.locator("#titleScope")).to_have_text(date.today().strftime("%B %Y"))
        expect(page.locator("#todayButton")).to_be_hidden()
        self.choose_time_frame(page, ["January 2024"])

        # Collections total their own purchases and the refunds on them, wherever they are dated.
        page.click('.tabs [data-tab="collections"]')
        row = page.locator("#collectionsTable tbody tr", has_text="Beach trip")
        expect(row).to_contain_text("1$600.00$100.00$500.00")
        row.click()
        expect(page.locator("#scopeActions button")).to_have_text(["Stats", "Rename", "Archive", "Delete"])
        page.locator("#scopeActions button", has_text="Stats").click()
        expect(page.locator("#statsTotals")).to_contain_text("Spent$600.00")
        expect(page.locator("#statsTotals")).to_contain_text("Net spent$500.00")
        # Stats charts people, tags, collections, and merchants the same way; hovering a bar shows its figures for the
        # period, and selecting it opens its numbered list.
        page.click('[data-stats-tab="places"]')
        expect(page.locator("#statsCollectionsChart")).to_have_attribute("aria-label", "Beach trip: $500.00")
        expect(page.locator("#statsPeopleChart")).to_have_attribute("aria-label", "Me: $500.00")
        page.locator("#statsCollectionsChart").hover(position=self.bar(page, "#statsCollectionsChart", "Beach trip"))
        expect(page.locator(".chart-tooltip")).to_contain_text("Beach tripNet spent: $500.00Purchases: 1Spent: $600.00Refunds: $100.00Avg purchase: $600.00")
        self.shot(page, "stats-collection")
        page.click('[data-stats-tab="trends"]')
        # The chart can show other measures than net spent, per day here because the collection spans 17 days.
        # Measures are check items; each gets a color in the key, whose definition shows on hover.
        self.choose_checks(page, "#statsChartMetric", ["Spent", "Refunds", "Purchases"])
        expect(page.locator("#statsChartLegend")).to_have_text("Activity per Day")
        expect(page.locator("#statsChartKey .chart-key-item")).to_have_text(["Spent", "Refunds", "Purchases"])
        expect(page.locator("#statsChartKey .chart-key-item").first).to_have_attribute("title", "Total of purchases.")
        box = page.locator("#statsChart").bounding_box()
        page.mouse.move(box["x"] + 75, box["y"] + 120)  # the first day's bars
        expect(page.locator(".chart-tooltip")).to_contain_text("01/20/2024Spent: $600.00Refunds: $0.00Purchases: 1")
        self.shot(page, "stats-chart-measures")
        self.choose_checks(page, "#statsChartMetric", ["Net spent"])
        self.set_checks(page, "#statsChartMetric", [])  # the last measure cannot be unchecked
        expect(page.locator("#statsChartKey .chart-key-item")).to_have_count(1)
        expect(page.locator("#statsChartLegend")).to_have_text("Net spent per Day")
        # Merchants and Tags tabs total each one like the Collections tab.
        page.click('.tabs [data-tab="merchants"]')
        expect(page.locator("#merchantsTable tbody tr", has_text="Hotel")).to_contain_text("Hotel1$600.00$100.00$500.00")
        page.click('.tabs [data-tab="tags"]')
        expect(page.locator("#tagsTable")).to_be_visible()
        page.click('.tabs [data-tab="stats"]')
        page.click('[data-stats-tab="places"]')
        page.locator("#statsMerchantsChart").click(position=self.bar(page, "#statsMerchantsChart", "Hotel"))
        expect(page.locator("#scopeDialogTitle")).to_have_text("Merchant: Hotel")
        page.locator("#scopeDialog button", has_text="Close").click()

        # New Transaction... stands out, and purchases choose collections like tags.
        page.click('.tabs [data-tab="transactions"]')
        expect(page.locator("#newTransactionButton")).to_have_text("New Transaction...")
        page.click("#newTransactionButton")
        self.set_checks(page, "#txCollections", ["Beach trip"])
        expect(page.locator("#txCollections .retro-select")).to_have_text("Beach trip▼")
        page.click("#txCancelButton")
        page.click('.tabs [data-tab="collections"]')
        page.locator("#collectionsTable tbody tr", has_text="Beach trip").click()
        expect(page.locator("#scopeDialogTitle")).to_have_text("Collection: Beach trip")
        expect(page.locator("#scopeTable tbody tr")).to_have_count(1)
        page.locator("#scopeDialog button", has_text="Close").click()

    def test_select_and_bulk_actions(self):
        page = self.new_page(viewport={"width": 1280, "height": 900})
        self.log_in(page)
        api = self.api_client()
        snapshot = api.get("/api/snapshot")
        me = next(p["id"] for p in snapshot["people"] if p["isSelf"])
        cash = snapshot["paymentMethods"][0]["id"]
        riley = api.post("/api/people", {"name": "Riley"})["id"]

        def buy(date, cents, merchant):
            return api.post("/api/transactions", {
                "kind": "Purchase", "date": date, "amountCents": cents, "paymentMethodId": cash, "personId": None, "linkedId": None,
                "merchantId": self.merchant_id(merchant), "description": "", "note": "", "tagIds": [], "shares": [{"personId": me, "amountCents": cents}]})

        # June 2024 is used by no other test. Amounts are large so they never become another test's lowest month.
        first, second, third = buy("2024-06-01", 10000, "Hardware"), buy("2024-06-02", 20000, "Bakery"), buy("2024-06-03", 30001, "Garage")
        page.click("#fileMenuButton")
        page.click("#refreshButton")
        self.choose_time_frame(page, ["June 2024"])
        # Newest first, as in TaskList: the highest ID is on top.
        expect(page.locator("#transactionsTable tbody tr").first).to_contain_text(f"#{third['id']}")
        expect(page.locator("#transactionsTable tbody tr").last).to_contain_text(f"#{first['id']}")
        # Only payment methods used in the time frame get a column: everything in June 2024 is cash.
        expect(page.locator("#transactionsTable thead")).to_contain_text("Cash")
        expect(page.locator("#transactionsTable thead")).not_to_contain_text("Credit Card")
        expect(page.locator("#transactionsTable thead")).not_to_contain_text("Debit Card")

        page.click("#fileMenuButton")
        page.click("#selectModeButton")
        expect(page.locator("#bulkControls")).to_be_visible()
        page.click(f'#transactionsTable tr[data-id="{first["id"]}"] .selection-check')
        page.click(f'#transactionsTable tr[data-id="{third["id"]}"]', modifiers=["Shift"], position={"x": 300, "y": 5})
        expect(page.locator("#selectedCount")).to_have_text("Selected: 3")

        # Adding a person splits each purchase evenly again; the first person listed keeps the leftover cent.
        page.click("#bulkActions .split-arrow")
        page.locator("#bulkActions .split-dropdown button", has_text="People...").click()
        expect(page.locator("#chooseMode .retro-select")).to_have_text("Add to the selected entries▼")  # one action per kind: add or remove
        self.set_checks(page, "#chooseMulti", ["Riley"])
        page.click("#chooseOkButton")
        expect(page.locator("#confirmMessage")).to_have_text('Add "Riley" for 3 selected entries?')
        expect(page.locator("#confirmDetail")).to_contain_text(f"#{third['id']} — 06/03/2024 — Garage — $300.01")
        page.click("#confirmOkButton")
        expect(page.locator("#statusLeft")).to_have_text("People: 3 entries changed.")
        shares = {tx["id"]: tx["shares"] for tx in api.get("/api/snapshot")["transactions"]}
        self.assertEqual(shares[third["id"]], [{"personId": me, "amountCents": 15001, "gift": False}, {"personId": riley, "amountCents": 15000, "gift": False}])

        # A rule the server enforces skips that entry, says why, and leaves it selected.
        api.post("/api/transactions", {
            "kind": "Payback", "date": "2024-06-04", "amountCents": 15000, "paymentMethodId": cash, "personId": riley, "linkedId": third["id"],
            "merchantId": None, "description": "Venmo", "note": "", "tagIds": [], "shares": []})
        page.click("#fileMenuButton")
        page.click("#refreshButton")
        # Entries stay selected after an action (and a refresh), so the next action can follow straight away.
        expect(page.locator("#selectedCount")).to_have_text("Selected: 3")
        page.click("#bulkActions .split-arrow")
        page.locator("#bulkActions .split-dropdown button", has_text="People...").click()
        self.pick(page, "#chooseMode", "Remove from the selected entries")
        self.set_checks(page, "#chooseMulti", ["Riley"])
        page.click("#chooseOkButton")
        page.click("#confirmOkButton")
        expect(page.locator("#confirmMessage")).to_have_text("People: 2 entries changed, 1 skipped. The entries stay selected.")
        expect(page.locator("#confirmDetail")).to_contain_text(f"#{third['id']}: Riley has linked refunds or paybacks on this purchase")
        page.click("#confirmOkButton")
        expect(page.locator("#selectedCount")).to_have_text("Selected: 3")
        for tx in (first, second):
            page.click(f'#transactionsTable tr[data-id="{tx["id"]}"] .selection-check')
        expect(page.locator("#selectedCount")).to_have_text("Selected: 1")

        # The bulk dialogs can add a new item ("Add New..."), which is then checked.
        page.click("#bulkActions .split-arrow")
        page.locator("#bulkActions .split-dropdown button", has_text="Tags...").click()
        expect(page.locator("#chooseDialog .dialog-buttons button")).to_have_text(["Cancel", "OK"])
        page.click("#chooseMulti .retro-select")
        page.locator("#chooseMulti .menu-dropdown button", has_text="Add New...").click()
        expect(page.locator("#promptDialog .dialog-buttons button")).to_have_text(["Cancel", "Save"])
        page.fill("#promptInput", "errands")
        page.keyboard.press("Enter")  # Enter saves, though Cancel comes first
        expect(page.locator("#chooseMulti .retro-select")).to_have_text("errands▼")
        page.click("#chooseOkButton")
        page.click("#confirmOkButton")
        expect(page.locator(f'#transactionsTable tr[data-id="{third["id"]}"]')).to_contain_text("errands")
        expect(page.locator("#selectedCount")).to_have_text("Selected: 1")  # the changed entry is still selected

        # Merchant... chooses from a dropdown of merchants, like tags and people; the list fits without scrolling the dialog.
        page.click("#bulkActions .split-arrow")
        page.locator("#bulkActions .split-dropdown button", has_text="Merchant...").click()
        page.click("#chooseSelect .retro-select")
        expect(page.locator("#chooseSelect .menu-dropdown")).to_be_in_viewport(ratio=1)  # shown whole, not clipped by the dialog
        self.assertEqual(page.locator("#chooseDialog .dialog-body").evaluate("b => getComputedStyle(b).overflowY"), "visible")
        self.shot(page, "choose-merchant")
        page.locator("#chooseSelect .menu-dropdown button", has_text="Bakery").click()
        page.click("#chooseOkButton")
        page.click("#confirmOkButton")
        expect(page.locator(f'#transactionsTable tr[data-id="{third["id"]}"]')).to_contain_text("Bakery")

        # Archiving hides an entry from the ledger but it still counts in Stats.
        page.click("#bulkActions .split-primary")
        page.click("#confirmOkButton")
        expect(page.locator(f'#transactionsTable tr[data-id="{third["id"]}"]')).to_have_count(0)
        expect(page.locator("#archivedNote")).to_contain_text("1 archived entry hidden")
        page.click("#viewMenuButton")
        page.locator("#viewMenu button", has_text="Show Archived").click()
        expect(page.locator(f'#transactionsTable tr[data-id="{third["id"]}"]')).to_contain_text("(archived)")
        self.shot(page, "bulk-selection")
        page.click("#viewMenuButton")
        page.locator("#viewMenu button", has_text="Show Archived").click()

        page.keyboard.press("Escape")
        expect(page.locator("#bulkControls")).to_be_hidden()
        expect(page.locator("#transactionsTable .selection-check")).to_have_count(0)

        # Filters: any of the checked ones within a group, all groups together. Groups expand like the Time frame years.
        ledger_rows = page.locator("#transactionsTable tbody tr:not(.empty-row)")
        page.click("#ledgerFilterSelect .retro-select")
        page.locator('#ledgerFilterSelect .menu-group[data-group="Merchant"]').click()
        page.locator("#ledgerFilterSelect .menu-dropdown button", has_text="Bakery").click()
        expect(ledger_rows).to_have_count(1)  # Garage's purchase is Bakery now too, but archived and hidden
        expect(ledger_rows.first).to_contain_text(f"#{second['id']}")
        page.locator("#ledgerFilterSelect .menu-dropdown button", has_text="Hardware").click()
        expect(ledger_rows).to_have_count(2)
        page.locator('#ledgerFilterSelect .menu-group[data-group="Type"]').click()
        page.locator("#ledgerFilterSelect .menu-dropdown button", has_text="Payback").click()
        expect(ledger_rows).to_have_count(0)  # the payback has no merchant of its own
        expect(page.locator("#ledgerFilterSelect .retro-select")).to_have_text("3 filters▼")
        page.keyboard.press("Escape")
        # Clear Filters appears only while a filter is checked.
        page.click("#clearFiltersButton")
        expect(page.locator("#ledgerFilterSelect .retro-select")).to_have_text("None▼")
        expect(page.locator("#clearFiltersButton")).to_be_hidden()
        expect(page.locator("#previousMonthButton")).to_have_text("")  # drawn arrows, not characters a phone shows as emoji

        # The editor shows per-scope numbers, and searching the ledger for #ID finds that entry. As in NewsReview, a
        # search also runs when the box loses focus.
        page.fill("#ledgerSearch", f"#{first['id']}")
        page.locator("#statusLeft").click()
        expect(page.locator("#transactionsTable tbody tr")).to_have_count(1)
        page.locator("#transactionsTable tbody tr").first.click()
        expect(page.locator("#txNumbers")).to_contain_text("Hardware #1")
        # Dropdowns in the editor float over the page rather than being cut off by the dialog.
        page.click("#txTags .retro-select")
        expect(page.locator("#txTags .menu-dropdown")).to_have_class(re.compile(r"\bfloating-menu\b"))
        expect(page.locator("#txTags .menu-dropdown")).to_be_in_viewport(ratio=1)
        page.keyboard.press("Escape")

        # Each number opens that scope's numbered list; rows on each item's tab open the same list.
        page.locator("#txNumbers button", has_text="Hardware #1").click()
        expect(page.locator("#transactionDialog")).not_to_be_visible()
        expect(page.locator("#scopeDialogTitle")).to_have_text("Merchant: Hardware")
        expect(page.locator("#scopeTable tbody tr")).to_have_count(1)
        page.locator("#scopeDialog button", has_text="Close").click()
        page.fill("#ledgerSearch", "")
        page.keyboard.press("Enter")
        # A person's row opens their dialog, which numbers their entries the same way.
        page.click('.tabs [data-tab="people"]')
        page.locator("#peopleTable tbody tr", has_text="Riley").click()
        # Riley left #1 and #2 (numbers 1 and 2), so the archived purchase (#3) and the payback (#4) remain.
        rows = page.locator("#personTable tbody tr")
        expect(rows).to_have_count(2)
        expect(rows.nth(0)).to_contain_text("#4")
        expect(rows.nth(1)).to_contain_text("$150.00")  # her share of the split purchase
        # A person's Rename, Archive, and Delete are in their dialog too, not on the row.
        expect(page.locator("#personActions button")).to_have_text(["Rename", "Archive", "Delete"])
        expect(page.locator("#peopleTable button")).to_have_count(0)
        page.locator("#personDialog button", has_text="Close").click()
        page.click('.tabs [data-tab="merchants"]')
        # Merchant rows have no buttons; Rename, Archive, and Delete are in the dialog a row opens.
        expect(page.locator("#merchantsTable button", has_text="Rename")).to_have_count(0)
        page.locator("#merchantsTable tbody tr", has_text="Bakery").click()
        expect(page.locator("#scopeDialogTitle")).to_have_text("Merchant: Bakery")
        expect(page.locator("#scopeActions button")).to_have_text(["Rename", "Archive", "Delete"])
        page.locator("#scopeActions button", has_text="Rename").click()
        page.fill("#promptInput", "Bakery & Cafe")
        page.keyboard.press("Enter")
        expect(page.locator("#scopeDialogTitle")).to_have_text("Merchant: Bakery & Cafe")
        expect(page.locator("#scopeTable tbody tr")).to_have_count(2)  # #2 is the purchase moved here by Merchant...
        page.locator("#scopeTable tbody tr").last.click()
        expect(page.locator("#transactionDialogTitle")).to_have_text(f"Edit Purchase #{second['id']}")
        page.click("#txCancelButton")
        page.click('.tabs [data-tab="methods"]')
        page.locator("#methodsTable tbody tr", has_text="Cash").click()
        expect(page.locator("#scopeDialogTitle")).to_have_text("Payment method: Cash")
        expect(page.locator("#scopeTable tbody tr", has_text="Hardware")).to_contain_text(f"#{first['id']}")  # other tests also pay cash
        page.locator("#scopeDialog button", has_text="Close").click()

    def test_ledger_pages_lazy_stats_and_local_updates(self):
        page = self.new_page(viewport={"width": 1280, "height": 900})
        snapshots = []
        page.on("request", lambda request: snapshots.append(request.url) if request.url.endswith("/api/snapshot") else None)
        stats_modules = []
        page.on("request", lambda request: stats_modules.append(request.url) if request.url.endswith("/stats.js") else None)
        self.log_in(page)
        # Stats and its charts are not loaded until the Stats tab opens.
        self.assertEqual(stats_modules, [])
        api = self.api_client()
        snapshot = api.get("/api/snapshot")
        me = next(p["id"] for p in snapshot["people"] if p["isSelf"])
        cash = snapshot["paymentMethods"][0]["id"]
        # January 2023 is used by no other test: 205 purchases of $1.00.
        for day in range(205):
            api.post("/api/transactions", {
                "kind": "Purchase", "date": f"2023-01-{day % 28 + 1:02d}", "amountCents": 100, "paymentMethodId": cash, "personId": None,
                "linkedId": None, "merchantId": None, "description": f"bulk {day}", "note": "", "tagIds": [], "shares": [{"personId": me, "amountCents": 100}]})
        page.click("#fileMenuButton")
        page.click("#refreshButton")
        self.choose_time_frame(page, ["January 2023"])

        # The ledger draws 200 rows at first; the Totals row covers all of them.
        rows = page.locator("#transactionsTable tbody tr")
        expect(rows).to_have_count(200)
        expect(page.locator("#ledgerMoreText")).to_have_text("Showing 200 of 205 entries.")
        expect(page.locator("#ledgerMoreButton")).to_have_text("Show 5 More")
        expect(page.locator("#transactionsTable tfoot td").last).to_have_text("$205.00")
        # The refund's purchase list draws only the newest 50 purchases; its search finds any of them.
        page.click("#newTransactionButton")
        self.pick(page, "#txKind", "Refund / return")
        page.click("#txLinked .retro-select")
        expect(page.locator("#txLinked .menu-list [role=menuitemradio]")).to_have_count(50)
        expect(page.locator("#txLinked .menu-note")).to_contain_text("Showing the newest 50 of")
        page.fill("#txLinked .menu-search input", "bulk 0")  # the very first of the 205, long before the newest 50
        expect(page.locator("#txLinked .menu-list [role=menuitemradio]")).to_have_count(1)
        page.keyboard.press("Escape")
        page.click("#txCancelButton")
        # Headings sort: ascending, descending, then back to newest first. The ledger sorts every entry, not just the
        # 200 drawn, so the earliest dates come first even though they are not among the newest IDs.
        ids = [tx["id"] for tx in api.get("/api/snapshot")["transactions"] if tx["date"].startswith("2023-01")]
        id_heading = page.locator("#transactionsTable thead th", has_text="ID")
        id_heading.click()
        expect(id_heading).to_have_attribute("aria-sort", "ascending")
        expect(rows.first).to_contain_text(f"#{min(ids)}")
        id_heading.click()
        expect(rows.first).to_contain_text(f"#{max(ids)}")
        id_heading.click()
        expect(id_heading).to_have_attribute("aria-sort", "none")
        page.locator("#transactionsTable thead th", has_text="When").click()
        expect(rows.first.locator("td").nth(1)).to_have_text("01/01/2023")
        expect(rows.last.locator("td").nth(1)).to_have_text("01/28/2023")  # 200 of 205 by date: the last few days of the 28 are left
        page.locator("#transactionsTable thead th", has_text="When").click()
        page.locator("#transactionsTable thead th", has_text="When").click()
        # On a touch screen, holding a heading shows its definition and does not sort.
        net_heading = page.locator("#transactionsTable thead th", has_text="Net Spent")
        box = net_heading.bounding_box()
        net_heading.dispatch_event("pointerdown", {"pointerType": "touch", "clientX": box["x"] + 5, "clientY": box["y"] + 5, "isPrimary": True})
        page.wait_for_timeout(700)
        expect(page.locator(".help-tooltip")).to_be_visible()
        expect(page.locator(".help-tooltip")).to_contain_text("What each entry adds to net spent")
        net_heading.dispatch_event("pointerup", {"pointerType": "touch"})
        net_heading.click()
        expect(net_heading).to_have_attribute("aria-sort", "none")
        net_heading.click()
        expect(net_heading).to_have_attribute("aria-sort", "ascending")  # an ordinary tap or click still sorts
        net_heading.click()
        net_heading.click()
        page.click("#ledgerMoreButton")
        expect(rows).to_have_count(205)
        expect(page.locator("#ledgerMore")).to_be_hidden()

        # Saving merges the server's answer instead of downloading every entry again.
        before = len(snapshots)
        page.click("#newTransactionButton")
        page.fill("#txDate", "2023-01-31")
        page.fill("#txAmount", "7")
        page.fill("#txDescription", "local update")
        page.click("#txSaveButton")
        expect(rows.first).to_contain_text("local update")
        expect(page.locator("#transactionsTable tfoot td").last).to_have_text("$212.00")
        # A click opens an entry, but a drag across it (to select text and copy it) does not.
        box = rows.first.locator("td").nth(3).bounding_box()
        page.mouse.move(box["x"] + 4, box["y"] + box["height"] / 2)
        page.mouse.down()
        page.mouse.move(box["x"] + box["width"] - 4, box["y"] + box["height"] / 2, steps=5)
        page.mouse.up()
        page.wait_for_timeout(300)
        expect(page.locator("#transactionDialog")).not_to_be_visible()
        rows.first.click()
        expect(page.locator("#transactionDialog")).to_be_visible()
        page.click("#txDeleteButton")
        page.click("#confirmOkButton")
        expect(page.locator("#transactionsTable")).not_to_contain_text("local update")
        self.assertEqual(len(snapshots), before)

        page.click('.tabs [data-tab="stats"]')
        expect(page.locator("#statsTotals .stat-card")).to_have_count(10)
        self.assertEqual(len(stats_modules), 1)

        # Merchants and History have search boxes.
        api.post("/api/merchants", {"name": "Zebra Mart"})
        api.post("/api/merchants", {"name": "Yak Shop"})
        for index in range(12):
            api.post("/api/merchants", {"name": f"Filler {index:02d}"})
        page.click("#fileMenuButton")
        page.click("#refreshButton")

        # A long dropdown starts with a filter box: typing narrows it, and Enter picks the first match.
        page.click("#newTransactionButton")
        page.click("#txMerchant .retro-select")
        expect(page.locator("#txMerchant .menu-search input")).to_be_focused()
        page.keyboard.type("zeb")
        expect(page.locator("#txMerchant .menu-list button")).to_have_text(["Zebra Mart", "Add New..."])
        page.keyboard.press("Enter")
        expect(page.locator("#txMerchant .retro-select")).to_have_text("Zebra Mart▼")
        expect(page.locator("#transactionDialog")).to_be_visible()  # Enter picked the merchant; it did not save
        # Dialogs put Cancel first and the confirming button on the right.
        expect(page.locator("#transactionDialog .dialog-buttons button").last).to_have_text("Save")
        page.click("#txCancelButton")
        page.click("#fileMenuButton")
        page.click("#freshStartMenuItem")
        expect(page.locator("#freshStartDialog .fresh-start-actions button")).to_have_text(["Cancel", "Reset Selected Data"])
        page.locator("#freshStartDialog .fresh-start-actions button", has_text="Cancel").click()
        expect(page.locator("#freshStartDialog")).not_to_be_visible()
        page.click('.tabs [data-tab="merchants"]')
        # The search box sits on the Add form's row, and only searches on Search or Enter.
        add_box = page.locator('form[data-add="merchants"]').bounding_box()
        search_box = page.locator("#merchantSearchForm").bounding_box()
        self.assertEqual(round(add_box["y"]), round(search_box["y"]))
        self.assertGreater(search_box["x"], add_box["x"] + add_box["width"])
        self.assertGreater(search_box["x"] + search_box["width"], page.locator("#merchantsTable").bounding_box()["x"] + page.locator("#merchantsTable").bounding_box()["width"] - 20)  # far right
        names = page.locator("#merchantsTable tbody tr td:nth-child(2)")
        page.locator("#merchantsTable thead th", has_text="Merchant").click()
        listed = names.all_inner_texts()
        self.assertEqual(listed, sorted(listed, key=str.lower))
        page.locator("#merchantsTable thead th", has_text="Merchant").click()
        self.assertEqual(names.all_inner_texts(), sorted(listed, key=str.lower, reverse=True))
        page.locator("#merchantsTable thead th", has_text="Merchant").click()
        all_merchants = page.locator("#merchantsTable tbody tr").count()
        page.fill("#merchantSearch", "zebra")
        page.wait_for_timeout(200)
        expect(page.locator("#merchantsTable tbody tr")).to_have_count(all_merchants)
        page.click("#merchantSearchForm button")
        expect(page.locator("#merchantsTable tbody tr")).to_have_count(1)
        expect(page.locator("#merchantsTable tbody tr")).to_contain_text("Zebra Mart")
        page.fill("#merchantSearch", "")
        page.keyboard.press("Enter")
        expect(page.locator("#merchantsTable tbody tr")).to_have_count(all_merchants)
        page.click('.tabs [data-tab="history"]')
        page.fill("#historySearch", "yak shop")
        page.keyboard.press("Enter")
        expect(page.locator("#historyTable tbody tr")).to_have_count(1)
        expect(page.locator("#historyTable tbody tr")).to_contain_text("Yak Shop")
        page.fill("#historySearch", "no such change anywhere")
        page.click("#historySearchForm button")
        expect(page.locator("#historyTable tbody tr")).to_contain_text('No change matches "no such change anywhere".')

    def test_stats_for_a_known_month(self):
        page = self.new_page(viewport={"width": 1280, "height": 900})
        self.log_in(page)
        api = self.api_client()
        snapshot = api.get("/api/snapshot")
        me = next(p["id"] for p in snapshot["people"] if p["isSelf"])
        cash, card = snapshot["paymentMethods"][0]["id"], snapshot["paymentMethods"][1]["id"]
        friend = api.post("/api/people", {"name": "Jordan"})["id"]
        groceries = api.post("/api/tags", {"name": "groceries"})["id"]

        def add(kind, date, cents, method, person=None, linked=None, merchant="", tags=()):
            shares = [{"personId": person, "amountCents": cents}] if kind == "Purchase" else []
            return api.post("/api/transactions", {
                "kind": kind, "date": date, "amountCents": cents, "paymentMethodId": method, "personId": None if kind == "Purchase" else person,
                "linkedId": linked, "merchantId": self.merchant_id(merchant), "description": "x", "note": "", "tagIds": list(tags), "shares": shares})

        # March 2025 has 31 days. Purchases on the 1st, 10th, and 31st; a refund on the 12th is not spending.
        add("Purchase", "2025-03-01", 1000, cash, me, merchant="Market")
        add("Purchase", "2025-03-01", 500, card, friend, merchant="Cafe")
        big = add("Purchase", "2025-03-10", 2000, card, me, merchant="Market", tags=[groceries])
        add("Refund", "2025-03-12", 500, card, me, linked=big["id"], merchant="Returned desk")
        add("Purchase", "2025-03-31", 100, cash, me, merchant="Market")

        page.click("#fileMenuButton")
        page.click("#refreshButton")
        page.click('.tabs [data-tab="stats"]')
        self.choose_checks(page, "#statsPeriodSelect", ["March 2025"])
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
        streaks = page.locator("#statsStreaks")
        expect(streaks).to_contain_text("Longest no-spend streak20 days (03/11/2025 – 03/30/2025)")
        expect(streaks).not_to_contain_text("Current no-spend streak")  # the period is over
        expect(streaks).to_contain_text("Longest spending streak1 day (03/01/2025)")
        # Average per day is $1.00; the 31st's $1 purchase is at it, so the run after the 10th lasts to the end.
        expect(streaks).to_contain_text("Longest streak at or under average21 days (03/11/2025 – 03/31/2025)")

        records = page.locator("#statsRecords")
        expect(records).to_contain_text("Highest day$20.00 on 03/10/2025")
        expect(records).to_contain_text("Highest week$15.00 (03/01/2025 – 03/02/2025)")  # clipped Mon 02/24 week
        expect(records).to_contain_text("Lowest full month$31.00 in March 2025")

        # Refunds count under their purchase's tag and merchant, regardless of the refund's own merchant.
        page.click('[data-stats-tab="places"]')
        tags = page.locator("#statsTagsChart")
        tags.hover(position=self.bar(page, "#statsTagsChart", "groceries"))
        expect(page.locator(".chart-tooltip")).to_contain_text("Net spent: $15.00Purchases: 1Spent: $20.00Refunds: $5.00")
        tags.hover(position=self.bar(page, "#statsTagsChart", "Untagged"))
        expect(page.locator(".chart-tooltip")).to_contain_text("Net spent: $16.00Purchases: 3Spent: $16.00Refunds: $0.00")
        merchants = page.locator("#statsMerchantsChart")
        expect(merchants).to_have_attribute("aria-label", re.compile(r"^Market: \$26\.00"))
        expect(merchants).not_to_have_attribute("aria-label", re.compile("Returned desk"))
        merchants.hover(position=self.bar(page, "#statsMerchantsChart", "Market"))
        expect(page.locator(".chart-tooltip")).to_contain_text("Visits: 3Spent: $31.00Refunds: $5.00Avg purchase: $10.33")
        # Merchant loyalty: Market's three visits fall on three days, 9 and 21 days apart (15 on average).
        expect(page.locator("#loyaltyTable tbody tr").first).to_contain_text("Market3")
        # Charts over the breakdowns, and the top merchants month by month; a merchant's bar opens its list.
        expect(page.locator("#statsMerchantsChart")).to_be_visible()
        expect(page.locator("#merchantTrendKey")).to_contain_text("Market")
        merchants.click(position=self.bar(page, "#statsMerchantsChart", "Market"))
        expect(page.locator("#scopeDialogTitle")).to_have_text("Merchant: Market")
        page.locator("#scopeDialog button", has_text="Close").click()
        expect(page.locator("#loyaltyTable tbody tr").first).to_contain_text("1 of 1")
        expect(page.locator("#loyaltyTable tbody tr").first).to_contain_text("15 days")

        # Trends: purchase sizes and the running total against February.
        page.click('[data-stats-tab="trends"]')
        expect(page.locator("#sizeTable tbody tr").first).to_contain_text("Under $10250%$6.0016.7%")  # the $5 and $1 purchases
        expect(page.locator("#sizeSummary")).to_contain_text("Median purchase$7.50")
        expect(page.locator("#runningKey .chart-key-item")).to_have_text(["March 2025", "February 2025"])
        expect(page.locator("#runningNote")).to_contain_text("By day 31: $31.00, $31.00 more than February 2025")
        # A bar opens what it stands for: in March 2025's chart, one bar per day, and March 10's opens that day.
        chart = page.locator("#statsChart")
        box = chart.bounding_box()
        slot = (box["width"] - 70 - 12) / 31  # the chart's left and right padding, then 31 days
        chart.click(position={"x": 70 + slot * 9.5, "y": box["height"] / 2})
        expect(page.locator("#dayDialogTitle")).to_contain_text("03/10/2025")
        page.locator("#dayDialog button", has_text="Close").click()

        # Heatmaps: the year grid marks March 10 darkest, and an empty day cannot be selected.
        page.click('[data-stats-tab="heatmaps"]')
        self.set_checks(page, "#heatYear", ["2025"])
        expect(page.locator('#yearHeatmap [data-date="2025-03-10"]')).to_have_class(re.compile(r"\bh4\b"))
        # Years are check boxes: two checked draw two grids, each under its year.
        this_year = str(date.today().year)
        self.set_checks(page, "#heatYear", [this_year, "2025"])
        expect(page.locator("#yearHeatmap .heatmap-title")).to_have_text([this_year, "2025"])
        expect(page.locator("#yearHeatmap .heatmap-grid")).to_have_count(2)
        # Show is check boxes too: each heatmap is drawn once per measure, under its name.
        self.set_checks(page, "#heatMeasure", ["Net spent", "Purchases"])
        expect(page.locator("#weekHeatmap .heatmap-title")).to_have_text(["Net spent", "Purchases"])
        expect(page.locator("#yearHeatmap .heatmap-title")).to_have_text([f"{this_year} · Net spent", f"{this_year} · Purchases", "2025 · Net spent", "2025 · Purchases"])
        # Select All checks every measure.
        page.click("#heatMeasure .retro-select")
        page.locator("#heatMeasure .select-all").click()
        page.keyboard.press("Escape")
        expect(page.locator("#weekHeatmap .heatmap-title")).to_have_text(["Net spent", "Spent", "Refunds", "Purchases"])
        self.set_checks(page, "#heatMeasure", ["Net spent"])
        self.set_checks(page, "#heatYear", ["2025"])
        expect(page.locator('#yearHeatmap span[data-date="2025-03-11"]')).to_have_count(1)
        expect(page.locator('#monthYearHeatmap [data-month="2025-03"]')).to_have_text("$31")
        expect(page.locator("#labelMonthHeatmap")).to_contain_text("groceries")
        self.shot(page, "stats-heatmaps")
        page.locator('#yearHeatmap button[data-date="2025-03-10"]').click()
        expect(page.locator("#dayDialogTitle")).to_contain_text("03/10/2025")
        page.locator("#dayDialog button", has_text="Close").click()

        # Compare March with February: everything in March is new.
        page.click('[data-stats-tab="compare"]')
        self.pick(page, "#compareA", "March 2025")
        self.pick(page, "#compareB", "February 2025")
        expect(page.locator("#compareTable tbody tr", has_text="Net spent")).to_contain_text("$31.00$0.00+$31.00")
        page.click('[data-stats-tab="overview"]')

        # Periods are check items: two months together count only their own days.
        self.choose_checks(page, "#statsPeriodSelect", ["March 2025", "February 2025"])
        expect(page.locator("#titleScope")).to_have_text("Stats · March 2025, February 2025")
        expect(page.locator("#statsTotals")).to_contain_text("Spent$36.00")
        expect(page.locator("#statsDaily")).to_contain_text("Days counted59 days")
        # Ten totals in two rows of five; Entries counts every type.
        expect(page.locator("#statsTotals .stat-card")).to_have_count(10)
        expect(page.locator("#statsTotals")).to_contain_text("Entries54 purchases · 1 other")
        tops = {round(card.bounding_box()["y"]) for card in page.locator("#statsTotals .stat-card").all()}
        self.assertEqual(len(tops), 2)

        # Counts: how many entries rather than how much money.
        page.click('[data-stats-tab="counts"]')
        expect(page.locator("#countSummary")).to_contain_text("Purchases4")
        expect(page.locator("#countSummary")).to_contain_text("Refunds1")
        expect(page.locator("#countBusiest")).to_contain_text("Most visited merchantMarket (3)")
        expect(page.locator("#countTimeLegend")).to_have_text("Entries per Day")
        expect(page.locator("#countTimeKey .chart-key-item")).to_have_text(["Purchases", "Refunds", "Paybacks"])
        # Charts over time switch between bars and lines, remembered in this browser.
        self.pick(page, "#chartStyleSelect", "Lines")
        page.reload()
        page.click('.tabs [data-tab="stats"]')
        expect(page.locator("#chartStyleSelect .retro-select")).to_have_text("Lines▼")
        # Stats always opens on Overview after a reload, whichever sub-tab was open before.
        expect(page.locator('[data-stats-tab="overview"]')).to_have_attribute("aria-selected", "true")
        page.click('[data-stats-tab="counts"]')
        self.shot(page, "stats-counts-lines")
        self.pick(page, "#chartStyleSelect", "Bars")
        page.click('[data-stats-tab="overview"]')
        self.shot(page, "stats-march-2025")

        # The ledger scrolls inside its frame, so its headers and Totals row stay in view, as in TaskList.
        page.set_viewport_size({"width": 1280, "height": 420})
        page.click('.tabs [data-tab="transactions"]')
        self.choose_time_frame(page, ["All time"])
        wrap = page.locator('[data-panel="transactions"] .table-wrap')
        header = page.locator("#transactionsTable thead th").first
        before = header.bounding_box()["y"]
        wrap.evaluate("el => { el.scrollTop = 200; }")
        self.assertGreater(wrap.evaluate("el => el.scrollTop"), 0)
        self.assertEqual(round(header.bounding_box()["y"]), round(before))
        footer = page.locator("#transactionsTable tfoot td").first.bounding_box()
        self.assertLessEqual(footer["y"] + footer["height"], 420)


if __name__ == "__main__":
    unittest.main()
