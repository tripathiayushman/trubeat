"""Tests for the TrueBeat browser extension (extension/).

The extension's JavaScript is exercised by tests/js/extension_test.mjs,
which loads the *shipped* files and drives the real code paths (the Gradio
API client against a live backend, the verdict mapping, the black-frame
guard, and a static privacy audit).

This wrapper runs that harness and also checks the manifest and the file
layout. It skips cleanly when Node is unavailable.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
HARNESS = ROOT / "tests" / "js" / "extension_test.mjs"

node = shutil.which("node")

needs_node = pytest.mark.skipif(node is None, reason="node is not installed")


def test_extension_layout():
    expected = [
        "manifest.json",
        "background.js",
        "offscreen.html",
        "offscreen.js",
        "popup.html",
        "popup.js",
        "options.html",
        "options.js",
        "overlay.js",
        "README.md",
    ]
    for name in expected:
        assert (EXT / name).is_file(), f"missing {name}"
    for size in (16, 32, 48, 128):
        assert (EXT / "icons" / f"icon{size}.png").is_file(), f"missing icon{size}"


def test_manifest_is_mv3_and_local_only():
    m = json.loads((EXT / "manifest.json").read_text())
    assert m["manifest_version"] == 3
    assert m["background"]["service_worker"] == "background.js"
    assert m["action"]["default_popup"] == "popup.html"
    assert m["options_page"] == "options.html"
    # The content script that draws the overlay.
    assert any(
        "overlay.js" in cs.get("js", []) for cs in m.get("content_scripts", [])
    )
    # Default permissions stay on localhost; anything else is optional.
    assert all(
        h in ("http://127.0.0.1/*", "http://localhost/*")
        for h in m["host_permissions"]
    )
    assert m["optional_host_permissions"]
    # tabCapture + offscreen are what the capture flow needs.
    for perm in ("tabCapture", "offscreen", "storage", "activeTab"):
        assert perm in m["permissions"]


def test_no_remote_code_in_html_pages():
    """MV3's CSP blocks inline scripts; every page must load a local file."""
    for name in ("popup.html", "options.html", "offscreen.html"):
        html = (EXT / name).read_text()
        for tag in html.split("<script"):
            if not tag.startswith(">"):
                continue
            body = tag[1:].split(">")[0]
            assert "src=" in body, f"{name} has an inline <script>"
            src = body.split("src=")[1].strip("\"' ")
            assert not src.startswith("http"), f"{name} loads a remote script"
            assert (EXT / src).is_file(), f"{name} references missing {src}"


@needs_node
def test_extension_javascript_suite():
    """The extension's own test harness (API client, overlay, privacy audit)."""
    proc = subprocess.run(
        [node, str(HARNESS)],
        capture_output=True,
        text=True,
        timeout=600,
        cwd=str(ROOT),
        check=False,
    )
    assert proc.returncode == 0, (
        "extension test harness failed:\n" + proc.stdout[-4000:] + proc.stderr[-2000:]
    )
    assert "0 failed" in proc.stdout, proc.stdout[-2000:]


@needs_node
def test_extension_javascript_parses():
    """Every shipped .js file must be syntactically valid."""
    for js in sorted(EXT.glob("*.js")):
        proc = subprocess.run(
            [node, "--check", str(js)], capture_output=True, text=True, check=False
        )
        assert proc.returncode == 0, f"{js.name}: {proc.stderr}"
