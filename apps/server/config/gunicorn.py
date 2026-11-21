"""Finite reviewed serving configuration; no caller-controlled forwarding trust.

External protocol callback and metadata URLs (SAML SP EntityID/ACS, SCIM resource locations)
derive canonical `https://` origins from `KODERA_PUBLIC_API_ORIGIN` / `KODERA_SAML_SP_BASE_URL`
in `config.settings.deploy`, never from client-supplied forwarding headers.
"""

import os

from config.deploy_environment import deployment

deployment(os.environ)
bind = "0.0.0.0:8000"
workers = 2
worker_class = "sync"
timeout = 30
graceful_timeout = 30
keepalive = 2
reload = False
preload_app = False
accesslog = None
errorlog = "-"
loglevel = "warning"
forwarded_allow_ips = ""
secure_scheme_headers: dict[str, str] = {}
forwarder_headers = ""
proxy_protocol = False
proxy_allow_ips = ""
worker_tmp_dir = "/dev/shm"  # noqa: S108 - private container tmpfs heartbeat files
