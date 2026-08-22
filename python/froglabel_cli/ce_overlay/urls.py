from django.conf import settings
from django.urls import path, re_path
from django.views.static import serve
from label_studio.core.urls import urlpatterns as label_studio_urlpatterns

from .views import ProjectCatalogView, offline_heidi_tips

urlpatterns = [
    path("heidi-tips/", offline_heidi_tips, name="froglabel-offline-heidi-tips"),
    path(
        "froglabel/api/projects/<int:project_id>/catalog/",
        ProjectCatalogView.as_view(),
        name="froglabel-project-catalog",
    ),
    *label_studio_urlpatterns,
]

if settings.FROGLABEL_SERVE_STATIC:
    urlpatterns.insert(
        0,
        re_path(
            r"^static/(?P<path>.*)$",
            serve,
            {"document_root": settings.STATIC_ROOT},
            name="froglabel-static-evidence",
        ),
    )
