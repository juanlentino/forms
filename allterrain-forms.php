<?php
/**
 * Plugin Name:       AllTerrain Forms
 * Plugin URI:        https://github.com/AllTerrainDeveloper/forms
 * Description:       Forms for WordPress with every premium feature free — conditional logic, calculations, multi-page, file uploads, signatures, repeaters, entry management, ten themes — built as an OpenStation desktop app with a drag-and-drop builder.
 * Version:           1.2.0
 * Requires at least: 6.9
 * Requires PHP:      7.4
 * Requires Plugins:  desktop-mode
 * Author:            Daniel Lopez
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       allterrain-forms
 *
 * No `Domain Path` header: it names the folder translations load from, and this
 * plugin ships none. Pointing it at a `/languages` directory that does not exist
 * is a promise the package does not keep, and Plugin Check rejects it as one.
 *
 * ---
 *
 * Three decisions shape this plugin, and everything else follows from them.
 *
 * **Nothing is behind a paywall.** Conditional logic, calculations, multi-page
 * forms, file uploads, signatures, repeaters, save-and-resume, entry management,
 * CSV export, conditional notifications, surveys, quizzes, user registration and
 * front-end post submission are the paid tier of every other forms plugin. None
 * of them is technically hard. They are all here, in the free plugin, and the
 * only reason they were ever sold separately is that somebody could.
 *
 * **The builder is a native OpenStation window, never an iframe.** Building a
 * form is a spatial act -- you drag a field from a palette and put it somewhere.
 * Rendering into the shell's own DOM is what gives the builder
 * `wp.os.dragManager`, the same pointer pipeline the desktop's file tiles ride,
 * so a field can be dragged between two open forms, an image can be dragged out
 * of WP Explorer onto a file field, and an entry can be dragged onto another
 * plugin's window entirely. None of that is reachable from inside an iframe.
 *
 * **Everything is a post.** A form is a post, an entry is a post, an entry note
 * is a comment, a saved theme is a post. Nothing lives in a bespoke table, so
 * the REST API, `current_user_can()`, revisions, search, the trash, and the
 * privacy exporter and eraser already work on this data without a line of
 * integration code.
 *
 * OpenStation is **required** — the `Requires Plugins: desktop-mode` header
 * says so, and WordPress enforces it at activation. The builder is a
 * native shell window; the desktop is the product, not a skin on it. Every
 * shell call still resolves through `includes/shell-api.php`'s
 * `function_exists()` gates, but as defense in depth for half-upgraded sites
 * rather than as a supported mode: without the shell, an admin notice says
 * what is missing, visitors' published forms keep rendering so nobody's
 * front end breaks, and nothing else pretends to work.
 *
 * @package AllTerrain_Forms
 */

defined( 'ABSPATH' ) || exit;

define( 'ALLTFO_VERSION', '1.2.0' );
define( 'ALLTFO_FILE', __FILE__ );
define( 'ALLTFO_DIR', plugin_dir_path( __FILE__ ) );
define( 'ALLTFO_URL', plugin_dir_url( __FILE__ ) );

/**
 * REST namespace for the form-shaped endpoints.
 *
 * The post types are `show_in_rest`, so `/wp/v2/alltfo_form` handles ordinary CRUD.
 * This namespace exists for the things core REST cannot express in one round
 * trip: submitting a form (which validates, screens for spam, stores an entry,
 * sends notifications and resolves a confirmation as one operation), saving a
 * whole schema atomically, and querying entries as a table rather than as posts.
 */
define( 'ALLTFO_REST_NAMESPACE', 'allterrain-forms/v1' );

/**
 * The post types.
 *
 * `register_post_type()` rejects a key longer than 20 characters, and
 * `allterrain-forms-` is 17 of them on its own. `alltfo_` keeps every key short
 * enough and reads consistently with the meta keys and the CSS prefix.
 */
define( 'ALLTFO_FORM_TYPE', 'alltfo_form' );
define( 'ALLTFO_ENTRY_TYPE', 'alltfo_entry' );
define( 'ALLTFO_THEME_TYPE', 'alltfo_theme' );

/**
 * The form's field list and settings, as one JSON document.
 *
 * One meta key rather than a row per field, because a form is only ever read and
 * written whole: the builder loads all of it, saves all of it, and a partial
 * write is always a bug. Storing it as one document also means post revisions
 * give version history -- and a way back from a bad edit -- for free.
 */
