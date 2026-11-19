# ShopSphere REST API (Stages 1–3)

Base URL: `http://localhost:5000/api`

A ready-made Postman collection is in [`docs/postman_collection.json`](postman_collection.json).

## Conventions

**Authentication.** Protected routes need the header `Authorization: Bearer <JWT>`. You get the token from `/auth/register` or `/auth/login`.

**Success body**

```json
{ "success": true, "message": "optional", "data": { } }
```

**Error body**

```json
{ "success": false, "error": { "code": "STABLE_CODE", "message": "Human readable", "details": "optional" } }
```

**Common errors**

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_JSON`, `INVALID_ID` | Malformed input |
| 401 | `AUTH_REQUIRED`, `INVALID_TOKEN`, `INVALID_CREDENTIALS` | Missing, bad or expired token; wrong login |
| 403 | `FORBIDDEN` | The role is not allowed |
| 404 | `ROUTE_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `ORDER_NOT_FOUND` | The thing doesn't exist |
| 429 | `TOO_MANY_REQUESTS` | Auth rate limit hit (30 per 15 min per IP) |
| 503 | `REDIS_UNAVAILABLE`, `TRANSACTIONS_UNAVAILABLE` | Required infrastructure is down |
| 500 | `INTERNAL_ERROR` | Unexpected error. Details are logged on the server, never sent to the client |

---

## Health

### `GET /health`

Public. Returns 200 when MongoDB (with transaction support), Redis and RabbitMQ are all connected, otherwise 503. The response also includes `"rabbitmq": { "status": "connected" }`.

```json
{
  "success": true,
  "status": "ok",
  "uptimeSeconds": 42,
  "timestamp": "2026-11-19T10:00:00.000Z",
  "services": {
    "api": { "status": "up" },
    "mongodb": { "status": "connected", "transactionsSupported": true },
    "redis": { "status": "connected" }
  }
}
```

---

## Authentication

### `POST /auth/register`

Public and rate-limited. Always creates a `CUSTOMER` account.

**Body**

```json
{ "name": "Asha Verma", "email": "asha@example.com", "password": "Secret123" }
```

**Rules**
- `name`: 2–80 characters.
- `email`: a valid email address.
- `password`: 8–72 characters, with at least one letter and one number.

**Responses**
- **201:** `data: { user: { id, name, email, role, createdAt, updatedAt }, token }`
- **409:** `EMAIL_IN_USE`
- **400:** `VALIDATION_ERROR`

### `POST /auth/login`

Public and rate-limited.

**Body**

```json
{ "email": "asha@example.com", "password": "Secret123" }
```

**Responses**
- **200:** `data: { user, token }`
- **401:** `INVALID_CREDENTIALS`. The same message is used for an unknown email and a wrong password.

### `GET /auth/me`

Requires authentication.

**Responses**
- **200:** `data: { user }`
- **401:** missing or invalid token

---

## Products

### `GET /products`

Public. Only active products are returned.

**Query parameters**

| Param | Default | Notes |
|---|---|---|
| `q` | none | Case-insensitive search over name, description and category |
| `category` | none | Exact category match, case-insensitive |
| `sort` | `newest` | One of `newest`, `price_asc`, `price_desc`, `name` |
| `minPrice`, `maxPrice` | none | Price range |
| `page` | `1` | Page number |
| `limit` | `12` | Maximum 50 |

**Response 200**

```json
{
  "data": {
    "products": [{ "id": "…", "name": "…", "slug": "…", "description": "…", "price": 7999, "category": "Electronics", "image": "/images/products/electronics.svg", "stock": 40, "isActive": true, "createdAt": "…", "updatedAt": "…" }],
    "pagination": { "page": 1, "limit": 12, "total": 15, "totalPages": 2 }
  }
}
```

### `GET /products/categories`

Public. **200:** `data: { categories: ["Books", "Electronics", …] }`

### `GET /products/:id`

Public.

**Responses**
- **200:** `data: { product }`
- **400:** malformed ID
- **404:** `PRODUCT_NOT_FOUND`

### `POST /products`

Requires the ADMIN role.

**Body**

```json
{ "name": "USB-C Hub", "description": "7-in-1 hub", "price": 1999.5, "category": "Electronics", "image": "/images/products/electronics.svg", "stock": 25 }
```

