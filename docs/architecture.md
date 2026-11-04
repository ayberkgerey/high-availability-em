# PeopleDesk Architecture

## 1. AWS deployment topology

```
                         Internet
                            │
                ┌───────────▼────────────┐
                │ Application Load        │  public subnets (AZ-A, AZ-B)
                │ Balancer  :80 / :443    │  health check: GET /health
                └─────┬─────────────┬─────┘
                      │             │      round-robin per request, no sticky sessions
         ┌────────────▼───┐   ┌─────▼──────────┐
         │ EC2  (AZ-A)    │   │ EC2  (AZ-B)    │  private app subnets
         │ Node.js :3000  │   │ Node.js :3000  │  systemd: employee-management
         │ Express + UI   │   │ Express + UI   │  IAM role → Secrets Manager
         └────────┬───────┘   └───────┬────────┘
                  │  mysql2 pool (TLS) │
                  └─────────┬──────────┘
                            │  Aurora CLUSTER endpoint (DNS → current writer)
              ┌─────────────▼──────────────────┐
              │ Amazon Aurora MySQL cluster    │  private DB subnets
              │  Writer (AZ-A) ◄─► Replica (AZ-B)  shared cluster storage (6 copies / 3 AZs)
              └────────────────────────────────┘
```

| Layer | Responsibility | HA mechanism |
| --- | --- | --- |
| ALB | Single public entry point, spreads requests across healthy targets | Multi-AZ by design; removes targets that fail `/health` |
| EC2 (Node.js) | Serves the static UI and the REST API | ≥ 2 instances in different AZs, stateless, systemd auto-restart (an Auto Scaling group is optional) |
| Aurora MySQL | Single source of truth for all employee data | Writer + replica in different AZs; automatic failover promotes the replica |
| Secrets Manager | Holds DB credentials | Regional service; read by the app through the instance IAM role |

## 2. Application architecture

```
frontend/ (static, served by Express)
  index.html ── css/styles.css ── js/app.js   →  fetch('/api/...')   (relative paths only)

backend/
  server.js                 HTTP server, keep-alive tuning, graceful shutdown, DB warm-up
  src/app.js                Express app: request context → health → helmet/compression/json → /api → static
  src/routes/               URL → controller mapping
  src/controllers/          HTTP concerns (status codes, headers, CSV)
  src/validation/           Input validation & normalization (body, query, ids)
  src/services/             Business logic + parameterized SQL
  src/db/pool.js            mysql2 pool, retries, failover handling, credential refresh
  src/config/               Env configuration + Secrets Manager loader
  src/middleware/           async handler, request id/logging, centralized error handler
```

Request flow: `ALB → Express → requestContext (request id, X-Served-By, access log) → route → controller → validation → service → db/pool.query() → Aurora`. Errors go to `errorHandler`, which maps them to a safe JSON response.

## 3. Stateless design

Any instance can serve any request:

- **No server-side sessions** and no sticky sessions; every request carries everything it needs.
- **No employee data in memory or on disk.** Every read and write goes to Aurora. The only per-process caches hold the instance's own metadata (instance ID, AZ) and the DB credentials.
- **No local files** for data: no SQLite, no JSON files, no uploads.
- **No hardcoded addresses.** The frontend uses relative URLs; the backend reads the DB endpoint from Secrets Manager or the environment.

So instances can be added, replaced or terminated at any time. Users never notice which instance served them, and the System Status page shows this.

## 4. Database design

```
departments                         employees
───────────────────────────         ───────────────────────────────────────────
id           INT UNSIGNED PK        id              BIGINT UNSIGNED PK AUTO_INCREMENT
name         VARCHAR(100) UNIQUE ◄──department      VARCHAR(100) NOT NULL  (FK, ON UPDATE CASCADE)
description  VARCHAR(255)           first_name      VARCHAR(100)
created_at   TIMESTAMP              last_name       VARCHAR(100)
updated_at   TIMESTAMP              email           VARCHAR(255) UNIQUE
                                    job_title       VARCHAR(150)
                                    employment_type ENUM('Full-time','Part-time','Contract')
                                    status          ENUM('Active','On Leave','Inactive')
                                    salary          DECIMAL(10,2) CHECK (salary >= 0)
                                    hire_date       DATE
                                    location        VARCHAR(150)
                                    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                    updated_at      TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
```