define( 'ALLTFO_META_SCHEMA', '_alltfo_schema' );

/** The submitted values, keyed by field id. */
define( 'ALLTFO_META_VALUES', '_alltfo_values' );

/** Which form an entry belongs to. Indexed by every entries query. */
define( 'ALLTFO_META_FORM', '_alltfo_form' );

/**
 * Submission metadata kept beside the values rather than inside them.
 *
 * Separate because it is not user input and must never collide with a field id:
 * a form with a field called `ip` would otherwise overwrite the record of where
 * the submission came from.
 */
define( 'ALLTFO_META_CONTEXT', '_alltfo_context' );

/**
 * Where an imported form came from: `{ importer, source }`.
 *
 * Recorded so the migration can be finished later. Importing the form is the
 * urgent half and the half somebody does immediately; bringing the stored
 * submissions across is the half they think of a week afterwards, by which time
 * nothing else remembers which source form became which AllTerrain form.
 */
define( 'ALLTFO_META_IMPORT_SOURCE', '_alltfo_import_source' );

/**
 * Source field name => new field id, for an imported form.
 *
 * The importers already build this map to rewrite mail tags into merge tags;
 * keeping it is what lets stored submissions be read afterwards, since every
 * source keys its saved values by its own field names and nothing else can
 * translate them.
 */
define( 'ALLTFO_META_IMPORT_MAP', '_alltfo_import_map' );

/**
 * The source record an imported entry came from: `{ importer, source }`.
 *
 * Makes importing entries repeatable: a second run skips what it already
 * brought across instead of duplicating it, which matters because the natural
 * response to a migration that looks incomplete is to run it again.
 */
define( 'ALLTFO_META_ENTRY_SOURCE', '_alltfo_entry_source' );

/** Design tokens for a user-created theme. */
define( 'ALLTFO_META_TOKENS', '_alltfo_tokens' );

/** Rolling per-form counters for views, starts and submissions. */
define( 'ALLTFO_META_STATS', '_alltfo_stats' );

/**
 * Rolling per-form device / browser / OS tallies.
 *
 * Aggregate counters keyed by coarse class ("mobile", "chrome"), one set for
 * views and one for submissions -- never a per-visitor row, and never the
 * user-agent string itself.
 */
define( 'ALLTFO_META_TECH', '_alltfo_tech' );

/**
 * A partially completed submission, kept so the user can resume it.
 *
 * Holds a token, the values so far, and an expiry. Stored on its own entry post
 * in the `alltfo-partial` status so retention and the privacy eraser reach it by
 * exactly the same code path as a finished submission.
 */
define( 'ALLTFO_META_RESUME', '_alltfo_resume' );

/**
 * Entry post statuses.
 *
 * Real post statuses rather than a meta field, so `wp_count_posts()` produces
 * the "12 unread" counts the entries table shows without a bespoke query, and
 * so the trash works the way the trash works everywhere else in WordPress.
 */
define( 'ALLTFO_STATUS_UNREAD', 'alltfo-unread' );
define( 'ALLTFO_STATUS_READ', 'alltfo-read' );
define( 'ALLTFO_STATUS_SPAM', 'alltfo-spam' );
define( 'ALLTFO_STATUS_PARTIAL', 'alltfo-partial' );

/**
 * The status an archived *form* holds.
 *
 * A real post status for the same reasons the entry statuses are: the post
 * keeps its meta, its revisions and its trash behaviour, and nothing about it
 * is copied anywhere to make it disappear from the pickers.
 */
define( 'ALLTFO_STATUS_ARCHIVED', 'alltfo-archived' );

