# Pinned, nonroot production WSGI image; local Compose chooses its own command.
FROM ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500 AS uv
FROM python:3.12.16-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df AS dependencies
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /build
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_PYTHON_DOWNLOADS=never UV_NO_CACHE=1
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --python python3.12

FROM scratch AS ee_src

FROM python:3.12.16-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df AS runtime
ENV PATH="/opt/venv/bin:$PATH" PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY --from=dependencies /opt/venv /opt/venv
COPY manage.py ./
COPY config/ ./config/
COPY core/ ./core/
COPY apps/ ./apps/
COPY services/ ./services/
# The tenant agent (ADR-0016) ships in the same image: `python -m tenant_agent run`.
COPY tenant_agent/ ./tenant_agent/
# So does the room-access service of Espace's audio rooms (ADR-0018): `python -m room_access`.
COPY room_access/ ./room_access/
# Enterprise Edition named context (`--build-context ee_src=ee`); empty in Community builds.
COPY --from=ee_src / /app/ee/
USER 10001:10001
CMD ["gunicorn", "--config", "config/gunicorn.py", "config.deploy_wsgi:application"]
