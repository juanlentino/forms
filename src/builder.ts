/**
 * The form builder.
 *
 * Three panes: a palette of field types, a canvas holding the form, and an
 * inspector for whatever is selected. A field is added by dragging it from the
 * palette onto the canvas, and reordered by dragging it within the canvas.
 *
 * Both of those go through `wp.os.dragManager` when OpenStation is present —
 * the shell's own pointer pipeline, shared with every other window on the
 * desktop. That is what makes the cross-window behaviour possible: a field can
 * be dragged between two open builder windows, and an image dragged out of WP
 * Explorer can be dropped onto an image-choice field. On a plain wp-admin page
 * the same code runs against the fallback manager in `dnd.ts`, so there is one
 * drag implementation rather than two.
 *
 * **Dragging is never the only way to do anything.** Every field type in the
 * palette is a real `<button>` that adds a field when activated, and every field
 * on the canvas can be moved with the keyboard. A builder that can only be
 * driven by a pointer excludes the people least able to work around it.
 */

import { api, runtime } from './api';
import { mountFormMio } from './mio/assistant';
import type { EditorSnapshot, FormAssistantHost } from './mio/types';
import { MAX_PACKAGE_BYTES, parsePackage, stringifyPackage, packageValidator, packageObjects } from './shared/form-package.mjs';
import packageContract from '../schemas/form-package-v1.schema.json';

import { conditionValueOptions } from './condition-values';
import { buildPayload, getDragManager, insertionIndex, watchShellDragVisuals } from './dnd';
import {
	button,
	checkbox,
	clear,
	confirmAction,
	debounce,
	el,
	hasComponent,
	icon,
	notify,
	numberInput,
	raf,
	readSetting,
	whenComponents,
	row,
	pinWindowBodyScroll,
	select,
	textArea,
	textInput,
	writeSetting,
} from './ui';
import { handOffToWindow, watchHandoffButton, takeFormFor } from './handoff';
import { LogicMap, OPERATOR_LABELS, VALUELESS_OPERATORS, controlCounts, logicEdges, logicTokens, ruleTokens, tokensToText } from './logic-map';
import { boundValue, renderFieldPreview } from './field-preview';
import type { LogicToken } from './logic-map';
import { forgetMergeTags, mergeTags, taggable } from './merge-tags';
import { mountThemeControls } from './theme-studio';
// For its side effects: the MailPoet window rides this bundle the same way the
// standalone Theme Studio does, and mounts itself when its root is present.
import './mailpoet-hub';
import { SUCCESS_STYLE_ICONS, defaultSuccessScreen, normalizeSuccessScreen, playSuccessEffects, renderSuccessScreen } from './success';
import { formulaInput, openFormulaEditor } from './formula-editor';
import { openConditionCopy } from './condition-copy';
import { compileRecipe, describeRecipe, openValidationEditor, parseRecipe } from './validation-editor';
import { VALIDATION_GROUPS, VALIDATION_PRESETS, validationPreset } from './shared/validation';
import { openPreview, refreshPreview, registerPreviewButton } from './preview-button';
import { formIdentity, setIdentity } from './relations';

/**
 * Where the logic-overlay toggle is remembered.
 *
 * The key carries a version, and bumping it is how "on by default" becomes true
 * for somebody who had already switched it off while it was a new and unfamiliar
 * thing. A stored preference outlives the reason it was set; this resets that one
 * choice once, and every choice made after this point sticks.
 */
const LOGIC_MAP_SETTING = 'allterrain-forms/logic-map-v2';

/**
 * Marks an inspector control as the twin of something on the canvas.
 *
 * The canvas and the inspector edit the same values, so they have to agree while
 * you are typing — rewriting a label on the card and watching the Label box keep
 * the old text reads as one of them being stale, with no way to tell which.
 *
 * The tag is what lets a canvas edit write through to its counterpart without
 * rebuilding the whole pane on every keystroke. Rebuilding would also work, and
 * is what a structural change does — but it recreates every shell component in
 * the inspector, sixty times a second, to change one string.
 *
 * @param control The inspector control.
 * @param key     What it edits: `label`, `placeholder`, `choice:<n>:label`, …
 * @return The same control.
 */
function bind< T extends HTMLElement >( control: T, key: string ): T {
	control.dataset.atfbBind = key;

	return control;
}

/**
 * The prefill sources, in the order they are offered.
 *
 * `tag` names the merge tag that resolves to the same thing, which is how the
 * preview line gets a real value for *this* site without a second endpoint: the
 * merge-tag catalogue already carries `sample` for every one of these, computed
 * by the same PHP that resolves them.
 *
 * `date:now` and `date:today` are spelled out rather than left as formats,
 * because they are what a date field and a time field respectively want and
 * nobody should have to know `H:i` to pre-fill the time.
 */
/**
 * One of a field type's own settings, and the control that edits it.
 *
 * # Why this is a table
 *
 * A field type declares what it supports; the inspector decides what to draw. For
 * a long time those two were joined by a hand-written `if` per setting, and the
 * consequence was not a bug anybody could see: thirty-two supported settings had
 * no control anywhere. `level` on a heading, `content` on an HTML block, the file
 * types a file field accepts, how many rows a repeater allows, the labels on the
 * ends of a scale — all honoured by the renderer, all reachable only by editing
 * the exported JSON by hand. A setting nobody can find is a setting that does not
 * exist, and nothing about the code said so, because every one of them worked
 * perfectly once set.
 *
 * As a table it is one line per setting, `field-settings.test.ts` asserts that
 * every flag any registered type declares either appears here or is listed as
 * deliberately handled elsewhere, and the failure mode goes from silent to loud.
 *
 * # The keys
 *
 * `flag` is the `supports` entry, which is lower-case by WordPress convention;
 * `key` is the property on the field, which is camelCase. They differ often
 * enough (`minrows` / `minRows`) that conflating them was never an option.
 */
interface SettingControl {
	/** The field property this writes. */
	key: string;
	/** The row's label. */
	label: string;
	/** How it is edited. */
	control: 'text' | 'number' | 'checkbox' | 'textarea' | 'select' | 'commas';
	/** Sits under the control. */
	hint?: string;
	/** For `select`. */
	options?: Array< { value: string; label: string } >;
	/** A companion setting rendered directly after — the natural pairs. */
	also?: { key: string; label: string; hint?: string };
}

/**
 * Every `supports` flag that draws a control of its own.
 *
 * Ordered as the inspector shows them: the ones that change what the field *is*
 * before the ones that tune it.
 */
export const SETTING_CONTROLS: Record< string, SettingControl > = {
	level: {
		key: 'level',
		label: 'Heading level',
		control: 'select',
		hint: 'Headings should step down one at a time.',
		options: [
			{ value: '2', label: 'Heading 2' },
			{ value: '3', label: 'Heading 3' },
			{ value: '4', label: 'Heading 4' },
			{ value: '5', label: 'Heading 5' },
			{ value: '6', label: 'Heading 6' },
		],
	},
	content: {
		key: 'content',
		label: 'HTML',
		control: 'textarea',
		hint: 'Shown as written. Scripts are stripped when the form is saved.',
	},
	consenttext: {
		key: 'consentText',
		label: 'What they are agreeing to',
		control: 'textarea',
		hint: 'Shown beside the tick box. Links are allowed.',
	},
	height: {
		key: 'height',
		label: 'Height',
		control: 'number',
		hint: 'In pixels.',
	},
	columns: {
		key: 'columns',
		label: 'Columns',
		control: 'number',
		hint: 'How many pictures sit side by side.',
	},
	multiple: {
		key: 'multiple',
		label: 'Let them choose more than one',
		control: 'checkbox',
	},
	inline: {
		key: 'inline',
		label: 'Lay the options out in a row',
		control: 'checkbox',
	},
	other: {
		key: 'other',
		label: 'Offer an “Other” box',
		control: 'checkbox',
		hint: 'Adds a final option with a box to type in.',
	},
	filetypes: {
		key: 'filetypes',
		label: 'Accepted file types',
		control: 'commas',
		hint: 'Extensions, separated by commas. Empty accepts anything the site allows.',
	},
	maxsize: {
		key: 'maxsize',
		label: 'Largest file',
		control: 'number',
		hint: 'In megabytes.',
	},
	maxfiles: {
		key: 'maxfiles',
		label: 'How many files',
		control: 'number',
	},
	minrows: {
		key: 'minRows',
		label: 'Fewest rows',
		control: 'number',
		also: { key: 'maxRows', label: 'Most rows' },
	},
	itemlabel: {
		key: 'itemLabel',
		label: 'What is one row called?',
		control: 'text',
		hint: 'Names each card — “Attendee 1”, “Attendee 2” — and the Remove button. Also editable on the card itself.',
	},
	endlabels: {
		key: 'minLabel',
		label: 'Label at the low end',
		control: 'text',
		also: { key: 'maxLabel', label: 'Label at the high end' },
	},
	points: {
		key: 'points',
		label: 'Points if correct',
		control: 'number',
	},
	minchoices: {
		key: 'minChoices',
		label: 'Fewest they may pick',
		control: 'number',
		also: { key: 'maxChoices', label: 'Most they may pick' },
	},
};

/**
 * Flags that draw no control of their own, and why.
 *
 * Listed rather than left out, because "not in the table" has to mean "somebody
 * decided that" instead of "somebody forgot". The test reads this.
 */
export const SETTINGS_HANDLED_ELSEWHERE: Record< string, string > = {
	label: 'the canvas edits it in place, and the inspector mirrors it',
	placeholder: 'edited by typing into the control on the canvas',
	hint: 'edited under the control on the canvas',
	nextlabel: 'edited on the page break’s own Next button',
	prevlabel: 'edited on the page break’s own Back button',
	addlabel: 'edited on the repeater’s own Add button',
	choices: 'the choices editor, and the option list on the canvas',
	required: 'the toggle on the card',
	width: 'its own row',
	css: 'its own row',
	prefill: 'its own section',
	logic: 'the conditional logic section',
	formula: 'its own row, with the currency that goes with it',
	currency: 'rendered with the formula',
	correct: 'the choices editor marks the right answer',
	default: 'its own row, typed to match what the field stores',
	rows: 'a row count on a textarea; the statement list on a Likert matrix',
	parts: 'a tick box per part, listed by the server',
	min: 'the validation section, paired with max',
	max: 'the validation section, paired with min',
	step: 'the validation section',
	minlength: 'the validation section, paired with maxlength',
	maxlength: 'the validation section, paired with minlength',
	mindate: 'the validation section, paired with maxdate',
	maxdate: 'the validation section, paired with mindate',
	mintime: 'the validation section, paired with maxtime',
	maxtime: 'the validation section, paired with mintime',
	pattern: 'the validation section',
	unique: 'the validation section',
	maxchoices: 'rendered with minchoices',
	maxrows: 'rendered with minrows',
};

/**
 * One row for one setting, per its table entry.
 *
 * `commas` is the only conversion here: a few settings store a list of short
 * tokens — the extensions a file field accepts — and a comma-separated box is
 * how everybody already expects to type those. Split on save, joined on render,
 * so the stored shape stays an array and the typed shape stays a sentence.
 *
 * @param field   The field.
 * @param setting The table entry.
 * @param update  Writes one property.
 * @return The row.
 */
function settingRow(
	field: Field,
	setting: SettingControl,
	update: ( key: string, value: unknown ) => void
): HTMLElement {
	const raw = field[ setting.key ];
	const write = ( value: unknown ) => update( setting.key, value );

	if ( 'checkbox' === setting.control ) {
		return checkbox( setting.label, Boolean( raw ), write );
	}

	if ( 'commas' === setting.control ) {
		const list = Array.isArray( raw ) ? ( raw as string[] ) : [];

		return row(
			setting.label,
			textInput( list.join( ', ' ), ( value ) => {
				write(
					value
						.split( ',' )
						.map( ( item ) => item.trim().replace( /^\./, '' ).toLowerCase() )
						.filter( Boolean )
				);
			} ),
			setting.hint
		);
	}

	if ( 'select' === setting.control ) {
		return row( setting.label, select( String( raw ?? '' ), setting.options ?? [], write ), setting.hint );
	}

	if ( 'textarea' === setting.control ) {
		return row( setting.label, textArea( String( raw ?? '' ), write ), setting.hint );
	}

	if ( 'number' === setting.control ) {
		return row( setting.label, numberInput( String( raw ?? '' ), write ), setting.hint );
	}

	return row( setting.label, bind( textInput( String( raw ?? '' ), write ), setting.key ), setting.hint );
}

/** One row of a Likert matrix: the statement, and the key its answers are stored against. */
export interface LikertRow {
	key?: string;
	label?: string;
}

/**
 * Rewrites a Likert matrix's statements from a block of text, keeping their keys.
 *
 * A row is `{ key, label }`, and the *key* is what an answer is stored against —
 * `atf[f1][r2]`. So a key has to survive its wording changing, or correcting a
 * typo in a statement silently detaches every answer already given to it, in
 * entries collected months ago that nobody looks at again until an export.
 *
 * Rows are matched to lines by position: line three keeps row three's key however
 * it is reworded. A line added at the end mints a fresh key, never one that has
 * been used before, because reusing a key would attach new answers to old ones.
 *
 * Reordering the lines does move the answers with the positions. That is the one
 * case this gets wrong, and it is also indistinguishable from here from having
 * rewritten both statements; the alternative costs a visible id per row in the
 * box, which is a worse trade for the common case.
 *
 * @param rows The rows as they stand.
 * @param text One statement per line.
 * @return The new rows.
 */
export function restatement( rows: LikertRow[], text: string ): LikertRow[] {
	const used = new Set( rows.map( ( statement ) => statement.key ).filter( Boolean ) as string[] );
	let next = rows.length + 1;

	return text
		.split( '\n' )
		.map( ( line ) => line.trim() )
		.filter( Boolean )
		.map( ( label, index ) => {
			const existing = rows[ index ]?.key;

			if ( existing ) {
				return { key: existing, label };
			}

			while ( used.has( `r${ next }` ) ) {
				next += 1;
			}

			used.add( `r${ next }` );

			return { key: `r${ next }`, label };
		} );
}

/**
 * Where a field moves when it is sent to a slot.
 *
 * `index` names the slot in the list *without* the moved field — the indexing
 * `insertionIndex()` produces when the dragged card is excluded, and the one
 * the drop marker is drawn with. One convention for the marker, the drop and
 * Alt+Arrow, because they used to disagree: an index counted *with* the field
 * still in place has to be corrected by one on every downward move, and each
 * caller got that correction wrong in a different way — the drop landed one
 * slot above its marker, and Alt+ArrowDown cancelled itself out entirely.
 *
 * @param fields  The list as it stands.
 * @param fieldId The field to move.
 * @param index   The slot to take, counted with the field lifted out.
 * @return Remove-at and insert-at positions, or null when nothing would move.
 */
export function fieldMove(
	fields: ReadonlyArray< { id: string } >,
	fieldId: string,
	index: number
): { from: number; to: number } | null {
	const from = fields.findIndex( ( field ) => field.id === fieldId );

	if ( from < 0 ) {
		return null;
	}

	// The list is one shorter with the field lifted out, so its last slot is
	// `length - 1` — which is also where inserting back at `from` puts the
	// field exactly where it was.
	const to = Math.max( 0, Math.min( index, fields.length - 1 ) );

	return to === from ? null : { from, to };
}

const PREFILL_SOURCES: Array< { value: string; label: string; group: string; tag?: string } > = [
	{ value: 'user:email', label: 'Their email address', group: 'About the person filling it in', tag: '{user:email}' },
	{ value: 'user:display_name', label: 'Their name', group: 'About the person filling it in', tag: '{user:display_name}' },
	{ value: 'user:first_name', label: 'Their first name', group: 'About the person filling it in' },
	{ value: 'user:last_name', label: 'Their last name', group: 'About the person filling it in' },
	{ value: 'user:login', label: 'Their username', group: 'About the person filling it in' },
	{ value: 'date:today', label: 'Today’s date', group: 'The date and time', tag: '{date}' },
	{ value: 'date:now', label: 'The time right now', group: 'The date and time', tag: '{time}' },
	{ value: 'site', label: 'This site’s name', group: 'About this site', tag: '{site}' },
	{ value: 'site:url', label: 'This site’s address', group: 'About this site', tag: '{site:url}' },
	{ value: 'site:admin_email', label: 'The site administrator’s email', group: 'About this site', tag: '{admin_email}' },
];

/** The `optgroup` headings, in order. */
const PREFILL_GROUPS = [ 'About the person filling it in', 'The date and time', 'About this site' ];
import type {
	BuilderConfig,
	Choice,
	Confirmation,
	Field,
	FieldType,
	Form,
	FormSchema,
	FormSummary,
	Logic,
	LogicRule,
	Notification,
	Theme,
} from './types';
import { FIELD_PAYLOAD_TYPE, MEDIA_PAYLOAD_TYPES } from './types';

const i18n = ( key: string, fallback: string ): string => runtime?.i18n?.[ key ] ?? fallback;
const validatePackage = packageValidator( packageContract );

/** The builder, mounted into one root element. */
export class Builder {
	private readonly root: HTMLElement;

	private config: BuilderConfig | null = null;
	private themes: Theme[] = [];
	private forms: FormSummary[] = [];

	private form: Form | null = null;
	private schema: FormSchema | null = null;
	private selected: string | null = null;
	private tab: 'build' | 'theme' | 'settings' | 'notify' | 'confirm' = 'build';

	/** The conditional-logic overlay, when the canvas has one. */
	private logicMap: LogicMap | null = null;

	/** The form theme's custom properties, applied to the canvas previews. */
	private readonly canvasTheme = el( 'style' );

	/** Which theme the canvas is currently painted with, so it repaints once. */
	private canvasThemeSignature = '';

	/**
	 * Which disclosure panels are open, by key.
	 *
	 * A `<details>` keeps its open state in the element, and the inspector and the
	 * canvas rebuild their elements on every change — so without this, opening
	 * Conditional logic and then editing anything inside it folds the panel up
	 * around the control you are still using.
	 *
	 * Keyed rather than positional so it survives a field being reordered,
	 * renamed or deleted: the key names the *thing*, not the row it was in.
	 */
	private openSections = new Map< string, boolean >();

	/**
	 * Whether to draw the logic connections.
	 *
	 * On by default, and remembered per browser once somebody says otherwise. A
	 * form with a dozen conditions draws a dozen curves, and somebody laying out
	 * fields may want them out of the way for a minute — a view that cannot be
	 * turned off stops being a view and becomes something to work around.
	 *
	 * The test is against `'off'` rather than for `'on'`, so an unset preference
	 * and an unreadable one both mean on. Storage is unavailable in private mode,
	 * and a feature that quietly disappears there would be the wrong default in
	 * the one session where nothing can be remembered.
	 */
	private logicMapOn: boolean = 'off' !== readSetting( LOGIC_MAP_SETTING );
	private dirty = false;

	/**
	 * Counts edits, so a save response can tell whether it is stale.
	 *
	 * Read when a save request's body is built and compared when its response
	 * lands. If the counter moved in between, the person edited while the
	 * request was in flight — the response describes a schema older than the
	 * one on screen, and adopting it would silently destroy those edits.
	 */
	private editGeneration = 0;

	/** Whether a save request is out right now. Saves are serialised, never raced. */
	private saveInFlight = false;

	private assistantSaving = false;

	/**
	 * At most one save waiting behind the in-flight one.
	 *
	 * One is enough: the follow-up reads the schema when it runs, so a single
	 * trailing request carries however many edits arrived mid-flight. `silent`
	 * is false if any of the collapsed requests wanted a notice.
	 */
	private queuedSave: { silent: boolean } | null = null;

	private readonly bar: HTMLElement;
	private readonly palette: HTMLElement;
	private readonly canvas: HTMLElement;
	private readonly inspector: HTMLElement;

	private teardowns: Array< () => void > = [];

	/**
	 * Undoes the current canvas drop-target registration.
	 *
	 * Held apart from `teardowns` because it turns over with every canvas
	 * render — every inspector keystroke — and an entry pushed per render is a
	 * document-level move listener leaked per keystroke, all alive until the
	 * window closes.
	 */
	private canvasTarget: ( () => void ) | null = null;

	/**
	 * Schema snapshots, oldest first, for undo and redo.
	 *
	 * Whole-schema snapshots rather than a command log, because a schema is a
	 * few kilobytes of JSON and a command log would need an inverse for every
	 * operation the builder can ever perform — including the ones added later,
	 * which is exactly where a command log quietly stops being correct.
	 */
	private history: string[] = [];
	private historyAt = -1;

	public constructor( root: HTMLElement ) {
		this.root = root;
		this.bar = root.querySelector< HTMLElement >( '[data-atfb-bar]' ) ?? el( 'div' );
		this.palette = root.querySelector< HTMLElement >( '[data-atfb-palette]' ) ?? el( 'div' );
		this.canvas = root.querySelector< HTMLElement >( '[data-atfb-canvas]' ) ?? el( 'div' );
		this.inspector = root.querySelector< HTMLElement >( '[data-atfb-inspector]' ) ?? el( 'div' );

		// Clicking the canvas's empty space puts the selection down. In a
		// narrow window that is also what folds the inspector away and brings
		// the palette back — the two rails are mutually exclusive there, and
		// this is the gesture that swaps them home. Anything interactive, or a
		// card itself, keeps the click.
		this.canvas.addEventListener( 'click', ( event ) => {
			const target = event.target as HTMLElement;

			if (
				this.tab !== 'build' ||
				! this.selected ||
				target.closest( '[data-atfb-card], button, os-button, a, input, textarea, select, os-select, label, [contenteditable]' )
			) {
				return;
			}

			this.putSelectionDown();
		} );
	}

	/**
	 * Puts the selection down without touching the canvas's structure.
	 *
	 * The canvas's empty space does this on click; the inspector's own Done
	 * does it where that space is too scarce to hit — a phone shows one pane
	 * at a time, and while the inspector is up there is no canvas to click.
	 */
	private putSelectionDown(): void {
		this.selected = null;

		for ( const card of this.canvas.querySelectorAll( '.atfb-card.is-selected' ) ) {
			card.classList.remove( 'is-selected' );
		}

		this.renderInspector();
	}

	/**
	 * Opens or closes the palette fly-over a phone-width window uses.
	 *
	 * Below 640px the palette has no resting track; the canvas's "Add a
	 * field" button opens it over the canvas and a tap on a chip closes it
	 * again. At any wider width the class changes nothing — the stylesheet
	 * only reads it inside that container query — so this is safe to call
	 * unconditionally. The fly-over and a selection are exclusive: opening
	 * one puts the other down, since the two rails share one track there.
	 */
	private togglePalette( open: boolean ): void {
		if ( open && this.selected ) {
			this.putSelectionDown();
		}

		this.root.classList.toggle( 'atfb--palette-open', open );

		if ( open ) {
			this.palette.querySelector< HTMLElement >( '.atfb-palette__search' )?.focus();
		}
	}

	/** Loads everything and paints. */
	public async start(): Promise< void > {
		try {
			const [ config, themes, forms ] = await Promise.all( [ api.config(), api.listThemes(), api.listForms() ] );

			this.config = config;
			this.themes = themes;
			this.forms = forms;
		} catch ( error ) {
			this.fail( error );

			return;
		}

		this.teardowns.push( watchShellDragVisuals( [ FIELD_PAYLOAD_TYPE ] ) );

		// The eye in the window's title bar, matching the shell's own
		// editor-preview convention. Registered with a view onto this builder
		// rather than a snapshot, so the button always previews whichever form
		// is open now.
		this.teardowns.push(
			registerPreviewButton( {
				current: () =>
					this.form
						? { id: this.form.id, title: this.form.title, previewUrl: this.form.previewUrl }
						: null,
				isDirty: () => this.dirty,
				save: () => this.save( true ),
			} )
		);

		// Leaving with unsaved work is the one thing a builder must never do
		// quietly. Registered once, and only ever fires while `dirty` is true.
		const beforeUnload = ( event: BeforeUnloadEvent ) => {
			if ( this.dirty ) {
				event.preventDefault();
				event.returnValue = '';
			}
		};

		window.addEventListener( 'beforeunload', beforeUnload );
		this.teardowns.push( () => window.removeEventListener( 'beforeunload', beforeUnload ) );

		// Undo and redo. Bound on the root rather than the document so two
		// builder windows open at once each answer their own keystrokes, and
		// skipped while focus is in a text control, where the browser's own undo
		// is what the user means.
		const onKey = ( event: KeyboardEvent ) => {
			if ( ! ( event.metaKey || event.ctrlKey ) || event.key.toLowerCase() !== 'z' ) {
				return;
			}

			const target = event.target as HTMLElement | null;

			if ( target?.closest( 'input, textarea, [contenteditable]' ) ) {
				return;
			}

			event.preventDefault();
			this.travel( event.shiftKey ? 1 : -1 );
		};

		this.root.addEventListener( 'keydown', onKey );
		this.teardowns.push( () => this.root.removeEventListener( 'keydown', onKey ) );

		this.renderBar();
		this.renderPalette();

		if ( this.forms.length ) {
			// A deep link's form wins over the most recent one.
			const requested = takeFormFor( 'builder' );

			await this.open(
				requested && this.forms.some( ( form ) => form.id === requested ) ? requested : this.forms[ 0 ].id
			);
		} else {
			this.renderFormsList();
		}
		this.teardowns.push( mountFormMio( {
			root: this.root,
			read: () => this.assistantSnapshot(),
			prepare: async () => {
				if ( this.saveInFlight || this.assistantSaving ) throw new Error( 'Wait for the current save to finish.' );
			},
			options: () => ( { config: this.config, themes: this.themes } ),
			apply: this.applyAssistant,
		} ) );
	}

