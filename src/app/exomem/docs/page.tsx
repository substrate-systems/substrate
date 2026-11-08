import Link from "next/link";
import { CLIENT_PLATFORM_LISTING_URLS } from "@/lib/exomem-hosted/client-platforms";
import { loadExomemCloudResource } from "@/lib/exomem-hosted/cloud-config";
import { cloudExportsEnabled } from "@/lib/exomem-hosted/cloud-exports";
import { buildExomemMetadata } from "@/lib/exomem/metadata";
import { ExomemPublicPage } from "../public-page";

export const metadata = buildExomemMetadata({
  title: "Exomem Cloud Documentation",
  description:
    "How to connect Exomem Cloud to Claude, ChatGPT, or any app that supports MCP, what Exomem can read and change, and how to disconnect, export, or delete.",
  path: "/exomem/docs",
});

// The MCP address comes from configuration, as on the setup page. Without it the page
// sends people to Home, which shows the address after sign-in, instead of guessing one.
function mcpAddress(): string | null {
  try {
    return loadExomemCloudResource().mcpUrl;
  } catch {
    return null;
  }
}

export default function ExomemDocsPage() {
  const address = mcpAddress();
  // This page is static, so it reads the export flag at build, as the privacy page does.
  const exportOffered = cloudExportsEnabled();
  const addressText = address ? (
    <code>{address}</code>
  ) : (
    <>
      the Exomem address that <Link href="/exomem/home">Home</Link> shows
    </>
  );
  return (
    <ExomemPublicPage title="Exomem Cloud documentation" eyebrow="Connect and use Exomem">
      <p>
        Exomem is a knowledge base that your AI assistants share. Your assistant uses it to find
        what you decided, the sources behind each decision, and what changed since. It can also save
        new conclusions, sources and evidence, so that your next conversation starts from them.
        Substrate Systems OÜ runs Exomem Cloud.
      </p>
      <p>
        This page tells you how to connect Exomem Cloud to your assistant, what Exomem can read and
        change, and how to stop.
      </p>

      <h2>Before you connect</h2>
      <ul>
        <li>
          You need an Exomem account. Start on the <Link href="/exomem">Exomem page</Link> with your
          email. Exomem Cloud is a monthly subscription.
        </li>
        <li>
          You need no admin permissions and no API key. When you connect, your app opens an Exomem
          sign-in page, and you approve the connection there.
        </li>
        <li>Your app must support remote MCP servers with OAuth sign-in.</li>
      </ul>
      <p>The Exomem address is {addressText}. It is the same for every account.</p>

      <h2>Connect Claude</h2>
      <p>
        These steps cover Claude on the web, Claude Desktop and Cowork. A connector that you add on
        the web also appears in the Claude mobile apps.
      </p>
      <ol>
        <li>In Claude, open “Settings”, then “Connectors”.</li>
        <li>
          Find Exomem and select “Connect”. If Exomem is not in the list, select “Add custom
          connector” and paste {addressText}.
        </li>
        <li>Sign in to Exomem with your email, and approve the connection.</li>
      </ol>
      <p>Claude now shows Exomem as connected, and you can use it in any conversation.</p>
      <p>For Claude Code, install the Exomem plugin. It also adds the Exomem skills and hooks:</p>
      <ol>
        <li>
          Run <code>/plugin marketplace add Artexis10/exomem</code>.
        </li>
        <li>
          Run <code>/plugin install exomem-cloud@exomem</code>.
        </li>
        <li>
          Run <code>/mcp</code>, select Exomem, and sign in.
        </li>
      </ol>

      <h2>Connect ChatGPT</h2>
      <ol>
        <li>
          Open{" "}
          <a href={CLIENT_PLATFORM_LISTING_URLS.openai} target="_blank" rel="noreferrer">
            Exomem in the ChatGPT plugin directory
          </a>
          .
        </li>
        <li>Select “Connect”.</li>
        <li>Sign in to Exomem with your email, and approve the connection.</li>
      </ol>
      <p>ChatGPT now shows Exomem as connected. Codex uses the same plugin from its directory.</p>

      <h2>Connect another app</h2>
      <p>Any app that supports remote MCP servers with OAuth sign-in can use Exomem.</p>
      <ol>
        <li>Open the connector or MCP server settings of your app.</li>
        <li>Add a remote server with the address {addressText}.</li>
        <li>Sign in to Exomem with your email, and approve the connection.</li>
        <li>
          On <Link href="/exomem/home">Home</Link>, copy the Exomem instructions. Paste them into
          the instructions of your app, or into its rules file, such as <code>AGENTS.md</code>.
        </li>
      </ol>
      <p>
        Your app now uses Exomem. The instructions are necessary because only the Claude and ChatGPT
        plugins include them.
      </p>

      <h2>What Exomem reads and changes</h2>
      <ul>
        <li>
          <strong>Reads:</strong> Exomem searches and reads your own knowledge base, and returns the
          notes and sources that answer the question.
        </li>
        <li>
          <strong>Changes:</strong> Exomem saves notes, sources, evidence, plans and corrections
          when you ask, or when the settings of your assistant allow it. A correction replaces old
          knowledge in a visible way. Exomem keeps the old version and marks it as replaced.
        </li>
        <li>
          <strong>Does not read:</strong> Exomem cannot open files on your device, your other
          connectors, or your past conversations. It receives only what your assistant sends to it.
        </li>
      </ul>
      <p>
        Your app decides when a tool runs. In Claude, for example, you can set each Exomem tool to
        ask you first.
      </p>

      <h2>Your data</h2>
      <ul>
        <li>Each account has its own storage, which no other account can reach.</li>
        <li>
          We encrypt your knowledge base and its backups at rest, and every connection in transit.
        </li>
        <li>We do not use your content to train AI models.</li>
      </ul>
      <p>
        The <Link href="/exomem/privacy">privacy policy</Link> gives the full details, including who
        processes your data and how long we keep it.
      </p>

      <h2>Disconnect, export or delete</h2>
      <ul>
        <li>
          <strong>Disconnect an app:</strong> remove the connector in the app, or select
          “Disconnect” next to the app on <Link href="/exomem/home">Home</Link>.
        </li>
        <li>
          <strong>Export:</strong>{" "}
          {exportOffered ? (
            <>
              start an export on <Link href="/exomem/home">Home</Link>. You get a ZIP file of your
              Markdown notes and files.
            </>
          ) : (
            <>
              ask on the <Link href="/exomem/support">support page</Link>.
            </>
          )}
        </li>
        <li>
          <strong>Delete your account:</strong> use the{" "}
          <Link href="/exomem/delete">delete page</Link>.
        </li>
      </ul>

      <h2>Help</h2>
      <p>
        For setup, account or privacy questions, use the{" "}
        <Link href="/exomem/support">support page</Link>.
      </p>
    </ExomemPublicPage>
  );
}
