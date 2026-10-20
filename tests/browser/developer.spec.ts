import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { startHttpEnvironment } from '../support/http-environment';
import { listings } from '../../src/infrastructure/catalog/fixtures';

let env: Awaited<ReturnType<typeof startHttpEnvironment>>;
const contexts: BrowserContext[] = [];
const listing = listings[0]!;
const secret = 'test-only-demo-configuration-'.repeat(3);

test.beforeAll(async () => {
  test.setTimeout(120_000);
  env = await startHttpEnvironment(['SUCCESS', 'SUCCESS'], { demoMode: true });
});
test.afterAll(async () => {
  await env?.stop();
});
test.beforeEach(async () => {
  await env.redis.command('FLUSHDB');
});
test.afterEach(async () => {
  // Trace/context disposal can be slow with the external Chromium test binary.
  // This changes teardown's budget, not the scenario's assertion timeouts.
  test.setTimeout(90_000);
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

async function pageOn(browser: Browser, mobile = false) {
  const context = await browser.newContext({
    viewport: mobile
      ? { width: 390, height: 844 }
      : { width: 1440, height: 1000 },
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });

  contexts.push(context);

  return context.newPage();
}

async function reserve(page: Page) {
  await page.goto(env.bases[0]! + `/events/${listing.eventId}`);
  await page
    .getByRole('article', { name: listing.allocation.section, exact: true })
    .getByRole('button', { name: 'Reserve tickets', exact: true })
    .click();
  await expect(page).toHaveURL(/\/checkout\//);
  await expect(
    page.getByRole('button', { name: /Complete simulated purchase/ }),
  ).toBeEnabled();

  return page.url().split('/').at(-1)!;
}

async function open(page: Page) {
  await page
    .getByRole('button', { name: 'Developer menu', exact: true })
    .click();
  const panel = page.getByRole('dialog', {
    name: 'Developer menu',
    exact: true,
  });

  await expect(panel).toBeVisible();

  return panel;
}

async function unlock(page: Page) {
  const panel = await open(page);

  await panel.getByLabel('Demo secret', { exact: true }).fill(secret);
  await panel.getByRole('button', { name: 'Unlock controls' }).click();
  await expect(
    panel.getByRole('button', { name: 'Apply duration' }),
  ).toBeEnabled();

  return panel;
}

async function close(page: Page) {
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('dialog', { name: 'Developer menu', exact: true }),
  ).not.toBeVisible();
}

async function read(page: Page, id: string) {
  return (
    await (
      await page.request.get(env.bases[0]! + `/api/checkouts/${id}`)
    ).json()
  ).data;
}

test('desktop popover persists price and duration across independent devices without refresh', async ({
  browser,
}) => {
  const a = await pageOn(browser),
    b = await pageOn(browser);
  const id = await reserve(a);

  await b.goto(env.bases[1]! + `/checkout/${id}`);
  const original = await read(a, id);
  const panel = await unlock(a);

  await panel.getByRole('button', { name: 'Increase price 10%' }).click();
  await expect(
    a.getByRole('button', { name: /Accept new total/ }),
  ).toBeVisible();
  await expect(
    b.getByRole('button', { name: /Accept new total/ }),
  ).toBeVisible();
  await close(a);
  await a.getByRole('button', { name: /Accept new total/ }).click();
  await expect(
    b.getByRole('button', { name: /Complete simulated purchase/ }),
  ).toBeEnabled();
  await open(a);
  await panel.getByRole('button', { name: 'Increase price 10%' }).click();
  await expect(
    b.getByRole('button', { name: /Accept new total/ }),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Decrease price 10%' }),
  ).toBeEnabled();
  await panel.getByRole('button', { name: 'Decrease price 10%' }).click();
  await expect(
    b.getByText('Your tickets just got cheaper!', { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Apply duration' }),
  ).toBeEnabled();
  const slider = panel.getByRole('slider');

  await slider.focus();
  await slider.press('End');
  await panel.getByRole('button', { name: 'Apply duration' }).click();
  await expect(b.getByTestId('countdown')).toHaveText(/^(29|30):/);
  const updated = await read(a, id);

  expect(Date.parse(updated.session.reservationExpiresAt)).toBeGreaterThan(
    Date.parse(original.session.reservationExpiresAt),
  );
  expect(updated.session.reservationId).toBe(original.session.reservationId);
  await a.screenshot({
    path: 'test-results/developer-desktop.png',
    fullPage: true,
  });
});

test('mobile right sheet traps focus, closes by keyboard, and expiration restores event inventory', async ({
  browser,
}) => {
  const a = await pageOn(browser, true),
    b = await pageOn(browser);
  const id = await reserve(a);

  await b.goto(env.bases[1]! + `/checkout/${id}`);
  const panel = await unlock(a);
  const bounds = await panel.boundingBox();

  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
  expect(bounds!.height).toBeGreaterThan(700);
  await a.screenshot({
    path: 'test-results/developer-mobile.png',
    fullPage: true,
  });
  await panel
    .getByRole('button', { name: 'Reset demo data…', exact: true })
    .scrollIntoViewIfNeeded();
  await panel.getByRole('button', { name: 'Close developer menu' }).click();
  await expect(
    a.getByRole('button', { name: 'Developer menu', exact: true }),
  ).toBeFocused();
  await open(a);
  await close(a);
  await expect(
    a.getByRole('button', { name: 'Developer menu', exact: true }),
  ).toBeFocused();
  await open(a);
  await panel.getByRole('button', { name: 'Expire now' }).click();
  await expect(a).toHaveURL(new RegExp(`/events/${listing.eventId}$`));
  await expect(b).toHaveURL(new RegExp(`/events/${listing.eventId}$`));
  await expect(
    a.getByText('8 available · 0 reserved · 0 sold', { exact: true }),
  ).toBeVisible();
});

test('shared one-shot payment override produces transient failure, then configured success', async ({
  browser,
}) => {
  const a = await pageOn(browser),
    b = await pageOn(browser);
  const id = await reserve(a);

  await b.goto(env.bases[1]! + `/checkout/${id}`);
  const panel = await unlock(a);

  await panel.getByRole('button', { name: 'Transient timeout' }).click();
  await expect(
    panel.getByText('transient failure', { exact: true }),
  ).toBeVisible();
  await expect(b.locator('.developer-menu')).toHaveAttribute(
    'data-session-version',
    String((await read(a, id)).session.version),
  );
  await b.getByRole('button', { name: /Complete simulated purchase/ }).click();
  await expect(
    b.getByRole('button', { name: /Try payment again/ }),
  ).toBeEnabled();
  await expect(panel.getByText(/Attempts used: 1 \/ 3/)).toBeVisible();
  await panel.getByRole('button', { name: 'Success', exact: true }).click();
  await expect(panel.getByText('success', { exact: true })).toBeVisible();
  await expect(b.locator('.developer-menu')).toHaveAttribute(
    'data-session-version',
    String((await read(a, id)).session.version),
  );
  await b.getByRole('button', { name: /Try payment again/ }).click();
  await expect(b).toHaveURL(/\/orders\/.*\/confirmation$/);
  await expect(a).toHaveURL(env.bases[0]! + '/');
});

test('definitive decline is server-backed and clearing selection restores the default scenario', async ({
  browser,
}) => {
  const a = await pageOn(browser);
  const id = await reserve(a);
  const panel = await unlock(a);

  await panel.getByRole('button', { name: 'Definitive decline' }).click();
  await expect(panel.getByText('declined', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Clear simulation' }).click();
  await expect(
    panel.getByText('Default scenario', { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Definitive decline' }),
  ).toBeEnabled();
  await panel.getByRole('button', { name: 'Definitive decline' }).click();
  await expect(panel.getByText('declined', { exact: true })).toBeVisible();
  await close(a);
  await a.getByRole('button', { name: /Complete simulated purchase/ }).click();
  await expect(a.getByText('Payment declined', { exact: true })).toBeVisible();
  expect((await read(a, id)).session.failureCode).toBe('DECLINED');
});

test('reset requires typed confirmation, invalidates old sessions and refreshes another device', async ({
  browser,
}) => {
  const a = await pageOn(browser),
    b = await pageOn(browser);
  const id = await reserve(a);

  await b.goto(env.bases[1]! + `/checkout/${id}`);
  const panel = await unlock(a);

  await panel
    .getByRole('button', { name: 'Reset demo data…', exact: true })
    .click();
  await expect(
    panel.getByRole('button', { name: 'Confirm reset' }),
  ).toBeDisabled();
  await panel
    .getByLabel('Type RESET DEMO DATA to confirm')
    .fill('RESET DEMO DATA');
  await panel.getByRole('button', { name: 'Confirm reset' }).click();
  await expect(a).toHaveURL(env.bases[0]! + '/');
  await expect(b).toHaveURL(env.bases[1]! + '/');
  expect(
    (await b.request.get(env.bases[1]! + `/api/checkouts/${id}`)).status(),
  ).toBe(404);
  await b.goto(env.bases[1]! + `/events/${listing.eventId}`);
  await expect(
    b.getByText('8 available · 0 reserved · 0 sold', { exact: true }),
  ).toBeVisible();
});