**Rules**
- `price`: at most 2 decimal places.
- `stock`: a whole number ≥ 0.
- The product and its Inventory record are created in one transaction.

**Responses**
- **201:** `data: { product }`
- **409:** `PRODUCT_EXISTS`
- **401/403:** not authenticated, or not an admin

### `PUT /products/:id`

Requires the ADMIN role. Send any subset of the create fields; at least one is required. Setting `stock` sets the Inventory's available quantity and updates `Product.stock` in the same transaction.

**200:** `data: { product }`

### `DELETE /products/:id`

Requires the ADMIN role. This is a soft delete: the product leaves the catalogue, but existing orders keep their references.

**Responses**
- **200:** deleted
- **404:** `PRODUCT_NOT_FOUND`

---

## Cart

Every cart route requires authentication. Each route returns the full cart view:

```json
{
  "data": {
    "cart": {
      "items": [{ "productId": "…", "name": "…", "image": "…", "category": "…", "unitPrice": 1000.5, "quantity": 2, "lineTotal": 2001, "availableStock": 8, "isAvailable": true }],
      "itemCount": 2, "subtotal": 2001, "currency": "INR", "hasUnavailableItems": false, "updatedAt": "…"
    }
  }
}
```

The server works out prices from the Product collection every time the cart is read.

| Method and path | Body | Notes |
|---|---|---|
| `GET /cart` | none | Returns the current cart |
| `POST /cart/add` | `{ "productId": "…", "quantity": 1 }` | Adds to any quantity already in the cart. **422** `INSUFFICIENT_STOCK` / `QUANTITY_LIMIT` (max 20 per product) |
| `PUT /cart/update` | `{ "productId": "…", "quantity": 3 }` | Sets the quantity. **404** `CART_ITEM_NOT_FOUND` |
| `DELETE /cart/remove/:productId` | none | Removes one product |
| `DELETE /cart/clear` | none | Empties the cart |

---

## Orders

### `POST /orders` (idempotent)

Requires authentication.

**Required headers**

```
Authorization: Bearer <JWT>
Idempotency-Key: 3f1c5a8e-2b7d-4c1e-9f0a-6d5b4c3a2e10
Content-Type: application/json
```

The `Idempotency-Key` must be 8–128 characters: letters, digits, `-` or `_`. A UUID is recommended. Keys are scoped to the user.

**Body**

```json
{
  "items": [{ "productId": "…", "quantity": 2 }],
  "shippingAddress": {
    "fullName": "Asha Verma", "phone": "+91 98765 43210",
    "addressLine1": "12 MG Road", "addressLine2": "",
    "city": "Bengaluru", "state": "Karnataka", "postalCode": "560001", "country": "India"
  }
}
```

**How the body is handled**
- Prices or totals sent by the client are ignored. The total is calculated from the prices in MongoDB.
- Purchased items are removed from the user's cart in the same transaction.

**Responses**

| Status | Meaning |
|---|---|
| **201** | Order accepted. `data: { order }`, where `orderStatus = PENDING` and `paymentStatus = PENDING`. The same transaction stored the payment operation and an `ORDER_CREATED` outbox event; the order is finalised **asynchronously** (poll `GET /orders/:id`) |
| **201** + header `Idempotent-Replayed: true` + body `idempotentReplay: true` | Duplicate request (same key, same payload). The original order is returned and nothing new is created |
| **409** `IDEMPOTENCY_KEY_REUSED` | Same key with a different payload |
| **409** `REQUEST_IN_PROGRESS` + `Retry-After` header | A request with this key is still running. Retry later with the same key |
| **422** `INSUFFICIENT_STOCK` / `PRODUCT_UNAVAILABLE` | Business failure. The whole transaction was rolled back. Repeating the same key replays this failure |
| **400** `IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_INVALID` / `VALIDATION_ERROR` | Bad header or body |
| **503** `REDIS_UNAVAILABLE` | The idempotency store is down. The order is **not** processed |

**Order object**

