"""Self-contained `#proximity` API route table."""

from django.urls import path

from . import views

urlpatterns = [
    path("api/v1/proximity/bootstrap", views.bootstrap),
    path("api/v1/proximity/checkin", views.checkin),
    path("api/v1/proximity/resolve", views.resolve),
    path("api/v1/proximity/nearby", views.nearby),
    path("api/v1/proximity/checkout", views.checkout),
]