	/** Snapshot includes the form identity, all settings and edits since the last read. */
	private assistantSnapshot(): EditorSnapshot {
		const draft = { title: this.form?.title ?? 'Untitled form', schema: this.schema ?? { version: 1, fields: [], settings: {}, notifications: [], confirmations: [], actions: [] } };
		return {
			formId: this.form?.id ?? 0,
			fingerprint: JSON.stringify( [ this.form?.id, this.editGeneration, draft ] ),
			draft: structuredClone( draft ) as EditorSnapshot['draft'],
			busy: this.saveInFlight || this.assistantSaving,
			dirty: this.dirty,
		};
	}

	/** Saves only a validated receipt while keeping late responses out of another form. */
	private readonly applyAssistant: FormAssistantHost['apply'] = async ( draft, mode, snapshot, revision, signal, operationKey ) => {
		if ( signal.aborted || ! this.root.isConnected || this.assistantSnapshot().fingerprint !== snapshot.fingerprint || this.saveInFlight || this.assistantSaving ) {
			throw new Error( 'The editor changed or is saving. Read it again before applying.' );
		}
		this.assistantSaving = true;
		const wasInert = this.root.inert;
		this.root.inert = true;
		try {
			const saved = await api.assistantApply( draft, mode === 'update' ? snapshot.formId : 0, revision, signal, operationKey );
			if ( signal.aborted || ! this.root.isConnected || this.assistantSnapshot().fingerprint !== snapshot.fingerprint ) {
				// Preserve the authoritative receipt without painting into a stale editor.
				return saved;
			}
			this.form = saved;
			this.schema = saved.schema;
			this.dirty = false;
			this.selected = null;
			this.editGeneration++;
			if ( mode === 'create' ) { this.history = []; this.historyAt = -1; }
			this.snapshot();
			const previous = this.forms.find( ( item ) => item.id === saved.id );
			this.forms = [ {
				unread: 0, views: 0, submissions: 0, ...previous,
				id: saved.id, title: saved.title, status: saved.status, modified: saved.modified,
				fields: saved.schema.fields.length, theme: saved.schema.settings.theme, entries: saved.entries, shortcode: saved.shortcode,
			}, ...this.forms.filter( ( item ) => item.id !== saved.id ) ];
			forgetMergeTags( saved.id );
			refreshPreview( saved.id, saved.title, saved.previewUrl );
			this.renderBar();
			this.renderCanvas();
			this.renderInspector();
			this.announceIdentity();
			return saved;
		} finally {
			this.assistantSaving = false;
			this.root.inert = wasInert;
		}
	};

	/** Releases every listener this instance registered. */
	public destroy(): void {
		this.canvasTarget?.();
		this.canvasTarget = null;

		this.teardowns.forEach( ( teardown ) => teardown() );
		this.teardowns = [];
	}

	/** Shows a load failure rather than an empty window. */
	private fail( error: unknown ): void {
		clear( this.bar );

		this.bar.append(
			el( 'p', {
				class: 'atfb-error',
				text:
					error instanceof Error
						? error.message
						: 'Something went wrong loading your forms.',
			} )
		);
	}

	/* ------------------------------------------------------------- Toolbar */

	/** The top bar: form picker, tabs, save. */
	private renderBar(): void {
		clear( this.bar );

		const picker = select(
			String( this.form?.id ?? '' ),
			[
				...this.forms.map( ( form ) => ( { value: String( form.id ), label: form.title || '(untitled)' } ) ),
			],
			( value ) => void this.open( Number( value ) )
		);

		picker.setAttribute( 'aria-label', 'Choose a form' );

		const title = el( 'input', {
			class: 'atfb-title',
			type: 'text',
			value: this.form?.title ?? '',
			placeholder: 'Untitled form',
			attrs: { 'aria-label': 'Form title' },
			on: {
				input: ( event: Event ) => {
					if ( this.form ) {
						this.form.title = ( event.target as HTMLInputElement ).value;
						this.markDirty();
					}
				},
			},
		} );

		const tabs = el( 'div', {
			class: 'atfb-tabs',
			attrs: { role: 'tablist' },
			children: (
				[
					[ 'build', 'Build' ],
					[ 'theme', 'Theme' ],
					[ 'settings', 'Settings' ],
					[ 'notify', 'Notifications' ],
					[ 'confirm', 'Confirmations' ],
				] as const
			).map( ( [ id, label ] ) =>
				el( 'button', {
					class: `atfb-tab${ this.tab === id ? ' is-active' : '' }`,
					type: 'button',
					text: label,
					attrs: { role: 'tab', 'aria-selected': this.tab === id },
					on: {
						click: () => {
							this.tab = id;
							this.renderBar();
							this.renderInspector();
							this.renderCanvas();
						},
					},
				} )
			),
		} );

		this.bar.append(
			el( 'div', {
				class: 'atfb-bar__left',
				children: [ this.forms.length > 1 ? picker : null, title ],
			} ),
			tabs,
			el( 'div', {
				class: 'atfb-bar__right',
				children: [
					// No save-status label here. OpenStation's title bar already
					// carries one — the activity ring that `wp.os.fetch` drives,
					// which every request in `api.ts` goes through — so a second
					// one in the toolbar is the same information twice, in the
					// less prominent place. The Save button below shows whether
					// there is anything to save; the window says what happened
					// to it.
					//
					// Undo and redo are also Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z; the
					// buttons exist because a builder whose only undo is a
					// shortcut is a builder most people never discover has one.
					this.historyButton( 'undo', 'Undo', -1 ),
					this.historyButton( 'redo', 'Redo', 1 ),
					button( 'New', () => void this.showTemplates(), 'secondary', 'plus-alt2' ),
					button( 'Export', () => void this.exportForm(), 'secondary', 'download' ),
					button( 'Import', () => void this.importForm(), 'secondary', 'upload' ),
					button( 'Validate YAML', () => void this.importForm( true ), 'secondary', 'yes-alt' ),
					// The same action the title bar's eye performs, for the admin
					// page — where there is no title bar to put an eye in.
					button( 'Preview', () => void this.preview(), 'secondary', 'visibility' ),
					button( 'Entries', () => this.openEntries(), 'secondary', 'list-view' ),
					this.logicMapButton(),
					this.saveButton(),
				],
			} )
		);
	}

	/**
	 * The field with this id in the *current* schema.
	 *
	 * Returns undefined when it has gone — deleted in another window, or dropped
	 * by the server's normalisation — which is a write that should simply not
	 * happen rather than one that should throw.
	 *
	 * @param fieldId The field's id.
	 * @return The live field, if it is still there.
	 */
	private liveField( fieldId: string ): Field | undefined {
		return this.locateField( fieldId )?.field;
	}

	/**
	 * A field found wherever it lives — the top level, or inside a repeater —
	 * along with the list holding it, so a caller can move or remove it.
	 *
	 * @param fieldId The field's id.
	 * @return The field, the list it sits in, its index there, and the repeater
	 *         containing it (null at the top level).
	 */
	private locateField(
		fieldId: string
	): { field: Field; list: Field[]; index: number; parent: Field | null } | undefined {
		const fields = this.schema?.fields ?? [];

		for ( let index = 0; index < fields.length; index++ ) {
			if ( fields[ index ].id === fieldId ) {
				return { field: fields[ index ], list: fields, index, parent: null };
			}

			const subs = ( fields[ index ].fields ?? [] ) as Field[];

			for ( let at = 0; at < subs.length; at++ ) {
				if ( subs[ at ].id === fieldId ) {
					return { field: subs[ at ], list: subs, index: at, parent: fields[ index ] };
				}
			}
		}

		return undefined;
	}

	/**
	 * Writes a field's current values into its card on the canvas.
	 *
	 * The mirror image of `syncInspector()`, for the same reason: the two panes
	 * edit one value and have to agree while it is being typed. The inspector's
	 * `update()` already repaints the canvas wholesale, but the choices editor
	 * mutates in place and only marks the form dirty — which was invisible until
	 * the canvas started drawing the options.
	 *
	 * Writes `textContent` rather than re-rendering, so the caret in the
	 * inspector is untouched.
	 *
	 * Driven by whatever `data-atfb-bind` keys the card happens to carry rather
	 * than by a list of properties kept here. The list was the bug waiting to
	 * happen: every editable added to the canvas had to be remembered in two
	 * other places, and forgetting one gave a value that mirrored in one
	 * direction only — which looks like it works right up until you use the other
	 * pane.
	 *
	 * @param field The field that was edited in the inspector.
	 */
	private syncCanvas( field: Field ): void {
		// A repeater sub-field's editables live on its smaller card.
		const card =
			this.canvas.querySelector< HTMLElement >( `[data-atfb-card="${ CSS.escape( field.id ) }"]` ) ??
			this.canvas.querySelector< HTMLElement >( `[data-atfb-subfield="${ CSS.escape( field.id ) }"]` );

		if ( ! card ) {
			return;
		}

		for ( const node of card.querySelectorAll< HTMLElement >( '.atfb-editable[data-atfb-bind]' ) ) {
			const value = boundValue( field, node.dataset.atfbBind ?? '' );

			// Compared before writing, and not only to save a DOM write: this runs
			// while somebody is typing in the *other* pane, and assigning to
			// `textContent` collapses the selection. Writing only on a real change
			// keeps the caret where it is in every element that already agrees.
			if ( node.textContent !== value ) {
				node.textContent = value;
			}
		}
	}

	/**
	 * Writes a field's current values into the inspector's matching controls.
	 *
	 * Only when the inspector is actually showing that field — editing a card that
	 * is not selected must not rewrite the pane describing a different one.
	 *
	 * Deliberately one-directional and value-only: the inspector's own handlers
	 * already write to the schema, and firing them from here would put the two
	 * panes in a loop, each telling the other about a change it had just made.
	 *
	 * @param field The field that was edited on the canvas.
	 */
	private syncInspector( field: Field ): void {
		if ( this.selected !== field.id ) {
			return;
		}

		for ( const control of this.inspector.querySelectorAll< HTMLElement & { value?: string } >(
			'[data-atfb-bind]'
		) ) {
			const value = boundValue( field, control.dataset.atfbBind ?? '' );

			if ( control.value === value ) {
				continue;
			}

			// `value` is a property on a native input and on the shell's field
			// components alike; the attribute is the fallback for anything that
			// only reflects it.
			if ( 'value' in control ) {
				control.value = value;
			} else {
				control.setAttribute( 'value', value );
			}
		}
	}

	/**
	 * Rebuilds the canvas so its cards point at the current schema objects.
	 *
	 * Deferred while the canvas holds focus. An autosave fires 2.5 seconds after
	 * the last keystroke, which is exactly when somebody has paused mid-sentence
	 * with the caret still in a label — and rebuilding then would take the caret
	 * away for no reason they could see. Waiting for the blur costs nothing: the
	 * card on screen already shows what they typed, and the rebind only has to
	 * happen before the *next* edit.
	 */
	private rebindCanvas(): void {
		// Rebinding exists for every pane whose controls close over schema
		// objects that an adopted save response has just replaced: the Build
		// tab's field cards, and the confirmations and notifications lists,
		// whose Name boxes and condition editors each hold the object they
		// were rendered from. Typing into any of them after an autosave would
		// otherwise update an object nothing serialises — which is exactly how
		// a confirmation's freshly added rule managed to vanish without a
		// single error.
		//
		// The Theme tab stays out: it holds a mounted studio with a live
		// preview, a scroll position and half-typed test answers, and its
		// controls write through `this.schema` — rebuilding it after every
		// autosave threw all of that away to fix a problem it does not have.
		if ( 'build' !== this.tab && 'confirm' !== this.tab && 'notify' !== this.tab ) {
			return;
		}

		const focused = document.activeElement;

		if ( focused instanceof HTMLElement && this.canvas.contains( focused ) ) {
			// Wait for focus to reach its next control (including the value picker).
			// During blur, activeElement is temporarily the body.
			focused.addEventListener( 'blur', () => queueMicrotask( () => this.rebindCanvas() ), { once: true } );

			return;
		}

		// A popup option can briefly return focus to the body between pointerdown
		// and click. Replacing its host then swallows the selection. Wait until
		// the pointer leaves the canvas as well as its keyboard focus.
		if ( this.canvas.matches( ':hover' ) ) {
			this.canvas.addEventListener( 'pointerleave', () => this.rebindCanvas(), { once: true } );
			return;
		}

		this.renderCanvas();
	}

	/**
	 * Takes a history snapshot.
	 *
	 * Called before a *structural* change — adding, moving, duplicating or
	 * deleting a field — and not on every keystroke. Snapshotting each character
	 * typed into a label would make undo mean "remove one letter", which is not
	 * what anybody reaches for it to do.
	 */
	private snapshot(): void {
		if ( ! this.schema ) {
			return;
		}

		const json = JSON.stringify( this.schema );

		if ( this.history[ this.historyAt ] === json ) {
			return;
		}

		// Anything ahead of the cursor is a branch the user abandoned by making
		// a new change after undoing, so it is discarded — the same rule every
		// editor follows.
		this.history = this.history.slice( 0, this.historyAt + 1 );
		this.history.push( json );

		// Bounded, because a long session should not grow without limit.
		if ( this.history.length > 60 ) {
			this.history.shift();
		}

		this.historyAt = this.history.length - 1;

		// Structural edits snapshot without rebuilding the toolbar — rebuilding
		// would take the focus of whoever is typing in the title box — so the
		// Undo and Redo buttons are refreshed where they stand instead.
		this.syncHistoryButtons();
	}

	/** Steps backwards or forwards through the history. */
	private travel( delta: number ): void {
		const next = this.historyAt + delta;

		if ( ! this.schema || next < 0 || next >= this.history.length ) {
			return;
		}

		this.historyAt = next;
		this.schema = JSON.parse( this.history[ next ] ) as FormSchema;

		// A field that no longer exists cannot stay selected, or the inspector
		// renders settings for something that is not on the canvas.
		if ( ! this.schema.fields.some( ( field ) => field.id === this.selected ) ) {
			this.selected = null;
		}

		this.markDirty();

		this.renderBar();
		this.renderCanvas();
		this.renderInspector();
	}

	/** An undo or redo button, disabled when there is nowhere to go. */
	private historyButton( iconSlug: string, label: string, delta: number ): HTMLElement & { disabled: boolean } {
		const node = button( label, () => this.travel( delta ), 'secondary', iconSlug );

		// Tagged with its direction so `syncHistoryButtons()` can find it again:
		// the buttons outlive many snapshots, and only `renderBar()` rebuilds them.
		node.setAttribute( 'data-atfb-history', String( delta ) );
		node.disabled = ! this.canTravel( delta );

		return node;
	}

	/** Whether the history has anywhere to go in this direction. */
	private canTravel( delta: number ): boolean {
		const target = this.historyAt + delta;

		return target >= 0 && target < this.history.length;
	}

	/**
	 * Refreshes Undo and Redo's disabled state in place.
	 *
	 * The state was computed only in `renderBar()`, which structural edits never
	 * call — so Undo sat disabled all session while Cmd+Z quietly worked. The
	 * buttons are updated whenever the history moves instead.
	 */
	private syncHistoryButtons(): void {
		for ( const node of this.bar.querySelectorAll< HTMLElement & { disabled: boolean } >(
			'[data-atfb-history]'
		) ) {
			node.disabled = ! this.canTravel( Number( node.dataset.atfbHistory ) );
		}
	}

	/** Keeps validation details visible and copyable until dismissed. */
	private showPackageResult( title: string, message: string ): void {
		if ( ! this.root.isConnected ) return;
		const dialog = el( 'dialog', { class: 'atfb-package-dialog', attrs: { 'aria-label': title } } );
		dialog.append(
			el( 'h2', { text: title } ),
			el( 'pre', { text: message } ),
			button( 'Close', () => dialog.close() )
		);
		dialog.addEventListener( 'close', () => dialog.remove(), { once: true } );
		this.root.append( dialog );
		dialog.showModal();
	}

	/** Downloads the current editor snapshot with its theme and image assets. */
	private async exportForm(): Promise< void > {
		if ( ! this.form || ! this.schema ) return;
		const id = this.form.id;
		const title = this.form.title;
		const schema = JSON.parse( JSON.stringify( this.schema ) ) as FormSchema;
		try {
			const payload = packageObjects( await api.exportForm( id, { title, schema } ), packageContract );
			validatePackage( payload );
			const yaml = stringifyPackage( payload );
			// The exported file must satisfy the same byte limit as the picker.
			if ( new TextEncoder().encode( yaml ).length > MAX_PACKAGE_BYTES ) {
				throw new Error( 'The form package exceeds the 16 MiB limit.' );
			}
			const url = URL.createObjectURL( new Blob( [ yaml ], { type: 'application/yaml' } ) );
			const link = el( 'a', {
				href: url,
				attrs: { download: `${ title.replace( /[^a-z0-9]+/gi, '-' ).toLowerCase() || 'form' }.yaml` },
			} );
			document.body.append( link );
			link.click();
			link.remove();
			window.setTimeout( () => URL.revokeObjectURL( url ), 1000 );
		} catch ( error ) {
			this.showPackageResult( 'Could not export this form', error instanceof Error ? error.message : '' );
		}
	}

	/** Validates YAML/JSON before importing a new draft, or performs a dry run. */
	private async importForm( validateOnly = false ): Promise< void > {
		const picker = el( 'input', { type: 'file', attrs: { accept: '.yaml,.yml,.json,application/yaml,application/json' } } );
		picker.addEventListener( 'change', async () => {
			const file = picker.files?.[ 0 ];
			if ( ! file ) return;
			try {
				if ( file.size > MAX_PACKAGE_BYTES ) throw new Error( 'The form package exceeds the 16 MiB limit.' );
				const parsed = parsePackage( await file.text() );
				validatePackage( parsed );
				const checked = await api.validateFormPackage( parsed );
				if ( validateOnly ) {
					this.showPackageResult( 'Valid form package', checked.warnings.join( '\n' ) || 'The form, theme and images are ready to import.' );
					return;
				}
				// Do not discard the open form's unsaved work when adopting the import.
				if ( this.dirty ) {
					await this.save();
					if ( this.dirty || this.saveInFlight ) throw new Error( 'Wait for the current form to finish saving before importing another one.' );
				}
				if ( this.saveInFlight ) throw new Error( 'Wait for the current form to finish saving before importing another one.' );
				const sourceId = this.form?.id;
				const generation = this.editGeneration;
				const created = await api.importFormPackage( parsed );
				// A failed theme-list refresh must not make a completed import look failed.
				try { this.themes = await api.listThemes(); } catch { /* Refreshed on the next open. */ }

				this.forms.unshift( {
					id: created.id,
					title: created.title,
					status: created.status,
					modified: created.modified,
					fields: created.schema.fields.length,
					theme: created.schema.settings.theme,
					entries: 0,
					unread: 0,
					views: 0,
					submissions: 0,
					shortcode: created.shortcode,
				} );

				if ( this.form?.id !== sourceId || this.editGeneration !== generation || this.dirty || this.saveInFlight ) {
					this.renderBar();
					notify( 'Form imported as a draft', `${ created.title } is available in the form picker. Your current edits are still open.` );
					return;
				}

				this.form = created;
				this.schema = created.schema;
				this.selected = null;
				this.dirty = false;
				this.history = [];
				this.historyAt = -1;
				this.snapshot();

				this.renderBar();
				this.renderCanvas();
				this.renderInspector();

				this.announceIdentity();
				this.showPackageResult( 'Form imported as a draft', [ created.title, ...( created.importWarnings ?? [] ) ].join( '\n' ) );
			} catch ( error ) {
				this.showPackageResult( validateOnly ? 'Validation failed' : 'Could not import that file', error instanceof Error ? error.message : '' );
			}
		} );

		picker.click();
	}

	/**
	 * The Save button, which is the only place unsaved state is shown.
	 *
	 * Disabled while there is nothing to save, so the button itself answers "is
	 * my work in?" without a label beside it repeating the answer.
	 */
	private saveButton(): HTMLElement & { disabled: boolean } {
		const node = button( 'Save', () => void this.save(), 'primary' );

		node.disabled = ! this.dirty;
		node.setAttribute( 'data-atfb-save', '' );

		return node;
	}

	/** Marks the form as having unsaved changes and schedules an autosave. */
	private markDirty(): void {
		this.dirty = true;
		this.editGeneration += 1;

		// Only the button changes, so the whole toolbar is not rebuilt on every
		// keystroke — which would drop the focus of whoever is typing in it.
		const save = this.bar.querySelector< HTMLElement & { disabled: boolean } >( '[data-atfb-save]' );

		if ( save ) {
			save.disabled = false;
		}

		this.autosave();
	}

	/**
	 * Saves a couple of seconds after the last edit.
	 *
	 * Long enough that typing a label is one save rather than fifteen, short
	 * enough that closing the window straight after an edit does not lose it.
	 */
	private readonly autosave = debounce( () => {
		void this.save( true );
	}, 2500 );

	/** Writes the form back. */
	private async save( silent = false ): Promise< void > {
		if ( ! this.form || ! this.schema || this.assistantSaving || ( silent && ! this.dirty ) ) {
			return;
		}

		// One request at a time. Two saves in flight can resolve out of order,
		// and the older response arriving last would put the older schema back.
		// A save asked for meanwhile is queued — once — and runs after this one,
		// reading the schema fresh when it does.
		if ( this.saveInFlight ) {
			this.queuedSave = { silent: silent && ( this.queuedSave?.silent ?? true ) };

			return;
		}

		this.saveInFlight = true;

		// Read as the request body is built. If it has moved by the time the
		// response lands, edits were made mid-flight and the response is stale.
		const generation = this.editGeneration;

		try {
			const saved = await api.updateForm( this.form.id, {
				title: this.form.title,
				schema: this.schema,
			} );

			// The server's normalisation is authoritative — it may have issued
			// ids, dropped an unusable field or clamped a setting — so its copy
			// replaces the local one rather than being merged into it.
			//
			// Replacing it orphans every card on the canvas: each one closes over
			// the field object it was rendered from, and those objects are now the
			// *previous* schema's. Typing into a label after an autosave would
			// update an object nothing serialises, and the edit would vanish at the
			// next save with no error anywhere. So the canvas is rebuilt to rebind
			// — but not out from under somebody who is still typing in it.
			//
			// Adopted only while nothing changed in flight: an edit made after the
			// request left is not in `saved`, and replacing the schema — or
			// clearing `dirty` — would destroy it. The stale case keeps the local
			// copy, stays dirty, and lets the already-scheduled autosave carry the
			// newer edits up.
			if ( generation === this.editGeneration ) {
				this.form = saved;
				this.schema = saved.schema;
				this.dirty = false;

				this.rebindCanvas();

				const save = this.bar.querySelector< HTMLElement & { disabled: boolean } >( '[data-atfb-save]' );

				if ( save ) {
					save.disabled = true;
				}
			}

			// The merge-tag picker lists this form's questions by label, and the
			// server builds that list from the *saved* schema. Without this, a
			// question added or renamed a moment ago is missing from the picker for
			// the rest of the session, which reads as the picker being broken
			// rather than as a cache.
			forgetMergeTags( saved.id );

			const summary = this.forms.find( ( candidate ) => candidate.id === saved.id );

			if ( summary ) {
				summary.title = saved.title;
			}

			// A preview window open for this form is navigated to the fresh
			// render. Doing it here rather than in the preview module means an
			// autosave refreshes it too, so the paired window tracks the builder
			// without anybody pressing anything.
			refreshPreview( saved.id, saved.title, saved.previewUrl );

			if ( ! silent ) {
				notify( 'Form saved', saved.title );
			}
		} catch ( error ) {
			// A failed save is the one save event worth interrupting for, and
			// the shell's own status ring cannot say *why*.
			notify(
				i18n( 'saveFailed', 'Could not save' ),
				error instanceof Error ? error.message : '',
				'error'
			);
		} finally {
			this.saveInFlight = false;

			const queued = this.queuedSave;

			this.queuedSave = null;

			if ( queued ) {
				void this.save( queued.silent );
			}
		}
	}

	/* ---------------------------------------------------------------- Forms */

	/** Opens a form. */
	/**
	 * Deep-link entry: WP Explorer (and anything else) asks for a form by id.
	 *
	 * @param id The form to open on the canvas.
	 */
	public async openFormById( id: number ): Promise< void > {
		await this.open( id );
	}

	private async open( id: number ): Promise< void > {
		if ( this.assistantSaving ) return;
		if ( this.dirty && ! ( await confirmAction( 'You have unsaved changes. Discard them?' ) ) ) {
			return;
		}

		try {
			this.form = await api.getForm( id );
			this.schema = this.form.schema;
			this.selected = null;
			this.dirty = false;

			// The freshly-loaded schema is the history's first entry, so the first
			// undo returns to how the form was when it was opened rather than to
			// whatever the previously-open form looked like.
			this.history = [];
			this.historyAt = -1;
			this.snapshot();
		} catch ( error ) {
			this.fail( error );

			return;
		}

		this.renderBar();
		this.renderCanvas();
		this.renderInspector();
		this.announceIdentity();
	}

	/**
	 * Tells the shell which form this window is showing.
	 *
	 * That one call is what makes an entries window for the same form draw a tie
	 * to this one, and what fills the title bar's Related menu. Re-announced on
	 * every open, because the identity is the *form*, not the window.
	 */
	private announceIdentity(): void {
		if ( ! this.form ) {
			return;
		}

		setIdentity( this.root, formIdentity( this.form, runtime?.adminUrl ?? '' ) );
	}

