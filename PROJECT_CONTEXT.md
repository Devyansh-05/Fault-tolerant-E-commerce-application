# PROJECT_CONTEXT — Fault-Tolerant E-Commerce Platform with an Idempotent Reliable Event Processing Framework

This file is the single source of truth for the project. Read it before starting any stage, and update it at the end of each one.

## 1. Current status

| Stage | Scope | Status |
|---|---|---|
| 1 | E-commerce foundation and HTTP request idempotency | **Complete** (2026-11-19) |
| **2** | RabbitMQ, transactional outbox, consumers, event idempotency, retry engine, DLQ, event status tracking | **Complete** (2026-11-19). 42/42 automated tests pass against Atlas, Redis and RabbitMQ. A real RabbitMQ `docker stop`/`start` outage was verified live |
| **3** | Fault injection, Admin Testing Panel, Synthetic Event Generator, Reliability Dashboard, DLQ page and replay, end-to-end tests | **Complete** (2026-11-19). 58/58 automated tests pass. Live verification on the dev servers covered 50 events, a temporary fault, a persistent fault plus replay, duplicate delivery, and a real RabbitMQ outage |

## 2. Final architecture (as implemented)

```
 CUSTOMER                                   ADMIN (role ADMIN, JWT)
    │                                          │
    ▼                                          ▼
 React storefront (Vite)              React Admin area
    │                                  ├─ Testing Panel  (/admin/testing)  ── faults · generator · duplicate delivery · reset
    │                                  ├─ Reliability Dashboard (/admin/reliability)  ── polling 2.5 s / 4 s
    │                                  └─ Dead Letter Queue (/admin/dlq)  ── inspect · replay
    ▼  REST (Axios)                            ▼  REST
 ┌──────────────────────── Express API (server.js) ─────────────────────────────────────────┐
 │ Idempotency-Key ─► Redis (HTTP idempotency)     /api/admin/faults ──► Redis  ecom:fault:*  │
 │ Order Service ─► ONE MongoDB txn:               /api/admin/testing/generate-events         │
 │   order + payment op + ORDER_CREATED (outbox)      └─► Synthetic Event Generator ─► outbox  │
 │                                                 /api/events/* (monitoring, DLQ replay)     │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
                       │ MongoDB Atlas: orders, payments, inventory, outbox_events, event_processing, ...
                       ▼
 ┌──────────────────────── Worker (worker.js) ─────────────────────────────────────────────┐
 │ Outbox Publisher ─(confirms)─► RabbitMQ "ecommerce.events" (topic)                       │
 │    ├─► payment   consumer ─► PAYMENT_COMPLETED | PAYMENT_FAILED ──┐                      │
 │    ├─► inventory consumer ─► INVENTORY_RESERVED | INVENTORY_FAILED ┤                     │
 │    │                         order consumer (saga) ◄──────────────┘ ─► ORDER_CONFIRMED|FAILED
 │    └─► email consumer (simulated e-mail)                                                 │
 │ Every consumer runs on the RELIABLE EVENT PROCESSOR:                                     │
 │   validate ─► event idempotency (Redis lease + MongoDB record)                            │
 │   ─► FAULT INJECTOR hook (reads ecom:fault:* — delay / failure / duplicate)               │
 │   ─► handler + COMPLETED in one transaction ─► Retry Engine (TTL delay queues) ─► DLQ     │
 │   ─► Event Status Tracking (event_processing) ─────────────► Reliability Dashboard        │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
 Docker: Redis + RabbitMQ only (RabbitMQ outage demo = real `docker stop ecommerce-rabbitmq`)
```

**What runs where:**
- **Docker:** Redis and RabbitMQ only.
- **Directly on the host:** the API (`npm run dev`), the worker (`npm run worker`) and the frontend (`npm run dev`).
- **Cloud:** MongoDB Atlas.

## 3. Agreed design decisions

1. **Event flow (changed in Stage 2).** The Stage 2 prompt explicitly asked for the Payment **and** Inventory consumers to both listen to `ORDER_CREATED`, with no assumption about which finishes first, and for compensation when one step fails. That replaces the earlier default of a sequential chain.
   - Implementation: **parallel choreography**, plus an **order consumer** (the Order Service saga coordinator) that combines the two results.
   - This is a fourth logical consumer, but it belongs to the Order Service, not to a new service.
2. **Stock:** checked at checkout (`assertAvailable`, no deduction), then **reserved** by the Inventory Consumer with conditional updates. The reservation is committed when the order is confirmed and released if the order fails.
3. **DLQ:** messages are kept in a RabbitMQ DLQ **and** in MongoDB (`event_processing` with status DLQ and the full event). Stage 3 adds a "Replay from DLQ" admin action.
4. **RabbitMQ outage demo:** a real `docker stop ecommerce-rabbitmq`, verified on 2026-11-19.
5. **Email:** simulated, stored in the `notifications` collection.
6. **Products:** seed script plus admin CRUD. The admin account comes from `.env`.
7. **Payment decline:** the simulated gateway declines totals above `SIMULATED_PAYMENT_DECLINE_ABOVE` (default ₹5,00,000), which gives a deterministic `PAYMENT_FAILED` path.

