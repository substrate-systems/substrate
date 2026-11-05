import { expect, test } from "@playwright/test";
import { createDeletionLink, createOwner, pool, setCell, signIn, tenantStatus } from "./seed";
import { homeE2eEnvironment } from "./environment";

test.afterAll(async () => pool.end());

test("retrying an interrupted log read clears the failure and shows the real received window", async ({
  page,
}) => {
  const owner = await createOwner({ plan: "complimentary" });
  await signIn(page.context(), owner);
  await page.route("**/api/exomem/cloud/access-log", (route) => route.abort("failed"));
  await page.goto("/exomem/access-log");
  const error = page.getByRole("alert").filter({ hasText: "The access log cannot be read" });
  await expect(error).toHaveText(
    "The access log cannot be read right now. Try again."
  );
  await page.unroute("**/api/exomem/cloud/access-log");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Received events" })).toBeVisible();
  await expect(
    page.getByText("No received events appear in this collection window.")
  ).toBeVisible();
  await expect(error).toHaveCount(0);
});

test("a stopped cell's received log survives erasure through a fresh restricted recovery login", async ({
  page,
  browser,
}) => {
  const owner = await createOwner({ plan: "complimentary" });
  const other = await createOwner({ plan: "complimentary" });
  await setCell(owner, { desired_state: "stopped", observed_state: "stopped", ready: false });
  await pool.query(
    "UPDATE exomem_cloud_cells SET desired_state='stopped', observed_state='stopped', ready=false WHERE cell_id=$1",
    [owner.cellId]
  );
  const receipt = await pool.query(
    "INSERT INTO exomem_cloud_access_receipts(bucket_id,object_key,version_id,provider_at,processed_at) VALUES('fixture-bucket',$1,'retained-version',now(),now()) RETURNING id",
    [`access/node-a/${owner.cellId}`]
  );
  const record = await pool.query(
    "INSERT INTO exomem_cloud_access_records(receipt_id,line_number,kind,source_at,provider_at,node,boot_id,event_id,identity_tier,action,target) VALUES($1,0,'kubernetes',now(),now(),'node-a','boot-a','event-a','admin','get','<img src=x onerror=alert(1)>') RETURNING id",
    [receipt.rows[0].id]
  );
  await pool.query("INSERT INTO exomem_cloud_access_entries(cell_id,record_id) VALUES($1,$2)", [
    owner.cellId,
    record.rows[0].id,
  ]);
  await signIn(page.context(), owner);
  await page.goto("/exomem/access-log");
  await expect(page.getByRole("heading", { name: "Received events" })).toBeVisible();
  await expect(page.getByText("<img src=x onerror=alert(1)>", { exact: true })).toBeVisible();
  await expect(page.locator("article img")).toHaveCount(0);
  await expect(page.getByText("Coverage is unknown.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Create recovery code" }).click();
  const codeField = page.getByRole("textbox", { name: "Save this recovery code" });
  await expect(codeField).toBeVisible();
  const code = await codeField.inputValue();
  expect(code.length).toBeGreaterThan(40);

  await page.goto(`/exomem/delete#${await createDeletionLink(owner)}`);
  await page.getByRole("button", { name: "Permanently delete my Exomem" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Your shared Substrate identity and any other product remain untouched."
  );
  await expect.poll(() => tenantStatus(owner)).toBe("deleted");
  const erased = await pool.query("SELECT email FROM exomem_users WHERE id=$1", [owner.userId]);
  expect(erased.rows[0].email).toBeNull();

  const fresh = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const retained = await fresh.newPage();
    await retained.goto("/exomem/access-log");
    await expect(retained.getByRole("heading", { name: "Read a retained log" })).toBeVisible();
    await retained.getByLabel("Recovery code", { exact: true }).fill(code);
    await retained.getByRole("button", { name: "Read access log" }).click();
    await expect(retained.getByText("<img src=x onerror=alert(1)>", { exact: true })).toBeVisible();
    await retained.reload();
    await expect(retained.getByText("<img src=x onerror=alert(1)>", { exact: true })).toBeVisible();
    expect(
      (await fresh.request.get(`/api/exomem/cloud/access-log?cellId=${other.cellId}`)).status()
    ).toBe(401);
    for (const path of ["/api/exomem/account", "/api/exomem/status"]) {
      expect((await fresh.request.get(path)).status()).toBe(401);
    }
    for (const path of [
      "/api/exomem/billing/portal",
      "/api/exomem/cloud/exports",
      "/api/exomem/cloud/access-log/recovery",
    ]) {
      expect((await fresh.request.post(path, { data: { cellId: owner.cellId } })).status()).toBe(
        401
      );
    }
    expect(
      (
        await fresh.request.post(homeE2eEnvironment().mcpUrl, {
          headers: {
            authorization: `Bearer ${(await fresh.cookies()).find((cookie) => cookie.name === "exomem_access_log_session")!.value}`,
          },
          data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        })
      ).status()
    ).toBe(401);
    await expect(retained.getByRole("button", { name: "Create recovery code" })).toHaveCount(0);
  } finally {
    await fresh.close();
  }
});
