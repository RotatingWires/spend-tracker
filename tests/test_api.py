"""API and data-integrity tests against a real SpendTracker server. Run: python3 -m unittest discover tests"""

import hashlib
import io
import json
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path

from server import PASSWORD, ApiError, Server, build


def setUpModule():
    build()


class SpendTrackerApiTests(unittest.TestCase):
    def setUp(self):
        self.server = Server()
        self.addCleanup(self.server.stop)
        self.api = self.server.logged_in_client()
        snapshot = self.api.get("/api/snapshot")
        self.me = next(p["id"] for p in snapshot["people"] if p["isSelf"])
        self.cash, self.card, self.debit = (m["id"] for m in snapshot["paymentMethods"])
        self.alex = self.api.post("/api/people", {"name": "Alex"})["id"]

    # ------------------------------------------------------------ helpers

    def merchant_id(self, name):
        """The ID of the merchant with this name, adding it under Manage first if needed; "" means no merchant."""
        if not name:
            return None
        found = next((m["id"] for m in self.api.get("/api/snapshot")["merchants"] if m["name"] == name), None)
        return found or self.api.post("/api/merchants", {"name": name})["id"]

    def purchase(self, amount=1000, date="2026-10-01", person=None, method=None, shares=None, merchant="Store", **extra):
        """A purchase for one person (the whole amount), or split by shares=[(person, cents) or (person, cents, gift), ...]."""
        shares = [(person or self.me, amount)] if shares is None else shares
        body = {"kind": "Purchase", "date": date, "amountCents": amount, "paymentMethodId": method or self.card,
                "personId": None, "linkedId": None, "merchantId": self.merchant_id(merchant), "description": "", "note": "", "tagIds": [],
                "shares": [{"personId": share[0], "amountCents": share[1], **({"gift": True} if share[2:] == (True,) else {})} for share in shares]}
        body.update(extra)
        return self.api.post("/api/transactions", body)

    def refund(self, purchase_id, amount, person=None, date="2026-10-05", merchant="Store", **extra):
        body = {"kind": "Refund", "date": date, "amountCents": amount, "paymentMethodId": self.card,
                "personId": person or self.me, "linkedId": purchase_id, "merchantId": self.merchant_id(merchant), "description": "", "note": "", "tagIds": [], "shares": []}
        body.update(extra)
        return self.api.post("/api/transactions", body)

    def payback(self, amount, person=None, linked=None, date="2026-10-06"):
        return self.api.post("/api/transactions", {
            "kind": "Payback", "date": date, "amountCents": amount, "paymentMethodId": self.cash,
            "personId": person or self.alex, "linkedId": linked, "merchantId": None, "description": "Venmo", "note": "", "tagIds": [], "shares": []})

    @staticmethod
    def editable(tx):
        """A saved transaction as a PUT body."""
        return {k: tx[k] for k in ("kind", "date", "amountCents", "paymentMethodId", "personId", "linkedId", "merchantId", "description", "note", "tagIds", "collectionIds", "shares")}

    def assertRejected(self, call, status=400, contains=None):
        with self.assertRaises(ApiError) as context:
            call()
        self.assertEqual(context.exception.status, status, context.exception.body)
        if contains:
            self.assertIn(contains, json.dumps(context.exception.body))
        return context.exception

    def history(self):
        return self.api.get("/api/history?limit=500")["entries"]

    # ------------------------------------------------------------ auth

    def test_api_requires_login_and_wrong_password_fails(self):
        anonymous = self.server.client()
        self.assertRejected(lambda: anonymous.get("/api/snapshot"), 401)
        self.assertRejected(lambda: anonymous.post("/api/auth/login", {"password": "wrong-password"}), 401)
        self.assertRejected(lambda: anonymous.post("/api/auth/setup", {"setupToken": "x", "password": "abcdefgh", "confirmPassword": "abcdefgh"}), 409)
        status = anonymous.get("/api/auth/status")
        self.assertTrue(status["configured"])
        self.assertFalse(status["authenticated"])
        self.assertNotIn("test-password", (self.server.data_dir / "auth.json").read_text())

    def test_first_run_seeds_self_and_payment_methods(self):
        snapshot = self.api.get("/api/snapshot")
        self.assertEqual([p["name"] for p in snapshot["people"]], ["Me", "Alex"])
        self.assertEqual([m["name"] for m in snapshot["paymentMethods"]], ["Cash", "Credit Card", "Debit Card"])

    # ------------------------------------------------------------ strict requests

    def test_requests_are_strict(self):
        self.assertRejected(lambda: self.purchase(unexpected="x"), contains="unexpected")
        self.assertRejected(lambda: self.api.post("/api/transactions", raw=b"{not json"), 400)
        self.assertRejected(lambda: self.purchase(amount=0), contains="Amount")
        self.assertRejected(lambda: self.purchase(amount=None), contains="Amount is required")
        self.assertRejected(lambda: self.purchase(date="2026-02-30"), contains="real date")
        self.assertRejected(lambda: self.purchase(kind="Gift"), contains="Type must be")
        self.assertRejected(lambda: self.purchase(merchant="", description=""), contains="merchant or a description")
        self.assertRejected(lambda: self.purchase(method=999), contains="payment method")
        self.assertRejected(lambda: self.purchase(person=999), contains="person")
        self.assertRejected(lambda: self.purchase(linkedId=1), contains="cannot be linked")
        self.assertEqual(self.api.get("/api/snapshot")["transactions"], [])

    # ------------------------------------------------------------ refunds and paybacks

    def test_refunds_are_linked_capped_and_for_one_share(self):
        bought = self.purchase(amount=2000, person=self.alex)
        self.assertRejected(lambda: self.refund(None, 100, person=self.alex), contains="Choose the purchase")
        self.assertRejected(lambda: self.refund(bought["id"], 100), contains="whose share")  # Me had no share
        self.assertRejected(lambda: self.refund(bought["id"], 100, person=self.alex, date="2026-09-30"), contains="before its purchase")
        self.assertRejected(lambda: self.refund(bought["id"], 2001, person=self.alex), contains="more than")
        self.assertRejected(lambda: self.refund(bought["id"], 100, person=self.alex, tagIds=[1]), contains="Only purchases have tags")
        self.assertRejected(lambda: self.refund(bought["id"], 100, person=self.alex, shares=[{"personId": self.alex, "amountCents": 100}]), contains="Only purchases are split")
        first = self.refund(bought["id"], 1500, person=self.alex)
        self.assertEqual(first["personId"], self.alex)
        self.assertRejected(lambda: self.refund(bought["id"], 501, person=self.alex), contains="more than")
        self.refund(bought["id"], 500, person=self.alex)
        refund_of_refund = self.assertRejected(lambda: self.refund(first["id"], 1, person=self.alex))
        self.assertIn("only be linked to a purchase", json.dumps(refund_of_refund.body))

    def test_paybacks_validate_person_and_link(self):
        for_alex = self.purchase(amount=3000, person=self.alex)
        for_me = self.purchase(amount=3000)
        self.assertRejected(lambda: self.payback(100, person=self.me), contains="someone other than you")
        self.assertRejected(lambda: self.payback(100, linked=for_me["id"]), contains="had a share")
        self.assertRejected(lambda: self.payback(3001, linked=for_alex["id"]), contains="more than")
        self.refund(for_alex["id"], 1000, person=self.alex)
        self.assertRejected(lambda: self.payback(2001, linked=for_alex["id"]), contains="more than")
        self.payback(2000, linked=for_alex["id"])
        unlinked = self.payback(5000)
        self.assertIsNone(unlinked["linkedId"])

    def test_split_purchases(self):
        jordan = self.api.post("/api/people", {"name": "Jordan"})["id"]
        dinner = self.purchase(amount=3000, shares=[(self.me, 1000), (self.alex, 1200), (jordan, 800)])
        self.assertEqual(dinner["shares"], [{"personId": self.me, "amountCents": 1000, "gift": False}, {"personId": self.alex, "amountCents": 1200, "gift": False}, {"personId": jordan, "amountCents": 800, "gift": False}])
        self.assertIsNone(dinner["personId"])
        self.assertRejected(lambda: self.purchase(amount=3000, shares=[(self.me, 1000), (self.alex, 1000)]), contains="add up to $20.00")
        self.assertRejected(lambda: self.purchase(amount=2000, shares=[(self.me, 1000), (self.me, 1000)]), contains="only be on a purchase once")
        # $0.00 keeps someone on a purchase who had no part of the cost; a negative share is never valid.
        food = self.purchase(amount=2000, shares=[(self.me, 2000), (self.alex, 0)])
        self.assertEqual([(share["personId"], share["amountCents"]) for share in food["shares"]], [(self.me, 2000), (self.alex, 0)])
        self.assertRejected(lambda: self.purchase(amount=2000, shares=[(self.me, 2100), (self.alex, -100)]), contains="cannot be negative")
        self.assertRejected(lambda: self.purchase(shares=[]), contains="Choose who")
        self.assertRejected(lambda: self.purchase(personId=self.me), contains="not in personId")

        # Refunds and paybacks apply to one person's share and are capped by it.
        self.assertRejected(lambda: self.payback(1201, linked=dinner["id"]), contains="Alex's share")
        self.payback(1200, linked=dinner["id"])
        self.assertRejected(lambda: self.refund(dinner["id"], 1, person=self.alex), contains="Alex's share")
        self.refund(dinner["id"], 800, person=jordan)

        # The split can change, but never drop someone below what is linked to their share.
        base = self.editable(dinner)
        self.assertRejected(lambda: self.api.put(f"/api/transactions/{dinner['id']}", {**base, "shares": [{"personId": self.me, "amountCents": 2200}, {"personId": jordan, "amountCents": 800}]}),
                            contains="Alex has linked")
        self.assertRejected(lambda: self.api.put(f"/api/transactions/{dinner['id']}", {**base, "shares": [{"personId": self.me, "amountCents": 1100}, {"personId": self.alex, "amountCents": 1100}, {"personId": jordan, "amountCents": 800}]}),
                            contains="cannot be less")
        edited = self.api.put(f"/api/transactions/{dinner['id']}", {**base, "amountCents": 3500, "shares": [{"personId": self.me, "amountCents": 1500}, {"personId": self.alex, "amountCents": 1200}, {"personId": jordan, "amountCents": 800}]})
        self.assertEqual(edited["shares"][0], {"personId": self.me, "amountCents": 1500, "gift": False})
        self.assertRejected(lambda: self.api.delete(f"/api/people/{jordan}"), contains="Archive them instead")

    def test_purchase_edits_keep_linked_entries_valid(self):
        bought = self.purchase(amount=2000, person=self.alex)
        self.refund(bought["id"], 500, person=self.alex)
        self.payback(1000, linked=bought["id"])
        base = self.editable(bought)
        put = lambda body: self.api.put(f"/api/transactions/{bought['id']}", body)
        self.assertRejected(lambda: put({**base, "shares": [{"personId": self.alex, "amountCents": 1499}, {"personId": self.me, "amountCents": 501}]}), contains="cannot be less")
        self.assertRejected(lambda: put({**base, "shares": [{"personId": self.me, "amountCents": 2000}]}), contains="must stay on it")
        self.assertRejected(lambda: put({**base, "date": "2026-10-07"}), contains="dated before")
        self.assertRejected(lambda: put({**base, "kind": "Payback", "personId": self.alex, "shares": []}), contains="must stay a purchase")
        self.assertRejected(lambda: self.api.delete(f"/api/transactions/{bought['id']}"), contains="Delete those first")
        edited = put({**base, "amountCents": 1500, "shares": [{"personId": self.alex, "amountCents": 1500}], "merchantId": self.merchant_id("Renamed")})
        self.assertEqual((edited["amountCents"], edited["merchant"]), (1500, "Renamed"))
        self.assertIsNotNone(edited["updatedAt"])

    # ------------------------------------------------------------ history

    def test_history_records_changes_and_skips_unchanged_saves(self):
        bought = self.purchase(amount=1234)
        base = self.editable(bought)
        unchanged = self.api.put(f"/api/transactions/{bought['id']}", base)
        self.assertIsNone(unchanged["updatedAt"])
        self.api.put(f"/api/transactions/{bought['id']}", {**base, "amountCents": 999, "shares": [{"personId": self.me, "amountCents": 999}]})
        self.api.delete(f"/api/transactions/{bought['id']}")
        entries = [e for e in self.history() if e["entity"] == "Transaction"]
        self.assertEqual([e["action"] for e in entries], ["Deleted", "Edited", "Created"])
        edited = entries[1]
        self.assertEqual((edited["before"]["amountCents"], edited["after"]["amountCents"]), (1234, 999))
        self.assertIsNone(entries[0]["after"])

    def test_history_pages_by_id(self):
        for index in range(5):
            self.api.post("/api/tags", {"name": f"tag {index}"})
        first = self.api.get("/api/history?limit=2")
        self.assertTrue(first["hasMore"])
        second = self.api.get(f"/api/history?limit=2&beforeId={first['entries'][-1]['id']}")
        self.assertLess(second["entries"][0]["id"], first["entries"][-1]["id"])

    # ------------------------------------------------------------ manage

    def test_payment_methods_archive_and_delete_rules(self):
        bought = self.purchase(method=self.debit)
        self.assertRejected(lambda: self.api.delete(f"/api/payment-methods/{self.debit}"), contains="Archive it instead")
        self.api.patch(f"/api/payment-methods/{self.debit}", {"archived": True})
        self.assertRejected(lambda: self.purchase(method=self.debit), contains="archived")
        base = self.editable(bought)
        self.api.put(f"/api/transactions/{bought['id']}", {**base, "amountCents": 2000, "shares": [{"personId": self.me, "amountCents": 2000}]})
        self.api.delete(f"/api/payment-methods/{self.cash}")
        self.assertRejected(lambda: self.api.patch(f"/api/payment-methods/{self.card}", {"archived": True}), contains="at least one active")
        self.assertRejected(lambda: self.api.post("/api/payment-methods", {"name": "credit card"}), contains="already exists")
        self.assertRejected(lambda: self.api.patch(f"/api/payment-methods/{self.card}", {"name": "  "}), contains="required")

    def test_people_rules(self):
        self.assertRejected(lambda: self.api.patch(f"/api/people/{self.me}", {"archived": True}), contains="archive yourself")
        self.assertRejected(lambda: self.api.delete(f"/api/people/{self.me}"), contains="delete yourself")
        self.purchase(person=self.alex)
        self.assertRejected(lambda: self.api.delete(f"/api/people/{self.alex}"), contains="Archive them instead")
        self.api.patch(f"/api/people/{self.me}", {"name": "Sam"})
        self.assertEqual(self.api.get("/api/snapshot")["people"][0]["name"], "Sam")

    def test_deleting_a_tag_removes_it_from_purchases(self):
        food = self.api.post("/api/tags", {"name": "food"})["id"]
        gas = self.api.post("/api/tags", {"name": "gas"})["id"]
        bought = self.purchase(tagIds=[gas, food, food])
        self.assertEqual(bought["tagIds"], sorted([food, gas]))
        self.assertRejected(lambda: self.purchase(tagIds=[999]), contains="tags no longer exists")
        self.api.delete(f"/api/tags/{food}")
        self.assertEqual(self.api.get("/api/snapshot")["transactions"][0]["tagIds"], [gas])
        deleted = next(e for e in self.history() if e["entity"] == "Tag" and e["action"] == "Deleted")
        self.assertEqual(deleted["before"]["removedFromTransactions"], 1)

    def test_gift_shares(self):
        riley = self.api.post("/api/people", {"name": "Riley"})["id"]
        gift = self.purchase(amount=3000, shares=[(self.me, 1000), (self.alex, 1000, True), (riley, 1000)])
        self.assertEqual([share["gift"] for share in gift["shares"]], [False, True, False])
        self.assertRejected(lambda: self.purchase(shares=[(self.me, 1000, True)]),
                            contains="Your own share cannot be a gift")
        # A gift is not owed, so it cannot be paid back; the person who still owes can pay back their share.
        self.assertRejected(lambda: self.payback(500, person=self.alex, linked=gift["id"]), contains="was a gift")
        self.payback(500, person=riley, linked=gift["id"])
        # And a share someone already paid back toward cannot become a gift.
        shares = [{"personId": self.me, "amountCents": 1000}, {"personId": self.alex, "amountCents": 1000, "gift": True}, {"personId": riley, "amountCents": 1000, "gift": True}]
        self.assertRejected(lambda: self.api.put(f"/api/transactions/{gift['id']}", {**self.editable(gift), "shares": shares}), contains="cannot be a gift")
        # Refunds on a gift share are still allowed: the store gave the money back.
        self.refund(gift["id"], 1000, person=self.alex)

    def test_archived_tags_stay_on_purchases_but_are_not_offered(self):
        food = self.api.post("/api/tags", {"name": "food"})["id"]
        bought = self.purchase(tagIds=[food])
        archived = self.api.patch(f"/api/tags/{food}", {"archived": True})
        self.assertTrue(archived["archived"])
        self.assertRejected(lambda: self.purchase(tagIds=[food]), contains="archived")
        kept = self.api.put(f"/api/transactions/{bought['id']}", {**self.editable(bought), "note": "still tagged"})
        self.assertEqual(kept["tagIds"], [food])
        self.assertEqual(self.api.get("/api/snapshot")["tags"][0]["archived"], True)
        restored = self.api.patch(f"/api/tags/{food}", {"archived": False})
        self.assertFalse(restored["archived"])
        self.purchase(tagIds=[food])

    def test_collections_work_like_tags(self):
        trip = self.api.post("/api/collections", {"name": "Trip"})["id"]
        self.assertRejected(lambda: self.api.post("/api/collections", {"name": "trip"}), contains="already exists")
        self.assertRejected(lambda: self.api.post("/api/collections", {"name": "Trip", "startDate": "2026-10-01"}), contains="startDate")  # no dates any more
        bought = self.purchase(collectionIds=[trip])
        self.assertEqual(bought["collectionIds"], [trip])
        self.assertIn({"scope": "collection", "scopeId": trip, "number": 1}, bought["numbers"])
        self.assertRejected(lambda: self.refund(bought["id"], 100, collectionIds=[trip]), contains="Only purchases have collections")
        self.assertEqual(self.editable(bought)["collectionIds"], [trip])

        self.api.patch(f"/api/collections/{trip}", {"archived": True})
        self.assertRejected(lambda: self.purchase(collectionIds=[trip]), contains="collection is archived")
        kept = self.api.put(f"/api/transactions/{bought['id']}", {**self.editable(bought), "note": "still on the trip"})
        self.assertEqual(kept["collectionIds"], [trip])
        # Leaving collectionIds out of an edit clears them, the same as leaving out tagIds.
        cleared = self.api.put(f"/api/transactions/{bought['id']}", {k: v for k, v in self.editable(kept).items() if k != "collectionIds"})
        self.assertEqual(cleared["collectionIds"], [])

        self.assertRejected(lambda: self.api.put(f"/api/transactions/{bought['id']}", self.editable(kept)), contains="collection is archived")
        self.api.patch(f"/api/collections/{trip}", {"archived": False})
        self.api.put(f"/api/transactions/{bought['id']}", self.editable(kept))
        self.api.delete(f"/api/collections/{trip}")
        self.assertEqual(self.api.get("/api/snapshot")["transactions"][0]["collectionIds"], [])
        self.assertEqual(self.history()[0]["before"]["removedFromTransactions"], 1)
        self.assertRejected(lambda: self.api.delete(f"/api/collections/{trip}"), 404)

    # ------------------------------------------------------------ backup and restore

    def test_schema_6_database_upgrades_and_keeps_its_data(self):
        """A database from before $0.00 shares (schema 6) opens, keeps everything, and then accepts $0.00 shares."""
        purchase = self.purchase(amount=1500, shares=[(self.me, 500), (self.alex, 1000)], description="Old dinner")
        copy = Path(tempfile.mkdtemp()) / "spendtracker.db"
        with sqlite3.connect(self.server.data_dir / "spendtracker.db") as live, sqlite3.connect(copy) as target:
            live.backup(target)
        with sqlite3.connect(copy) as old:  # make it a schema 6 database again
            old.executescript("""
                PRAGMA foreign_keys = OFF;
                CREATE TABLE shares_v6 (
                    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
                    person_id INTEGER NOT NULL REFERENCES people(id),
                    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
                    gift INTEGER NOT NULL DEFAULT 0 CHECK(gift IN (0, 1)),
                    PRIMARY KEY (transaction_id, person_id));
                INSERT INTO shares_v6 SELECT transaction_id, person_id, amount_cents, gift FROM transaction_shares;
                DROP TABLE transaction_shares;
                ALTER TABLE shares_v6 RENAME TO transaction_shares;
                PRAGMA user_version = 6;""")
        upgraded = Server(prepare=lambda data: (data / "spendtracker.db").write_bytes(copy.read_bytes()))
        self.addCleanup(upgraded.stop)
        api = upgraded.logged_in_client()
        snapshot = api.get("/api/snapshot")
        kept = next(tx for tx in snapshot["transactions"] if tx["id"] == purchase["id"])
        self.assertEqual([share["amountCents"] for share in kept["shares"]], [500, 1000])
        food = api.post("/api/transactions", {**self.editable(kept), "description": "Food", "shares": [{"personId": self.me, "amountCents": 1500}, {"personId": self.alex, "amountCents": 0}]})
        self.assertEqual([share["amountCents"] for share in food["shares"]], [1500, 0])
        with sqlite3.connect(upgraded.data_dir / "spendtracker.db") as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 7)

    def test_backup_restore_round_trip_keeps_ids_links_and_history(self):
        food = self.api.post("/api/tags", {"name": "food"})["id"]
        bought = self.purchase(amount=2500, shares=[(self.me, 500), (self.alex, 2000)], tagIds=[food])
        self.refund(bought["id"], 500, person=self.alex)
        self.payback(1000, linked=bought["id"])
        trip = self.api.post("/api/collections", {"name": "Trip"})["id"]
        self.purchase(collectionIds=[trip])
        before = self.api.get("/api/snapshot")
        archive = self.api.download("/api/backup")

        with zipfile.ZipFile(io.BytesIO(archive)) as backup:
            self.assertEqual(sorted(backup.namelist()), ["manifest.json", "spendtracker.db"])
            manifest = json.loads(backup.read("manifest.json"))
            database = backup.read("spendtracker.db")
        self.assertEqual(manifest["format"], "spendtracker-backup")
        self.assertEqual(manifest["sha256"], hashlib.sha256(database).hexdigest())
        self.assertEqual(manifest["totals"]["transactions"], 4)
        self.assertEqual(manifest["totals"]["transaction_collections"], 1)
        self.assertNotIn(b"PBKDF2", database)  # the password file is never included

        self.purchase(amount=999, merchant="Added after backup")
        result = self.api.upload_zip("/api/restore", archive)
        self.assertEqual(result["transactions"], 4)
        self.assertTrue((self.server.data_dir / "backups" / result["recoveryFile"]).exists())

        restored = self.api.get("/api/snapshot")
        self.assertEqual(restored, before)
        self.assertEqual(self.history()[0]["action"], "Restored")
        # IDs keep counting past every row that ever existed rather than reusing one.
        self.assertGreater(self.purchase()["id"], 5)

        # The recovery copy is itself a valid backup of the data from just before the restore.
        recovery = (self.server.data_dir / "backups" / result["recoveryFile"]).read_bytes()
        self.api.upload_zip("/api/restore", recovery)
        self.assertIn("Added after backup", json.dumps(self.api.get("/api/snapshot")))

    def test_numbers_per_person_tag_and_merchant(self):
        food = self.api.post("/api/tags", {"name": "food"})["id"]
        first = self.purchase(shares=[(self.me, 600), (self.alex, 400)], tagIds=[food], merchant="Diner")
        second = self.purchase(person=self.alex, merchant="Diner")
        payback = self.payback(400, linked=first["id"])

        def numbers(tx):
            return {(n["scope"], n["scopeId"]): n["number"] for n in tx["numbers"]}

        self.assertEqual(second["merchant"], "Diner", "responses name the merchant as well as its ID")
        self.assertEqual(numbers(first), {("person", self.me): 1, ("person", self.alex): 1, ("tag", food): 1, ("merchant", first["merchantId"]): 1, ("method", self.card): 1})
        self.assertEqual(numbers(second), {("person", self.alex): 2, ("merchant", first["merchantId"]): 2, ("method", self.card): 2})
        self.assertEqual(numbers(payback), {("person", self.alex): 3, ("method", self.cash): 1})

        # Numbers are never reused: deleting #2 and adding another entry gives it #4, and leaving a scope drops its number.
        self.api.delete(f"/api/transactions/{second['id']}")
        third = self.purchase(person=self.alex, merchant="Diner")
        self.assertEqual(numbers(third)[("person", self.alex)], 4)
        self.assertEqual(numbers(third)[("merchant", first["merchantId"])], 3)
        untagged = self.api.put(f"/api/transactions/{first['id']}", {**self.editable(first), "tagIds": []})
        self.assertNotIn(("tag", food), numbers(untagged))
        retagged = self.api.put(f"/api/transactions/{first['id']}", {**self.editable(first), "tagIds": [food]})
        self.assertEqual(numbers(retagged)[("tag", food)], 2)
        self.assertEqual(numbers(retagged)[("person", self.alex)], 1, "unrelated numbers stay put")

        # Deleting a tag forgets its numbers, so a new tag that reuses nothing starts again at #1.
        self.api.delete(f"/api/tags/{food}")
        self.assertEqual(numbers(self.api.get("/api/snapshot")["transactions"][0]).get(("tag", food)), None)

    def test_merchants(self):
        # Merchants are added under Manage and chosen by ID, like payment methods.
        merchant = self.api.post("/api/merchants", {"name": "  Corner Shop "})["id"]
        bought = self.purchase(merchant="Corner Shop")
        self.assertEqual((bought["merchantId"], bought["merchant"]), (merchant, "Corner Shop"))
        self.assertRejected(lambda: self.purchase(merchant=None, merchantId=999), contains="no longer exists")
        self.assertRejected(lambda: self.api.post("/api/transactions", {**self.editable(bought), "merchant": "Corner Shop"}), contains="merchant")  # names are not accepted

        renamed = self.api.patch(f"/api/merchants/{merchant}", {"name": "Corner Store"})
        self.assertEqual(renamed["name"], "Corner Store")
        self.assertEqual(self.api.get("/api/snapshot")["transactions"][0]["merchant"], "Corner Store")
        self.assertRejected(lambda: self.api.post("/api/merchants", {"name": "corner store"}), contains="already exists")
        self.assertRejected(lambda: self.api.delete(f"/api/merchants/{merchant}"), contains="Archive it instead")

        self.api.patch(f"/api/merchants/{merchant}", {"archived": True})
        self.assertRejected(lambda: self.purchase(merchant=None, merchantId=merchant), contains="archived merchant")
        kept = self.api.put(f"/api/transactions/{bought['id']}", {**self.editable(bought), "note": "still fine"})
        self.assertEqual(kept["merchantId"], merchant, "an archived merchant stays on entries that already had it")

        cleared = self.api.put(f"/api/transactions/{bought['id']}", {**self.editable(bought), "merchantId": None, "description": "Snacks"})
        self.assertEqual((cleared["merchantId"], cleared["merchant"]), (None, ""))
        self.api.delete(f"/api/merchants/{merchant}")
        self.assertNotIn("Corner Store", [m["name"] for m in self.api.get("/api/snapshot")["merchants"]])
        unused = self.api.post("/api/merchants", {"name": "x" * 120})
        self.assertEqual(len(unused["name"]), 120)
        self.assertRejected(lambda: self.api.post("/api/merchants", {"name": "x" * 121}))

    def test_archived_transactions_still_count(self):
        bought = self.purchase(person=self.alex)
        archived = self.api.put(f"/api/transactions/{bought['id']}", {**self.editable(bought), "archived": True})
        self.assertTrue(archived["archived"])
        # Leaving archived out of an edit keeps the current value, and refunds can still link to it.
        edited = self.api.put(f"/api/transactions/{bought['id']}", {**self.editable(archived), "note": "edited"})
        self.assertTrue(edited["archived"])
        self.refund(bought["id"], 100, person=self.alex)
        entry = self.history()[1]
        self.assertEqual((entry["before"]["archived"], entry["after"]["archived"]), (True, True))
        restored = self.api.put(f"/api/transactions/{bought['id']}", {**self.editable(edited), "archived": False})
        self.assertFalse(restored["archived"])

    def test_restore_fills_in_missing_numbers(self):
        """A backup from before a scope existed has no numbers for it; restoring numbers its entries in date order."""
        later = self.purchase(date="2026-10-09", method=self.cash)
        earlier = self.purchase(date="2026-10-02", method=self.cash)
        archive = self.api.download("/api/backup")
        self.api.upload_zip("/api/restore", rebuild(archive, sql="DELETE FROM scope_numbers WHERE scope = 'method'; DELETE FROM scope_counters WHERE scope = 'method'"))
        numbers = {tx["id"]: {(n["scope"], n["scopeId"]): n["number"] for n in tx["numbers"]} for tx in self.api.get("/api/snapshot")["transactions"]}
        self.assertEqual((numbers[earlier["id"]][("method", self.cash)], numbers[later["id"]][("method", self.cash)]), (1, 2))
        self.assertEqual(numbers[later["id"]][("person", self.me)], 1, "numbers that were in the backup are kept")

    def test_invalid_restore_changes_nothing(self):
        bought = self.purchase(amount=1000, person=self.alex)
        self.refund(bought["id"], 100, person=self.alex)
        archive = self.api.download("/api/backup")
        before = self.api.get("/api/snapshot")

        # Data problems, re-signed so they pass the archive checks and must be caught by the data rules.
        data_cases = {
            "over-refunded": f"INSERT INTO transactions (kind, date, amount_cents, payment_method_id, person_id, linked_id, description, created_at) VALUES ('Refund', '2026-10-05', 950, 1, {self.alex}, {bought['id']}, 'x', 'x')",
            "shares off by a cent": "UPDATE transaction_shares SET amount_cents = amount_cents + 1",
            "payback for a gift": f"UPDATE transaction_shares SET gift = 1; INSERT INTO transactions (kind, date, amount_cents, payment_method_id, person_id, linked_id, description, created_at) VALUES ('Payback', '2026-10-06', 5, 1, {self.alex}, {bought['id']}, 'x', 'x')",
            "share on a refund": f"INSERT INTO transaction_shares VALUES ({bought['id'] + 1}, {self.alex}, 100, 0)",
            "refund for someone without a share": f"UPDATE transactions SET person_id = {self.me} WHERE kind = 'Refund'",
            "missing payment method": "UPDATE transactions SET payment_method_id = 42",
            "impossible date": "UPDATE transactions SET date = '2026-02-30'",
            "text amount": "UPDATE transactions SET amount_cents = 'lots'",
            "no self person": "UPDATE people SET is_self = 0",
            "collection on a refund": f"INSERT INTO collections (id, name, created_at) VALUES (9, 'x', 'x'); INSERT INTO transaction_collections VALUES ({bought['id'] + 1}, 9)",
            "tag on a refund": f"INSERT INTO tags (id, name, created_at) VALUES (9, 'x', 'x'); INSERT INTO transaction_tags VALUES ({bought['id'] + 1}, 9)",
            "blank name": "UPDATE tags SET name = ' '; INSERT INTO tags (name, created_at) VALUES ('  ', 'x')",
            "damaged history": "UPDATE history SET after_json = '{not json'",
            "payback from me": f"INSERT INTO transactions (kind, date, amount_cents, payment_method_id, person_id, description, created_at) VALUES ('Payback', '2026-10-05', 5, 1, {self.me}, 'x', 'x')",
            "missing merchant": "UPDATE transactions SET merchant_id = 99",
            "blank merchant name": "UPDATE merchants SET name = ''",
            "number for a scope it left": f"INSERT INTO scope_numbers VALUES ('tag', 5, {bought['id']}, 1); INSERT INTO scope_counters VALUES ('tag', 5, 1)",
            "number past its counter": "UPDATE scope_numbers SET number = number + 10 WHERE scope = 'merchant'",
            "unknown scope": "INSERT INTO scope_counters VALUES ('color', 1, 1)",
            "trigger": "CREATE TRIGGER evil AFTER INSERT ON tags BEGIN DELETE FROM people; END",
            "view": "CREATE VIEW extra AS SELECT 1",
            "extra table": "CREATE TABLE extra (id INTEGER)",
            "extra column": "ALTER TABLE tags ADD COLUMN color TEXT",
        }
        for name, sql in data_cases.items():
            with self.subTest(name):
                self.assertRejected(lambda: self.api.upload_zip("/api/restore", rebuild(archive, sql=sql)), 400)
                self.assertEqual(self.api.get("/api/snapshot"), before)

        archive_cases = {
            "checksum mismatch": rebuild(archive, sql="UPDATE transactions SET amount_cents = 1", resign=False),
            "wrong totals": rebuild(archive, manifest={"totals": {"transactions": 99}}),
            "wrong format": rebuild(archive, manifest={"format": "something-else"}),
            "newer app": rebuild(archive, manifest={"applicationVersion": "99.0.0"}),
            "newer schema": rebuild(archive, manifest={"schemaVersion": 8}),
            "schema 5 from v0.9": rebuild(archive, manifest={"schemaVersion": 5}),
            "schema 4 from v0.8": rebuild(archive, manifest={"schemaVersion": 4}),
            "schema 3 from v0.4": rebuild(archive, manifest={"schemaVersion": 3}),
            "schema 2 from v0.3": rebuild(archive, manifest={"schemaVersion": 2}),
            "extra member": rebuild(archive, extra={"notes.txt": b"hi"}),
            "missing database": rebuild(archive, drop="spendtracker.db"),
            "broken links": rebuild(archive, sql="PRAGMA foreign_keys=OFF; INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (9999, 9999);"),
            "old JSON backup": json.dumps({"format": "spendtracker-backup", "formatVersion": 1}).encode(),
            "random bytes": b"PK\x03\x04 definitely not a zip",
        }
        for name, data in archive_cases.items():
            with self.subTest(name):
                self.assertRejected(lambda: self.api.upload_zip("/api/restore", data), 400)
                self.assertEqual(self.api.get("/api/snapshot"), before)
        self.assertRejected(lambda: self.api.upload_zip("/api/restore", b""), 400, contains="Choose a backup")
        self.assertRejected(lambda: self.api.request("POST", "/api/restore", raw=archive, content_type="text/plain"), 400, contains="application/zip")
        self.assertFalse((self.server.data_dir / "backups").exists() and any((self.server.data_dir / "backups").iterdir()),
                         "a rejected restore must not write a recovery copy")

    # ------------------------------------------------------------ fresh start

    def fresh_start(self, **selections):
        return self.api.post("/api/fresh-start", {"confirmation": "RESET SELECTED", "selections": selections})

    def archive(self, tx):
        return self.api.put(f"/api/transactions/{tx['id']}", {**self.editable(tx), "archived": True})

    def test_fresh_start_requires_confirmation_and_valid_options(self):
        self.purchase()
        for body in [{"confirmation": "reset selected", "selections": {"history": True}},
                     {"confirmation": "RESET SELECTED", "selections": {"bogus": True}},
                     {"confirmation": "RESET SELECTED", "selections": {"history": False}},
                     {"confirmation": "RESET SELECTED"}]:
            self.assertRejected(lambda: self.api.post("/api/fresh-start", body))
        self.assertEqual(len(self.api.get("/api/snapshot")["transactions"]), 1)
        self.assertEqual(len(self.history()), 3)  # Alex, the merchant, and the purchase

    def test_fresh_start_removes_archived_entries_unless_an_active_entry_links_to_them(self):
        kept = self.archive(self.purchase(amount=2000, person=self.alex, merchant="Kept"))
        self.refund(kept["id"], 500, person=self.alex)
        gone = self.archive(self.purchase(amount=700, person=self.alex, merchant="Gone"))
        active = self.purchase(amount=900, person=self.alex, merchant="Active")
        refund = self.archive(self.refund(active["id"], 100, person=self.alex))
        summary = self.api.get("/api/fresh-start")
        self.assertEqual((summary["archivedEntries"], summary["allArchivedEntries"]), (2, 3))

        result = self.fresh_start(archivedEntries=True)
        self.assertEqual((result["removedEntries"], result["keptArchivedEntries"]), (2, 1))
        remaining = {tx["id"] for tx in self.api.get("/api/snapshot")["transactions"]}
        self.assertTrue({kept["id"], active["id"]} <= remaining)
        self.assertFalse({gone["id"], refund["id"]} & remaining)
        deleted = {entry["entityId"] for entry in self.history() if entry["action"] == "Deleted"}
        self.assertEqual(deleted, {gone["id"], refund["id"]})
        # Per-person numbers keep counting past the removed entries rather than reusing them.
        alex_numbers = [n["number"] for n in self.purchase(person=self.alex)["numbers"] if n["scope"] == "person"]
        self.assertEqual(alex_numbers, [6])

    def test_fresh_start_every_entry_and_unused_labels_keep_me_and_one_payment_method(self):
        tag = self.api.post("/api/tags", {"name": "food"})["id"]
        trip = self.api.post("/api/collections", {"name": "Trip"})["id"]
        bought = self.purchase(amount=3000, shares=[(self.me, 1000), (self.alex, 2000)], method=self.debit, tagIds=[tag], collectionIds=[trip])
        self.refund(bought["id"], 500, person=self.alex)
        self.payback(1500, linked=bought["id"])
        self.api.post("/api/people", {"name": "Unused"})
        self.assertEqual(self.api.get("/api/fresh-start")["unusedLabels"], 1)  # only "Unused": every payment method is on an entry

        result = self.fresh_start(allEntries=True, unusedLabels=True)
        self.assertEqual(result["removedEntries"], 3)
        snapshot = self.api.get("/api/snapshot")
        self.assertEqual(snapshot["transactions"], [])
        self.assertEqual([p["name"] for p in snapshot["people"]], ["Me"])
        self.assertEqual([m["name"] for m in snapshot["paymentMethods"]], ["Cash"])
        self.assertEqual((snapshot["merchants"], snapshot["tags"], snapshot["collections"]), ([], [], []))
        self.assertEqual(result["removedLabels"], 7)  # Store, food, Trip, Alex, Unused, Credit Card, Debit Card
        self.assertGreaterEqual(sum(entry["action"] == "Deleted" for entry in self.history()), 10)
        self.purchase(method=snapshot["paymentMethods"][0]["id"], merchant="New start")

    def test_fresh_start_every_label_starts_ids_over(self):
        tag = self.api.post("/api/tags", {"name": "food"})["id"]
        self.purchase(amount=3000, shares=[(self.me, 1000), (self.alex, 2000)], method=self.debit, tagIds=[tag], merchant="Store")
        self.assertEqual(self.api.get("/api/fresh-start")["allLabels"], 6)  # food, Store, Alex, and the three payment methods
        # Used labels can only go with the entries that use them.
        self.assertRejected(lambda: self.fresh_start(allLabels=True), 400, contains="every entry")

        result = self.fresh_start(allEntries=True, allLabels=True)
        self.assertEqual((result["removedEntries"], result["removedLabels"]), (1, 6))
        snapshot = self.api.get("/api/snapshot")
        self.assertEqual([p["name"] for p in snapshot["people"]], ["Me"])
        self.assertEqual([(m["id"], m["name"]) for m in snapshot["paymentMethods"]], [(1, "Cash"), (2, "Credit Card"), (3, "Debit Card")])
        # IDs and per-scope numbers start again at 1.
        self.assertEqual(self.api.post("/api/tags", {"name": "groceries"})["id"], 1)
        self.assertEqual(self.api.post("/api/merchants", {"name": "Market"})["id"], 1)
        friend = self.api.post("/api/people", {"name": "Sam"})["id"]
        self.assertEqual(friend, self.me + 1)
        first = self.purchase(amount=500, method=1, person=friend)
        self.assertEqual(first["id"], 1)
        self.assertEqual({n["scope"]: n["number"] for n in first["numbers"]}["person"], 1)

    def test_people_are_listed_me_first_then_by_name(self):
        for name in ("Zed", "adam", "Maya"):
            self.api.post("/api/people", {"name": name})
        names = [p["name"] for p in self.api.get("/api/snapshot")["people"]]
        self.assertEqual(names[0], "Me")
        self.assertEqual(names[1:], sorted(names[1:], key=str.lower))

    def test_history_search(self):
        self.purchase(merchant="Walmart", description="groceries")
        self.purchase(merchant="Gas Station", description="snacks")
        found = self.api.get("/api/history?query=walmart")["entries"]
        self.assertTrue(found and all("Walmart" in json.dumps(entry) for entry in found))
        self.assertEqual(self.api.get("/api/history?query=nothing%25like_this")["entries"], [])

    def test_fresh_start_clears_history_and_recovery_backups_and_frees_space(self):
        for index in range(60):
            self.purchase(amount=100 + index, merchant=f"Shop {index % 5}", note="n" * 1500)
        self.api.upload_zip("/api/restore", self.api.download("/api/backup"))
        summary = self.api.get("/api/fresh-start")
        self.assertEqual(summary["recoveryBackups"], 1)
        self.assertGreater(summary["historyEntries"], 60)

        result = self.fresh_start(allEntries=True, history=True, recoveryBackups=True)
        self.assertEqual((result["removedEntries"], result["removedBackups"]), (60, 1))
        self.assertTrue(result["compacted"])
        self.assertEqual(self.history(), [])  # cleared history records no Deleted entries for the removed rows
        self.assertEqual(list((self.server.data_dir / "backups").iterdir()), [])
        after = self.api.get("/api/fresh-start")
        self.assertLess(after["databaseBytes"], summary["databaseBytes"] / 2)
        self.assertGreater(result["freedBytes"], after["databaseBytes"])