## 4. Technology stack (as installed)

**Backend:**
- Node.js ≥ 20 (developed on 26.13.1), ES modules
- Express 5.3, Mongoose 8.24, redis (node-redis) 4.7, **amqplib 0.10.9**
- jsonwebtoken 9, bcryptjs, zod 3, helmet, cors, express-rate-limit, dotenv 16
- Tests: `node:test` + supertest

**Frontend:** React 18.3, react-router-dom 6.30, axios, Vite 6.4.

**Infrastructure:**
- MongoDB Atlas (replica set, so transactions are available)
- Redis 7.4-alpine
- **RabbitMQ 4.1-management-alpine**

## 5. Folder structure

```
.
├── docker-compose.yml                 # redis + rabbitmq (management UI on :15672)
├── PROJECT_CONTEXT.md, README.md, docs/API.md, docs/postman_collection.json
├── backend/
│   ├── server.js                      # API process (Mongo, Redis, RabbitMQ for health/monitoring)
│   ├── worker.js                      # worker process: `node worker.js [publisher|payment|inventory|order|email ...]`
│   ├── app.js
│   ├── config/        env.js · database.js (runInTransaction) · redis.js · rabbitmq.js (connection, confirms, reconnect)
│   ├── events/        eventTypes.js (types + routing keys) · eventSchema.js (zod) · eventFactory.js (envelope, deterministic child IDs)
│   ├── outbox/        outboxService.js (addToOutbox in a session) · outboxPublisher.js (claim -> publish -> confirm -> mark)
│   ├── messaging/     topology.js (exchanges/queues/bindings) · broker.js (initBroker) · worker.js (startWorker)
│   ├── reliable-event-processor/
│   │   ├── eventProcessor.js          # the common pipeline used by every consumer
│   │   ├── eventIdempotency.js        # Redis lease / COMPLETED marker
│   │   ├── eventStatus.js             # MongoDB status transitions + history
│   │   ├── retryEngine.js             # back-off policy + delay-queue scheduling
│   │   ├── deadLetterHandler.js       # confirmed transfer to DLQ
│   │   ├── errors.js                  # TransientError / PermanentError / timeout classification
│   │   └── hooks.js                   # before-handle hook (Stage 3 fault injection, tests)
│   ├── fault-injection/  faultDefinitions.js (allowlist) · faultStore.js (Redis, Lua trigger) · faultInjector.js (processor hooks)   [Stage 3]
│   ├── consumers/     consumerRuntime.js · paymentConsumer · inventoryConsumer · orderConsumer · emailConsumer · index.js
│   ├── models/        User, Product, Inventory, Cart, Order, Payment, OutboxEvent, EventProcessing, Notification, InventoryReservation
│   ├── services/      order · orderSaga · payment · inventory · notification · eventMonitoring · idempotency · cart · product · auth · token · admin
│   │                  + faultInjection · eventGenerator · eventOperations (redeliver, DLQ replay)   [Stage 3]
│   ├── middleware/    + testingGuard.js (403 when testing tools are disabled / production)   [Stage 3]
│   ├── routes/        + testing.routes.js (/api/admin/faults, /api/admin/testing)   [Stage 3]
│   ├── controllers/   + event.controller.js
│   ├── routes/        + event.routes.js (/api/events, ADMIN)
│   ├── validators/    + event.validators.js
│   ├── middleware/, utils/, scripts/ (seed)
│   └── tests/         fingerprint · idempotency.service · api.integration · events.integration · helpers/
└── frontend/src/
    ├── pages/admin/   AdminTestingPage · ReliabilityDashboardPage · DeadLetterQueuePage (+ Stage 1 AdminDashboard, AdminProducts)
    ├── components/admin/  FaultConfiguration · ActiveFaults · EventGenerator · DuplicateDelivery · MetricCard · PollStatus
    │                      · ConsumerStats · EventTable · EventDetails
    ├── services/      + monitoringService.js · testingService.js
    └── hooks/         + usePolling.js · useDlqReplay.js
```

## 6. API endpoints

The full reference is in `docs/API.md`.

| Method | Path | Auth |
|---|---|---|
| GET | `/api/health` (mongodb, redis, **rabbitmq**) | public |
| POST | `/api/auth/register`, `/api/auth/login` · GET `/api/auth/me` | public / user |
| GET | `/api/products`, `/categories`, `/:id` · POST/PUT/DELETE (admin) | public / ADMIN |
| * | `/api/cart/*` | user |
| POST | `/api/orders` (Idempotency-Key). **Returns the order PENDING**; it is finalised asynchronously | user |
| GET | `/api/orders`, `/api/orders/:id` | user |
| GET | `/api/admin/overview` | ADMIN |
| GET | **`/api/events`** (filters: status, consumer, eventType, correlationId, q, page, limit) | ADMIN |
| GET | **`/api/events/stats`**, **`/api/events/consumer-stats`**, **`/api/events/dlq`**, **`/api/events/outbox`**, **`/api/events/config`**, **`/api/events/:eventId`**. Stage 3 adds the filters `scope=all\|test\|real`, `batchId`, `from`, `to` | ADMIN |
| POST | **`/api/events/dlq/:eventId/replay`** `{consumer}` (Stage 3) | ADMIN |
| GET / POST | **`/api/admin/faults`**, **`/api/admin/faults/enable`**, **`/api/admin/faults/disable`** (Stage 3) | ADMIN, dev/test only |
| POST | **`/api/admin/testing/generate-events`**, **`/duplicate-delivery`**, **`/reset-test-data`** (Stage 3) | ADMIN, dev/test only |

