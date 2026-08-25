import { expect, test, type Page, type Request } from "@playwright/test";

const CAPACITY = "**/api/exomem/admin/capacity";
const INVITES = "**/api/exomem/admin/invites";
const BEARER = "operator-bearer-sentinel";

const capacity = {
  storageCapacityBytes: 20 * 1024 * 1024 * 1024,
  reservedStorageBytes: 5 * 1024 * 1024 * 1024,
  runtimeCapacitySlots: 4,
  reservedRuntimeSlots: 1,
  provisionReservationCapacity: 4,
  reservedProvisionSlots: 1,
  provisionClaimCapacity: 2,
  activeProvisionClaims: 0,
  outstandingPaidInvites: 1,
};

function authorization(request: Request): string | undefined {
  return request.headers()["authorization"];
}

async function openControls(page: Page) {
  await page.getByLabel("Admin bearer").fill(BEARER);
  await page.getByRole("button", { name: "Open controls" }).click();
  await expect(page.getByRole("heading", { name: "Alpha invitations." })).toBeVisible();
}

test.describe("private Exomem operator", () => {
  test("keeps the bearer ephemeral and sends paid access by default", async ({ context, page }) => {
    const capacityRequests: Request[] = [];
    const inviteBodies: unknown[] = [];
    await context.addCookies([
      { name: "session-sentinel", value: "must-not-be-sent", url: "http://127.0.0.1:3000" },
    ]);
    await page.route(CAPACITY, async (route) => {
      capacityRequests.push(route.request());
      await route.fulfill({ status: 200, json: { success: true, capacity } });
    });
    await page.route(INVITES, async (route) => {
      inviteBodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 201, json: { success: true, status: "sent" } });
    });

    await page.goto("/exomem/operator");
    await openControls(page);

    expect(authorization(capacityRequests[0]!)).toBe(`Bearer ${BEARER}`);
    expect(capacityRequests[0]!.headers()["cookie"]).toBeUndefined();
    expect(capacityRequests[0]!.headers()["referer"]).toBeUndefined();
    await expect(page.getByText("Paid slots free").locator("..").getByText("2")).toBeVisible();
    await expect(page.getByLabel("Access")).toHaveValue("paid");

    await page.getByLabel("Friend's email").fill("friend@example.com");
    await page.getByRole("button", { name: "Send paid invitation" }).click();
    await expect(page.getByRole("status")).toHaveText("Paid invitation sent.");
    expect(inviteBodies).toEqual([{ email: "friend@example.com", source: "paid" }]);

    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    await page.reload();
    await expect(page.getByLabel("Admin bearer")).toBeVisible();
  });

  test("makes complimentary access explicit and surfaces capacity refusal", async ({ page }) => {
    let inviteCount = 0;
    await page.route(CAPACITY, async (route) => {
      await route.fulfill({ status: 200, json: { success: true, capacity } });
    });
    await page.route(INVITES, async (route) => {
      inviteCount += 1;
      if (inviteCount === 1) {
        await route.fulfill({
          status: 409,
          json: { success: false, error: { code: "CAPACITY_UNAVAILABLE" } },
        });
        return;
      }
      await route.fulfill({ status: 201, json: { success: true, status: "sent" } });
    });

    await page.goto("/exomem/operator");
    await openControls(page);
    await page.getByLabel("Friend's email").fill("friend@example.com");
    await page.getByRole("button", { name: "Send paid invitation" }).click();
    await expect(page.getByText("No paid alpha slots remain.", { exact: true })).toBeVisible();

    await page.getByLabel("Access").selectOption("complimentary");
    const complimentary = page.getByRole("button", { name: "Send complimentary invitation" });
    await expect(complimentary).toBeDisabled();
    await page.getByLabel("Confirm this person will not be asked to subscribe.").check();
    await expect(complimentary).toBeEnabled();
    await complimentary.click();
    await expect(page.getByRole("status")).toHaveText("Complimentary invitation sent.");
  });
});
