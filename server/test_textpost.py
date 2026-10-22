"""Regression cases for textpost.remove_fillers.

Run: .venv/bin/python test_textpost.py  (or with pytest)
Every case here was either a real bug or guards against one.
"""

from textpost import remove_fillers

# (input, expected output) — None means: stays unchanged.
CASES = [
    # Meaning that used to get lost
    ("Die Platte ist 5 mm dick.", None),
    ("Angabe in mm bitte.", None),
    ("Die Frau, die die Tür öffnet, ist da.", None),
    ("Er sagte, dass das das Beste ist.", None),
    ("Das, was er hat, hat er verdient.", None),
    ("Die Nummer ist 11 11.", None),
    ("Ich komme um 5 Uhr.", None),
    ("Ja. Ja.", None),
    ("Hmm. Ich weiß nicht.", None),
    ("Das ist äh sehr sehr gut.", "Das ist sehr sehr gut."),
    # What should still be removed
    ("Ich ich wollte das sagen.", "Ich wollte das sagen."),
    ("Wir wir haben äh das gemacht.", "Wir haben das gemacht."),
    ("Das ist hmm schwierig.", "Das ist schwierig."),
    ("the the the cat", "the cat"),
]


def test_cases():
    for text, expected in CASES:
        assert remove_fillers(text, "de") == (expected or text), text


if __name__ == "__main__":
    failed = 0
    for text, expected in CASES:
        result = remove_fillers(text, "de")
        if result != (expected or text):
            failed += 1
            print(f"FAIL {text!r} -> {result!r}, expected {expected or text!r}")
    print(f"{len(CASES) - failed}/{len(CASES)} ok")
    raise SystemExit(1 if failed else 0)
