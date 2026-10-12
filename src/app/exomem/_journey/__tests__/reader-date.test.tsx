import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { unknownDate } from "../copy";
import { useReaderDate } from "../reader-date";

function Deadline({ iso }: { iso: string }) {
  return createElement("p", null, useReaderDate({ value: iso, reason: null }));
}

// The last day to export is shown in the reader's own time zone. The server does not
// know that zone: a date written there in UTC would be a day out for half the world,
// and without JavaScript it would stay wrong.
describe("useReaderDate", () => {
  it("leaves the date unknown in the server's render", () => {
    const html = renderToString(createElement(Deadline, { iso: "2026-11-11T00:30:00.000Z" }));

    assert.ok(html.includes(unknownDate), html);
    assert.ok(!/November/.test(html), html);
  });
});
