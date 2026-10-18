import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { EXOMEM_THEME_CHOICES } from "@/lib/exomem/theme";
import { saveExomemTheme } from "@/lib/exomem-hosted/db";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import {
  accessErrorResponse,
  newRequestId,
  readBoundedJsonRequest,
} from "@/lib/exomem-hosted/http";
import { accountThemeSnapshot } from "@/lib/exomem-hosted/theme-snapshot";
import { resolveExomemSession, validateMutationRequest } from "@/lib/exomem-hosted/sessions";
import { EXOMEM_EMAIL_SCHEMES } from "@/lib/email-templates/exomem-email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Preferences = z
  .object({
    themeChoice: z.enum(EXOMEM_THEME_CHOICES),
    emailScheme: z.enum(EXOMEM_EMAIL_SCHEMES),
    // First-login adoption must not overwrite another device's initialized choice.
    initialize: z.literal(true).optional(),
    // A device observation cannot replace a choice saved on another device.
    effectiveOnly: z.literal(true).optional(),
  })
  .strict()
  .refine((value) => !value.initialize || !value.effectiveOnly);

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const session = await resolveExomemSession(request);
    validateMutationRequest(request, session);
    const body = Preferences.safeParse(await readBoundedJsonRequest(request, 512));
    if (!body.success) throw exomemErrors.invalidRequest();
    const choice = body.data.themeChoice;
    const saved = await saveExomemTheme({
      ...body.data,
      tenantId: session.tenantId,
      userId: session.userId,
      emailScheme: choice === "auto" ? body.data.emailScheme : choice,
    });
    if (!saved) throw exomemErrors.sessionInvalid();
    const themeSnapshot = accountThemeSnapshot({ ...session, ...saved });
    // The browser checks the current scope before writing this presentation cookie.
    return NextResponse.json(
      { success: true, ...saved, themeSnapshot, requestId },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return accessErrorResponse({ error, event: "access.request.denied", requestId });
  }
}
