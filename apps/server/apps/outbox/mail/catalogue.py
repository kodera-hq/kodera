"""The message template catalogue: docs/specs/OUTBOX_MAIL_SENDER.md §4.

Read from catalogue.toml once per process. A template declares its parameters, whether its copy is
approved, and a subject and a plain-text body per locale, with `${name}` placeholders: the declared
parameters and `link`. A template carries a secret link (`link`, the default) or no link at all
(`link = false`). A parameter it declares under `lines` takes one to ten values, rendered one per
line. A parameter it declares under `text` takes a customer's message verbatim: up to 20,000
characters, line feeds and tabs kept, every other control character refused, in a body only.
"""

from __future__ import annotations

import functools
import tomllib
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from string import Template

LOCALES = ("fr", "en")
LINK = "link"
MAX_PARAM_LENGTH = 200
MAX_LINES = 10
MAX_TEXT_LENGTH = 20_000
# The only control characters a `text` value keeps: a line feed and a tab.
TEXT_CONTROLS = frozenset("\n\t")
TEXT_REFUSED_CATEGORIES = frozenset({"Cc", "Cs", "Zl", "Zp"})
PATH = Path(__file__).with_name("catalogue.toml")


class TemplateError(ValueError):
    """A template is unknown, malformed, or cannot render with the values given."""


@dataclass(frozen=True)
class Copy:
    subject: str
    body: str


@dataclass(frozen=True)
class MessageTemplate:
    template_id: str
    approved: bool
    params: tuple[str, ...]
    copies: Mapping[str, Copy]
    link: bool = True
    lines: tuple[str, ...] = ()
    text: tuple[str, ...] = ()


@dataclass(frozen=True)
class Rendered:
    subject: str
    body: str


def _placeholders(text: str) -> set[str]:
    return {
        match.group("named") or match.group("braced")
        for match in Template.pattern.finditer(text)
        if match.group("named") or match.group("braced")
    }


def _parse(raw: Mapping[str, object]) -> dict[str, MessageTemplate]:
    templates: dict[str, MessageTemplate] = {}
    for template_id, entry in raw.items():
        if not isinstance(entry, dict):
            raise TemplateError(f"{template_id} is not a table")
        approved = entry.get("approved")
        params = entry.get("params")
        if not isinstance(approved, bool):
            raise TemplateError(f"{template_id} does not say whether its copy is approved")
        link = entry.get("link", True)
        lines = entry.get("lines", [])
        text = entry.get("text", [])
        if not isinstance(link, bool):
            raise TemplateError(f"{template_id} says whether it carries a link with true or false")
        if (
            not isinstance(params, list)
            or not all(isinstance(name, str) and name.isidentifier() for name in params)
            or LINK in params
            or len(set(params)) != len(params)
        ):
            raise TemplateError(f"{template_id} declares malformed parameters")
        if (
            not isinstance(lines, list)
            or not set(lines) <= set(params)
            or len(set(lines)) != len(lines)
        ):
            raise TemplateError(f"{template_id} declares lines that are not its parameters")
        if (
            not isinstance(text, list)
            or not set(text) <= set(params)
            or len(set(text)) != len(text)
        ):
            raise TemplateError(f"{template_id} declares text that is not its parameters")
        if set(text) & set(lines):
            raise TemplateError(f"{template_id} declares a parameter both lines and text")
        copies: dict[str, Copy] = {}
        for locale in LOCALES:
            copy = entry.get(locale)
            if copy is None:
                continue
            subject, body = (
                (copy.get("subject"), copy.get("body")) if isinstance(copy, dict) else (None, None)
            )
            if not isinstance(subject, str) or not isinstance(body, str):
                raise TemplateError(f"{template_id} {locale} lacks a subject or a body")
            allowed = {*params, LINK} if link else set(params)
            if not _placeholders(subject) | _placeholders(body) <= allowed:
                raise TemplateError(f"{template_id} {locale} uses an undeclared placeholder")
            if link and (LINK not in _placeholders(body) or LINK in _placeholders(subject)):
                raise TemplateError(f"{template_id} {locale} must carry the link in its body only")
            if any(name in _placeholders(subject) for name in lines):
                raise TemplateError(f"{template_id} {locale} puts lines in its subject")
            if any(name in _placeholders(subject) for name in text):
                raise TemplateError(f"{template_id} {locale} puts text in its subject")
            copies[locale] = Copy(subject=subject, body=body)
        if not copies:
            raise TemplateError(f"{template_id} has no copy")
        templates[template_id] = MessageTemplate(
            template_id=template_id,
            approved=approved,
            params=tuple(params),
            copies=copies,
            link=link,
            lines=tuple(lines),
            text=tuple(text),
        )
    return templates