require_once ALLTFO_DIR . 'includes/shell-api.php';
require_once ALLTFO_DIR . 'includes/post-types.php';
require_once ALLTFO_DIR . 'includes/fields.php';
require_once ALLTFO_DIR . 'includes/field-types.php';
require_once ALLTFO_DIR . 'includes/schema.php';
require_once ALLTFO_DIR . 'includes/themes.php';
require_once ALLTFO_DIR . 'includes/logic.php';
require_once ALLTFO_DIR . 'includes/calc.php';
require_once ALLTFO_DIR . 'includes/merge-tags.php';
require_once ALLTFO_DIR . 'includes/render.php';
require_once ALLTFO_DIR . 'includes/render-controls.php';
require_once ALLTFO_DIR . 'includes/availability.php';
require_once ALLTFO_DIR . 'includes/validation.php';
require_once ALLTFO_DIR . 'includes/spam.php';
require_once ALLTFO_DIR . 'includes/uploads.php';
require_once ALLTFO_DIR . 'includes/submission.php';
require_once ALLTFO_DIR . 'includes/resume.php';
require_once ALLTFO_DIR . 'includes/notifications.php';
require_once ALLTFO_DIR . 'includes/confirmations.php';
require_once ALLTFO_DIR . 'includes/actions.php';
require_once ALLTFO_DIR . 'includes/mailpoet.php';
require_once ALLTFO_DIR . 'includes/entries.php';
require_once ALLTFO_DIR . 'includes/archive.php';
require_once ALLTFO_DIR . 'includes/analytics.php';
require_once ALLTFO_DIR . 'includes/dev-mode.php';
require_once ALLTFO_DIR . 'includes/demo-data.php';
require_once ALLTFO_DIR . 'includes/templates.php';
require_once ALLTFO_DIR . 'includes/importers.php';
require_once ALLTFO_DIR . 'includes/importer-cf7.php';
require_once ALLTFO_DIR . 'includes/importer-wpforms.php';
require_once ALLTFO_DIR . 'includes/importer-gravityforms.php';
require_once ALLTFO_DIR . 'includes/import-notice.php';
require_once ALLTFO_DIR . 'includes/portability.php';
require_once ALLTFO_DIR . 'includes/assistant.php';
require_once ALLTFO_DIR . 'includes/rest.php';
require_once ALLTFO_DIR . 'includes/abilities.php';
require_once ALLTFO_DIR . 'includes/preview.php';
require_once ALLTFO_DIR . 'includes/shortcode.php';
require_once ALLTFO_DIR . 'includes/block.php';
require_once ALLTFO_DIR . 'includes/assets.php';
require_once ALLTFO_DIR . 'includes/admin-page.php';
require_once ALLTFO_DIR . 'includes/openstation.php';
require_once ALLTFO_DIR . 'includes/openstation-explorer.php';
require_once ALLTFO_DIR . 'includes/privacy.php';

register_activation_hook( __FILE__, 'alltfo_activate' );
register_deactivation_hook( __FILE__, 'alltfo_deactivate' );

/**
 * Prepares the site on activation.
 *
 * Post types are registered here as well as on `init` because permalinks are
 * flushed in the same breath: `flush_rewrite_rules()` rewrites the rules for
 * whatever is registered *at that moment*, and on activation `init` has already
 * run. Without the re-registration the flush would helpfully erase the very
 * rules it was called to create.
 *
 * @since 0.1.0
 *
 * @return void
 */
function alltfo_activate() {
	alltfo_register_post_types();
	alltfo_register_post_statuses();
	alltfo_add_capabilities();
	alltfo_schedule_retention();

	flush_rewrite_rules();
}

/**
 * Undoes the parts of activation that would otherwise outlive the plugin.
 *
 * Capabilities are deliberately *not* removed. A site that deactivates this
 * plugin to debug something and reactivates it a minute later would otherwise
 * find every editor's form permissions gone, and there is no way to tell that
 * case apart from a real uninstall. Removing them belongs in `uninstall.php`,
 * which only runs when the plugin is actually deleted.
 *
 * @since 0.1.0
 *
 * @return void
 */
function alltfo_deactivate() {
	wp_clear_scheduled_hook( 'alltfo_apply_retention' );

	flush_rewrite_rules();
}

/**
 * Announces that the plugin is loaded and its APIs are safe to call.
 *
 * Fired on `plugins_loaded` at 20 rather than at file scope so that a plugin
 * registering a field type or a theme has a hook that runs after this plugin's
 * own registries exist but before `init`, where they are first read.
 *
 * @since 0.1.0
 *
 * @return void
 */
function alltfo_loaded() {
	/**
	 * Fires once AllTerrain Forms is loaded and its registries are open.
	 *
	 * The place to call `alltfo_register_field_type()` and `alltfo_register_theme()`.
	 *
	 * @since 0.1.0
	 */
	do_action( 'alltfo_loaded' );
}
add_action( 'plugins_loaded', 'alltfo_loaded', 20 );
