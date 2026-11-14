"""The originals the redactor can hand back (card 7d537654): a caller that must put the originals back into an
ANSWER to the redacted text gets {placeholder: original}; the redacted text is the same with or without it, and
nothing of it reaches the return value."""
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

TEXT = ("Kovács Péter kérdezte, hogy az aquacalculator.com mit mond. Kovács Péternek is írtam. "
        "Az e-mailje kovacs.peter@pelda.hu, a telefonja +36 30 123 4567.")


class OriginalsTest(unittest.TestCase):
    def test_the_redacted_text_is_the_same_with_and_without_originals(self):
        plain = redact.redact(TEXT)
        originals = {}
        with_originals = redact.redact(TEXT, originals=originals)
        self.assertEqual(plain, with_originals)
        self.assertEqual(set(with_originals), {"text", "version", "counts"})

    def test_every_placeholder_in_the_text_has_its_original_and_putting_them_back_gives_the_input(self):
        originals = {}
        r = redact.redact(TEXT, originals=originals)
        import re
        placeholders = set(re.findall(r"<[A-Z_]+_\d+>", r["text"]))
        self.assertEqual(placeholders, set(originals))
        self.assertIn("aquacalculator.com", originals.values())
        self.assertIn("kovacs.peter@pelda.hu", originals.values())
        person = sorted(v for k, v in originals.items() if k.startswith("<PERSON_"))
        self.assertEqual(person, ["Kovács Péter", "Kovács Péternek"])
        back = r["text"]
        for placeholder, original in originals.items():
            back = back.replace(placeholder, original)
        self.assertEqual(back, TEXT)

    def test_no_originals_dict_no_change_in_the_call(self):
        self.assertEqual(redact.redact("Szia, ez egy sima mondat."), redact.redact("Szia, ez egy sima mondat.", originals=None))
        originals = {}
        redact.redact("Szia, ez egy sima mondat.", originals=originals)
        self.assertEqual(originals, {})

    def test_the_originals_never_enter_the_result(self):
        originals = {}
        r = redact.redact(TEXT, originals=originals)
        flat = repr(r)
        for original in originals.values():
            self.assertNotIn(original, flat)


if __name__ == "__main__":
    unittest.main()
