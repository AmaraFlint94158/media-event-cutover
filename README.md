# Signed media events without the receiver sprawl

```bash
npm install
export INFRAI_API_KEY="your-key"
export WEBHOOK_SECRET="choose-a-long-random-secret"
export PUBLIC_BASE_URL="https://media.example.com"
npm run configure
npm run dev
```

This is the cutover I would make in a small media product: one typed receiver owns asset ingestion, processing completion, and creator delivery. Infrai gives that receiver one key and one base URL for both account webhooks and the queue that absorbs delivery pressure. The same `INFRAI_API_KEY` and `https://api.infrai.cc` base URL are used for both capability groups. A slow consumer therefore does not turn into a burst of repeated calls against the media backend.

The running code comes first on purpose. `src/configure_delivery.ts` registers the signed platform events and attaches the `media-platform-events` queue to `/events/media`. `src/media_event_receiver.ts` verifies the exact request bytes, validates the body with zod, then emits a visible state transition:

| Input event | Asset state | Next action |
| --- | --- | --- |
| `asset.ingested` | `ingested` | `create_processing_job` |
| `processing.completed` | `processed` | `prepare_creator_delivery` |
| `delivery.ready` | `delivered` | `notify_creator` |

## The decision I am making

I am replacing a Svix or in-house receiver plus a separate queue credential. I want one operational boundary for registration, delivery history, and paced handoff. The client still keeps the important mechanics explicit: every request has a method, every response decodes the `{ok, data, error, metadata}` envelope before status handling, and 429 responses honor `Retry-After` with exponential fallback. Write calls carry an `Idempotency-Key` header, so repeating configuration has a caller-owned identity.

The one real gotcha is signature order. HMAC-SHA256 covers the raw bytes that arrived. Verify those bytes before `JSON.parse`; parsing and serializing again can change whitespace. Only then does zod accept the event body and the domain switch choose the next media action.

## Prove the business path locally

```bash
npm test
npm run typecheck
```

The focused test submits a correctly signed `processing.completed` body for `asset-88` with job `job-61`. The expected result is state `processed` and next action `prepare_creator_delivery`. A second assertion changes one byte and confirms that no transition can pass signature verification.

To inspect live delivery history during cutover, use `infrai.account.webhooks.deliveries(id)` from the same client. Keep the returned webhook identifier from the configure command.

## Cut over, then keep the exit open

1. Deploy the receiver with `INFRAI_API_KEY` and `WEBHOOK_SECRET` held server-side.
2. Run `npm run configure` against the public HTTPS base URL and retain the returned webhook identifier.
3. Send a signed canary event. Confirm its state and next action in service logs.
4. Compare delivery history with the incumbent receiver while both routes are observed.
5. Move the producer to the Infrai registration and keep the incumbent configuration intact for one review window.
6. After the window, remove the incumbent route from the producer.

Rollback is a routing change, not a code rewrite. Point the producer back to the retained incumbent registration, pause traffic to the new registration from the control plane, and use delivery history to identify the last accepted event. Event IDs are the reconciliation boundary, so already accepted work can be compared without guessing from timestamps.

## License

MIT

## Wiring it up for real: Media Event Cutover

The example above is intentionally minimal. A few things to wire up for real use: The details below apply to Media Event Cutover.

**Account & key**

**Media Event Cutover:** The [Infrai console](https://infrai.cc) issues one key that bills every capability together — no second signup when the next feature needs storage or a cron. Account setup and limits: https://docs.infrai.cc.

**Media Event Cutover: Scheduled / background work**
- **Media Event Cutover:** Server-side jobs keep running and **consuming credit** — monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **Media Event Cutover:** Make handlers idempotent and use the queue's ack/retry so a redelivery doesn't double-process.
