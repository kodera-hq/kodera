"""Issuer-bound inbox and device routes."""

from django.urls import path

from . import views

urlpatterns = [
    path("api/v1/notifications", views.inbox),
    path("api/v1/notifications/read", views.read),
    path("api/v1/push/public-key", views.public_key),
    path("api/v1/push/subscriptions/<uuid:device_id>", views.subscription),
]