	/** The template picker, for a new form. */
	private async showTemplates(): Promise< void > {
		if ( ! this.config ) {
			return;
		}

		const overlay = el( 'div', { class: 'atfb-overlay' } );

		// Named, so it can be removed however the dialog closes. A `{ once: true }`
		// listener is spent by the first keydown of *any* key — pressing anything
		// else first left Escape doing nothing — and closing via Cancel would
		// leave it behind to eat the next Escape pressed anywhere.
		const onKeydown = ( event: KeyboardEvent ) => {
			if ( event.key === 'Escape' ) {
				close();
			}
		};

		const close = () => {
			overlay.remove();
			document.removeEventListener( 'keydown', onKeydown );
		};

		const grid = el( 'div', {
			class: 'atfb-templates',
			children: this.config.templates.map( ( template ) =>
				el( 'button', {
					class: 'atfb-template',
					type: 'button',
					on: {
						click: async () => {
							close();

							try {
								const created = await api.createForm( { template: template.slug } );

								this.forms.unshift( {
									id: created.id,
									title: created.title,
									status: created.status,
									modified: created.modified,
									fields: created.schema.fields.length,
									theme: created.schema.settings.theme,
									entries: 0,
									unread: 0,
									views: 0,
									submissions: 0,
									shortcode: created.shortcode,
								} );

								this.form = created;
								this.schema = created.schema;
								this.selected = null;
								this.dirty = false;

								// A fresh form starts a fresh history, exactly as
								// `open()` and `importForm()` do. Kept, the first
								// Cmd+Z would restore the *previous* form's
								// snapshot — and autosave it under this form's id.
								this.history = [];
								this.historyAt = -1;
								this.snapshot();

								this.renderBar();
								this.renderCanvas();
								this.renderInspector();
								this.announceIdentity();
							} catch ( error ) {
								notify( 'Could not create the form', error instanceof Error ? error.message : '', 'error' );
							}
						},
					},
					children: [
						icon( template.icon ),
						el( 'strong', { text: template.label } ),
						el( 'span', { text: template.description } ),
					],
				} )
			),
		} );

		overlay.append(
			el( 'div', {
				class: 'atfb-modal',
				attrs: { role: 'dialog', 'aria-label': 'Start a new form' },
				children: [
					el( 'h2', { text: 'Start a new form' } ),
					grid,
					this.archivedFormsSection( close ),
					el( 'div', { class: 'atfb-modal__actions', children: [ button( 'Cancel', close ) ] } ),
				],
			} )
		);

		overlay.addEventListener( 'click', ( event ) => {
			if ( event.target === overlay ) {
				close();
			}
		} );

		document.addEventListener( 'keydown', onKeydown );

		this.root.append( overlay );
		grid.querySelector< HTMLElement >( 'button' )?.focus();
	}

	/**
	 * The archive's door, inside the "Start a new form" dialog.
	 *
	 * Restoring a retired form is a way of getting a form, so it lives where
	 * getting a form lives — not behind a settings tab on a form you would
	 * have to already have open. The list arrives asynchronously and the
	 * section simply is not there when the archive is empty, so the dialog
	 * costs nothing on the sites that never archive anything.
	 *
	 * @param close Closes the dialog this section sits in.
	 * @return The section, filled in when the archive answers.
	 */
	private archivedFormsSection( close: () => void ): HTMLElement {
		const section = el( 'div', { class: 'atfb-archived' } );

		void api
			.listArchivedForms()
			.then( ( archived ) => {
				if ( ! archived.length ) {
					return;
				}

				section.append(
					el( 'h3', { class: 'atfb-archived__title', text: 'Or bring one back from the archive' } ),
					...archived.map( ( form ) =>
						el( 'div', {
							class: 'atfb-archived__row',
							children: [
								el( 'div', {
									class: 'atfb-archived__meta',
									children: [
										el( 'strong', { text: form.title || '(untitled)' } ),
										el( 'span', {
											class: 'atfb-hint',
											text: `${ form.entries } ${ form.entries === 1 ? 'entry' : 'entries' } · ${
												form.submissions
											} submissions · ${ form.views } views`,
										} ),
									],
								} ),
								button(
									'Restore',
									async () => {
										try {
											const restored = await api.unarchiveForm( form.id );

											close();
											this.forms.unshift( restored );
											notify( 'Form restored', `${ restored.title || '(untitled)' } is back, with its entries and stats.` );
											await this.open( restored.id );
										} catch ( error ) {
											notify(
												'Could not restore the form',
												error instanceof Error ? error.message : '',
												'error'
											);
										}
									},
									'secondary',
									'undo'
								),
							],
						} )
					)
				);
			} )
			.catch( () => {
				// The dialog's job is starting a form; a failed archive lookup
				// must not break that, and an empty section says everything.
			} );

		return section;
	}

	/** Shown when the site has no forms at all. */
	private renderFormsList(): void {
		clear( this.canvas );

		this.canvas.append(
			el( 'div', {
				class: 'atfb-empty',
				children: [
					el( 'h2', { text: 'No forms yet' } ),
					el( 'p', { text: 'Start from a template, or build one from nothing.' } ),
					button( 'New form', () => void this.showTemplates(), 'primary', 'plus-alt2' ),
				],
			} )
		);
	}

	/** Opens the entries window, or the entries admin page. */
	private openEntries(): void {
		const shell = ( window as unknown as { wp?: { os?: { openWindow?: ( id: string ) => boolean } } } ).wp?.os;

		if ( shell?.openWindow ) {
			shell.openWindow( 'allterrain-forms-entries' );

			return;
		}

		window.location.assign( `${ runtime?.adminUrl ?? '' }admin.php?page=allterrain-forms-entries` );
	}

	/* -------------------------------------------------------------- Palette */

	/** Draws the field palette, grouped. */
	private renderPalette(): void {
		if ( ! this.config ) {
			return;
		}

		clear( this.palette );

		const grouped = new Map< string, FieldType[] >();

		for ( const type of this.config.fieldTypes ) {
			const list = grouped.get( type.group ) ?? [];

			list.push( type );
			grouped.set( type.group, list );
		}

		const search = el( 'input', {
			class: 'atfb-input atfb-palette__search',
			type: 'search',
			placeholder: 'Search fields',
			attrs: { 'aria-label': 'Search field types' },
			on: {
				input: ( event: Event ) => {
					const term = ( event.target as HTMLInputElement ).value.toLowerCase().trim();

					this.palette.querySelectorAll< HTMLElement >( '.atfb-chip' ).forEach( ( chip ) => {
						const label = ( chip.textContent ?? '' ).toLowerCase();

						chip.hidden = term !== '' && ! label.includes( term );
					} );

					// A group whose every chip is filtered out is hidden too,
					// so the palette does not end up as a list of empty
					// headings.
					this.palette.querySelectorAll< HTMLElement >( '.atfb-group' ).forEach( ( group ) => {
						const visible = Array.from( group.querySelectorAll< HTMLElement >( '.atfb-chip' ) ).some(
							( chip ) => ! chip.hidden
						);

						group.hidden = ! visible;
					} );
				},
			},
		} );

		// The head only shows in the phone fly-over, where the palette has a
		// way in (the canvas's "Add a field") and so needs a way out.
		const close = button( 'Close', () => this.togglePalette( false ), 'ghost', 'no-alt' );

		close.classList.add( 'atfb-palette__close' );

		this.palette.append(
			el( 'div', {
				class: 'atfb-palette__head',
				children: [ el( 'h3', { class: 'atfb-group__title', text: 'Add a field' } ), close ],
			} ),
			search
		);

		for ( const [ slug, label ] of Object.entries( this.config.groups ) ) {
			const types = grouped.get( slug );

			if ( ! types?.length ) {
				continue;
			}

			this.palette.append(
				el( 'div', {
					class: 'atfb-group',
					children: [
						el( 'h3', { class: 'atfb-group__title', text: label } ),
						el( 'div', {
							class: 'atfb-group__items',
							children: types.map( ( type ) => this.paletteChip( type ) ),
						} ),
					],
				} )
			);
		}
	}

	/**
	 * One palette entry.
	 *
	 * A real `<button>`, so it is reachable by keyboard and activating it adds
	 * the field to the end of the form. The drag is layered on top of that
	 * rather than replacing it — `onClickOnly` is what the drag manager calls
	 * when a press never travelled far enough to become a drag, so one element
	 * serves both interactions without a click firing after a drop.
	 */
	private paletteChip( type: FieldType ): HTMLElement {
		const chip = el( 'button', {
			class: 'atfb-chip',
			type: 'button',
			title: type.description,
			attrs: { 'data-atf-type': type.type },
			children: [ icon( type.icon ), el( 'span', { text: type.label } ) ],
		} );

		// Whether the drag manager took the current press. It declines one it
		// will not drive — the shell refuses every drag on a phone, and the
		// fallback refuses a second button — and a declined press never
		// reaches `onClickOnly`, so the click below has to add the field
		// itself. A keyboard activation has no press at all and lands there
		// too, which is what makes the chip a real button.
		let pressTaken = false;

		chip.addEventListener( 'pointerdown', ( event ) => {
			const ghost = el( 'div', {
				class: 'atfb-chip atfb-chip--ghost',
				children: [ icon( type.icon ), el( 'span', { text: type.label } ) ],
			} );

			pressTaken =
				null !==
				getDragManager().start( {
					payload: buildPayload( FIELD_PAYLOAD_TYPE, chip, { fieldType: type.type, isNew: true }, event, ghost ),
					origin: event,
					onClickOnly: () => {
						this.addField( type.type );
						this.togglePalette( false );
					},
				} );
		} );

		// A press that becomes a drag must not also fire a click. The manager
		// records when a drag ended, and that window is what this checks.
		chip.addEventListener( 'click', ( event ) => {
			const taken = pressTaken;

			pressTaken = false;

			if ( getDragManager().recentlyEndedDrag() ) {
				event.preventDefault();

				return;
			}

			if ( ! taken ) {
				this.addField( type.type );
				this.togglePalette( false );
			}
		} );

		return chip;
	}

	/* --------------------------------------------------------------- Canvas */

	/** Draws the canvas for the current tab. */
	private renderCanvas(): void {
		clear( this.canvas );

		if ( ! this.schema || ! this.form ) {
			this.renderFormsList();

			return;
		}

		if ( this.tab !== 'build' ) {
			this.canvas.append( this.renderTabCanvas() );

			return;
		}

		const list = el( 'div', { class: 'atfb-canvas__list', attrs: { 'data-atfb-list': '' } } );

		if ( ! this.schema.fields.length ) {
			list.append(
				el( 'div', {
					class: 'atfb-placeholder',
					text: i18n( 'emptyCanvas', 'Drag a field from the left to begin.' ),
				} )
			);
		}

		this.schema.fields.forEach( ( field, index ) => {
			list.append( this.renderFieldCard( field, index ) );
		} );

		const add = button( 'Add a field', () => this.togglePalette( true ), 'secondary', 'plus-alt2' );

		add.classList.add( 'atfb-canvas__add' );

		const inner = el( 'div', {
			class: 'atfb-canvas__inner',
			children: [
				el( 'p', {
					class: 'atfb-shortcode',
					text: this.form.shortcode,
					title: 'Paste this anywhere to place the form',
				} ),
				list,
				add,
			],
		} );

		this.canvas.append( inner );

		this.registerCanvasTarget( list );
		this.paintLogicMap( inner );

		// Repaints only when the theme or its overrides actually changed, so the
		// canvas does not ask the server for a render on every keystroke.
		void this.paintCanvasTheme();
	}

	/**
	 * Where a field's opening value comes from, asked in plain language.
	 *
	 * This box used to be free text under the hint
	 * `query:utm_source, user:email, user:name, site:name or date:today` — a list
	 * of five examples of a syntax nobody had been taught, two of which
	 * (`user:name`, `site:name`) were not even things the resolver understood. So
	 * the one person who typed exactly what the hint said got an empty field and
	 * no error, because an unrecognised source resolves to nothing.
	 *
	 * The sources are a closed set, so they are offered as a list. The stored
	 * value is still the same string — a form built before this opens in whichever
	 * mode its value already matches, and a plugin adding a source through
	 * `alltfo_resolve_prefill` still works via Advanced.
	 */
	private prefillControl( field: Field, update: ( key: string, value: unknown ) => void ): HTMLElement {
		// `query:` keeps its parameter name in a separate box, so the only thing
		// anybody types is the name itself.
		const isQuery = field.prefill.startsWith( 'query:' );
		const known = PREFILL_SOURCES.some( ( source ) => source.value === field.prefill );
		const mode = isQuery ? 'query' : ( known && field.prefill ) || ( field.prefill ? 'custom' : '' );

		const detail = el( 'div', { class: 'atfb-prefill__detail' } );
		const preview = el( 'p', { class: 'atfb-row__hint atfb-prefill__preview' } );

		const paint = ( current: string ) => {
			detail.replaceChildren();
			preview.replaceChildren();

			if ( 'query' === current ) {
				const name = field.prefill.startsWith( 'query:' ) ? field.prefill.slice( 6 ) : '';

				detail.append(
					textInput(
						name,
						( value ) => {
							const trimmed = value.trim();

							update( 'prefill', trimmed ? `query:${ trimmed }` : '' );
							paintPreview( `query:${ trimmed }` );
						},
						'utm_source'
					),
					el( 'p', {
						class: 'atfb-row__hint',
						text: 'The name of the parameter in the link people arrive on.',
					} )
				);
			}

			if ( 'custom' === current ) {
				detail.append(
					textInput(
						field.prefill,
						( value ) => {
							update( 'prefill', value );
							paintPreview( value );
						},
						'myplugin:something'
					),
					el( 'p', {
						class: 'atfb-row__hint',
						text: 'For a source another plugin has added through alltfo_resolve_prefill.',
					} )
				);
			}

			paintPreview( field.prefill );
		};

		// What the visitor will actually see in the box. The site's real values,
		// not invented ones — the whole reason the merge-tag catalogue is served
		// from PHP is that only the server knows them, and this reuses it rather
		// than growing a second endpoint that could disagree.
		const paintPreview = ( source: string ) => {
			preview.replaceChildren();

			if ( ! source ) {
				return;
			}

			if ( source.startsWith( 'query:' ) ) {
				const name = source.slice( 6 );

				if ( name ) {
					preview.textContent = `A visit to …/your-page/?${ name }=abc opens the form with “abc” in it.`;
				}

				return;
			}

			const tag = PREFILL_SOURCES.find( ( candidate ) => candidate.value === source )?.tag;

			if ( ! tag ) {
				return;
			}

			void mergeTags( this.form?.id ?? 0 ).then( ( groups ) => {
				for ( const group of groups ) {
					for ( const item of group.items ) {
						if ( item.tag === tag ) {
							// The caveat only belongs on the sources that have one. A
							// site name is a site name whoever is looking; an account
							// email is nothing at all to a visitor who never signed in,
							// and that is the difference worth stating.
							const personal = source.startsWith( 'user:' );

							if ( ! item.sample ) {
								preview.textContent = 'Empty unless the visitor is signed in.';

								return;
							}

							preview.textContent = personal
								? `Opens with “${ item.sample }” for you — empty for a visitor who is not signed in.`
								: `Opens with “${ item.sample }”.`;

							return;
						}
					}
				}
			} );
		};

		paint( mode );

		const picker = el( 'select', {
			class: 'atfb-input atfb-select',
			on: {
				change: ( event: Event ) => {
					const value = ( event.target as HTMLSelectElement ).value;

					// `query` and `custom` are modes, not sources: what gets stored
					// depends on what is typed into the box they reveal. Clearing
					// first means switching away from `user:email` and typing nothing
					// leaves the field with no prefill rather than the old one.
					update( 'prefill', 'query' === value || 'custom' === value ? '' : value );
					paint( value );
				},
			},
		} );

		picker.append(
			el( 'option', { value: '', text: 'Nothing — leave it empty', attrs: { selected: '' === mode } } )
		);

		for ( const group of PREFILL_GROUPS ) {
			const optgroup = document.createElement( 'optgroup' );

			optgroup.label = group;

			for ( const source of PREFILL_SOURCES.filter( ( candidate ) => candidate.group === group ) ) {
				optgroup.append(
					el( 'option', {
						value: source.value,
						text: source.label,
						attrs: { selected: source.value === mode },
					} )
				);
			}

			picker.append( optgroup );
		}

		const link = document.createElement( 'optgroup' );

		link.label = 'From the link they arrived on';
		link.append(
			el( 'option', { value: 'query', text: 'A parameter in the web address', attrs: { selected: 'query' === mode } } )
		);

		// Ungrouped, at the end. It is the escape hatch rather than a fifth
		// category, and filing it under a heading would imply it belongs to one.
		picker.append(
			link,
			el( 'option', { value: 'custom', text: 'Something else (advanced)', attrs: { selected: 'custom' === mode } } )
		);

		return row(
			'Pre-fill this with',
			el( 'div', { class: 'atfb-prefill', children: [ picker, detail, preview ] } ),
			'What the box already contains when the form opens. They can still change it.'
		);
	}

	/**
	 * A field's condition, drawn as its parts rather than as a sentence.
	 *
	 * "Shown when Can you make it? is Yes, I will be there" is five things in a
	 * row with nothing to separate them, and two of the five are text somebody
	 * typed — so the question ends in a question mark and the answer contains a
	 * comma, and the punctuation the sentence relies on for structure is also in
	 * the content. Reading it means parsing it.
	 *
	 * Drawn as parts, no parsing is needed: the referenced question is a chip,
	 * the answer is a chip, and the verb and comparison are quiet text between
	 * them. The whole row still carries the plain sentence as its `aria-label`,
	 * because a screen reader reading five chips as five unrelated fragments
	 * would be worse off than before.
	 *
	 * Questions, comparisons and answers are editable in place. Each rule has
	 * its own delete control; adding or clearing rules stays on the canvas.
	 */
	private renderCondition( owner: Field, tokens: LogicToken[] ): HTMLElement {
		const broken = tokens.some( ( token ) => 'field' === token.kind && token.missing );

		const wrap = el( 'div', {
			class: `atfb-cond${ broken ? ' is-broken' : '' }`,
			attrs: { 'aria-label': tokens.length ? tokensToText( tokens ) : 'Conditional rules' },
		} );
		wrap.append( el( 'div', { class: 'atfb-cond__heading', children: [
			el( 'span', { class: 'atfb-cond__label', children: [ icon( 'randomize' ), 'Conditions' ] } ),
			this.copyConditionButton( `field:${ owner.id }` ),
		] } ) );
		owner.logic.rules.forEach( ( rule, index ) => {
			const parts = ruleTokens( rule, this.schema?.fields ?? [], index );
			const remove = el( 'button', {
				class: 'atfb-cond__delete', type: 'button', title: 'Delete this rule',
				attrs: { 'aria-label': `Delete rule ${ index + 1 }` },
				children: [ icon( 'trash' ) ],
				on: { click: () => {
					this.snapshot();
					this.editCondition( owner.id, ( logic ) => { logic.rules.splice( index, 1 ); }, true, `${ owner.id }:add` );
					this.snapshot();
				} },
			} );
			wrap.append( el( 'div', {
				class: 'atfb-cond__rule',
				children: [
					index === 0
						? this.renderConditionToken( owner, { kind: 'verb', text: owner.logic.action === 'hide' ? 'Hidden when' : 'Shown when' } )
						: this.renderConditionToken( owner, { kind: 'join', text: owner.logic.match === 'all' ? 'and' : 'or' } ),
					...parts.map( ( token ) => this.renderConditionToken( owner, token, index ) ),
					remove,
				],
			} ) );
		} );
		if ( ! owner.logic.rules.length ) {
			wrap.append( el( 'span', { class: 'atfb-hint', text: 'No rules yet. Add one or copy a condition.' } ) );
		}
		const add = el( 'button', {
			class: 'atfb-cond__add', type: 'button', text: '+ Add rule', title: 'Add rule',
			attrs: { 'aria-label': 'Add rule', 'data-cond': `${ owner.id }:add` },
			on: { click: () => this.addConditionRule( owner.id ) },
		} );
		const clear = el( 'button', {
			class: 'atfb-cond__clear', type: 'button', text: 'Clear', title: 'Delete all rules',
			attrs: { 'aria-label': 'Clear all rules', disabled: ! owner.logic.rules.length },
			on: { click: () => {
				this.snapshot();
				this.editCondition( owner.id, ( logic ) => { logic.rules = []; }, true, `${ owner.id }:add` );
				this.snapshot();
			} },
		} );
		wrap.append( el( 'div', { class: 'atfb-cond__actions', children: [ add, clear ] } ) );

		// The row is a live editor inside a card that is itself a draggable
		// button. None of the card's gestures may leak in: a pointerdown would
		// start a drag, a click would select the card, and the card's Backspace
		// shortcut would delete the field somebody is merely correcting a value
		// in.
		wrap.addEventListener( 'pointerdown', ( event ) => event.stopPropagation() );
		wrap.addEventListener( 'click', ( event ) => event.stopPropagation() );
		wrap.addEventListener( 'keydown', ( event ) => event.stopPropagation() );

		return wrap;
	}

	/**
	 * Writes to a field's live logic block and repaints what shows it.
	 *
	 * With `rebuild` false the cards are left alone and only the curve labels
	 * refresh — the mode for every keystroke in the value box, where a rebuild
	 * would destroy the input mid-word. The commit (change/blur) passes true and
	 * everything redraws, with focus put back on the control named by `refocus`
	 * so keyboard editing survives the rebuild.
	 */
	private editCondition( fieldId: string, mutate: ( logic: Logic ) => void, rebuild = true, refocus = '' ): void {
		const live = this.liveField( fieldId )?.logic;

		if ( ! live ) {
			return;
		}

		mutate( live );
		this.markDirty();

		if ( ! rebuild ) {
			this.logicMap?.setEdges( logicEdges( this.schema?.fields ?? [] ) );

			return;
		}

		this.renderCanvas();
		this.renderInspector();

		if ( refocus ) {
			window.requestAnimationFrame( () => {
				this.canvas.querySelector< HTMLElement >( `[data-cond="${ CSS.escape( refocus ) }"]` )?.focus();
			} );
		}
	}

	/**
	 * A small dropdown for the condition row.
	 *
	 * The shell's own `<os-select>` when its components are loaded, so the
	 * control on the card is the same control everywhere else on the desktop —
	 * a bare browser `<select>` next to os-styled chrome read as a seam. On
	 * the plain admin page, where the components do not exist, a native select
	 * is the seamless choice for exactly the same reason.
	 *
	 * @param value    The selected value.
	 * @param options  What can be picked.
	 * @param key      The `data-cond` refocus key.
	 * @param label    The accessible name.
	 * @param onChange Called with the newly picked value.
	 * @return The control.
	 */
	private condSelect(
		value: string,
		options: Array< { value: string; label: string; disabled?: boolean } >,
		key: string,
		label: string,
		onChange: ( picked: string ) => void
	): HTMLElement {
		if ( hasComponent( 'os-select' ) && hasComponent( 'os-option' ) ) {
			const host = document.createElement( 'os-select' );

			host.setAttribute( 'value', value );
			host.setAttribute( 'aria-label', label );
			host.setAttribute( 'data-cond', key );
			host.className = 'atfb-cond__control';
			host.setAttribute( 'plain', '' );
			host.title = label;

			for ( const option of options ) {
				const item = document.createElement( 'os-option' );

				item.setAttribute( 'value', option.value );
				if ( option.disabled ) item.setAttribute( 'disabled', '' );
				item.textContent = option.label;
				host.append( item );
			}

			host.addEventListener( 'os-pick', ( event: Event ) => {
				onChange( String( ( event as CustomEvent< { value?: string } > ).detail?.value ?? '' ) );
			} );

			return host;
		}

		return el( 'select', {
			class: 'atfb-cond__control atfb-cond__control--native',
			title: label,
			attrs: { 'aria-label': label, 'data-cond': key },
			on: {
				change: ( event: Event ) => onChange( ( event.target as HTMLSelectElement ).value ),
			},
			children: options.map( ( option ) =>
				el( 'option', { value: option.value, text: option.label, attrs: { selected: option.value === value, disabled: option.disabled } } )
			),
		} );
	}