```json
{
  "id": "…", "orderNumber": "ORD-261119-A1B2C3", "userId": "…",
  "orderItems": [{ "productId": "…", "name": "…", "image": "…", "unitPrice": 1000.5, "quantity": 2, "lineTotal": 2001 }],
  "totalAmount": 2001, "currency": "INR", "shippingAddress": { },
  "orderStatus": "CONFIRMED", "paymentStatus": "PAID",
  "paymentId": "…", "paymentReference": "PAY-<orderId>",
  "idempotencyKey": "…",
  "fulfillment": {
    "payment":   { "status": "SUCCEEDED", "reason": "", "eventId": "…", "updatedAt": "…" },
    "inventory": { "status": "RESERVED",  "reason": "", "eventId": "…", "updatedAt": "…" }
  },
  "failureReason": "",
  "compensation": { "paymentRefunded": false, "stockReleased": false },
  "statusHistory": [{ "status": "PENDING", "note": "Order received — awaiting payment and stock reservation", "at": "…" }, { "status": "PROCESSING", "note": "Payment succeeded (simulated)", "at": "…" }, { "status": "PROCESSING", "note": "Stock reserved", "at": "…" }, { "status": "CONFIRMED", "note": "Payment received and stock reserved", "at": "…" }],
  "createdAt": "…", "updatedAt": "…"
}
```

**Order lifecycle**
- `orderStatus` moves `PENDING → PROCESSING → CONFIRMED | PAYMENT_FAILED | INVENTORY_FAILED`.
- `paymentStatus` is one of `PENDING | PAID | FAILED | REFUNDED`. `REFUNDED` appears after compensation when inventory failed.
- `fulfillment.payment.status` is `PENDING | SUCCEEDED | FAILED`.
- `fulfillment.inventory.status` is `PENDING | RESERVED | FAILED`.

### `GET /orders?page=1&limit=10`

Requires authentication. Returns only the current user's orders, newest first.

**200:** `data: { orders: [...], pagination }`

### `GET /orders/:id`

Requires authentication. Customers can read only their own orders; admins can read any order.

**Responses**
- **200:** `data: { order }`
- **404:** `ORDER_NOT_FOUND`. This is also returned for another user's order, so the API doesn't reveal that it exists.

---

## Admin

### `GET /admin/overview`

Requires the ADMIN role.

```json
{ "data": { "totalUsers": 3, "totalProducts": 15, "totalOrders": 7, "confirmedRevenue": 25497, "recentOrders": [{ "...order": "", "customer": { "name": "…", "email": "…" } }] } }
```

---

## Event monitoring (Stage 2)

Every endpoint in this section requires the **ADMIN** role (401 without a token, 403 for customers). Every value is read from MongoDB (`event_processing`, `outbox_events`) or from live RabbitMQ queue depths; nothing is estimated.

An **event processing record** is one event as seen by one consumer. For example, `ORDER_CREATED` has two records, one for `payment` and one for `inventory`.

### `GET /events`

Lists processing records, newest update first. The `event` payload and `history` are omitted here; use the detail endpoint for those.

**Query parameters:** `status` (`RECEIVED|PROCESSING|COMPLETED|RETRYING|FAILED|DLQ`), `consumer` (`payment|inventory|order|email`), `eventType`, `correlationId` (the order ID), `q` (eventId prefix), `page`, `limit` (max 50, default 20).

```json
{ "data": { "records": [{ "id": "…", "eventId": "…", "consumerName": "payment", "eventType": "ORDER_CREATED", "status": "COMPLETED",
  "attempts": 3, "retryCount": 2, "maxAttempts": 4, "deliveries": 3, "duplicateCount": 0, "deferredCount": 0,
  "lastError": null, "failureType": null, "processingMs": 412, "correlationId": "<orderId>",
  "firstReceivedAt": "…", "lastAttemptAt": "…", "nextRetryAt": null, "completedAt": "…", "dlqAt": null }],
  "pagination": { "page": 1, "limit": 20, "total": 37, "totalPages": 2 } } }
```

### `GET /events/stats`

```json
{ "data": {
  "processingRecords": 37, "distinctEvents": 21, "deliveries": 45, "attempts": 41,
  "byStatus": { "RECEIVED": 0, "PROCESSING": 0, "COMPLETED": 35, "RETRYING": 0, "FAILED": 0, "DLQ": 2, "DUPLICATE": 0 },
  "successful": 35, "currentlyProcessing": 0, "retrying": 0, "failed": 0, "inDlq": 2,
  "retried": 3, "totalRetries": 6, "duplicateDeliveries": 4, "recordsWithDuplicates": 3, "deferredDeliveries": 1,
  "avgProcessingMs": 388.2, "updatedInLastMinute": 5,
  "outbox": { "total": 25, "byStatus": { "PENDING": 0, "PUBLISHING": 0, "PUBLISHED": 25 }, "publishedMoreThanOnce": 1 },
  "broker": { "status": "connected" }, "generatedAt": "…" } }
```

