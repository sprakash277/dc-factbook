"""DC Fact Book — a generic distribution-center / site directory app.

FastAPI backend that serves the React SPA and a JSON API over a site table in
Unity Catalog. All account-specific values (catalog/schema, warehouse, Genie
space, editors, branding) come from environment variables, so any account can
deploy this template unchanged. Writes (per-site edit / bulk xlsx|csv upload)
go through the Databricks SDK."""
from __future__ import annotations

import contextvars
import csv
import io
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

from databricks.sdk import WorkspaceClient
from fastapi import FastAPI, HTTPException, UploadFile, File, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s dcfactbook %(message)s")
log = logging.getLogger("dcfactbook")

CATALOG = os.environ.get("CATALOG", "dc_factbook")
SCHEMA = os.environ.get("SCHEMA", "sites")
TABLE = f"{CATALOG}.{SCHEMA}.dc_sites"
WAREHOUSE_ID = os.environ["DATABRICKS_WAREHOUSE_ID"]
GENIE_SPACE_ID = os.environ.get("GENIE_SPACE_ID", "")

# Branding — override per account without touching code.
APP_TITLE = os.environ.get("APP_TITLE", "DC Fact Book")
APP_SUBTITLE = os.environ.get("APP_SUBTITLE", "Distribution Network Directory")

# Write-access allowlist (comma-separated emails). "*" or unset = everyone can edit
# (fine for a local dev run; the deployed app sets an explicit allowlist).
EDITORS = [e.strip().lower() for e in os.environ.get("EDITORS", "*").split(",") if e.strip()]


def _email(request: Request) -> str:
    h = request.headers
    return (h.get("x-forwarded-email") or h.get("x-forwarded-preferred-username") or "").strip().lower()


def _can_edit(request: Request) -> bool:
    if not EDITORS or "*" in EDITORS:
        return True
    return _email(request) in EDITORS


ADMIN_TABLE = f"{CATALOG}.{SCHEMA}.sites_admin"
ADMIN_GROUP = "admins"  # Databricks workspace admin group
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def _user_token(request: Request) -> str:
    return (request.headers.get("x-forwarded-access-token") or "").strip()


def _is_workspace_admin(request: Request) -> bool:
    """True if the signed-in user is in the workspace 'admins' group (checked with their own token)."""
    tok = _user_token(request)
    if not tok:
        return False
    try:
        from databricks.sdk.core import Config
        me = WorkspaceClient(config=Config(host=w.config.host, token=tok, auth_type="pat")).current_user.me()
        return any(str(g.display or "").lower() == ADMIN_GROUP for g in (me.groups or []))
    except Exception as e:  # noqa: BLE001
        log.warning("workspace admin check failed: %s", type(e).__name__)
        return False


def _table_admin(email: str) -> bool:
    """True if sites_admin has this email with is_site_admin = true. Missing table = no table admins."""
    try:
        return bool(_rows(f"SELECT user_email FROM {ADMIN_TABLE} "
                          f"WHERE lower(user_email) = {_esc(email)} AND is_site_admin = true LIMIT 1"))
    except HTTPException:
        return False


def _is_admin(request: Request) -> bool:
    email = _email(request)
    if not email:
        return False
    if EDITORS and "*" not in EDITORS and email in EDITORS:  # bootstrap: explicit editors are admins
        return True
    return _table_admin(email) or _is_workspace_admin(request)


def _require_admin(request: Request) -> str:
    if not _is_admin(request):
        raise HTTPException(status_code=403, detail="Admins only.")
    return _email(request)


def _require_editor(request: Request) -> str:
    who = _email(request)
    if not (_can_edit(request) or _is_admin(request)):
        log.warning("edit denied for %r", who or "(anonymous)")
        raise HTTPException(status_code=403, detail="You have view-only access. Ask an admin to add you to the editors list.")
    return who or "app-user"

