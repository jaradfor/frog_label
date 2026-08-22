from __future__ import annotations

import base64
import json
import os
import sys
import traceback
from time import time
from typing import Any

import django
from django.conf import settings
from django.contrib.auth import get_user_model
from django.test import Client


def response_body(response: Any) -> bytes:
    if getattr(response, "streaming", False):
        return b"".join(response.streaming_content)
    return bytes(response.content)


def request_headers(raw: dict[str, str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for name, value in raw.items():
        normalized = name.upper().replace("-", "_")
        if normalized in {"CONTENT_LENGTH", "CONTENT_TYPE", "HOST"}:
            continue
        result[f"HTTP_{normalized}"] = value
    return result


def main() -> None:
    django.setup()
    client = Client(enforce_csrf_checks=False)
    username = os.environ.get("FROGLABEL_CE_USERNAME")
    if not username:
        raise RuntimeError("FROGLABEL_CE_USERNAME is required")
    user = get_user_model().objects.get(email=username)
    client.force_login(user, backend="django.contrib.auth.backends.ModelBackend")
    session = client.session
    session["last_login"] = time()
    session.save()
    # CE uses signed-cookie sessions in this local setup; saving changes the
    # encoded session key, so mirror it back into the test client's cookie jar.
    client.cookies[settings.SESSION_COOKIE_NAME] = session.session_key
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        message: dict[str, Any] = {}
        try:
            message = json.loads(line)
            body = base64.b64decode(message.get("body", ""))
            headers = {str(key): str(value) for key, value in message.get("headers", {}).items()}
            response = client.generic(
                str(message["method"]),
                str(message["path"]),
                data=body,
                content_type=headers.get("content-type", "application/octet-stream"),
                **request_headers(headers),
            )
            response_headers = [[name.lower(), value] for name, value in response.items()]
            response_headers.extend(
                ["set-cookie", morsel.OutputString()] for morsel in response.cookies.values()
            )
            output = {
                "id": message["id"],
                "status": response.status_code,
                "headers": response_headers,
                "body": base64.b64encode(response_body(response)).decode("ascii"),
            }
        except Exception as error:  # pragma: no cover - standalone diagnostic boundary
            output = {
                "id": message.get("id"),
                "error": f"{error}\n{traceback.format_exc()}",
            }
        print(json.dumps(output), flush=True)


if __name__ == "__main__":
    main()
