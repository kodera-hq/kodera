"""Official industry workspace templates for Kodera onboarding and warm-pool claim, and the two
vocabularies a claim names them with (docs/specs/WORKSPACE_TEMPLATES.md, contract 0.42.0).

- **Template identifiers** (`WorkspaceTemplateId`). `proximity` is canonical; `crisis-cell` is its
  permanent deprecated alias and resolves to the same template, never a different one.
- **Theme identifiers** (`ThemeId`, `ThemeIdAlias`). `light`, `dark`, `black`, `ciel` and
  `ciel-nuit` are canonical; `givre`, `ardoise` and `real-black` are the deprecated aliases of the
  first three.

An identifier is canonicalised in one place each, `canonical_template_id` and `canonical_theme_id`,
by the claim that sends it and by the reader of a stored provisioning plan alike, so that a claim
sending `light` matches a plan prepared as `givre`.
"""

from dataclasses import dataclass
from typing import Any

from .models import TEMPLATE_KEY, Channel


class UnknownWorkspaceTemplateError(ValueError):
    """Raised when a requested workspace template identifier is not in the official catalogue."""

    def __init__(self, template_id: str) -> None:
        super().__init__(f"unknown workspace template: {template_id}")
        self.template_id = template_id


@dataclass(frozen=True, slots=True)
class CategoryBlueprint:
    key: str
    name: str

    @property
    def db_template_key(self) -> str:
        """Database-safe template_key conforming to models.TEMPLATE_KEY."""
        return self.key.replace("-", "_")


@dataclass(frozen=True, slots=True)
class ChannelBlueprint:
    category_key: str
    template_key: str
    name: str
    kind: str
    topic: str = ""

    @property
    def db_template_key(self) -> str:
        """Database-safe template_key conforming to models.TEMPLATE_KEY."""
        return self.template_key.replace("-", "_")


@dataclass(frozen=True, slots=True)
class WorkspaceTemplate:
    id: str
    label_fr: str
    categories: tuple[CategoryBlueprint, ...]
    channels: tuple[ChannelBlueprint, ...]
    default_connectors: tuple[str, ...]
    recommended_roles: tuple[str, ...]
    default_theme_id: str
    # The English display label, where Core owns one. Never an identifier: a label is read by a
    # person, an identifier is ASCII and is what is sent and stored.
    label_en: str | None = None


# The unified theme vocabulary (contract `ThemeId`), the same on every client and in Core.
THEME_IDS = ("light", "dark", "black", "ciel", "ciel-nuit")
# The identifiers in use before 0.42.0 (contract `ThemeIdAlias`): accepted wherever a ThemeId is,
# and read as the ThemeId each names. `ciel` and `ciel-nuit` have no alias.
THEME_ALIASES = {"givre": "light", "ardoise": "dark", "real-black": "black"}
DEFAULT_THEME_ID = "light"
# The identifier a template took before 0.42.0 (contract `WorkspaceTemplateId`): permanent.
TEMPLATE_ALIASES = {"crisis-cell": "proximity"}

# The proximity channel's own words, where Core carries them: what the room is, and that it is
# not an emergency service, in English and in French.
PROXIMITY_NOT_AN_EMERGENCY_SERVICE = (
    "Proximity is not an emergency service: in an emergency, call your local emergency number "
    "(112 in the EU). / Proximité n'est pas un service d'urgence : en cas d'urgence, appelez le "
    "numéro d'urgence local (112 dans l'UE)."
)


def canonical_theme_id(value: object) -> str | None:
    """The `ThemeId` `value` names, itself or through its alias, or None when it names none."""
    if not isinstance(value, str):
        return None
    theme_id = THEME_ALIASES.get(value, value)
    return theme_id if theme_id in THEME_IDS else None


def canonical_template_id(value: object) -> str | None:
    """The official template `value` names, itself or through its alias, or None."""
    if not isinstance(value, str):
        return None
    template_id = TEMPLATE_ALIASES.get(value, value)
    return template_id if template_id in TEMPLATES else None


