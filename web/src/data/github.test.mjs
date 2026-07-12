import assert from "node:assert/strict";
import { test } from "node:test";

import { GitHubClient } from "./github.ts";

test("the browser GitHub adapter keeps credentials in headers and exact bytes in immutable writes", async () => {
  const token = "github-test-credential";
  const blobSha = "a".repeat(40);
  const envelope = "{\"exact\":true}";
  const requests = [];
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
      return Response.json({
        content: Buffer.from(envelope).toString("base64"),
        encoding: "base64",
        sha: blobSha,
        size: Buffer.byteLength(envelope),
      });
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
  const body = JSON.parse(write.init.body);
  assert.equal(Buffer.from(body.content, "base64").toString(), envelope);
  assert.equal("sha" in body, false);
});
