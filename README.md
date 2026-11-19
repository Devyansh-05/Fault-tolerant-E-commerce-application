# ShopSphere — Fault-Tolerant E-Commerce Platform

*Fault-Tolerant E-Commerce Platform with an Idempotent Reliable Event Processing Framework* (academic major project).

**Status:** all three stages are complete.

| Stage | Contents |
|---|---|
| 1 | Storefront, authentication, cart, checkout, HTTP request idempotency (Redis) |
| 2 | Transactional outbox, RabbitMQ, payment / inventory / order-saga / email consumers. The **Reliable Event Processor**: event idempotency, retry with exponential back-off, dead-letter queues, event status tracking |
| 3 | Fault Injection Module, Admin Testing Panel, Synthetic Event Generator, Reliability Dashboard, DLQ page with replay |

**Further documentation**
- Architecture, metric definitions and guarantees: [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)
- API reference: [docs/API.md](docs/API.md)
- Postman collection: [docs/postman_collection.json](docs/postman_collection.json)

```
CUSTOMER ─► React storefront ─► Express API ─► Redis (Idempotency-Key)
                                     └─► Order Service ─► MongoDB txn (order + payment op + outbox event)
ADMIN ─► Testing Panel ─► /api/admin/faults ─► Redis fault config ─────────────┐
      └► Testing Panel ─► /api/admin/testing/generate-events ─► outbox          │
                                                                              ▼
Worker: Outbox Publisher ─► RabbitMQ ─► payment · inventory · order(saga) · email consumers
        every consumer = Reliable Event Processor:
        idempotency ─► FAULT INJECTOR ─► handler+COMPLETED (one txn) ─► Retry Engine ─► DLQ
        └─► event_processing (status + history) ─► Reliability Dashboard / DLQ page
```

---

## 1. Stage 3 features

### Fault Injection Module

Faults are injected **inside the real consumers** by the Reliable Event Processor's hook. The configuration is stored in Redis, so the API (where you configure faults) and the worker (where they fire) always agree.

- Faults are **off by default**, ADMIN-only, and unavailable in production.

### Admin Testing Panel (`/admin/testing`)

It has these sections:
- A fault selector that shows only the fields relevant to the chosen fault.
- The list of configured faults, read from the backend.
- The Synthetic Event Generator.
- On-demand duplicate delivery.
- RabbitMQ outage instructions with live broker and outbox status.
- "Reset test data".

### Synthetic Event Generator

It creates clearly marked test events, with `metadata.isTestEvent = true` and a `testBatchId`. They go through the **real** outbox, RabbitMQ and consumers.

**Isolation:** it uses a synthetic customer and 20 hidden synthetic products, so real stock and real customers are never touched.

**Event types:**
- `Test Order Event`: the full saga (payment, inventory, order saga, email).
- `Test Email Event`: the email consumer only.

### Reliability Dashboard (`/admin/reliability`)

- **Live data:** it polls every 2.5 s, or 4 s for the table.
- **Summary cards:** Total events, Successfully processed, Currently processing, Retrying, Duplicate deliveries, Failed attempts, Events in DLQ.
- **Consumer statistics,** including the live RabbitMQ queue and DLQ depths.
- **Event records table** with filters: status, consumer, event type, eventId, test or real, batch.
- **Event detail view:** click a row to see each consumer's attempt history.

### Dead Letter Queue (`/admin/dlq`)

The page lists every dead-lettered record with its attempts, error and time, plus the RabbitMQ DLQ depths.

**Replay** sends the original event back through the normal pipeline. The DLQ history is kept as an audit trail, and the record becomes COMPLETED only if processing really succeeds.

**Metric definitions**

| Term | Meaning |
|---|---|
| Logical event | One eventId |
| Processing record | That event as handled by one consumer (ORDER_CREATED has two: payment and inventory) |
| Attempts | Executions of a handler. Retries add attempts to the same record; they never add records |

## 2. Fault types