# (excel col, snake_name, sql_type, is_hyperlink) — mirrors data/load_real.py
COLSPEC = [
 (2,"sce_owner","STRING",False),(3,"dc_plant","STRING",False),(4,"whs_plt_no","STRING",False),
 (5,"location_name","STRING",False),(6,"region","STRING",False),(7,"products","STRING",False),
 (8,"divisions_serviced","STRING",False),(9,"vice_president","STRING",False),(10,"regional_director","STRING",False),
 (11,"site_leaders","STRING",False),(12,"transportation_managers","STRING",False),(13,"street_address","STRING",False),
 (14,"city","STRING",False),(15,"state","STRING",False),(16,"zip","STRING",False),
 (17,"google_earth_url","STRING",True),(18,"total_acreage","DOUBLE",False),(19,"expansion_space","STRING",False),
 (20,"lease_vs_own","STRING",False),(21,"frozen_sqft","BIGINT",False),(22,"refrigerated_sqft","BIGINT",False),
 (23,"ambient_sqft","BIGINT",False),(24,"ciw_fdic_gm_sqft","BIGINT",False),(25,"total_sqft","BIGINT",False),
 (26,"dock_doors_ambient","INT",False),(27,"dock_doors_perishable","INT",False),(28,"dock_doors_frozen","INT",False),
 (29,"automation_vendor","STRING",False),(30,"whs_union","STRING",False),(31,"whs_operation","STRING",False),
 (32,"trans_union","STRING",False),(33,"transportation","STRING",False),(34,"transportation_operator","STRING",False),
 (35,"tractor_total","INT",False),(36,"trailer_total","INT",False),(37,"associate_total","INT",False),
 (38,"banana_room_count","INT",False),(39,"fuel_lanes","INT",False),(40,"vmf_bays","INT",False),
 (41,"building_open_year","INT",False),(42,"function_local_regional","STRING",False),(43,"total_stores_serviced","INT",False),
 (44,"site_plan_url","STRING",True),(45,"building_plan_url","STRING",True),(46,"building_plan_temp_zone_url","STRING",True),
 (47,"aerial_photo_url","STRING",True),(48,"link_to_files2_url","STRING",True),
]
ALL_COLS = ["site_id"] + [n for _, n, _, _ in COLSPEC] + ["lat", "lon", "area"]
TYPE = {"site_id": "STRING", "lat": "DOUBLE", "lon": "DOUBLE", "area": "STRING", **{n: t for _, n, t, _ in COLSPEC}}
NUMERIC = {n for n, t in TYPE.items() if t in ("DOUBLE", "BIGINT", "INT")}
EDITABLE = [n for n in ALL_COLS if n not in ("site_id", "lat", "lon", "google_earth_url")]
LIST_COLS = ("site_id, location_name AS name, 'DC' AS site_type, city, state, region, area, lat, lon, "
             "total_sqft, expansion_space, products, divisions_serviced, automation_vendor, "
             "whs_union, function_local_regional")
LATLON = re.compile(r"@(-?\d+\.\d+),(-?\d+\.\d+)")

app = FastAPI(title="DC Fact Book")
w = WorkspaceClient()


# The signed-in user's token for the current request, set by the middleware below.
_user_tok: contextvars.ContextVar[str] = contextvars.ContextVar("user_tok", default="")


@app.middleware("http")
async def _capture_user_token(request: Request, call_next):
    _user_tok.set((request.headers.get("x-forwarded-access-token") or "").strip())
    return await call_next(request)


def _sql_client() -> WorkspaceClient:
    """SQL runs as the signed-in user (their permissions apply). Falls back to the app's service
    principal only when no user token is forwarded, e.g. local development."""
    tok = _user_tok.get()
    if tok:
        from databricks.sdk.core import Config
        return WorkspaceClient(config=Config(host=w.config.host, token=tok, auth_type="pat"))
    log.warning("no user token on request; using the app service principal")
    return w


def _run(sql: str):
    c = _sql_client()
    try:
        r = c.statement_execution.execute_statement(warehouse_id=WAREHOUSE_ID, statement=sql, wait_timeout="50s")
        waited = 0
        while r.status and r.status.state and r.status.state.value in ("PENDING", "RUNNING") and waited < 120:
            time.sleep(2); waited += 2
            r = c.statement_execution.get_statement(r.statement_id)
    except Exception as e:  # SDK / auth / permission errors on the request itself
        msg = str(e)
        if "Invalid scope" in msg or "sql" in msg and "scope" in msg:
            raise HTTPException(status_code=403, detail="Your session isn't authorized for SQL yet. Sign out of the app and sign back in to re-authorize it, then try again.")
        raise HTTPException(status_code=403 if type(e).__name__ == "PermissionDenied" else 500,
                            detail=f"SQL request failed: {type(e).__name__}. Check your warehouse and table permissions.")
    st = r.status.state.value if r.status and r.status.state else "?"
    if st != "SUCCEEDED":
        msg = r.status.error.message if r.status and r.status.error else st
        raise HTTPException(status_code=500, detail=f"SQL failed: {msg}")
    return r