## 7. MongoDB collections

| Collection | Purpose | Key constraints |
|---|---|---|
| `users`, `products`, `carts` | Stage 1 (unchanged) | unique email / slug / userId |
| `inventory` | `availableQuantity`, `reservedQuantity` (now used) | unique productId |
| `orders` | Stage 1 fields plus `fulfillment.{payment,inventory}.{status,reason,eventId,updatedAt}`, `failureReason`, `compensation.{paymentRefunded,stockReleased}`. `orderStatus` is one of `PENDING, PROCESSING, CONFIRMED, PAYMENT_FAILED, INVENTORY_FAILED, CANCELLED, FAILED` | unique (userId, idempotencyKey) |
| `payments` | Created **PENDING** at checkout; the payment consumer sets SUCCEEDED or FAILED; compensation sets REFUNDED. Also `processedByEventId`, `refundReference` | unique orderId, unique paymentReference `PAY-<orderId>` |
| **`outbox_events`** | eventId, eventType, eventVersion, routingKey, aggregateType/Id, correlationId, causationId, payload, eventCreatedAt, **status `PENDING\|PUBLISHING\|PUBLISHED`**, publishAttempts, publishCount, lastError, nextAttemptAt, claimedBy, claimedAt, publishedAt, source | **unique eventId**; (status, nextAttemptAt), (status, claimedAt), correlationId |
| **`event_processing`** | One document per **(eventId, consumerName)**: eventType, aggregateId, correlationId, causationId, status, attempts, retryCount, maxAttempts, deliveries, duplicateCount, deferredCount, lastError, failureType, processingMs, firstReceivedAt, lastAttemptAt, nextRetryAt, completedAt, dlqAt, **event** (the full original), **history[]** (last 50 entries) | **unique (eventId, consumerName)**; status, consumer+status, eventType, correlationId, updatedAt |
| **`inventory_reservations`** | Per order: items, status `RESERVED\|COMMITTED\|RELEASED\|FAILED`, eventId | **unique orderId** |
| **`notifications`** | Simulated e-mails: eventId, orderId, template, to, subject, body, status, providerMessageId | **unique eventId** |

## 8. Redis key conventions

The prefix is `REDIS_KEY_PREFIX` (default `ecom`); tests use `ecomtest`.

| Key | Value | TTL |
|---|---|---|
| `ecom:idem:http:orders.create:<userId>:<key>` | HTTP idempotency (Stage 1): PROCESSING, COMPLETED or FAILED, plus fingerprint and response | 60 s lock / 24 h |
| `ecom:idem:event:<consumer>:<eventId>` | **Event idempotency:** `{status: PROCESSING, owner}` lease, or `{status: COMPLETED}` | lease `EVENT_LEASE_MS` (20 s) / 7 days |
| `ecom:fault:<consumer>:<FAULT_TYPE>` | **Fault configuration (Stage 3):** `{faultType, targetConsumer, enabled, failureRate, failureCount, remaining, delayMs, copies, applyTo, matchedAttempts, injectedCount, createdAt, updatedAt, lastInjectedAt, enabledBy}` | none. The record persists, and disabling only sets `enabled = false` |

## 9. RabbitMQ topology

The exchange is `RABBITMQ_EXCHANGE` (default `ecommerce.events`) and the prefix is `RABBITMQ_QUEUE_PREFIX` (default `ecommerce`). Tests use `ecommerce_test.*`, so a running dev worker never consumes test messages.

**Exchanges**

| Exchange | Type | Purpose |
|---|---|---|
| `ecommerce.events` | topic, durable | All business events. Routing key = event type |
| `ecommerce.events.dlx` | direct, durable | Dead-letter exchange. Routing key = consumer name |

**Queues** (all durable)

| Consumer | Main queue (bindings) | Retry queues | DLQ |
|---|---|---|---|
| payment | `ecommerce.payment.queue` ← `order.created` | `ecommerce.payment.retry.{1000,2000,4000}ms` | `ecommerce.payment.dlq` |
| inventory | `ecommerce.inventory.queue` ← `order.created` | `…inventory.retry.*` | `ecommerce.inventory.dlq` |
| order | `ecommerce.order.queue` ← `payment.completed`, `payment.failed`, `inventory.reserved`, `inventory.failed` | `…order.retry.*` | `ecommerce.order.dlq` |
| email | `ecommerce.email.queue` ← `order.confirmed`, `order.failed`, `email.notification.requested` | `…email.retry.*` | `ecommerce.email.dlq` |

