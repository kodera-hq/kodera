"""Core's own mail: the template catalogue, the seal and the SMTP transport.

docs/specs/OUTBOX_MAIL_SENDER.md. Nothing here imports a model, so the settings module can read the
transport and the seal key before Django is set up.
"""
