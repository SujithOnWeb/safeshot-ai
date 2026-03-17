#!/usr/bin/env python3
"""
build.py — SafeShot AI Extension Packager

Creates a distributable .zip of the Chrome extension ready for:
  • Loading as an unpacked extension
  • Uploading to the Chrome Web Store
  • Sharing with other users

Usage:
  python build.py           → creates safeshot-ai-extension-v2.0.0.zip
  python build.py --output dist/my-extension.zip
"""

import argparse
import json
import os
import zipfile
from pathlib import Path

EXTENSION_DIR = Path(__file__).parent / "extension"

# Files to include in the extension package
EXTENSION_FILES = [
    "manifest.json",
    "popup.html",
    "popup.js",
    "content.js",
    "background.js",
    "styles.css",
    "options.html",
    "options.js",
    "icon16.png",
    "icon48.png",
    "icon128.png",
]


def build(output_path: str | None = None):
    # Read version from manifest
    manifest_path = EXTENSION_DIR / "manifest.json"
    with open(manifest_path, "r") as f:
        manifest = json.load(f)
    version = manifest.get("version", "0.0.0")
    name = manifest.get("name", "extension").lower().replace(" ", "-")

    if not output_path:
        output_path = f"{name}-v{version}.zip"

    # Verify all files exist
    missing = []
    for fname in EXTENSION_FILES:
        fpath = EXTENSION_DIR / fname
        if not fpath.exists():
            missing.append(fname)

    if missing:
        print(f"⚠️  Missing files: {', '.join(missing)}")
        print("   Run 'python build.py' from the safeshot-ai/ root directory.")
        return

    # Create zip
    os.makedirs(os.path.dirname(output_path) if os.path.dirname(output_path) else ".", exist_ok=True)
    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname in EXTENSION_FILES:
            fpath = EXTENSION_DIR / fname
            zf.write(fpath, fname)
            print(f"  ✓ {fname} ({fpath.stat().st_size:,} bytes)")

    zip_size = Path(output_path).stat().st_size
    print(f"\n📦 Built: {output_path} ({zip_size:,} bytes)")
    print(f"   Version: {version}")
    print(f"   Files: {len(EXTENSION_FILES)}")
    print(f"\n🚀 Share this .zip with others!")
    print(f"   To install: Chrome → Extensions → Developer mode → Load unpacked (extract zip first)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Package SafeShot AI Chrome extension")
    parser.add_argument("--output", "-o", help="Output zip file path")
    args = parser.parse_args()
    build(args.output)
