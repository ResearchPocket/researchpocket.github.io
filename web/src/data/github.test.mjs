import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { GitHubClient } from "./github.ts";

test("the browser GitHub adapter keeps credentials in headers and exact bytes in immutable writes", async () => {
  const token = "github-test-credential";
  const envelope = "{\"exact\":true}";
  const blobSha = gitBlobSha(envelope);
  const requests = [];
  let blobAttempts = 0;
  const fetcher = async (input, init) => {
    const url = input instanceof URL ? input : new URL(input.toString());
    requests.push({ url, init });

    if (url.pathname === "/repos/owner/private-library") {
      return Response.json({
        private: true,
        archived: false,
        disabled: false,
        default_branch: "main",
        size: 1,
        permissions: { push: true },
      });
    }
    if (url.pathname.endsWith("/git/trees/main")) {
      return Response.json({
        sha: "b".repeat(40),
        truncated: false,
        tree: [
          {
            path: "sync/v1/ops/00000000-0000-7000-8000-000000000002/00000000000000000001.json",
            mode: "100644",
            type: "blob",
            sha: blobSha,
          },
        ],
      });
    }
    if (url.pathname.endsWith(`/git/blobs/${blobSha}`)) {
      blobAttempts += 1;
      const response = new Response(envelope, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
      if (blobAttempts === 1) {
        Object.defineProperty(response, "arrayBuffer", {
          value: async () => {
            throw new TypeError("transient mobile body read failure");
          },
        });
      }
      return response;
    }
    if (init?.method === "PUT") return new Response(null, { status: 409 });
    throw new Error(`Unexpected request ${url}`);
  };

  const client = new GitHubClient(token, fetcher);
  const remote = { owner: "owner", repository: "private-library", branch: "main" };
  assert.deepEqual(await client.inspectRepository(remote.owner, remote.repository), {
    defaultBranch: "main",
    empty: false,
  });
  const tree = await client.discover(remote);
  assert.equal(tree.blobs.size, 1);
  assert.equal(await client.downloadText(remote, blobSha), envelope);
  assert.equal(blobAttempts, 2);
  assert.deepEqual(
    await client.putNew(remote, [...tree.blobs.keys()][0], envelope, remote.branch),
    { type: "race" },
  );

  for (const { url, init } of requests) {
    assert.equal(url.href.includes(token), false);
    assert.equal(JSON.stringify(init?.body ?? "").includes(token), false);
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token}`);
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
  }
  const write = requests.find(({ init }) => init?.method === "PUT");
  assert.ok(write);
  const blobReads = requests.filter(({ url }) => url.pathname.endsWith(`/git/blobs/${blobSha}`));
  assert.equal(blobReads.length, 2);
  for (const { init } of blobReads) {
    assert.equal(
      new Headers(init?.headers).get("Accept"),
      "application/vnd.github.raw+json",
    );
  }
  const body = JSON.parse(write.init.body);
  assert.equal(Buffer.from(body.content, "base64").toString(), envelope);
  assert.equal("sha" in body, false);
});

test("the browser GitHub adapter rejects raw bytes with the wrong Git identity", async () => {
  const expected = "original";
  const blobSha = gitBlobSha(expected);
  const client = new GitHubClient("github-test-credential", async () => {
    return new Response("tampered", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  });

  await assert.rejects(
    () =>
      client.downloadText(
        { owner: "owner", repository: "private-library", branch: "main" },
        blobSha,
      ),
    (error) => {
      assert.equal(error?.name, "GitHubSyncError");
      assert.equal(error?.kind, "integrity");
      return true;
    },
  );
});

function gitBlobSha(text) {
  const bytes = Buffer.from(text);
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}
