# Deploying PeopleDesk on Amazon EC2 (Amazon Linux 2023)

This guide installs the application on **each** EC2 instance behind the Application Load Balancer. Every instance runs the same code and configuration and talks to the same Aurora cluster.

```
Internet → ALB (:80/:443) → EC2 AZ-A :3000 ┐
                          → EC2 AZ-B :3000 ┴→ Aurora MySQL cluster endpoint :3306
```

---

## 1. Prerequisites (AWS Console)

### 1.1 Security groups

| Security group | Inbound rule | Source |
| --- | --- | --- |
| `alb-sg` | TCP 80 (and 443 if using HTTPS) | `0.0.0.0/0` |
| `app-sg` | TCP **3000** | `alb-sg` |
| `app-sg` | TCP 22 (optional, prefer SSM Session Manager) | your IP |
| `aurora-sg` | TCP **3306** | `app-sg` |

The instances need outbound HTTPS to reach Secrets Manager, the package repositories and the RDS CA bundle. In private subnets, use a NAT gateway or VPC endpoints (`secretsmanager`, `ssm`).

### 1.2 Aurora MySQL cluster

- Engine: Aurora MySQL 3.x (MySQL 8.0 compatible)
- One **writer** plus at least one **Aurora replica** in a different AZ (this enables automatic failover)
- Private DB subnet group, `aurora-sg`, not publicly accessible
- Copy the **cluster (writer) endpoint**, e.g. `peopledesk.cluster-abc123xyz.eu-central-1.rds.amazonaws.com`

> Always use the cluster endpoint, never an instance endpoint. After a failover, the cluster endpoint's DNS points to the new writer automatically.

### 1.3 Database schema and application user

From any instance that can reach Aurora (after step 3, the installer has already installed the MariaDB client):

```bash
mysql -h <cluster-endpoint> -u admin -p < /opt/employee-management/database/schema.sql
```

Then create a least-privilege user for the app:

```sql
CREATE USER 'app_user'@'%' IDENTIFIED BY '<strong-password>';
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_management.* TO 'app_user'@'%';
```

The schema script is idempotent, so running it twice is harmless.

### 1.4 Secrets Manager secret

Create a secret of type **Other type of secret** (JSON), e.g. named `peopledesk/aurora`:

```json
{
  "username": "app_user",
  "password": "<strong-password>",
  "host": "peopledesk.cluster-abc123xyz.eu-central-1.rds.amazonaws.com",
  "port": 3306,
  "database": "employee_management"
}
```

CLI alternative:

```bash
aws secretsmanager create-secret --name peopledesk/aurora \
  --secret-string '{"username":"app_user","password":"<pw>","host":"<cluster-endpoint>","port":3306,"database":"employee_management"}'
```

### 1.5 IAM role for the EC2 instances

Create a role for EC2 (an instance profile) with this inline policy, and optionally `AmazonSSMManagedInstanceCore` for Session Manager:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadAuroraSecret",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:eu-central-1:<account-id>:secret:peopledesk/aurora-*"
    }
  ]
}
```

If the secret is encrypted with a customer-managed KMS key, also allow `kms:Decrypt` on that key.

### 1.6 Target group and ALB

| Setting | Value |
| --- | --- |
| Target type | Instances |
| Protocol / port | HTTP / **3000** |
| Health check path | **`/health`** |
| Success codes | `200` |
| Interval / timeout | 15 s / 5 s |
| Healthy / unhealthy threshold | 2 / 3 |
| Deregistration delay | 30 s (the app drains connections on SIGTERM) |
| Stickiness | **Disabled** (the app is stateless) |

Register both instances, one per AZ. Then create an internet-facing ALB in two public subnets with `alb-sg` and a listener on port 80 (or 443 with an ACM certificate) forwarding to the target group.

> Use `/health`, not `/ready`, for the target group. `/health` doesn't depend on the database, so a short Aurora failover won't make the ALB mark every instance unhealthy at the same time.

---

## 2. Launch the EC2 instances

- AMI: **Amazon Linux 2023**
- Type: `t3.micro` / `t3.small`
- One instance in a private (or public) subnet in **AZ-A**, one in **AZ-B**
- Security group: `app-sg`
- IAM instance profile: the role from step 1.5
- Metadata: IMDSv2 **required** (the app supports it)

---

## 3. Install the application

Connect with SSM Session Manager or SSH, then:

```bash
sudo dnf install -y git
git clone https://github.com/<your-username>/aurora-employee-management.git
cd aurora-employee-management

