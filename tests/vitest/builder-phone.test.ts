/**
 * The builder on a phone-width window.
 *
 * Two contracts, neither of which a render can check. The first is
 * behavioural: the shell refuses every drag under its mobile stamp by
 * returning `null` from `dragManager.start()`, and a palette chip that only
 * added a field through the manager's click-only callback added nothing on a
 * phone. The second is the stylesheet's cascade: the folded layouts zero a
 * rail's padding at the same specificity as the resting rule, so they only
 * win by coming later in the file — a fact a refactor can silently undo,
 * and the symptom is a 28px sliver of palette painted over the canvas.
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Builder } from '../../src/builder';
import type { FieldType, FormSchema } from '../../src/types';

const TEXT: FieldType = {
	type: 'text',
	label: 'Single line',
	description: '',
	group: 'text',
	icon: 'editor-textcolor',
	input: true,
	value: 'string',
	choices: false,
	supports: [ 'label' ],
	settings: {},
};

/** A builder with one palette chip and an empty form, under a stubbed shell. */
function mount( dragManager: unknown ): { root: HTMLElement; schema: FormSchema } {
	const root = document.createElement( 'div' );

	root.innerHTML = '<div data-atfb-bar></div><div data-atfb-palette></div><div data-atfb-canvas></div><div data-atfb-inspector></div>';
	document.body.append( root );

	// The canvas re-registers itself as a drop target on every render; the
	// stub only has to accept that and hand back a teardown.
	( window as unknown as { wp: unknown } ).wp = {
		os: { dragManager: { registerDropTarget: () => () => undefined, ...( dragManager as object ) } },
	};

	const schema = { fields: [], confirmations: [], notifications: [], settings: {} } as unknown as FormSchema;
	const builder = new Builder( root );

	Reflect.set( builder, 'config', { fieldTypes: [ TEXT ], groups: { text: 'Text' } } );
	Reflect.set( builder, 'schema', schema );
	Reflect.set( builder, 'form', { id: 1, title: 'QA', schema } );
	Reflect.get( builder, 'renderPalette' ).call( builder );

	return { root, schema };
}

/** A tap, as a phone delivers it: a press the manager may decline, then a click. */
function tap( chip: HTMLElement ): void {
	chip.dispatchEvent( new MouseEvent( 'pointerdown', { bubbles: true, button: 0 } ) );
	chip.dispatchEvent( new MouseEvent( 'click', { bubbles: true, button: 0 } ) );
}

describe( 'a palette chip on a phone', () => {
	afterEach( () => {
		document.body.replaceChildren();
		delete ( window as unknown as { wp?: unknown } ).wp;
	} );

	it( 'adds the field when the shell declines the press', () => {
		const { root, schema } = mount( { start: () => null, recentlyEndedDrag: () => false } );

		tap( root.querySelector< HTMLElement >( '.atfb-chip' )! );

		expect( schema.fields.map( ( field ) => field.type ) ).toEqual( [ 'text' ] );
	} );

	it( 'does not add it twice when the shell took the press and fired click-only itself', () => {
		let onClickOnly: ( () => void ) | undefined;
		const { root, schema } = mount( {
			start: ( opts: { onClickOnly?: () => void } ) => {
				onClickOnly = opts.onClickOnly;

				return { cancel: () => undefined };
			},
			recentlyEndedDrag: () => false,
		} );

		const chip = root.querySelector< HTMLElement >( '.atfb-chip' )!;

		chip.dispatchEvent( new MouseEvent( 'pointerdown', { bubbles: true, button: 0 } ) );
		onClickOnly?.();
		chip.dispatchEvent( new MouseEvent( 'click', { bubbles: true, button: 0 } ) );

		expect( schema.fields ).toHaveLength( 1 );
	} );
} );

describe( 'the builder stylesheet’s folded layouts', () => {
	const css = readFileSync( 'assets/css/builder.css', 'utf8' );
	const at = ( needle: string ) => {
		const index = css.indexOf( needle );

		expect( index, needle ).toBeGreaterThan( -1 );

		return index;
	};

	it( 'declares the resting rail padding before the fold that zeroes it', () => {
		expect( at( '.atfb__palette,\n.atfb__inspector,\n.atfs__controls {' ) ).toBeLessThan(
			at( '@container ( max-width: 640px )' )
		);
	} );

	it( 'declares the phone-only controls hidden before the folds that show them', () => {
		expect( at( '.atfb .atfb-canvas__add,\n.atfb-palette__head {\n\tdisplay: none;' ) ).toBeLessThan(
			at( '@container ( max-width: 900px )' )
		);
	} );

	it( 'lets the canvas column shrink below a card’s min-content', () => {
		const list = css.slice( at( '.atfb-canvas__list {' ) );

		expect( list.slice( 0, list.indexOf( '}' ) ) ).toContain( 'grid-template-columns: minmax( 0, 1fr )' );
	} );

	it( 'names the card preview as the container form.css asks about', () => {
		const preview = css.slice( at( '.atfb-preview {\n\tcontainer-type' ) );

		expect( preview.slice( 0, preview.indexOf( '}' ) ) ).toContain( 'container-name: atf-form' );
	} );
} );
