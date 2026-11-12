# Quickstart & auto-hébergement

> Préparez votre espace. Gardez la maîtrise de l’identité et du déploiement.

## Commencer par un plan de configuration

Depuis un checkout de kodera-hq/kodera, lancez le CLI Node sans dépendance externe. Ce dry-run valide domaine public, émetteur HTTPS externe et template, sans créer de fichier ni de service.

Les cinq templates sont audiovisual-production, tech-studio, b2b-advisory, public-sector et proximity ; crisis-cell est un alias permanent de proximity. Le template audiovisuel inclut une intention de configuration Frame.io.

> Le CLI est une préversion locale. La publication registre n’est pas confirmée ; utilisez immédiatement l’exécutable du dépôt.

```bash
node packages/create-kodera/bin/create-kodera.mjs --self-host \
  --domain chat.example.org --oidc-issuer https://id.example.org/realms/studio \
  --oidc-client-id console --template audiovisual-production --dry-run
```

## Après publication du package officiel

Le package fournit les exécutables create-kodera et kodera-deploy. La forme npx ci-dessous sera utilisable après publication sur le registre.

La génération réelle demande aussi la confiance publique de votre émetteur et un checkout source. Elle crée un nouveau dossier, une configuration en mode 0600 et un manifeste d’intention ; elle refuse les écrasements.

> Un manifeste généré ne prouve pas l’existence de salons, d’identifiants ou d’abonnements aux connecteurs.

```bash
npx create-kodera --self-host --domain chat.example.org \
  --oidc-issuer https://id.example.org/realms/studio \
  --oidc-client-id console --template audiovisual-production --dry-run
```

## Générer, vérifier, puis démarrer Compose

Préparez public-trust.json avec les clés publiques de votre émetteur externe. Lancez le générateur shell depuis la racine du dépôt ; il affiche la commande Compose à exécuter par l’opérateur.

Community inclut Caddy, Web, API/migrateur, room-access, PostgreSQL, Valkey, Synapse et LiveKit. Docker Compose v2, DNS public, HTTPS et ports média doivent être configurés. La stack ne fournit pas de fournisseur d’identité.

> Cette documentation ne promet ni durée d’installation, ni empreinte mémoire, ni déploiement distant.

```bash
bash deploy/community/kodera-deploy.sh --domain chat.example.org \
  --oidc-issuer https://id.example.org/realms/studio \
  --oidc-origin https://id.example.org --oidc-client-id console \
  --support-mailbox support@example.org --trust-file public-trust.json \
  --template audiovisual-production --env-file kodera-generated.conf --generate-only
```

## Sources

- [deploy/community/README.md](https://github.com/kodera-hq/kodera/blob/main/deploy/community/README.md)

- [packages/create-kodera/README.md](https://github.com/kodera-hq/kodera/blob/main/packages/create-kodera/README.md)

- [README.md](https://github.com/kodera-hq/kodera/blob/main/README.md)
