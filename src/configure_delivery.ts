import { randomUUID } from "node:crypto";
import { InfraiClient } from "./infrai_client.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before configuring delivery`);
  return value;
}

const apiKey = required("INFRAI_API_KEY");
const secret = required("WEBHOOK_SECRET");
const receiverUrl = new URL("/events/media", required("PUBLIC_BASE_URL")).toString();
const queue = process.env.MEDIA_EVENT_QUEUE ?? "media-platform-events";
const runId = randomUUID();
const infrai = new InfraiClient(apiKey);

const webhook = await infrai.account.webhooks.register(
  {
    url: receiverUrl,
    events: ["account.created"],
    description: "Media asset lifecycle receiver",
    secret,
  },
  `media-webhook-${runId}`,
);

const subscription = await infrai.queue.push_subscribe(
  queue,
  { url: receiverUrl },
  `media-queue-${runId}`,
);

console.log(JSON.stringify({ webhook, queue, subscription }, null, 2));
