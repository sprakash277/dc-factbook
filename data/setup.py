"""Create dc_factbook catalog/schema/volume/table + load ~14 synthetic DC sites.

The table schema here MUST match what backend/main.py queries (the load_real.py /
COLSPEC columns: location_name, region, total_sqft, products, divisions_serviced,
automation_vendor, whs_union, function_local_regional, etc.). Keeping them in sync is
what prevents the /api/sites 500 "column not found" error.

Run:
  export DATABRICKS_CONFIG_PROFILE=<profile>
  export DATABRICKS_WAREHOUSE_ID=<warehouse-id>
  # optional: grant the deployed app's service principal read/write access
  export APP_SERVICE_PRINCIPAL=<app sp application/client id>
  python3 data/setup.py
"""
import os, time, random
from databricks.sdk import WorkspaceClient

WID = os.environ["DATABRICKS_WAREHOUSE_ID"]
APP_SP = os.environ.get("APP_SERVICE_PRINCIPAL", "").strip()
CATALOG = os.environ.get("CATALOG", "dc_factbook")
SCHEMA = os.environ.get("SCHEMA", "sites")
TABLE = f"{CATALOG}.{SCHEMA}.dc_sites"
w = WorkspaceClient()


def run(sql):
    r = w.statement_execution.execute_statement(warehouse_id=WID, statement=sql, wait_timeout="50s")
    waited = 0
    while r.status and r.status.state and r.status.state.value in ("PENDING", "RUNNING") and waited < 120:
        time.sleep(2); waited += 2
        r = w.statement_execution.get_statement(r.statement_id)
    st = r.status.state.value if r.status and r.status.state else "?"
    if st != "SUCCEEDED":
        raise SystemExit(f"FAIL: {st} :: {(r.status.error.message if r.status and r.status.error else '')} :: {sql[:90]}")
    return r


def q(v):
    if v is None or v == "": return "NULL"
    if isinstance(v, bool): return "true" if v else "false"
    if isinstance(v, (int, float)): return str(v)
    return "'" + str(v).replace("\\", "\\\\").replace("'", "''") + "'"


# Schema EXACTLY as backend/main.py expects: site_id + COLSPEC names + lat/lon/area.
COLS = [
    ("site_id", "STRING"), ("sce_owner", "STRING"), ("dc_plant", "STRING"), ("whs_plt_no", "STRING"),
    ("location_name", "STRING"), ("region", "STRING"), ("products", "STRING"), ("divisions_serviced", "STRING"),
    ("vice_president", "STRING"), ("regional_director", "STRING"), ("site_leaders", "STRING"),
    ("transportation_managers", "STRING"), ("street_address", "STRING"), ("city", "STRING"), ("state", "STRING"),
    ("zip", "STRING"), ("google_earth_url", "STRING"), ("total_acreage", "DOUBLE"), ("expansion_space", "STRING"),
    ("lease_vs_own", "STRING"), ("frozen_sqft", "BIGINT"), ("refrigerated_sqft", "BIGINT"), ("ambient_sqft", "BIGINT"),
    ("ciw_fdic_gm_sqft", "BIGINT"), ("total_sqft", "BIGINT"), ("dock_doors_ambient", "INT"),
    ("dock_doors_perishable", "INT"), ("dock_doors_frozen", "INT"), ("automation_vendor", "STRING"),
    ("whs_union", "STRING"), ("whs_operation", "STRING"), ("trans_union", "STRING"), ("transportation", "STRING"),
    ("transportation_operator", "STRING"), ("tractor_total", "INT"), ("trailer_total", "INT"),
    ("associate_total", "INT"), ("banana_room_count", "INT"), ("fuel_lanes", "INT"), ("vmf_bays", "INT"),
    ("building_open_year", "INT"), ("function_local_regional", "STRING"), ("total_stores_serviced", "INT"),
    ("site_plan_url", "STRING"), ("building_plan_url", "STRING"), ("building_plan_temp_zone_url", "STRING"),
    ("aerial_photo_url", "STRING"), ("link_to_files2_url", "STRING"), ("lat", "DOUBLE"), ("lon", "DOUBLE"),
    ("area", "STRING"),
]