**Queue arguments**
- Main queues: `x-dead-letter-exchange = ecommerce.events.dlx`, `x-dead-letter-routing-key = <consumer>`. This is the native fallback for nacked messages.
- Retry queues: `x-message-ttl = <delay>`, `x-dead-letter-exchange = ""`, `x-dead-letter-routing-key = <main queue>`.
  - When the TTL expires, the message goes back to *that consumer's* queue only.
  - There is one queue per delay, so there is no head-of-line blocking.

**Messages and consumption**
- Messages are persistent and JSON. `messageId = eventId` and `type = eventType`; `correlationId` is set.
- Consumers use manual ack and a per-consumer prefetch (`RABBITMQ_PREFETCH`, default 10).
- Publishing always waits for publisher confirms (ConfirmChannel).
- **Connection:** one connection per process, plus one confirm channel and one channel per consumer. Reconnect uses exponential back-off capped at 5 s. On reconnect the topology is re-declared and consumers resubscribe.

## 10. Event format

```json
{
  "eventId": "uuid",                      // stable; child events use a deterministic id = hash(causationId|eventType)
  "eventType": "ORDER_CREATED",
  "eventVersion": 1,
  "aggregateType": "Order",
  "aggregateId": "<orderId>",
  "correlationId": "<orderId>",           // groups all events of one order flow
  "causationId": null | "<parent eventId>",
  "createdAt": "ISO-8601",
  "payload": { }
}
```

| Event | Payload |
|---|---|
| ORDER_CREATED | orderId, orderNumber, userId, totalAmount, currency, paymentReference, items[{productId, quantity, name}] |
| PAYMENT_COMPLETED / PAYMENT_FAILED | orderId, orderNumber, paymentReference, amount, gatewayTransactionId \| reason |
| INVENTORY_RESERVED / INVENTORY_FAILED | orderId, orderNumber, items \| reason, shortages |
| ORDER_CONFIRMED | orderId, orderNumber, totalAmount, customer{userId, name, email} |
| ORDER_FAILED | orderId, orderNumber, orderStatus, reason, totalAmount, customer, compensation{paymentRefunded, stockReleased} |
| EMAIL_NOTIFICATION_REQUESTED | to, subject, body, orderId?, template? |

Each payload is validated with zod (`events/eventSchema.js`). A payload that fails validation is a **permanent** failure.

## 11. Transactional outbox

**The checkout transaction** (`order.service.createOrder`) does all of this atomically:
1. Insert the order as PENDING. The unique idempotency key is checked here.
2. `assertAvailable` checks stock.
3. Create the PENDING payment operation.
4. Insert ORDER_CREATED into `outbox_events`.
5. Remove the purchased items from the cart.
6. **Commit.**

Nothing is published inside the transaction. Every consumer also writes its result events into the outbox **inside its own processing transaction**.

**The Outbox Publisher** (`outbox/outboxPublisher.js`, runs in the worker):
1. Claims an event atomically with `findOneAndUpdate`: PENDING and due, **or** PUBLISHING with a claim older than `OUTBOX_CLAIM_TIMEOUT_MS` (a crashed publisher). It is set to PUBLISHING with `claimedBy` and `publishAttempts++`. Several publishers can run safely.
2. Publishes with a broker confirm. It then records `publishCount++` and marks the event PUBLISHED, as long as it still owns the claim.
3. On failure the event goes back to PENDING with `lastError` and `nextAttemptAt` (exponential back-off up to `OUTBOX_MAX_BACKOFF_MS`). **It is never discarded.**
4. When the broker reconnects, every waiting event becomes due immediately.

**Publishing is at-least-once.** If the publisher crashes after the broker confirms but before the event is marked PUBLISHED, the event is published again. `publishCount` makes this visible. Consumers deduplicate by `eventId`. Tests 6 and 5 cover this case and the outage case.

## 12. Reliable Event Processor (main contribution)

The pipeline lives in `reliable-event-processor/eventProcessor.js`. Every consumer delivery goes through these steps:

1. **Parse and validate.** Invalid JSON, schema or event type is **permanent**: it goes straight to the DLQ, recorded with failureType PERMANENT and attempts = 1, then acked.
2. **Redis lease.** `SET NX PX` on `idem:event:<consumer>:<eventId>`:
   - **COMPLETED:** record DUPLICATE and ack.
   - **PROCESSING** (another copy is running): **defer**. The copy goes to the delay queue (confirmed), `deferredCount++`, then ack. It is never acked-and-dropped, because the holder could crash.
   - **Redis down:** skip this step. MongoDB still guards.
3. **Durable record.** Upsert `(eventId, consumer)`:
   - Already COMPLETED or DLQ: DUPLICATE, ack. This covers Redis data loss.
   - Otherwise: PROCESSING with `attempts++`.
