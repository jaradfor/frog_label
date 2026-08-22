# The upstream settings module consults django.conf.settings while it is still
# importing. Populate this wrapper with the exact base first so those lookups
# see a complete settings object, then force telemetry off before CE finalizes.
import os

from label_studio.core.settings.base import *  # noqa: F403

from froglabel_cli.ce_installer import INTEGRATION_VERSION

SENTRY_DSN = ""

from label_studio.core.settings.label_studio import *  # noqa: E402,F403

INSTALLED_APPS = [*INSTALLED_APPS, "froglabel_cli.ce_overlay"]  # noqa: F405
ROOT_URLCONF = "froglabel_cli.ce_overlay.urls"
FROGLABEL_CE_INTEGRATION_VERSION = INTEGRATION_VERSION
FROGLABEL_SERVE_STATIC = os.environ.get("FROGLABEL_SERVE_STATIC") == "1"

# FrogLabel fetches protected audio with the authenticated page session, then
# plays the verified bytes through a short-lived object URL. Keep the allowance
# scoped to media; scripts, frames, and connections retain Label Studio's policy.
if ENABLE_CSP:  # noqa: F405
    CSP_MEDIA_SRC = ("'self'", "blob:")
