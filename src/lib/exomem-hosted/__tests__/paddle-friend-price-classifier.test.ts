import assert from "node:assert/strict";
import { test } from "node:test";
import { carriesFriendPrice } from "../paddle-friend-price";

test("stored and provider facts recognize a configured friend SKU or the legacy friend discount", () => {
  const config = { friendPriceId: "pri_friend_example", friendDiscountId: "dsc_friend_example" };
  assert.equal(
    carriesFriendPrice({ priceId: config.friendPriceId, discountId: null }, config),
    true
  );
  assert.equal(
    carriesFriendPrice(
      { priceId: "pri_regular_example", discountId: config.friendDiscountId },
      config
    ),
    true
  );
  assert.equal(
    carriesFriendPrice({ priceId: "pri_regular_example", discountId: "dsc_promo_example" }, config),
    false
  );
  assert.equal(
    carriesFriendPrice(
      { priceId: null, discountId: null },
      { friendPriceId: null, friendDiscountId: null }
    ),
    false
  );
});