4. **Run.** The fault hook runs first (Stage 3). Then one MongoDB transaction contains **both** the conditional update `status → COMPLETED` and the business handler, which writes the business data and the outbox events.
   - So the business effect and the completion record commit **together**. A crash between "did the work" and "recorded it" is impossible.
   - The whole attempt is bounded by `EVENT_PROCESSING_TIMEOUT_MS`.
5. **Success:** set the Redis COMPLETED marker, then ack.
6. **Failure:**
   1. Classify it with `errors.js`. TransientError, timeouts, unknown and infrastructure errors are retryable. PermanentError, ZodError and Mongoose validation errors are not.
   2. Set status FAILED and record the error in history. Release the lease.
   3. **If retryable and `attempt < maxAttempts`:** send a confirmed copy to `retry.<delay>ms`, then set RETRYING (`retryCount++`, `nextRetryAt`).
   4. **Otherwise:** send a confirmed copy to the DLQ (original body, plus headers `x-dlq-event-id`, `x-dlq-consumer`, `x-dlq-attempts`, `x-dlq-error`, `x-dlq-failure-type`, `x-dlq-original-routing-key`, `x-dlq-failed-at`), then set status DLQ.
   5. **Ack only after the copy is confirmed by the broker.**
7. **Infrastructure failure during bookkeeping** (MongoDB or RabbitMQ unavailable): `nack(requeue=true)` after 1 s. The message is never dropped.

**Late or concurrent writers.** Every status update is conditional: nothing overwrites COMPLETED, and RETRYING only follows FAILED. So a timed-out attempt that commits late, or two concurrent copies, still produce exactly one business effect. The second copy hits `AlreadyCompletedError` and is recorded as a DUPLICATE.

**Business-level guards (defence in depth)**

| Consumer | Guards |
|---|---|
| Payment | `paymentReference` is unique. Only a PENDING payment can be charged. The simulated gateway is idempotent per reference |
| Inventory | One `InventoryReservation` per order (unique). Stock changes use conditional `$inc`. All-or-nothing reservation |
| Order saga | Each step is recorded once. The final transition happens only from PENDING or PROCESSING. Refund and release are conditional state transitions |
| Email | `notifications.eventId` is unique |

## 13. Retry and DLQ configuration

| Variable | Default | Meaning |
|---|---|---|
| MAX_RETRIES | 3 | Retries after the first attempt. **maxAttempts = 1 + MAX_RETRIES = 4** |
| INITIAL_RETRY_DELAY_MS | 1000 | Delay before retry 1. Also the deferral delay |
| RETRY_BACKOFF_MULTIPLIER | 2 | Delay before retry n = min(INITIAL × MULTIPLIER^(n-1), MAX) |
| MAX_RETRY_DELAY_MS | 10000 | Delay cap |
| EVENT_PROCESSING_TIMEOUT_MS | 10000 | An attempt longer than this counts as a transient timeout failure |
| EVENT_LEASE_MS | 20000 | Redis lease. It must be greater than the timeout |

**Counting:** attempt 1 runs immediately, then retries come after 1 s, 2 s and 4 s, then the DLQ. In total: 4 executions and 3 retries.

DLQ messages are never deleted automatically, and they are also inspectable via `GET /api/events/dlq`.

## 14. Order lifecycle (saga)

**Status flow:**
- `PENDING` (checkout committed)
- → `PROCESSING` (the first step result has arrived)
- → then one of:
  - `CONFIRMED`: payment SUCCEEDED **and** inventory RESERVED. The reservation is committed, ORDER_CONFIRMED is emitted, and the e-mail is sent.
  - `PAYMENT_FAILED`: reserved stock is released and ORDER_FAILED is emitted.
  - `INVENTORY_FAILED`: the payment is refunded (simulated), `paymentStatus = REFUNDED`, and ORDER_FAILED is emitted.

**Rules:**
- Results can arrive in either order. Two results for the same order conflict on the same order document, so MongoDB serialises their transactions and exactly one of them makes the final decision.
- The confirmation e-mail is sent only after CONFIRMED.
- If a step event ends in the DLQ, the order stays PROCESSING until an operator acts (Stage 3 replay). This is documented behaviour; such orders are not auto-cancelled.

## 15. Delivery and processing guarantees (honest statement)

**Guarantees**
- **Publishing is at-least-once.** The outbox plus publisher confirms mean no committed event is lost; it may be published more than once.
- **Consumption is at-least-once.** Manual acks; redelivery on crash or channel loss.
- **Business effects are effectively once.** The completion record and the business writes are committed in one MongoDB transaction, a unique `(eventId, consumer)` record exists, and business-level unique constraints and conditional transitions apply. Redis speeds up duplicate detection and coordinates concurrent copies, but it is **not** required for correctness.
- This is **not** mathematically guaranteed exactly-once delivery.

