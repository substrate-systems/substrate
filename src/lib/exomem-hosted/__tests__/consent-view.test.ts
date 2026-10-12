import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connectorSettingsUrl } from "../consent-view";

// "Connect after all" renders this value as a link on the consent page. A wrong
// row is a local app sent to a web settings page, or an operator typo turned
// into a `javascript:` link, or a malformed setting that breaks the page.
const SETTINGS = JSON.stringify({ claude: "https://assistant.example.test/settings/connectors" });

const CASES: Array<{
  name: string;
  platform: string | null;
  loopback: boolean;
  setting: string | undefined;
  expected: { value: string | null; reason: string | null };
}> = [
  {
    name: "a web app on a configured platform links to its settings",
    platform: "claude",
    loopback: false,
    setting: SETTINGS,
    expected: { value: "https://assistant.example.test/settings/connectors", reason: null },
  },
  {
    name: "a local app has no settings page",
    platform: "claude",
    loopback: true,
    setting: SETTINGS,
    expected: { value: null, reason: "local_app" },
  },
  {
    name: "an app with no platform has no known settings page",
    platform: null,
    loopback: false,
    setting: SETTINGS,
    expected: { value: null, reason: "platform_unknown" },
  },
  {
    name: "an unset setting offers no link",
    platform: "claude",
    loopback: false,
    setting: undefined,
    expected: { value: null, reason: "not_configured" },
  },
  {
    name: "a platform missing from the setting offers no link",
    platform: "openai",
    loopback: false,
    setting: SETTINGS,
    expected: { value: null, reason: "not_configured" },
  },
  {
    name: "a setting that is not JSON offers no link",
    platform: "claude",
    loopback: false,
    setting: "claude=https://assistant.example.test",
    expected: { value: null, reason: "invalid_configuration" },
  },
  {
    name: "an address that is not https is never linked",
    platform: "claude",
    loopback: false,
    setting: JSON.stringify({ claude: "javascript:alert(1)" }),
    expected: { value: null, reason: "invalid_configuration" },
  },
];

describe("connectorSettingsUrl", () => {
  for (const { name, platform, loopback, setting, expected } of CASES) {
    it(name, () => {
      const warn = console.warn;
      console.warn = () => {};
      try {
        assert.deepEqual(
          connectorSettingsUrl(platform, loopback, { EXOMEM_CONNECTOR_SETTINGS_URLS: setting }),
          expected
        );
      } finally {
        console.warn = warn;
      }
    });
  }
});
