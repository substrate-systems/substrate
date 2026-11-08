import Link from "next/link";
import { INVOLVEMENT_LEVELS } from "@/components/exomem/involvement-levels";
import { CLIENT_PLATFORM_LISTING_URLS } from "@/lib/exomem-hosted/client-platforms";
import { exomemCloudMcpUrlOrNull } from "@/lib/exomem-hosted/cloud-config";
import { cloudExportsEnabled } from "@/lib/exomem-hosted/cloud-exports";
import { buildExomemMetadata } from "@/lib/exomem/metadata";
import { ExomemPublicPage } from "../public-page";

export const metadata = buildExomemMetadata({
  title: "Exomem Cloud Documentation",
  description:
    "How to connect Exomem Cloud to Claude, ChatGPT, or any app that supports MCP, what Exomem can read and change, and how to disconnect, export, or delete.",
  path: "/exomem/docs",
});

export default function ExomemDocsPage() {
  // Both read at build, as the privacy page does: this page is static.
  const address = exomemCloudMcpUrlOrNull();
  const exportOffered = cloudExportsEnabled();
  const levels = INVOLVEMENT_LEVELS.map((level) => `“${level.label}”`).join(", ");
  const home = <Link href="/exomem/home">Home</Link>;
  const theAddress = address ? <code>{address}</code> : <>the address that {home} shows</>;
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
          You need no API key. When you connect, your app opens an Exomem sign-in page, and you
          approve the connection there.
        </li>
        <li>Your app must support remote MCP servers with OAuth sign-in.</li>
        <li>
          On a company workspace, such as Claude Team or Enterprise, an owner or admin may need to
          allow Exomem first.
        </li>
      </ul>
      {address ? (
        <p>The Exomem address is {theAddress}. It is the same for every account.</p>
      ) : (
        <p>After you sign in, {home} shows the Exomem address.</p>
      )}

      <h2>Connect Claude</h2>
      <p>
        These steps cover Claude on the web, Claude Desktop and Cowork. A connector that you add on
        the web also appears in the Claude mobile apps.
      </p>
      <ol>
        <li>In Claude, open “Settings”, then “Connectors”.</li>
        <li>If Exomem is in the list, select it.</li>
        <li>
          If Exomem is not in the list, select “Add custom connector”, and paste {theAddress}.
        </li>
        <li>Select “Connect”.</li>
        <li>Sign in to Exomem with your email, and approve the connection.</li>
      </ol>
      <p>Claude now shows Exomem as connected, and you can use it in any conversation.</p>

      <h2>Connect Claude Code</h2>
      <p>
        The Exomem plugin adds the connection, the Exomem skills, and hooks that suggest when to
        search or save. The hooks run on your device and need Python 3 (<code>python3</code>).
      </p>
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
      <p>
        <code>/mcp</code> now shows Exomem as connected.
      </p>

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
        <li>Add a remote server with {theAddress}.</li>
        <li>Sign in to Exomem with your email, and approve the connection.</li>
        <li>On {home}, select “Add another app”, then “Set up”.</li>
        <li>Pick how much the app joins in, and select “Copy”.</li>
        <li>
          Paste the text into the instructions of your app, or into its rules file, such as{" "}
          <code>AGENTS.md</code>.
        </li>
      </ol>
      <p>
        Your app now uses Exomem. The instructions tell it when to search Exomem and when to save to
        it.
      </p>

      <h2>What Exomem reads and changes</h2>
      <ul>
        <li>
          <strong>Reads:</strong> Exomem searches and reads your own knowledge base, and returns the
          notes and sources that answer the question.
        </li>
        <li>
          <strong>Receives:</strong> when your assistant searches, it sends your question and short
          parts of the conversation. Exomem keeps only what is saved or imported.
        </li>
        <li>
          <strong>Changes:</strong> Exomem saves notes, sources, evidence, plans and corrections
          when you ask. Your level on {home}, under “How much Exomem joins in”, decides how much
          your assistant saves without asking: {levels}.
        </li>
        <li>
          <strong>Corrections:</strong> a correction replaces old knowledge in a visible way. Exomem
          keeps the old version and marks it as replaced.
        </li>
        <li>
          <strong>Imports:</strong> you can also add your own documents with “Import documents” on{" "}
          {home}.
        </li>
      </ul>
      <p>
        The Exomem service cannot open files on your device or your other connectors, and it does
        not import your past conversations. In Claude Code, the plugin hooks read the current
        session on your device to suggest when to search or save. They keep their state on your
        device.
      </p>
      <p>
        Your app decides when a tool runs. In Claude, for example, you can set each Exomem tool to
        ask you first.
      </p>

      <h2>Your data</h2>
      <ul>
        <li>Each account has its own storage, which no other account can reach.</li>
        <li>
          We encrypt your knowledge base and its backups at rest, and connections to the service in
          transit.
        </li>
        <li>
          Exomem Cloud is not end-to-end encrypted. Our servers see your requests and answers while
          they serve them, and we hold the keys to your storage.
        </li>
        <li>We do not use your content to train AI models.</li>
      </ul>
      <p>
        The <Link href="/exomem/privacy">privacy policy</Link> gives the full details, including who
        processes your data, who can access it, and how long we keep it.
      </p>

      <h2>Disconnect an app</h2>
      <ol>
        <li>On {home}, select “Disconnect” next to the app.</li>
        <li>Select “Disconnect” again to confirm.</li>
      </ol>
      <p>
        The app can no longer reach your Exomem. Removing the connector inside the app alone does
        not end its access.
      </p>

      <h2>Export</h2>
      {exportOffered ? (
        <>
          <ol>
            <li>On {home}, under “Your data”, find “Export everything”.</li>
            <li>Select “Export”.</li>
          </ol>
          <p>
            You get a ZIP file of your Markdown notes and files. Your connected assistants can pause
            for a short time while the export runs.
          </p>
        </>
      ) : (
        <p>
          To get a copy of your data, ask on the <Link href="/exomem/support">support page</Link>.
        </p>
      )}

      <h2>Delete your Exomem</h2>
      <ol>
        <li>On {home}, under “Your data”, select “Delete Exomem”, then “Delete…”.</li>
        <li>Select “Email me a confirmation link”.</li>
        <li>Open the link in the email, and select “Permanently delete my Exomem”.</li>
      </ol>
      <p>
        We delete your knowledge base, its storage and its keys. The privacy policy says what we
        keep for legal duties, and for how long.
      </p>

      <h2>Help</h2>
      <p>
        For setup, account or privacy questions, use the{" "}
        <Link href="/exomem/support">support page</Link>.
      </p>
    </ExomemPublicPage>
  );
}