| Fault | Where it is injected | Parameters | Expected behaviour |
|---|---|---|---|
| Payment Failure | Payment Consumer (before charging) | failure rate %, number of failures (or unlimited) | Transient error → retry with back-off → success, or DLQ when retries are exhausted. Never a second charge |
| Inventory Failure | Inventory Consumer (before reserving) | rate, count | Retry or DLQ. Stock is reserved at most once per order |
| Email Failure | Email Consumer (before "sending") | rate, count | Retry or DLQ. At most one notification per event |
| Artificial Delay / Timeout | Any selected consumer | delay ms (≤ 30 000), chance, count | If the delay exceeds the 10 s processing timeout, the attempt fails as a timeout and is retried. The timed-out attempt is aborted and never runs its business logic |
| Duplicate Event Delivery | Any consumer, after successful processing | extra copies (≤ 5), chance, count | The same message (same eventId) is delivered again. Detected as DUPLICATE and skipped |
| Repeated / Persistent Failure | Any selected consumer | next N attempts, or always | Every attempt fails → 4 attempts in total → DLQ |
| RabbitMQ Unavailability | Message broker (real `docker stop`) | — | Events wait as PENDING in the MongoDB outbox and are published after `docker start` |

**Retry convention, shown the same way in the UI and the backend:**
- Attempt 1 is the first execution. `MAX_RETRIES = 3` further attempts follow, so the maximum is **4 attempts**.
- The retry delays are 1 s, 2 s and 4 s.
- After the 4th failed attempt the event goes to the DLQ.

**"Apply to"** limits a fault to *synthetic test events* (recommended for demos), *real events*, or *all events*.

---

## 3. Running the project

### Prerequisites

- Node.js 20 or newer
- Docker Desktop, running
- A MongoDB Atlas cluster

### One-time setup

1. Create your environment file:
   ```bash
   cd backend
   cp .env.example .env        # PowerShell: Copy-Item .env.example .env
   ```
2. Fill in `backend/.env`:
   - **Required:** `MONGODB_URI` (the Atlas database-user string, without `< >`) and `JWT_SECRET` (32+ characters).
   - **Recommended:** `ADMIN_EMAIL` / `ADMIN_PASSWORD`, which the seed script uses to create your admin account.
   - **Optional:** everything else. The defaults match `docker-compose.yml`.
3. Install and seed:
   ```bash
   npm install
   npm run seed                # 15 products + the admin account (safe to re-run)
   cd ../frontend && npm install
   ```

### Every time: step by step

1. **Start Docker services** (from the project root):
   ```bash
   docker compose up -d
   docker compose ps
   ```
   Wait until both `ecommerce-redis` and `ecommerce-rabbitmq` show **healthy** (about 15 s).
2. **Verify Redis:**
   ```bash
   docker exec ecommerce-redis redis-cli ping
   ```
   It should answer `PONG`.
3. **Verify RabbitMQ:** open http://localhost:15672 and log in as `ecommerce` / `ecommerce_dev` (local development credentials).
4. **Start the backend API** (terminal 1):
   ```bash
   cd backend && npm run dev
   ```
   Then open http://localhost:5000/api/health. It should report `mongodb`, `redis` and `rabbitmq` as connected.
5. **Start the worker** (terminal 2). This runs the Outbox Publisher, all consumers and the fault injector:
   ```bash
   cd backend && npm run worker
   ```
   The log shows `Fault injection hooks installed` and `Worker started`.
6. **Start the frontend** (terminal 3):
   ```bash
   cd frontend && npm run dev
   ```
   Then open http://localhost:5173.
7. **Log in as ADMIN** with your `ADMIN_EMAIL` / `ADMIN_PASSWORD`. **Admin** appears in the top menu.
8. **Open the testing panel:** Admin → **Testing Panel**.
9. **Generate events:** in *Synthetic Event Generator*, choose 50, then **Generate events**.
10. **Configure a fault:** choose a fault, enter its values, then **Enable fault**.
11. **Watch the dashboard:** Admin → **Reliability Dashboard**. Click any row to see its history.
12. **Inspect the DLQ:** Admin → **Dead Letter Queue**.

**Docker commands**

| Command | Effect |
|---|---|
| `docker compose logs -f rabbitmq` | Follow the broker logs |
| `docker compose stop` | Stop the containers |
| `docker compose down` | Remove the containers (the data volumes are kept) |

**Individual worker components**

You can run parts of the worker separately: `npm run publisher`, `npm run consumer:payment`, `consumer:inventory`, `consumer:order`, `consumer:email`, or `node worker.js payment email`.

### Automated tests

```bash
cd backend && npm test      # 58 tests, ~2.5 min - Docker + Atlas required
```

