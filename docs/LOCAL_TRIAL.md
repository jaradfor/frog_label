# Local-file trial

Start FrogLabel locally and open `http://127.0.0.1:4175/frog_label/froglabel-local/`. This route is explicit and never substitutes for a failed Label Studio integration.

1. Choose Open audio and select a WAV or MP3 (maximum 128 MiB, five minutes, two channels, 192 kHz source rate, and 30 million decoded channel-samples).
2. Add species to the initially empty local catalog and annotate using the normal workspace.
3. Choose Download annotations after decoding completes.
4. Later choose Resume annotations and then select the exact original audio when prompted.

The `.froglabel.json` is schema-versioned and bounded to 10 MiB on import. It contains export/application versions, filename/size/MIME/duration/sample rate, SHA-256 of exact file bytes, the catalog, and the canonical annotation document. It never embeds audio bytes or an upload URL.

Resume recomputes SHA-256 and blocks on mismatch even when the filename is identical. Corrupt/truncated JSON, unknown newer schema version, invalid species/document/geometry, wrong media type, or an oversized file produces a visible error and does not replace the current intact session.

All audio decode, fingerprinting, catalog edits, and JSON construction remain in the current browser tab. FrogLabel issues no network upload or telemetry request. Download annotations creates a browser download only; it is not a Label Studio export and does not imply server persistence.