	/**
	 * One tagged part of a condition — as the control that edits it.
	 *
	 * The row used to *describe* the rule and send you to the inspector to
	 * change it, which is the opposite of direct manipulation: the words were
	 * right there and none of them answered to a click. Now each part is the
	 * editor for what it shows — the verb flips show/hide, the comparison is a
	 * small select, the answer is an input (or a select of the source field's
	 * choices), and "and"/"or" toggles how rules combine.
	 */
	private renderConditionToken( owner: Field, token: LogicToken, ruleIndex = 0 ): HTMLElement {
		if ( 'field' === token.kind ) {
			const key = `${ owner.id }:source:${ ruleIndex }`;
			const choices = ( this.schema?.fields ?? [] ).filter( ( field ) => field.id !== owner.id && field.type !== 'page_break' );
			return this.condSelect( token.fieldId, [
				...( token.missing ? [ { value: token.fieldId, label: 'Choose a question…' } ] : [] ),
				...choices.map( ( field ) => ( { value: field.id, label: field.label || field.id } ) ),
			], key, 'Question used by this rule', ( value ) => this.editCondition( owner.id, ( logic ) => {
				const rule = logic.rules[ ruleIndex ];
				if ( rule ) {
					rule.field = value;
					rule.value = '';
				}
			}, true, key ) );
		}

		if ( 'verb' === token.kind ) {
			return el( 'button', {
				class: 'atfb-cond__verb',
				type: 'button',
				text: token.text,
				title: 'Switch between showing and hiding this field when the condition matches.',
				attrs: { 'data-cond': `${ owner.id }:verb` },
				on: {
					click: () =>
						this.editCondition(
							owner.id,
							( logic ) => {
								logic.action = 'hide' === logic.action ? 'show' : 'hide';
							},
							true,
							`${ owner.id }:verb`
						),
				},
			} );
		}

		if ( 'join' === token.kind ) {
			return el( 'button', {
				class: 'atfb-cond__join',
				type: 'button',
				text: token.text,
				title: 'Switch between needing every rule (and) or any one of them (or).',
				attrs: { 'data-cond': `${ owner.id }:join` },
				on: {
					click: () =>
						this.editCondition(
							owner.id,
							( logic ) => {
								logic.match = 'all' === logic.match ? 'any' : 'all';
							},
							true,
							`${ owner.id }:join`
						),
				},
			} );
		}

		if ( 'operator' === token.kind ) {
			const key = `${ owner.id }:op:${ token.ruleIndex }`;

			return this.condSelect(
				token.operator,
				Object.entries( OPERATOR_LABELS ).map( ( [ value, label ] ) => ( { value, label } ) ),
				key,
				'How the answer is compared',
				( picked ) =>
					this.editCondition(
						owner.id,
						( logic ) => {
							const rule = logic.rules[ token.ruleIndex ];

							if ( rule ) {
								rule.operator = picked as keyof typeof OPERATOR_LABELS;
							}
						},
						true,
						key
					)
			);
		}

		if ( 'value' === token.kind ) {
			return this.renderConditionValue( owner, token );
		}

		return el( 'span' );
	}

	/**
	 * The answer half of a condition, as the control it deserves.
	 *
	 * When the question being consulted has choices, the honest editor is a
	 * select of those choices — typing free text against a radio group can only
	 * produce a rule that never matches. Scales, ratings and other finite answer sets also get selectors. Open-ended answers get a text box, sized to
	 * its content so it reads as part of the sentence rather than as a form.
	 */
	private renderConditionValue(
		owner: Field,
		token: Extract< LogicToken, { kind: 'value' } >
	): HTMLElement {
		const key = `${ owner.id }:value:${ token.ruleIndex }`;
		const source = this.schema?.fields.find( ( candidate ) => candidate.id === token.sourceId );

		const write = ( value: string, rebuild: boolean ) =>
			this.editCondition(
				owner.id,
				( logic ) => {
					const rule = logic.rules[ token.ruleIndex ];

					if ( rule ) {
						rule.value = value;
					}
				},
				rebuild,
				key
			);

		const options = conditionValueOptions( source, token.raw, this.config?.countries );
		if ( options ) {
			const picker = this.condSelect( token.raw, options, key, 'The answer that triggers this', ( picked ) => write( picked, true ) );
			picker.classList.add( 'atfb-cond__value-select' );
			picker.removeAttribute( 'plain' );
			return picker;
		}

		const numeric = [ 'number', 'range', 'scale', 'rating', 'total' ].includes( source?.type ?? '' );

		const input = el( 'input', {
			class: 'atfb-cond__chip atfb-cond__chip--value atfb-cond__value',
			value: token.raw,
			title: 'The answer that triggers this. Edit it here.',
			attrs: {
				type: 'text',
				'aria-label': 'The answer that triggers this',
				'data-cond': key,
				inputmode: numeric ? 'decimal' : undefined,
				size: String( Math.max( 2, Math.min( 24, token.raw.length || 2 ) ) ),
			},
		} ) as HTMLInputElement;

		// Keystrokes write through to the live rule and refresh the curve
		// labels; the rebuild waits for the commit so the box survives typing.
		input.addEventListener( 'input', () => {
			input.size = Math.max( 2, Math.min( 24, input.value.length || 2 ) );
			write( input.value, false );
		} );
		input.addEventListener( 'change', () => write( input.value, true ) );
		input.addEventListener( 'keydown', ( event ) => {
			if ( 'Enter' === event.key ) {
				event.preventDefault();
				write( input.value, true );
			}
		} );

		return input;
	}

	/**
	 * A disclosure panel that remembers whether it was open.
	 *
	 * `openByDefault` decides only what happens the *first* time a key is seen —
	 * a field that already has a condition opens showing it, because arriving at
	 * a field and being told nothing about a rule that governs it is worse than a
	 * little extra height. After that the person's own choice wins.
	 *
	 * What this deliberately does not do is derive `open` from the data inside
	 * it. Conditional logic used to: `open: logic.enabled`, so unticking "Only
	 * show this field sometimes" collapsed the panel around the checkbox that had
	 * just been clicked. Whether a panel is open is a question about the
	 * *person's attention*; whether a feature is on is a question about the
	 * *form*. Binding one to the other means neither can be set independently.
	 *
	 * @param key           Stable identity for this panel.
	 * @param summary       The panel's heading.
	 * @param children      What it contains.
	 * @param openByDefault Whether to open it the first time it is rendered.
	 * @return The panel.
	 */
	private section(
		key: string,
		summary: string,
		children: Array< Node | string | null | undefined | false >,
		openByDefault = false
	): HTMLElement {
		const details = el( 'details', {
			class: 'atfb-section',
			attrs: { open: this.openSections.get( key ) ?? openByDefault },
			children: [ el( 'summary', { text: summary } ), ...children ],
		} );

		details.addEventListener( 'toggle', () => this.openSections.set( key, details.open ) );

		return details;
	}

	/**
	 * The toolbar's toggle for the logic overlay.
	 *
	 * Hidden entirely on a form with no conditions. A control for a thing that
	 * is not there teaches nothing and takes up a slot in a toolbar that already
	 * has eight.
	 */
	private logicMapButton(): HTMLElement {
		const has = logicEdges( this.schema?.fields ?? [] ).length > 0;

		const toggle = button(
			this.logicMapOn ? 'Hide logic' : 'Show logic',
			() => {
				this.logicMapOn = ! this.logicMapOn;

				writeSetting( LOGIC_MAP_SETTING, this.logicMapOn ? 'on' : 'off' );

				this.renderBar();
				this.renderCanvas();
			},
			this.logicMapOn ? 'primary' : 'secondary',
			'randomize'
		);

		toggle.title = 'Draw a line from each question to the ones it decides.';
		toggle.hidden = ! has;

		return toggle;
	}

	/**
	 * Draws the conditional-logic connections over the canvas.
	 *
	 * Rebuilt with the canvas rather than kept alive across renders: the layer
	 * measures cards that this render has just replaced, and an instance holding
	 * a `ResizeObserver` on a detached element is a leak that also stops
	 * redrawing. Cheap enough — it is one `<svg>` and a handful of paths.
	 *
	 * @param inner The canvas element the layer covers.
	 */
	private paintLogicMap( inner: HTMLElement ): void {
		this.logicMap?.destroy();
		this.logicMap = null;

		const fields = this.schema?.fields ?? [];
		const edges = logicEdges( fields );

		if ( ! edges.length || ! this.logicMapOn ) {
			return;
		}

		// The strip the curves are drawn in. Reserved by shrinking the cards rather
		// than by letting the layer overflow: the canvas is a scroll box, so
		// anything drawn outside it is clipped — which is exactly what happened to
		// the first version's labels.
		inner.classList.add( 'has-logicmap' );

		const map = new LogicMap( inner );

		map.setEdges( edges );
		map.highlight( this.selected ?? '' );

		this.logicMap = map;

		// Hover lights the curves touching a card and dims the rest, which answers
		// "what does this one affect?" without a click. Delegated from the list so
		// it survives cards being added, removed and reordered.
		inner.addEventListener( 'pointerover', ( event ) => {
			const card = ( event.target as HTMLElement ).closest< HTMLElement >( '[data-atfb-card]' );

			map.highlight( card?.dataset.atfbCard ?? this.selected ?? '' );
		} );

		inner.addEventListener( 'pointerleave', () => map.highlight( this.selected ?? '' ) );
	}

	/** One field on the canvas. */
	private renderFieldCard( field: Field, index: number ): HTMLElement {
		const type = this.config?.fieldTypes.find( ( candidate ) => candidate.type === field.type );
		const selected = this.selected === field.id;

		// What the logic actually does, and how much this field decides for
		// others. A `LOGIC` badge said neither: it announced that a rule existed
		// and left finding out what it said as an exercise.
		const fields = this.schema?.fields ?? [];
		const condition = logicTokens( field, fields );
		const controls = controlCounts( fields ).get( field.id ) ?? 0;

		const card = el( 'div', {
			class: `atfb-card${ selected ? ' is-selected' : '' }`,
			attrs: {
				'data-atfb-card': field.id,
				'data-index': index,
				tabindex: '0',
				role: 'button',
				'aria-pressed': selected,
				'aria-label': `${ field.label || type?.label || field.type }, ${ index + 1 } of ${
					this.schema?.fields.length ?? 0
				}`,
			},
			children: [
				// The card is a miniature of the window that contains it: a title
				// bar carrying the grip, the field's identity and the actions,
				// with the field itself as the window body below. The bar is one
				// element rather than three floated ones so the shell's titlebar
				// surface can paint across it edge to edge.
				el( 'div', {
					class: 'atfb-card__bar',
					children: [
						el( 'div', {
							class: 'atfb-card__grip',
							attrs: { 'aria-hidden': 'true' },
							children: [ icon( 'menu' ) ],
						} ),
						el( 'div', {
							class: 'atfb-card__head',
							children: [
								icon( type?.icon ?? 'dashicons-forms' ),
								el( 'span', { class: 'atfb-card__type', text: type?.label ?? field.type } ),
								this.requiredToggle( field ),
								field.type !== 'page_break' ? this.conditionToolbar( field ) : null,
								controls
									? el( 'span', {
											class: 'atfb-badge atfb-badge--controls',
											text: 1 === controls ? 'controls 1 field' : `controls ${ controls } fields`,
											title: 'Other questions appear or disappear based on this answer.',
									  } )
									: null,
							],
						} ),
						el( 'div', {
							class: 'atfb-card__actions',
							children: [
								this.cardAction( 'admin-page', 'Duplicate', () => this.duplicateField( field.id ) ),
								this.cardAction( 'trash', 'Delete', () => void this.deleteField( field.id ) ),
							],
						} ),
					],
				} ),
				el( 'div', {
					class: 'atfb-card__body',
					children: [
						// The field itself, drawn with the real front-end classes and the
						// form's own theme, with its text editable where it sits.
						renderFieldPreview( field, type, {
							// The live field is looked up by id on every write. A save
							// replaces `this.schema` with the server's normalised copy,
							// so the object this card was rendered from stops being the
							// one that gets serialised — see `PreviewHandlers`.
							edit: ( apply ) => {
								const live = this.liveField( field.id );

								if ( ! live ) {
									return;
								}

								apply( live );
								this.markDirty();
								this.syncInspector( live );

								// The edit may have landed on a sub-field of
								// this card's repeater — if that sub-field is
								// what the inspector is showing, it is the one
								// to mirror.
								const selected = this.selected ? this.locateField( this.selected ) : undefined;

								if ( selected?.parent && selected.parent.id === live.id ) {
									this.syncInspector( selected.field );
								}
							},
							restructure: ( apply ) => {
								const live = this.liveField( field.id );

								if ( ! live ) {
									return;
								}

								this.snapshot();
								apply( live );
								this.markDirty();
								this.renderCanvas();
								this.renderInspector();
							},
							// A repeater draws each sub-field through the same
							// preview machinery, and needs to know their types
							// and which of them is selected.
							types: ( name ) => this.config?.fieldTypes.find( ( candidate ) => candidate.type === name ),
							selectedId: this.selected,
						} ),
						field.logic.enabled ? this.renderCondition( field, condition ) : null,
					],
				} ),
			],
		} );

		card.addEventListener( 'click', ( event ) => {
			if ( ( event.target as HTMLElement ).closest( '.atfb-card__actions' ) ) {
				return;
			}

			if ( getDragManager().recentlyEndedDrag() ) {
				return;
			}

			this.selectField( field.id );
		} );

		// Keyboard parity with the drag: Enter selects, and Alt with an arrow
		// moves the field. Without this a keyboard user could inspect a form but
		// never reorder one.
		card.addEventListener( 'keydown', ( event ) => {
			if ( event.key === 'Enter' || event.key === ' ' ) {
				event.preventDefault();
				this.selectField( field.id );

				return;
			}

			if ( event.altKey && ( event.key === 'ArrowUp' || event.key === 'ArrowDown' ) ) {
				event.preventDefault();
				this.moveField( field.id, event.key === 'ArrowUp' ? index - 1 : index + 1 );

				// The card is rebuilt by the move, so focus has to be restored
				// onto its replacement or it falls back to the document.
				window.requestAnimationFrame( () => {
					this.canvas
						.querySelector< HTMLElement >( `[data-atfb-card="${ CSS.escape( field.id ) }"]` )
						?.focus();
				} );
			}

			if ( event.key === 'Delete' || event.key === 'Backspace' ) {
				event.preventDefault();
				void this.deleteField( field.id );
			}
		} );

		card.addEventListener( 'pointerdown', ( event ) => {
			if ( ( event.target as HTMLElement ).closest( '.atfb-card__actions' ) ) {
				return;
			}

			getDragManager().start( {
				payload: buildPayload( FIELD_PAYLOAD_TYPE, card, { fieldId: field.id, field, isNew: false }, event ),
				origin: event,
			} );
		} );

		return card;
	}

	/** Adds a rule without leaving the canvas. */
	private addConditionRule( fieldId: string ): void {
		this.snapshot();
		this.editCondition( fieldId, ( logic ) => {
			const source = this.schema?.fields.find( ( field ) => field.id !== fieldId && field.type !== 'page_break' );
			logic.rules.push( { field: source?.id ?? '', operator: 'is', value: '' } );
		}, true, `${ fieldId }:source:${ this.liveField( fieldId )?.logic.rules.length ?? 0 }` );
		this.snapshot();
	}

	/** A compact title-bar entry point; the settings live in a dialog. */
	private conditionToolbar( field: Field ): HTMLElement {
		const trigger = el( 'button', {
			class: `atfb-req atfb-condition-toggle${ field.logic.enabled ? ' is-on' : '' }`,
			type: 'button',
			title: field.logic.enabled ? 'Edit conditional logic' : 'Set up conditional logic',
			attrs: { 'aria-haspopup': 'dialog', 'data-cond': `${ field.id }:enabled` },
			children: [
				el( 'span', { class: 'atfb-condition-dot', attrs: { 'aria-hidden': 'true' } } ),
				el( 'span', { text: 'Conditional' } ),
			],
			on: { click: () => this.openConditionEditor( field.id ) },
		} );
		for ( const name of [ 'pointerdown', 'click', 'keydown' ] ) {
			trigger.addEventListener( name, ( event ) => event.stopPropagation() );
		}
		return trigger;
	}

	/** Edits a draft, so Cancel leaves the saved and inline conditions alone. */
	private openConditionEditor( fieldId: string ): void {
		const field = this.liveField( fieldId );
		if ( ! field ) {
			return;
		}
		const hadRules = field.logic.rules.length > 0;
		const draft: Logic = { ...field.logic, enabled: true, rules: field.logic.rules.map( ( rule ) => ( { ...rule } ) ) };
		const overlay = el( 'div', { class: 'atfb-overlay' } );
		const dialog = el( 'div', {
			class: 'atfb-modal atfb-condition-editor',
			attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Conditional logic', tabindex: '-1' },
		} );
		const close = () => {
			overlay.remove();
			this.root.querySelector< HTMLElement >( `[data-cond="${ CSS.escape( fieldId ) }:enabled"]` )?.focus();
		};
		const controlsSelector = 'button:not([disabled]), input, select, os-select, os-checkbox-label, os-button:not([disabled])';
		const paint = () => {
			const focusedIndex = [ ...dialog.querySelectorAll( controlsSelector ) ].indexOf( document.activeElement! );
			const write = ( mutate: ( logic: Logic ) => void, rebuild = false ) => {
				mutate( draft );
				if ( rebuild ) {
					paint();
				}
			};
			const action = select( draft.action, [ { value: 'show', label: 'Show' }, { value: 'hide', label: 'Hide' } ], ( value ) => { draft.action = value as Logic[ 'action' ]; } );
			action.setAttribute( 'aria-label', 'Conditional action' );
			const match = select( draft.match, [ { value: 'all', label: 'all' }, { value: 'any', label: 'any' } ], ( value ) => {
				draft.match = value as Logic[ 'match' ];
				paint();
			} );
			match.setAttribute( 'aria-label', 'Match rules' );
			const copy = el( 'button', {
				class: 'atfb-button atfb-copy-condition', type: 'button',
				children: [ icon( 'admin-page' ), el( 'span', { text: 'Copy condition' } ) ],
				on: { click: () => openConditionCopy( {
					root: overlay,
					to: `field:${ fieldId }`,
					schema: () => this.schema ? {
						...this.schema,
						fields: this.schema.fields.map( ( item ) => item.id === fieldId ? { ...item, logic: draft } : item ),
					} : null,
					onCopy: () => { draft.enabled = true; paint(); dialog.focus(); },
				} ) },
			} );
			dialog.replaceChildren(
				el( 'div', { class: 'atfb-condition-editor__heading', children: [
					el( 'span', { class: 'atfb-condition-editor__icon', children: [ icon( 'randomize' ) ] } ),
					el( 'div', { children: [ el( 'h2', { text: 'Conditional logic' } ), el( 'p', { text: field.label || 'Untitled field' } ) ] } ),
				] } ),
				el( 'p', { class: 'atfb-hint', text: 'Choose when this field appears in your form.' } ),
				el( 'div', { class: 'atfb-condition-editor__sentence', children: [ action, 'this field when', match, 'of these rules match:' ] } ),
				...this.logicRulesEditor( draft, write, fieldId ),
				el( 'div', { class: 'atfb-condition-editor__footer', children: [
					copy,
					el( 'div', { class: 'atfb-modal__actions', children: [
						button( 'Clear', () => {
							this.snapshot();
							this.editCondition( fieldId, ( live ) => Object.assign( live, { enabled: false, action: 'show', match: 'all', rules: [] } ) );
							this.snapshot();
							close();
						} ),
						...( hadRules || draft.rules.length ? [ button( 'Cancel', close ) ] : [] ),
						button( 'Save conditions', () => {
							if ( ! this.liveField( fieldId ) || ! draft.rules.length ) {
								close();
								return;
							}
							this.snapshot();
							this.editCondition( fieldId, ( live ) => Object.assign( live, draft, { rules: draft.rules.map( ( rule ) => ( { ...rule } ) ) } ) );
							this.snapshot();
							close();
						}, 'primary' ),
					] } ),
				] } )
			);
			if ( ! draft.rules.length ) {
				dialog.querySelector( '.atfb-button--primary' )?.setAttribute( 'disabled', '' );
			}
			if ( focusedIndex >= 0 ) {
				const controls = dialog.querySelectorAll< HTMLElement >( controlsSelector );
				controls[ Math.min( focusedIndex, controls.length - 1 ) ]?.focus();
			}
		};
		overlay.append( dialog );
		overlay.addEventListener( 'click', ( event ) => { if ( event.target === overlay ) close(); } );
		overlay.addEventListener( 'keydown', ( event ) => {
			if ( event.key === 'Escape' ) {
				event.preventDefault();
				close();
			}
			if ( event.key === 'Tab' ) {
				const controls = [ ...dialog.querySelectorAll< HTMLElement >( controlsSelector ) ];
				const first = controls[ 0 ];
				const last = controls[ controls.length - 1 ];
				if ( event.shiftKey && ( document.activeElement === first || document.activeElement === dialog ) ) {
					event.preventDefault();
					last?.focus();
				} else if ( ! event.shiftKey && document.activeElement === last ) {
					event.preventDefault();
					first?.focus();
				}
			}
			event.stopPropagation();
		} );
		this.root.append( overlay );
		paint();
		dialog.focus();
	}

	/**
	 * The required flag, as a toggle on the card rather than a badge.
	 *
	 * It was already displayed here as a read-only badge, and the switch that set
	 * it was in the inspector — so the canvas told you a field was required and
	 * made you go somewhere else to change it. Marking a question required is a
	 * decision you make while writing it, not afterwards.
	 */
	private requiredToggle( field: Field ): HTMLElement {
		const toggle = el( 'button', {
			class: `atfb-req${ field.required ? ' is-on' : '' }`,
			type: 'button',
			text: field.required ? 'Required' : 'Optional',
			title: field.required ? 'This must be answered. Click to make it optional.' : 'Click to make this required.',
			attrs: { 'aria-pressed': field.required ? 'true' : 'false' },
			on: {
				// The card is draggable and clicking it selects the field; neither
				// should happen when the target was this switch.
				pointerdown: ( event: Event ) => event.stopPropagation(),
				click: ( event: Event ) => {
					event.stopPropagation();
					field.required = ! field.required;
					this.markDirty();
					this.renderCanvas();
					this.renderInspector();
				},
			},
		} );

		return toggle;
	}

	/** A small icon button on a field card. */
	private cardAction( iconSlug: string, label: string, onClick: () => void ): HTMLElement {
		return el( 'button', {
			class: 'atfb-card__action',
			type: 'button',
			title: label,
			attrs: { 'aria-label': label },
			on: {
				click: ( event: Event ) => {
					event.stopPropagation();
					onClick();
				},
			},
			children: [ icon( iconSlug ) ],
		} );
	}

