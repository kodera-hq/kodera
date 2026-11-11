"""Prepare operator-owned Community configuration without starting services."""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import uuid
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
CHECK = ROOT / 'scripts/ci/check-community-deploy.py'
spec = importlib.util.spec_from_file_location('community_check', CHECK)
check = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check
spec.loader.exec_module(check)
TEMPLATE = Path(__file__).with_name('.env.example')
WORKSPACE_TEMPLATES = json.loads(Path(__file__).with_name('workspace-templates.json').read_text())


def domain(value):
    if not isinstance(value, str) or len(value) > 253 or not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}', value):
        raise ValueError('A public lowercase DNS domain is required')
    if value.endswith(('.localhost', '.local', '.internal')):
        raise ValueError('Private hostnames are refused')
    return value


def https(value, origin=False):
    if not isinstance(value, str) or len(value) > 2048 or re.search(r'[\s\\]', value):
        raise ValueError('A public HTTPS URL is required')
    url = urlsplit(value)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.port or url.query or url.fragment:
        raise ValueError('A public HTTPS URL is required')
    domain(url.hostname)
    if origin and url.path not in ('', '/'):
        raise ValueError('OIDC origin cannot contain a path')
    return value.rstrip('/')


def generate(args):
    template_id = getattr(args, 'template', None)
    if template_id is not None and template_id not in WORKSPACE_TEMPLATES:
        raise ValueError('Invalid workspace template')
    host = domain(args.domain)
    matrix_domain = domain(getattr(args, 'matrix_domain', None) or (host.split('.', 1)[1] if host.count('.') >= 2 else host))
    if template_id == 'community' and host != 'community.' + matrix_domain:
        raise ValueError('Community host must be community.<matrix-domain>')
    issuer = https(args.oidc_issuer)
    origin = https(args.oidc_origin, True)
    if not issuer.startswith(origin + '/'):
        raise ValueError('Issuer must belong to the configured provider origin')
    if not re.fullmatch(r'[A-Za-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,63}', args.support_mailbox or ''):
        raise ValueError('A support mailbox is required')
    # Public trust material must come from the operator; never invent a trusted signing key.
    if args.trust_file and Path(args.trust_file).stat().st_size > 65_536:
        raise ValueError('Trust registry exceeds 64 KiB')
    trust = json.loads(Path(args.trust_file).read_text()) if args.trust_file else None
    if not isinstance(trust, list) or not trust or len(trust) > 8:
        raise ValueError('Provide --trust-file with the external issuer public trust registry')
    if not any(entry.get('issuer') == issuer and entry.get('lane') == 'customer' and entry.get('public_jwks', {}).get('keys') for entry in trust if isinstance(entry, dict)):
        raise ValueError('Trust registry must contain the selected customer issuer and public keys')
    trust_json = json.dumps(trust, separators=(',', ':'))
    if "'" in trust_json or any(k in trust_json for k in ['"d":', '"p":', '"q":', '"k":']):
        raise ValueError('Trust registry must contain public key material only')
    client_id = getattr(args, 'oidc_client_id', None) or 'console'
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,128}', client_id):
        raise ValueError('Invalid OIDC client identifier')
    values = dict(KODERA_OIDC_CLIENT_ID=client_id, KODERA_DOMAIN=host, KODERA_ACME_EMAIL=args.support_mailbox,
                  KODERA_MATRIX_DOMAIN=matrix_domain,
                  DJANGO_ALLOWED_HOSTS=host+',127.0.0.1', KODERA_OIDC_PROVIDER_ORIGIN=origin,
                  KODERA_AUTH_TRUST="'"+trust_json+"'")
    staff = getattr(args, 'staff_issuer', None)
    values['KODERA_STAFF_ISSUER'] = https(staff) if staff else ''
    if staff and (not staff.endswith('/realms/kodera-staff') or not any(
        entry.get('issuer') == staff and entry.get('lane') == 'staff' for entry in trust
    )):
        raise ValueError('Staff issuer must be admitted on the staff trust lane')
    values.update({key: '' for key in (*check.COMMUNITY_KEYS, *check.AGENT_SECRET_KEYS, check.SYNAPSE_OIDC_SECRET_ENV_KEY)})
    if template_id == 'community':
        if issuer != origin + '/realms/community':
            raise ValueError('Community bootstrap requires the canonical Community issuer')
        try:
            owner = str(uuid.UUID(getattr(args, 'owner_user_id', None) or ''))
        except ValueError:
            raise ValueError('Community bootstrap requires --owner-user-id of an existing user') from None
        values.update(KODERA_DEFAULT_COMMUNITY_ORG_SLUG='community',
                      KODERA_DEFAULT_COMMUNITY_ISSUER=issuer,
                      KODERA_DEFAULT_COMMUNITY_OWNER_USER_ID=owner)
        for key, option in (('KODERA_AGENT_TOKEN', 'agent_token_file'), ('KODERA_SYNAPSE_TOKEN', 'synapse_token_file'), (check.SYNAPSE_OIDC_SECRET_ENV_KEY, 'synapse_oidc_secret_file')):
            token_file = getattr(args, option, None)
            if not token_file or Path(token_file).stat().st_size > 4096:
                raise ValueError('Community bootstrap requires --' + option.replace('_', '-'))
            token = Path(token_file).read_text().strip()
            if not re.fullmatch(r'[A-Za-z0-9._~+/=-]{32,4096}', token):
                raise ValueError('Invalid issued credential file for ' + key)
            values[key] = token
    lines = []
    for line in TEMPLATE.read_text().splitlines():
        if line.startswith('#') and 'CHANGE_ME_' in line:
            continue
        if '=' in line and not line.startswith('#'):
            key, value = line.split('=', 1)
            if key in values:
                value = values[key]
            elif 'CHANGE_ME_' in value:
                value = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode() if key.endswith('SEAL_KEY') else secrets.token_hex(32)
            line = key+'='+value
        lines.append(line)
    content = '\n'.join(lines)+'\n'
    errors = check.preflight_env(TEMPLATE.read_text(), content)
    if errors:
        raise ValueError('; '.join(errors))
    target = Path(args.env_file)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(content)
    result = subprocess.run([sys.executable, str(CHECK), '--preflight', str(target)], capture_output=True, text=True, check=False)
    if result.returncode:
        target.unlink()
        raise ValueError('Generated configuration failed the Community preflight')
    if template_id is not None:
        # This is an operator-owned provisioning intent, not remote allocation.
        manifest = Path(str(target) + '.workspace-template.json')
        template = WORKSPACE_TEMPLATES[template_id]
        try:
            with manifest.open('x') as stream:
                intent = dict(templateId=template_id, channels=template['channels'],
                              roles=template['roles'], enabledConnectors=template['connectors'])
                for key in ('categories', 'readOnlyChannels', 'voiceChannels'):
                    if key in template:
                        intent[key] = template[key]
                json.dump(intent, stream, indent=2)
                stream.write('\n')
        except OSError:
            target.unlink()
            raise
    return target


