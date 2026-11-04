# PeopleDesk API Documentation

Base URL: relative to wherever the app is served (e.g. `http://<alb-dns-name>`). The frontend only uses relative paths such as `/api/employees`, so the API works the same behind any load balancer, instance or domain.

- Content type: `application/json` (UTF-8)
- All `/api/*` responses include `Cache-Control: no-store`
- Every response includes `X-Request-Id` (reuses the ALB `X-Amzn-Trace-Id` when present) and `X-Served-By` (instance ID and AZ on EC2)

## Error format

All errors share one envelope. Internal details (SQL, stack traces, hostnames, credentials) are never returned; they are logged server-side with the same `requestId`.

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Employee data is invalid",
    "details": [{ "field": "email", "message": "Email must be a valid email address" }],
    "requestId": "2f7c1d0e-6a7b-4d0b-9a55-0f7a1f6c2d11"
  }
}
```

| HTTP | `code`                 | When                                                        |
| ---- | ---------------------- | ----------------------------------------------------------- |
| 400  | `VALIDATION_ERROR`     | Invalid body, query string or id; unknown department        |
| 400  | `INVALID_JSON`         | Malformed JSON body                                         |
| 404  | `NOT_FOUND`            | Employee or route does not exist                            |
| 409  | `CONFLICT`             | Email already belongs to another employee                   |
| 413  | `PAYLOAD_TOO_LARGE`    | Body larger than 50 KB                                      |
| 503  | `DATABASE_UNAVAILABLE` | Aurora unreachable after retries (sent with `Retry-After: 5`) |
| 500  | `INTERNAL_ERROR`       | Unexpected server error                                     |

## Employee object

```json
{
  "id": 12,
  "firstName": "Harper",
  "lastName": "Lindqvist",
  "fullName": "Harper Lindqvist",
  "email": "harper.lindqvist@peopledesk.io",
  "jobTitle": "Lead Product Designer",
  "department": "Design",
  "employmentType": "Full-time",
  "status": "Active",
  "salary": 146000,
  "hireDate": "2019-11-18",
  "location": "Stockholm, Sweden",
  "createdAt": "2026-10-31T19:43:18.000Z",
  "updatedAt": "2026-10-31T19:43:18.000Z"
}
```

### Validation rules (POST and PUT)

| Field            | Rules                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| `firstName`      | required, 1–100 chars, letters / spaces / `'` / `.` / `-`                |
| `lastName`       | required, 1–100 chars, letters / spaces / `'` / `.` / `-`                |
| `email`          | required, valid email, max 255 chars, unique (stored lower-case)         |
| `jobTitle`       | required, 2–150 chars                                                    |
| `department`     | required, must be an existing department name (see `/api/departments`)   |
| `employmentType` | `Full-time` \| `Part-time` \| `Contract`                                 |
| `status`         | `Active` \| `On Leave` \| `Inactive`                                     |
| `hireDate`       | `YYYY-MM-DD`, real calendar date between 1950-01-01 and one year from today |
| `location`       | required, 2–150 chars                                                    |
| `salary`         | number (or numeric string), 0 – 99,999,999.99, max 2 decimals            |

---

## Health

### `GET /health`

Liveness check for the **ALB target group**. Returns 200 whenever the Node.js process can serve HTTP. It **never** touches the database, so an Aurora failover does not cause the ALB to drain every instance at once.

```json
{ "status": "ok", "uptimeSeconds": 5321, "timestamp": "2026-10-31T19:50:00.000Z" }
```

### `GET /ready`

Readiness check. Runs `SELECT 1` against Aurora with a 3-second timeout (`DB_READY_TIMEOUT_MS`).

`200 OK`
```json
{
  "status": "ready",
  "database": { "status": "connected", "latencyMs": 2, "role": "writer" },
  "timestamp": "2026-10-31T19:50:00.000Z"
}
```

`503 Service Unavailable`
```json
{ "status": "not_ready", "database": { "status": "unavailable" }, "timestamp": "2026-10-31T19:50:00.000Z" }
```

