import assert from "node:assert/strict";
import { test } from "node:test";
import { requireExomemDeployer, requireExomemOperator } from "../operator-auth";
import { generateExternalToken } from "../security";

test("deploy credential works only through the release principal and cannot authenticate as admin", () => {
  const previousAdmin = process.env.EXOMEM_ADMIN_TOKEN;
  const previousDeploy = process.env.EXOMEM_DEPLOY_TOKEN;
  try {
    process.env.EXOMEM_ADMIN_TOKEN = generateExternalToken();
    process.env.EXOMEM_DEPLOY_TOKEN = generateExternalToken();
    const deploy = new Request("https://app.example.test", {
      headers: { authorization: `Bearer ${process.env.EXOMEM_DEPLOY_TOKEN}` },
    });
    const admin = new Request("https://app.example.test", {
      headers: { authorization: `Bearer ${process.env.EXOMEM_ADMIN_TOKEN}` },
    });
    assert.ok(requireExomemDeployer(deploy).principalDigest);
    assert.throws(() => requireExomemOperator(deploy));
    assert.ok(requireExomemOperator(admin).principalDigest);
    assert.ok(requireExomemDeployer(admin).principalDigest);
    delete process.env.EXOMEM_DEPLOY_TOKEN;
    assert.throws(() => requireExomemDeployer(deploy));
  } finally {
    if (previousAdmin === undefined) delete process.env.EXOMEM_ADMIN_TOKEN;
    else process.env.EXOMEM_ADMIN_TOKEN = previousAdmin;
    if (previousDeploy === undefined) delete process.env.EXOMEM_DEPLOY_TOKEN;
    else process.env.EXOMEM_DEPLOY_TOKEN = previousDeploy;
  }
});
