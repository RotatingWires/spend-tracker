"""API and data-integrity tests against a real SpendTracker server. Run: python3 -m unittest discover tests"""

import json
import unittest

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

    def purchase(self, amount=1000, date="2026-10-01", person=None, method=None, **extra):
        body = {"kind": "Purchase", "date": date, "amountCents": amount, "paymentMethodId": method or self.card,
                "personId": person or self.me, "linkedId": None, "merchant": "Store", "description": "", "note": "", "tagIds": []}
        body.update(extra)
        return self.api.post("/api/transactions", body)

    def refund(self, purchase_id, amount, date="2026-10-05", **extra):
        body = {"kind": "Refund", "date": date, "amountCents": amount, "paymentMethodId": self.card,
                "personId": None, "linkedId": purchase_id, "merchant": "Store", "description": "", "note": "", "tagIds": []}
        body.update(extra)
        return self.api.post("/api/transactions", body)

    def payback(self, amount, person=None, linked=None, date="2026-10-06"):
        return self.api.post("/api/transactions", {
            "kind": "Payback", "date": date, "amountCents": amount, "paymentMethodId": self.cash,
            "personId": person or self.alex, "linkedId": linked, "merchant": "", "description": "Venmo", "note": "", "tagIds": []})

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

    def test_refunds_are_linked_capped_and_inherit_the_purchase_person(self):
        bought = self.purchase(amount=2000, person=self.alex)
        self.assertRejected(lambda: self.refund(None, 100), contains="Choose the purchase")
        self.assertRejected(lambda: self.refund(bought["id"], 100, personId=self.me), contains="do not set For Who")
        self.assertRejected(lambda: self.refund(bought["id"], 100, date="2026-09-30"), contains="before its purchase")
        self.assertRejected(lambda: self.refund(bought["id"], 2001), contains="more than")
        self.assertRejected(lambda: self.refund(bought["id"], 100, tagIds=[1]), contains="Only purchases have tags")
        first = self.refund(bought["id"], 1500)
        self.assertIsNone(first["personId"])
        self.assertRejected(lambda: self.refund(bought["id"], 501), contains="more than")
        self.refund(bought["id"], 500)
        refund_of_refund = self.assertRejected(lambda: self.refund(first["id"], 1))
        self.assertIn("only be linked to a purchase", json.dumps(refund_of_refund.body))

    def test_paybacks_validate_person_and_link(self):
        for_alex = self.purchase(amount=3000, person=self.alex)
        for_me = self.purchase(amount=3000)
        self.assertRejected(lambda: self.payback(100, person=self.me), contains="someone other than you")
        self.assertRejected(lambda: self.payback(100, linked=for_me["id"]), contains="same person")
        self.assertRejected(lambda: self.payback(3001, linked=for_alex["id"]), contains="more than")
        self.refund(for_alex["id"], 1000)
        self.assertRejected(lambda: self.payback(2001, linked=for_alex["id"]), contains="more than")
        self.payback(2000, linked=for_alex["id"])
        unlinked = self.payback(5000)
        self.assertIsNone(unlinked["linkedId"])

    def test_purchase_edits_keep_linked_entries_valid(self):
        bought = self.purchase(amount=2000, person=self.alex)
        self.refund(bought["id"], 500)
        self.payback(1000, linked=bought["id"])
        base = {k: bought[k] for k in ("kind", "date", "amountCents", "paymentMethodId", "personId", "linkedId", "merchant", "description", "note", "tagIds")}
        self.assertRejected(lambda: self.api.put(f"/api/transactions/{bought['id']}", {**base, "amountCents": 1499}), contains="cannot be less")
        self.assertRejected(lambda: self.api.put(f"/api/transactions/{bought['id']}", {**base, "personId": self.me}), contains="cannot change")
        self.assertRejected(lambda: self.api.put(f"/api/transactions/{bought['id']}", {**base, "date": "2026-10-07"}), contains="dated before")
        self.assertRejected(lambda: self.api.put(f"/api/transactions/{bought['id']}", {**base, "kind": "Payback", "linkedId": None}), contains="must stay a purchase")
        self.assertRejected(lambda: self.api.delete(f"/api/transactions/{bought['id']}"), contains="Delete those first")
        edited = self.api.put(f"/api/transactions/{bought['id']}", {**base, "amountCents": 1500, "merchant": "Renamed"})
        self.assertEqual((edited["amountCents"], edited["merchant"]), (1500, "Renamed"))
        self.assertIsNotNone(edited["updatedAt"])

    # ------------------------------------------------------------ history

    def test_history_records_changes_and_skips_unchanged_saves(self):
        bought = self.purchase(amount=1234)
        base = {k: bought[k] for k in ("kind", "date", "amountCents", "paymentMethodId", "personId", "linkedId", "merchant", "description", "note", "tagIds")}
        unchanged = self.api.put(f"/api/transactions/{bought['id']}", base)
        self.assertIsNone(unchanged["updatedAt"])
        self.api.put(f"/api/transactions/{bought['id']}", {**base, "amountCents": 999})
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
        base = {k: bought[k] for k in ("kind", "date", "amountCents", "paymentMethodId", "personId", "linkedId", "merchant", "description", "note", "tagIds")}
        self.api.put(f"/api/transactions/{bought['id']}", {**base, "amountCents": 2000})
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

    def test_events_validate_dates(self):
        self.assertRejected(lambda: self.api.post("/api/events", {"name": "Trip", "startDate": "2026-10-05", "endDate": "2026-10-01", "note": ""}), contains="before the start")
        self.assertRejected(lambda: self.api.post("/api/events", {"name": "", "startDate": "2026-10-01", "endDate": "2026-10-01", "note": ""}), contains="required")
        event = self.api.post("/api/events", {"name": "Trip", "startDate": "2026-10-01", "endDate": "2026-10-05", "note": "NYC"})
        moved = self.api.put(f"/api/events/{event['id']}", {"name": "Trip", "startDate": "2026-10-02", "endDate": "2026-10-05", "note": "NYC"})
        self.assertEqual(moved["startDate"], "2026-10-02")
        self.api.delete(f"/api/events/{event['id']}")
        self.assertRejected(lambda: self.api.delete(f"/api/events/{event['id']}"), 404)

    # ------------------------------------------------------------ backup and restore

    def test_backup_restore_round_trip_keeps_ids_links_and_history(self):
        food = self.api.post("/api/tags", {"name": "food"})["id"]
        bought = self.purchase(amount=2500, person=self.alex, tagIds=[food])
        self.refund(bought["id"], 500)
        self.payback(1000, linked=bought["id"])
        self.api.post("/api/events", {"name": "Trip", "startDate": "2026-10-01", "endDate": "2026-10-03", "note": ""})
        backup = self.api.get("/api/backup")
        self.assertEqual(backup["format"], "spendtracker-backup")
        self.assertNotIn("auth", json.dumps(backup).lower().replace("author", ""))

        self.purchase(amount=999, merchant="Added after backup")
        result = self.api.post("/api/restore", backup)
        self.assertEqual(result["transactions"], 3)
        self.assertTrue((self.server.data_dir / "backups" / result["recoveryFile"]).exists())

        restored = self.api.get("/api/snapshot")
        for key in ("paymentMethods", "people", "tags", "events", "transactions"):
            self.assertEqual(restored[key], backup[key], key)
        self.assertEqual(self.history()[0]["action"], "Restored")
        # IDs keep counting from the restored data rather than reusing a removed row's ID.
        self.assertGreater(self.purchase()["id"], max(t["id"] for t in backup["transactions"]))

    def test_invalid_restore_changes_nothing(self):
        bought = self.purchase(amount=1000, person=self.alex)
        backup = self.api.get("/api/backup")
        before = self.api.get("/api/snapshot")

        cases = {
            "over-refunded": lambda b: b["transactions"].append({**b["transactions"][0], "id": 99, "kind": "Refund", "personId": None, "linkedId": bought["id"], "amountCents": 1001}),
            "missing method": lambda b: b["transactions"][0].update(paymentMethodId=42),
            "duplicate ids": lambda b: b["tags"].extend([{"id": 7, "name": "a", "createdAt": "x"}, {"id": 7, "name": "b", "createdAt": "x"}]),
            "no self": lambda b: [p.update(isSelf=False) for p in b["people"]],
            "bad date": lambda b: b["transactions"][0].update(date="2026-13-01"),
            "wrong format": lambda b: b.update(format="something-else"),
            "newer app": lambda b: b.update(appVersion="99.0.0"),
        }
        for name, corrupt in cases.items():
            with self.subTest(name):
                broken = json.loads(json.dumps(backup))
                corrupt(broken)
                self.assertRejected(lambda: self.api.post("/api/restore", broken), 400)
                self.assertEqual(self.api.get("/api/snapshot"), before)
        self.assertRejected(lambda: self.api.post("/api/restore", {**backup, "extra": 1}), 400)
        self.assertRejected(lambda: self.api.post("/api/restore", {k: v for k, v in backup.items() if k != "transactions"}), 400)


if __name__ == "__main__":
    unittest.main()