	/**
	 * Makes the canvas a drop target.
	 *
	 * Accepts this plugin's own field payload — from the palette, from this
	 * canvas, or from a *second* builder window, which is what the shell's
	 * shared drag manager buys and an iframe could not.
	 */
	/**
	 * The animated insertion gap for one drop container — the canvas list, or
	 * a repeater's zone.
	 *
	 * While a field payload is over the container, a slot the size of the
	 * dragged card follows the pointer, the dragged card leaves the flow, and
	 * the other cards slide out of the way with first/last-position
	 * transforms — so the list previews, in real time, exactly the layout the
	 * drop will produce.
	 *
	 * @param container    The drop target element; the gap shows while it has
	 *                     the `is-dropping` class.
	 * @param itemSelector The cards that reflow, `.atfb-card` or `.atfb-subcard`.
	 * @param findCard     Resolves a dragged field id to its card in this
	 *                     container's world, or null for one it doesn't hold.
	 * @param accepts      Optional payload gate mirroring the drop target's
	 *                     own `accept()`, so a drag the target will refuse
	 *                     never opens a gap it cannot honour.
	 * @return `enter`/`leave`/`drop` to wire into the drop target, and a
	 *         `teardown` for the document-level listeners.
	 */
	private gapAnimator(
		container: HTMLElement,
		itemSelector: string,
		findCard: ( fieldId: string ) => HTMLElement | null,
		accepts?: ( data: Record< string, unknown > ) => boolean
	): {
		enter( fieldId?: string ): void;
		leave(): void;
		drop( clientY: number, source?: HTMLElement | null ): number;
		teardown(): void;
	} {
		const marker = el( 'div', { class: 'atfb-marker', attrs: { 'aria-hidden': 'true' } } );

		/**
		 * The slot the marker currently shows, in the same "list without the
		 * dragged card" indexing the drop uses. Null while no gap is open.
		 *
		 * The drop reads this instead of re-measuring the pointer: with a
		 * card-sized gap open the cards are nowhere near where a measurement
		 * of the restored layout would put them, so a recomputed index lands
		 * the field a slot away from where the gap said it would.
		 */
		let shownIndex: number | null = null;

		/** The card lifted out of the flow while its gap is open, if any. */
		let liftedCard: HTMLElement | null = null;

		/** The gap's height — the dragged card's, measured before it is lifted. */
		let slotSize = 0;

		const restore = () => {
			marker.remove();
			liftedCard?.classList.remove( 'atfb-lifted' );
			liftedCard = null;
			shownIndex = null;
		};

		// First/last-position animation: measure where every card sits, mutate
		// the DOM, transform each card back to its old spot and release — so
		// the gap opening, moving and closing reads as cards sliding out of
		// the way in real time rather than teleporting.
		const moveAnimated = ( mutate: () => void ) => {
			const cards = Array.from( container.querySelectorAll< HTMLElement >( itemSelector ) );
			// A lifted card has no box, and a rect of zeros as a start position
			// would animate its restore in from the viewport's top corner — so
			// only cards visible *before* the mutation get one.
			const before = new Map(
				cards
					.filter( ( card ) => ! card.classList.contains( 'atfb-lifted' ) )
					.map( ( card ) => [ card, card.getBoundingClientRect().top ] )
			);

			mutate();

			for ( const card of cards ) {
				card.style.transition = 'none';
				card.style.transform = '';
			}

			const moved = cards.filter( ( card ) => {
				const from = before.get( card );

				if ( from === undefined || ! card.isConnected || card.classList.contains( 'atfb-lifted' ) ) {
					return false;
				}

				const delta = from - card.getBoundingClientRect().top;

				if ( Math.abs( delta ) < 0.5 ) {
					return false;
				}

				card.style.transform = `translateY(${ delta }px)`;

				return true;
			} );

			// One reflow commits the start positions, then every moved card
			// transitions to its natural spot. Cards that didn't move give the
			// inline `transition: none` straight back — left on, it would keep
			// eating their hover transitions until the next render.
			void container.offsetHeight;

			for ( const card of cards ) {
				if ( ! moved.includes( card ) ) {
					card.style.transition = '';
					continue;
				}

				card.style.transition = 'transform 160ms ease';
				card.style.transform = '';
				card.addEventListener(
					'transitionend',
					() => {
						card.style.transition = '';
					},
					{ once: true }
				);
			}
		};

		// The gap follows the pointer. Driven from the drag manager's move
		// event, which both managers emit.
		const onMove = ( event: Event ) => {
			const detail = (
				event as CustomEvent< {
					payload?: { type: string; data?: Record< string, unknown > };
					clientY?: number;
				} >
			 ).detail;

			if ( detail?.payload?.type !== FIELD_PAYLOAD_TYPE || ! container.classList.contains( 'is-dropping' ) ) {
				return;
			}

			if ( accepts && ! accepts( detail.payload.data ?? {} ) ) {
				return;
			}

			// The dragged card is left out of the count, exactly as `drop`
			// leaves it out. Gap and drop must be computed in the same
			// indexing — counted two different ways, the field lands one slot
			// away from where the gap said it would.
			const fieldId = detail.payload.data?.fieldId;
			const dragged = typeof fieldId === 'string' ? findCard( fieldId ) : null;
			const index = insertionIndex( container, itemSelector, detail.clientY ?? 0, dragged ?? undefined );

			// Every pointer move lands here; only a move that changes the slot
			// touches layout.
			if ( index === shownIndex && marker.isConnected ) {
				return;
			}

			shownIndex = index;

			moveAnimated( () => {
				// The dragged card leaves the flow the moment its gap first
				// opens: the ghost under the pointer is the card now, and the
				// gap is where it will land. Both at once would show the field
				// twice, one of them stale.
				if ( dragged && dragged !== liftedCard ) {
					liftedCard?.classList.remove( 'atfb-lifted' );
					dragged.classList.add( 'atfb-lifted' );
					liftedCard = dragged;
				}

				marker.style.blockSize = `${ Math.max( 8, Math.round( slotSize ) ) }px`;

				const cards = Array.from( container.querySelectorAll< HTMLElement >( itemSelector ) ).filter(
					( card ) => card !== dragged
				);

				if ( index >= cards.length ) {
					container.append( marker );
				} else {
					cards[ index ].before( marker );
				}
			} );
		};

		// The safety net for a drag that ends anywhere but a clean drop here —
		// Escape, window blur, a drop swallowed by another target. The restore
		// is deferred a tick because a manager may emit its end event before
		// it delivers the drop, and the drop still needs `shownIndex`; after a
		// clean drop this is a no-op.
		const onEnd = () => {
			container.classList.remove( 'is-dropping' );
			window.setTimeout( () => moveAnimated( restore ), 0 );
		};

		document.addEventListener( 'os.drag.move', onMove );
		document.addEventListener( 'os.drag.end', onEnd );

		return {
			enter: ( fieldId ) => {
				const card = fieldId ? findCard( fieldId ) : null;

				// Measured now, before the card is lifted out of the flow —
				// afterwards it has no box left to measure. A palette item has
				// no card yet, so its gap is a nominal card height.
				slotSize =
					card && ! card.classList.contains( 'atfb-lifted' )
						? card.getBoundingClientRect().height
						: slotSize || 44;
			},
			leave: () => moveAnimated( restore ),
			drop: ( clientY, source ) => {
				// The slot the open gap showed, when one is open. Only a drop
				// that never opened one — possible with a pointer that never
				// moved after entering — falls back to measuring, against a
				// layout that in that case was never distorted.
				const index = shownIndex ?? insertionIndex( container, itemSelector, clientY, source ?? undefined );

				restore();

				return index;
			},
			teardown: () => {
				document.removeEventListener( 'os.drag.move', onMove );
				document.removeEventListener( 'os.drag.end', onEnd );
				restore();
			},
		};
	}

	private registerCanvasTarget( list: HTMLElement ): void {
		// Every canvas render builds a fresh list element, and this runs on every
		// render — so the previous registration and its document-level move
		// listener go first. Left in place, each inspector keystroke would stack
		// one more of each until the window closed.
		this.canvasTarget?.();
		this.canvasTarget = null;

		const gap = this.gapAnimator( list, '.atfb-card', ( fieldId ) =>
			this.canvas.querySelector< HTMLElement >( `[data-atfb-card="${ CSS.escape( fieldId ) }"]` )
		);

		const teardown = getDragManager().registerDropTarget( {
			id: `atfb-canvas-${ this.form?.id ?? 0 }`,
			element: list,
			accept: ( payload ) => payload.type === FIELD_PAYLOAD_TYPE,
			onEnter: ( session ) => {
				list.classList.add( 'is-dropping' );
				gap.enter( ( session.payload.data as { fieldId?: string } ).fieldId );
			},
			onLeave: () => {
				list.classList.remove( 'is-dropping' );
				gap.leave();
			},
			onDrop: ( session, position ) => {
				list.classList.remove( 'is-dropping' );

				const data = session.payload.data as {
					fieldType?: string;
					fieldId?: string;
					field?: Field;
					isNew?: boolean;
				};

				const source = data.fieldId
					? this.canvas.querySelector< HTMLElement >( `[data-atfb-card="${ CSS.escape( data.fieldId ) }"]` )
					: null;

				const index = gap.drop( position.clientY, source );

				if ( data.isNew && data.fieldType ) {
					this.addField( data.fieldType, index );

					return;
				}

				// Wherever the field currently lives — the top level, or
				// inside a repeater it is being pulled out of — this drop
				// makes it a top-level field at the marked spot.
				if ( data.fieldId && this.locateField( data.fieldId ) ) {
					this.relocateField( data.fieldId, null, index );

					return;
				}

				// A field dragged in from another builder window: its id may
				// already be taken here, so it is added as a copy and the
				// schema's normaliser re-issues the id on save.
				if ( data.field ) {
					this.insertField( { ...data.field, id: '' } as Field, index );
				}
			},
		} );

		const zoneTeardowns = this.wireRepeaterZones( list );

		this.canvasTarget = () => {
			teardown();
			zoneTeardowns.forEach( ( zoneTeardown ) => zoneTeardown() );
			gap.teardown();
		};
	}

	/**
	 * Makes every repeater on the canvas a drop target of its own, and its
	 * sub-field cards draggable, selectable and keyboard-operable.
	 *
	 * The zone elements are drawn by the preview (`field-preview.ts`), which
	 * cannot reach the drag manager; this is where they come alive. Zones are
	 * nested inside the canvas target, and the manager resolves hits depth
	 * first, so a drop lands in the repeater when it is over one and on the
	 * canvas when it is not.
	 *
	 * @param list The canvas list, freshly rendered.
	 * @return One teardown per registered zone.
	 */
	private wireRepeaterZones( list: HTMLElement ): Array< () => void > {
		const teardowns: Array< () => void > = [];

		list.querySelectorAll< HTMLElement >( '[data-atfb-repeater-zone]' ).forEach( ( zone ) => {
			const repeaterId = zone.dataset.atfbRepeaterZone ?? '';

			// The zone's acceptance rule, shared between the drop target's
			// `accept()` and its gap animator — a drag the zone will refuse
			// must not open a gap in it either.
			const acceptsData = ( raw: Record< string, unknown > ) => {
				const data = raw as { fieldType?: string; fieldId?: string; field?: Field; isNew?: boolean };

				// The repeater itself dragged over its own zone must
				// fall through to the canvas, not swallow the drop.
				if ( data.fieldId === repeaterId ) {
					return false;
				}

				const type = data.isNew
					? data.fieldType
					: this.locateField( data.fieldId ?? '' )?.field.type ?? data.field?.type;

				return !! type && this.allowedInRepeater( type );
			};

			const gap = this.gapAnimator(
				zone,
				'.atfb-subcard',
				( fieldId ) => list.querySelector< HTMLElement >( `[data-atfb-subfield="${ CSS.escape( fieldId ) }"]` ),
				acceptsData
			);

			teardowns.push( () => gap.teardown() );

			teardowns.push(
				getDragManager().registerDropTarget( {
					id: `atfb-repzone-${ this.form?.id ?? 0 }-${ repeaterId }`,
					element: zone,
					accept: ( payload ) => payload.type === FIELD_PAYLOAD_TYPE && acceptsData( payload.data ),
					onEnter: ( session ) => {
						zone.classList.add( 'is-dropping' );
						gap.enter( ( session.payload.data as { fieldId?: string } ).fieldId );
					},
					onLeave: () => {
						zone.classList.remove( 'is-dropping' );
						gap.leave();
					},
					onDrop: ( session, position ) => {
						zone.classList.remove( 'is-dropping' );

						const data = session.payload.data as {
							fieldType?: string;
							fieldId?: string;
							field?: Field;
							isNew?: boolean;
						};

						const source = data.fieldId
							? list.querySelector< HTMLElement >(
									`[data-atfb-subfield="${ CSS.escape( data.fieldId ) }"]`
							  )
							: null;

						const index = gap.drop( position.clientY, source );

						if ( data.isNew && data.fieldType ) {
							this.addFieldToRepeater( data.fieldType, repeaterId, index );

							return;
						}

						if ( data.fieldId && this.locateField( data.fieldId ) ) {
							this.relocateField( data.fieldId, repeaterId, index );

							return;
						}

						// From another builder window: a copy, re-identified.
						if ( data.field ) {
							this.insertFieldIntoRepeater( { ...data.field, id: '' } as Field, repeaterId, index );
						}
					},
				} )
			);

			zone.querySelectorAll< HTMLElement >( '.atfb-subcard' ).forEach( ( card ) => {
				const subId = card.dataset.atfbSubfield ?? '';

				card.addEventListener( 'click', ( event ) => {
					if ( ( event.target as HTMLElement ).closest( '.atfb-preview__remove' ) ) {
						return;
					}

					event.stopPropagation();

					if ( getDragManager().recentlyEndedDrag() ) {
						return;
					}

					this.selectField( subId );
				} );

				card.addEventListener( 'keydown', ( event ) => {
					// Nothing a sub-field's keyboard does should reach the
					// repeater's own card — its Delete would take the whole
					// container.
					event.stopPropagation();

					if ( event.key === 'Enter' || event.key === ' ' ) {
						event.preventDefault();
						this.selectField( subId );

						return;
					}

					if ( event.altKey && ( event.key === 'ArrowUp' || event.key === 'ArrowDown' ) ) {
						event.preventDefault();

						const now = this.locateField( subId );

						if ( now ) {
							this.relocateField(
								subId,
								repeaterId,
								event.key === 'ArrowUp' ? now.index - 1 : now.index + 1
							);

							window.requestAnimationFrame( () => {
								this.canvas
									.querySelector< HTMLElement >( `[data-atfb-subfield="${ CSS.escape( subId ) }"]` )
									?.focus();
							} );
						}

						return;
					}

					if ( event.key === 'Delete' || event.key === 'Backspace' ) {
						event.preventDefault();
						void this.deleteField( subId );
					}
				} );

				card.addEventListener( 'pointerdown', ( event ) => {
					// The repeater card above must not hear this press and
					// start dragging the whole container.
					event.stopPropagation();

					if ( ( event.target as HTMLElement ).closest( '.atfb-preview__remove' ) ) {
						return;
					}

					const found = this.locateField( subId );

					if ( ! found ) {
						return;
					}

					getDragManager().start( {
						payload: buildPayload(
							FIELD_PAYLOAD_TYPE,
							card,
							{ fieldId: subId, parentId: repeaterId, field: found.field, isNew: false },
							event
						),
						origin: event,
					} );
				} );
			} );
		} );

		return teardowns;
	}

	/* -------------------------------------------------------- Field editing */

	/** Adds a field of a type, at an index or at the end. */
	private addField( type: string, index?: number ): void {
		const field = this.buildField( type );

		if ( field ) {
			this.insertField( field, index );
		}
	}

	/** A brand-new field of a type, with the type's defaults and a fresh id. */
	private buildField( type: string ): Field | undefined {
		const definition = this.config?.fieldTypes.find( ( candidate ) => candidate.type === type );

		if ( ! definition || ! this.schema ) {
			return undefined;
		}

		const field = {
			id: this.nextFieldId(),
			type,
			label: definition.input ? definition.label : '',
			placeholder: '',
			hint: '',
			required: false,
			width: 'full',
			cssClass: '',
			default: '',
			choices: definition.choices
				? [
						{ label: 'First choice', value: 'first' },
						{ label: 'Second choice', value: 'second' },
				  ]
				: [],
			logic: { enabled: false, action: 'show', match: 'all', rules: [] },
			messages: {},
			prefill: '',
			...definition.settings,
		} as unknown as Field;

		return field;
	}

	/**
	 * Whether a field type may live inside a repeater.
	 *
	 * The exclusions are each a real constraint, not taste: a repeater inside
	 * a repeater has no addressable rows; a page break splits a *form*, not a
	 * row; file uploads and signatures are wired to top-level names in the
	 * submission pipeline; and a total is computed once per form, so a copy
	 * per row would be a number that lies. Layout blocks are out because a
	 * repeater's rows are answers, and analytics reads them as answers.
	 */
	private allowedInRepeater( type: string ): boolean {
		const definition = this.config?.fieldTypes.find( ( candidate ) => candidate.type === type );

		if ( ! definition || ! definition.input ) {
			return false;
		}

		return ! [ 'repeater', 'page_break', 'file', 'signature', 'total' ].includes( type );
	}

	/** Adds a brand-new field of a type inside a repeater. */
	private addFieldToRepeater( type: string, repeaterId: string, index?: number ): void {
		if ( ! this.allowedInRepeater( type ) ) {
			return;
		}

		const field = this.buildField( type );

		if ( field ) {
			this.insertFieldIntoRepeater( field, repeaterId, index );
		}
	}

	/** Puts a field into a repeater's sub-field list. */
	private insertFieldIntoRepeater( field: Field, repeaterId: string, index?: number ): void {
		const repeater = this.liveField( repeaterId );

		if ( ! this.schema || ! repeater || repeater.type !== 'repeater' ) {
			return;
		}

		if ( ! field.id ) {
			field.id = this.nextFieldId();
		}

		this.snapshot();

		if ( ! Array.isArray( repeater.fields ) ) {
			repeater.fields = [];
		}

		const list = repeater.fields as Field[];
		const at = index === undefined ? list.length : Math.max( 0, Math.min( index, list.length ) );

		list.splice( at, 0, field );
		this.selected = field.id;

		this.markDirty();
		this.renderCanvas();
		this.renderInspector();

		window.requestAnimationFrame( () => {
			this.canvas
				.querySelector< HTMLElement >( `[data-atfb-subfield="${ CSS.escape( field.id ) }"]` )
				?.focus();
		} );
	}

	/**
	 * Moves a field to wherever it was dropped — the top level, or inside a
	 * repeater — from wherever it was.
	 *
	 * `index` counts the destination list *without* the moved field, exactly
	 * as `insertionIndex()` computes it with the dragged card excluded.
	 */
	private relocateField( fieldId: string, repeaterId: string | null, index: number ): void {
		if ( ! this.schema ) {
			return;
		}

		const found = this.locateField( fieldId );

		if ( ! found ) {
			return;
		}

		// Top level to top level is the move that has always existed, with its
		// own carefully-tested index arithmetic. Keep using it.
		if ( ! found.parent && ! repeaterId ) {
			this.moveField( fieldId, index );

			return;
		}

		const repeater = repeaterId ? this.liveField( repeaterId ) : null;

		if ( repeaterId && ( ! repeater || repeater.type !== 'repeater' || fieldId === repeaterId ) ) {
			return;
		}

		if ( repeater && ! Array.isArray( repeater.fields ) ) {
			repeater.fields = [];
		}

		const targetList = repeater ? ( repeater.fields as Field[] ) : this.schema.fields;

		this.snapshot();

		found.list.splice( found.index, 1 );

		const at = Math.max( 0, Math.min( index, targetList.length ) );

		targetList.splice( at, 0, found.field );
		this.selected = found.field.id;

		this.markDirty();
		this.renderCanvas();
		this.renderInspector();
	}

	/** Puts a field into the schema. */
	private insertField( field: Field, index?: number ): void {
		if ( ! this.schema ) {
			return;
		}

		if ( ! field.id ) {
			field.id = this.nextFieldId();
		}

		this.snapshot();

		const at = index === undefined ? this.schema.fields.length : Math.max( 0, Math.min( index, this.schema.fields.length ) );

		this.schema.fields.splice( at, 0, field );
		this.selected = field.id;

		this.markDirty();
		this.renderCanvas();
		this.renderInspector();

		window.requestAnimationFrame( () => {
			this.canvas.querySelector< HTMLElement >( `[data-atfb-card="${ CSS.escape( field.id ) }"]` )?.focus();
		} );
	}

	/**
	 * Moves a field to an index.
	 *
	 * `index` counts the list *without* the moved field — see {@link fieldMove}
	 * for why every caller works in that space.
	 */
	private moveField( fieldId: string, index: number ): void {
		if ( ! this.schema ) {
			return;
		}

		const move = fieldMove( this.schema.fields, fieldId, index );

		if ( ! move ) {
			return;
		}

		this.snapshot();

		const [ field ] = this.schema.fields.splice( move.from, 1 );

		this.schema.fields.splice( move.to, 0, field );

		this.markDirty();
		this.renderCanvas();
	}

	/** Copies a field, id and all but the id. */
	private duplicateField( fieldId: string ): void {
		if ( ! this.schema ) {
			return;
		}

		const found = this.locateField( fieldId );

		if ( ! found ) {
			return;
		}

		const copy = JSON.parse( JSON.stringify( found.field ) ) as Field;

		// Every id in the copy is re-minted against one shared pool —
		// duplicating a repeater must not produce a second `age` answering to
		// the first one's `{attendees.age}`.
		const used = this.usedFieldIds();
		const mint = () => {
			let index = used.size + 1;

			while ( used.has( `f${ index }` ) ) {
				index++;
			}

			const id = `f${ index }`;

			used.add( id );

			return id;
		};

		copy.id = mint();

		for ( const sub of ( copy.fields ?? [] ) as Field[] ) {
			sub.id = mint();
		}

		// A duplicate keeps its logic rules, which still point at the *original*
		// fields — that is almost always what somebody duplicating a
		// conditionally-shown field wants.
		if ( found.parent ) {
			this.snapshot();
			found.list.splice( found.index + 1, 0, copy );
			this.selected = copy.id;
			this.markDirty();
			this.renderCanvas();
			this.renderInspector();

			return;
		}

		this.insertField( copy, found.index + 1 );
	}

	/** Removes a field, wherever it lives. */
	private async deleteField( fieldId: string ): Promise< void > {
		if ( ! this.schema ) {
			return;
		}

		const found = this.locateField( fieldId );

		if ( ! found ) {
			return;
		}

		const dependents = this.schema.fields.filter( ( field ) =>
			field.logic?.rules?.some( ( rule ) => rule.field === fieldId )
		);

		const message = dependents.length
			? `Delete this field? ${ dependents.length } other field${
					dependents.length === 1 ? '' : 's'
			  } use it in a condition, and those conditions will stop working.`
			: i18n( 'confirmDelete', 'Delete this? It cannot be undone.' );

		if ( ! ( await confirmAction( message, 'Delete field' ) ) ) {
			return;
		}

		this.snapshot();

		found.list.splice( found.index, 1 );

		if ( this.selected === fieldId ) {
			this.selected = null;
		}

		this.markDirty();
		this.renderCanvas();
		this.renderInspector();
	}

	/** Selects a field and shows it in the inspector. */
	private selectField( fieldId: string ): void {
		this.selected = fieldId;
		this.root.classList.remove( 'atfb--palette-open' );

		// Selection repaints the *selected state*, not the canvas.
		//
		// It used to call `renderCanvas()`, which rebuilds every card — and since
		// the card now contains the field's own editable label and options, that
		// destroyed the element the click had just put the caret in. Clicking into
		// a question to rewrite it therefore focused it and immediately lost it,
		// which read as the field being un-typeable.
		//
		// Nothing about the canvas's *structure* changes when the selection moves,
		// so nothing needs rebuilding: two class toggles say the same thing, keep
		// the caret, and are faster besides.
		for ( const card of this.canvas.querySelectorAll< HTMLElement >( '[data-atfb-card]' ) ) {
			const isSelected = card.dataset.atfbCard === fieldId;

			card.classList.toggle( 'is-selected', isSelected );
			card.setAttribute( 'aria-pressed', isSelected ? 'true' : 'false' );
		}

		// A repeater's sub-fields carry their own selected state, on their own
		// smaller cards.
		for ( const card of this.canvas.querySelectorAll< HTMLElement >( '[data-atfb-subfield]' ) ) {
			card.classList.toggle( 'is-selected', card.dataset.atfbSubfield === fieldId );
		}

		this.logicMap?.highlight( fieldId );
		this.renderInspector();
	}

	/**
	 * A field id not already in use — anywhere, repeater sub-fields included.
	 *
	 * Sub-fields draw from the same pool as top-level fields because a formula
	 * names them as `{repeater.sub}` and a field can be dragged out of a
	 * repeater onto the canvas: an id that collided the moment it surfaced
	 * would make both of those ambiguous.
	 */
	private nextFieldId(): string {
		const used = this.usedFieldIds();
		let index = used.size + 1;

		while ( used.has( `f${ index }` ) ) {
			index++;
		}

		return `f${ index }`;
	}

	/** Every field id in the schema, repeater sub-fields included. */
	private usedFieldIds(): Set< string > {
		const used = new Set< string >();

		for ( const field of this.schema?.fields ?? [] ) {
			used.add( field.id );

			for ( const sub of ( field.fields ?? [] ) as Field[] ) {
				used.add( sub.id );
			}
		}

		return used;
	}

	/**
	 * An id for a new notification or confirmation, not already in use.
	 *
	 * Minted against the ids present, like `nextFieldId()`, rather than from
	 * the list's length: after a delete-then-add, `length + 1` re-issues an id
	 * the list still contains, and two entries sharing one id share one
	 * disclosure panel — opening either folds and unfolds both.
	 */
	private nextEntryId( prefix: string, items: ReadonlyArray< { id: string } > ): string {
		const used = new Set( items.map( ( item ) => item.id ) );
		let index = items.length + 1;

		while ( used.has( `${ prefix }${ index }` ) ) {
			index++;
		}

		return `${ prefix }${ index }`;
	}

	/* ------------------------------------------------------------ Inspector */

