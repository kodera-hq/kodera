"""Live, uncached Core authority and a narrow Matrix guest request surface."""

import re
from urllib.parse import unquote, urlsplit


def valid_origin(value):
    if not isinstance(value, str):
        return False
    parsed = urlsplit(value)
    return bool(parsed.scheme == 'https' and parsed.hostname and not parsed.username
                and not parsed.password and parsed.path in ('', '/') and not parsed.query
                and not parsed.fragment and value.rstrip('/') == f'https://{parsed.netloc}')


class Authority:
    def __init__(self, api, origin, token):
        self.api, self.origin, self.token = api, origin.rstrip('/'), token

    async def decide(self, user, room, action):
        try:
            result = await self.api.http_client.get_json(
                self.origin + '/agent/v1/channel-authority',
                args={'user_id': user, 'room_id': room, 'action': action},
                headers={'Authorization': ['Bearer ' + self.token]},
            )
            if (not isinstance(result, dict) or type(result.get('allowed')) is not bool
                    or not isinstance(result.get('role'), str)
                    or type(result.get('revision')) is not int):
                return {'allowed': False, 'role': 'none'}
            return result
        except Exception:
            # An outage must never reuse a previously positive decision.
            return {'allowed': False, 'role': 'none'}


def guest_request(path, method):
    """Return (room, action) for a guest-safe request, or None. Decode exactly once."""
    if method not in {'GET', 'POST', 'PUT'} or not isinstance(path, str):
        return None
    path = path.partition('?')[0]
    if '%' in unquote(path) or '..' in unquote(path) or '\\' in path:
        return None
    if method == 'GET' and path in {
        '/_matrix/client/v3/account/whoami',
        '/_matrix/client/versions', '/_matrix/client/v3/devices',
    }:
        return '', 'session'
    match = re.fullmatch(r'/_matrix/client/v3/rooms/([^/]+)/(messages|state|members|joined_members|event/[^/]+|send/[^/]+/[^/]+|receipt/[^/]+/[^/]+|typing/[^/]+|join|leave)', path)
    if match is None:
        return None
    room, suffix = unquote(match[1]), match[2]
    if '/' in room or not room.startswith('!'):
        return None
    if method == 'GET' and suffix in {'messages', 'state', 'members', 'joined_members'}:
        return room, 'event'
    if method == 'GET' and suffix.startswith('event/'):
        return room, 'event'
    if method in {'PUT', 'POST'} and suffix.startswith(('send/', 'receipt/', 'typing/')):
        return room, 'event'
    if method == 'POST' and suffix in {'join', 'leave'}:
        return room, 'join'
    return None


def public_request(path, method):
    if not isinstance(path, str):
        return False
    path = path.partition('?')[0]
    # Synapse validates the signed logout_token; no Matrix bearer token is sent.
    if method == 'POST' and path == '/_synapse/client/oidc/backchannel_logout':
        return True
    if method == 'GET' and (
        path == '/_synapse/client/oidc/callback'
        or re.fullmatch(r'/_matrix/client/v3/login/sso/redirect(?:/[A-Za-z0-9_-]+)?', path)
    ):
        return True
    return (path == '/_matrix/client/versions' and method == 'GET'
            or path == '/_matrix/client/v3/login' and method in {'GET', 'POST'}
            or path == '/_matrix/client/v3/refresh' and method == 'POST')


class EventView:
    """A decision-only view; never rewrites or persists a Matrix event."""

    def __init__(self, source, *, sender, content=None):
        self.source, self.sender = source, sender
        self.content = source.content if content is None else content

    def __getattr__(self, name):
        return getattr(self.source, name)