**Limitations**
- External side effects that sit outside MongoDB would be at-least-once. The simulated gateway and e-mail are DB-backed, so here they are effectively once.
- If MongoDB is unavailable, processing pauses and messages are requeued.
- If retry or DLQ publishing fails while the broker is down, the delivery is requeued and counts as another attempt.
- **Poison messages that crash the whole process:** RabbitMQ classic queues have no delivery limit. The processing timeout and the try/catch around every step bound most cases.

## 16. Environment variables (`backend/.env`)

**Stage 1 variables (unchanged):** PORT, NODE_ENV, FRONTEND_URL, MONGODB_URI, MONGODB_DB_NAME, MONGODB_TEST_DB_NAME, JWT_SECRET, JWT_EXPIRES_IN, REDIS_*, IDEMPOTENCY_*, ADMIN_*.

**Stage 2 variables.** All are optional; the defaults match `docker-compose.yml`.
- RABBITMQ_URL (`amqp://ecommerce:ecommerce_dev@127.0.0.1:5672`), RABBITMQ_EXCHANGE, RABBITMQ_QUEUE_PREFIX, RABBITMQ_PREFETCH, RABBITMQ_CONFIRM_TIMEOUT_MS
- MAX_RETRIES, INITIAL_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS, RETRY_BACKOFF_MULTIPLIER, EVENT_PROCESSING_TIMEOUT_MS, EVENT_LEASE_MS, EVENT_IDEMPOTENCY_TTL_SECONDS
- OUTBOX_POLL_INTERVAL_MS, OUTBOX_BATCH_SIZE, OUTBOX_CLAIM_TIMEOUT_MS, OUTBOX_MAX_BACKOFF_MS
- SIMULATED_PAYMENT_DECLINE_ABOVE

**Stage 3 variables (optional):**
- `FAULT_INJECTION_ENABLED` (default `true`). It is **forced off when `NODE_ENV=production`**.
- FAULT_MAX_DELAY_MS (30000), FAULT_MAX_FAILURE_COUNT (100), FAULT_MAX_DUPLICATE_COPIES (5)
- TEST_EVENT_MAX_BATCH (200)

**Docker variables (optional):** RABBITMQ_USER and RABBITMQ_PASSWORD (defaults `ecommerce` / `ecommerce_dev`, local development only).

## 17. Testing

Run with `cd backend && npm test`. Docker must be running and Atlas configured. The run takes about 2.5 minutes.

| Suite | Tests | Result (2026-11-19) |
|---|---|---|
| fingerprint.test.js | 5 | PASS |
| idempotency.service.test.js (Redis) | 8 | PASS |
| api.integration.test.js (Stage 1 regression, Atlas + Redis + RabbitMQ) | 15 | PASS |
| events.integration.test.js (Stage 2, worker in-process) | 14 | PASS |
| **faults.integration.test.js** (Stage 3, real fault store + injector + HTTP API) | 15 | PASS |
| **testingGuard.test.js** (tools disabled ⇒ 403, hooks not installed) | 1 | PASS |
| **Total** | **58** | **58/58 PASS** |

**Stage 3 test map:**
- Authorization: 10 endpoints × (anonymous → 401, customer → 403)
- Validation: allowlists and limits
- T1: 10 synthetic orders reach 50/50 COMPLETED; real stock untouched; test orders excluded from the overview
- Synthetic e-mail events
- T4: temporary payment failure (2) → 3 attempts, then COMPLETED
- T5 + T10: persistent payment failure → DLQ after 4 attempts. Inventory completed independently; the order stays PROCESSING and no e-mail is sent
- DLQ replay: COMPLETED once, `dlqHistory` kept; a second replay returns 409
- T6: inventory failure → retry; one reservation
- T7: e-mail failure (2) → one notification
- T8: 8.5 s delay vs the 8 s timeout → timeout failure → retry, one reservation
- T3a: DUPLICATE_DELIVERY fault → 2 duplicates, still 1 attempt, 1 payment
- T3b: on-demand re-delivery → duplicates on payment and inventory, no second effect
- T12: recovery after disabling a fault
- Dashboard totals equal direct DB aggregates
- Reset deletes only synthetic data

**Stage 3 live verification** (dev servers on port 5000 plus a separate worker; 2026-11-19):

| Scenario | Result |
|---|---|
| 50 events | 250/250 records COMPLETED in about 30 s; 0 failed attempts, retries or DLQ entries |
| PAYMENT_FAILURE ×2 | failedAttempts = 2, everything completed |
| PERSISTENT_FAILURE | 2 events reached the DLQ with 4 attempts each; a replay completed one |
| Re-delivery ×3 | duplicates = 3 per consumer, attempts = 1 |
| Real `docker stop` with 10 generated events | 10 PENDING in the outbox; after `docker start`, 50/50 COMPLETED |

**Load test:** 100 synthetic orders gave 500/500 records COMPLETED in 65 s, with 0 failures.

