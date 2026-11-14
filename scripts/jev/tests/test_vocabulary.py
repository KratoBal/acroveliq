"""The heading words and the micro sign (card 7d537654, r17). A product page's headings are common words, not names,
and a unit's micro sign is no capital letter; a real name beside them still masks."""
import os
import sys
import tempfile
import unittest

_JEV = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _JEV)

_TMP = tempfile.mkdtemp()
os.environ["JEV_STORE"] = _TMP
os.environ["JEV_KNOWN_ENTITIES"] = os.path.join(_TMP, "known.json")

import redact  # noqa: E402


def red(text):
    return redact.redact(text)["text"]


class VocabularyTest(unittest.TestCase):
    def test_a_heading_word_is_kept_at_a_line_start_after_a_colon_and_beside_a_name(self):
        for text in ("Tulajdonságok: gyors hatás", "A Tulajdonságok alcím alatt:", "Jellemzők és Előnyök", "Összetétel, Használat, Adagolás, Leírás"):
            self.assertEqual(red(text), text)
        out = red("Jellemzők Kovács Péter és Összetétel Nagy Gábor")
        self.assertTrue(out.startswith("Jellemzők <PERSON_1> és Összetétel <PERSON_2>"), out)
        self.assertNotIn("Kovács", out)

    def test_a_unit_with_the_micro_sign_or_the_greek_mu_is_kept(self):
        for text in ("5 µg/l jód", "7 μg/l jód", "a µS/cm vezetés", "3 µg naponta"):
            self.assertEqual(red(text), text)

    def test_the_names_beside_them_and_a_greek_capital_name_still_mask(self):
        out = red("5 µg/l, Szabados Gábor szerint")
        self.assertNotIn("Szabados", out)
        self.assertIn("5 µg/l", out)
        out = red("Ο Παπαδόπουλος Γιώργος írta")
        self.assertNotIn("Παπαδόπουλος", out)
        self.assertNotIn("Γιώργος", out)

    def test_the_version_moved_with_the_behaviour(self):
        self.assertEqual(redact.REDACTION_VERSION, "r17")


if __name__ == "__main__":
    unittest.main()
