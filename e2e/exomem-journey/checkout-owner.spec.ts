import { test, expect } from "./fixtures";
import { seedOwner } from "./seed";

test("a paid checkout cannot use another sign-in's ready cell after its cookie changes", async ({
  page,
  context,
}) => {
  const original = await seedOwner("preparing");
  const switched = await seedOwner("ready");
  await context.addCookies(original.cookies);
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === new URL(process.env.EXOMEM_E2E_BASE_URL!).origin
      ? route.continue()
      : route.abort()
  );
  let rejected = 0;
  await page.route(
    (url) => url.pathname === "/api/exomem/status",
    async (route) => {
      expect(new URL(route.request().url()).searchParams.get("tenantId")).toBe(original.tenantId);
      await context.addCookies(switched.cookies);
      const response = await route.fetch({
        headers: {
          ...route.request().headers(),
          cookie: switched.cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
        },
      });
      expect(response.status()).toBe(403);
      rejected += 1;
      await route.fulfill({ response });
    }
  );
  await page.goto("/exomem/setup");
  await expect(page.getByRole("heading", { name: "Sign in again to continue" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "You’re subscribed" })).toBeVisible();
  await expect(
    page.getByText("This does not change any payment Paddle received.", { exact: false })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Add it to your assistant →" })).not.toBeVisible();
  await page.unrouteAll({ behavior: "wait" });
  expect(rejected).toBeGreaterThan(0);
});

test("a returned checkout stops on permanent ownership rejection without claiming payment failure", async ({
  page,
  context,
}) => {
  const original = await seedOwner("preparing");
  const switched = await seedOwner("ready");
  await context.addCookies(original.cookies);
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === new URL(process.env.EXOMEM_E2E_BASE_URL!).origin
      ? route.continue()
      : route.abort()
  );
  let rejected = 0;
  await page.route("**/api/exomem/billing/checkout", async (route) => {
    expect(route.request().postDataJSON().tenantId).toBe(original.tenantId);
    await context.addCookies(switched.cookies);
    const response = await route.fetch({
      headers: {
        ...route.request().headers(),
        cookie: switched.cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
        "x-exomem-csrf": switched.cookies.find(({ name }) => name === "exomem_csrf")!.value,
      },
    });
    expect(response.status()).toBe(403);
    rejected += 1;
    await route.fulfill({ response });
  });
  await page.goto(`/exomem/setup?_ptxn=txn_${"a".repeat(26)}`);
  await expect(page.getByRole("heading", { name: "Sign in again to continue" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in again", exact: true })).toBeVisible();
  await expect(page.getByText("Your payment didn’t finish.", { exact: false })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Add it to your assistant →" })).not.toBeVisible();
  await page.unrouteAll({ behavior: "wait" });
  expect(rejected).toBeGreaterThan(0);
});
