# Getting started — TAP Company Cookbook

The Cookbook is a shared, cross-AI knowledge store: your AI assistant captures its work
(recipes = tasks, ingredients = steps), you approve what's worth keeping, and approved work can
be admitted into a company-wide Knowledge Graph everyone can reuse. This guide shows how to
**connect your AI client** and **use the dashboard**.

- **Dashboard (stage):** https://110557-tapmcpconnector-stage.adobeio-static.net/index.html
- **MCP endpoint:** `https://110557-tapmcpconnector-stage.adobeioruntime.net/api/v1/web/tap-mcp-connector/mcp-server`

---

## 1. Access today (interim) vs. per-user sign-in (rolling out)

Authentication is enforced — the endpoint rejects unauthenticated calls. Two ways in:

| | How you connect | Identity you get |
|---|---|---|
| **Interim (today)** | Dashboard: a shared **access code**. MCP client: a shared **API key**. | Everyone shares one `service-account` identity. |
| **Per-user (rolling out)** | Sign in with your own account (Adobe IMS or Auth0) via OAuth. | Your **own** identity — your data is private to you. |

Per-user sign-in flips on the moment an admin provisions a provider client id (see
`docs/ims-auth-setup.md` / `knowledge/AUTH-PROVIDER-SPIKE.md`). Until then, use the interim path.

---

## 2. Open the dashboard

1. Go to the dashboard URL above.
2. If prompted **"Cookbook is locked,"** enter the access code (ask your admin — interim stopgap).
3. You'll land on **Home / My Work**. Panels: Projects, Work Log, Active Tasks, Cookbook,
   Knowledge Graph, Company CX Graph, Settings.

Once per-user sign-in is live, instead of the code you'll see **"Sign in with Adobe"** and land
in *your* private view.

---

## 3. Connect your AI client (MCP)

### Claude Desktop / Claude Code (CLI) — interim (shared key)
Add to your MCP config (`~/.claude.json` for Claude Code):
```json
{
  "mcpServers": {
    "company-cookbook": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://110557-tapmcpconnector-stage.adobeioruntime.net/api/v1/web/tap-mcp-connector/mcp-server",
        "--header", "x-api-key:${COOKBOOK_KEY}"
      ],
      "env": { "COOKBOOK_KEY": "<ask your admin for the key>" }
    }
  }
}
```
Restart the client; you should see the `company-cookbook` tools available.

### Claude.ai (web / desktop) — per-user sign-in (once a provider client exists)
**Settings → Connectors → Add custom connector**, paste the MCP endpoint URL. When your admin has
registered a provider client, Claude will run an OAuth sign-in (Adobe ID or Auth0) — no key. If
the provider is confidential, paste the client id/secret under **Advanced**.

### Claude Code (CLI) — per-user sign-in (once a provider client exists)
Drop the `--header x-api-key:…` line so `mcp-remote` performs OAuth. This needs a **public**
provider app whose **loopback** callback (`http://localhost:<port>/oauth/callback`) is registered
(see the spike doc) — otherwise it can't complete sign-in.

---

## 4. The capture → approve → cookbook → CX-graph flow

1. **Work with your AI** — it calls `start_project` / `start_recipe` and `append_step`s its outputs
   (messages, code, decisions, diagrams). Everything is **experimental** by default and expires
   unless kept.
2. **Approve** the ingredients worth keeping (Work Log → per-ingredient approve/reject).
3. **Bake** a recipe (from Active Tasks) once it has ≥1 approved ingredient → it enters the
   **Cookbook** (approved-only, in order).
4. A **Head Chef** admits a baked recipe into the **Company CX Graph** (cross-owner, visible to
   all). Baking alone doesn't publish it — a Head Chef gates it.

**Privacy:** your experimental work is private to you; only approved + Head-Chef-admitted recipes
become visible company-wide. (Real per-user privacy is live once you sign in per-user; on the
shared key everyone is the one `service-account`.)

---

## 5. Roles (who can do what)

| Role | Can |
|---|---|
| **chef** (everyone) | capture, approve/bake their own recipes |
| **head-chef** | admit baked recipes into the Company CX Graph |
| **admin** | manage roles (Settings → Team/Roles), admin/all-owner views, edit settings, reset |

Admins assign roles in **Settings → Team / Roles** (multi-select chips per user). Roles bind to
your signed-in identity, so they take full effect with per-user sign-in.

---

## 6. Troubleshooting

- **401 / "locked":** you're unauthenticated — enter the dashboard access code, or check your MCP
  client is sending the key (or has completed sign-in).
- **mcp-remote won't connect keyless:** the provider client/redirect isn't provisioned yet — use
  the interim key, or ask your admin to finish provider setup (`knowledge/AUTH-PROVIDER-SPIKE.md`).
- **Can't see Team/Roles:** it's admin-only.
