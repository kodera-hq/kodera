#!/usr/bin/env python3
"""Django management entry point; defaults to local-only configuration."""

import os
import sys

from django.core.management import execute_from_command_line

if __name__ == "__main__":
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")
    execute_from_command_line(sys.argv)
