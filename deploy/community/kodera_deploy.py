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
# A template keeps every identifier it ever had: `crisis-cell` selects `proximity`, permanently.
TEMPLATE_ALIASES = {alias: template_id for template_id, template in WORKSPACE_TEMPLATES.items() for alias in template.get('aliases', ())}
if set(TEMPLATE_ALIASES) & set(WORKSPACE_TEMPLATES) or TEMPLATE_ALIASES.get('crisis-cell') != 'proximity':
    raise RuntimeError('workspace-templates.json must keep crisis-cell as an alias of proximity')


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


TOPOLOGIES = ('single', 'split')


def split_origins(host, matrix_domain):
    """The public origins of the split topology (README.md, "Topologies"); the web client is hosted elsewhere."""
    return {'web': 'https://' + host, 'api': 'https://api.' + matrix_domain,
            'matrix': 'https://matrix.' + host, 'livekit': 'wss://livekit.' + host}


def compose_command(target, template_id, topology):
    """The exact command an operator runs, arguments quoted as data to inspect before execution."""
    import shlex
    base = Path(__file__).with_name('docker-compose.yml')
    files = [base] + ([base.with_name('docker-compose.split.yml')] if topology == 'split' else [])
    profile = ' --profile community-governance' if template_id == 'community' else ''
    return ('docker compose --env-file ' + shlex.quote(str(target)) + ''.join(' -f ' + shlex.quote(str(path)) for path in files)
            + profile + ' up -d')