def _rows(sql: str) -> list[dict[str, Any]]:
    r = _run(sql)
    if not r.result or not r.result.data_array:
        return []
    names = [c.name for c in r.manifest.schema.columns]
    return [dict(zip(names, row)) for row in r.result.data_array]


def _esc(v: Any) -> str:
    if v is None or v == "":
        return "NULL"
    # Databricks SQL string literals treat backslash as an escape char, so escape
    # both backslash and single-quote before embedding.
    return "'" + str(v).replace("\\", "\\\\").replace("'", "''") + "'"


def _num(v: Any) -> str:
    if v is None or v == "":
        return "NULL"
    try:
        return str(float(str(v).replace(",", "").strip()))
    except (TypeError, ValueError):
        return "NULL"


def _cell(name: str, v: Any) -> str:
    return _num(v) if name in NUMERIC else _esc(v)


# ---------- API ----------

@app.get("/api/config")
def config() -> dict[str, Any]:
    """Branding + feature flags for the SPA, so any account can rebrand via env."""
    return {"title": APP_TITLE, "subtitle": APP_SUBTITLE, "genie": bool(GENIE_SPACE_ID)}


@app.get("/api/me")
def whoami(request: Request) -> dict[str, Any]:
    """Identity of the signed-in user, from the headers Databricks Apps inject at the proxy.
    Falls back gracefully in local dev where those headers are absent."""
    h = request.headers
    email = (h.get("x-forwarded-email") or h.get("x-forwarded-preferred-username") or "").strip()
    user = (h.get("x-forwarded-user") or "").strip()
    name = ""
    if email:
        local = email.split("@")[0]
        name = " ".join(p.capitalize() for p in re.split(r"[._\-]+", local) if p)
    is_admin = _is_admin(request)
    return {
        "email": email,
        "user": user,
        "name": name or email or "Signed-in user",
        "authenticated": bool(email or user),
        "is_admin": is_admin,
        "can_edit": _can_edit(request) or is_admin,
    }


@app.get("/api/sites")
def list_sites() -> list[dict[str, Any]]:
    try:
        return _rows(f"SELECT {LIST_COLS} FROM {TABLE} ORDER BY location_name")
    except Exception as e:  # table/catalog missing or warehouse unreachable
        logging.exception("list_sites failed for %s", TABLE)
        raise HTTPException(
            status_code=503,
            detail=f"Site data isn't available: could not query {TABLE}. "
                   f"Check that the catalog, schema and dc_sites table exist and the app can use the warehouse. ({type(e).__name__})",
        )


@app.get("/api/sites/{site_id}")
def site_detail(site_id: str) -> dict[str, Any]:
    rows = _rows(f"SELECT *, 'DC' AS site_type FROM {TABLE} WHERE site_id = {_esc(site_id)} LIMIT 1")
    if not rows:
        raise HTTPException(status_code=404, detail="Site not found")
    return rows[0]


class SiteEdit(BaseModel):
    fields: dict[str, Any]
    editor: str = "app-user"


@app.post("/api/sites/{site_id}")
def edit_site(site_id: str, body: SiteEdit, request: Request) -> dict[str, str]:
    who = _require_editor(request)
    sets = [f"{k} = {_cell(k, v)}" for k, v in body.fields.items() if k in EDITABLE]
    if not sets:
        raise HTTPException(status_code=400, detail="No editable fields provided")
    sets += [f"updated_by = {_esc(who)}", "updated_at = current_timestamp()"]
    _run(f"UPDATE {TABLE} SET {', '.join(sets)} WHERE site_id = {_esc(site_id)}")
    log.info("site %s edited by %s (%d fields)", site_id, who, len(sets) - 2)
    return {"status": "updated", "site_id": site_id}


def _slug(s: Any) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", str(s).lower())).strip("-") or "site"


