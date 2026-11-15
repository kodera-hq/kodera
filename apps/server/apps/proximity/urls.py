"""Dedicated self-contained URLconf mount for ephemeral `#proximity` endpoints."""

from .api.urls import urlpatterns as urlpatterns

handler404 = "core.api.errors.not_found"
handler500 = "core.api.errors.server_error"
