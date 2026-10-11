import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasForbiddenGatewayHeaders } from "../forbidden-headers";

describe("gateway forbidden headers", () => {
  it("rejects browser attempts to supply Cloudflare Access service credentials", () => {
    for (const name of ["CF-Access-Client-Id", "CF-Access-Client-Secret"]) {
      assert.equal(hasForbiddenGatewayHeaders(new Headers({ [name]: "browser-value" })), true);
    }
  });

  it("rejects release selectors in public headers and cookies without rejecting the bearer", () => {
    assert.equal(
      hasForbiddenGatewayHeaders(
        new Headers({ authorization: "Bearer opaque", "candidate-id": "candidate-b" })
      ),
      true
    );
    assert.equal(
      hasForbiddenGatewayHeaders(
        new Headers({ authorization: "Bearer opaque", "source-release": "0.35.0" })
      ),
      true
    );
    assert.equal(
      hasForbiddenGatewayHeaders(new Headers({ cookie: "session=safe; assignment_generation=7" })),
      true
    );
    assert.equal(
      hasForbiddenGatewayHeaders(
        new Headers({ cookie: `session=safe; contractDigest=${"a".repeat(64)}` })
      ),
      true
    );
    assert.equal(
      hasForbiddenGatewayHeaders(
        new Headers({ authorization: "Bearer opaque", cookie: "session=safe" })
      ),
      false
    );
  });
});