	/** Draws the inspector for whatever is selected. */
	private readonly renderInspector = raf( (): void => {
		clear( this.inspector );

		if ( ! this.schema ) {
			return;
		}

		// Only the Build tab has anything to inspect, and only the Build tab has
		// anywhere to drag a field *to*. So on the other tabs both side columns
		// go — a palette you cannot drop from is 240px of furniture, and a
		// permanent "nothing here" column is worse than no column. The width
		// they give back is width the settings and theme panes can use.
		this.root.classList.toggle( 'atfb--build-only-panes', this.tab !== 'build' );

		if ( this.tab !== 'build' ) {
			return;
		}

		const located = this.selected ? this.locateField( this.selected ) : undefined;
		const field = located?.field;
		const parent = located?.parent ?? null;

		// In a narrow window there is room for one side rail, and which one is
		// useful depends on what the user just did: nothing selected means they
		// are adding (palette), a selected field means they are editing
		// (inspector). The container queries in builder.css read this class to
		// make the swap.
		this.root.classList.toggle( 'atfb--has-selection', !! field );

		if ( ! field ) {
			this.inspector.append(
				el( 'div', {
					class: 'atfb-placeholder',
					children: [
						el( 'p', { text: 'Select a field to change it.' } ),
						el( 'p', {
							class: 'atfb-hint',
							text: 'Drag a field from the palette, or press one to add it to the end.',
						} ),
					],
				} )
			);

			return;
		}

		const definition = this.config?.fieldTypes.find( ( candidate ) => candidate.type === field.type );
		const supports = definition?.supports ?? [];

		// Writes resolve the field from the *current* schema at write time, by
		// id. A save replaces `this.schema` with the server's normalised copy
		// and rebinds only the canvas — the inspector keeps these controls — so
		// the `field` found above is orphaned by the first autosave, and writing
		// to it would edit an object nothing serialises. The same trap
		// `PreviewHandlers` documents in field-preview.ts.
		const update = ( key: string, value: unknown ) => {
			const live = this.liveField( field.id );

			if ( ! live ) {
				return;
			}

			( live as unknown as Record< string, unknown > )[ key ] = value;
			this.markDirty();
			this.renderCanvas();
		};

		const done = button( 'Done', () => this.putSelectionDown(), 'ghost', 'yes' );

		done.classList.add( 'atfb-inspector__done' );

		this.inspector.append(
			el( 'div', {
				class: 'atfb-inspector__head',
				children: [ el( 'h3', { class: 'atfb-inspector__title', text: definition?.label ?? field.type } ), done ],
			} )
		);

		if ( parent ) {
			this.inspector.append(
				el( 'p', {
					class: 'atfb-hint atfb-inspector__crumb',
					text: `Inside ${ parent.label || 'a repeater' } — the visitor answers this once per ${
						String( parent.itemLabel ?? '' ) || 'row'
					}.`,
				} ),
				el( 'p', {
					class: 'atfb-hint',
					text: `Formulas aggregate it as {${ parent.id }.${ field.id }} — e.g. sum( {${ parent.id }.${ field.id }} ).`,
				} )
			);
		} else {
			this.inspector.append(
				el( 'p', { class: 'atfb-hint', text: `Reference this field as {field:${ field.id }}` } )
			);
		}

		if ( supports.includes( 'label' ) ) {
			this.inspector.append(
				row(
					'Label',
					bind( textInput( field.label, ( value ) => update( 'label', value ) ), 'label' )
				)
			);
		}

		if ( supports.includes( 'placeholder' ) ) {
			this.inspector.append(
				row(
					'Placeholder',
					bind( textInput( field.placeholder, ( value ) => update( 'placeholder', value ) ), 'placeholder' )
				)
			);
		}

		if ( supports.includes( 'hint' ) ) {
			this.inspector.append(
				row(
					'Hint',
					bind( textInput( field.hint, ( value ) => update( 'hint', value ) ), 'hint' ),
					'Shown under the field, and read out with it.'
				)
			);
		}

		// The wording on the buttons a page break puts at the foot of its page.
		// Both are already honoured by the renderer and neither had a control
		// anywhere, so a form in any language other than English shipped a button
		// saying "Next" and there was nothing to be done about it.
		if ( supports.includes( 'nextlabel' ) ) {
			this.inspector.append(
				row(
					'Next button',
					bind(
						textInput( String( field.nextLabel ?? '' ), ( value ) => update( 'nextLabel', value ) ),
						'nextLabel'
					),
					'Leave empty for “Next”.'
				)
			);
		}

		if ( supports.includes( 'prevlabel' ) ) {
			this.inspector.append(
				row(
					'Back button',
					bind(
						textInput( String( field.prevLabel ?? '' ), ( value ) => update( 'prevLabel', value ) ),
						'prevLabel'
					),
					'Leave empty for “Back”.'
				)
			);
		}

		if ( supports.includes( 'addlabel' ) ) {
			this.inspector.append(
				row(
					'Add button',
					bind(
						textInput( String( field.addLabel ?? '' ), ( value ) => update( 'addLabel', value ) ),
						'addLabel'
					),
					'Leave empty for “Add another”.'
				)
			);
		}

		if ( supports.includes( 'required' ) ) {
			this.inspector.append(
				checkbox( 'Required', field.required, ( value ) => update( 'required', value ) )
			);
		}

		if ( supports.includes( 'width' ) ) {
			this.inspector.append(
				row(
					'Width',
					select(
						field.width,
						[
							{ value: 'full', label: 'Full width' },
							{ value: 'two-thirds', label: 'Two thirds' },
							{ value: 'half', label: 'Half' },
							{ value: 'third', label: 'One third' },
							{ value: 'quarter', label: 'One quarter' },
						],
						( value ) => update( 'width', value )
					)
				)
			);
		}

		if ( definition?.choices ) {
			this.inspector.append( this.renderChoicesEditor( field, update ) );
		}

		this.renderTypeSettings( field, definition, supports, update );

		if ( field.type === 'total' || supports.includes( 'formula' ) ) {
			this.inspector.append(
				row(
					'Formula',
					el( 'div', {
						class: 'atfb-formula__row',
						children: [
							formulaInput(
								textInput( String( field.formula ?? '' ), ( value ) => update( 'formula', value ) ),
								this.schema?.fields ?? [], field.id
							),
							// The editor is where the formula is meant to be
							// written: the questions and the functions are
							// buttons there, and the result computes live
							// against sample answers. The bare box stays for
							// somebody pasting one in.
							button( 'Formula editor', () =>
								openFormulaEditor( {
									root: this.root,
									fields: this.schema?.fields ?? [],
									field: this.liveField( field.id ) ?? field,
									onSave: ( formula ) => {
										update( 'formula', formula );
										this.renderInspector();
									},
								} )
							),
						],
					} ),
					'Reference answers with braces — {f1} * {f2} + 10 — or open the editor and click them in.'
				),
				row( 'Currency symbol', textInput( String( field.currency ?? '' ), ( value ) => update( 'currency', value ) ) )
			);
		}

		if ( field.type === 'total' ) {
			this.inspector.append( row( 'Display total as', select(
				String( field.display ?? 'input' ),
				[ { value: 'output', label: 'Plain text' }, { value: 'input', label: 'Disabled input' } ],
				( value ) => update( 'display', value )
			) ) );
		}

		this.inspector.append( this.renderValidationSection( field, supports, update ) );

		// Conditional logic and prefill act on top-level answers: the logic
		// engine shows and hides whole fields, and prefill writes one value —
		// neither has a meaning "once per row", so offering them on a
		// sub-field would be a switch wired to nothing.
		if ( ! parent ) {
			this.inspector.append( this.renderLogicSection( field ) );

			if ( supports.includes( 'prefill' ) ) {
				this.inspector.append( this.prefillControl( field, update ) );
			}
		}

		if ( supports.includes( 'css' ) ) {
			this.inspector.append(
				row( 'CSS class', textInput( field.cssClass, ( value ) => update( 'cssClass', value ) ) )
			);
		}
	} );

	/**
	 * The settings a field type brings with it.
	 *
	 * Driven by {@link SETTING_CONTROLS} for everything that is a plain value, and
	 * by hand for the three that are not: `default` has to match whatever the field
	 * stores, `rows` means a row count on a textarea and a list of statements on a
	 * Likert matrix, and `parts` is a tick box per part with the list coming from
	 * the server so a filtered part cannot go missing.
	 *
	 * @param field      The field.
	 * @param definition Its registered type.
	 * @param supports   What that type declares.
	 * @param update     Writes one property and repaints.
	 * @return void
	 */
	private renderTypeSettings(
		field: Field,
		definition: FieldType | undefined,
		supports: string[],
		update: ( key: string, value: unknown ) => void
	): void {
		for ( const flag of supports ) {
			const setting = SETTING_CONTROLS[ flag ];

			if ( ! setting ) {
				continue;
			}

			this.inspector.append( settingRow( field, setting, update ) );

			if ( setting.also ) {
				this.inspector.append(
					settingRow(
						field,
						{ ...setting, key: setting.also.key, label: setting.also.label, hint: setting.also.hint, also: undefined },
						update
					)
				);
			}
		}

		// A textarea's `rows` is how tall the box is. A Likert matrix's `rows` are
		// the statements being rated — the same word for a number and a list,
		// which is why neither belongs in the table.
		if ( supports.includes( 'rows' ) && 'likert' !== field.type ) {
			this.inspector.append(
				row(
					'Lines tall',
					numberInput( String( field.rows ?? '' ), ( value ) => update( 'rows', value ) )
				)
			);
		}

		if ( supports.includes( 'rows' ) && 'likert' === field.type ) {
			this.inspector.append( this.renderStatementList( field, update ) );
		}

		if ( supports.includes( 'parts' ) ) {
			this.inspector.append( this.renderPartsEditor( field, definition, update ) );
		}

		// A default only means something where the field holds one value somebody
		// could have typed. Offering to pre-fill a file upload, a signature or a
		// Likert matrix is a box whose contents can never appear anywhere.
		if ( supports.includes( 'default' ) && ! [ 'files', 'object' ].includes( definition?.value ?? '' ) ) {
			this.inspector.append( this.renderDefaultControl( field, definition, update ) );
		}
	}

	/**
	 * The statements a Likert matrix asks about, one per line.
	 *
	 * A textarea rather than a repeating row editor: these are a handful of short
	 * sentences, they are almost always pasted in from somewhere else, and one box
	 * you can paste five lines into beats five boxes you have to create first.
	 *
	 * # The keys are the reason this is not just a list of strings
	 *
	 * A row is `{ key, label }`, and the *key* is what an answer is stored
	 * against — `atf[f1][r2]`. So a row's key has to survive its wording being
	 * changed, or correcting a typo in a statement silently detaches every answer
	 * already given to it, in entries that were collected months ago and are not
	 * looked at again until somebody exports them.
	 *
	 * Rows are therefore matched to lines by position: line three keeps row
	 * three's key however it is reworded. A line added at the end mints a fresh
	 * key, never one that has been used, because reusing a key would attach new
	 * answers to old ones.
	 *
	 * Reordering the lines does move the answers, which is the one case position
	 * matching gets wrong — and is also indistinguishable, from here, from
	 * rewriting both statements. The alternative costs a visible id per row in the
	 * box, which is a worse trade for the common case.
	 *
	 * @param field  The field.
	 * @param update Writes one property.
	 * @return The row.
	 */
	private renderStatementList( field: Field, update: ( key: string, value: unknown ) => void ): HTMLElement {
		const rows = Array.isArray( field.rows ) ? ( field.rows as LikertRow[] ) : [];

		return row(
			'Statements',
			textArea(
				rows.map( ( statement ) => statement.label ?? '' ).join( '\n' ),
				( value ) => update( 'rows', restatement( rows, value ) ),
				5
			),
			'One per line. Each becomes a row of the matrix.'
		);
	}

	/**
	 * Which parts of a name or an address to ask for.
	 *
	 * The available parts come from the server, because `alltfo_name_parts` and
	 * `alltfo_address_parts` are both filterable — a builder with the list baked in
	 * would offer five while the form drew seven.
	 *
	 * Order follows the server's, not the order they were ticked, so the tick
	 * boxes read in the same order as the fields they turn on.
	 *
	 * @param field      The field.
	 * @param definition Its registered type.
	 * @param update     Writes one property.
	 * @return The section.
	 */
	private renderPartsEditor(
		field: Field,
		definition: FieldType | undefined,
		update: ( key: string, value: unknown ) => void
	): HTMLElement {
		const available = definition?.parts ?? [];
		const enabled = Array.isArray( field.parts ) ? ( field.parts as string[] ) : available.map( ( part ) => part.key );

		const boxes = available.map( ( part ) =>
			checkbox( part.label, enabled.includes( part.key ), ( checked ) => {
				const next = available
					.map( ( candidate ) => candidate.key )
					.filter( ( key ) => ( key === part.key ? checked : enabled.includes( key ) ) );

				// Emptying it would render a field with no inputs at all, which
				// looks like the form is broken rather than like a setting.
				update( 'parts', next.length ? next : [ part.key ] );
			} )
		);

		return el( 'div', {
			class: 'atfb-section',
			children: [ el( 'h4', { class: 'atfb-section__title', text: 'Parts to ask for' } ), ...boxes ],
		} );
	}

	/**
	 * The answer a field starts with.
	 *
	 * Typed to match what the field stores: a dropdown of the options where there
	 * are options, a tick box where the field is a toggle, a plain box otherwise.
	 * A text box offering to set the default of a checkbox group is a control that
	 * cannot say the right thing.
	 *
	 * Left out entirely for the types whose value is a structure — a file, a
	 * signature, a repeater — where there is no single value to pre-fill.
	 *
	 * @param field      The field.
	 * @param definition Its registered type.
	 * @param update     Writes one property.
	 * @return The row, or null where a default makes no sense.
	 */
	private renderDefaultControl(
		field: Field,
		definition: FieldType | undefined,
		update: ( key: string, value: unknown ) => void
	): HTMLElement {
		const hint = 'Filled in before they start. They can change it.';

		if ( 'switch' === field.type || 'consent' === field.type ) {
			return checkbox( 'On by default', Boolean( field.default ), ( value ) => update( 'default', value ) );
		}

		if ( definition?.choices && ( field.choices ?? [] ).length ) {
			return row(
				'Default answer',
				select(
					String( field.default ?? '' ),
					[
						{ value: '', label: 'Nothing chosen' },
						...( field.choices ?? [] ).map( ( choice ) => ( {
							value: String( choice.value ),
							label: choice.label || String( choice.value ),
						} ) ),
					],
					( value ) => update( 'default', value )
				),
				hint
			);
		}

		return row(
			'Default answer',
			textInput( String( field.default ?? '' ), ( value ) => update( 'default', value ) ),
			hint
		);
	}

	/** The choices editor, with drag-in image support. */
	private renderChoicesEditor( field: Field, update: ( key: string, value: unknown ) => void ): HTMLElement {
		const choices = ( field.choices ?? [] ) as Choice[];

		// Handlers below write to the choice as it exists in the *current*
		// schema, looked up at write time — never to the `choices` rendered
		// here, which a save orphans along with the field that owns them. The
		// same trap `update()` avoids, one level down.
		const liveChoice = ( index: number ): Choice | undefined => this.liveField( field.id )?.choices?.[ index ];

		const list = el( 'div', { class: 'atfb-choices' } );

		choices.forEach( ( choice, index ) => {
			const rowEl = el( 'div', {
					class: 'atfb-choice-row',
					children: [
						// The image well only exists on a field that shows
						// pictures. Everywhere else it would be a column of
						// empty boxes for a setting that does nothing.
						field.type === 'image_choice' ? this.choiceImageWell( choice, index, field ) : null,
						bind( textInput( choice.label, ( value ) => {
							const live = liveChoice( index );

							if ( ! live ) {
								return;
							}

							// Read *before* the assignment. This compared
							// `choice.value` with `choices[ index ].value` — the
							// same object — so it was always true and the value
							// followed the label unconditionally, which is the
							// one thing the comment says it must not do: an
							// entry stores the value, and rewriting it orphans
							// every submission already recorded under it.
							const mirroring = ! live.value || live.value === live.label;

							live.label = value;

							if ( mirroring ) {
								live.value = value;
							}

							this.markDirty();

							const parent = this.liveField( field.id );

							if ( parent ) {
								this.syncCanvas( parent );
							}
						} ), `choice:${ index }:label` ),
						bind(
							textInput(
								choice.value,
								( value ) => {
									const live = liveChoice( index );

									if ( live ) {
										live.value = value;
										this.markDirty();
									}
								},
								'value'
							),
							`choice:${ index }:value`
						),
						field.type === 'quiz' || choice.points !== undefined
							? numberInput( String( choice.points ?? '' ), ( value ) => {
									const live = liveChoice( index );

									if ( live ) {
										live.points = value === '' ? undefined : Number( value );
										this.markDirty();
									}
							  } )
							: numberInput( String( choice.price ?? '' ), ( value ) => {
									const live = liveChoice( index );

									if ( live ) {
										live.price = value === '' ? undefined : Number( value );
										this.markDirty();
									}
							  } ),
						el( 'button', {
							class: 'atfb-card__action',
							type: 'button',
							attrs: { 'aria-label': `Remove ${ choice.label }` },
							on: {
								click: () => {
									const parent = this.liveField( field.id );

									if ( ! parent ) {
										return;
									}

									( parent.choices ?? [] ).splice( index, 1 );
									update( 'choices', parent.choices );
									this.renderInspector();
								},
							},
							children: [ icon( 'trash' ) ],
						} ),
					],
				} );

			list.append( rowEl );
		} );

		return el( 'div', {
			class: 'atfb-section',
			children: [
				el( 'h4', { text: 'Choices' } ),
				el( 'p', {
					class: 'atfb-hint',
					text: field.type === 'quiz' ? 'Label, value, points.' : 'Label, value, and a price for calculations.',
				} ),
				list,
				button(
					'Add choice',
					() => {
						const parent = this.liveField( field.id );

						if ( ! parent ) {
							return;
						}

						const next = parent.choices ?? [];

						next.push( { label: '', value: '' } );
						update( 'choices', next );
						this.renderInspector();
					},
					'ghost',
					'plus-alt2'
				),
				field.type === 'quiz'
					? row(
							'Correct answer',
							select(
								String( field.correct ?? '' ),
								[
									{ value: '', label: '—' },
									...choices.map( ( choice ) => ( { value: choice.value, label: choice.label } ) ),
								],
								( value ) => update( 'correct', value )
							)
					  )
					: null,
			],
		} );
	}

	/**
	 * The image well on one choice of an image-choice field.
	 *
	 * A drop target for media dragged out of WP Explorer. This is the clearest
	 * demonstration of why the builder is a native window: WP Explorer is a
	 * different window entirely, and its file tiles ride the same
	 * `wp.os.dragManager` this target registers with — so a photograph on the
	 * desktop can be dropped straight onto a form's option. Across an iframe
	 * boundary the two would never meet.
	 *
	 * The attachment id is what gets stored; the URL in the payload is used only
	 * to paint the thumbnail immediately, so the well fills the moment the drop
	 * lands rather than after a round trip.
	 */
	private choiceImageWell( choice: Choice, index: number, field: Field ): HTMLElement {
		const well = el( 'div', {
			class: `atfb-well${ choice.image ? ' has-image' : '' }`,
			attrs: {
				'data-choice': index,
				'aria-label': `Image for ${ choice.label || `choice ${ index + 1 }` }`,
			},
			children: [ choice.image ? el( 'span', { class: 'atfb-well__id', text: `#${ choice.image }` } ) : icon( 'format-image' ) ],
		} );

		const teardown = getDragManager().registerDropTarget( {
			id: `atfb-well-${ field.id }-${ index }`,
			element: well,
			// WP Explorer has used more than one payload slug across shell
			// versions, so every spelling this plugin knows about is accepted
			// rather than betting on one.
			accept: ( payload ) => MEDIA_PAYLOAD_TYPES.includes( payload.type ),
			onEnter: () => well.classList.add( 'is-dropping' ),
			onLeave: () => well.classList.remove( 'is-dropping' ),
			onDrop: ( session ) => {
				well.classList.remove( 'is-dropping' );

				const data = session.payload.data as {
					id?: number;
					attachmentId?: number;
					file?: { id?: number; url?: string };
					url?: string;
				};

				const id = Number( data.attachmentId ?? data.id ?? data.file?.id ?? 0 );

				if ( ! id ) {
					notify( 'That is not an image this field can use', '', 'error' );

					return;
				}

				// Written to the choice in the *current* schema, not the one this
				// well was rendered from — a save may have replaced it since.
				const live = this.liveField( field.id )?.choices?.[ index ];

				if ( ! live ) {
					return;
				}

				live.image = id;
				this.markDirty();
				this.renderInspector();
			},
		} );

		this.teardowns.push( teardown );

		// Clicking clears it, because there is otherwise no way to undo a drop
		// and the well is the only place the setting lives.
		well.addEventListener( 'click', () => {
			const live = this.liveField( field.id )?.choices?.[ index ];

			if ( ! live?.image ) {
				return;
			}

			live.image = undefined;
			this.markDirty();
			this.renderInspector();
		} );

		return well;
	}

	/** Validation settings for a field. */
	private renderValidationSection(
		field: Field,
		supports: string[],
		update: ( key: string, value: unknown ) => void
	): HTMLElement {
		const rows: HTMLElement[] = [];

		const pairs: Array< [ string, string ] > = [];

		if ( supports.includes( 'minlength' ) ) {
			pairs.push( [ 'minlength', 'Minimum characters' ], [ 'maxlength', 'Maximum characters' ] );
		}

		if ( supports.includes( 'min' ) ) {
			pairs.push( [ 'min', 'Minimum' ], [ 'max', 'Maximum' ] );
		} else if ( supports.includes( 'max' ) ) {
			// A star rating declares a ceiling and no floor, so pairing the two
			// meant its ceiling — how many stars there are — had no control at all.
			pairs.push( [ 'max', 'Highest' ] );
		}

		if ( supports.includes( 'step' ) ) {
			pairs.push( [ 'step', 'Steps of' ] );
		}

		if ( supports.includes( 'mindate' ) ) {
			pairs.push( [ 'minDate', 'Earliest date' ], [ 'maxDate', 'Latest date' ] );
		}

		if ( supports.includes( 'mintime' ) ) {
			pairs.push( [ 'minTime', 'Earliest time' ], [ 'maxTime', 'Latest time' ] );
		}

		for ( const [ key, label ] of pairs ) {
			rows.push(
				row(
					label,
					textInput( String( field[ key ] ?? '' ), ( value ) => update( key, value ) )
				)
			);
		}

		if ( supports.includes( 'pattern' ) ) {
			rows.push( ...this.renderAnswerShapeRows( field, update ) );
		}

		if ( supports.includes( 'unique' ) ) {
			rows.push(
				checkbox( 'No two people may submit the same value', Boolean( field.unique ), ( value ) =>
					update( 'unique', value )
				)
			);
		}

		const messages = ( field.messages ?? {} ) as Record< string, string >;

		// Only where the field can be required at all. A spacer offered a box for
		// the wording of an error it can never raise, which reads as a setting that
		// does nothing — and on a layout block it was the *only* row in the
		// section, so the section existed to hold it.
		if ( supports.includes( 'required' ) ) {
			rows.push(
				row(
					'Message when required',
					textInput( messages.required ?? '', ( value ) => {
						messages.required = value;
						update( 'messages', messages );
					} ),
					'Leave empty for the default wording.'
				)
			);
		}

		if ( ! rows.length ) {
			return el( 'div', { class: 'atfb-section is-empty' } );
		}

		return this.section( `validation:${ field.id }`, 'Validation', rows );
	}

	/**
	 * The answer-shape dropdown itself.
	 *
	 * The shell's `<os-select>` when its components are loaded — the same
	 * control as every other inspector dropdown. It has no notion of
	 * `optgroup`, so the group headings ride along as disabled options, which
	 * its listbox paints muted and unpickable: the same reading an optgroup
	 * heading gives. The plain admin page gets a native select with real
	 * optgroups.
	 *
	 * @param current The selected value.
	 * @param onPick  Called with the newly picked value.
	 * @return The control.
	 */
	private buildShapePicker( current: string, onPick: ( value: string ) => void ): HTMLElement {
		const groups: Array< { heading: string | null; options: Array< { value: string; label: string } > } > = [
			{ heading: null, options: [ { value: '', label: 'Anything at all' } ] },
			...VALIDATION_GROUPS.map( ( group ) => ( {
				heading: group,
				options: VALIDATION_PRESETS.filter( ( preset ) => preset.group === group ).map( ( preset ) => ( {
					value: preset.slug,
					label: preset.label,
				} ) ),
			} ) ),
			{ heading: 'Your own', options: [ { value: 'custom', label: 'A custom rule…' } ] },
		];

		if ( hasComponent( 'os-select' ) && hasComponent( 'os-option' ) ) {
			const host = document.createElement( 'os-select' );

			host.setAttribute( 'value', current );
			host.setAttribute( 'aria-label', 'What the answer should look like' );
			host.classList.add( 'atfb-field' );

			for ( const group of groups ) {
				if ( group.heading ) {
					const heading = document.createElement( 'os-option' );

					heading.setAttribute( 'value', `__heading:${ group.heading }` );
					heading.setAttribute( 'disabled', '' );
					heading.textContent = group.heading;
					host.append( heading );
				}

				for ( const option of group.options ) {
					const item = document.createElement( 'os-option' );

					item.setAttribute( 'value', option.value );
					item.textContent = option.label;
					host.append( item );
				}
			}

			host.addEventListener( 'os-pick', ( event: Event ) => {
				onPick( String( ( event as CustomEvent< { value?: string } > ).detail?.value ?? '' ) );
			} );

			return host;
		}

		const picker = el( 'select', {
			class: 'atfb-input atfb-select',
			attrs: { 'aria-label': 'What the answer should look like' },
			on: {
				change: ( event: Event ) => onPick( ( event.target as HTMLSelectElement ).value ),
			},
		} );

		for ( const group of groups ) {
			const parent = group.heading
				? ( () => {
						const optgroup = document.createElement( 'optgroup' );

						optgroup.label = group.heading;
						picker.append( optgroup );

						return optgroup;
				  } )()
				: picker;

			for ( const option of group.options ) {
				parent.append(
					el( 'option', {
						value: option.value,
						text: option.label,
						attrs: { selected: option.value === current },
					} )
				);
			}
		}

		return picker;
	}

	/**
	 * "The answer should look like…" — the validation picker.
	 *
	 * The pattern box asked for a regular expression, which is asking the
	 * wrong person the wrong question. The picker asks the one they can
	 * answer: an email address, a phone number, a ZIP code — each preset
	 * enforced identically by the browser and the server. When nothing fits,
	 * "A custom rule…" opens the rule builder, where the blocks are plain
	 * questions and a playground judges sample answers live.
	 *
	 * @param field  The field being inspected.
	 * @param update The inspector's writer.
	 * @return The rows for the validation section.
	 */
	private renderAnswerShapeRows( field: Field, update: ( key: string, value: unknown ) => void ): HTMLElement[] {
		const stored = 'string' === typeof field.validation ? field.validation : '';

		// A pattern with no slug predates the picker: it behaves exactly as a
		// custom rule, so it is shown as one rather than as "Anything".
		const current = stored || ( field.pattern ? 'custom' : '' );

		const openEditor = () =>
			openValidationEditor( {
				root: this.root,
				field: this.liveField( field.id ) ?? field,
				onSave: ( result ) => {
					update( 'validation', 'custom' );
					update( 'pattern', result.pattern );
					update( 'validationRecipe', JSON.stringify( result.recipe ) );

					const messages = { ...( ( this.liveField( field.id )?.messages ?? {} ) as Record< string, string > ) };

					messages.invalid = result.message;
					update( 'messages', messages );
					this.renderInspector();
				},
				onCancel: () => this.renderInspector(),
			} );

		const onPick = ( value: string ) => {
			if ( 'custom' === value ) {
				// The rule builder writes everything on save; until then
				// nothing changes, and cancelling restores the picker to what
				// the field really has.
				openEditor();

				return;
			}

			update( 'validation', value );

			// A preset replaces whatever custom rule there was; keeping the
			// old pattern alongside it would enforce both at once.
			update( 'pattern', '' );
			update( 'validationRecipe', '' );
			this.renderInspector();
		};

		const picker = this.buildShapePicker( current, onPick );

		const preset = validationPreset( current );
		const rows = [
			row(
				'The answer should be',
				picker,
				preset ? `e.g. ${ preset.example }` : 'Checked as they type, and again on the server.'
			),
		];

		if ( 'custom' === current ) {
			const recipe = parseRecipe( String( field.validationRecipe ?? '' ) );
			const described =
				describeRecipe( recipe ) ||
				( field.pattern ? `Matches the expression ${ String( field.pattern ) }` : 'No rule yet — open the builder.' );

			rows.push(
				row(
					'Your rule',
					el( 'div', {
						class: 'atfb-valrule',
						children: [
							el( 'p', { class: 'atfb-valrule__words', text: described } ),
							button( 'Edit the rule…', openEditor, 'secondary', 'edit' ),
						],
					} ),
					compileRecipe( recipe ) || field.pattern
						? 'Built in the rule builder, with a playground to test it.'
						: undefined
				)
			);
		}

		return rows;
	}