**Stage 2 test map:**
- T1: normal flow
- T2: duplicate delivery of ORDER_CREATED ×2 and ORDER_CONFIRMED
- T3 + T9: transient failure ×2 then success, back-off gaps ≥ 300/600 ms, separate per-consumer state
- T4: retry exhaustion leads to the DLQ, with the payload preserved in both MongoDB and RabbitMQ
- Permanent failures (invalid JSON or schema) skip retries
- T5: broker connection lost; the outbox stays PENDING with `lastError`, then publishes after recovery
- T6: publisher crash after confirm leads to `publishCount = 2`, still a single effect
- T7: consumer channel crash mid-processing; redelivery, single reservation
- T8: inventory consumer stopped; payment completes, the order stays PROCESSING, then finishes on restart
- Saga compensation: refund on inventory failure; stock release on payment decline
- Processing timeout is retried
- Redis disconnected; MongoDB guard still deduplicates
- Monitoring API returns real counts and is admin-only

**Live verification** (2026-11-19, separate API and worker processes on the isolated test environment):
1. An order was CONFIRMED in about 1.8 s.
2. `docker stop ecommerce-rabbitmq` was run.
3. `/api/health` returned 503 (rabbitmq disconnected).
4. A new order was still accepted as PENDING. Its outbox event showed `publishAttempts = 3` and `lastError = "RabbitMQ is not connected"`.
5. `docker start ecommerce-rabbitmq` was run.
6. The worker reconnected, re-declared the topology, resubscribed its consumers, and the order became CONFIRMED.

## 18. Completed tasks

**Stage 1:** see the git history and README.

**Stage 2:**
- RabbitMQ in compose
- The connection module (confirms, reconnect, topology)
- Event catalogue, schema and factory
- Outbox model, service and publisher
- Four consumers on the shared runtime
- The Reliable Event Processor (idempotency, retry, DLQ, status, hooks)
- Order saga with compensation
- Simulated payment, inventory reservation and e-mail
- Event monitoring API
- Health check includes RabbitMQ
- Frontend order page polls the asynchronous status and shows each step
- Tests and docs

**Stage 3:**
- Fault Injection Module (`backend/fault-injection/`)
- Synthetic Event Generator
- On-demand duplicate delivery
- DLQ replay with an audit trail
- Test-data reset
- Scoped and extended monitoring
- Testing Panel, Reliability Dashboard and DLQ pages
- Tests and docs

## 19. Stage 3 — Fault injection, generator, dashboard

### 19.1 Gaps found in Stage 2, and how they were fixed

1. **A timed-out attempt could keep running.** An injected delay that outlived the timeout continued in the background and could start its business transaction at the same time as the retry. MongoDB's conditional COMPLETED claim prevented a double effect, but the work still overlapped.
   - **Fix:** the processor now passes an **AbortSignal**. The fault delay is abortable, and the attempt never *starts* its transaction after the deadline.
2. **Synthetic events could not be identified.**
   - **Fix:** an optional `metadata {isTestEvent, testBatchId, source}` on the envelope. It is inherited by child events (`createChildEvent`) and copied to `outbox_events` and `event_processing`.
3. **"Failed attempts" could not be counted accurately.**
   - **Fix:** a `failedAttempts` counter (`$inc` on every FAILED transition).
4. **Real business numbers would include synthetic data.**
   - **Fix:** `isTest` on orders and payments and `isSynthetic` on the synthetic user. The admin overview excludes them.

### 19.2 Fault Injection Module (`backend/fault-injection/`)

**Files:**
- `faultDefinitions.js`: the allowlist of 6 fault types, their allowed consumers and their parameters.
- `faultStore.js`: the Redis store `ecom:fault:<consumer>:<TYPE>`. It is shared by the API process, where faults are configured, and the worker processes, where they are injected.
  - `tryTrigger` is a **Lua script** that atomically rolls the failure rate and consumes `remaining`, so the "next N failures" counts are exact even with concurrent attempts.
- `faultInjector.js`: installs the processor hooks in the worker. It is **not installed in production**.

**How each fault is applied:**
- `ARTIFICIAL_DELAY` waits with an abortable delay.
- `*_FAILURE` and `PERSISTENT_FAILURE` throw `TransientError("[FAULT INJECTION] …")`.
- `DUPLICATE_DELIVERY` (in the after-success hook) republishes the identical message N times to the consumer's queue, with header `x-simulated-duplicate`. Copies of copies are never made.

**Configuration:**
- **Parameters:** `failureRate` 1–100, `failureCount` 1–100 or null (unlimited), `delayMs` 100–30000, `copies` 1–5, and `applyTo` ALL | TEST_EVENTS | REAL_EVENTS.
- Irrelevant parameters are dropped by the validator.
- **Safety:** faults are disabled by default. They are admin-only (`authenticate` + `requireRole('ADMIN')`), and `requireTestingTools` returns 403 when the tools are disabled. Disabling a fault never changes an event's status. Events already in the DLQ stay there until an admin replays them.

### 19.3 Synthetic Event Generator (`services/eventGenerator.service.js`)

