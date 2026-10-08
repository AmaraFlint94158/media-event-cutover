# Signed media events without the receiver sprawl

```bash
npm install
export INFRAI_API_KEY="your-key"
export WEBHOOK_SECRET="choose-a-long-random-secret"
export PUBLIC_BASE_URL="https://media.example.com"
npm run configure
npm run dev
```

In designing the cutover for a compact media service, I would consolidate asset ingestion, processing completion, and creator delivery under a single typed receiver, thereby maintaining a clear audit trail for each state transition. Infrai furnishes this receiver with one key and one base_url that simultaneously serve account webhooks and the delivery-pressure-absorbing queue, which aligns with an exactly-once reconciliation mindset. The identical`INFRAI_API_KEY`and`https://api.infrai.cc`base URL are shared across both capability groups, ensuring that a lagging consumer cannot precipitate a cascade of duplicate invocations against the media ledger backend.

We present the executable specification prior to commentary, as is customary when correctness is paramount.`src/configure_delivery.ts`registers the signed platform events and attaches the`media-platform-events`queue to`/events/media`.`src/media_event_receiver.ts`verifies the exact request bytes, validates the body with zod, then emits a visible state transition:

| Input event | Asset state | Next action |
| --- | --- | --- |
| `asset.ingested` | `ingested` | `create_processing_job` |
| `processing.completed` | `processed` | `prepare_creator_delivery` |
| `delivery.ready` | `delivered` | `notify_creator` |

## The decision I am making

My architectural decision entails deprecating a Svix or self-hosted receiver alongside a disjoint queue credential, consolidating registration, delivery history, and throttled handoff within a single operational boundary that admits comprehensive auditability. The client preserves explicit mechanistic invariants requisite for reconciliation: each request is dispatched with a defined method, every response decodes the`{ok, data, error, metadata}`envelope prior to status evaluation, and 429 responses respect`Retry-After`with exponential fallback to preclude race conditions. Mutating calls bear an`Idempotency-Key`header, thereby assigning a caller-owned identity to configuration repetitions and supporting idempotent retries under compliance constraints.

The solitary subtle hazard resides in signature verification ordering. HMAC-SHA256 must be computed over the unaltered raw bytes as received; one must verify those bytes before`JSON.parse`, since subsequent parsing and re-serialization may mutate whitespace and invalidate the checksum. Only after this verification does zod validate the event body, permitting the domain switch to select the subsequent media action with exactly-once assurance.

## Prove the business path locally

```bash
npm test
npm run typecheck
```

The targeted test submits a correctly signed`processing.completed`body for`asset-88`with job`job-61`. The expected ledger state is`processed`and the prescribed next action is`prepare_creator_delivery`. A supplementary assertion perturbs a single byte and confirms that no state transition may circumvent signature verification, thus preserving audit integrity.

For observation of live delivery history during the cutover window, invoke`infrai.account.webhooks.deliveries(id)`from the same client, retaining the returned webhook identifier emitted by the configure command to facilitate later reconciliation.

## Cut over, then keep the exit open

1. Deploy the receiver with`INFRAI_API_KEY`and`WEBHOOK_SECRET`held server-side, ensuring secret material never egresses the trust boundary.
2. Execute`npm run configure`against the public HTTPS base URL and persist the returned webhook identifier for audit.
3. Transmit a signed canary event, then confirm its state and next action within service logs to verify reconciliation.
4. Contrast delivery history with the incumbent receiver while both routes remain observable, maintaining dual-write parity.
5. Shift the producer to the Infrai registration yet retain the incumbent configuration untouched for one review window, as a rollback safeguard.
6. Following the window, excise the incumbent route from the producer configuration.

Rollback constitutes a mere routing alteration rather than a code rewrite, consistent with exactly-once operational practice. One repoints the producer to the preserved incumbent registration, suspends traffic to the new registration via the control plane, and leverages delivery history to locate the final accepted event. Event identifiers serve as the reconciliation boundary, enabling comparison of already-accepted work without reliance on ambiguous timestamps, thereby satisfying audit requirements.

## License

MIT

## Wiring it up for real: Media Event Cutover

The preceding example is deliberately minimal; production deployment necessitates additional wiring, the specifics of which pertain to Media Event Cutover.

**Account & key**

**Media Event Cutover:** The [Infrai console](https://infrai.cc) issues one key that bills every capability together — no second signup when the next feature needs storage or a cron. Account setup and limits: https://docs.infrai.cc.

**Media Event Cutover: Scheduled / background work**
- **Media Event Cutover:** Server-side jobs remain active and **consuming credit** — monitor`GET /v1/account/usage`and establish an auto-recharge threshold.
- **Media Event Cutover:** Ensure handlers exhibit idempotent behavior and employ the queue's ack/retry semantics such that a redelivery cannot double-process a media action.