def canonical_plan(plan: Any) -> Any:
    """A stored provisioning plan read with today's identifiers: its `theme_id` and `template_id`
    are replaced by the identifiers they name. Everything else is the plan's own, compared as it
    is; a value that names nothing is left alone, and then matches no claim."""
    if not isinstance(plan, dict):
        return plan
    canonical = dict(plan)
    theme_id = canonical_theme_id(plan.get("theme_id"))
    if theme_id is not None:
        canonical["theme_id"] = theme_id
    template_id = canonical_template_id(plan.get("template_id"))
    if template_id is not None:
        canonical["template_id"] = template_id
    return canonical


TEMPLATES: dict[str, WorkspaceTemplate] = {
    "audiovisual-production": WorkspaceTemplate(
        id="audiovisual-production",
        label_fr="Société de production audiovisuelle",
        categories=(
            CategoryBlueprint("production", "Production & Tournage"),
            CategoryBlueprint("post-production", "Post-Production & Rushes"),
            CategoryBlueprint("plateaux", "Plateaux & Salles Vocales"),
        ),
        channels=(
            ChannelBlueprint(
                "production",
                "production",
                "production",
                Channel.Kind.TEXT,
                "Coordination générale des projets et plannings de production",
            ),
            ChannelBlueprint(
                "production",
                "tournage",
                "tournage",
                Channel.Kind.TEXT,
                "Feuilles de service, repérages et logistique plateau",
            ),
            ChannelBlueprint(
                "post-production",
                "post-production",
                "post-production",
                Channel.Kind.TEXT,
                "Montage, étalonnage, mixage et validations Frame.io",
            ),
            ChannelBlueprint(
                "post-production",
                "dailies-rushes",
                "dailies-rushes",
                Channel.Kind.TEXT,
                "Retours quotidiens sur les rushes et notes timecodées",
            ),
            ChannelBlueprint(
                "plateaux",
                "plateau-regie",
                "plateau-regie",
                Channel.Kind.AUDIO,
                "Canal vocal direct plateau et régie",
            ),
            ChannelBlueprint(
                "plateaux",
                "salle-montage",
                "salle-montage",
                Channel.Kind.AUDIO,
                "Session vocale de revue montage et post-production",
            ),
        ),
        default_connectors=("frameio-review-bridge", "nextcloud-drive-notifier"),
        recommended_roles=(
            "Producteur",
            "Réalisateur",
            "post-production",
            "Superviseur VFX/Son",
        ),
        default_theme_id="black",
    ),
    "tech-studio": WorkspaceTemplate(
        id="tech-studio",
        label_fr="Studio Tech & Produit",
        categories=(
            CategoryBlueprint("general", "Général"),
            CategoryBlueprint("engineering", "Ingénierie & Produit"),
            CategoryBlueprint("voice", "Salons Vocaux"),
        ),
        channels=(
            ChannelBlueprint(
                "general",
                "general",
                "general",
                Channel.Kind.TEXT,
                "Annonces d'équipe et coordination quotidienne",
            ),
            ChannelBlueprint(
                "engineering",
                "releases",
                "releases",
                Channel.Kind.TEXT,
                "Suivi des déploiements, changelogs et mises en production",
            ),
            ChannelBlueprint(
                "engineering",
                "incidents",
                "incidents",
                Channel.Kind.TEXT,
                "Gestion des alertes de production et post-mortems",
            ),
            ChannelBlueprint(
                "voice",
                "standup",
                "standup",
                Channel.Kind.AUDIO,
                "Point quotidien d'équipe à faible latence",
            ),
            ChannelBlueprint(
                "voice",
                "pairing",
                "pairing",
                Channel.Kind.AUDIO,
                "Session vocale de pair-programming et revue de code",
            ),
        ),
        default_connectors=("github-webhook", "linear-sync", "sentry-alerts"),
        recommended_roles=("Lead Tech", "Product", "SRE", "Security"),
        default_theme_id="dark",
    ),
    "b2b-advisory": WorkspaceTemplate(
        id="b2b-advisory",
        label_fr="Cabinet & Conseil B2B",
        categories=(
            CategoryBlueprint("cabinet", "Vie du Cabinet"),
            CategoryBlueprint("missions", "Missions & Livrables"),
            CategoryBlueprint("salles", "Salles de Réunion"),
        ),
        channels=(
            ChannelBlueprint(
                "cabinet",
                "general",
                "general",
                Channel.Kind.TEXT,
                "Coordination interne du cabinet et annonces",
            ),
            ChannelBlueprint(
                "missions",
                "missions-clients",
                "missions-clients",
                Channel.Kind.TEXT,
                "Suivi des mandats, cadrages et comités de pilotage",
            ),
            ChannelBlueprint(
                "missions",
                "livrables",
                "livrables",
                Channel.Kind.TEXT,
                "Revue des rapports, synthèses et propositions commerciales",
            ),
            ChannelBlueprint(
                "salles",
                "salle-associes",
                "salle-associes",
                Channel.Kind.AUDIO,
                "Salle vocale des associés et directeurs",
            ),
            ChannelBlueprint(
                "salles",
                "point-client",
                "point-client",
                Channel.Kind.AUDIO,
                "Pont audio pour réunions et restitutions",
            ),
        ),
        default_connectors=(
            "qonto-treasury-alerts",
            "stripe-revenue-events",
            "calcom-booking-sync",
        ),
        recommended_roles=("Associé", "Directeur de mission", "Consultant", "Finance"),
        default_theme_id="light",
    ),
    "public-sector": WorkspaceTemplate(
        id="public-sector",
        label_fr="Collectivité & Secteur Public",
        categories=(
            CategoryBlueprint("collectivite", "Services & Direction"),
            CategoryBlueprint("deliberations", "Projets & Délibérations"),
            CategoryBlueprint("permanence", "Permanence Vocale"),
        ),
        channels=(
            ChannelBlueprint(
                "collectivite",
                "accueil",
                "accueil",
                Channel.Kind.TEXT,
                "Informations générales des agents et de la direction",
            ),
            ChannelBlueprint(
                "collectivite",
                "services-generaux",
                "services-generaux",
                Channel.Kind.TEXT,
                "Coordination inter-services et logistique",
            ),
            ChannelBlueprint(
                "deliberations",
                "deliberations",
                "deliberations",
                Channel.Kind.TEXT,
                "Préparation des dossiers, arrêtés et séances",
            ),
            ChannelBlueprint(
                "permanence",
                "salle-du-conseil",
                "salle-du-conseil",
                Channel.Kind.AUDIO,
                "Salle vocale pour réunions de direction et commissions",
            ),
            ChannelBlueprint(
                "permanence",
                "permanence",
                "permanence",
                Channel.Kind.AUDIO,
                "Canal vocal d'astreinte et de continuité de service",
            ),
        ),
        default_connectors=("nextcloud-drive-notifier",),
        recommended_roles=("Direction", "Secrétariat général", "Agent", "Astreinte"),
        default_theme_id="light",
    ),
    "proximity": WorkspaceTemplate(
        id="proximity",
        label_fr="#proximité",
        label_en="#proximity",
        categories=(CategoryBlueprint("proximity", "Proximité"),),
        # Exactly one default channel: the proximity room itself. People add further proximity
        # channels with `createChannel` and invite members with the channel's access document.
        channels=(
            ChannelBlueprint(
                "proximity",
                "proximity",
                "proximity",
                Channel.Kind.TEXT,
                PROXIMITY_NOT_AN_EMERGENCY_SERVICE,
            ),
        ),
        default_connectors=(),
        recommended_roles=("Référent", "Membre"),
        default_theme_id="black",
    ),
}


def resolve_template(template_id: str) -> WorkspaceTemplate:
    """Return the official WorkspaceTemplate `template_id` names, by its identifier or by a
    deprecated alias of it, or raise UnknownWorkspaceTemplateError."""
    canonical = canonical_template_id(template_id)
    if canonical is None:
        raise UnknownWorkspaceTemplateError(str(template_id))
    return TEMPLATES[canonical]


def list_templates() -> list[WorkspaceTemplate]:
    """Return the ordered catalogue of official workspace templates."""
    return list(TEMPLATES.values())


__all__ = [
    "DEFAULT_THEME_ID",
    "PROXIMITY_NOT_AN_EMERGENCY_SERVICE",
    "TEMPLATE_ALIASES",
    "TEMPLATE_KEY",
    "TEMPLATES",
    "THEME_ALIASES",
    "THEME_IDS",
    "CategoryBlueprint",
    "ChannelBlueprint",
    "UnknownWorkspaceTemplateError",
    "WorkspaceTemplate",
    "canonical_plan",
    "canonical_template_id",
    "canonical_theme_id",
    "list_templates",
    "resolve_template",
]
