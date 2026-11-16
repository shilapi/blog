import assert from "node:assert/strict";
import { test } from "node:test";
import { signWebhookPayload } from "@notionhq/client";
import worker from "../workers/notion-webhook/index.ts";

const env = {
  NOTION_VERIFICATION_TOKEN: "secret_test",
  CLOUDFLARE_DEPLOY_HOOK_URL: "https://example.com/deploy-hook",
};

async function signedRequest(type, body = JSON.stringify({ type })) {
  return new Request("https://example.com/notion", {
    method: "POST",
    body,
    headers: {
      "x-notion-signature": await signWebhookPayload({
        body,
        verificationToken: env.NOTION_VERIFICATION_TOKEN,
      }),
    },
  });
}

test("only signed content events can trigger a build", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (...args) => {
    calls.push(args);
    return Response.json({ success: true });
  });

  for (const type of [
    "page.content_updated",
    "page.properties_updated",
    "page.created",
    "page.deleted",
    "page.undeleted",
    "page.moved",
    "data_source.content_updated",
  ]) {
    const response = await worker.fetch(await signedRequest(type), env);
    assert.equal(response.status, 200);
  }
  assert.equal(calls.length, 7);
  assert.equal(calls[0][0], env.CLOUDFLARE_DEPLOY_HOOK_URL);
  assert.equal(calls[0][1].method, "POST");

  const ignored = await worker.fetch(
    await signedRequest("comment.created"),
    env,
  );
  assert.equal(await ignored.text(), "Event ignored");
  const unsigned = await worker.fetch(
    new Request("https://example.com/notion", {
      method: "POST",
      body: JSON.stringify({ type: "page.content_updated" }),
    }),
    env,
  );
  assert.equal(unsigned.status, 401);
  const tampered = await signedRequest("page.content_updated");
  tampered.headers.set("x-notion-signature", "sha256=" + "0".repeat(64));
  assert.equal((await worker.fetch(tampered, env)).status, 401);
  assert.equal(calls.length, 7);
});

test("verifies the exact raw body, including whitespace", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ success: true }),
  );
  const request = await signedRequest(
    null,
    '{ "type": "page.content_updated" }',
  );
  assert.equal((await worker.fetch(request, env)).status, 200);
});

test("failed deploy hooks return errors so Notion can retry", async (t) => {
  const stub = t.mock.method(globalThis, "fetch");
  for (const response of [
    Response.json({ success: false }),
    Response.json({ success: true }, { status: 503 }),
    new Response("not JSON"),
  ]) {
    stub.mock.mockImplementation(async () => response);
    assert.equal(
      (await worker.fetch(await signedRequest("page.deleted"), env)).status,
      502,
    );
  }
  stub.mock.mockImplementation(async () => {
    throw new Error("network error");
  });
  assert.equal(
    (await worker.fetch(await signedRequest("page.deleted"), env)).status,
    502,
  );
});

test("bootstrap accepts verification only and stops logging after setup", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const network = t.mock.method(globalThis, "fetch", () => {
    throw new Error("must not trigger a build");
  });
  const verification = () =>
    new Request("https://example.com/notion", {
      method: "POST",
      body: JSON.stringify({ verification_token: "secret_bootstrap" }),
    });
  assert.equal((await worker.fetch(verification(), {})).status, 200);
  assert.equal(logs.mock.callCount(), 1);
  assert.equal((await worker.fetch(verification(), env)).status, 401);
  assert.equal(logs.mock.callCount(), 1);
  assert.equal(
    (await worker.fetch(await signedRequest("page.created"), {})).status,
    503,
  );
  assert.equal(
    (
      await worker.fetch(await signedRequest("page.created"), {
        NOTION_VERIFICATION_TOKEN: env.NOTION_VERIFICATION_TOKEN,
      })
    ).status,
    503,
  );
  assert.equal(network.mock.callCount(), 0);
});

test("rejects wrong routes, methods, and malformed payloads", async () => {
  assert.equal(
    (await worker.fetch(new Request("https://example.com/"), env)).status,
    404,
  );
  assert.equal(
    (await worker.fetch(new Request("https://example.com/notion"), env)).status,
    405,
  );
  for (const body of ["{", "null", "[]", '"text"']) {
    const response = await worker.fetch(
      new Request("https://example.com/notion", {
        method: "POST",
        body,
      }),
      env,
    );
    assert.equal(response.status, 400);
  }
});