def _records_from_xlsx(raw: bytes) -> list[dict[str, Any]]:
    """Parse the customer's two-row-header xlsx (hyperlink coords) into per-site records."""
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(raw))
    ws = wb["DCs"] if "DCs" in wb.sheetnames else wb.active
    out, seen = [], set()
    for r in range(3, ws.max_row + 1):
        if all(ws.cell(row=r, column=c).value in (None, "") for c, _, _, _ in COLSPEC):
            continue
        rec: dict[str, Any] = {}
        for c, name, _, is_link in COLSPEC:
            cell = ws.cell(row=r, column=c)
            rec[name] = ((cell.hyperlink.target if cell.hyperlink else None) or cell.value) if is_link else cell.value
        m = LATLON.search(str(rec.get("google_earth_url") or ""))
        rec["lat"], rec["lon"] = (float(m.group(1)), float(m.group(2))) if m else (None, None)
        sid = f"DC-{str(rec.get('whs_plt_no') or 'x').strip()}-{_slug(rec.get('location_name'))}"
        base, i = sid, 2
        while sid in seen:
            sid = f"{base}-{i}"; i += 1
        seen.add(sid); rec["site_id"] = sid
        out.append({n: rec.get(n) for n in ALL_COLS})
    return out


def _records_from_csv(raw: bytes) -> list[dict[str, Any]]:
    reader = csv.DictReader(io.StringIO(raw.decode("utf-8-sig")))
    incoming = list(reader)
    if not incoming or "site_id" not in (reader.fieldnames or []):
        raise HTTPException(status_code=400, detail="CSV must include a site_id column")
    return [{n: r.get(n) for n in ALL_COLS} for r in incoming]


def _parse_records(raw: bytes, filename: str) -> list[dict[str, Any]]:
    name = (filename or "").lower()
    try:
        recs = _records_from_xlsx(raw) if name.endswith((".xlsx", ".xlsm")) else _records_from_csv(raw)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Could not parse file: {e}")
    if not recs:
        raise HTTPException(status_code=400, detail="No data rows found")
    return recs


def _values_tuple(rec: dict[str, Any], types: dict[str, str] | None = None) -> str:
    if types is None:
        cells = [_cell(n, rec.get(n)) for n in ALL_COLS]
    else:  # table was created from inferred types: cast explicitly so ANSI mode accepts every value
        cells = [_esc(rec.get(n)) if types[n] == "STRING" else f"CAST({_num(rec.get(n))} AS {types[n]})" for n in ALL_COLS]
    return "(" + ",".join(cells) + ", current_timestamp(), 'upload')"


def _table_exists() -> bool:
    try:
        _rows(f"SELECT 1 FROM {TABLE} LIMIT 1")
        return True
    except HTTPException as e:
        # Only "not found" means the table is missing. Permission errors must surface, not trigger a create.
        if "TABLE_OR_VIEW_NOT_FOUND" in str(e.detail) or "cannot be found" in str(e.detail):
            return False
        raise


def _infer_types(recs: list[dict[str, Any]]) -> dict[str, str]:
    """Text columns stay STRING (zip codes, plant numbers, names). A numeric column becomes BIGINT if every
    value is a whole number, DOUBLE if every value is numeric, otherwise STRING. Empty columns keep the
    app's declared type."""
    out: dict[str, str] = {}
    for c in ALL_COLS:
        declared = TYPE.get(c, "STRING")
        if declared == "STRING":
            out[c] = "STRING"
            continue
        vals = [str(r.get(c)).replace(",", "").strip() for r in recs if r.get(c) not in (None, "")]
        if not vals:
            out[c] = declared
            continue
        try:
            nums = [float(v) for v in vals]
        except ValueError:
            out[c] = "STRING"
            continue
        whole = all(float(v).is_integer() and "." not in v for v in vals)
        out[c] = "BIGINT" if whole else "DOUBLE"
    return out