	/**
	 * The rule cards, joiners and Add-rule button shared by every logic editor.
	 *
	 * Fields, confirmations and notifications all carry the same `Logic`
	 * block. What differs is where the live copy lives and what a write must
	 * repaint, so the write arrives as a callback; `exclude` keeps a field
	 * from offering itself as its own condition.
	 *
	 * Returns the rule stack and the Add-rule button as separate elements so
	 * each caller can place its own sentence between the enable switch and
	 * the rules.
	 */
	private logicRulesEditor(
		logic: Logic,
		write: ( mutate: ( live: Logic ) => void, rebuild?: boolean ) => void,
		exclude = ''
	): HTMLElement[] {
		const others = ( this.schema?.fields ?? [] ).filter(
			( candidate ) => candidate.id !== exclude && candidate.type !== 'page_break'
		);

		/**
		 * The "and" / "or" between two rule cards — a button, because it is
		 * the same fact the canvas row lets you flip in place. One setting
		 * governs every joint, so clicking any of them switches all.
		 */
		const joiner = () =>
			el( 'div', {
				class: 'atfb-rule-join',
				children: [
					el( 'button', {
						class: 'atfb-rule-join__chip',
						type: 'button',
						text: 'all' === logic.match ? 'and' : 'or',
						title: 'Switch between needing every rule (and) or any one of them (or).',
						on: {
							click: () =>
								write( ( live ) => {
									live.match = 'all' === live.match ? 'any' : 'all';
								}, true ),
						},
					} ),
				],
			} );

		/**
		 * One rule as a small card: the question, the comparison and the
		 * answer stacked full width, so nothing has to truncate to share a
		 * 250px column with two siblings — which is exactly what the old
		 * one-line grid made them do.
		 */
		const ruleCard = ( rule: LogicRule, index: number ): HTMLElement => {
			const remove = el( 'button', {
				class: 'atfb-card__action',
				type: 'button',
				attrs: { 'aria-label': 'Remove this rule' },
				title: 'Remove this rule',
				on: {
					click: () =>
						write( ( live ) => {
							live.rules.splice( index, 1 );
						}, true ),
				},
				children: [ icon( 'trash' ) ],
			} );

			const children: HTMLElement[] = [
				el( 'div', {
					class: 'atfb-rule__top',
					children: [
						select(
							rule.field,
							others.map( ( candidate ) => ( {
								value: candidate.id,
								label: candidate.label || candidate.id,
							} ) ),
							( value ) =>
								// A new source question invalidates the old
								// answer — a value picked from one field's
								// choices means nothing against another's.
								write( ( live ) => {
									const liveRule = live.rules[ index ];

									if ( liveRule ) {
										liveRule.field = value;
										liveRule.value = '';
									}
								}, true )
						),
						remove,
					],
				} ),
				select(
					rule.operator,
					Object.entries( this.config?.operators ?? {} ).map( ( [ value, label ] ) => ( { value, label } ) ),
					( value ) =>
						// "is empty" needs no answer and "is" does, so the
						// card's own shape depends on this — rebuild.
						write( ( live ) => {
							const liveRule = live.rules[ index ];

							if ( liveRule ) {
								liveRule.operator = value as LogicRule[ 'operator' ];
							}
						}, true )
				),
			];

			// The answer control earns its shape from the rule: none at all
			// for an operator that is a complete statement on its own, the
			// source question's own choices where it has them, free text
			// otherwise. It was a bare text box in every case, which let you
			// type an answer a radio group can never produce.
			if ( ! VALUELESS_OPERATORS.includes( rule.operator ) ) {
				const source = this.schema?.fields.find( ( candidate ) => candidate.id === rule.field );

				const options = conditionValueOptions( source, rule.value, this.config?.countries );
				if ( options ) {
					children.push(
						select( rule.value, options, ( value ) =>
							write( ( live ) => {
								const liveRule = live.rules[ index ];

								if ( liveRule ) {
									liveRule.value = value;
								}
							} )
						)
					);
				} else {
					children.push(
						textInput(
							rule.value,
							( value ) =>
								write( ( live ) => {
									const liveRule = live.rules[ index ];

									if ( liveRule ) {
										liveRule.value = value;
									}
								} ),
							'The answer to compare against'
						)
					);
				}
			}

			children[ 0 ].querySelector( 'select, os-select' )?.setAttribute( 'aria-label', 'Question used by this rule' );
			children[ 1 ].setAttribute( 'aria-label', 'How the answer is compared' );
			children[ 2 ]?.setAttribute( 'aria-label', 'The answer that triggers this' );
			if ( children[ 2 ]?.matches( 'select, os-select' ) ) children[ 2 ].classList.add( 'atfb-cond__value-select' );

			return el( 'div', { class: 'atfb-rule', children } );
		};

		const rules = el( 'div', { class: 'atfb-rules' } );

		logic.rules.forEach( ( rule, index ) => {
			if ( index > 0 ) {
				rules.append( joiner() );
			}

			rules.append( ruleCard( rule, index ) );
		} );

		const add = button(
			'Add rule',
			() => {
				write( ( live ) => {
					live.rules.push( {
						field: others[ 0 ]?.id ?? '',
						operator: 'is',
						value: '',
					} );
				}, true );
			},
			'ghost',
			'plus-alt2'
		);

		return [ rules, add ];
	}

	/**
	 * The conditions section for a confirmation or a notification.
	 *
	 * Fields decide their own visibility through `renderLogicSection`; these
	 * two decide whether they *fire* — the same `Logic` block without the
	 * show/hide half, evaluated by `alltfo_logic_conditions_met()` on submit.
	 * The copy above the confirmations list has promised "the first one whose
	 * conditions match" since the list existed; this is the editor that
	 * promise was missing.
	 *
	 * Writes mutate the object in place, the way every other control on
	 * these panes does — the pane is rebuilt from the schema on structural
	 * changes and the `section()` key keeps it open across the rebuild.
	 */
	private conditionsSection( key: string, noun: 'confirmation' | 'notification', logic: Logic ): HTMLElement {
		const write = ( mutate: ( live: Logic ) => void, rebuild = false ) => {
			mutate( logic );
			this.markDirty();

			if ( rebuild ) {
				this.renderCanvas();
			}
		};

		const verb = 'confirmation' === noun ? 'Use' : 'Send';

		return this.section(
			`conditions:${ key }`,
			'Conditions',
			[
				this.copyConditionButton( `${ noun }:${ key }` ),
				checkbox(
					`Only ${ verb.toLowerCase() } this ${ noun } sometimes`,
					logic.enabled,
					( value ) =>
						write( ( live ) => {
							live.enabled = value;
						}, true )
				),
				logic.enabled
					? el( 'div', {
							children: [
								el( 'div', {
									class: 'atfb-rule-head',
									children: [
										el( 'span', { text: `${ verb } it when` } ),
										select(
											logic.match,
											[
												{ value: 'all', label: 'all' },
												{ value: 'any', label: 'any' },
											],
											( value ) =>
												write( ( live ) => {
													live.match = value as 'all' | 'any';
												}, true )
										),
										el( 'span', { text: 'of these match:' } ),
									],
								} ),
								...this.logicRulesEditor( logic, write ),
							],
					  } )
					: null,
			],
			// One that already has conditions opens showing them, for the same
			// reason a conditioned field's logic section does.
			logic.enabled
		);
	}

	/** Reuse a condition, resolving the schema when the chooser applies it. */
	private copyConditionButton( key: string ): HTMLElement {
		return el( 'button', {
			class: 'atfb-button atfb-copy-condition', type: 'button',
			children: [ icon( 'admin-page' ), el( 'span', { text: 'Copy condition' } ) ],
			on: { click: () => openConditionCopy( {
				root: this.root,
				schema: () => this.schema,
				to: key,
				beforeCopy: () => this.snapshot(),
				onCopy: () => {
					this.snapshot();
					this.markDirty();
					this.renderCanvas();
					this.renderInspector();
				},
			} ) },
		} );
	}

	/** The conditional-logic editor. */
	private renderLogicSection( field: Field ): HTMLElement {
		const logic = field.logic;

		// Handlers below write to the logic block of the field as it exists in
		// the *current* schema, resolved at write time — `logic` above is only
		// what this render paints from, and a save orphans it along with the
		// field it belongs to. The same trap `update()` avoids.
		const liveLogic = () => this.liveField( field.id )?.logic;

		/**
		 * Writes to the live logic and repaints both views of it.
		 *
		 * The canvas card carries the same condition as this panel, so every
		 * write repaints the canvas too — before this, a rule edited here went
		 * stale on the card until something else happened to redraw it. The
		 * inspector itself is rebuilt only when asked: a keystroke in the
		 * value box must not destroy the box mid-word.
		 */
		const write = ( mutate: ( live: Logic ) => void, rebuild = false ) => {
			const live = liveLogic();

			if ( ! live ) {
				return;
			}

			mutate( live );
			this.markDirty();
			this.renderCanvas();

			if ( rebuild ) {
				this.renderInspector();
			}
		};

		const editor = this.logicRulesEditor( logic, write, field.id );

		return this.section(
			`logic:${ field.id }`,
			'Conditional logic',
			[
				checkbox( 'Only show this field sometimes', logic.enabled, ( value ) => {
					write( ( live ) => {
						live.enabled = value;
					}, true );
				} ),
				logic.enabled
					? el( 'div', {
							children: [
								el( 'div', {
									class: 'atfb-rule-head',
									children: [
										select(
											logic.action,
											[
												{ value: 'show', label: 'Show' },
												{ value: 'hide', label: 'Hide' },
											],
											( value ) =>
												write( ( live ) => {
													live.action = value as 'show' | 'hide';
												}, true )
										),
										el( 'span', { text: 'this field when' } ),
										select(
											logic.match,
											[
												{ value: 'all', label: 'all' },
												{ value: 'any', label: 'any' },
											],
											( value ) =>
												write( ( live ) => {
													live.match = value as 'all' | 'any';
												}, true )
										),
										el( 'span', { text: 'of these match:' } ),
									],
								} ),
								...editor,
							],
					  } )
					: null,
				el( 'div', { class: 'atfb-logic-actions', children: [ this.copyConditionButton( `field:${ field.id }` ) ] } ),
			],
			// A field that already has a condition opens showing it: being told a
			// rule governs this field and not what it says is the problem the
			// whole logic display exists to solve.
			logic.enabled
		);
	}

	/* ------------------------------------------------------------ Tab panes */

	/** The canvas contents for the non-Build tabs. */
	private renderTabCanvas(): HTMLElement {
		if ( ! this.schema ) {
			return el( 'div' );
		}

		if ( this.tab === 'theme' ) {
			return mountThemeControls( {
				themes: this.themes,
				tokens: this.config?.tokens ?? [],
				activeSlug: this.schema.settings.theme,
				overrides: this.schema.settings.themeOverrides,
				onTheme: ( slug ) => {
					this.schema!.settings.theme = slug;
					this.markDirty();
				},
				onOverride: ( token, value ) => {
					if ( value === '' ) {
						delete this.schema!.settings.themeOverrides[ token ];
					} else {
						this.schema!.settings.themeOverrides[ token ] = value;
					}

					this.markDirty();
				},
				// The studio clears the whole set on a theme switch, save or
				// delete. Without this the schema keeps the old theme's tuning
				// while the preview shows none of it, and the published form
				// disagrees with what the Theme tab said it would look like.
				onOverridesReplaced: ( overrides ) => {
					this.schema!.settings.themeOverrides = { ...overrides };
					this.markDirty();
				},
				previewFor: ( slug, overrides ) => this.previewHtml( slug, overrides ),
				onThemesChanged: ( themes ) => {
					this.themes = themes;
				},
			} );
		}

		if ( this.tab === 'settings' ) {
			return this.renderSettingsPane();
		}

		if ( this.tab === 'notify' ) {
			return this.renderNotificationsPane();
		}

		return this.renderConfirmationsPane();
	}

	/**
	 * Puts the form's own theme tokens onto the canvas.
	 *
	 * The previews on the canvas use the real front-end classes, so they are
	 * already styled by `form.css` — but `form.css` reads everything from custom
	 * properties, and without them it falls back to the built-in defaults. The
	 * result would be a canvas that looks like Clean whatever theme the form is
	 * set to, which is the one thing a WYSIWYG canvas must not do.
	 *
	 * The values come from the server's own renderer rather than being resolved
	 * again here. A form's theme is a base theme plus per-form overrides plus
	 * whatever `alltfo_theme_tokens` filters did to it, and a second resolver in
	 * TypeScript would be a second answer to "what colour is this" — the same
	 * twin-engine problem the logic and calculation code goes to some length to
	 * avoid. One render is asked for, the token declarations are lifted off its
	 * wrapper's `style` attribute, and they are re-scoped to the canvas.
	 *
	 * Failure is silent on purpose: no tokens means the previews render in the
	 * default theme, which is a worse-looking canvas and a working builder.
	 */
	private async paintCanvasTheme(): Promise< void > {
		if ( ! this.form || ! this.schema ) {
			return;
		}

		const theme = this.schema.settings.theme;
		const signature = JSON.stringify( [ theme, this.schema.settings.themeOverrides ] );

		if ( signature === this.canvasThemeSignature ) {
			return;
		}

		this.canvasThemeSignature = signature;

		try {
			const html = await this.previewHtml( theme, this.schema.settings.themeOverrides ?? {} );

			// A dark theme's text tokens assume the theme's own background. The
			// canvas cards are builder-white, so without this the previews wore
			// near-white text on white — the theme's colours with none of its
			// ground. The server marks dark themes on the form it renders; the
			// canvas previews are builder-built and never carry that class, so
			// the flag is hoisted to the root and the stylesheet paints every
			// preview's ground from it.
			this.root.classList.toggle( 'atfb--dark-form', /atf-is-dark/.test( html ) );

			// The server puts the tokens on the wrapper's own `style` attribute,
			// scoped to the one instance it rendered. The canvas has many
			// previews and no wrapper, so the declarations are lifted off the
			// attribute and re-scoped to the class they all carry.
			const block = /class="atf-form-wrap"[^>]*\sstyle="([^"]*)"/.exec( html );

			if ( ! block ) {
				return;
			}