sudo AWS_REGION=eu-central-1 AWS_SECRET_NAME=peopledesk/aurora ./deployment/install.sh
```

The installer:

1. Installs Node.js 20, rsync and the MariaDB client
2. Creates the `nodeapp` system user
3. Copies `backend/`, `frontend/` and `database/` to `/opt/employee-management`
4. Runs `npm ci --omit=dev`
5. Downloads the Amazon RDS CA bundle for TLS
6. Writes `/etc/employee-management/app.env` (`root:nodeapp`, mode `0640`)
7. Installs and enables the `employee-management` systemd service
8. Verifies `/health` and `/ready` on localhost

### Installer variables

| Variable | Default | Description |
| --- | --- | --- |
| `AWS_REGION` | auto-detected from IMDS | Region of the secret |
| `AWS_SECRET_NAME` | – | Secrets Manager secret name or ARN (**recommended**) |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | – | Only if not using Secrets Manager (`DB_HOST` = cluster endpoint) |
| `PORT` | `3000` | Must match the target group port |
| `DB_SSL` | `true` | TLS to Aurora using the RDS CA bundle |
| `DB_POOL_SIZE` | `10` | Connections per instance |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `INSTALL_DB_CLIENT` | `true` | Install the MariaDB client |
| `FORCE_ENV` | `false` | Regenerate an existing `app.env` |

### Fully automated: EC2 user data

Paste this into **Advanced details → User data** when launching instances (or in a launch template for an Auto Scaling group):

```bash
#!/bin/bash
set -euxo pipefail
dnf install -y git
git clone https://github.com/<your-username>/aurora-employee-management.git /opt/src/peopledesk
cd /opt/src/peopledesk
AWS_SECRET_NAME=peopledesk/aurora ./deployment/install.sh
```

---

## 4. Runtime environment variables

Stored in `/etc/employee-management/app.env` and loaded by systemd:

| Variable | Example | Notes |
| --- | --- | --- |
| `NODE_ENV` | `production` | |
| `PORT` | `3000` | |
| `AWS_REGION` | `eu-central-1` | Required with `AWS_SECRET_NAME` |
| `AWS_SECRET_NAME` | `peopledesk/aurora` | Enables Secrets Manager mode |
| `DB_HOST` | `*.cluster-*.rds.amazonaws.com` | Fallback when the secret has no `host` |
| `DB_SSL` / `DB_SSL_CA_PATH` | `true` / `/opt/employee-management/certs/rds-global-bundle.pem` | |
| `DB_POOL_SIZE` | `10` | |
| `DB_CONNECT_TIMEOUT_MS` | `5000` | |
| `DB_QUERY_RETRIES` | `3` | Retries for transient errors and failover |

After editing: `sudo systemctl restart employee-management`

---

## 5. Verify

On the instance:

```bash
curl -s localhost:3000/health          # {"status":"ok",...}
curl -s localhost:3000/ready           # {"status":"ready","database":{"status":"connected",...}}
curl -s localhost:3000/api/dashboard
```

Through the load balancer:

```bash
ALB=http://<alb-dns-name>
for i in $(seq 1 10); do curl -s -o /dev/null -D - $ALB/health | grep -i x-served-by; done
```

The `X-Served-By` header should alternate between the two instance IDs and AZs. In the browser, open **System Status → Run test** to see the same distribution.

---

## 6. Operations

```bash
sudo systemctl status employee-management       # service state
sudo journalctl -u employee-management -f       # live JSON logs
sudo systemctl restart employee-management      # restart

# Deploy a new version (repeat on each instance, one at a time, for zero downtime)
cd ~/aurora-employee-management && git pull
sudo ./deployment/install.sh                    # keeps the existing app.env
```

Optionally ship logs to CloudWatch with the CloudWatch agent (collect from journald or `/var/log/messages`).

---

## 7. High availability tests

| Test | How | Expected result |
| --- | --- | --- |
| Instance failure | Stop one instance | ALB marks it unhealthy after about 3 × 15 s; all traffic goes to the other AZ and the data is unchanged |
| Process crash | `sudo kill -9 $(pgrep -f "node server.js")` | systemd restarts it within 5 s |
| Aurora failover | RDS console → cluster → *Actions → Failover* | A few requests may return 503 for about 30 s; the app then reconnects to the new writer with no restart. `/health` stays 200 |
| Shared data | Create an employee, refresh repeatedly | The record appears regardless of which instance (see the badge) serves the page |

---

## 8. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Targets unhealthy, `curl localhost:3000/health` fails | Service not running: `journalctl -u employee-management -n 100` |
| Targets unhealthy, local `/health` OK | `app-sg` does not allow port 3000 from `alb-sg`, or the target group port/path is wrong |
| `/ready` 503 with `ETIMEDOUT` / `ECONNREFUSED` in logs | `aurora-sg` does not allow 3306 from `app-sg`, wrong endpoint, or different VPC |
| Logs show `CredentialsProviderError` | No IAM instance profile attached to the instance |
| Logs show `AccessDeniedException` | IAM policy is missing `secretsmanager:GetSecretValue` for the secret ARN (or `kms:Decrypt`) |
| Logs show `ResourceNotFoundException` | Wrong `AWS_SECRET_NAME` or `AWS_REGION` |
| Logs show `ER_ACCESS_DENIED_ERROR` | Wrong username/password in the secret, or the user lacks grants |
| `ER_BAD_DB_ERROR` | `database/schema.sql` has not been run |
| Writes fail with `ER_OPTION_PREVENTS_STATEMENT` | `DB_HOST` / secret `host` is a **reader** or instance endpoint; use the cluster endpoint |
| TLS errors (`self-signed certificate`) | Set `DB_SSL_CA_PATH` to the RDS global bundle, or re-run the installer |