class DataFolderTests(unittest.TestCase):
    """The data folder can move, and files from before the spendtracker.db rename keep working."""

    def backup_with_purchase(self):
        server = Server()
        self.addCleanup(server.stop)
        api = server.logged_in_client()
        api.post("/api/tags", {"name": "Kept tag"})
        return api.download("/api/backup")

    def test_restore_accepts_backups_with_the_old_database_name(self):
        archive = self.backup_with_purchase()
        output = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(archive)) as source, zipfile.ZipFile(output, "w") as target:
            target.writestr("manifest.json", source.read("manifest.json"))
            target.writestr("spend-tracker.db", source.read("spendtracker.db"))
        server = Server()
        self.addCleanup(server.stop)
        api = server.logged_in_client()
        api.upload_zip("/api/restore", output.getvalue())
        self.assertIn("Kept tag", [tag["name"] for tag in api.get("/api/snapshot")["tags"]])

    def test_startup_renames_the_old_database_file(self):
        with zipfile.ZipFile(io.BytesIO(self.backup_with_purchase())) as source:
            database = source.read("spendtracker.db")
        server = Server(prepare=lambda data: (data / "spend-tracker.db").write_bytes(database))
        self.addCleanup(server.stop)
        api = server.logged_in_client()
        self.assertIn("Kept tag", [tag["name"] for tag in api.get("/api/snapshot")["tags"]])
        self.assertTrue((server.data_dir / "spendtracker.db").exists())
        self.assertFalse((server.data_dir / "spend-tracker.db").exists())

    def test_data_dir_option_moves_the_data_folder(self):
        folder = tempfile.TemporaryDirectory(prefix="spend-tracker-data-")
        self.addCleanup(folder.cleanup)
        server = Server(args=["--data-dir", folder.name])
        self.addCleanup(server.stop)
        api = server.client()
        api.post("/api/auth/setup", {"setupToken": server.token, "password": PASSWORD, "confirmPassword": PASSWORD})
        self.assertTrue((Path(folder.name) / "spendtracker.db").exists())
        self.assertTrue((Path(folder.name) / "auth.json").exists())
        self.assertFalse(server.data_dir.exists())

def rebuild(archive, sql=None, manifest=None, extra=None, drop=None, resign=True):
    """Repackages a real backup ZIP after changing its database or manifest."""
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "spendtracker.db"
        with zipfile.ZipFile(io.BytesIO(archive)) as source:
            path.write_bytes(source.read("spendtracker.db"))
            fields = json.loads(source.read("manifest.json"))
        if sql:
            with sqlite3.connect(path) as connection:
                connection.executescript(sql)
            connection.close()
        database = path.read_bytes()
        if resign:
            fields["sha256"] = hashlib.sha256(database).hexdigest()
            with sqlite3.connect(path) as connection:
                fields["totals"] = {table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in fields["totals"]}
            connection.close()
        fields.update(manifest or {})
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as target:
            members = {"manifest.json": json.dumps(fields).encode(), "spendtracker.db": database, **(extra or {})}
            for member, content in members.items():
                if member != drop:
                    target.writestr(member, content)
        return output.getvalue()


if __name__ == "__main__":
    unittest.main()
