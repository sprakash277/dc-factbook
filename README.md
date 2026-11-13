# DC Fact Book

A Databricks App that gives supply-chain leaders an instant, exec-friendly **single source of
truth for distribution centers**: an interactive US map of every DC, a per-site fact page
(address, leadership, square footage by temperature zone, dock doors, automation, fleet,
building, documents), a persistent aerial/satellite view, and a Genie-powered
**"Ask about this site"** assistant.

Packaged as a **Databricks Asset Bundle (DAB)** so it deploys with one command.

---

## Repo layout

```
dc-factbook/
├── databricks.yml                    # DAB definition: bundle, variables, targets
├── .databricksignore                 # keeps node_modules/ & data/ out of the app image (keeps dist/)
├── resources/
│   └── dc_factbook_app.app.yml        # the `apps` resource: name, source, env, warehouse + genie grants
├── app/                              # ← everything under here is the deployed app (source_code_path)
│   ├── app.yaml                       # runtime command (uvicorn) + default env
│   ├── requirements.txt               # Python deps installed by Databricks Apps
│   ├── backend/
│   │   ├── __init__.py
│   │   └── main.py                    # FastAPI: JSON API over dc_sites, edits, Genie, serves the SPA
│   └── frontend/                      # React + Vite SPA (dist/ is committed and served by the backend)
│       ├── src/App.jsx
│       ├── dist/                       # built bundle — served at runtime
│       ├── package.json
│       └── vite.config.js
└── data/                             # one-off setup / load scripts (run separately, NOT in the app image)
    ├── setup.py                       # create catalog/schema/volume/table + synthetic sites
    └── load_real.py                   # load the customer's real xlsx (points at a local file — not committed)
```

The backend serves the SPA from `app/frontend/dist`, so the frontend must be **built** before deploy.

---

## Prerequisites

- Databricks CLI ≥ 0.230 (`databricks version`) authenticated to your workspace
  (`databricks auth login --host https://<workspace-host>/ -p <profile>`).
- A SQL Warehouse, a Unity Catalog you can create tables in, and (optional) a Genie space.
- Node 20+ and Python 3.11+ for local frontend builds.

## 1. One-time data setup

```bash
export DATABRICKS_CONFIG_PROFILE=<profile>
export DATABRICKS_WAREHOUSE_ID=<warehouse-id>

# synthetic demo data (recommended for a public/shared workspace):
python3 data/setup.py

# — or — load a real spreadsheet (edit the path at the top of the script first):
python3 data/load_real.py
```

This creates `dc_factbook.sites.dc_sites` (+ a `site_drawings` volume) and populates it. The
table schema matches what `backend/main.py` queries — keep the two in sync or `/api/sites`
returns a 500 "column not found".

**Grant the app's service principal.** Databricks Apps run as their own service principal, so it
needs access to the data or `/api/sites` will 500. Either set `APP_SERVICE_PRINCIPAL` before
running `setup.py` (it grants `USE CATALOG/SCHEMA` + `SELECT`/`MODIFY` on the table), or grant it
by hand after deploy. The app SP's application id is shown by
`databricks apps get <app-name> | jq -r .service_principal_client_id`. It also needs `CAN_USE` on
the SQL warehouse (the DAB's `sql-warehouse` app resource normally handles that).

## 2. Build the frontend

```bash
cd app/frontend
npm install --legacy-peer-deps
npm run build          # emits app/frontend/dist
cd ../..
```

## 3. Configure your target

Edit `databricks.yml` → `targets.dev` with your `profile`, `warehouse_id`, `catalog`,
`schema`, and `genie_space_id`. (An `e2demo` target is included as a working reference.)

## 4. Deploy the bundle

```bash
databricks bundle validate -t dev
databricks bundle deploy   -t dev      # uploads app/ and creates/updates the App resource
databricks bundle run dc_factbook_app -t dev   # starts the app; prints the URL
```

To redeploy after changing the UI: rebuild (`step 2`) then `databricks bundle deploy -t dev` again.

---

## Environment variables (read by `backend/main.py`)

| Var | Meaning |
|-----|---------|
| `DATABRICKS_WAREHOUSE_ID` | Warehouse for the JSON API, edits, and Genie SQL |
| `CATALOG` / `SCHEMA` | Location of the `dc_sites` table (default `dc_factbook` / `sites`) |
| `GENIE_SPACE_ID` | Genie space backing "Ask about this site" (optional; the tab degrades gracefully if unset) |

The DAB sets these from each target's `variables`; `app/app.yaml` carries defaults for a manual
`databricks apps deploy`.

---

## Data governance note

`data/load_real.py` loads a **customer-confidential** spreadsheet from a local path — that file is
**not** part of this repo and must never be committed. When using real customer data, deploy into a
**customer-owned workspace/catalog**, not a shared sandbox.