def _ensure_location() -> None:
    """Create the schema, and the catalog too if needed. Fails with a readable message if the app
    lacks the privilege to create them."""
    try:
        _run(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{SCHEMA}")
        return
    except HTTPException:
        pass
    try:
        _run(f"CREATE CATALOG IF NOT EXISTS {CATALOG}")
        _run(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{SCHEMA}")
    except HTTPException as e:
        raise HTTPException(
            status_code=400,
            detail=f"Catalog '{CATALOG}' / schema '{SCHEMA}' don't exist and the app couldn't create them "
                   f"({e.detail}). Ask a workspace admin to create them or grant the app CREATE privileges.",
        )


def _create_site_table(types: dict[str, str]) -> None:
    cols = ", ".join(f"{c} {types[c]}" for c in ALL_COLS)
    _run(f"CREATE TABLE IF NOT EXISTS {TABLE} ({cols}, updated_at TIMESTAMP, updated_by STRING) USING DELTA")


def _commit_records(recs: list[dict[str, Any]], who: str = "upload", create_if_missing: bool = True) -> tuple[int, bool]:
    if not recs:
        raise HTTPException(status_code=400, detail="No rows to load")
    if any(not str(r.get("site_id") or "").strip() for r in recs):
        raise HTTPException(status_code=400, detail="Every row must have a site_id")
    created, types = False, None
    if not _table_exists():
        if not create_if_missing:
            raise HTTPException(status_code=404, detail=f"{TABLE} doesn't exist. Tick 'Create the table if it doesn't exist' to create it from this file.")
        types = _infer_types(recs)
        _ensure_location()
        _create_site_table(types)
        created = True
        log.info("created %s with inferred types", TABLE)
    vals = [_values_tuple(r, types) for r in recs]
    # Atomic full replace: INSERT OVERWRITE is a single Delta transaction, so a failure
    # never leaves the table empty (and prior versions stay recoverable via time travel).
    _run(f"INSERT OVERWRITE {TABLE} ({', '.join(ALL_COLS)}, updated_at, updated_by) VALUES " + ",".join(vals))
    log.info("directory replaced with %d rows by %s", len(vals), who)
    return len(vals), created


@app.post("/api/upload/parse")
async def upload_parse(file: UploadFile = File(...), request: Request = None) -> dict[str, Any]:
    """Parse an uploaded file and RETURN the rows for review/edit — does NOT write anything."""
    _require_editor(request)
    recs = _parse_records(await file.read(), file.filename or "")
    return {"columns": ALL_COLS, "numeric": sorted(NUMERIC), "rows": recs, "count": len(recs)}


class CommitBody(BaseModel):
    rows: list[dict[str, Any]]
    create_if_missing: bool = True


@app.post("/api/upload/commit")
def upload_commit(body: CommitBody, request: Request) -> dict[str, Any]:
    """Replace the whole directory with the (reviewed/edited) rows from a prior parse.
    If the table doesn't exist yet and create_if_missing is set, it is created with inferred types."""
    who = _require_editor(request)
    n, created = _commit_records(body.rows, who, body.create_if_missing)
    return {"status": "loaded", "rows": n, "created_table": created}


@app.post("/api/upload")
async def bulk_upload(file: UploadFile = File(...), request: Request = None) -> dict[str, Any]:
    """Legacy one-shot: parse + replace in a single call (no review step)."""
    who = _require_editor(request)
    recs = _parse_records(await file.read(), file.filename or "")
    n, created = _commit_records(recs, who)
    return {"status": "loaded", "rows": n, "created_table": created}


class GenieBody(BaseModel):
    question: str


def _g(method: str, path: str, body: dict | None = None) -> dict:
    return w.api_client.do(method, path, body=body)


@app.post("/api/genie/ask")
def genie_ask(body: GenieBody) -> dict[str, Any]:
    if not GENIE_SPACE_ID:
        raise HTTPException(status_code=503, detail="Genie space not configured")
    sp = GENIE_SPACE_ID
    start = _g("POST", f"/api/2.0/genie/spaces/{sp}/start-conversation", {"content": body.question})
    conv, msg_id = start["conversation_id"], start["message_id"]
    msg: dict = {}
    for _ in range(45):
        msg = _g("GET", f"/api/2.0/genie/spaces/{sp}/conversations/{conv}/messages/{msg_id}")
        if msg.get("status") in ("COMPLETED", "FAILED", "CANCELLED", "QUERY_RESULT_EXPIRED"):
            break
        time.sleep(2)
    if msg.get("status") != "COMPLETED":
        return {"answer": f"(Genie status: {msg.get('status')})", "sql": None, "columns": [], "rows": []}
    answer, sql, att_id = None, None, None
    for att in msg.get("attachments", []) or []:
        if att.get("text"):
            answer = att["text"].get("content")
        if att.get("query"):
            sql = att["query"].get("query")
            att_id = att.get("attachment_id")
    columns, rows = [], []
    if att_id:
        qr = _g("GET", f"/api/2.0/genie/spaces/{sp}/conversations/{conv}/messages/{msg_id}/query-result/{att_id}")
        sr = qr.get("statement_response") or {}
        cols = (((sr.get("manifest") or {}).get("schema") or {}).get("columns")) or []
        columns = [c.get("name") for c in cols]
        rows = ((sr.get("result") or {}).get("data_array")) or []
    return {"answer": answer, "sql": sql, "columns": columns, "rows": rows[:50]}


# ---------- configuration (read-only, admins) ----------

@app.get("/api/admin/config")
def admin_config(request: Request) -> dict[str, Any]:
    """Deploy-time settings the app is running with. Read-only; change them in databricks.yml and redeploy."""
    _require_admin(request)
    return {
        "catalog": CATALOG,
        "schema": SCHEMA,
        "table": TABLE,
        "admin_table": ADMIN_TABLE,
        "warehouse_id": WAREHOUSE_ID,
        "genie_space_id": GENIE_SPACE_ID or None,
        "editors": EDITORS if EDITORS and "*" not in EDITORS else "everyone",
    }


# ---------- admins (sites_admin table) ----------

class AdminAssign(BaseModel):
    email: str
    is_site_admin: bool


def _ensure_admin_table() -> None:
    _run(f"CREATE TABLE IF NOT EXISTS {ADMIN_TABLE} (user_email STRING, is_site_admin BOOLEAN) USING DELTA")


@app.get("/api/admin/users")
def admin_list(request: Request) -> list[dict[str, Any]]:
    _require_admin(request)
    try:
        return _rows(f"SELECT user_email, is_site_admin FROM {ADMIN_TABLE} ORDER BY user_email")
    except HTTPException:
        return []  # table not created yet


@app.post("/api/admin/users")
def admin_assign(body: AdminAssign, request: Request) -> dict[str, Any]:
    who = _require_admin(request)
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="Enter a valid email address.")
    _ensure_admin_table()
    flag = "true" if body.is_site_admin else "false"
    _run(
        f"MERGE INTO {ADMIN_TABLE} AS t "
        f"USING (SELECT {_esc(email)} AS user_email, {flag} AS is_site_admin) AS s "
        f"ON lower(t.user_email) = lower(s.user_email) "
        f"WHEN MATCHED THEN UPDATE SET t.is_site_admin = s.is_site_admin "
        f"WHEN NOT MATCHED THEN INSERT (user_email, is_site_admin) VALUES (s.user_email, s.is_site_admin)"
    )
    log.info("site admin %s set to %s by %s", email, flag, who)
    return {"status": "saved", "email": email, "is_site_admin": body.is_site_admin}


# ---------- site data (Update site data) ----------

class RowUpdate(BaseModel):
    site_id: str
    fields: dict[str, Any]


class BatchUpdate(BaseModel):
    rows: list[RowUpdate]


@app.get("/api/site-data")
def site_data_all(request: Request) -> list[dict[str, Any]]:
    _require_editor(request)
    return _rows(f"SELECT {', '.join(ALL_COLS)} FROM {TABLE} ORDER BY location_name")


@app.post("/api/site-data/batch")
def site_data_batch(body: BatchUpdate, request: Request) -> dict[str, Any]:
    who = _require_editor(request)
    if not body.rows:
        raise HTTPException(status_code=400, detail="No changes to save.")
    if len(body.rows) > 500:
        raise HTTPException(status_code=400, detail="Save at most 500 rows at a time.")
    saved = 0
    for r in body.rows:
        if not r.site_id.strip():
            raise HTTPException(status_code=400, detail="Every row needs a site_id.")
        sets = [f"{k} = {_cell(k, v)}" for k, v in r.fields.items() if k in EDITABLE]
        if not sets:
            continue
        sets += [f"updated_by = {_esc(who)}", "updated_at = current_timestamp()"]
        _run(f"UPDATE {TABLE} SET {', '.join(sets)} WHERE site_id = {_esc(r.site_id)}")
        saved += 1
    log.info("%d site rows updated by %s", saved, who)
    return {"status": "updated", "rows": saved}


# ---------- static SPA (path-based client routing) ----------
DIST = Path(__file__).parent.parent / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(DIST / "assets")), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        if full_path.startswith("api"):
            return Response("Not found", status_code=404)
        candidate = DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(str(DIST / "index.html"))
