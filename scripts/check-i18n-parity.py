#!/usr/bin/env python3
"""Verify every locale's translation.json has exactly the same set of keys as en.

Flags missing keys (present in en, absent in a locale) and extra keys (present
in a locale, absent in en) — the same structural-diff approach used to find the
original 149-key i18n gap. Exits non-zero if any locale has a gap.
"""
import json
import sys
from pathlib import Path

LOCALES_DIR = Path(__file__).resolve().parent.parent / "src" / "client" / "i18n" / "locales"
LOCALES = ["en", "de", "fr", "es", "ja", "pt", "it"]


def flatten(d, prefix=""):
    items = {}
    for k, v in d.items():
        path = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            items.update(flatten(v, path))
        else:
            items[path] = v
    return items


def main():
    data = {}
    for locale in LOCALES:
        path = LOCALES_DIR / locale / "translation.json"
        try:
            data[locale] = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"{locale}: INVALID JSON — {e}")
            sys.exit(1)

    flat = {locale: flatten(d) for locale, d in data.items()}
    en_keys = set(flat["en"].keys())

    had_gap = False
    for locale in LOCALES:
        if locale == "en":
            continue
        locale_keys = set(flat[locale].keys())
        missing = sorted(en_keys - locale_keys)
        extra = sorted(locale_keys - en_keys)
        if missing or extra:
            had_gap = True
            print(f"{locale}: {len(missing)} missing, {len(extra)} extra")
            for k in missing:
                print(f"  MISSING: {k}")
            for k in extra:
                print(f"  EXTRA:   {k}")
        else:
            print(f"{locale}: OK ({len(locale_keys)} keys)")

    if had_gap:
        sys.exit(1)
    print("\nAll locales have exact key parity with en.")


if __name__ == "__main__":
    main()
