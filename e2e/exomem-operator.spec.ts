import { expect, test, type Page, type Request } from "@playwright/test";

const CAPACITY = "**/api/exomem/admin/capacity";
const INVITES = "**/api/exomem/admin/invites";
const BEARER = "operator-bearer-sentinel";

const capacity = {
  freePlaces: 2,
  freePlacesUnknownReason: null,
  observedSlots: 4,
  liveCells: 1,
  outstandingInvitations: 1,
  newestObservationAt: "2026-10-12T08:00:00.000Z",
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
  test("keeps the bearer ephemeral and sends a paid invitation by default", async ({
    context,
    page,
  }) => {
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
      await route.fulfill({ status: 201, json: { success: true, status: "queued" } });
    });

    await page.goto("/exomem/operator");
    await openControls(page);

    expect(authorization(capacityRequests[0]!)).toBe(`Bearer ${BEARER}`);
    expect(capacityRequests[0]!.headers()["cookie"]).toBeUndefined();
    expect(capacityRequests[0]!.headers()["referer"]).toBeUndefined();
    await expect(page.getByText("Cloud places free").locator("..").getByText("2")).toBeVisible();
    const access = page.getByRole("group", { name: "Access" });
    await expect(access.getByRole("radio", { name: "Paid", exact: true })).toBeChecked();

    await page.getByLabel("Invitee's email").fill("invitee@example.com");
    await page.getByRole("button", { name: "Send paid invitation" }).click();
    await expect(page.getByRole("status")).toHaveText("The paid invitation is queued.");
    expect(inviteBodies).toEqual([{ email: "invitee@example.com", kind: "standard" }]);

    // Theme preferences can persist; the operator bearer must never enter browser storage.
    const storedEntries = await page.evaluate(() => [
      ...Object.entries(localStorage),
      ...Object.entries(sessionStorage),
    ]);
    expect(JSON.stringify(storedEntries)).not.toContain(BEARER);
    await page.reload();
    await expect(page.getByLabel("Admin bearer")).toBeVisible();
  });

  test("sends a friend invitation with the inviter's details, makes covered access explicit and surfaces capacity refusal", async ({
    page,
  }) => {
    const inviteBodies: unknown[] = [];
    await page.route(CAPACITY, async (route) => {
      await route.fulfill({ status: 200, json: { success: true, capacity } });
    });
    await page.route(INVITES, async (route) => {
      inviteBodies.push(route.request().postDataJSON());
      if (inviteBodies.length === 1) {
        await route.fulfill({
          status: 409,
          json: { success: false, error: { code: "CAPACITY_UNAVAILABLE" } },
        });
        return;
      }
      await route.fulfill({ status: 201, json: { success: true, status: "queued" } });
    });

    await page.goto("/exomem/operator");
    await openControls(page);
    await page.getByLabel("Invitee's email").fill("invitee@example.com");
    await page.getByRole("button", { name: "Send paid invitation" }).click();
    await expect(page.getByText("No Cloud places are free.", { exact: true })).toBeVisible();

    // A friend invitation names its inviter; an inviter's email needs the invitee's name.
    const access = page.getByRole("group", { name: "Access" });
    await access.getByRole("radio", { name: "Friend (paid, friend price)" }).check();
    await page.getByLabel("Inviter's name").fill("Alex Example");
    await page.getByLabel("Inviter's email").fill("alex@example.com");
    await expect(page.getByLabel("Invitee's name")).toHaveAttribute("required", "");
    await page.getByLabel("Invitee's name").fill("Sam Example");
    await page.getByLabel("Note from the inviter").fill("This is what I have been building.");
    await page.getByRole("button", { name: "Send friend invitation" }).click();
    await expect(page.getByRole("status")).toHaveText("The friend invitation is queued.");
    expect(inviteBodies[1]).toEqual({
      email: "invitee@example.com",
      kind: "friend",
      inviterName: "Alex Example",
      inviterEmail: "alex@example.com",
      inviteeName: "Sam Example",
      note: "This is what I have been building.",
    });
    // Each send returns the form to a paid invitation.
    await expect(access.getByRole("radio", { name: "Paid", exact: true })).toBeChecked();

    await page.getByLabel("Invitee's email").fill("covered@example.com");
    await access.getByRole("radio", { name: "Covered (complimentary)" }).check();
    await page.getByLabel("Inviter's name").fill("Alex Example");
    const covered = page.getByRole("button", { name: "Send covered invitation" });
    await expect(covered).toBeDisabled();
    await page
      .getByRole("switch", { name: "Confirm this person will not be asked to subscribe." })
      .check();
    await expect(covered).toBeEnabled();
    await covered.click();
    await expect(page.getByRole("status")).toHaveText("The covered invitation is queued.");
    expect(inviteBodies[2]).toEqual({
      email: "covered@example.com",
      kind: "covered",
      inviterName: "Alex Example",
    });
  });
});