**Event types:**
- `TEST_ORDER_EVENT`: per event, one transaction (chunks of 50) creates a test order, a PENDING payment and `ORDER_CREATED` in the outbox. The full saga then runs through the real pipeline.
- `TEST_EMAIL_EVENT`: `EMAIL_NOTIFICATION_REQUESTED`, handled by the email consumer only.

**Isolation from real data:**
- A synthetic customer (`synthetic.customer@shopsphere.test`, random password, so nobody can log in as it).
- 20 hidden synthetic products with their own inventory, at least 10 000 units each, assigned round-robin to avoid write contention.
- Real stock is never touched.

**Rules:**
- Batch IDs look like `TEST-YYYYMMDDhhmmss-XXXX`. Counts are bounded (`TEST_EVENT_MAX_BATCH`).
- **"Accepted" means committed to the outbox, not processed.** The generator never writes processing records.
- `resetTestData` deletes only `isTest` / `isTestEvent` data, and refuses with 409 while test events are in flight.

### 19.4 DLQ replay (`services/eventOperations.service.js`)

**Preconditions:** admin only; the record must be in the DLQ and its event must pass validation; RabbitMQ must be connected.

**Steps:**
1. `prepareReplay` stores the previous outcome in `dlqHistory` (`dlqAt`, `attempts`, `lastError`, `failureType`, `replayedAt`, `replayedBy`) and adds a REPLAYED history entry.
2. It sets status **RETRYING** with a fresh retry budget and increments `replayCount`.
3. The Redis marker is cleared.
4. The original event is published (confirmed) to **that consumer's** queue only.

**After that:**
- The record becomes COMPLETED only if processing succeeds. If publishing fails, the replay is reverted (`revertReplay`).
- Business guards prevent a second payment, reservation or e-mail.
- The RabbitMQ DLQ message is kept.

**Duplicate delivery on demand:** `redeliverEvent` republishes a **PUBLISHED** outbox event with the same eventId, either to every subscriber or to one chosen consumer.

### 19.5 Metric definitions (backend and UI use the same ones)

| Term | Definition |
|---|---|
| Logical event | One eventId in `outbox_events`. Shown as "Total events" |
| Processing record | One event as handled by **one** consumer. ORDER_CREATED has 2. Retries never create records |
| Successful | Records with status COMPLETED |
| Currently processing | Records with status RECEIVED or PROCESSING |
| Retrying | Records with status RETRYING |
| Retried | Records with `retryCount > 0` |
| Failed attempts | Sum of `failedAttempts` |
| Failed (status) | Records whose latest attempt failed and whose retry or DLQ transfer is being scheduled. This is momentary |
| DLQ | Records with status DLQ |
| Duplicate deliveries | Sum of `duplicateCount` |

The `scope` (all | test | real) and `batchId` filters apply to every metric.

### 19.6 Frontend

**Pages:**
- `/admin/testing`: Fault Injection Panel (a dropdown with only the relevant fields), configured faults read from the backend, the Synthetic Event Generator (10 / 50 / 100 or a custom count), duplicate delivery, RabbitMQ outage instructions with live broker and outbox status, and the reset action.
- `/admin/reliability`:
  - 7 summary cards, plus a definitions line.
  - Consumer statistics, including live queue and DLQ depths.
  - Event records table with filters for status, consumer, type, eventId prefix, scope and batch, and pagination.
  - Event detail modal with per-consumer history ("Attempt 2 → FAILED: …"), DLQ audit entries and child events.
- `/admin/dlq`: DLQ records, RabbitMQ DLQ depths and a Replay button.

**Polling** (`hooks/usePolling.js`):
- Statistics refresh every 2.5 s and tables every 4 s.
- Requests never overlap, and polling pauses while the tab is hidden.
- On failure, a stale-data warning is shown and the figures are dimmed.

**Status colours:** COMPLETED green, PROCESSING blue, RETRYING orange, FAILED red, DLQ dark red, DUPLICATE grey.

## 20. Known issues and limitations

- **Stage 1 limitations still apply:** the JWT is in localStorage, the Atlas M0 tier is throttled (100 synthetic orders take about 65 s), and `orderNumber` is display-only.
- **Dead-lettered orders.** An order whose step event is dead-lettered stays PROCESSING until that event is replayed from the DLQ page.
- **A worker must be running.** The API connects to RabbitMQ only for health, monitoring, replay and duplicate delivery. **Orders are finalised only while a worker is running** (`npm run worker`).
- **RabbitMQ boot time.** RabbitMQ needs about 10–15 s to boot after `docker start`. During an outage the publisher tries about one event per poll cycle, so `lastError` appears progressively on pending events.
- **Faults are global.** A fault applies to the *next matching attempts* of any event (filtered only by consumer and `applyTo`). Enable a fault, then generate events. In-flight events from an earlier batch can also be affected.
- **Reset scope.** "Reset test data" does not remove messages already in RabbitMQ DLQ queues. Purge them in the Management UI (Queues → `ecommerce.<consumer>.dlq` → Purge) if needed.
- **Browser walkthrough.** The admin pages were verified by a production build, route checks and their backend APIs. A click-through in a browser is left for the user.
