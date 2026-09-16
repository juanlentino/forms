# Architecture

How the pieces fit, and why they are shaped the way they are.

---

## Data model

Nothing lives in a bespoke table.

| Thing | Storage | Key |
|---|---|---|
| Form | post type `alltfo_form` | schema JSON in `_alltfo_schema` |
| Entry | post type `alltfo_entry` | values in `_alltfo_values`, context in `_alltfo_context` |
| Entry note | an ordinary **comment** on the entry post | — |
| Theme | post type `alltfo_theme` | tokens in `_alltfo_tokens` |
| Entry status | real post statuses | `alltfo-unread`, `alltfo-read`, `alltfo-spam`, `alltfo-partial` |
| Uploads | attachments, `post_parent` = the entry | `_alltfo_upload` |
| Analytics counters | form meta | views/starts/submissions in `_alltfo_stats`; aggregate device / browser / OS tallies in `_alltfo_tech` — coarse classes and counts only, never a user-agent string or a per-visitor row |

### Why posts

`current_user_can()`, the REST API, revisions, search, the trash, and WordPress's
own privacy exporter and eraser already work on this data. A form's revision
history is version history for free. An entry note is moderated on the Comments
screen without this plugin reimplementing a thread. Deleting an entry takes its
uploads with it because they are its children.

### What it costs

Entries are rows in `wp_posts` alongside content, and a site taking a hundred
thousand submissions will feel that. The mitigations: entries are
`exclude_from_search`, not publicly queryable, and always fetched through
`alltfo_query_entries()`, which filters on an indexed meta key. If a site ever
outgrows this, the swap is behind that one function.

### Why the schema is one JSON document

A form is only ever read and written **whole** — the builder loads all of it and
saves all of it — so a row per field would buy nothing and a partial write is
always a bug. Storing it as one document also means post revisions give a way
back from a bad edit.

JSON rather than a serialised array so the value stays legible in the database,
survives a `wp db export`, and can be diffed between revisions by eye.

### Why statuses, not a meta flag

`wp_count_posts()` returns the per-status counts the entries table needs as a
single cached query. A meta flag would need a `meta_query` per tab on every page
load.

---

## The submission pipeline

One function, `alltfo_process_submission()`, and **every** route ends at it: the
REST endpoint the bundle posts to, the plain `POST` a form makes with JavaScript
off, and any programmatic call. One place where a submission is accepted is the
only way to be sure the two paths enforce the same rules.

The order is fixed and each step earns its position:

```
1  Availability   a closed form rejects before anything is parsed
2  Sanitise       every value through its field type, before it is read
3  Uploads        files become attachments, or the submission fails here
4  Calculations   recomputed server-side; the browser's totals are ignored
5  Validate       against the fields conditional logic says were visible
6  Spam           after validation, so a real visitor sees their typo first
7  Store          unless the form is set not to keep entries
8  Actions        create a post, register a user, call a webhook
9  Notify         e-mail, conditionally
10 Confirm        resolve what the visitor is shown next
```

**Visibility before validation** is the one that matters most. A field hidden by
conditional logic is not required and is not validated — checking it first would
reject a submission for not answering a question the visitor was never shown.

**Spam after validation**, so somebody who mistyped their e-mail address is told
about the typo rather than being quietly filed as spam.

**Notifications after storage**, so a mail server that is refusing connections
costs the site an e-mail rather than a submission.

### Sanitising walks the schema, not the request

`alltfo_sanitize_submission()` iterates the form's fields and reads the request for
each one. A key no field asked for is never read at all, so a forged
`atf[administrator]` reaches nothing.

---

## The two-engine problem

Conditional logic and calculations exist **twice** — once in PHP, once in
TypeScript — because both sides genuinely need them:

- the browser hides and shows fields as the visitor types, and shows a running
  total;
- the server decides what was actually required, and stores the real total.