DUPLICATE is never a record's *current* status. A duplicate delivery is logged in the record's `history` and counted in `duplicateCount`, while the record itself stays COMPLETED.

### `GET /events/consumer-stats`

Returns per-consumer totals: `byStatus`, `attempts`, `duplicates`, `retries` and `avgProcessingMs`. It also includes the live RabbitMQ `queue.depth`, `queue.consumers` and `dlq.depth`.

### `GET /events/dlq?consumer=email&page=1&limit=20`

Returns the records with status DLQ, each including the **full original `event`**, `lastError`, `attempts`, `failureType` and `history`. It also returns `queues: [{ consumer, queue, messages }]`, the live DLQ depths.

### `GET /events/outbox?status=PENDING&eventType=ORDER_CREATED`

Returns outbox entries with `status`, `publishAttempts`, `publishCount`, `lastError`, `nextAttemptAt` and `publishedAt`. Use it to watch events waiting while RabbitMQ is down.

### `GET /events/config`

Returns the active retry policy (`maxRetries`, `maxAttempts`, `delaysMs`, …) and the RabbitMQ topology (the queues, routing keys, retry queues and DLQ of each consumer).

### `GET /events/:eventId`

Returns everything about one event:
- `outbox`: the outbox entry
- `consumers[]`: one full record per consumer, with history and event
- `redisState`: the live idempotency marker for each consumer
- `childEvents[]`: the events it caused, linked by `causationId`

**404** `EVENT_NOT_FOUND`: no record of this event exists.

The detail response also includes `eventType`, `isTestEvent` and `testBatchId`. Each consumer record includes `failedAttempts`, `replayCount` and `dlqHistory[]`.

### Common query parameters (Stage 3)

`/events`, `/events/stats`, `/events/consumer-stats`, `/events/dlq` and `/events/outbox` accept:
- `scope`: `all` (default), `test` (synthetic generator events) or `real`
- `batchId`: one generated test batch

`/events` additionally accepts `from` / `to` (ISO dates, applied to `firstReceivedAt`).

`/events/stats` also returns:
- `logicalEvents`: outbox events. This is the dashboard's "Total events".
- `testEventsGenerated`
- `failedAttempts`
- `replays`
- `retryPolicy`

### `POST /events/dlq/:eventId/replay`

Requires the ADMIN role.

**Body:** `{ "consumer": "payment" }`

Replays a dead-lettered event for one consumer:
- The previous outcome is kept in `dlqHistory`.
- The status becomes **RETRYING** with a fresh retry budget.
- The original event is published again to that consumer's queue only.
- The record becomes COMPLETED only if processing succeeds.

**Responses**
- **202:** `data: { eventId, consumer, status: "RETRYING", replayCount, message }`
- **404** `EVENT_NOT_FOUND`
- **409** `NOT_IN_DLQ`
- **422** `EVENT_NOT_REPLAYABLE`: the message itself is invalid.
- **503** `BROKER_UNAVAILABLE`

---

## Fault injection and testing (Stage 3)

Every endpoint in this section:
- requires the **ADMIN** role;
- returns **403** `TESTING_TOOLS_DISABLED` when `NODE_ENV=production` or `FAULT_INJECTION_ENABLED=false`;
- is backed by Redis (`ecom:fault:<consumer>:<FAULT_TYPE>`), so the worker processes see every change immediately.

### `GET /admin/faults`

```json
{ "data": {
  "available": true, "activeCount": 1,
  "faults": [{ "faultType": "PAYMENT_FAILURE", "label": "Payment Failure", "targetConsumer": "payment", "enabled": true,
               "failureRate": 100, "failureCount": 2, "remaining": 0, "delayMs": 0, "copies": 0, "applyTo": "TEST_EVENTS",
               "matchedAttempts": 2, "injectedCount": 2, "active": false, "exhausted": true,
               "createdAt": "…", "updatedAt": "…", "lastInjectedAt": "…", "enabledBy": "admin@…" }],
  "definitions": [{ "faultType": "ARTIFICIAL_DELAY", "label": "…", "kind": "DELAY", "consumers": ["payment","inventory","order","email"], "params": ["delayMs","failureRate","failureCount"], "description": "…" }],
  "applyToOptions": ["ALL", "TEST_EVENTS", "REAL_EVENTS"],
  "limits": { "maxDelayMs": 30000, "maxFailureCount": 100, "maxDuplicateCopies": 5, "processingTimeoutMs": 10000, "maxGeneratedEvents": 200 },
  "retryPolicy": { "maxRetries": 3, "maxAttempts": 4, "delaysMs": [1000, 2000, 4000] } } }
```

