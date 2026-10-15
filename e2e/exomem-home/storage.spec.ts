import { randomUUID } from "node:crypto";
import { expect, test as base } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createOwner, pool, signIn } from "./seed";
import { homeE2eEnvironment } from "./environment";

const test = base.extend<object, { database: void }>({
  database: [
    async ({}, use) => {
      await use();
      await pool.end();
    },
    { scope: "worker", auto: true },
  ],
});

async function payingOwner() {
  const owner = await createOwner({
    storage: {
      usedBytes: 1_000_000_000,
      filesystemBytes: 10 * 1024 ** 3,
      observedAt: new Date().toISOString(),
    },
  });
  const subscriptionId = `sub_${randomUUID().replaceAll("-", "").slice(0, 26)}`;
  const customerId = `ctm_${randomUUID().replaceAll("-", "").slice(0, 26)}`;
  await pool.query(
    "UPDATE exomem_entitlements SET provider_subscription_ref=$2,provider_customer_ref=$3,resource_limits=$4 WHERE tenant_id=$1",
    [
      owner.tenantId,
      subscriptionId,
      customerId,
      { storageBytes: 5 * 1024 ** 3, uploadBytes: 90 * 1024 ** 2, workerCount: 0 },
    ]
  );
  await pool.query(
    "UPDATE exomem_cloud_cells SET observed_storage_pvc_uid='claim-original',observed_storage_pvc_version='1',observed_storage_capacity_bytes=10737418240,observed_storage_generation=generation,observed_storage_at=now() WHERE cell_id=$1",
    [owner.cellId]
  );
  return {
    owner,
    subscriptionId,
    customerId,
    subscription: {
      id: subscriptionId,
      customer_id: customerId,
      status: "active",
      updated_at: "2026-01-01T00:00:00Z",
      currency_code: "EUR",
      billing_cycle: { interval: "month", frequency: 1 },
      collection_mode: "automatic",
      scheduled_change: null,
      custom_data: {
        user_id: owner.userId,
        tenant_id: owner.tenantId,
        product_key: "exomem-hosted",
      },
      items: [
        { price: { id: "pri_" + "a".repeat(26) }, quantity: 1 },
        { price: { id: "pri_" + "c".repeat(26) }, quantity: 3 },
      ],
    },
  };
}

test("storage confirms its provider price once, survives reload and waits for the matching expanded disk", async ({
  page,
  request,
}) => {
  const fixture = await payingOwner();
  const control = `${homeE2eEnvironment().controlUrl}/__paddle-control/${fixture.subscriptionId}`;
  await request.post(control, { data: { subscription: fixture.subscription } });
  await signIn(page.context(), fixture.owner);
  await page.goto("/exomem/home");
  await page.getByRole("button", { name: "Add storage", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("radio", { name: /\+10 GB/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Check the price", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Add 10 GB · €1.98 now", exact: true })
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Add 10 GB · €1.98 now", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Making room", exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Add storage", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Making room", exact: true })).toBeVisible();
  const provider = await (await request.get(control)).json();
  expect(provider.updates).toBe(1);
  expect(
    provider.subscription.items.find(
      (item: { price: { id: string } }) => item.price.id === "pri_" + "c".repeat(26)
    ).quantity
  ).toBe(3);
  await pool.query(
    "UPDATE exomem_cloud_cells SET observed_storage_pvc_uid='other-claim',observed_storage_capacity_bytes=21474836480,observed_storage_generation=generation,observed_storage_at=now() WHERE cell_id=$1",
    [fixture.owner.cellId]
  );
  const pending = await page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/exomem/storage"
  );
  expect((await pending.json()).operation.state).toBe("paid");
  await pool.query(
    "UPDATE exomem_cloud_cells SET observed_storage_pvc_uid='claim-original',observed_storage_pvc_version='2',observed_storage_at=now() WHERE cell_id=$1",
    [fixture.owner.cellId]
  );
  await expect(
    dialog.getByRole("heading", { name: "More storage added", exact: true })
  ).toBeVisible();
  await expect(dialog.getByText(/You now have 21\.5 GB/)).toBeVisible();
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().iterations))
        .map((animation) => animation.finished.catch(() => {}))
    );
  });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical"
    )
  ).toEqual([]);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test("an account change refuses the old storage confirmation before billing", async ({
  page,
  request,
}) => {
  const fixture = await payingOwner();
  const other = await payingOwner();
  const control = `${homeE2eEnvironment().controlUrl}/__paddle-control/${fixture.subscriptionId}`;
  await request.post(control, { data: { subscription: fixture.subscription } });
  await request.post(
    `${homeE2eEnvironment().controlUrl}/__paddle-control/${other.subscriptionId}`,
    { data: { subscription: other.subscription } }
  );
  await signIn(page.context(), fixture.owner);
  await page.goto("/exomem/home");
  await page.getByRole("button", { name: "Add storage", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Check the price", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Add 10 GB · €1.98 now", exact: true })
  ).toBeVisible();
  await signIn(page.context(), other.owner);
  const refused = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/exomem/storage"
  );
  await page.getByRole("button", { name: "Add 10 GB · €1.98 now", exact: true }).click();
  expect((await refused).status()).toBe(403);
  await expect(page).toHaveURL(/\/exomem\/sign-in/);
  expect((await (await request.get(control)).json()).updates ?? 0).toBe(0);
});