			// `esc_attr()` on the server entity-encodes the attribute; the only
			// entities a sanitised token value can actually contain are these.
			const decls = block[ 1 ]
				.replace( /&quot;/g, '"' )
				.replace( /&#0?39;/g, "'" )
				.replace( /&amp;/g, '&' );

			this.canvasTheme.textContent = `.atfb .atfb-preview {\n${ decls }\n}`;

			if ( ! this.canvasTheme.isConnected ) {
				this.root.append( this.canvasTheme );
			}
		} catch {
			// See above: the canvas simply keeps the default look.
		}
	}

	/** Renders the current schema to HTML for a preview. */
	private async previewHtml( theme: string, overrides: Record< string, string > ): Promise< string > {
		if ( ! this.form || ! this.schema ) {
			return '';
		}

		const schema = JSON.parse( JSON.stringify( this.schema ) ) as FormSchema;

		schema.settings.theme = theme;
		schema.settings.themeOverrides = overrides;

		const { html } = await api.preview( this.form.id, { schema, theme } );

		return html;
	}

	/** The form's own settings. */
	private renderSettingsPane(): HTMLElement {
		const settings = this.schema!.settings;

		const set = ( path: string, value: unknown ) => {
			const parts = path.split( '.' );
			let target = settings as unknown as Record< string, unknown >;

			for ( let i = 0; i < parts.length - 1; i++ ) {
				target = target[ parts[ i ] ] as Record< string, unknown >;
			}

			target[ parts[ parts.length - 1 ] ] = value;
			this.markDirty();
		};

		return el( 'div', {
			class: 'atfb-pane',
			children: [
				el( 'h2', { text: 'Settings' } ),

				el( 'section', {
					children: [
						el( 'h3', { text: 'Submitting' } ),
						row( 'Button label', textInput( settings.submitLabel, ( value ) => set( 'submitLabel', value ) ) ),
						checkbox( 'Submit without reloading the page', settings.ajax, ( value ) => set( 'ajax', value ) ),
						row(
							'Progress indicator',
							select(
								settings.progressBar,
								[
									{ value: 'steps', label: 'Numbered steps' },
									{ value: 'bar', label: 'A bar' },
									{ value: 'none', label: 'None' },
								],
								( value ) => set( 'progressBar', value )
							),
							'Only shown on forms with a page break.'
						),
					],
				} ),

				el( 'section', {
					children: [
						el( 'h3', { text: 'Who can fill this in' } ),
						checkbox( 'Only logged-in users', settings.requireLogin, ( value ) => set( 'requireLogin', value ) ),
						row(
							'Message for everyone else',
							textInput( settings.loginMessage, ( value ) => set( 'loginMessage', value ) )
						),
						row(
							'Open from',
							el( 'input', {
								class: 'atfb-input',
								type: 'datetime-local',
								value: settings.schedule.start,
								on: {
									input: ( event: Event ) =>
										set( 'schedule.start', ( event.target as HTMLInputElement ).value ),
								},
							} )
						),
						row(
							'Closes',
							el( 'input', {
								class: 'atfb-input',
								type: 'datetime-local',
								value: settings.schedule.end,
								on: {
									input: ( event: Event ) => set( 'schedule.end', ( event.target as HTMLInputElement ).value ),
								},
							} )
						),
						row(
							'Message when closed',
							textInput( settings.schedule.message, ( value ) => set( 'schedule.message', value ) )
						),
						row(
							'Stop after this many submissions',
							numberInput( String( settings.limit.total || '' ), ( value ) =>
								set( 'limit.total', Number( value ) || 0 )
							),
							'0 means no limit.'
						),
						row(
							'Submissions per logged-in user',
							numberInput( String( settings.limit.perUser || '' ), ( value ) =>
								set( 'limit.perUser', Number( value ) || 0 )
							)
						),
					],
				} ),

				el( 'section', {
					children: [
						el( 'h3', { text: 'Spam' } ),
						el( 'p', {
							class: 'atfb-hint',
							text: 'No captcha. Nothing here asks the visitor to prove anything.',
						} ),
						checkbox( 'Honeypot field', settings.spam.honeypot, ( value ) => set( 'spam.honeypot', value ) ),
						row(
							'Reject submissions faster than (seconds)',
							numberInput( String( settings.spam.timeTrap ), ( value ) =>
								set( 'spam.timeTrap', Number( value ) || 0 )
							),
							'A human cannot fill in a form in under a second. A script can.'
						),
						row(
							'Submissions allowed per hour, per address',
							numberInput( String( settings.spam.rateLimit ), ( value ) =>
								set( 'spam.rateLimit', Number( value ) || 0 )
							)
						),
						row(
							'Blocked words',
							textArea( settings.spam.blocklist, ( value ) => set( 'spam.blocklist', value ), 4 ),
							'One per line.'
						),
						checkbox( 'Check submissions with Akismet', settings.spam.akismet, ( value ) =>
							set( 'spam.akismet', value )
						),
						el( 'p', {
							class: 'atfb-hint',
							text:
								'Off unless you switch it on. When on, each submission — the answers, plus the '
								+ 'sender’s IP address and user agent — is sent to Akismet’s servers for a spam '
								+ 'verdict. Needs the Akismet plugin installed and configured.',
						} ),
						checkbox( 'Ask a simple sum before sending', settings.spam.challenge, ( value ) =>
							set( 'spam.challenge', value )
						),
						el( 'p', {
							class: 'atfb-hint',
							text:
								'Only for a form under sustained attack — it is the one check here that asks the '
								+ 'visitor to do something. Still kinder than an image captcha: it is answerable by '
								+ 'a screen reader, and it hands no data to anyone.',
						} ),
					],
				} ),

				el( 'section', {
					children: [
						el( 'h3', { text: 'Storage and privacy' } ),
						checkbox( 'Keep entries', settings.storage.entries, ( value ) => set( 'storage.entries', value ) ),
						checkbox( 'Record IP addresses', settings.storage.ip, ( value ) => set( 'storage.ip', value ) ),
						checkbox( 'Anonymise recorded IP addresses', settings.storage.anonymise, ( value ) =>
							set( 'storage.anonymise', value )
						),
						row(
							'Delete entries after (days)',
							numberInput( String( settings.storage.retention || '' ), ( value ) =>
								set( 'storage.retention', Number( value ) || 0 )
							),
							'0 keeps them forever. Anything else deletes automatically, every day.'
						),
					],
				} ),

				el( 'section', {
					children: [
						el( 'h3', { text: 'Analytics' } ),
						checkbox( 'Count views and starts', settings.analytics.enabled, ( value ) =>
							set( 'analytics.enabled', value )
						),
						checkbox( 'Tally device, browser and system', settings.analytics.tech, ( value ) =>
							set( 'analytics.tech', value )
						),
						el( 'p', {
							class: 'atfb-hint',
							text:
								'Counters, never people: no cookie, no fingerprint, no per-visitor record — the '
								+ 'tallies keep coarse classes like “phone” and “Chrome”, not the visitor’s '
								+ 'user-agent string. Nothing here needs a consent banner. Turning the first '
								+ 'switch off stops view and start counting entirely.',
						} ),
					],
				} ),

				el( 'section', {
					children: [
						el( 'h3', { text: 'Save and continue later' } ),
						checkbox( 'Let people save a half-finished form', settings.resume.enabled, ( value ) =>
							set( 'resume.enabled', value )
						),
						row(
							'Keep a saved form for (days)',
							numberInput( String( settings.resume.days ), ( value ) =>
								set( 'resume.days', Math.max( 1, Number( value ) || 30 ) )
							)
						),
						el( 'p', {
							class: 'atfb-hint',
							text:
								'The link this creates is the only key to those answers — anyone holding it can read them. '
								+ 'For genuinely sensitive questions, require login instead.',
						} ),
					],
				} ),

				el( 'section', {
					children: [
						el( 'h3', { text: 'Archive' } ),
						el( 'p', {
							class: 'atfb-hint',
							text:
								'Retire the form when its moment has passed. It stops accepting responses and leaves '
								+ 'every list, and its entries and stats go with it — nothing is deleted, and restoring '
								+ 'it brings all of it back exactly as it was.',
						} ),
						button( 'Archive this form', () => void this.archiveCurrentForm(), 'secondary', 'archive' ),
					],
				} ),

				el( 'section', {
					children: [
						el( 'h3', { text: 'Delete' } ),
						el( 'p', {
							class: 'atfb-hint',
							text:
								'Deleting is for a form that should never have existed. It moves to the desktop’s '
								+ 'Trash, disappears from every list, and any page still carrying its shortcode '
								+ 'shows nothing at all. Its entries stay in Entries, and until the Trash is '
								+ 'emptied you can bring it back from there. If the form simply had its day, '
								+ 'archive it instead.',
						} ),
						button( 'Delete this form', () => void this.deleteCurrentForm(), 'danger', 'trash' ),
					],
				} ),
			],
		} );
	}

	/**
	 * Archives the open form, entries and stats included.
	 *
	 * Unsaved edits are saved first: the archive keeps whatever the form is at
	 * the moment it goes in, and losing the last half hour of edits because
	 * archiving skipped the save would be a quiet little disaster.
	 */
	private async archiveCurrentForm(): Promise< void > {
		if ( ! this.form ) {
			return;
		}

		const title = this.form.title || '(untitled)';
		const entries = this.forms.find( ( form ) => form.id === this.form!.id )?.entries ?? 0;

		const confirmed = await confirmAction(
			`Archive “${ title }”? It stops accepting responses and leaves every list — its ${ entries } ${
				entries === 1 ? 'entry' : 'entries'
			} and its stats go with it. Nothing is deleted: restore it any time from “Start a new form”.`,
			'Archive form'
		);

		if ( ! confirmed ) {
			return;
		}

		try {
			if ( this.dirty ) {
				await this.save( true );
			}

			await api.archiveForm( this.form.id );
			notify( 'Form archived', `${ title } — restore it any time from the New form dialog.` );

			await this.releaseCurrentForm();
		} catch ( error ) {
			notify( 'Could not archive the form', error instanceof Error ? error.message : '', 'error' );
		}
	}

	/**
	 * Deletes the open form.
	 *
	 * No save-first, unlike the archive: saving a form on its way to the trash
	 * would only preserve edits nobody will ever see. The entries deliberately
	 * stay — they are the visitors' words, not the form's — and the server
	 * uses the trash rather than a hard delete, so a wrong click ends in the
	 * desktop's Trash window, not in a loss.
	 */
	private async deleteCurrentForm(): Promise< void > {
		if ( ! this.form ) {
			return;
		}

		const title = this.form.title || '(untitled)';
		const entries = this.forms.find( ( form ) => form.id === this.form!.id )?.entries ?? 0;

		const confirmed = await confirmAction(
			`Delete “${ title }”? Every page showing it goes blank. ${
				entries
					? `Its ${ entries } ${ entries === 1 ? 'entry stays' : 'entries stay' } in Entries. `
					: ''
			}It moves to the desktop’s Trash — restore it from there if you change your mind.`,
			'Delete form'
		);

		if ( ! confirmed ) {
			return;
		}

		try {
			const formId = this.form.id;

			await api.deleteForm( formId );

			// Tell the rest of the desktop *now*. The open Trash window and
			// its dock badge subscribe to `os.alltfo_form.changed`; the shell
			// cannot see a mutation made through this plugin's own REST, so
			// without the announcement they only learn about the delete when
			// the Heartbeat catch-all drips it in, up to a minute later.
			const shell = ( window as unknown as {
				wp?: {
					os?: {
						announceContentChange?: (
							type: string,
							action: string,
							ids: number | number[],
							source?: string
						) => void;
					};
				};
			} ).wp?.os;

			shell?.announceContentChange?.( 'alltfo_form', 'trashed', formId, 'allterrain-forms' );

			notify( 'Form deleted', `${ title } moved to the desktop’s Trash.` );

			await this.releaseCurrentForm();
		} catch ( error ) {
			notify( 'Could not delete the form', error instanceof Error ? error.message : '', 'error' );
		}
	}

	/**
	 * Lets go of the open form after it left the working set — archived or
	 * deleted — and lands the builder somewhere sensible: the next form if
	 * there is one, the empty state if there is not.
	 */
	private async releaseCurrentForm(): Promise< void > {
		this.forms = this.forms.filter( ( form ) => form.id !== this.form!.id );
		this.form = null;
		this.schema = null;
		this.selected = null;
		this.dirty = false;
		this.history = [];
		this.historyAt = -1;

		if ( this.forms.length ) {
			await this.open( this.forms[ 0 ].id );

			return;
		}

		this.renderBar();
		this.renderCanvas();
		this.renderInspector();
	}

	/** Tag inputs can remain focused across autosaves; always write to the live section. */
	private writeTagValue( kind: 'notification' | 'confirmation', id: string, key: string, value: string ): void {
		const section = kind === 'notification'
			? this.schema?.notifications.find( ( item ) => item.id === id )
			: this.schema?.confirmations.find( ( item ) => item.id === id );
		if ( ! section ) {
			return;
		}
		if ( key === 'successTitle' && 'success' in section ) {
			section.success.title = value;
		} else {
			Object.assign( section, { [ key ]: value } );
		}
		this.markDirty();
	}

	/** A one-line input that understands merge tags. */
	private taggableInput(
		value: string,
		onChange: ( value: string ) => void,
		placeholder = ''
	): HTMLElement {
		return taggable( textInput( value, onChange, placeholder ), { formId: this.form!.id } );
	}

	/** A multi-line input that understands merge tags. */
	private taggableArea( value: string, onChange: ( value: string ) => void, rows = 6 ): HTMLElement {
		return taggable( textArea( value, onChange, rows ), { formId: this.form!.id } );
	}

	/**
	 * Who the notification goes to, asked in plain language.
	 *
	 * Almost every notification is addressed one of three ways, and only one of
	 * them has anything to do with merge tags:
	 *
	 * - to whoever runs the site — `{admin_email}`, and the person should never
	 *   have to learn that;
	 * - to a fixed address they type;
	 * - back to the visitor, at whatever address they gave — which means naming
	 *   one of the form's own email questions, the case where `{field:f2}` used
	 *   to be the entire interface.
	 *
	 * So the choice is offered as a choice, the email questions are listed by
	 * their labels, and the free-text box appears only for the fourth case —
	 * several addresses, or a tag we have not thought of. The stored value is
	 * still a plain string of tags, so nothing about the format changed and a form
	 * built before this existed opens in whichever mode its value already
	 * matches.
	 */
	private recipientControl( notification: Notification ): HTMLElement {
		const emailFields = this.schema!.fields.filter( ( field ) => 'email' === field.type );

		const modeOf = ( value: string ): string => {
			if ( '{admin_email}' === value.trim() ) {
				return 'admin';
			}

			const named = value.trim().match( /^\{field:([a-z0-9_-]+)\}$/i );

			if ( named && emailFields.some( ( field ) => field.id === named[ 1 ] ) ) {
				return `field:${ named[ 1 ] }`;
			}

			// Anything else with a tag in it is beyond the simple choices; a plain
			// address is not.
			return /\{/.test( value ) ? 'custom' : 'address';
		};

		const options = [
			{ value: 'admin', label: 'Whoever runs this site' },
			...emailFields.map( ( field ) => ( {
				value: `field:${ field.id }`,
				label: `The person who filled it in — ${ field.label || 'their email answer' }`,
			} ) ),
			{ value: 'address', label: 'A specific email address' },
			{ value: 'custom', label: 'Something else (advanced)' },
		];

		const mode = modeOf( notification.to );
		const detail = el( 'div', { class: 'atfb-recipient__detail' } );

		const paintDetail = ( current: string ) => {
			detail.replaceChildren();

			if ( 'address' === current ) {
				detail.append(
					textInput(
						/\{/.test( notification.to ) ? '' : notification.to,
						( value ) => {
							this.writeTagValue( 'notification', notification.id, 'to', value );
						},
						'name@example.com'
					)
				);

				return;
			}

			if ( 'custom' === current ) {
				detail.append(
					this.taggableInput(
						notification.to,
						( value ) => {
							this.writeTagValue( 'notification', notification.id, 'to', value );
						},
						'{admin_email}, sales@example.com'
					),
					el( 'p', {
						class: 'atfb-row__hint',
						text: 'Separate several addresses with commas.',
					} )
				);
			}
		};

		paintDetail( mode );

		return row(
			'Send it to',
			el( 'div', {
				class: 'atfb-recipient',
				children: [
					select( mode, options, ( value ) => {
						if ( 'admin' === value ) {
							notification.to = '{admin_email}';
						} else if ( value.startsWith( 'field:' ) ) {
							notification.to = `{${ value }}`;
						} else if ( 'address' === value ) {
							// Cleared rather than carried over: the previous value was a
							// tag, and leaving it in a box labelled "email address" invites
							// somebody to send to a literal `{admin_email}`.
							notification.to = /\{/.test( notification.to ) ? '' : notification.to;
						}

						this.markDirty();
						paintDetail( value );
					} ),
					detail,
				],
			} ),
			emailFields.length
				? undefined
				: 'Add an Email question on the Build tab to reply straight back to the visitor.'
		);
	}

	/** The notification editor. */
	private renderNotificationsPane(): HTMLElement {
		const notifications = this.schema!.notifications;

		const list = el( 'div', { class: 'atfb-list' } );

		if ( ! notifications.length ) {
			list.append(
				el( 'p', {
					class: 'atfb-hint',
					text: 'With none set up, one email goes to the site administrator with every answer in it.',
				} )
			);
		}

		notifications.forEach( ( notification, index ) => {
			list.append(
				this.section(
					`notification:${ notification.id }`,
					notification.name || `Notification ${ index + 1 }`,
					[
						row(
							'Name',
							textInput( notification.name, ( value ) => {
								notification.name = value;
								this.markDirty();
							} )
						),
						this.recipientControl( notification ),
						row(
							'Reply to',
							this.taggableInput(
								notification.replyTo,
								( value ) => {
									this.writeTagValue( 'notification', notification.id, 'replyTo', value );
								},
								'Leave empty to reply to you'
							),
							'Set this to the visitor’s email address and hitting Reply answers them directly.'
						),
						row(
							'Subject',
							this.taggableInput( notification.subject, ( value ) => {
								this.writeTagValue( 'notification', notification.id, 'subject', value );
							} )
						),
						row(
							'Message',
							this.taggableArea(
								notification.message,
								( value ) => {
									this.writeTagValue( 'notification', notification.id, 'message', value );
								},
								8
							)
						),
						checkbox( 'Attach uploaded files', notification.attachFiles, ( value ) => {
							notification.attachFiles = value;
							this.markDirty();
						} ),
						this.conditionsSection( notification.id, 'notification', notification.logic ),
						button(
							'Delete this notification',
							() => {
								notifications.splice( index, 1 );
								this.markDirty();
								this.renderCanvas();
							},
							'danger'
						),
					]
				)
			);
		} );

		return el( 'div', {
			class: 'atfb-pane',
			children: [
				el( 'h2', { text: 'Notifications' } ),
				list,
				button(
					'Add a notification',
					() => {
						notifications.push( {
							id: this.nextEntryId( 'n', notifications ),
							enabled: true,
							name: 'Notification',
							to: '{admin_email}',
							cc: '',
							bcc: '',
							replyTo: '',
							fromName: '',
							fromEmail: '',
							subject: 'New submission',
							message: '{all_fields}',
							attachFiles: false,
							logic: { enabled: false, action: 'show', match: 'all', rules: [] },
						} );

						this.markDirty();
						this.renderCanvas();
					},
					'primary',
					'plus-alt2'
				),
			],
		} );
	}

	/**
	 * The part of a confirmation that depends on what it does.
	 *
	 * "Send them to a page" used to render the same free-text URL box as "Send
	 * them to a URL", which made the two options identical in every visible way
	 * while writing to different fields — so picking the page option and typing an
	 * address stored a URL the confirmation would never read. A page is chosen
	 * from the site's pages, which is the only reading of that option that means
	 * anything.
	 */
	private confirmationDetail( confirmation: Confirmation ): HTMLElement {
		if ( 'message' === confirmation.type ) {
			return el( 'div', {
				children: [
					row(
						'Message',
						this.taggableArea(
							confirmation.message,
							( value ) => {
								this.writeTagValue( 'confirmation', confirmation.id, 'message', value );
							},
							5
						),
						'Insert an answer to greet them by name, or show back what they sent.'
					),
					this.successDesigner( confirmation ),
				],
			} );
		}

		// Both of the "send them somewhere" kinds can carry query parameters, so
		// the box is shared. It was in the schema and honoured by the server from
		// the start with nothing in the builder to set it — a feature that exists
		// and cannot be reached is a feature nobody has.
		const query = row(
			'Extra query parameters',
			this.taggableInput(
				confirmation.query,
				( value ) => {
					this.writeTagValue( 'confirmation', confirmation.id, 'query', value );
				},
				'ref={entry:id}&name={field:f1}'
			),
			'Added to the address, so the page they land on can read them. Leave empty for none.'
		);

		if ( 'redirect' === confirmation.type ) {
			return el( 'div', {
				children: [
					row(
						'Web address',
						this.taggableInput(
							confirmation.url,
							( value ) => {
								this.writeTagValue( 'confirmation', confirmation.id, 'url', value );
							},
							'https://example.com/thank-you'
						),
						'A full address, starting with https://.'
					),
					query,
				],
			} );
		}

		// The whole control is rebuilt when the list arrives rather than having its
		// options swapped in place. `select()` may return a native `<select>` or an
		// `<os-select>` depending on what the page has, and those spell their
		// options and their value differently — reaching into one of them from here
		// would mean this function knowing which it got, which is exactly what
		// `select()` exists to hide.
		const holder = el( 'div', { class: 'atfb-pagepicker' } );

		const paint = ( options: Array< { value: string; label: string } > ) => {
			holder.replaceChildren(
				select( String( confirmation.pageId || 0 ), options, ( value ) => {
					confirmation.pageId = Number( value ) || 0;
					this.markDirty();
				} )
			);
		};

		paint( [ { value: '0', label: 'Loading pages…' } ] );

		// Loaded rather than shipped in the config blob: a site with a thousand
		// pages should not pay for the list on every admin page load, and this is
		// the only screen that wants it.
		void api
			.pages()
			.then( ( pages ) => {
				paint( [
					{ value: '0', label: 'Choose a page…' },
					...pages.map( ( page ) => ( { value: String( page.id ), label: page.title } ) ),
				] );
			} )
			.catch( () => {
				paint( [ { value: '0', label: 'Could not load the pages' } ] );
			} );

		return row(
			'Page',
			holder,
			'They are sent to this page after submitting. Its own content is shown, not the form’s message.'
		);
	}

	/**
	 * The success screen designer: what the thank-you moment looks like.
	 *
	 * A gallery of styles rather than a dropdown, because the styles are
	 * *looks* and a look chosen from a list of words is a look chosen blind.
	 * Picking one plays the real screen immediately — the renderer previewing
	 * here is the same code the visitor's browser runs, so what the author
	 * sees is what ships.
	 */
	private successDesigner( confirmation: Confirmation ): HTMLElement {
		// Older drafts predate the screen; they behave as the default.
		confirmation.success = normalizeSuccessScreen( confirmation.success );

		const success = confirmation.success;
		const holder = el( 'div', { class: 'atfb-success' } );

		const styles: Array< { key: typeof success.style; label: string; glyph: string; blurb: string } > = [
			{ key: 'plain', label: 'Plain', glyph: '¶', blurb: 'Just the message.' },
			{ key: 'simple', label: 'Simple', glyph: '✓', blurb: 'Check mark and a gentle fade.' },
			{ key: 'minimal', label: 'Minimalistic', glyph: '—', blurb: 'Quiet type, generous space.' },
			{ key: 'card', label: 'Card', glyph: '🎫', blurb: 'An elevated card that pops in.' },
			{ key: 'check', label: 'Check mark', glyph: '✔', blurb: 'A big check draws itself.' },
			{ key: 'confetti', label: 'Confetti', glyph: '🎉', blurb: 'Paper rains over the page.' },
			{ key: 'fireworks', label: 'Fireworks', glyph: '🎆', blurb: 'The full night-sky show.' },
			{ key: 'sparkles', label: 'Sparkles', glyph: '✨', blurb: 'Your emoji floats up around it.' },
			{ key: 'typewriter', label: 'Typewriter', glyph: '⌨', blurb: 'Types itself out, letter by letter.' },
		];

		const paint = () => {
			const gallery = el( 'div', {
				class: 'atfb-success__styles',
				attrs: { role: 'radiogroup', 'aria-label': 'Success screen style' },
				children: styles.map( ( style ) =>
					el( 'button', {
						class: `atfb-success__style${ success.style === style.key ? ' is-selected' : '' }`,
						type: 'button',
						attrs: {
							role: 'radio',
							'aria-checked': success.style === style.key ? 'true' : 'false',
							title: style.blurb,
						},
						children: [
							el( 'span', { class: 'atfb-success__style-glyph', text: style.glyph } ),
							el( 'span', { class: 'atfb-success__style-label', text: style.label } ),
						],
						on: {
							click: () => {
								success.style = style.key;
								this.markDirty();
								paint();

								// Seeing beats reading: picking a look plays it.
								if ( 'plain' !== style.key ) {
									this.previewSuccessScreen( confirmation );
								}
							},
						},
					} )
				),
			} );

			const controls: HTMLElement[] = [];

			if ( 'plain' !== success.style ) {
				controls.push(
					row(
						'Heading',
						this.taggableInput(
							success.title,
							( value ) => {
								this.writeTagValue( 'confirmation', confirmation.id, 'successTitle', value );
							},
							'Thank you, {field:name}!'
						),
						'Shown above the message. Leave empty for none.'
					)
				);

				if ( [ 'simple', 'card', 'confetti', 'fireworks', 'sparkles' ].includes( success.style ) ) {
					controls.push(
						row(
							'Emoji',
							textInput( success.icon, ( value ) => {
								success.icon = value;
								this.markDirty();
							}, SUCCESS_STYLE_ICONS[ success.style ] || '🎉' ),
							'sparkles' === success.style
								? 'Also the particle that floats up — try 🎈 or ❤️.'
								: 'The badge above the heading.'
						)
					);
				}

				controls.push( this.successAccentRow( success ) );

				if ( [ 'confetti', 'fireworks', 'sparkles' ].includes( success.style ) ) {
					controls.push(
						row(
							'Intensity',
							select(
								success.intensity,
								[
									{ value: 'low', label: 'Calm' },
									{ value: 'medium', label: 'Festive' },
									{ value: 'high', label: 'Over the top' },
								],
								( value ) => {
									success.intensity = value as typeof success.intensity;
									this.markDirty();
								}
							)
						)
					);
				}

				controls.push(
					checkbox( 'Offer to fill it in again', success.showButton, ( value ) => {
						success.showButton = value;
						this.markDirty();
						paint();
					} )
				);

				if ( success.showButton ) {
					controls.push(
						row(
							'Button label',
							textInput( success.buttonLabel, ( value ) => {
								success.buttonLabel = value;
								this.markDirty();
							}, 'Fill it in again' )
						)
					);
				}
			}

			holder.replaceChildren(
				el( 'div', {
					class: 'atfb-success__head',
					children: [
						el( 'h4', { text: 'Success screen' } ),
						button( 'Preview', () => this.previewSuccessScreen( confirmation ), 'ghost', 'controls-play' ),
					],
				} ),
				gallery,
				...controls
			);
		};

		paint();

		return holder;
	}

	/** The accent picker: a colour, or the theme's own accent by default. */
	private successAccentRow( success: Confirmation[ 'success' ] ): HTMLElement {
		const input = el( 'input', {
			class: 'atfb-success__accent',
			attrs: { type: 'color', 'aria-label': 'Accent colour' },
		} ) as HTMLInputElement;

		input.value = success.accent || '#3858e9';

		const reset = button( 'Use the theme accent', () => {
			success.accent = '';
			input.value = '#3858e9';
			reset.style.display = 'none';
			this.markDirty();
		}, 'ghost' );

		reset.style.display = success.accent ? '' : 'none';

		input.addEventListener( 'input', () => {
			success.accent = input.value;
			reset.style.display = '';
			this.markDirty();
		} );

		return row(
			'Accent',
			el( 'div', { class: 'atfb-success__accent-row', children: [ input, reset ] } ),
			'Recolours the screen; the theme decides when left alone.'
		);
	}

	/**
	 * Plays the success screen over the builder, exactly as it will ship.
	 *
	 * The stage wears the canvas's own preview classes so the form's real theme
	 * tokens reach it, and the screen inside is built by the front-end renderer
	 * itself. Escape, the backdrop or the close button put the builder back.
	 */
	private previewSuccessScreen( confirmation: Confirmation ): void {
		const message = confirmation.message || 'Thank you. Your submission has been received.';

		let cleanup: () => void = () => {};

		const overlay = el( 'div', {
			class: 'atfb-success-preview',
			attrs: { role: 'dialog', 'aria-label': 'Success screen preview', 'aria-modal': 'true' },
		} );

		const dismiss = () => {
			cleanup();
			overlay.remove();
			document.removeEventListener( 'keydown', onKey );
		};

		const onKey = ( event: KeyboardEvent ) => {
			if ( 'Escape' === event.key ) {
				event.stopPropagation();
				dismiss();
			}
		};

		const screen = renderSuccessScreen( message, confirmation.success, dismiss );
		const stage = el( 'div', { class: 'atfb-success-preview__stage atfb-preview atf-form', children: [ screen ] } );

		const play = () => {
			cleanup();
			cleanup = playSuccessEffects( screen, confirmation.success );
		};

		overlay.append(
			stage,
			el( 'div', {
				class: 'atfb-success-preview__bar',
				children: [
					button( 'Replay', play, 'secondary', 'controls-repeat' ),
					button( 'Close', dismiss, 'primary' ),
				],
			} )
		);

		overlay.addEventListener( 'click', ( event ) => {
			if ( event.target === overlay ) {
				dismiss();
			}
		} );

		document.addEventListener( 'keydown', onKey );
		this.root.append( overlay );

		// After layout, so the burst can aim at where the screen actually is.
		window.requestAnimationFrame( play );
	}

	/** The confirmation editor. */
	private renderConfirmationsPane(): HTMLElement {
		const confirmations = this.schema!.confirmations;

		const list = el( 'div', { class: 'atfb-list' } );

		if ( ! confirmations.length ) {
			list.append(
				el( 'p', { class: 'atfb-hint', text: 'With none set up, the form says thank you and stops.' } )
			);
		}

		confirmations.forEach( ( confirmation, index ) => {
			// Swapped in place when the kind changes, rather than re-rendering the
			// pane.
			//
			// The bug this fixes: changing "What happens" called `renderCanvas()`,
			// which rebuilds every `<details>` in the list — and a rebuilt
			// `<details>` is closed. The whole section collapsed the instant the
			// choice was made, so the control it was supposed to reveal was never
			// seen. From the outside that is indistinguishable from the two other
			// options doing nothing at all, which is exactly how it was reported.
			const detail = el( 'div', { class: 'atfb-confirm__detail' } );

			const paintDetail = () => {
				detail.replaceChildren( this.confirmationDetail( confirmation ) );
			};

			paintDetail();

			list.append(
				this.section(
					`confirmation:${ confirmation.id }`,
					confirmation.name || `Confirmation ${ index + 1 }`,
					[
						row(
							'Name',
							textInput( confirmation.name, ( value ) => {
								confirmation.name = value;
								this.markDirty();
							} )
						),
						row(
							'What happens',
							select(
								confirmation.type,
								[
									{ value: 'message', label: 'Show a message' },
									{ value: 'redirect', label: 'Send them to a URL' },
									{ value: 'page', label: 'Send them to a page' },
								],
								( value ) => {
									confirmation.type = value as typeof confirmation.type;
									this.markDirty();
									paintDetail();
								}
							)
						),
						detail,
						this.conditionsSection( confirmation.id, 'confirmation', confirmation.logic ),
						button(
							'Delete this confirmation',
							() => {
								confirmations.splice( index, 1 );
								this.markDirty();
								this.renderCanvas();
							},
							'danger'
						),
					]
				)
			);
		} );

		return el( 'div', {
			class: 'atfb-pane',
			children: [
				el( 'h2', { text: 'Confirmations' } ),
				el( 'p', {
					class: 'atfb-hint',
					text: 'The first one whose conditions match is the one they see.',
				} ),
				list,
				button(
					'Add a confirmation',
					() => {
						confirmations.push( {
							id: this.nextEntryId( 'c', confirmations ),
							enabled: true,
							name: 'Confirmation',
							type: 'message',
							message: 'Thank you. Your submission has been received.',
							url: '',
							pageId: 0,
							query: '',
							success: defaultSuccessScreen(),
							logic: { enabled: false, action: 'show', match: 'all', rules: [] },
						} );

						this.markDirty();
						this.renderCanvas();
					},
					'primary',
					'plus-alt2'
				),
			],
		} );
	}

	/**
	 * Opens the form's real front-end preview.
	 *
	 * The same code path the title bar's eye takes, so the toolbar button and
	 * the eye cannot drift apart. Inside OpenStation it opens a window paired
	 * with this one; on a plain admin page it opens a tab.
	 */
	private async preview(): Promise< void > {
		await openPreview( {
			current: () =>
				this.form ? { id: this.form.id, title: this.form.title, previewUrl: this.form.previewUrl } : null,
			isDirty: () => this.dirty,
			save: () => this.save( true ),
		} );
	}
}

/** Mounts the builder into whatever root is on the page. */
let mounted: Builder | null = null;
let mountedRoot: HTMLElement | null = null;

// WP Explorer's actions open this window and then say which form they meant.
// The window may still be mounting when the event lands, so the ask waits the
// same beat the analytics demo-panel deep link does.
document.addEventListener( 'alltfo-open-form', ( event ) => {
	const formId = Number( ( event as CustomEvent ).detail?.formId ?? 0 );

	if ( ! formId ) {
		return;
	}

	void mounted?.openFormById( formId );
} );

export function mountBuilder(): void {
	// One *live* builder per document.
	//
	// Two roots can legitimately exist for a moment — the desktop shell renders
	// the admin page's markup and the native window's into the same document —
	// and mounting both gives two instances autosaving the same form, able to
	// overwrite each other's saves.
	//
	// But "one, ever" is too strong, and was its own bug: closing the window
	// takes its DOM with it, and a latch that never releases meant reopening the
	// builder produced a window stuck on "Loading your forms…" forever. The
	// question is not whether one was *ever* mounted, but whether the one that
	// was is still on screen.
	if ( mountedRoot?.isConnected ) {
		return;
	}

	// The previous instance's window is gone; release its listeners rather than
	// leaving a `beforeunload` handler and an autosave timer behind for every
	// open-and-close.
	if ( mounted ) {
		mounted.destroy();
		mounted = null;
		mountedRoot = null;
	}

	const root = document.querySelector< HTMLElement >( '[data-atfb-root]:not([data-atfb-mounted])' );

	if ( ! root ) {
		return;
	}

	// Flagged before the await, not after. `mountBuilder()` is called from two
	// places — DOM ready and the shell's `os-window-content-loaded` — and an
	// await between the guard and the flag is a window big enough for both to
	// pass it and mount two builders on one page.
	root.dataset.atfbMounted = '1';
	mountedRoot = root;
	pinWindowBodyScroll( root );

	void whenComponents().then( () => {
		// The window may have been closed while the kit was loading.
		if ( ! root.isConnected ) {
			return;
		}

		mounted = new Builder( root );

		void mounted.start();
	} );
}

function boot(): void {
	mountBuilder();
	handOffToWindow();
}

watchHandoffButton();

if ( document.readyState === 'loading' ) {
	document.addEventListener( 'DOMContentLoaded', boot );
} else {
	boot();
}

// The shell mounts a native window's markup after this bundle has already run,
// so the window's own render callback fires this to mount into it.
document.addEventListener( 'os-window-content-loaded', mountBuilder );
