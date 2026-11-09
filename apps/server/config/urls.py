"""Only explicitly implemented diagnostics are routed."""

from django.urls import path

from core.health import live, ready

urlpatterns = [path("health/live", live), path("health/ready", ready)]
