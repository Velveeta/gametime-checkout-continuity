import {
  test,
  expect,
  type Page,
  type BrowserContext,
  type Browser,
} from '@playwright/test';
import { startHttpEnvironment } from '../support/http-environment';
import { composeCheckout } from '../../src/infrastructure/checkout/compose';
import { DEFAULT_CHECKOUT_POLICY } from '../../src/domain/checkout';
import { listings } from '../../src/infrastructure/catalog/fixtures';
import { version } from '../../src/domain/values';
import { selectionKey } from '../../src/lib/ui/presentation';

let env: Awaited<ReturnType<typeof startHttpEnvironment>>;
const listing = listings[0]!;
const allocation =
  listing.allocation.kind === 'ASSIGNED'
    ? { ...listing.allocation, seats: [9, 10] as [number, number] }
    : listing.allocation;
const contexts: BrowserContext[] = [];
test.beforeAll(async () => {
  test.setTimeout(120_000);
  env = await startHttpEnvironment([
    'SUCCESS',
    'SUCCESS',
    'TRANSIENT_THEN_SUCCESS',
    'DECLINE',
    'ALWAYS_TRANSIENT',
    'UNKNOWN',
  ]);
});
test.afterAll(async () => {
  await env?.stop();
});
test.beforeEach(async () => {
  // This is the harness's own disposable Redis PROCESS, never a configured DB.
  await env.redis.command('FLUSHDB');
});
test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
});
async function pageOn(browser: Browser, server = 0, mobile = false) {
  const context = await browser.newContext({
    viewport: mobile
      ? { width: 390, height: 844 }
      : { width: 1440, height: 1000 },
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  contexts.push(context);
  return context.newPage().then((page) => ({ page, base: env.bases[server]! }));
}
async function reserve(page: Page, base: string) {
  await page.goto(base + `/events/${listing.eventId}`);
  const card = page.getByRole('article', {
    name: listing.allocation.section,
    exact: true,
  });
  const reservation = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/checkouts' &&
      response.request().method() === 'POST',
  );
  await card
    .getByRole('button', { name: 'Reserve tickets', exact: true })
    .click();
  const response = await reservation;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(page).toHaveURL(/\/checkout\//);
  await expect(
    page.getByRole('button', { name: /Complete simulated purchase/ }),
  ).toBeEnabled();
  return page.url().split('/').at(-1)!;
}
async function shortCheckout(holdMs = 1800, processingMs = 1000) {
  const setup = await composeCheckout({
    redis: env.redis,
    namespace: env.namespace,
    callerSecret: env.callerSecret,
    completionSecret: env.completionSecret,
    secureCookies: true,
    policy: { ...DEFAULT_CHECKOUT_POLICY, holdMs, processingMs },
    analytics: { record: async () => {} },
  });
  const result = await setup.checkout.create({
    listingId: listing.id,
    allocation,
    expectedListingVersion: version(1),
  });
  if (!result.ok) throw result.error;
  return result.value;
}
async function price(unit: number, fee: number) {
  await env.redis.command(
    'EVAL',
    `local d=cjson.decode(redis.call('GET',KEYS[1]));local l=d.listings[ARGV[1]];l.unitPrice=tonumber(ARGV[2]);l.feePerTicket=tonumber(ARGV[3]);l.version=l.version+1;redis.call('SET',KEYS[1],cjson.encode(d));return 1`,
    '1',
    `checkout:{${env.namespace}}:inventory:v2:${listing.id}`,
    listing.id,
    String(unit),
    String(fee),
  );
}
async function inventory() {
  return JSON.parse(
    await env.redis.command(
      'GET',
      `checkout:{${env.namespace}}:inventory:v2:${listing.id}`,
    ),
  );
}

test('event discovery, filtering, seat selection and desktop checkout layout', async ({
  browser,
}) => {
  const { page, base } = await pageOn(browser);
  await page.goto(base);
  await expect(
    page.getByRole('heading', { name: 'Be there. Feel everything.' }),
  ).toBeVisible();
  await expect(page.locator('.event-card')).toHaveCount(4);
  await page.getByRole('button', { name: 'Concerts', exact: true }).click();
  await expect(page.locator('.event-card')).toHaveCount(1);
  await expect(
    page.locator('.event-card').filter({ hasText: 'The Midnight' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'All events', exact: true }).click();
  await page.screenshot({
    path: 'test-results/home-desktop.png',
    fullPage: true,
  });
  await reserve(page, base);
  await expect(
    page.getByRole('heading', { name: 'Make it a great night.' }),
  ).toBeVisible();
  await expect(page.getByTestId('order-total')).toHaveText('$228');
  const summary = await page
    .getByRole('complementary', { name: 'Order summary' })
    .boundingBox();
  const actions = await page
    .getByRole('region', { name: 'Checkout actions' })
    .boundingBox();
  expect(summary!.x).toBeGreaterThan(actions!.x + actions!.width);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: 'test-results/checkout-desktop.png',
    fullPage: true,
  });
});
test('server renders event, selected seats, total and reservation before JavaScript', async ({
  browser,
}) => {
  const s = await shortCheckout(15_000);
  const context = await browser.newContext({ javaScriptEnabled: false });
  contexts.push(context);
  const page = await context.newPage();
  const response = await page.goto(env.bases[0] + `/checkout/${s.session.id}`);
  expect(response!.status()).toBe(200);
  await expect(
    page.getByRole('heading', { name: /Dallas Cowboys/ }),
  ).toBeVisible();
  await expect(
    page.getByText('Row 18 · Seats 9, 10', { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('order-total')).toHaveText('$228');
  await expect(page.getByTestId('countdown')).toBeVisible();
});
test('mobile uses the same session, stacks summary, offers a QR and copy link', async ({
  browser,
}) => {
  const a = await pageOn(browser);
  const id = await reserve(a.page, a.base);
  const b = await pageOn(browser, 1, true);
  await b.page.goto(b.base + `/checkout/${id}`);
  await expect(
    b.page.getByRole('button', { name: /Complete simulated/ }),
  ).toBeEnabled();
  await expect(b.page.getByTestId('order-total')).toHaveText('$228');
  await b.page
    .getByRole('button', { name: 'Continue on another device' })
    .click();
  await expect(
    b.page.getByAltText('Scan to open this same checkout on your phone'),
  ).toBeVisible();
  await expect(b.page.getByLabel('Checkout link')).toHaveValue(
    b.base + `/checkout/${id}`,
  );
  await b.page
    .context()
    .grantPermissions(['clipboard-read', 'clipboard-write']);
  await b.page.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(b.page.getByRole('status')).toHaveText('Checkout link copied.');
  expect(await b.page.evaluate(() => navigator.clipboard.readText())).toBe(
    b.base + `/checkout/${id}`,
  );
  const first = await a.page.request.get(a.base + `/api/checkouts/${id}`);
  const second = await b.page.request.get(b.base + `/api/checkouts/${id}`);
  expect((await first.json()).data.session.reservationExpiresAt).toBe(
    (await second.json()).data.session.reservationExpiresAt,
  );
  const payment = await b.page.locator('.payment-panel').boundingBox(),
    summary = await b.page.locator('.order-summary').boundingBox();
  expect(payment!.y).toBeGreaterThan(summary!.y + summary!.height);
  expect(
    await b.page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(Object.keys((await inventory()).reservations)).toHaveLength(1);
  await b.page.screenshot({
    path: 'test-results/checkout-mobile.png',
    fullPage: true,
  });
});
test('separate carts see stock removed and automatically restored on expiry', async ({
  browser,
}) => {
  const a = await pageOn(browser);
  await a.page.goto(a.base + `/events/${listing.eventId}`);
  const card = a.page.getByRole('article', {
    name: listing.allocation.section,
    exact: true,
  });
  await expect(
    card.getByText('8 available · 0 reserved · 0 sold'),
  ).toBeVisible();
  await card
    .getByLabel('Seats together')
    .selectOption({ label: 'Row 18 · Seats 13, 14' });
  const s = await shortCheckout(3500);
  await expect(
    card.getByText('6 available · 2 reserved · 0 sold'),
  ).toBeVisible();
  await expect(card.getByLabel('Seats together')).toHaveValue(
    selectionKey({
      kind: 'ASSIGNED',
      section: listing.allocation.section,
      row: '18',
      seats: [13, 14],
    }),
  );
  await env.redis.after(s.session.reservationExpiresAt);
  await expect(
    card.getByText('8 available · 0 reserved · 0 sold'),
  ).toBeVisible();
});
test('price acknowledgement synchronizes across contexts, decreases auto-apply', async ({
  browser,
}) => {
  const a = await pageOn(browser);
  const id = await reserve(a.page, a.base);
  const b = await pageOn(browser, 1);
  await b.page.goto(b.base + `/checkout/${id}`);
  await price(10000, 2000);
  await expect(
    a.page.getByRole('button', { name: 'Accept new total · $240' }),
  ).toBeVisible();
  await expect(
    b.page.getByRole('button', { name: /Complete simulated/ }),
  ).toBeDisabled();
  await a.page.getByRole('button', { name: 'Accept new total · $240' }).click();
  await expect(
    b.page.getByRole('button', { name: /Complete simulated/ }),
  ).toBeEnabled();
  await price(8000, 1500);
  await expect(
    b.page.getByText('Your tickets just got cheaper!'),
  ).toBeVisible();
  await expect(b.page.getByTestId('order-total')).toHaveText('$190');
});
test('countdown ignores device wall-clock skew and confirms mounted expiry without recovery', async ({
  browser,
}) => {
  const s = await shortCheckout(5500);
  const { page, base } = await pageOn(browser);
  await page.addInitScript(() => {
    const now = Date.now.bind(Date);
    Date.now = () => now() + 86_400_000;
  });
  let recoveryCalls = 0;
  page.on('request', (r) => {
    if (r.url().includes('/recover')) recoveryCalls++;
  });
  await page.goto(base + `/checkout/${s.session.id}`);
  await expect(page.getByTestId('countdown')).toHaveText(/^0:0[0-6]$/);
  await expect(page).toHaveURL(new RegExp(`/events/${listing.eventId}$`));
  expect(recoveryCalls).toBe(0);
  const original = JSON.parse(
    await env.redis.command(
      'GET',
      `checkout:{${env.namespace}}:session:v2:${s.session.id}`,
    ),
  );
  expect(original.session.successorSessionId).toBeUndefined();
  await expect(
    page
      .getByRole('article', { name: listing.allocation.section, exact: true })
      .getByText('8 available · 0 reserved · 0 sold'),
  ).toBeVisible();
});
test('fresh navigation recovers one new session while a completed URL returns home', async ({
  browser,
}) => {
  const s = await shortCheckout(100);
  await env.redis.after(s.session.reservationExpiresAt);
  const a = await pageOn(browser);
  await a.page.goto(a.base + `/checkout/${s.session.id}`);
  await expect(a.page).toHaveURL(/\/checkout\//);
  expect(a.page.url()).not.toContain(s.session.id);
  await expect(
    a.page.getByRole('button', { name: /Complete simulated/ }),
  ).toBeEnabled();
  const recovered = a.page.url();
  await a.page.getByRole('button', { name: /Complete simulated/ }).click();
  await expect(a.page).toHaveURL(/\/orders\/.+\/confirmation$/);
  await a.page.goto(recovered);
  await expect(a.page).toHaveURL(a.base + '/');
});
test('only the completing context receives a refreshable confirmation; observer goes home', async ({
  browser,
}) => {
  const a = await pageOn(browser);
  const id = await reserve(a.page, a.base);
  const b = await pageOn(browser, 1);
  await b.page.goto(b.base + `/checkout/${id}`);
  await expect(
    b.page.getByRole('button', { name: /Complete simulated/ }),
  ).toBeEnabled();
  let submissions = 0;
  a.page.on('request', (r) => {
    if (r.url().endsWith('/complete') && r.method() === 'POST') submissions++;
  });
  await a.page
    .getByRole('button', { name: /Complete simulated/ })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect(a.page).toHaveURL(/\/orders\/.+\/confirmation$/);
  await expect(
    a.page.getByRole('heading', { name: "You're going." }),
  ).toBeVisible();
  const confirmationPath = new URL(a.page.url()).pathname;
  await a.page.reload();
  await expect(
    a.page.getByRole('heading', { name: "You're going." }),
  ).toBeVisible();
  await expect(b.page).toHaveURL(b.base + '/');
  await b.page.goto(b.base + confirmationPath);
  await expect(b.page).toHaveURL(b.base + '/');
  expect(submissions).toBe(1);
  expect((await inventory()).soldQuantity).toBe(2);
});
test('transient noncapture allows a new attempt and then succeeds', async ({
  browser,
}) => {
  const a = await pageOn(browser, 2);
  await reserve(a.page, a.base);
  await a.page.getByRole('button', { name: /Complete simulated/ }).click();
  await expect(
    a.page.getByText("That attempt timed out. You weren't charged."),
  ).toBeVisible();
  await expect(a.page.getByText(/1 of 3 attempts used/)).toBeVisible();
  await a.page.getByRole('button', { name: /Try payment again/ }).click();
  await expect(a.page).toHaveURL(/\/orders\/.+\/confirmation$/);
});
test('definitive decline releases tickets and stops periodic polling', async ({
  browser,
}) => {
  const a = await pageOn(browser, 3);
  const id = await reserve(a.page, a.base);
  let reads = 0;
  a.page.on('request', (r) => {
    if (new URL(r.url()).pathname === `/api/checkouts/${id}`) reads++;
  });
  await a.page.getByRole('button', { name: /Complete simulated/ }).click();
  await expect(
    a.page.getByText('Payment declined', { exact: true }),
  ).toBeVisible();
  await expect(
    a.page.getByRole('link', { name: /Choose tickets again/ }),
  ).toBeVisible();
  await a.page.waitForTimeout(500);
  const count = reads;
  await a.page.waitForTimeout(2300);
  expect(reads).toBe(count);
  expect(Object.keys((await inventory()).reservations)).toHaveLength(0);
});
test('three transient attempts exhaust without a fourth payment action', async ({
  browser,
}) => {
  const a = await pageOn(browser, 4);
  await reserve(a.page, a.base);
  await a.page.getByRole('button', { name: /Complete simulated/ }).click();
  for (let n = 1; n <= 2; n++) {
    await expect(
      a.page.getByText(new RegExp(`${n} of 3 attempts used`)),
    ).toBeVisible();
    await a.page.getByRole('button', { name: /Try payment again/ }).click();
  }
  await expect(
    a.page.getByText('Payment attempts exhausted', { exact: true }),
  ).toBeVisible();
  await expect(
    a.page.getByRole('button', { name: /Try payment again/ }),
  ).toHaveCount(0);
});
test('processing protects inventory past the business deadline and resolves at its own deadline', async ({
  browser,
}) => {
  const s = await shortCheckout(2500);
  const a = await pageOn(browser, 5);
  await a.page.goto(a.base + `/checkout/${s.session.id}`);
  await a.page.getByRole('button', { name: /Complete simulated/ }).click();
  await expect(
    a.page.getByText("We're confirming your purchase."),
  ).toBeVisible();
  await expect(a.page.getByTestId('countdown')).toHaveCount(0);
  await env.redis.after(s.session.reservationExpiresAt);
  const stock = await inventory();
  expect(Object.keys(stock.reservations)).toHaveLength(1);
  const reservation = stock.reservations[s.session.reservationId];
  expect(reservation.processingDeadlineMs).toBeGreaterThan(
    Date.parse(s.session.reservationExpiresAt),
  );
  await env.redis.command(
    'EVAL',
    `local s=cjson.decode(redis.call('GET',KEYS[1]));local i=cjson.decode(redis.call('GET',KEYS[2]));local t=redis.call('TIME');local deadline=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)+400;s.session.processingDeadlineAt=deadline;i.reservations[ARGV[1]].processingDeadlineMs=deadline;redis.call('MSET',KEYS[1],cjson.encode(s),KEYS[2],cjson.encode(i));return 1`,
    '2',
    `checkout:{${env.namespace}}:session:v2:${s.session.id}`,
    `checkout:{${env.namespace}}:inventory:v2:${listing.id}`,
    s.session.reservationId,
  );
  await expect(
    a.page.getByText('The payment couldn’t be confirmed', { exact: true }),
  ).toBeVisible();
  await a.page.getByRole('link', { name: /Choose tickets again/ }).click();
  await expect(
    a.page
      .getByRole('article', { name: listing.allocation.section, exact: true })
      .getByText('8 available · 0 reserved · 0 sold'),
  ).toBeVisible();
});
test('lost successful response replays the same key and does not duplicate an order', async ({
  browser,
}) => {
  const a = await pageOn(browser);
  await reserve(a.page, a.base);
  const keys: string[] = [];
  let drop = true;
  await a.page.route('**/api/checkouts/*/complete', async (route) => {
    keys.push(route.request().headers()['idempotency-key']!);
    if (drop) {
      drop = false;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await a.page.getByRole('button', { name: /Complete simulated/ }).click();
  await expect(a.page).toHaveURL(/\/orders\/.+\/confirmation$/);
  expect(keys.length).toBeGreaterThanOrEqual(2);
  expect(new Set(keys).size).toBe(1);
  expect((await inventory()).soldQuantity).toBe(2);
});
test('focus revalidates changed state and keyboard controls remain accessible', async ({
  browser,
}) => {
  const a = await pageOn(browser);
  await reserve(a.page, a.base);
  await a.page.evaluate(() =>
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    }),
  );
  await a.page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange')),
  );
  await price(10000, 2500);
  const refreshed = a.page.waitForResponse(
    (r) =>
      r.url().includes('/api/checkouts/') && r.request().method() === 'GET',
  );
  await a.page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await refreshed;
  await expect(
    a.page.getByRole('button', { name: 'Accept new total · $250' }),
  ).toBeVisible();
  await a.page.getByRole('button', { name: 'Accept new total · $250' }).focus();
  await a.page.keyboard.press('Enter');
  await expect(
    a.page.getByRole('button', { name: /Complete simulated/ }),
  ).toBeEnabled();
  expect(
    await a.page
      .locator('input:not([type=hidden]),select,button')
      .evaluateAll((nodes) =>
        nodes.every((n) =>
          n instanceof HTMLButtonElement
            ? n.textContent!.trim().length > 0
            : !!n.closest('label') || n.hasAttribute('aria-label'),
        ),
      ),
  ).toBe(true);
});

test('expired unavailable inventory and missing checkout URLs return to useful pages', async ({
  browser,
}) => {
  const original = await shortCheckout(100);
  await env.redis.after(original.session.reservationExpiresAt);
  await shortCheckout(15_000); // An independent cart now owns those same seats.
  const a = await pageOn(browser);
  await a.page.goto(a.base + `/checkout/${original.session.id}`);
  await expect(a.page).toHaveURL(a.base + `/events/${listing.eventId}`);
  await a.page.goto(a.base + '/checkout/no-such-checkout');
  await expect(a.page).toHaveURL(a.base + '/');
});
test('temporary refresh failure disables payment and recovers without replacing the hold', async ({
  browser,
}) => {
  const a = await pageOn(browser);
  const id = await reserve(a.page, a.base);
  const before = await inventory();
  const deadline =
    before.reservations[Object.keys(before.reservations)[0]!].expiresAtMs;
  await a.page.route(`**/api/checkouts/${id}`, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Temporary test interruption',
        },
      }),
    }),
  );
  await expect(a.page.getByText("Let's reconnect.")).toBeVisible();
  await expect(
    a.page.getByRole('button', { name: /Complete simulated/ }),
  ).toBeDisabled();
  await a.page.unroute(`**/api/checkouts/${id}`);
  await a.page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(
    a.page.getByRole('button', { name: /Complete simulated/ }),
  ).toBeEnabled();
  const after = await inventory();
  expect(Object.keys(after.reservations)).toHaveLength(1);
  expect(
    after.reservations[Object.keys(after.reservations)[0]!].expiresAtMs,
  ).toBe(deadline);
});

test('keyboard skip navigation is discoverable and hidden during pointer interaction', async ({
  browser,
}) => {
  const a = await pageOn(browser);
  await a.page.goto(a.base);
  const skip = a.page.getByRole('link', { name: 'Skip to content' });
  await a.page.keyboard.press('Tab');
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await a.page.keyboard.press('Enter');
  await expect(a.page.locator('#main')).toBeInViewport();
  await a.page.getByRole('button', { name: 'Concerts', exact: true }).click();
  expect(await skip.evaluate((el) => getComputedStyle(el).clipPath)).toBe(
    'inset(50%)',
  );
});
