import assert from "node:assert/strict";
import test from "node:test";
import { decideMediaTransition, mediaEventSchema, signBody, verifySignature } from "../src/media_event_receiver.js";

test("a signed completed job advances its asset to creator delivery", () => {
  const rawBody = Buffer.from(JSON.stringify({
    event_id: "evt-204",
    event_type: "processing.completed",
    data: {
      asset_id: "asset-88",
      job_id: "job-61",
      renditions: ["720p", "1080p"],
    },
  }));
  const secret = "focused-test-secret";
  const signature = `sha256=${signBody(rawBody, secret)}`;

  assert.equal(verifySignature(rawBody, signature, secret), true);
  const event = mediaEventSchema.parse(JSON.parse(rawBody.toString("utf8")));
  assert.deepEqual(decideMediaTransition(event), {
    eventId: "evt-204",
    assetId: "asset-88",
    state: "processed",
    next: "prepare_creator_delivery",
  });
});

test("changing signed bytes rejects the event before its transition", () => {
  const original = Buffer.from('{"event_id":"evt-204"}');
  const changed = Buffer.from('{ "event_id":"evt-204"}');
  assert.equal(verifySignature(changed, signBody(original, "secret"), "secret"), false);
});