- `departments` is a lookup table. The foreign key on `employees.department` stops typos from creating "phantom" departments. Because it references the name rather than an id, the `employees.department` column stays readable as specified, and `ON UPDATE CASCADE` lets a department be renamed in one place.
- Indexes: `uq_employees_email` (uniqueness and email lookups), `(department, status)` for the filters and dashboard, `status`, `(last_name, first_name)` for name sorting, and `hire_date` for date sorting and recent hires.
- `utf8mb4` / `utf8mb4_unicode_ci` handles international names and works on Aurora MySQL 2 and 3.
- All SQL is parameterized (`?` placeholders, mysql2 prepared statements). `ORDER BY` uses a whitelist map, never user input.

## 5. Resilience and Aurora failover

What happens during an Aurora failover (typically about 30 seconds):

1. The writer becomes unreachable, or is demoted to a reader. The cluster endpoint's DNS record (TTL 5 s) moves to the promoted replica.
2. In-flight queries fail with errors such as `ECONNRESET`, `PROTOCOL_CONNECTION_LOST` or `ER_OPTION_PREVENTS_STATEMENT` (read-only).
3. `db/pool.js` handles them as follows:
   - **Broken or read-only connections are destroyed**, never returned to the pool. A fresh connection re-resolves DNS and reaches the new writer.
   - **Retries with exponential backoff** (250 ms, 500 ms, 1 s… capped at 4 s; `DB_QUERY_RETRIES`, default 3).
     - Connect-phase errors (`ECONNREFUSED`, `ENOTFOUND`, read-only…) are retried for every query, because the statement never ran.
     - Mid-flight errors are retried **only for reads**. A write that lost its connection may already have committed, so it is not replayed blindly.
   - If retries run out, the API returns **503 `DATABASE_UNAVAILABLE`** with `Retry-After: 5`, and the UI shows a friendly retry message.
4. `/health` stays green throughout, so the ALB keeps the instances in service. Pulling every instance because of a shared database problem would turn a 30-second blip into a full outage. `/ready` reports 503, which you can use for alarms or deployment checks.
5. When Aurora is back, the next request opens new connections automatically. No process restart is needed.

Other resilience features:

| Concern | Mechanism |
| --- | --- |
| DB down at boot | Server starts anyway; the pool is created lazily and warm-up failures are only logged |
| Secret rotation | On `ER_ACCESS_DENIED_ERROR` the secret is re-read (at most every 30 s) and the pool rebuilt |
| Pool exhaustion | `connectionLimit` 10 per instance, `queueLimit` 100; excess requests fail fast with 503 |
| Stale idle connections | `enableKeepAlive`, `idleTimeout` 60 s, `maxIdle` 5 |
| ALB 502s from keep-alive races | `server.keepAliveTimeout` 65 s, longer than the ALB idle timeout (60 s) |
| Deployments / scale-in | SIGTERM → stop accepting connections, drain in-flight requests, close pool (≤ 15 s) |
| Process crash | `uncaughtException` → exit; systemd `Restart=always` brings it back in 5 s |

**Pool sizing:** total connections = instances × `DB_POOL_SIZE`. With 2–4 instances × 10 connections, even a `db.t3.medium` Aurora instance (about 90 `max_connections`) has headroom.

## 6. Security

- **Network:** ALB SG allows 80/443 from the internet. App SG allows the app port **only from the ALB SG**. Aurora SG allows 3306 **only from the app SG**. Aurora sits in private subnets and is not publicly accessible.
- **Credentials:** stored in AWS Secrets Manager and fetched with the EC2 instance role (`secretsmanager:GetSecretValue` on one secret ARN). There are no access keys on disk. `/etc/employee-management/app.env` is `root:nodeapp 0640`.
- **Least-privilege DB user:** `app_user` has only `SELECT, INSERT, UPDATE, DELETE` on `employee_management.*`.
- **Transport:** TLS to Aurora (`DB_SSL=true`, RDS CA bundle); HTTPS on the ALB with ACM is recommended.
- **App hardening:** Helmet (CSP with `script-src 'self'`, `frame-ancestors 'none'`, nosniff…), 50 KB JSON body limit, strict validation, parameterized SQL, HTML escaping on the client, CSV formula-injection protection, and generic error messages.
- **Runtime:** a dedicated non-login `nodeapp` user, plus systemd sandboxing (`ProtectSystem=strict`, `NoNewPrivileges`, `PrivateTmp`…).
- **IMDSv2 only:** the app uses session tokens, so you can set the instance metadata option *HttpTokens = required*.
