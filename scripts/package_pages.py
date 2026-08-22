"""Create a byte-reproducible GitHub Pages artifact and SHA-256 manifest."""

from __future__ import annotations

import hashlib
import json
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "build" / "pages"
OUTPUT_DIRECTORY = ROOT / "artifacts" / "github-pages"
ARCHIVE = OUTPUT_DIRECTORY / "froglabel-pages-static.zip"
MANIFEST = OUTPUT_DIRECTORY / "froglabel-pages-static.manifest.json"
FIXED_ZIP_TIME = (2020, 1, 1, 0, 0, 0)


class _AssetReferenceParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.references: list[str] = []

    def handle_starttag(self, _tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.references.extend(
            value for name, value in attrs if name in {"src", "href"} and value is not None
        )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_static_tree() -> None:
    parser = _AssetReferenceParser()
    parser.feed((SOURCE / "index.html").read_text(encoding="utf-8"))
    resolved: set[str] = set()
    for reference in parser.references:
        split = urlsplit(reference)
        if split.scheme or split.netloc or reference.startswith("//"):
            raise SystemExit(f"Pages index contains an external runtime asset: {reference}")
        path = split.path
        if not path or path.startswith("data:") or path.startswith("#"):
            continue
        prefix = "/frog_label/"
        relative = path[len(prefix) :] if path.startswith(prefix) else path.lstrip("./")
        candidate = (SOURCE / relative).resolve()
        source_root = SOURCE.resolve()
        if source_root not in candidate.parents or not candidate.is_file():
            raise SystemExit(f"Pages index reference is missing from the artifact: {reference}")
        resolved.add(candidate.relative_to(source_root).as_posix())

    entry_assets = sorted(
        path.relative_to(SOURCE).as_posix()
        for pattern in ("assets/index-*.js", "assets/index-*.css")
        for path in SOURCE.glob(pattern)
    )
    orphaned = [asset for asset in entry_assets if asset not in resolved]
    if orphaned:
        raise SystemExit(f"Pages artifact contains unreferenced entry assets: {orphaned}")
    if (SOURCE / "fake-host").exists():
        raise SystemExit("Pages artifact contains the development-only fake-host route")


def main() -> None:
    if not (SOURCE / "index.html").is_file():
        raise SystemExit("build/pages is missing; run npm run build:pages first")
    validate_static_tree()

    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    files = sorted(path for path in SOURCE.rglob("*") if path.is_file())
    manifest = {
        "artifact": ARCHIVE.name,
        "basePath": "/frog_label/",
        "files": [
            {
                "path": path.relative_to(SOURCE).as_posix(),
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
            }
            for path in files
        ],
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    with ZipFile(ARCHIVE, "w", ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            relative = path.relative_to(SOURCE).as_posix()
            info = ZipInfo(relative, FIXED_ZIP_TIME)
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes(), compresslevel=9)

    print(f"Packaged {ARCHIVE.relative_to(ROOT)} ({sha256(ARCHIVE)})")


if __name__ == "__main__":
    main()
