"""Load the customer's real DC Factbook xlsx into dc_factbook.sites.dc_sites.
Two-row header (row2=names, data row3+). Extracts hyperlink targets and parses
lat/lon from the Google Earth Link. Run:
  DATABRICKS_CONFIG_PROFILE=e2-demo-field-eng DATABRICKS_WAREHOUSE_ID=c4c2b14f526c4abd python3 data/load_real.py
"""
import os, re, time
import openpyxl
from databricks.sdk import WorkspaceClient

F = "/Users/sumit.prakash/Downloads/DC Factbook Data-Copy.xlsx"
WID = os.environ["DATABRICKS_WAREHOUSE_ID"]
w = WorkspaceClient()

# (excel col, snake_name, sql_type, original label, is_hyperlink)
COLS = [
 (2,"sce_owner","STRING","SC&E Owner",False),
 (3,"dc_plant","STRING","DC / PLANT",False),
 (4,"whs_plt_no","STRING","WHS - PLT #",False),
 (5,"location_name","STRING","LOCATION NAME",False),
 (6,"region","STRING","REGION",False),
 (7,"products","STRING","PRODUCTS",False),
 (8,"divisions_serviced","STRING","DIVISION(S) SERVICED",False),
 (9,"vice_president","STRING","VICE PRESIDENT",False),
 (10,"regional_director","STRING","REGIONAL DIRECTOR",False),
 (11,"site_leaders","STRING","SITE LEADER(s)",False),
 (12,"transportation_managers","STRING","TRANSPORATION MANAGERS",False),
 (13,"street_address","STRING","STREET ADDRESS",False),
 (14,"city","STRING","CITY",False),
 (15,"state","STRING","STATE",False),
 (16,"zip","STRING","ZIP",False),
 (17,"google_earth_url","STRING","Google Earth Link",True),
 (18,"total_acreage","DOUBLE","Total Acerage",False),
 (19,"expansion_space","STRING","Expansion Space",False),
 (20,"lease_vs_own","STRING","Lease vs Own",False),
 (21,"frozen_sqft","BIGINT","Frozen",False),
 (22,"refrigerated_sqft","BIGINT","Refrigerated",False),
 (23,"ambient_sqft","BIGINT","Ambient",False),
 (24,"ciw_fdic_gm_sqft","BIGINT","CIW/FDIC/GM",False),
 (25,"total_sqft","BIGINT","Total Sq Ft",False),
 (26,"dock_doors_ambient","INT","Dock Doors - Ambient",False),
 (27,"dock_doors_perishable","INT","Dock Doors - Perishable",False),
 (28,"dock_doors_frozen","INT","Dock Doors - Frozen",False),
 (29,"automation_vendor","STRING","Automation Vendor",False),
 (30,"whs_union","STRING","Union or Non-Union (WHS)",False),
 (31,"whs_operation","STRING","WHS Operation",False),
 (32,"trans_union","STRING","Union or Non-Union (Transportation)",False),
 (33,"transportation","STRING","Transportation",False),
 (34,"transportation_operator","STRING","Transportation Operator",False),
 (35,"tractor_total","INT","Tractor Total",False),
 (36,"trailer_total","INT","Trailer Total",False),
 (37,"associate_total","INT","Associate Total",False),
 (38,"banana_room_count","INT","Banana Room Count",False),
 (39,"fuel_lanes","INT","Fuel Lanes",False),
 (40,"vmf_bays","INT","VMF Bays",False),
 (41,"building_open_year","INT","Building Open (Year)",False),
 (42,"function_local_regional","STRING","Function (Local / Regional)",False),
 (43,"total_stores_serviced","INT","Total Stores Serviced",False),
 (44,"site_plan_url","STRING","Site Plan",True),
 (45,"building_plan_url","STRING","Building Plan",True),
 (46,"building_plan_temp_zone_url","STRING","Building Plan w/ temp zone",True),
 (47,"aerial_photo_url","STRING","Aerial Photo",True),
 (48,"link_to_files2_url","STRING","Link to Files2",True),
]
NUMTYPES = {"DOUBLE","BIGINT","INT"}
LATLON = re.compile(r"@(-?\d+\.\d+),(-?\d+\.\d+)")

