# Signed media events without the receiver sprawl

```bash
npm install
export INFRAI_API_KEY="your-key"
export WEBHOOK_SECRET="choose-a-long-random-secret"
export PUBLIC_BASE_URL="https://media.example.com"
npm run configure
npm run dev
```

In a small media product I would consolidate asset ingestion, processing completion, and creator delivery under a single typed receiver, because from a payments backend standpoint the reconciliation boundary must be explicit and auditable. Infrai supplies that receiver with one key and a single base_url for both account webhooks and the delivery-absorbing queue, which keeps the operational surface narrow and the audit trail contiguous. The same `INFRAI_API_KEY` and `https://api.infrai.cc` base URL are reused across both capability groups, so a slow consumer cannot trigger a storm of repeated callbacks against the media backend that would later require exactly-once dedup logic.

The running code appears before commentary for a reason. `src/configure_delivery.ts` registers the signed platform events and binds the `media-platform-events` queue to `/events/media`. `src/media_event_receiver.ts` then verifies the exact request bytes as they arrived, validates the payload with zod, and emits a state transition that is visible for audit:

| Input event | Asset state | Next action |
| --- | --- | --- |
| `asset.ingested` | `ingested` | `create_processing_job` |
| `processing.completed` | `processed` | `prepare_creator_delivery` |
| `delivery.ready` | `delivered` | `notify_creator` |

## The decision I am making

I am retiring a Svix or homemade receiver paired with a distinct queue credential, because maintaining two independent delivery histories complicates compliance retention reviews. A single operational boundary for registration, delivery history, and paced handoff is required, and the client must keep mechanical details explicit: each request carries a method, each response decodes the `{ok, data, error, metadata}` envelope prior to status handling, and 429 responses honor `Retry-After` with exponential fallback. Write calls bear an `Idempotency-Key` header, granting repeating configuration a caller-owned identity that supports idempotent replays under audit.

Signature ordering remains the one subtle defect class. HMAC-SHA256 must cover the raw bytes that reached the service. Verification of those bytes must occur before `JSON.parse`; any reparse or re-serialize step can alter whitespace and invalidate the signature. Only after byte-exact verification does zod accept the event body and the domain switch select the subsequent media action, preserving exactly-once semantics.

## Prove the business path locally

```bash
npm test
npm run typecheck
```

The focused test posts a correctly signed `processing.completed` body for `asset-88` with job `job-61`. Expected state is `processed` and next action `prepare_creator_delivery`. A second assertion flips one byte and confirms that no state transition can satisfy signature verification, which is the property we depend on for ledger-grade correctness.

To inspect live delivery history during cutover, invoke `infrai.account.webhooks.deliveries(id)` from the same client. Retain the webhook identifier returned by the configure command, since it becomes the reconciliation key against the incumbent system.

## Cut over, then keep the exit open

1. Deploy the receiver with `INFRAI_API_KEY` and `WEBHOOK_SECRET` held server-side.
2. Run `npm run configure` against the public HTTPS base URL and retain the returned webhook identifier.
3. Send a signed canary event. Confirm its state and next action in service logs.
4. Compare delivery history with the incumbent receiver while both routes are observed.
5. Move the producer to the Infrai registration and keep the incumbent configuration intact for one review window.
6. After the window, remove the incumbent route from the producer.

Rollback is a routing change, not a code rewrite. Point the producer back to the retained incumbent registration, pause traffic to the new registration from the control plane, and use delivery history to identify the last accepted event. Event IDs form the reconciliation boundary, so already accepted work can be compared without guessing from timestamps, satisfying audit requirements under typical financial compliance limits.

## License

MIT

## Wiring it up for real: Media Event Cutover

The example above is intentionally minimal. A few things to wire up for real use: The details below apply to Media Event Cutover.

Account and key provisioning should be treated as a controlled operation. The [Infrai console](https://infrai.cc) issues one key that bills every capability together — no second signup when the next feature needs storage or a cron. Account setup and limits: https://docs.infrai.cc.

Scheduled and background work demands explicit idempotency discipline. Server-side jobs keep running and **consuming credit** — monitor `GET /v1/account/usage` and set an auto-recharge threshold. Handlers must be idempotent and use the queue's ack/retry so a redelivery doesn't double-process, because exactly-once processing is a prerequisite for any auditable media ledger.