The tests use an isolated namespace: the database `ecommerce_test`, Redis keys `ecomtest:*` and the RabbitMQ prefix `ecommerce_test.*`. Your development data and a running dev worker are never touched.

---

## 4. Demonstration guide (12 scenarios)

### Before you start

1. Open three browser tabs: the **Testing Panel**, the **Reliability Dashboard** and the **Dead Letter Queue**.
2. In the Testing Panel, click **Reset test data** so every counter starts from zero.
3. On the dashboard, set **Events: Synthetic test events**.
4. Keep **Apply to: Synthetic test events only** for every fault.

### 1. Normal event processing

**Do:**
1. Make sure no fault is enabled (*Configured faults* is empty or shows DISABLED).
2. Generate **50** Test Order Events.

**Observe:**
- The result card says *Successfully submitted: 50*. "Submitted" is not "processed".
- On the dashboard, *Total events* climbs to 200 (50 ORDER_CREATED + 50 PAYMENT_COMPLETED + 50 INVENTORY_RESERVED + 50 ORDER_CONFIRMED).
- *Successfully processed* climbs to 250 processing records.
- *Retrying*, *Failed attempts* and *DLQ* stay at 0.

**Explain:** events really travel outbox → RabbitMQ → consumers. Every number comes from MongoDB records.

### 2. HTTP request idempotency

**Do:**
1. Use Postman (`docs/postman_collection.json`): **Login**, then **Products**, then **New idempotency key**, then **Create order**.
2. Send **Create order** again unchanged.
3. Run *SAME key, DIFFERENT payload*.

**Observe:**
- The second request returns the same order id with the header `Idempotent-Replayed: true`.
- The different payload returns **409**.
- Admin Overview shows only one order.

**Explain:** Redis `SET NX` plus a fingerprint, with a unique MongoDB index as a backstop. Concurrent duplicates are covered by the automated tests (and README §5 of Stage 1).

### 3. Duplicate event delivery

**Do (option A):**
1. In *Duplicate delivery of an existing event*, click **Use latest test order event**.
2. Set copies to 3 and click **Deliver again**.

**Do (option B):**
1. Enable **Duplicate Event Delivery**: consumer Payment, 2 extra copies, 1 event.
2. Generate 1 event.

**Observe:**
- *Duplicate deliveries* increases.
- Open the event: payment and inventory show `duplicates 3, attempts 1`, with history lines *"Duplicate delivery detected and skipped"*.

**Explain:** same eventId → idempotency (Redis + MongoDB) → no second payment, stock deduction or e-mail.

### 4. Temporary payment failure

**Do:**
1. Enable **Payment Failure**: rate 100 %, number of failures **2**.
2. Generate **5** events.

**Observe:**
- *Failed attempts* = 2 and *Retried* = 2 records, then everything COMPLETED.
- Open an affected event. The payment history reads:
  - Attempt 1 → FAILED: [FAULT INJECTION]…
  - Retry 1 scheduled in 1000 ms
  - Attempt 2 → FAILED
  - Attempt 3 → COMPLETED
- The fault's *Matched / injected* shows `… / 2`, and its status is EXHAUSTED.

**Explain:** transient failures are retried with exponential back-off and recover without duplicates.

### 5. Persistent payment failure and DLQ

**Do:**
1. Enable **Repeated / Persistent Failure**: consumer Payment, *Always fail while enabled*.
2. Generate **2** events.

**Observe (about 8 s later):**
- *Events in DLQ* = 2.
- On the DLQ page each record shows **4 attempts**, *"Retries exhausted after 4 attempt(s)"*, the failure time, and the RabbitMQ payment DLQ depth.

**Then:**
1. **Disable** the fault.
2. Click **Replay** on one record.

**Observe:** the record goes RETRYING → COMPLETED. The DLQ count drops by 1, and the audit line *"Previous DLQ entries"* remains.

### 6. Inventory failure

**Do:**
1. Enable **Inventory Failure**: number of failures 3.
2. Generate **3** events.

**Observe:**
- The inventory consumer row shows failed attempts and retries; everything completes.
- In the event detail, the stock was reserved once (inventory `attempts > 1`, but a single reservation).

### 7. Email failure

**Do:**
1. Enable **Email Failure**: number of failures 2.
2. Generate **1** event.

**Observe:**
- The ORDER_CONFIRMED event's email record shows 3 attempts, then COMPLETED.
- Only one notification is created.
- Payment and inventory were unaffected.

