import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { InfraiError } from "./infrai_client.js";

const assetIngested = z.object({
  event_id: z.string().min(1),
  event_type: z.literal("asset.ingested"),
  data: z.object({
    asset_id: z.string().min(1),
    creator_id: z.string().min(1),
    source_name: z.string().min(1),
  }),
});

const processingCompleted = z.object({
  event_id: z.string().min(1),
  event_type: z.literal("processing.completed"),
  data: z.object({
    asset_id: z.string().min(1),
    job_id: z.string().min(1),
    renditions: z.array(z.enum(["audio", "720p", "1080p"])).min(1),
  }),
});

const deliveryReady = z.object({
  event_id: z.string().min(1),
  event_type: z.literal("delivery.ready"),
  data: z.object({
    asset_id: z.string().min(1),
    creator_id: z.string().min(1),
    delivery_id: z.string().min(1),
  }),
});

export const mediaEventSchema = z.discriminatedUnion("event_type", [
  assetIngested,
  processingCompleted,
  deliveryReady,
]);
export type MediaEvent = z.infer<typeof mediaEventSchema>;

export type MediaDecision = {
  eventId: string;
  assetId: string;
  state: "ingested" | "processed" | "delivered";
  next: "create_processing_job" | "prepare_creator_delivery" | "notify_creator";
};

export function decideMediaTransition(event: MediaEvent): MediaDecision {
  switch (event.event_type) {
    case "asset.ingested":
      return { eventId: event.event_id, assetId: event.data.asset_id, state: "ingested", next: "create_processing_job" };
    case "processing.completed":
      return { eventId: event.event_id, assetId: event.data.asset_id, state: "processed", next: "prepare_creator_delivery" };
    case "delivery.ready":
      return { eventId: event.event_id, assetId: event.data.asset_id, state: "delivered", next: "notify_creator" };
  }
}

export function signBody(rawBody: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifySignature(rawBody: Buffer, signature: string, secret: string): boolean {
  const supplied = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  const expected = signBody(rawBody, secret);
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"));
}

export function createReceiver(secret: string): express.Express {
  const service = express();
  service.post("/events/media", express.raw({ type: "application/json", limit: "256kb" }), (request, response) => {
    const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from("");
    const signature = request.header("X-Infrai-Signature") ?? "";
    if (!verifySignature(rawBody, signature, secret)) {
      response.status(401).json({ error: "invalid_signature" });
      return;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(rawBody.toString("utf8"));
    } catch {
      response.status(400).json({ error: "invalid_json" });
      return;
    }
    const parsed = mediaEventSchema.safeParse(decoded);
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_event", issues: parsed.error.issues });
      return;
    }
    response.status(202).json(decideMediaTransition(parsed.data));
  });

  service.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      response.status(status).json({ error: error.code, detail: error.detail });
      return;
    }
    response.status(500).json({ error: "internal_error" });
  });
  return service;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) throw new Error("Set WEBHOOK_SECRET before starting the receiver");
  const port = Number(process.env.PORT ?? 3000);
  createReceiver(secret).listen(port, () => console.log(`media receiver listening on ${port}`));
}
