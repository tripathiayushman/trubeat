"""Hugging Face Space launcher for TrueBeat.

This is deliberately thin: it launches the SAME Gradio application
`trubeat serve` builds — ``trubeat.app.main`` → ``build_demo()`` — so the
Space exposes the named ``analyze_video`` endpoint (inputs: one video
FileData; outputs: the verdict JSON) and the standard ``/run`` UI
endpoint. No pipeline, threshold or verdict logic is duplicated here:
``pip install`` pulls the tool (with the committed detector bundle
packaged inside the wheel) straight from the GitHub repo, and the default
model search resolves to the packaged copy.

The app makes zero network calls while running: videos are analysed in
the Space's own container.
"""

from __future__ import annotations

import os

from trubeat.app import main as serve

if __name__ == "__main__":
    # Hugging Face expects the app to listen on 7860; PORT exists only if
    # someone redeploys the container with a different mapping.
    port = int(os.environ.get("PORT", "7860"))
    raise SystemExit(serve(["--port", str(port)]))
