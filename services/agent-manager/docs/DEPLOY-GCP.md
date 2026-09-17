# Deploying Agent Manager on Google Cloud

**Goal:** Agent Manager on a public HTTPS URL the whole of Tap can open, with no
box to own and nobody's SSH key to wait for.

This is the alternative to `DEPLOY-AWS.md`, which is blocked on access to
Chauncey's EC2 instance. Cloud Run needs no host, no security group and no
second account — and it hands out TLS and a real hostname, which the AWS path
does not without more work.

Project **`agent-x-508719`**, service account
`claude-gc-service@agent-x-508719.iam.gserviceaccount.com`.

---

## Blocked, on one thing

**The project has no billing account.** Verified 17 Sep against the live
project:

```
$ gcloud storage buckets create gs://agent-x-508719-agent-manager
ERROR: HTTPError 403: The billing account for the owning project is
       disabled in state absent.

$ gcloud services enable run.googleapis.com artifactregistry.googleapis.com
ERROR: FAILED_PRECONDITION: Billing account for project '1073202030060'
       is not found.
```

It is **not a permissions problem** — `claude-gc-service` holds `roles/owner`
on the project, and it successfully enabled the APIs that do not require
billing (Cloud Resource Manager, Cloud Storage). Everything that needs billing
— Cloud Run, Artifact Registry, Cloud Build, Secret Manager, and creating any
bucket — fails before IAM is ever consulted.

Nothing in this repo can fix that. It is one action by a person who owns a
billing account:

> Console → **Billing** → *Link a billing account* → project `agent-x-508719`.
> <https://console.cloud.google.com/billing/linkedaccount?project=agent-x-508719>

Cloud Run's free tier covers this service comfortably; linking billing is not
the same as spending. Once linked, everything below runs unattended.

---

## The deploy

One script, idempotent, and re-running it is how you ship a new revision:

```bash
./deploy/gcp.sh
```

It enables the APIs, creates the Artifact Registry repo, the GCS bucket, a
runtime service account, and two secrets; builds the image with Cloud Build;
and deploys the Cloud Run service. Defaults are overridable by environment
(`PROJECT`, `REGION`, `SERVICE`, `BUCKET`, `BOOTSTRAP_ADMINS`).

### Then, once: create the shared login

```bash
URL="$(gcloud run services describe agent-manager --region=us-central1 --format='value(status.url)')"
KEY="$(gcloud secrets versions access latest --secret=agent-manager-service-api-key)"

curl -s -X POST "$URL/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "x-api-key: $KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_user",
       "arguments":{"id":"admin","password":"Tapadmin@123","display_name":"Tap Admin",
       "roles":["chef","head-chef","admin"]}}}'
```

Same caveat as the AWS path: `admin` / `Tapadmin@123` is a shared account, so
it is also one shared view of the runs. **Change the password before the URL is
handed round.**

---

## Three things this path gets right that are worth knowing

### Storage is not the filesystem

Cloud Run has no disk that survives a revision, so `STORAGE_DRIVER=fs` would
drop the entire log on every deploy. The script sets `STORAGE_DRIVER=gcs` with
a bucket. `lib/storage/gcs.js` authenticates with Application Default
Credentials, which on Cloud Run is the attached service account — **no key file
and no credential in the environment**. The JSON key in Downloads is used to
*deploy*; it never reaches the running service.

The image ships without either cloud's SDK, so the build passes
`--build-arg STORAGE_SDK=@google-cloud/storage`. That is why the build goes
through `deploy/cloudbuild.yaml` rather than `gcloud builds submit --tag`,
which cannot pass a build arg. Without it the container starts and then throws
`STORAGE_DRIVER=gcs needs the Google Cloud Storage SDK`.

### `--max-instances=1` is not a cost setting

`lib/store.js` does read-modify-write against blob storage, and there is no
compare-and-swap in the four-method driver contract. Two instances writing the
same projection can silently lose one of the writes — exactly the class of
failure this product exists to expose. Pinning to one instance is correct until
that is addressed; raising it is a code change, not a flag change.

### The OAuth callback needs no configuration

Adobe redirects back to `<whatever the browser used>/mcp-connect/callback`.
`actions/mcp-connect/index.js` derives that from `x-forwarded-host` and
`x-forwarded-proto`, both of which Cloud Run sets, so the callback comes out as
`https://<service>-<hash>.run.app/mcp-connect/callback` on its own.
`MCP_CONNECT_REDIRECT_URI` stays unset unless a custom domain is put in front.

Unlike the EC2 path, the URL is public HTTPS from the first deploy, so the
Adobe sign-in can be done from anywhere — no security-group rule, no signing in
from the office.

---

## Pointing the harness at the gateway

Unchanged from `DEPLOY-AWS.md` except the URL — the harness reaches Agent
Manager over the public URL rather than `localhost`:

```bash
MCP_GATEWAY_URL=https://<service>.run.app/mcp
MCP_GATEWAY_HEADER=x-api-key
MCP_GATEWAY_TOKEN=<gcloud secrets versions access latest --secret=agent-manager-service-api-key>
```

`MCP_GATEWAY_ROUTES`, `WORKFRONT_MCP_FLAVOUR`, `WORKFRONT_INTAKE_QUEUE` and
`MCP_ENDPOINT_URL` are all exactly as documented in `DEPLOY-AWS.md`.

## Connecting Claude Desktop

```json
{
  "mcpServers": {
    "agent-manager": {
      "command": "npx",
      "args": ["-y", "mcp-remote",
               "https://<service>.run.app/mcp",
               "--header", "x-cookbook-login:YOUR_ID:YOUR_PASSWORD"]
    }
  }
}
```

Quit Claude Desktop completely and reopen; the config is read only at startup.

## Keeping the jobs running

Cron on the old host, HTTP endpoints here, so Cloud Scheduler drives them:

```bash
URL="$(gcloud run services describe agent-manager --region=us-central1 --format='value(status.url)')"
TOKEN="$(gcloud secrets versions access latest --secret=agent-manager-internal-token)"

gcloud scheduler jobs create http agent-manager-purge \
  --location=us-central1 --schedule="0 3 * * *" \
  --uri="$URL/internal/purge" --http-method=POST \
  --headers="x-internal-token=$TOKEN"

gcloud scheduler jobs create http agent-manager-cx-refresh \
  --location=us-central1 --schedule="0 4 * * *" \
  --uri="$URL/internal/cx-refresh" --http-method=POST \
  --headers="x-internal-token=$TOKEN"
```

---

## What is verified, and what is not

**Verified locally, 17 Sep:**
- The image builds with `--build-arg STORAGE_SDK=@google-cloud/storage`
- It boots and answers `/healthz` with `{"ok":true,"storage":"fs"}`
- `@google-cloud/storage` loads inside the image
- The GCS driver fails closed and legibly without `STORAGE_BUCKET`

**Verified against the live project, 17 Sep:**
- The service account authenticates and holds `roles/owner`
- It can enable APIs — Cloud Resource Manager and Cloud Storage were enabled
- Billing is absent, and blocks every remaining step

**Not verified, because billing blocks it:** the Cloud Run deploy itself, the
GCS driver against a real bucket, and the Adobe OAuth round trip on a
`.run.app` host.

The two upstream problems in `DEPLOY-AWS.md` — Workfront's tools returning
nothing, and Agent 1 calling `search_knowledge_base` instead of
`search_adobe_knowledge` — are unchanged by moving cloud. Both are still
Chauncey's, and both are still worth doing before any demo.
