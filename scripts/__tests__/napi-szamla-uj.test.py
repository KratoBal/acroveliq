#!/usr/bin/env python3
"""What is new in the daily invoice check since yesterday (scripts/lib/napi_szamla_uj.py, acrobot 55376).

What this pins:
  1. In the full form (items joined with " ¦ ") only the items missing yesterday are named, per list, and none at all reads "nincs".
  2. An item holding a comma ("AHUW263207959 (Alza.hu Kft., 10-26)") stays one item.
  3. A list in the old ", " form with more than one item, or cut with " (+N további)", is "not comparable": named, never guessed.
  4. No yesterday file is said so; a key missing yesterday counts its every item as new.
  5. More than MAX_SHOWN new items are cut in the summary with the count of the rest.
Run: python3 -B <thisfile>   Exit 0 = all pass.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from napi_szamla_uj import MAX_SHOWN, SEP, new_since  # noqa: E402


def raw(**lists):
    """A raw file: every list in the full form (count, items)."""
    return "\n".join(f"{k}|{len(v)}|{SEP.join(v)}" for k, v in lists.items()) + "\n"


class NewSince(unittest.TestCase):
    def test_only_the_new_items_per_list(self):
        yesterday = raw(be_pdf_nincs_egyezes=["A (Telekom)", "B (Tesla)"], atnezesre_var=["X (Alza.hu Kft., 10-26)"])
        today = raw(be_pdf_nincs_egyezes=["C (OBI)", "A (Telekom)", "B (Tesla)"], atnezesre_var=["X (Alza.hu Kft., 10-26)", "Y (?, 11-16)"])
        self.assertEqual(
            new_since(today, yesterday),
            ["• Új a tegnapihoz képest: bejövő, nincs egyező PDF: C (OBI); átnézésre vár: Y (?, 11-16)"],
        )

    def test_nothing_new(self):
        same = raw(be_pdf_nincs_egyezes=["A (Telekom)"], terheles_szamla_nelkul=["2026-11-16 590360 HUF Oceans Jewels"])
        self.assertEqual(new_since(same, same), ["• Új a tegnapihoz képest: nincs"])

    def test_a_comma_inside_an_item_does_not_split_it(self):
        yesterday = raw(atnezesre_var=["AHUW263207959 (Alza.hu Kft., 10-26)"])
        today = raw(atnezesre_var=["AHUW263207959 (Alza.hu Kft., 10-26)", "26009990 (De Jong Marinelife B.V., 10-27)"])
        self.assertEqual(new_since(today, yesterday), ["• Új a tegnapihoz képest: átnézésre vár: 26009990 (De Jong Marinelife B.V., 10-27)"])

    def test_an_old_or_cut_list_is_not_compared(self):
        # yesterday's file in the old form: ", " joined, cut at 12 (the 2026-11-17 file looks like this)
        yesterday = "be_pdf_nincs_egyezes|19|A (Telekom), B (Tesla) (+17 további)\natnezesre_var|2|X (Alza.hu Kft., 10-26), Z (?, 10-21)\n"
        today = raw(be_pdf_nincs_egyezes=["A (Telekom)", "C (OBI)"], atnezesre_var=["X (Alza.hu Kft., 10-26)"])
        self.assertEqual(
            new_since(today, yesterday),
            [
                "• Új a tegnapihoz képest: nincs",
                "• Nem vethető össze: bejövő, nincs egyező PDF: a tegnapi lista régi vagy vágott alakú; átnézésre vár: a tegnapi lista régi vagy vágott alakú",
            ],
        )
        # and today's list in the old form is not split either
        old_today = "be_pdf_nincs_egyezes|2|A (Telekom), C (OBI)\n"
        self.assertEqual(new_since(old_today, raw(be_pdf_nincs_egyezes=["A (Telekom)"]))[1], "• Nem vethető össze: bejövő, nincs egyező PDF: a mai lista nem teljes alakú")

    def test_one_item_needs_no_separator(self):
        self.assertEqual(new_since("atnezesre_var|1|Y (?, 11-16)\n", "atnezesre_var|0|\n"), ["• Új a tegnapihoz képest: átnézésre vár: Y (?, 11-16)"])

    def test_no_yesterday_file_and_a_new_key(self):
        self.assertEqual(new_since(raw(atnezesre_var=["Y"]), None), ["• Új a tegnapihoz képest: a tegnapi nyers fájl nincs meg, nem vethető össze"])
        self.assertEqual(new_since(raw(be_hianyos_osszeg=["H (x)"]), raw()), ["• Új a tegnapihoz képest: hiányos összeg: H (x)"])

    def test_many_new_items_are_cut_in_the_summary(self):
        today = raw(terheles_szamla_nelkul=[f"T{i}" for i in range(MAX_SHOWN + 3)])
        line = new_since(today, raw(terheles_szamla_nelkul=[]))[0]
        self.assertTrue(line.endswith(f"T{MAX_SHOWN - 1} (+3 további)"), line)


if __name__ == "__main__":
    unittest.main()