`role` is `reader` if the connection landed on a read-only instance (`@@innodb_read_only = 1`). That should never happen when `DB_HOST` is the cluster endpoint.

---

## Dashboard

### `GET /api/dashboard`

```json
{
  "data": {
    "totalEmployees": 34,
    "activeEmployees": 29,
    "employeesOnLeave": 3,
    "inactiveEmployees": 2,
    "totalDepartments": 10,
    "departmentBreakdown": [{ "department": "Engineering", "headcount": 8 }],
    "recentHires": [
      { "id": 34, "fullName": "Aria Hosseini", "jobTitle": "Privacy & Compliance Counsel", "department": "Legal", "hireDate": "2025-01-06" }
    ]
  }
}
```

## Departments

### `GET /api/departments`

```json
{
  "data": [
    { "id": 1, "name": "Engineering", "description": "Builds and operates the PeopleDesk platform", "employeeCount": 8, "activeCount": 7 }
  ]
}
```

## Instance

### `GET /api/instance`

Shows which EC2 instance handled the request (from IMDSv2, cached per process). The UI uses it for the instance badge and the load balancer distribution test.

```json
{
  "data": {
    "hostname": "ip-10-0-11-24.eu-central-1.compute.internal",
    "platform": "ec2",
    "nodeVersion": "v20.18.1",
    "instanceId": "i-0a1b2c3d4e5f67890",
    "availabilityZone": "eu-central-1a",
    "instanceType": "t3.micro",
    "privateIp": "10.0.11.24",
    "uptimeSeconds": 5321
  }
}
```

---

## Employees

### `GET /api/employees`

| Query param  | Type    | Default | Description                                                      |
| ------------ | ------- | ------- | ---------------------------------------------------------------- |
| `search`     | string  | –       | Case-insensitive match on full name, email or job title (max 100) |
| `department` | string  | –       | Exact department name                                            |
| `status`     | string  | –       | `Active` \| `On Leave` \| `Inactive`                             |
| `sortBy`     | string  | `name`  | `name` (last, first) \| `hireDate` \| `createdAt`                |
| `sortOrder`  | string  | `asc`   | `asc` \| `desc`                                                  |
| `page`       | integer | `1`     | 1-based page number                                              |
| `pageSize`   | integer | `10`    | 1–100                                                            |

```bash
curl "http://localhost:3000/api/employees?search=engineer&department=Engineering&status=Active&sortBy=hireDate&sortOrder=desc&page=1&pageSize=10"
```

```json
{
  "data": [ { "...": "Employee object" } ],
  "pagination": { "page": 1, "pageSize": 10, "total": 7, "totalPages": 1 }
}
```

### `GET /api/employees/export`

Same filters and sorting as the list endpoint, without pagination (capped at 10,000 rows). Returns `text/csv` as an attachment named `employees-YYYY-MM-DD.csv`. Cells that start with `=`, `+`, `-` or `@` are prefixed with `'` to prevent spreadsheet formula injection.

### `GET /api/employees/:id`

`200` → `{ "data": Employee }` · `400` invalid id · `404` not found

### `POST /api/employees`

```bash
curl -X POST http://localhost:3000/api/employees \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Ayla",
    "lastName": "Kaya",
    "email": "ayla.kaya@peopledesk.io",
    "jobTitle": "Solutions Architect",
    "department": "Engineering",
    "employmentType": "Full-time",
    "status": "Active",
    "hireDate": "2026-11-02",
    "location": "Istanbul, Turkey",
    "salary": 145000
  }'
```

`201 Created` with a `Location: /api/employees/{id}` header → `{ "data": Employee }` · `400` · `409`

### `PUT /api/employees/:id`

Full replacement: send every field, same body and rules as POST.

`200` → `{ "data": Employee }` · `400` · `404` · `409`

### `DELETE /api/employees/:id`

`204 No Content` · `400` · `404`