### 8. Artificial delay / timeout

**Do:**
1. Enable **Artificial Delay**: consumer Inventory, **12000 ms** (longer than the 10 s timeout), number of delayed attempts 1.
2. Generate **1** event.

**Observe:**
- The inventory record shows *Attempt 1 → FAILED: Event processing timed out after 10000 ms*, then *Attempt 2 → COMPLETED*.
- One reservation.

**Explain:** timeouts are transient failures. The timed-out attempt is aborted, so the business logic never runs twice.

**Variation:** a 3000 ms delay just makes processing slower, with no failure.

### 9. RabbitMQ unavailability (real outage)

**Do:**
1. In a terminal: `docker stop ecommerce-rabbitmq`.
2. Generate **10** events (or place an order in the shop).

**Observe:**
- The Testing Panel and the dashboard show RabbitMQ as **disconnected**, and *Outbox pending* = 10.
- The event table does not grow: nothing reached the consumers, and nothing was marked successful.

**Then:**
1. Run `docker start ecommerce-rabbitmq`.
2. Wait about 15–25 s.

**Observe:** the worker log shows *"RabbitMQ connected"* and *"waiting event(s) scheduled for immediate publishing"*. The pending count drops to 0, and the 10 events complete.

**Explain:** the transactional outbox means no event is lost when the broker is down.

### 10. Independent consumer processing

**Do:**
1. Enable **Persistent Failure** on Payment (always).
2. Generate **1** event.

**Observe:**
- **Consumer statistics:** inventory COMPLETED while payment goes RETRYING, then DLQ.
- The order is not confirmed without payment. In the ORDER_CREATED event detail, *Events caused by this event* shows **INVENTORY_RESERVED but no PAYMENT_COMPLETED**. The order consumer has recorded only the inventory result (the order stays PROCESSING), and **no ORDER_CONFIRMED event or e-mail** exists.

**Then:** disable the fault and replay the event from the DLQ. The order becomes CONFIRMED.

### 11. Admin authorization

**Do:**
1. Log out and register a normal customer.
2. Open `/admin/testing`, `/admin/reliability` and `/admin/dlq` directly.
3. With the customer's token in Postman, call `GET /api/events/stats` and `POST /api/admin/faults/enable`.

**Observe:**
- The pages redirect to the home page.
- The API calls return **403**. Without a token they return **401**.

**Explain:** access is enforced by the backend, not only by the UI.

### 12. Recovery after disabling a fault

**Do:**
1. Enable **Persistent Failure** on Email (always).
2. Generate **5** Test Email Events.
3. As soon as *Retrying* shows records, **Disable** the fault.

**Observe:**
- Records still waiting for a retry complete on their next attempt.
- New events complete at the first attempt.
- Any event that had already reached the DLQ **stays in the DLQ** until it is replayed. Disabling a fault never marks failures as successful.

### After the demo

Click **Reset test data**. This doesn't clear RabbitMQ's DLQ queues: purge them in the Management UI (Queues → `ecommerce.<consumer>.dlq` → *Purge Messages*) if you want those depths at 0 too.

---

## 5. Guarantees (what to say to the examiner)

- **Delivery is at-least-once.** RabbitMQ may redeliver messages, and the outbox may republish them after a crash.
- **Processing is idempotent.** Each consumer's business effect and its COMPLETED record commit in **one MongoDB transaction**. A unique `(eventId, consumer)` record, business constraints (unique payment reference, one reservation per order, unique notification per event), and the Redis lease for concurrent copies make the business effects **effectively once**.
- **This is not exactly-once delivery,** and the project does not claim it is.

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| Orders / generated events stay PENDING | Start the worker: `cd backend && npm run worker` |
| Testing Panel says the tools are disabled | `NODE_ENV=production` or `FAULT_INJECTION_ENABLED=false` in `backend/.env` |
| Dashboard shows "⚠ Cannot reach the backend" | The API on :5000 is not running |
| `rabbitmq: disconnected` in health | `docker compose up -d` and wait for *healthy* |
| `bad auth : authentication failed` | Wrong Atlas database-user password, or `< >` left in `MONGODB_URI` |
| `querySrv ENOTFOUND` / timeout | Add your IP in Atlas Network Access, or try another network or a hotspot |
| `503 REDIS_UNAVAILABLE` on checkout | `docker compose up -d` (Redis) |
