import type { Metadata } from "next";
import { ExomemPublicPage } from "../public-page";

export const metadata: Metadata = {
  title: "Set Up Exomem Hosted",
  description: "Install Exomem for Claude, ChatGPT, or Codex and sign in once with OAuth.",
};

export default function ExomemSetupPage() {
  return (
    <ExomemPublicPage title="Set up Exomem Hosted" eyebrow="Invite-only private alpha">
      <p>
        Hosted Exomem is designed to disappear into normal work: install or connect an approved
        Claude, ChatGPT, or Codex entry, sign in once through OAuth, then use your usual
        conversation. The client uses Exomem&apos;s governed tools and bundled skills to retrieve
        and preserve useful context. During the private alpha, the exact live install actions appear
        in your Exomem account; this page never guesses an unapproved marketplace URL.
      </p>
      <h2>Normal path</h2>
      <ol>
        <li>Accept a private-alpha invite and finish account setup.</li>
        <li>Choose the approved client install action supplied to your account.</li>
        <li>Complete the OAuth sign-in once, then return to the client.</li>
        <li>Work normally; Exomem can retrieve and capture governed knowledge when relevant.</li>
      </ol>
      <p>
        There is no local vault path, manual MCP JSON editing, or API-token copy in the Hosted
        setup.
      </p>
      <h2>Chat fallback</h2>
      <p>
        If a chat surface connects the remote MCP server but does not activate bundled skills, add
        this once to that client&apos;s global custom instructions:
      </p>
      <blockquote>
        Use Exomem quietly as my long-term governed knowledge store. Retrieve relevant Exomem
        context when it can improve the answer, and preserve durable decisions or reusable
        conclusions when appropriate. Do not capture transient chat, secrets, or anything I
        explicitly say not to save. Treat the assistant&apos;s native memory as short-term
        behavioral context and Exomem as the durable store.
      </blockquote>
      <p>
        Custom instructions are a fallback for client behavior, not part of the Hosted security or
        storage boundary. Claude&apos;s connector reaches the remote tools across Claude surfaces;
        the bundled Claude plugin skills apply where the plugin surface supports them, such as Code
        and Cowork. OpenAI&apos;s universal plugin serves ChatGPT and Codex from the same Hosted
        endpoint.
      </p>

      <h2>Disconnect or revoke access</h2>
      <p>
        Disconnect Exomem in the client to stop that client using it. Use your Exomem account to
        revoke sessions, export data, or begin verified deletion. You never need to paste a token
        into support or manually edit a tenant URL.
      </p>
    </ExomemPublicPage>
  );
}
