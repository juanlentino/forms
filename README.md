<div align="center">

<img src=".wordpress-org/banner-1544x500.png" alt="AllTerrain Forms — every premium feature, free" width="840">

# AllTerrain Forms

**Forms for WordPress with every premium feature free — built as an
[OpenStation](https://wordpress.org/plugins/desktop-mode/) desktop app with a
drag-and-drop builder, ten themes, and no paywall anywhere in it.**

[![WordPress 6.9+](https://img.shields.io/badge/WordPress-6.9%2B-21759b)](https://wordpress.org)
[![PHP 7.4+](https://img.shields.io/badge/PHP-7.4%2B-777bb4)](https://php.net)
[![License](https://img.shields.io/badge/license-GPL--2.0--or--later-blue)](LICENSE)

![The builder and the entries window open together on the OpenStation desktop](.github/media/desktop.png)

</div>

---

## What it is

A forms plugin. You drag fields onto a canvas, pick a theme, and put the form on
a page. People fill it in; you read what they said.

Three decisions shape everything else.

### Nothing is behind a paywall

Conditional logic, calculations, multi-page forms, file uploads, signatures,
repeaters, save-and-resume, entry management, CSV export, conditional
notifications, webhooks, surveys, quizzes, user registration and front-end post
submission are the paid tier of every other forms plugin. None of them is
technically hard. They are all here, in the free plugin, and the only reason they
were ever sold separately is that somebody could.

### The builder is a native OpenStation window, never an iframe

Building a form is a spatial act — you drag a field from a palette and put it
somewhere. Rendering into the shell's own DOM is what gives the builder
`wp.os.dragManager`, the same pointer pipeline the desktop's file tiles ride. So:

| Drag this | Onto this | And |
|---|---|---|
| A field from the palette | The canvas | It is added where you dropped it |
| A field already on the canvas | Somewhere else on it | It moves |
| A field | **A second builder window** | It is copied into that form |
| An image from **WP Explorer** | An image-choice option | It becomes that option's picture |
| An entry from the **Entries window** | An AllTerrain Work column | It becomes a task |

None of that is reachable from inside an iframe. It is also the reason the
Entries window emits `allterrain-forms/entry` as a public payload type: any other
plugin can register a drop target for it and decide what a submission means to
them.

![The form builder: a field palette on the left, the canvas in the middle, the field inspector on the right](.github/media/builder.png)

### Everything is a post

A form is a post, an entry is a post, an entry note is a comment, a saved theme
is a post. Nothing lives in a bespoke table, so the REST API,
`current_user_can()`, revisions, search, the trash, and WordPress's own privacy
exporter and eraser already work on this data without a line of integration code.

**OpenStation is required.** The plugin declares `Requires Plugins:
desktop-mode`, so WordPress installs and activates the shell alongside it
and refuses to pull the shell out from underneath it. The builder is a native
shell window — the desktop is the product, not a skin on it — so the plugin
does not ship a lesser version of itself for sites without one. The
`function_exists()` gates in `includes/shell-api.php` remain as defense in
depth for half-upgraded sites: without the shell an admin notice says what is
missing, and published forms keep rendering so no visitor ever pays for an
admin dependency.

---

## The eye in the title bar

OpenStation has a convention for previewing: a window with something to show on
the front end carries an eye on the right of its title bar, and pressing it opens
the front end **as its own window, paired with the editor**. The shell does this
for post and page edit screens. A form is the same shape of thing, so it wears
the same affordance.

Press it and the form opens beside the builder as a real front-end render — same
renderer, same stylesheet, same theme resolution, so what you see is what a
visitor gets. Save, and the preview window refreshes itself. Drag a field, watch
it change, drag another; the builder never closes.


---

## Ten themes, and an eleventh you make yourself

A theme is **one flat map of design tokens** and nothing else. There is no theme
PHP, no theme template, no theme stylesheet. The renderer emits the same markup
for every theme and the tokens decide what it looks like — which is what makes
"expandable without code" true rather than a line in a README.

| | | |
|---|---|---|
| **Clean** — the neutral default | **Midnight** — dark, high contrast | **Glass** — translucent, real backdrop blur |
| **Brutal** — 3px black rules, offset shadow | **Paper** — warm stock, serif headings | **Neon** — near-black, gradient accents, glow |
| **Terminal** — monospace, phosphor green | **Soft** — neumorphic, dual inset shadows | **Editorial** — big serif, labels in the margin |
| **Holo** — the OpenStation brand | | |

Sixty-nine tokens across eleven families: colour, radius, shadow, border,
spacing, typography, label position, button shape, focus ring, motion and
effects. A theme can change the corner radius of the checkbox independently of
the text field, put labels inside the field or in the margin, swap the field for
an underline, add a backdrop blur, or paint the submit button with a gradient.

**Theme Studio** is a native window with a control per token and a live preview.
Duplicate a built-in, move sliders, name it, save — it becomes a theme selectable
anywhere a built-in is, exportable as JSON and importable on another site. No
code, no build step.

![Theme Studio: the ten built-in themes across the top, plain-language dials on the left, a live form preview on the right](.github/media/theme-studio.png)

The dials are the part worth explaining. Sixty-nine tokens is a complete
description of a theme and a terrible way to make one: nobody thinks *"I want
`radius-field: 14px`, `radius-button: 14px`, `radius-card: 24px`"* — they think
**rounder**. So six controls each drive a whole family — Accent, Roundness,
Density, Depth, Fields, Labels — and the full token list stays behind Advanced
for the cases they cannot express. Both write the same token map; the dials are a
faster way to write it, not a parallel format.

The token surface and the stylesheet are asserted to agree **in both directions**
by the test suite: a token no CSS rule reads is a control that does nothing, and
a custom property no token declares is a value no theme can reach. All ten themes
are also checked for WCAG AA contrast.

---

## The field palette

**Text** — single line, paragraph, email, website, phone, number, password, hidden
**Choice** — dropdown, multi-select, radios, checkboxes, image choice, toggle
**Date & time** — date, time, date & time, date range
**Advanced** — file upload, signature, star rating, opinion scale, Likert matrix, slider, colour, name, address, country, repeater
**Layout** — section heading, HTML block, divider, spacer, page break
**Special** — consent, calculated total, quiz question

Every one of them is a single `alltfo_register_field_type()` call using exactly the
API a third-party plugin would use. There is no privileged path: if a built-in
needs something the registry cannot express, the registry gets a feature rather
than the built-in reaching around it.

---

## Conditional logic you can see

A `LOGIC` badge tells you a field has a condition and nothing about what it is.
To find out you had to select the field, scroll the inspector, and read three
dropdowns — and even then you learned about that one field, not about the shape
of the form. A form where three questions depend on the first one *has* a
structure, and a flat list is not showing it.

![The builder canvas with curves drawn from a radio question to the two fields it controls, each labelled with the answer that triggers it](.github/media/conditional-logic.png)

So every card states its condition, and the controller is joined to what it
controls by a labelled curve. Hovering a card dims every curve it does not touch,
which turns *"what does this field affect?"* from a search into a glance.

The condition is drawn as **separated parts**, not a sentence:

> `SHOWN WHEN` · **Can you make it?** · *is* · `Yes, I will be there`

Both the question and the answer are text somebody typed, so the question ends in
a question mark and the answer contains a comma — the punctuation a sentence
would rely on for structure is inside the content. Chips remove the parsing. The
question chip is a button that selects that field, and a rule pointing at a
deleted question is drawn in red, because that form is genuinely stuck and it was
previously invisible.

---

## Merge tags nobody has to learn

`{field:f2}` asks somebody to know three things nobody told them: that braces mean
something, which tags exist, and that their second question is internally called
`f2`. It sat in the two panes that decide whether anyone ever finds out a form was
submitted.

![The Notifications pane with the Insert a value picker open, listing the form's own questions by label with an example of what each resolves to](.github/media/merge-tags.png)

Every box that takes tags has an **Insert a value** picker listing the form's own
questions *by the label you wrote*, grouped with the submitter, the submission,
the form and the site — each row showing what it actually resolves to on this
site. Under the box, a "reads as" line with the tags filled in.

**Send it to** is asked in plain language too: whoever runs this site, the person
who filled it in (naming your email question), a specific address, or free text
for the rest. The common cases need no tags at all.

The catalogue is served from PHP — `alltfo_merge_tag_catalogue()` — so it cannot
drift from what actually resolves, and the suite fails if it ever advertises a tag
the resolver does not know.

---

## Everything else it does

**Logic** — conditional show/hide on any field, page, notification, confirmation
or post-submit action, with all/any matching and chained conditions. Calculations
over field values with a safe expression evaluator (no `eval`, ever). Multi-page
forms with step validation. Save and resume. Pre-fill from the URL, the logged-in
user or the date. Unique-value validation.

**Anti-spam without a captcha** — honeypot, signed time trap, per-address rate
limit, word blocklist, and Akismet — off by default — when the site already has
it and switches it on per form. Nothing asks the
visitor to prove they are human, because that charges them for the site's spam
problem and fails WCAG for a good number of people. A submission judged spam is
**stored**, in a spam status, never silently discarded.

**After submission** — multiple conditional notifications with merge tags,
CC/BCC, reply-to and attachments. Multiple conditional confirmations: a message,
a URL, or a page. Webhooks with HMAC-SHA256 signing. Actions that create a post,
register a user, or write user meta — each with a capability ceiling that a form
author cannot raise.

**Managing** — an entries table with search, filters and star; a detail view;
bulk read/spam/trash; CSV export with formula injection defused; survey and quiz
reporting.

**Reporting** — an analytics window with views, starts, conversion and completion;
submissions per day; a tally or a distribution per question; Net Promoter Score
for any 0–10 question; and a cross-tab that breaks every numeric answer down by
any categorical one — which is the difference between "the average score is 7.5"
and "Support scores 5.8 and everyone else is above 7".

![The entries window: submissions on the left, one submission's answers on the right](.github/media/entries.png)

![The analytics window: headline counts, submissions per day, a Net Promoter Score, and every answer broken down by team](.github/media/analytics.png)

**Privacy** — a retention policy that deletes automatically, IP anonymisation,
and integration with WordPress's own export and erase tools so a subject access
request reaches form submissions without anybody having to remember they are a
separate place.

---

## Nine abilities, so AI agents can use the forms

The plugin registers its whole working surface with WordPress's Abilities API,
which is how a site describes what it can do to agents and MCP clients. Each
ability is a thin adapter over the same functions the windows and the REST API
call — an agent and a human clicking the same button get the same behaviour,
the same validation and the same capability checks.

| Ability | What it does |
|---|---|
| `list-forms` | Every form with id, title, theme, shortcode, entry count and questions — the ids feed everything else |
| `get-form` | One form's questions: field ids, types, labels, required flags, choices |
| `list-field-types` | The building vocabulary: all 37 types and what each stores |
| `create-form` | Builds a form from a title and a loose field list; returns the shortcode |
| `set-form-theme` | Dresses a form in any installed theme |
| `submit-form` | Submits through the visitor pipeline — validation, anti-spam, storage, notifications; refusals return per-field errors |
| `list-entries` | Queries submissions — search, date range, status, pagination — raw and human-readable |
| `get-entry` | One submission, every answer labelled and formatted |
| `form-report` | The analytics as structured data: conversion, timeline, distributions, NPS, group-by breakdowns |

Ask an assistant to *"make a booking form and show me last week's responses"*,
and these are what it calls. The full contract — permissions, schemas, and the
one honest liberty `submit-form` takes with the time trap — is in
[`docs/abilities.md`](docs/abilities.md).

---

## Accessibility

Not a section that says "we care about accessibility". The things that were
actually done:

- Every control has a real `<label>` bound by `for`. Grouped controls (radios,
  checkboxes, ratings, scales, names, addresses) are in a `<fieldset>` with a
  `<legend>`, because a `<label>` may only point at one control and one above six
  radios is bound to none of them.
- The Likert matrix is a real `<table>` with `scope` on both header directions,
  so each radio's accessible name is its row's statement crossed with its
  column's answer.
- Hints and errors are wired with `aria-describedby`; invalid fields carry
  `aria-invalid`. The error summary is a focusable `role="alert"` region that
  takes focus on a failed submit.
- Required is announced with `required`, not with an asterisk — the asterisk is
  `aria-hidden`, because "asterisk" tells a screen-reader user nothing.
- A required field hidden by conditional logic is not validated. Its controls are
  disabled as well as hidden, so the browser cannot block submission on a field
  nobody can see or reach.
- The builder is keyboard-complete: every palette entry is a `<button>` that adds
  its field, and Alt+↑/↓ moves a field on the canvas. Dragging is never the only
  way to do anything.
- `prefers-reduced-motion` and `forced-colors` are both honoured. All ten themes
  meet WCAG AA contrast, and the suite fails if one stops.
- The form works with JavaScript switched off: a real `POST`, real server
  validation, errors against the right fields, answers still in place.

![The same form on the front end of a site, in the Clean theme](.github/media/front-end.png)

---

## Install

```bash
git clone https://github.com/allterraindeveloper/forms.git
cd forms
npm install
npm run build
```

Drop the directory into `wp-content/plugins/` and activate it. With OpenStation
installed the builder appears as a desktop window and a wallpaper icon; without
it, under **Forms** in the admin menu.

Place a form with the shortcode the builder shows you:

```
[allterrain_form id="12"]
```

…or with the **Form** block, which has a picker and a live preview.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Builds every bundle, dev and minified, then mirrors into a local site |
| `npm run dev` | Rebuilds the builder bundle on save |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest — the shared conformance suites |
| `npm run env:start` | Starts a WordPress via `wp-env` |
| `npm run test:php` | PHPUnit inside `wp-env` |
| `npm run test:php:local` | PHPUnit against a `WP_TESTS_DIR` you already have |
| `npm run plugin:build` | Typecheck, test, build — everything a release needs |
| `npm run plugin:package` | The above, then `dist/allterrain-forms.zip` |

### Development

`npm run env:start` brings up a WordPress with this plugin mounted. `.wp-env.json`
also mounts a sibling `../alcazaba-plugin` checkout so the desktop shell is there
to host the windows — without it you get the plugin's admin-page fallback, which
is a complete forms plugin and not the interesting half.

`npm run build` ends by mirroring the built tree into a local WordPress checkout
if it finds one (`../wordpress-alcazaba` or `../wordpress-develop`). Override with
`ALLTFO_DEPLOY_TARGET`, or skip with `ALLTFO_SKIP_DEPLOY=1`. It is a convenience, not a
build requirement: on CI it finds nothing, says so, and exits successfully.

### Releasing

Four places carry the version and they must agree:

| Where | What |
|---|---|
| `allterrain-forms.php` | the `Version:` header |
| `allterrain-forms.php` | `ALLTFO_VERSION` |
| `readme.txt` | `Stable tag` |
| `package.json` | `version` |

Bump all four, commit, then tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The tag starts [`release.yml`](.github/workflows/release.yml), which checks the
tag against all four, builds and packages, runs the PHP suite, creates a GitHub
Release with the zip attached, and deploys to WordPress.org.

A tag whose version disagrees with any of the four fails **before** the Release
exists. That ordering is the point: a bad commit can be replaced, and a published
tag cannot.

A prerelease (`v0.2.0-rc1`) stops at the GitHub Release. WordPress.org has no
concept of one and pushing it would make it the live download.

The WordPress.org step needs `SVN_USERNAME` and `SVN_PASSWORD` repository
secrets, and cannot succeed before the plugin is approved and its SVN repository
exists. Until then the first submission is a manual zip upload; everything before
that step is useful from the first tag on.

Re-running a failed deploy is a manual dispatch rather than a re-run:

```bash
gh workflow run release.yml --ref main -f tag=v0.2.0
```

A tag push runs the workflow definition frozen into that tag's commit, so a
deploy that failed for a workflow-level reason can never be fixed by re-running
it. Dispatching from `main` runs the current definition and leaves the existing
Release alone.

### CI

[`ci.yml`](.github/workflows/ci.yml) runs three jobs on every push and pull
request:

| Job | What it proves |
|---|---|
| `js` | Types, Vitest, and that the committed `assets/js` bundles match their source |
| `php` | PHPUnit and PHPCS, inside `wp-env` |
| `package` | That `npm run plugin:package` still produces a zip, uploaded as an artifact |

The third exists because a packaging script that only ever runs at release time
is a script that breaks at release time. The first exists because `assets/js` is
committed on purpose — it is what makes "download the zip from a tag and install
it" work with no `npm install` — and that only holds while the committed bundles
match the TypeScript they came from.

`.wp-env.json` mounts a sibling checkout that does not exist on a runner, and
wp-env treats a missing mapping as fatal, so both PHP jobs write a
`.wp-env.override.json` that replaces `mappings` wholesale. Nothing is lost: every
shell call in this plugin sits behind `alltfo_shell_has()`, which is simply false
when no shell is installed.

## Testing

The conditional-logic and calculation engines exist **twice** — once in PHP, once
in TypeScript — because the browser hides and shows fields as the visitor types
and the server decides what was actually required. If they disagree, the visitor
is shown a form they cannot submit, with an error about a field they cannot see.

So they are not tested twice. `tests/fixtures/logic-cases.json` and
`calc-cases.json` hold one table each, and both suites run it:

```
tests/fixtures/logic-cases.json ──┬── tests/vitest/logic.test.ts
                                  └── tests/phpunit/tests/logic.php
```

A case added to one language is a case added to both, and a change that breaks
the parity fails in both suites. 113 shared cases, plus each side's own.

```bash
npm test              # 166 TypeScript tests
npm run test:php      # 465 PHP tests, inside wp-env
```

## Documentation

- [`docs/hooks-reference.md`](docs/hooks-reference.md) — every action and filter
- [`docs/abilities.md`](docs/abilities.md) — the nine WordPress Abilities AI
  agents use the forms through: build, theme, submit, query, report
- [`docs/field-types.md`](docs/field-types.md) — adding a field type
- [`docs/themes.md`](docs/themes.md) — the token surface, and adding a token
- [`docs/javascript.md`](docs/javascript.md) — events, drag payloads, the bundles
- [`docs/architecture.md`](docs/architecture.md) — how it fits together
- [`docs/openstation-requests.md`](docs/openstation-requests.md) — what this
  plugin needed from the shell, what it got, and what is still missing

## Licence

GPL-2.0-or-later. Every premium feature, free, forever.

## Export, edit and import forms as YAML

Use **Export** in the builder to download the current form with its base theme, only changed theme/advanced CSS settings, all field/settings/logic/action configuration and embedded image-choice attachments. **Validate YAML** checks a file without writing anything. **Import** accepts YAML or versioned JSON and creates a new draft with its own theme.

For LLM-assisted editing, use the [format guide](docs/form-packages.md), [JSON Schema](schemas/form-package-v1.schema.json) and [example YAML](docs/examples/contact-form.yaml). Validate a document locally with:

```bash
npm run validate:form -- path/to/form.yaml
```

This checks the portable contract offline. Import also checks installed field types, safe theme tokens and image contents. Entries and external plugin/site configuration are separate from the form definition; see the guide for dependency handling.

The browser round-trip test runs against the local wp-env site with OpenStation and AllTerrain Forms active:

```bash
npx playwright install chromium
npm run env:start
npm run test:e2e
```

`ATF_E2E_URL`, `ATF_E2E_USER`, and `ATF_E2E_PASSWORD` override the default local URL (`http://localhost:8889`) and `admin` / `password` test account. The test creates its own form/theme and deletes them afterward. On an older development database, reactivate AllTerrain Forms to refresh its capabilities first.

The phone builder regression also requires OpenStation enabled for the test user.
It checks tap-to-add, the full-width inspector, card bounds, saving and reopening,
and the transition back to the desktop layout. Run it on its own with
`npx playwright test tests/e2e/builder-phone.spec.ts`.

### MIO form editing

With OpenStation's compatible window MIO API, open AllTerrain Forms and use **Ask
MIO** to create a draft or update the current form. YAML is validated before saving;
invalid candidates receive precise errors and up to two correction attempts.
Existing forms keep their publication status. Manual and file workflows remain
available in classic admin. Provider setup and MIO enablement belong to OpenStation.

- [Detailed linked Markdown knowledge base](docs/mio/index.md)
- [Developer handoff: review of MIO PR #816](docs/mio-api-feedback.md)
- [Conditional contact YAML example](docs/examples/mio-conditional-contact.yaml)

Browser tests default to Docker `http://localhost:8889` (`npm run test:e2e`). The MIO
adapter cases capture the real shell registration and simulate model tool calls.
The chat case uses the real composer, session and rendered Preview button, replacing
only provider responses. All use real WordPress validation/saves without invoking
a paid AI provider.


The recovery MIO API adds turn-wide correction limits, compact document history
and read-only reconciliation of uncertain saves. To exercise the adapter against
an actual local MIO checkout, run
`ATF_MIO_SOURCE=../alcazaba-plugin npm test -- --run tests/vitest/mio-contract.test.ts`.
The [response button handoff](docs/mio-action-buttons-proposal.md) records the plan
and implementation follow-up. Forms supplies a Preview action after a confirmed
save when the shell supports the new optional responseActions API.
