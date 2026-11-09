"""Finite reviewed serving configuration; no caller-controlled forwarding trust."""

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