def selftest():
    compose = Path(__file__).with_name('docker-compose.yml').read_text()
    assert not check.check_community_deploy(compose, TEMPLATE.read_text(), Path(__file__).with_name('Caddyfile').read_text())
    assert not check.check_synapse_policy_source(Path(__file__).with_name('configure_synapse.py').read_text())
    from configure_synapse import MODULE, configure
    configured = configure({'server_name': 'chat.example.org', 'modules': [{'module': 'operator.module'}]})
    assert configured['modules'][0] == {'module': 'operator.module'}
    assert configured['modules'][1] == {'module': MODULE, 'config': {
        'agent_user_id': '@kodera-agent:chat.example.org',
        'room_access_user_id': '@kodera-rooms:chat.example.org',
    }}
    assert configure(configured) == configured and len(configured['modules']) == 2
    community_environment = {
        'KODERA_DEFAULT_COMMUNITY_ORG_SLUG': 'community',
        'KODERA_DEFAULT_COMMUNITY_ISSUER': 'https://id.example.org/realms/community',
        'KODERA_SYNAPSE_OIDC_CLIENT_SECRET': 'synthetic-issued-token-for-test-only',
    }
    oidc = configure({'server_name': 'chat.example.org'}, community_environment)
    provider = oidc['oidc_providers'][0]
    assert provider['pkce_method'] == 'always' and provider['allow_existing_users'] is False
    assert provider['user_mapping_provider']['config']['localpart_template'] == '{{ user.sub | lower }}'
    assert oidc['password_config']['enabled'] is False and oidc['enable_registration'] is False
    assert configure(oidc, community_environment) == oidc and len(oidc['oidc_providers']) == 1
    for values in (
        dict(community_environment, KODERA_DEFAULT_COMMUNITY_ISSUER='http://id.example.org/realms/community'),
        dict(community_environment, KODERA_SYNAPSE_OIDC_CLIENT_SECRET=''),
        dict(community_environment, KODERA_DEFAULT_COMMUNITY_ORG_SLUG='other'),
    ):
        try:
            configure({'server_name': 'chat.example.org'}, values)
        except ValueError:
            pass
        else:
            raise AssertionError('Unsafe Community OIDC configuration accepted')
    try:
        configure({'server_name': 'chat.example.org', 'oidc_providers': [{'idp_id': 'unrelated'}]}, community_environment)
    except ValueError:
        pass
    else:
        raise AssertionError('Unrelated identity provider silently replaced')
    for guard in ('--no-index', 'PYTHONPATH: /tmp/kodera-policy', 'python /opt/community/configure_synapse.py /data/homeserver.yaml'):
        assert check.check_community_deploy(compose.replace(guard, 'removed'), TEMPLATE.read_text(), Path(__file__).with_name('Caddyfile').read_text())
    with tempfile.TemporaryDirectory(prefix='kodera-deploy-test-') as tmp:
        trust = Path(tmp)/'public-trust.json'
        trust.write_text(json.dumps([dict(lane='customer', issuer='https://id.example.org/realms/'+realm, public_jwks={'keys':[{'kty':'RSA','n':'public-test-modulus','e':'AQAB'}]}) for realm in ('studio', 'community')]))
        credential = Path(tmp)/'synthetic-credential.txt'
        credential.write_text('synthetic-issued-token-for-test-only')
        def args(**changes):
            data = dict(domain='chat.example.org', oidc_issuer='https://id.example.org/realms/studio', oidc_origin='https://id.example.org', support_mailbox='support@example.org', trust_file=str(trust), env_file=str(Path(tmp)/secrets.token_hex(8)))
            if changes.get('template') == 'community':
                data.update(domain='community.example.org', oidc_issuer='https://id.example.org/realms/community', owner_user_id='00000000-0000-4000-8000-000000000001', agent_token_file=str(credential), synapse_token_file=str(credential), synapse_oidc_secret_file=str(credential))
            return argparse.Namespace(**(data | changes))
        path = generate(args())
        assert 'KODERA_MATRIX_DOMAIN=example.org' in generate(args(domain='example.org')).read_text()
        assert path.stat().st_mode & 0o777 == 0o600
        content = path.read_text()
        assert 'CHANGE_ME_' not in '\n'.join(line for line in content.splitlines() if not line.startswith('#'))
        assert not check.preflight_env(TEMPLATE.read_text(), content)
        for changes in [dict(oidc_issuer='http://id.example.org/realm'), dict(domain='bad;command'), dict(oidc_origin='https://localhost'), dict(trust_file=None)]:
            try:
                generate(args(**changes))
            except ValueError:
                continue
            raise AssertionError('Invalid input accepted')
        assert check.preflight_env(TEMPLATE.read_text(), content.replace('POSTGRES_PASSWORD=', 'POSTGRES_PASSWORD=CHANGE_ME_'))
        try:
            generate(args(env_file=str(path)))
        except FileExistsError:
            pass
        else:
            raise AssertionError('Existing configuration overwritten')
        for template_id in WORKSPACE_TEMPLATES:
            configured = generate(args(template=template_id))
            manifest = json.loads(Path(str(configured) + '.workspace-template.json').read_text())
            assert manifest['templateId'] == template_id
            assert manifest['channels'] == WORKSPACE_TEMPLATES[template_id]['channels']
            if template_id == 'community':
                assert manifest['readOnlyChannels'] == ['announcements']
                assert 'KODERA_DEFAULT_COMMUNITY_ORG_SLUG=community' in configured.read_text()
        for changes in (dict(owner_user_id=None), dict(oidc_issuer='https://id.example.org/realms/studio'), dict(agent_token_file=None), dict(synapse_token_file=None), dict(matrix_domain='community.example.org')):
            try:
                generate(args(template='community', **changes))
            except ValueError:
                pass
            else:
                raise AssertionError('Invalid Community bootstrap input accepted')
        try:
            generate(args(template='unknown'))
        except ValueError:
            pass
        else:
            raise AssertionError('Unknown template accepted')
        occupied = args(template='tech-studio')
        manifest_path = Path(occupied.env_file + '.workspace-template.json')
        manifest_path.write_text('existing operator data')
        try:
            generate(occupied)
        except FileExistsError:
            assert manifest_path.read_text() == 'existing operator data'
            assert not Path(occupied.env_file).exists()
        else:
            raise AssertionError('Existing template manifest overwritten')
    print('PASS: deployment generation, Community bootstrap and refusal checks')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['env-file', 'domain', 'matrix-domain', 'oidc-issuer', 'oidc-origin', 'support-mailbox', 'trust-file', 'oidc-client-id', 'owner-user-id', 'agent-token-file', 'synapse-token-file', 'synapse-oidc-secret-file', 'staff-issuer']:
        parser.add_argument('--'+name, default='kodera-generated.conf' if name == 'env-file' else None)
    parser.add_argument('--template', choices=tuple(WORKSPACE_TEMPLATES))
    parser.add_argument('--generate-only', action='store_true')
    parser.add_argument('--preflight-only', action='store_true')
    parser.add_argument('--selftest', action='store_true')
    args = parser.parse_args()
    try:
        if args.selftest:
            selftest()
            return 0
        if args.preflight_only:
            return subprocess.run([sys.executable, str(CHECK), '--preflight', args.env_file], check=False).returncode
        target = generate(args)
        # Arguments are quoted as data for an operator to inspect before execution.
        import shlex
        print('Generated configuration with mode 0600. External OIDC issuer required.')
        if args.template:
            print('Workspace template intent: '+str(target)+'.workspace-template.json (not remotely provisioned)')
        profile = ' --profile community-governance' if args.template == 'community' else ''
        print('docker compose --env-file '+shlex.quote(str(target.resolve()))+' -f '+shlex.quote(str(Path(__file__).with_name('docker-compose.yml')))+profile+' up -d')
        return 0
    except (ValueError, OSError, TypeError) as error:
        print('Configuration refused: '+str(error).split('\n')[0], file=sys.stderr)
        return 1

if __name__ == '__main__':
    sys.exit(main())
