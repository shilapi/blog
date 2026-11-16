import { verifyWebhookSignature } from "@notionhq/client";

interface Env {
  NOTION_VERIFICATION_TOKEN?: string;
  CLOUDFLARE_DEPLOY_HOOK_URL?: string;
}

// Use a dedicated Notion connection shared only with the blog's content.
const buildEvents = new Set([
  "page.created",
  "page.content_updated",
  "page.properties_updated",
  "page.deleted",
  "page.undeleted",
  "page.moved",
  "data_source.content_updated",
  "data_source.schema_updated",
  "data_source.deleted",
  "data_source.undeleted",
  "data_source.moved",
]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/notion") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    const body = await request.text();
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return new Response("Invalid payload", { status: 400 });
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // Bootstrap only: retrieve this token with `wrangler tail`, then save it
    // as a secret before verifying the subscription in Notion's dashboard.
    if (!env.NOTION_VERIFICATION_TOKEN) {
      if (
        typeof payload.verification_token === "string" &&
        payload.verification_token.startsWith("secret_") &&
        payload.verification_token.length <= 256
      ) {
        console.log(
          "Notion subscription verification:",
          payload.verification_token,
        );
        return new Response("Verification received");
      }
      return new Response("Webhook not configured", { status: 503 });
    }

    const trusted = await verifyWebhookSignature({
      body,
      signature: request.headers.get("x-notion-signature"),
      verificationToken: env.NOTION_VERIFICATION_TOKEN,
    });
    if (!trusted) return new Response("Invalid signature", { status: 401 });

    if (typeof payload.type !== "string" || !buildEvents.has(payload.type)) {
      return new Response("Event ignored");
    }
    if (!env.CLOUDFLARE_DEPLOY_HOOK_URL) {
      return new Response("Deploy hook not configured", { status: 503 });
    }

    try {
      const result = await fetch(env.CLOUDFLARE_DEPLOY_HOOK_URL, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await result.json()) as { success?: boolean };
      if (!result.ok || data.success !== true) {
        console.error(
          "Cloudflare deploy hook rejected the build",
          result.status,
        );
        return new Response("Build trigger failed", { status: 502 });
      }
    } catch {
      // Do not log the exception: it may include the secret deploy hook URL.
      return new Response("Build trigger unavailable", { status: 502 });
    }

    // Await the hook before acknowledging so Notion retries failed requests.
    return new Response("Build triggered");
  },
};