### `POST /admin/faults/enable`

**Body**

```json
{ "faultType": "PAYMENT_FAILURE", "targetConsumer": "payment", "failureRate": 50, "failureCount": 5, "applyTo": "TEST_EVENTS" }
```

**Fault types and their allowed consumers**

| faultType | targetConsumer | Parameters |
|---|---|---|
| `PAYMENT_FAILURE` | payment | failureRate, failureCount |
| `INVENTORY_FAILURE` | inventory | failureRate, failureCount |
| `EMAIL_FAILURE` | email | failureRate, failureCount |
| `ARTIFICIAL_DELAY` | any | **delayMs** (required), failureRate, failureCount |
| `DUPLICATE_DELIVERY` | any | copies, failureRate, failureCount |
| `PERSISTENT_FAILURE` | any | failureCount (null = always) |

**Limits**
- `failureRate`: 1–100 (default 100)
- `failureCount`: 1–100, or `null` for unlimited
- `delayMs`: 100–30000
- `copies`: 1–5
- `applyTo`: `ALL | TEST_EVENTS | REAL_EVENTS`

Parameters that don't belong to the chosen fault are ignored.

**Responses**
- **200:** `data: { fault }`
- **400** `VALIDATION_ERROR`: unknown fault, a consumer not allowed for that fault, or a value out of range.

### `POST /admin/faults/disable`

**Body:** `{ "faultType": "PAYMENT_FAILURE", "targetConsumer": "payment" }` or `{ "all": true }`

**Responses**
- **200:** `data: { disabled, fault? }`
- **404** `FAULT_NOT_FOUND`

Disabling a fault never changes the status of any event. Records in the DLQ stay there.

### `POST /admin/testing/generate-events`

**Body:** `{ "count": 50, "eventType": "TEST_ORDER_EVENT" }`

| eventType | What happens |
|---|---|
| `TEST_ORDER_EVENT` | For each event: a synthetic order and payment, plus `ORDER_CREATED` in the outbox. The full saga runs through the real pipeline |
| `TEST_EMAIL_EVENT` | `EMAIL_NOTIFICATION_REQUESTED` (email consumer only) |

`count` ranges from 1 to `TEST_EVENT_MAX_BATCH` (default 200).

**Response 201**

```json
{ "success": true, "data": { "batchId": "TEST-20261119111432-314F", "eventType": "TEST_ORDER_EVENT", "requested": 50, "accepted": 50, "failed": 0, "generatedAt": "…", "errors": [], "note": "Accepted = committed to the outbox…" } }
```

`accepted` counts events durably stored in the outbox. It does not mean they were processed.

### `POST /admin/testing/duplicate-delivery`

**Body:** `{ "eventId": "…", "copies": 2, "consumer": "payment" }`. `consumer` is optional; without it, the copies go to every subscriber of that event.

Publishes the stored event again with the **same eventId**.

**Responses**
- **200:** `data: { eventId, eventType, copies, deliveredTo[] }`
- **404** `EVENT_NOT_FOUND`
- **409** `EVENT_NOT_PUBLISHED`
- **400** `CONSUMER_NOT_SUBSCRIBED`
- **503** `BROKER_UNAVAILABLE`

### `POST /admin/testing/reset-test-data`

Deletes **only** synthetic data:
- test orders and payments
- test outbox events and processing records
- their reservations and notifications

**Responses**
- **200:** `data: { deleted: { processingRecords, outboxEvents, orders, payments, reservations, notifications } }`
- **409** `TEST_EVENTS_IN_FLIGHT`: test events are still being published or processed.

### `GET /admin/overview` (changed in Stage 3)

Synthetic test orders and the synthetic customer are excluded. The response now also includes `syntheticTestOrders`.