print("catalog/schema/volume/table…")
run(f"CREATE CATALOG IF NOT EXISTS {CATALOG} COMMENT 'DC Fact Book — supply-chain site directory (synthetic demo data)'")
run(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{SCHEMA}")
run(f"CREATE VOLUME IF NOT EXISTS {CATALOG}.{SCHEMA}.site_drawings")
run(f"DROP TABLE IF EXISTS {TABLE}")
run(f"CREATE TABLE {TABLE} (" + ", ".join(f"{n} {t}" for n, t in COLS) + ")")

# (location_name, region, city, state, lat, lon, products, division, automation_vendor)
SITES = [
    ("Atlanta DC", "Southeast", "Atlanta", "GA", 33.7490, -84.3880, "Grocery; Perishable", "Atlanta Division", "Witron"),
    ("Cincinnati DC", "Midwest", "Cincinnati", "OH", 39.1031, -84.5120, "Grocery; GM", "Cincinnati/Dayton", "Manual"),
    ("Dallas DC", "South Central", "Dallas", "TX", 32.7767, -96.7970, "Grocery; Frozen", "Dallas Division", "Dematic"),
    ("Denver DC", "Mountain", "Denver", "CO", 39.7392, -104.9903, "Grocery; Perishable", "King Soopers", "Manual"),
    ("Phoenix DC", "Southwest", "Phoenix", "AZ", 33.4484, -112.0740, "Grocery", "Fry's", "Witron"),
    ("Portland DC", "Northwest", "Portland", "OR", 45.5152, -122.6784, "Grocery; GM", "Fred Meyer", "Manual"),
    ("Nashville DC", "Southeast", "Nashville", "TN", 36.1627, -86.7816, "Grocery; Frozen", "Nashville Division", "Dematic"),
    ("Indianapolis DC", "Midwest", "Indianapolis", "IN", 39.7684, -86.1581, "Grocery", "Central Division", "Manual"),
    ("Houston DC", "South Central", "Houston", "TX", 29.7604, -95.3698, "Grocery; Perishable", "Houston Division", "Witron"),
    ("Salt Lake DC", "Mountain", "Salt Lake City", "UT", 40.7608, -111.8910, "Grocery; GM", "Smith's", "Manual"),
    ("Charlotte DC", "Southeast", "Charlotte", "NC", 35.2271, -80.8431, "Grocery; Frozen", "Mid-Atlantic", "Dematic"),
    ("Columbus DC", "Midwest", "Columbus", "OH", 39.9612, -82.9988, "Grocery", "Columbus Division", "Manual"),
    ("Memphis DC", "South Central", "Memphis", "TN", 35.1495, -90.0490, "Grocery; Perishable", "Delta Division", "Witron"),
    ("Roanoke DC", "Mid-Atlantic", "Roanoke", "VA", 37.2710, -79.9414, "Grocery; GM", "Mid-Atlantic", "Manual"),
]

print(f"inserting {len(SITES)} sites…")
rows = []
for i, (name, region, city, st, lat, lon, prod, div, auto) in enumerate(SITES, 1):
    amb = random.randint(400, 900) * 1000; per = random.randint(150, 350) * 1000
    frz = random.randint(80, 220) * 1000; ciw = random.randint(50, 150) * 1000
    rec = {
        "site_id": f"DC{i:03d}", "sce_owner": "Kroger SCE", "dc_plant": f"PLT{100+i}", "whs_plt_no": str(100 + i),
        "location_name": name, "region": region, "products": prod, "divisions_serviced": div,
        "vice_president": "VP Supply Chain", "regional_director": "Regional Director",
        "site_leaders": random.choice(["J. Carter", "M. Nguyen", "R. Patel", "S. Brooks", "D. Alvarez"]),
        "transportation_managers": "T. Manager", "street_address": f"{random.randint(100, 9999)} Logistics Pkwy",
        "city": city, "state": st, "zip": f"{random.randint(10000, 99999)}", "google_earth_url": None,
        "total_acreage": round(random.uniform(40, 160), 1), "expansion_space": random.choice(["Yes", "No", "Limited"]),
        "lease_vs_own": random.choice(["Own", "Lease"]), "frozen_sqft": frz, "refrigerated_sqft": per,
        "ambient_sqft": amb, "ciw_fdic_gm_sqft": ciw, "total_sqft": amb + per + frz + ciw,
        "dock_doors_ambient": random.randint(40, 120), "dock_doors_perishable": random.randint(15, 50),
        "dock_doors_frozen": random.randint(10, 40), "automation_vendor": auto,
        "whs_union": random.choice(["Union", "Non-Union"]), "whs_operation": "Kroger",
        "trans_union": random.choice(["Union", "Non-Union"]), "transportation": "Fleet",
        "transportation_operator": "Kroger", "tractor_total": random.randint(60, 220),
        "trailer_total": random.randint(200, 700), "associate_total": random.randint(400, 1500),
        "banana_room_count": random.randint(0, 2), "fuel_lanes": random.randint(0, 8), "vmf_bays": random.randint(2, 10),
        "building_open_year": random.randint(1985, 2022), "function_local_regional": random.choice(["Regional", "Local"]),
        "total_stores_serviced": random.randint(80, 350), "site_plan_url": None, "building_plan_url": None,
        "building_plan_temp_zone_url": None, "aerial_photo_url": None, "link_to_files2_url": None,
        "lat": lat, "lon": lon, "area": region,
    }
    rows.append("(" + ", ".join(q(rec.get(n)) for n, _ in COLS) + ")")

run(f"INSERT INTO {TABLE} VALUES " + ",\n".join(rows))

# Grant the deployed app's service principal access, if provided. Databricks Apps run as
# their own service principal, so without these grants /api/sites returns 500.
if APP_SP:
    print(f"granting app service principal {APP_SP}…")
    run(f"GRANT USE CATALOG ON CATALOG {CATALOG} TO `{APP_SP}`")
    run(f"GRANT USE SCHEMA ON SCHEMA {CATALOG}.{SCHEMA} TO `{APP_SP}`")
    run(f"GRANT SELECT ON TABLE {TABLE} TO `{APP_SP}`")
    run(f"GRANT MODIFY ON TABLE {TABLE} TO `{APP_SP}`")
    run(f"GRANT READ VOLUME ON VOLUME {CATALOG}.{SCHEMA}.site_drawings TO `{APP_SP}`")
else:
    print("APP_SERVICE_PRINCIPAL not set — skipping app grants. The deployed app's "
          "service principal needs USE CATALOG/SCHEMA + SELECT/MODIFY on the table + "
          "CAN_USE on the warehouse, or /api/sites will 500.")

print(f"DONE — {len(rows)} sites loaded into {TABLE}" + (" (+ app SP granted)" if APP_SP else ""))
