import { test, expect, type Page } from '@playwright/test';

test.use( { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } );

/** Uses the builder's authenticated REST session and checks every response. */
async function api( page: Page, path: string, method = 'GET', body?: unknown ) {
	return page.evaluate( async ( { path, method, body } ) => {
		const config = ( window as any ).allTerrainForms;
		const response = await fetch( `${ config.restUrl }${ path }`, {
			method,
			headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': config.nonce },
			body: body === undefined ? undefined : JSON.stringify( body ),
		} );
		if ( ! response.ok ) throw new Error( await response.text() );
		return response.json();
	}, { path, method, body } );
}

test( 'phone fields can be added, edited and saved without overflowing the canvas', async ( { page } ) => {
	await page.goto( '/wp-login.php' );
	await page.getByLabel( 'Username or Email Address' ).fill( process.env.ATF_E2E_USER || 'admin' );
	await page.getByLabel( 'Password', { exact: true } ).fill( process.env.ATF_E2E_PASSWORD || 'password' );
	await page.getByRole( 'button', { name: 'Log In', exact: true } ).click();
	await page.waitForURL( '**/wp-admin/**' );
	await page.goto( '/wp-admin/admin.php?page=allterrain-forms' );
	await page.waitForFunction( () => Boolean( ( window as any ).allTerrainForms?.nonce ) );
	await expect( page.locator( 'html' ) ).toHaveAttribute( 'data-os-mode', 'mobile' );
	const title = `Phone builder E2E ${ Date.now() }`;
	const created = await api( page, '/forms', 'POST', {
		title,
		schema: {
			fields: [ { id: 'name', type: 'name', label: 'Your name' } ],
			settings: { theme: 'clean' },
		},
	} );
	try {
		await page.goto( '/wp-admin/admin.php?page=allterrain-forms' );
		await expect( page.getByLabel( 'Form title', { exact: true } ) ).toHaveValue( title );
		const builder = page.locator( '.atfb' );
		const cards = builder.locator( '[data-atfb-card]' );
		await expect( cards ).toHaveCount( 1 );
		await builder.getByRole( 'button', { name: 'Add a field', exact: true } ).tap();
		await builder.getByRole( 'button', { name: 'Single line', exact: true } ).tap();
		await expect( cards ).toHaveCount( 2 );
		await expect( builder ).toHaveClass( /atfb--has-selection/ );
		await expect( builder ).not.toHaveClass( /atfb--palette-open/ );
		await expect.poll( async () => {
			const body = await builder.locator( '.atfb__body' ).boundingBox();
			const inspector = await builder.locator( '.atfb__inspector' ).boundingBox();
			return Math.abs( body!.width - inspector!.width );
		} ).toBeLessThan( 2 );
		await builder.getByRole( 'button', { name: 'Done', exact: true } ).tap();
		await expect( builder ).not.toHaveClass( /atfb--has-selection/ );
		await expect.poll( () => builder.locator( '.atfb-canvas__list' ).evaluate( ( list ) => {
			const bounds = list.getBoundingClientRect();
			return Array.from( list.querySelectorAll( '[data-atfb-card]' ) ).every( ( card ) => {
				const rect = card.getBoundingClientRect();
				return rect.left >= bounds.left && rect.right <= bounds.right + 1;
			} );
		} ) ).toBe( true );
		await builder.getByRole( 'button', { name: 'Save', exact: true } ).tap();
		await expect.poll( async () => ( await api( page, `/forms/${ created.id }` ) ).schema.fields.length ).toBe( 2 );
		await page.goto( '/wp-admin/admin.php?page=allterrain-forms' );
		await expect( cards ).toHaveCount( 2 );
		await page.setViewportSize( { width: 1440, height: 1000 } );
		await expect( page.locator( 'html' ) ).toHaveAttribute( 'data-os-mode', 'desktop' );
		await expect( builder.getByRole( 'button', { name: 'Add a field', exact: true } ) ).toBeHidden();
		await expect( builder.getByRole( 'button', { name: 'Single line', exact: true } ) ).toBeVisible();
	} finally {
		await api( page, `/forms/${ created.id }`, 'DELETE' );
	}
} );