def run(sql):
    r = w.statement_execution.execute_statement(warehouse_id=WID, statement=sql, wait_timeout="50s")
    t = 0
    while r.status and r.status.state and r.status.state.value in ("PENDING","RUNNING") and t < 120:
        time.sleep(2); t += 2; r = w.statement_execution.get_statement(r.statement_id)
    st = r.status.state.value if r.status and r.status.state else "?"
    if st != "SUCCEEDED":
        raise SystemExit(f"FAIL {st}: {(r.status.error.message if r.status and r.status.error else '')} :: {sql[:90]}")
    return r

def esc(v):
    return "NULL" if v in (None,"") else "'" + str(v).replace("'","''") + "'"
def num(v):
    if v in (None,""): return "NULL"
    try: return str(float(str(v).replace(",","").strip()))
    except ValueError: return "NULL"
def slug(s):
    return re.sub(r"-+","-", re.sub(r"[^a-z0-9]+","-", str(s).lower())).strip("-") or "site"

wb = openpyxl.load_workbook(F)   # keep hyperlinks
ws = wb["DCs"]

rows, seen, coords = [], set(), 0
for r in range(3, 42):
    if all(ws.cell(row=r,column=c).value in (None,"") for c,_,_,_,_ in COLS):
        continue
    rec = {}
    for c, name, typ, _, is_link in COLS:
        cell = ws.cell(row=r, column=c)
        if is_link:
            rec[name] = (cell.hyperlink.target if cell.hyperlink else None) or (cell.value if cell.value else None)
        else:
            rec[name] = cell.value
    # lat/lon from google earth url
    m = LATLON.search(str(rec.get("google_earth_url") or ""))
    rec["lat"] = float(m.group(1)) if m else None
    rec["lon"] = float(m.group(2)) if m else None
    if m: coords += 1
    # stable site_id
    sid = f"DC-{str(rec.get('whs_plt_no') or 'x').strip()}-{slug(rec.get('location_name'))}"
    base = sid; i = 2
    while sid in seen: sid = f"{base}-{i}"; i += 1
    seen.add(sid); rec["site_id"] = sid
    rows.append(rec)

print(f"parsed {len(rows)} rows, {coords} with coords")

# CREATE OR REPLACE with comments
defs = [f"  site_id STRING COMMENT 'stable synthetic key'"]
for c, name, typ, label, _ in COLS:
    defs.append(f"  {name} {typ} COMMENT {esc(label)}")
defs += ["  lat DOUBLE COMMENT 'parsed from Google Earth Link'",
         "  lon DOUBLE COMMENT 'parsed from Google Earth Link'",
         "  updated_at TIMESTAMP", "  updated_by STRING"]
run("CREATE CATALOG IF NOT EXISTS dc_factbook")
run("CREATE SCHEMA IF NOT EXISTS dc_factbook.sites")
run("CREATE VOLUME IF NOT EXISTS dc_factbook.sites.site_drawings")
run("CREATE OR REPLACE TABLE dc_factbook.sites.dc_sites (\n" + ",\n".join(defs) + "\n)")

ordered = ["site_id"] + [n for _,n,_,_,_ in COLS] + ["lat","lon"]
types = {"site_id":"STRING", **{n:t for _,n,t,_,_ in COLS}, "lat":"DOUBLE","lon":"DOUBLE"}
vals = []
for rec in rows:
    cells = []
    for n in ordered:
        v = rec.get(n)
        cells.append(num(v) if types[n] in NUMTYPES else esc(v))
    cells += ["current_timestamp()", "'seed-real'"]
    vals.append("(" + ",".join(cells) + ")")
run(f"INSERT INTO dc_factbook.sites.dc_sites ({', '.join(ordered)}, updated_at, updated_by) VALUES " + ",\n".join(vals))
n = run("SELECT COUNT(*) FROM dc_factbook.sites.dc_sites").result.data_array[0][0]
print(f"DONE — {n} rows loaded; {coords}/{len(rows)} have coords")
print("columns:", ", ".join(ordered))