A disagreement is the worst class of bug this plugin can have. So the cases live
in `tests/fixtures/*.json` and both suites run the same table. See
[`javascript.md`](javascript.md#the-twins).

The server is always the authority. The browser's copy is a convenience that is
never trusted.

---

## Progressive enhancement

The rendered form is a real `<form>` with a real `action` and `method="post"`.
Submitted with scripting off it posts, validates on the server, and comes back
with errors against the right fields and the visitor's answers still in them.

`alltfo_handle_post_submission()` runs on `wp` — early enough that a redirect
confirmation can fire before any output — and stashes the result for the
shortcode to render.

The bundle adds conditional logic as you type, live totals, step transitions,
inline validation, repeater rows, the signature pad and an AJAX submit **on top
of a form that already worked**. If the bundle fails to load, or throws, the form
still collects submissions — and `boot()` deliberately leaves a form alone rather
than half-enhancing it when its schema cannot be read.

Multi-page forms degrade to one long page, which is completable. Pages after the
first carry `data-atf-page-hidden` rather than `hidden`, so a slow bundle shows a
usable form rather than one page with no way forward.

---

## Rendering and theming

`render.php` owns the chrome every field shares — wrapper, label, hint, error,
logic attributes. `render-controls.php` owns the control itself, one `case` per
type. Adding a field type touches one of them.

Themes never change the markup. All ten render byte-identical DOM and differ only
in the custom properties emitted inline, scoped to the form's instance id — which
is both what lets two differently-themed forms share a page, and what keeps the
accessibility work done once. `test_themes_do_not_change_the_markup()` asserts it.

---

## OpenStation

Every shell call sits behind a `function_exists()` gate resolved through
`includes/shell-api.php`, which also resolves the **spelling**: the shell was
called Desktop Mode and is now called OpenStation, and
`desktop_mode_register_window()` became `openstation_register_window()`. Asking
for a capability by its bare name means a site mid-upgrade, a fork, or a shell
that renames itself again degrades to "no desktop integration" rather than a
fatal error on every request.

Registration happens on `init` at 20, wired up from `plugins_loaded` at 20 —
never at file scope, because plugins load alphabetically and `allterrain-forms`
runs before `desktop-mode`, so none of the shell's functions exist yet when the
file is first read.

### Why the builder is a native window

Rendering into the shell's own DOM is what gives it `wp.os.dragManager`, one
pointer pipeline shared with every other window. That is the whole difference:

- a field can be dragged between **two open builder windows**;
- an image dragged out of **WP Explorer** can be dropped onto an image-choice
  option;
- an entry dragged out of the Entries window carries
  `allterrain-forms/entry`, and any other plugin can accept it.

None of that is reachable from inside an iframe.

### Surfaces

| Surface | Id |
|---|---|
| Native window — the builder | `allterrain-forms` |
| Native window — entries | `allterrain-forms-entries` |
| Native window — Theme Studio | `allterrain-forms-themes` |
| Native window — analytics | `allterrain-forms-analytics` |
| Native window — the paired preview | `allterrain-forms-preview-<id>` |
| Wallpaper icon | `allterrain-forms` |
| Widget | `allterrain-forms/recent` |
| Title-bar button | `allterrain-forms/preview` |
| Commands | three, one per window |

### Developer mode

OpenStation has a per-user **Developer mode** switch. This plugin reads the same
one rather than adding a second, so somebody who has turned developer tools on
once has them everywhere.

It gates the demo-data generator: a survey and several hundred submissions, made
so the analytics have something to be analytics *of*. That is a useful thing and a
dangerous one — it writes hundreds of entries into a live database — so it is not
left in the menu of a site collecting real enquiries.

**The preference is not the permission.** `alltfo_developer_mode()` answers "show me
these"; `alltfo_can_edit_forms()` answers "you may use them", and both are checked on
every route. A preference lives in user meta; treating it as authorisation would
mean anybody who can write their own meta could seed a database.

## Analytics

Counters live in post meta and are bumped as things happen; everything else is
computed on demand from a capped sample of entries — 500 by default, spam and
partials excluded, one query shared by every statistic in the report.

Three things are worth stating because getting them wrong looks fine:

**A timeline includes its empty days.** Keep only the days that had a submission
and the gaps close up, so a quiet fortnight renders as wide as a busy one and the
chart shows a steady trickle where the truth was one spike and three weeks of
silence.

**NPS is not an average.** It is the percentage of promoters (9–10) minus the
percentage of detractors (0–6); the passives count for nothing. A mean of the same
answers is a plausible number on a different scale, and reporting it as NPS makes
every benchmark meaningless. A 0–10 scale is recognised as an NPS question by its
shape rather than by a flag somebody has to set.

**A mean needs its distribution.** Everybody answering 3, and half answering 1
with half answering 5, have the same mean and are opposite findings — so the
distribution is returned alongside it and the chart marks which bar the mean falls
in.

The charts themselves are ordinary elements sized in percentages, not canvas or
SVG paths. A bar chart *is* a list of labelled quantities, and built as a list it
can be read aloud, selected and searched; resizing is a reflow rather than a
redraw; and the plugin ships no charting dependency to every site that installs
it.

### Import, the one page with no native window

**Forms → Import** is deliberately not a native window. It is a server-rendered
page whose buttons `POST` to `admin-post.php`, which is the right shape for a
one-time migration and the wrong shape for a window rendering into the shell's
own DOM. With the shell up it is reached instead through the dock tile's
`Import forms` row — the one row carrying a real `url`, which the shell opens
as a window of its own.

That row is load-bearing rather than convenient. With the shell active the
Forms admin menu is not registered at all (see below), so a page with neither a
native window nor a dock row exists at a URL nobody can navigate to.

### The admin-URL handoff

Every surface — builder, entries, analytics, Theme Studio — also has an admin
URL, and without the shell those URLs are the whole experience: ordinary pages
under the **Forms** menu, mounting the same bundles into the same root
elements. With the shell up those URLs must not become a second copy of the
tool. Two copies of the builder on one page means two autosave timers writing
the same form.

The shell offers no way for a native window to *claim* a URL, and a title-bar
Related item can only be expressed as a URL — the shell opens one as a chromeless
iframe window. So the admin page renders a pointer instead of the tool, and
`src/handoff.ts` finishes the job: it opens the native window, then closes the
iframe window it is itself inside. Reaching the URL any way at all — bookmark,
Related menu, deep link — lands you in the native window.

The pointer's button remains for the case where the automatic path cannot run: no
shell, or a shell that refused. Deactivate the shell and the ordinary admin pages
come back untouched.

---

## Security posture

The places where getting it wrong costs somebody else something, and what stands
in the way.

**Uploads.** A per-field extension whitelist re-checked server-side; a MIME check
against the file's actual bytes, so `payload.php` renamed to `photo.jpg` is
refused; an unconditional forbidden-extension list that a form cannot override;
storage in a directory with a deny rule and an index file; unguessable filenames;
and `private` attachment status so they stay out of public queries.

**Calculations.** No `eval()`. Shunting-yard over a whitelist of pure numeric
functions. A formula is author-supplied, stored, and evaluated on every
submission — `eval()` would be remote code execution wearing a convenience
costume.

**Themes.** Token values land in the form wrapper's `style` attribute, so
braces, semicolons, angle brackets, backslashes, `url(`, `expression(`,
`@import` and `javascript:` are **refused** rather than escaped. There is no legitimate token value that needs
one.

**Exports.** A cell beginning `=`, `+`, `-` or `@` is prefixed with an
apostrophe, because a spreadsheet executes it on open.

**Post-submit actions.** Post types, post statuses and roles are each constrained
by a filter whose default is the narrow answer: `post` and `page`; `publish`
downgraded to `pending`; the site's own default role and nothing else. A form's
settings are editable by anyone with `alltfo_edit_forms`, which is a lower bar than
"may publish anywhere" or "may hand out roles".

**The client schema.** The front end gets a reduced slice — ids, types, logic,
bounds, choice prices — never notification recipients, webhook secrets, the spam
blocklist or quiz answers. Asserted by
`test_client_schema_leaks_nothing()`.

**Entries.** Not `show_in_rest`. An entry holds whatever the form asked for, and
core's generic handler would expose it to anyone who can read a post. Every read
goes through `alltfo_prepare_entry()`, which is where the capability check lives.

**The public routes.** `/submit` and `/track` are the only two, and `/track`
accepts one event and can only increment a counter.

---

## File layout

```
allterrain-forms.php          bootstrap, constants, activation
includes/
  shell-api.php               function_exists() gate + name resolution
  openstation.php             windows, icon, widget, commands
  preview.php                 the standalone front-end preview page
  post-types.php              post types, statuses, meta, capabilities
  fields.php                  the field-type registry
  field-types.php             the 37 built-ins
  schema.php                  normalise, store, page-split
  themes.php                  tokens, ten themes, CSS emitter
  logic.php                   conditional logic      ← twin of src/shared/logic.ts
  calc.php                    the expression evaluator ← twin of src/shared/calc.ts
  merge-tags.php              {field:f1}, {all_fields}, quiz scoring
  render.php                  form chrome, client schema
  render-controls.php         one control per field type
  availability.php            scheduling, limits, prefill
  validation.php              server-side validation
  spam.php                    honeypot, time trap, rate limit, Akismet
  uploads.php                 the dangerous one
  submission.php              the pipeline
  notifications.php           e-mail
  confirmations.php           what happens next
  actions.php                 post, user, webhook
  entries.php                 query, export, retention
  analytics.php               counters, rates, timeline, NPS, cross-tabs, device/browser tallies
  dev-mode.php                the developer-mode gate
  demo-data.php               the survey and the people who answered it
  templates.php               the template library
  rest.php                    allterrain-forms/v1
  shortcode.php / block.php   placement
  admin-page.php              the no-shell fallback
  assets.php                  handles and config
  privacy.php                 exporter, eraser, policy text
src/
  form.ts                     the front-end bundle
  success.ts                  the success screens and their celebrations
  builder.ts                  palette, canvas, inspector
  theme-studio.ts             the token editor
  entries.ts                  the submissions window
  analytics.ts                the report window
  widget.ts                   the desktop widget
  preview-button.ts           the eye in the title bar
  logic-map.ts                conditions in words + the curves that draw them
  merge-tags.ts               the Insert-a-value picker
  handoff.ts                  admin URL → native window
  dock.ts                     the one dock tile and its flyout
  relations.ts                the window content graph
  dnd.ts                      drag manager + fallback
  api.ts / ui.ts / types.ts
  shared/logic.ts, shared/calc.ts
tests/
  fixtures/*.json             the shared conformance tables
  vitest/                     TypeScript
  phpunit/tests/              PHP
```

## Portable form packages

The Vite build uses `commonjsOptions.strictRequires: true` to preserve the
validator's CommonJS initialization order consistently. Automatic wrapper
detection can vary with module load order, producing different committed bundles
on CI. Development and production bundles are committed and checked against a
fresh build before release.

[Version-1 YAML/JSON packages](form-packages.md) wrap the existing form schema with a built-in theme base, sparse theme changes, form overrides, embedded image-choice dependencies and page URL references. Export uses the current builder snapshot; import validates and creates a new draft plus isolated theme/media resources. Existing form storage stays JSON in `ALLTFO_META_SCHEMA`.

`schemas/form-package-v1.schema.json` is the shared contract. The builder and offline CLI use a bundled YAML 1.2 parser and JSON Schema validator. `includes/portability.php` validates decoded JSON against that contract and installed field/token behavior before writes. REST routes accept decoded JSON; PHP needs no YAML runtime. See [form-packages.md](form-packages.md) for routes, size limits, dependency handling and rollback behavior.

Custom themes now persist their dark-surface hint in `_alltfo_theme_dark` post meta. `alltfo_save_theme()` accepts optional `dark`; omitted values preserve the hint on updates, and existing themes without the meta remain light. This makes imported dark themes render correctly.

## Private MIO form editing (experimental)

When the native shell exposes the PR #816 MIO API, the builder registers a lease
against its actual window instance. `src/mio/` owns linked bundled Markdown help,
read/validate/apply tools and single-use in-memory validation receipts. Classic
admin and older shells keep manual/file workflows. See the [knowledge base](mio/index.md)
and [MIO API review](mio-api-feedback.md).

All routes below use the existing `alltfo_edit_forms` permission gate and REST
cookie/nonce authentication. JSON bodies carry a decoded `{title,schema}` draft:

| Route relative to allterrain-forms/v1 | Request | Response |
|---|---|---|
| GET /assistant/forms/{id} | Form ID | `{revision}` hash of stored title/status/schema |
| POST /assistant/validate | `{draft}` | `{valid:true}`, or WP_Error with path/message/suggestion |
| POST /assistant/apply | `{draft,formId,revision,operationKey?}` | Saved form plus operation receipt when keyed; formId=0 creates a draft |
| GET /assistant/operations/{key} | User-scoped operation key | Confirmed receipt/form ID, known rejection, or unknown outcome; never writes |

Apply revalidates and rejects a stale stored revision with HTTP 409; updates retain
publication status. The check is optimistic, not a transaction across all legacy
writers. Client cancellation cannot roll back an already accepted request. Unknown
write outcomes must be inspected, never automatically retried. The assistant YAML
limit is 40,000 bytes on the recovery API and 16,000 on the original API; the server draft limit is 60,000 bytes. None of these routes reads
submissions or invokes mail/actions. No new user meta, global ability or query flag
is introduced.

Operation records use non-autoloaded `_alltfo_mio_{sha256(userId:key)}` options in
the current site. Each contains a normalized-payload hash, state and timestamps;
confirmed records also carry form ID, saved revision and a UUID receipt. There is
no YAML, credential or submission content in the ledger. `add_option` atomically
claims the key before any form write. The same key cannot accept a different
payload; an in-flight record stays unknown until a confirmed receipt is stored.
An identical completed replay returns the original result only while that saved
revision remains current. This deduplication does not lock out unrelated form
writers. Single cron events expire records after seven days; uninstall removes
these transient operation records and their scheduled events even when retaining
forms/entries. A missing or expired record means unknown, never permission to retry.