def load() -> dict[str, MessageTemplate]:
    """Every template of the catalogue file."""
    with PATH.open("rb") as handle:
        return _parse(tomllib.load(handle))


@functools.cache
def _catalogue() -> dict[str, MessageTemplate]:
    return load()


def templates() -> dict[str, MessageTemplate]:
    """The catalogue, read once per process."""
    return _catalogue()


def get(template_id: str) -> MessageTemplate:
    try:
        return templates()[template_id]
    except KeyError:
        raise TemplateError(f"{template_id!r} is not a template of the catalogue") from None


def unapproved() -> frozenset[str]:
    """The templates whose copy is not approved (`approved = false`)."""
    return frozenset(t.template_id for t in templates().values() if not t.approved)


def check_value(value: object) -> bool:
    """A parameter value: a non-empty string of at most 200 characters, no control character."""
    return (
        isinstance(value, str)
        and 0 < len(value) <= MAX_PARAM_LENGTH
        and not any(unicodedata.category(character).startswith("C") for character in value)
    )


def check_lines(value: object) -> bool:
    """A `lines` parameter: one to ten values, each a single value."""
    return (
        isinstance(value, list)
        and 0 < len(value) <= MAX_LINES
        and all(check_value(line) for line in value)
    )


def check_text(value: object) -> bool:
    """A `text` parameter: a non-empty string of at most 20,000 characters whose only control
    characters are line feeds and tabs. A lone surrogate, which no mail can encode, and the Unicode
    line and paragraph separators, which break a line without being one, are refused too. Format
    characters (an emoji's joiner, a soft hyphen, a right-to-left mark) are a person's text."""
    return (
        isinstance(value, str)
        and 0 < len(value) <= MAX_TEXT_LENGTH
        and not any(
            character not in TEXT_CONTROLS
            and unicodedata.category(character) in TEXT_REFUSED_CATEGORIES
            for character in value
        )
    )


def check_params(template: MessageTemplate, params: Mapping[str, object]) -> None:
    """Refuse parameters that are not exactly the template's, or a value that is not plain text."""
    if set(params) != set(template.params):
        raise TemplateError(f"{template.template_id} takes exactly {sorted(template.params)}")
    for name, value in params.items():
        if name in template.lines:
            ok = check_lines(value)
        elif name in template.text:
            ok = check_text(value)
        else:
            ok = check_value(value)
        if not ok:
            raise TemplateError(f"{template.template_id} was given a malformed parameter value")


def render(
    template_id: str, locale: str, params: Mapping[str, object], *, link: str | None
) -> Rendered:
    """The subject and body of `template_id` in `locale`, with `link` in place of ${link} (None for
    a template without a link) and each `lines` parameter one value per line."""
    return _render(get(template_id), locale, params, link=link)


def _render(
    template: MessageTemplate, locale: str, params: Mapping[str, object], *, link: str | None
) -> Rendered:
    template_id = template.template_id
    copy = template.copies.get(locale)
    if copy is None:
        raise TemplateError(f"{template_id} has no {locale} copy")
    check_params(template, params)
    if (link is None) == template.link:
        raise TemplateError(f"{template_id} is rendered with a link if and only if it carries one")
    values = {
        name: "\n".join(value) if name in template.lines and isinstance(value, list) else value
        for name, value in params.items()
    }
    if link is not None:
        values[LINK] = link
    try:
        return Rendered(
            subject=Template(copy.subject).substitute(values),
            body=Template(copy.body).substitute(values),
        )
    except (KeyError, ValueError):
        raise TemplateError(f"{template_id} {locale} does not render") from None
