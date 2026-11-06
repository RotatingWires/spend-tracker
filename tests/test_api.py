"""API and data-integrity tests against a real SpendTracker server. Run: python3 -m unittest discover tests"""

import hashlib
import io
import json
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path

from server import ApiError, Server, build


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

    def purchase(self, amount=1000, date="2026-10-01", person=None, method=None, shares=None, **extra):
        """A purchase for one person (the whole amount), or split by shares=[(person, cents), ...]."""
        shares = [(person or self.me, amount)] if shares is None else shares
        body = {"kind": "Purchase", "date": date, "amountCents": amount, "paymentMethodId": method or self.card,
                "personId": None, "linkedId": None, "merchant": "Store", "description": "", "note": "", "tagIds": [],
                "shares": [{"personId": who, "amountCents": cents} for who, cents in shares]}
        body.update(extra)
        return self.api.post("/api/transactions", body)

    def refund(self, purchase_id, amount, person=None, date="2026-10-05", **extra):
        body = {"kind": "Refund", "date": date, "amountCents": amount, "paymentMethodId": self.card,
                "personId": person or self.me, "linkedId": purchase_id, "merchant": "Store", "description": "", "note": "", "tagIds": [], "shares": []}
        body.update(extra)
        return self.api.post("/api/transactions", body)

    def payback(self, amount, person=None, linked=None, date="2026-10-06"):
        return self.api.post("/api/transactions", {
            "kind": "Payback", "date": date, "amountCents": amount, "paymentMethodId": self.cash,
            "personId": person or self.alex, "linkedId": linked, "merchant": "", "description": "Venmo", "note": "", "tagIds": [], "shares": []})

    @staticmethod
    def editable(tx):
        """A saved transaction as a PUT body."""
        return {k: tx[k] for k in ("kind", "date", "amountCents", "paymentMethodId", "personId", "linkedId", "merchant", "description", "note", "tagIds", "eventIds", "shares")}

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
        self.assertEqual(dinner["shares"], [{"personId": self.me, "amountCents": 1000}, {"personId": self.alex, "amountCents": 1200}, {"personId": jordan, "amountCents": 800}])
        self.assertIsNone(dinner["personId"])
        self.assertRejected(lambda: self.purchase(amount=3000, shares=[(self.me, 1000), (self.alex, 1000)]), contains="add up to $20.00")
        self.assertRejected(lambda: self.purchase(amount=2000, shares=[(self.me, 1000), (self.me, 1000)]), contains="only be on a purchase once")
        self.assertRejected(lambda: self.purchase(amount=2000, shares=[(self.me, 2000), (self.alex, 0)]), contains="at least $0.01")
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
        self.assertEqual(edited["shares"][0], {"personId": self.me, "amountCents": 1500})
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
        edited = put({**base, "amountCents": 1500, "shares": [{"personId": self.alex, "amountCents": 1500}], "merchant": "Renamed"})
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

    def test_events_work_like_tags(self):
        trip = self.api.post("/api/events", {"name": "Trip"})["id"]
        self.assertRejected(lambda: self.api.post("/api/events", {"name": "trip"}), contains="already exists")
        self.assertRejected(lambda: self.api.post("/api/events", {"name": "Trip", "startDate": "2026-10-01"}), contains="startDate")  # no dates any more
        bought = self.purchase(eventIds=[trip])
        self.assertEqual(bought["eventIds"], [trip])
        self.assertIn({"scope": "event", "scopeId": trip, "number": 1}, bought["numbers"])
        self.assertRejected(lambda: self.refund(bought["id"], 100, eventIds=[trip]), contains="Only purchases have events")
        self.assertEqual(self.editable(bought)["eventIds"], [trip])

        self.api.patch(f"/api/events/{trip}", {"archived": True})
        self.assertRejected(lambda: self.purchase(eventIds=[trip]), contains="event is archived")
        kept = self.api.put(f"/api/transactions/{bought['id']}", {**self.editable(bought), "note": "still on the trip"})
        self.assertEqual(kept["eventIds"], [trip])
        # Leaving eventIds out of an edit clears them, the same as leaving out tagIds.
        cleared = self.api.put(f"/api/transactions/{bought['id']}", {k: v for k, v in self.editable(kept).items() if k != "eventIds"})
        self.assertEqual(cleared["eventIds"], [])

        self.assertRejected(lambda: self.api.put(f"/api/transactions/{bought['id']}", self.editable(kept)), contains="event is archived")
        self.api.patch(f"/api/events/{trip}", {"archived": False})
        self.api.put(f"/api/transactions/{bought['id']}", self.editable(kept))
        self.api.delete(f"/api/events/{trip}")
        self.assertEqual(self.api.get("/api/snapshot")["transactions"][0]["eventIds"], [])
        self.assertEqual(self.history()[0]["before"]["removedFromTransactions"], 1)
        self.assertRejected(lambda: self.api.delete(f"/api/events/{trip}"), 404)

    # ------------------------------------------------------------ backup and restore

    def test_backup_restore_round_trip_keeps_ids_links_and_history(self):
        food = self.api.post("/api/tags", {"name": "food"})["id"]
        bought = self.purchase(amount=2500, shares=[(self.me, 500), (self.alex, 2000)], tagIds=[food])
        self.refund(bought["id"], 500, person=self.alex)
        self.payback(1000, linked=bought["id"])
        trip = self.api.post("/api/events", {"name": "Trip"})["id"]
        self.purchase(eventIds=[trip])
        before = self.api.get("/api/snapshot")
        archive = self.api.download("/api/backup")

        with zipfile.ZipFile(io.BytesIO(archive)) as backup:
            self.assertEqual(sorted(backup.namelist()), ["manifest.json", "spend-tracker.db"])
            manifest = json.loads(backup.read("manifest.json"))
            database = backup.read("spend-tracker.db")
        self.assertEqual(manifest["format"], "spendtracker-backup")
        self.assertEqual(manifest["sha256"], hashlib.sha256(database).hexdigest())
        self.assertEqual(manifest["totals"]["transactions"], 4)
        self.assertEqual(manifest["totals"]["transaction_events"], 1)
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
        second = self.purchase(person=self.alex, merchant="diner")
        payback = self.payback(400, linked=first["id"])

        def numbers(tx):
            return {(n["scope"], n["scopeId"]): n["number"] for n in tx["numbers"]}

        self.assertEqual(second["merchantId"], first["merchantId"], "merchant names match ignoring case")
        self.assertEqual(second["merchant"], "Diner", "the first spelling is kept")
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
        bought = self.purchase(merchant="  Corner Shop ")
        merchant = bought["merchantId"]
        self.assertEqual(bought["merchant"], "Corner Shop")
        self.assertEqual([m["name"] for m in self.api.get("/api/snapshot")["merchants"]], ["Corner Shop"])
        self.assertEqual(self.history()[1]["entity"], "Merchant", "typing a new merchant records it before the transaction")

        renamed = self.api.patch(f"/api/merchants/{merchant}", {"name": "Corner Store"})
        self.assertEqual(renamed["name"], "Corner Store")
        self.assertEqual(self.api.get("/api/snapshot")["transactions"][0]["merchant"], "Corner Store")
        self.assertRejected(lambda: self.api.post("/api/merchants", {"name": "corner store"}), contains="already exists")
        self.assertRejected(lambda: self.api.delete(f"/api/merchants/{merchant}"), contains="Archive it instead")

        self.api.patch(f"/api/merchants/{merchant}", {"archived": True})
        self.assertRejected(lambda: self.purchase(merchant="Corner Store"), contains="archived merchant")
        kept = self.api.put(f"/api/transactions/{bought['id']}", {**self.editable(bought), "merchant": "Corner Store", "note": "still fine"})
        self.assertEqual(kept["merchantId"], merchant, "an archived merchant stays on entries that already had it")

        cleared = self.api.put(f"/api/transactions/{bought['id']}", {**self.editable(bought), "merchant": "", "description": "Snacks"})
        self.assertIsNone(cleared["merchantId"])
        self.api.delete(f"/api/merchants/{merchant}")
        self.assertEqual(self.api.get("/api/snapshot")["merchants"], [])
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
            "share on a refund": f"INSERT INTO transaction_shares VALUES ({bought['id'] + 1}, {self.alex}, 100)",
            "refund for someone without a share": f"UPDATE transactions SET person_id = {self.me} WHERE kind = 'Refund'",
            "missing payment method": "UPDATE transactions SET payment_method_id = 42",
            "impossible date": "UPDATE transactions SET date = '2026-02-30'",
            "text amount": "UPDATE transactions SET amount_cents = 'lots'",
            "no self person": "UPDATE people SET is_self = 0",
            "event on a refund": f"INSERT INTO events (id, name, created_at) VALUES (9, 'x', 'x'); INSERT INTO transaction_events VALUES ({bought['id'] + 1}, 9)",
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
            "newer schema": rebuild(archive, manifest={"schemaVersion": 5}),
            "schema 3 from v0.4": rebuild(archive, manifest={"schemaVersion": 3}),
            "schema 2 from v0.3": rebuild(archive, manifest={"schemaVersion": 2}),
            "extra member": rebuild(archive, extra={"notes.txt": b"hi"}),
            "missing database": rebuild(archive, drop="spend-tracker.db"),
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


def rebuild(archive, sql=None, manifest=None, extra=None, drop=None, resign=True):
    """Repackages a real backup ZIP after changing its database or manifest."""
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "spend-tracker.db"
        with zipfile.ZipFile(io.BytesIO(archive)) as source:
            path.write_bytes(source.read("spend-tracker.db"))
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
            members = {"manifest.json": json.dumps(fields).encode(), "spend-tracker.db": database, **(extra or {})}
            for member, content in members.items():
                if member != drop:
                    target.writestr(member, content)
        return output.getvalue()


if __name__ == "__main__":
    unittest.main()