def generate(args):
    topology = getattr(args, 'topology', None) or 'single'
    if topology not in TOPOLOGIES:
        raise ValueError('Topology must be single or split')
    template_id = getattr(args, 'template', None)
    template_id = TEMPLATE_ALIASES.get(template_id, template_id)
    if template_id is not None and template_id not in WORKSPACE_TEMPLATES:
        raise ValueError('Invalid workspace template')
    host = domain(args.domain)
    matrix_domain = domain(getattr(args, 'matrix_domain', None) or (host.split('.', 1)[1] if host.count('.') >= 2 else host))
    if template_id == 'community' and host != 'community.' + matrix_domain:
        raise ValueError('Community host must be community.<matrix-domain>')
    allowed_hosts = host + ',127.0.0.1'
    if topology == 'split':
        # The web client keeps its own host; the API moves to api.<matrix-domain>.
        if not host.endswith('.' + matrix_domain):
            raise ValueError('Split topology needs a web client host below the Matrix domain')
        allowed_hosts = domain('api.' + matrix_domain) + ',127.0.0.1'
        domain('matrix.' + host)
        domain('livekit.' + host)
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
                  DJANGO_ALLOWED_HOSTS=allowed_hosts, KODERA_TOPOLOGY=topology, KODERA_OIDC_PROVIDER_ORIGIN=origin,
                  KODERA_AUTH_TRUST="'"+trust_json+"'")
    staff = getattr(args, 'staff_issuer', None)
    values['KODERA_STAFF_ISSUER'] = https(staff) if staff else ''
    if staff and (not staff.endswith('/realms/kodera-staff') or not any(
        entry.get('issuer') == staff and entry.get('lane') == 'staff' for entry in trust
    )):
        raise ValueError('Staff issuer must be admitted on the staff trust lane')
    values.update({key: '' for key in (*check.COMMUNITY_KEYS, *check.AGENT_ENV_NAMES, check.SYNAPSE_OIDC_ENV_NAME,
                                       check.SYNAPSE_OIDC_ISSUER_ENV_NAME, check.FEDERATION_ENV_NAME)})

    def issued(key, option):
        token_file = getattr(args, option, None)
        if not token_file or Path(token_file).stat().st_size > 4096:
            raise ValueError('An issued credential file is required: --' + option.replace('_', '-'))
        token = Path(token_file).read_text().strip()
        if not re.fullmatch(r'[A-Za-z0-9._~+/=-]{32,4096}', token):
            raise ValueError('Invalid issued credential file for ' + key)
        return token
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
        for key, option in (('KODERA_AGENT_TOKEN', 'agent_token_file'), ('KODERA_SYNAPSE_TOKEN', 'synapse_token_file'), (check.SYNAPSE_OIDC_ENV_NAME, 'synapse_oidc_secret_file')):
            values[key] = issued(key, option)
    elif getattr(args, 'synapse_oidc_secret_file', None):
        # An isolated self-host signs members in to Synapse with the realm it already trusts.
        values[check.SYNAPSE_OIDC_ISSUER_ENV_NAME] = issuer
        values[check.SYNAPSE_OIDC_ENV_NAME] = issued(check.SYNAPSE_OIDC_ENV_NAME, 'synapse_oidc_secret_file')
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
    assert not check.check_synapse_config(Path(__file__).with_name('configure_synapse.py').read_text())
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
    hardened = configure({'server_name': 'chat.example.org', 'listeners': [{'type': 'http', 'resources': [{'names': ['client', 'federation']}]}]})
    assert hardened['database']['name'] == 'psycopg2' and 'password' not in hardened['database']['args']
    assert hardened['federation_domain_whitelist'] == [] and hardened['listeners'][0]['resources'][0]['names'] == ['client']
    assert hardened['password_config'] == {'enabled': False} and 'oidc_providers' not in hardened
    assert check.check_community_deploy(compose, TEMPLATE.read_text(), Path(__file__).with_name('Caddyfile').read_text().replace('/api/* /health/*', '/api/* /health/* /agent/*'))
    override = Path(__file__).with_name('docker-compose.split.yml').read_text()
    split_caddyfile = Path(__file__).with_name('Caddyfile.split').read_text()
    assert not check.check_split_topology(override, split_caddyfile, TEMPLATE.read_text())
    assert check.check_split_topology(override, split_caddyfile.replace('/api/* /health/*', '/api/* /health/* /agent/*'), TEMPLATE.read_text())
    assert check.check_split_topology(override, split_caddyfile.replace('/_synapse/client/*', '/_synapse/client/* /_matrix/federation/*'), TEMPLATE.read_text())
    assert check.check_split_topology(override.replace('profiles: [single-origin-web]', 'profiles: [default]'), split_caddyfile, TEMPLATE.read_text())
    split_environment = {'KODERA_TOPOLOGY': 'split', 'KODERA_COMPOSE_TOPOLOGY': 'split'}
    split_homeserver = configure({'server_name': 'community.example.org'}, split_environment)
    assert split_homeserver['public_baseurl'] == 'https://matrix.community.example.org/'
    split_signed = configure({'server_name': 'community.example.org'}, dict(community_environment, KODERA_DEFAULT_COMMUNITY_ISSUER='https://id.example.org/realms/community', **split_environment))
    assert split_signed['public_baseurl'] == 'https://matrix.community.example.org/'
    assert split_signed['sso']['client_whitelist'] == ['https://community.example.org/']
    for values in ({'KODERA_TOPOLOGY': 'split'}, {'KODERA_COMPOSE_TOPOLOGY': 'split'}, {'KODERA_TOPOLOGY': 'both', 'KODERA_COMPOSE_TOPOLOGY': 'both'}):
        try:
            configure({'server_name': 'community.example.org'}, values)
        except ValueError:
            pass
        else:
            raise AssertionError('Topology mismatch accepted')
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
        assert 'KODERA_SYNAPSE_OIDC_ISSUER=\n' in path.read_text() and 'KODERA_MATRIX_FEDERATION_ALLOWLIST=\n' in path.read_text()
        signed_in = generate(args(synapse_oidc_secret_file=str(credential))).read_text()
        assert 'KODERA_SYNAPSE_OIDC_ISSUER=https://id.example.org/realms/studio\n' in signed_in
        assert 'KODERA_SYNAPSE_OIDC_CLIENT_SECRET=synthetic-issued-token-for-test-only\n' in signed_in
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
        # Topologies: `single` stays the default; `split` admits the API host and is refused where
        # its origins cannot exist.
        single = generate(args()).read_text()
        assert 'KODERA_TOPOLOGY=single\n' in single and 'DJANGO_ALLOWED_HOSTS=chat.example.org,127.0.0.1\n' in single
        split = generate(args(topology='split')).read_text()
        assert 'KODERA_TOPOLOGY=split\n' in split and 'DJANGO_ALLOWED_HOSTS=api.example.org,127.0.0.1\n' in split
        assert 'KODERA_DOMAIN=chat.example.org\n' in split and not check.preflight_env(TEMPLATE.read_text(), split)
        community_split = generate(args(template='community', topology='split')).read_text()
        assert 'KODERA_DOMAIN=community.example.org\n' in community_split
        assert 'DJANGO_ALLOWED_HOSTS=api.example.org,127.0.0.1\n' in community_split
        assert not check.preflight_env(TEMPLATE.read_text(), community_split)
        for changes in (dict(topology='both'), dict(topology='Split'), dict(topology='split', domain='example.org')):
            try:
                generate(args(**changes))
            except ValueError:
                pass
            else:
                raise AssertionError('Invalid topology accepted')
        base = Path(__file__).with_name('docker-compose.yml')
        assert compose_command(Path('/srv/kodera.conf'), None, 'single') == 'docker compose --env-file /srv/kodera.conf -f ' + str(base) + ' up -d'
        assert compose_command(Path('/srv/kodera.conf'), 'community', 'split') == (
            'docker compose --env-file /srv/kodera.conf -f ' + str(base) + ' -f ' + str(base.with_name('docker-compose.split.yml'))
            + ' --profile community-governance up -d')
        assert split_origins('community.example.org', 'example.org') == {
            'web': 'https://community.example.org', 'api': 'https://api.example.org',
            'matrix': 'https://matrix.community.example.org', 'livekit': 'wss://livekit.community.example.org'}
        aliased = generate(args(template='crisis-cell'))
        manifest = json.loads(Path(str(aliased) + '.workspace-template.json').read_text())
        assert manifest['templateId'] == 'proximity' and 'proximity' in manifest['channels']
        assert manifest == json.loads(Path(str(generate(args(template='proximity'))) + '.workspace-template.json').read_text())
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
    parser.add_argument('--template', choices=(*WORKSPACE_TEMPLATES, *TEMPLATE_ALIASES))
    parser.add_argument('--topology', choices=TOPOLOGIES, default='single',
                        help='single: one origin serves everything (default); split: backends only, web client hosted elsewhere')
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
        print('Generated configuration with mode 0600. External OIDC issuer required.')
        if args.template != 'community' and not args.synapse_oidc_secret_file:
            print('Matrix sign-in is not configured: pass --synapse-oidc-secret-file to sign members in to Synapse.')
        if args.template:
            print('Workspace template intent: '+str(target)+'.workspace-template.json (not remotely provisioned)')
        if args.topology == 'split':
            written = check.parse_env_example(target.read_text())[0]
            origins = split_origins(written['KODERA_DOMAIN'], written['KODERA_MATRIX_DOMAIN'])
            print('Split topology: this stack serves ' + ', '.join(origins[name] for name in ('api', 'matrix', 'livekit'))
                  + '. Host the web client at ' + origins['web'] + ', with /.well-known/matrix/client naming ' + origins['matrix'] + '.')
        template_id = TEMPLATE_ALIASES.get(args.template, args.template)
        print(compose_command(target.resolve(), template_id, args.topology))
        return 0
    except (ValueError, OSError, TypeError) as error:
        print('Configuration refused: '+str(error).split('\n')[0], file=sys.stderr)
        return 1

if __name__ == '__main__':
    sys.exit(main())
