-- RKB Obsidian portal schema.
-- Entities follow docs/solutions/prototype.solution.md and the sketch diagram:
-- Customer, Supplier, Customer Orders, Inventory Orders, Inventory of Parts, Tractor.
-- All dates are ISO 'YYYY-MM-DD' text.

PRAGMA foreign_keys = ON;

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE warehouses (
  id        TEXT PRIMARY KEY,           -- WH-IL
  name      TEXT NOT NULL,
  address   TEXT NOT NULL,
  city      TEXT NOT NULL,
  state     TEXT NOT NULL,
  lat       REAL NOT NULL,
  lng       REAL NOT NULL,
  is_plant  INTEGER NOT NULL DEFAULT 0  -- the plant builds tractors and receives all parts
);

-- Diagram: Customer - Name, ID, Primary Address
CREATE TABLE customers (
  id              TEXT PRIMARY KEY,     -- CUS-001
  name            TEXT NOT NULL,
  segment         TEXT NOT NULL,        -- farm | co-op | dealer | contractor
  primary_address TEXT NOT NULL,
  city            TEXT NOT NULL,
  state           TEXT NOT NULL,
  region          TEXT NOT NULL,        -- fulfilment region (CA, IL, FL, NY, TX)
  lat             REAL NOT NULL,
  lng             REAL NOT NULL
);

-- Diagram: Supplier - Name, ID, Primary Address, Long/Lat, Reliability Score
CREATE TABLE suppliers (
  id                TEXT PRIMARY KEY,   -- SUP-A
  code              TEXT NOT NULL,      -- 'Supplier A' (as named in the source dataset)
  name              TEXT NOT NULL,
  primary_address   TEXT NOT NULL,
  city              TEXT NOT NULL,
  state             TEXT NOT NULL,
  lat               REAL NOT NULL,
  lng               REAL NOT NULL,
  quoted_lead_days  INTEGER NOT NULL,
  reliability_score REAL                -- 0-100, maintained by the parts performance tracker
);

CREATE TABLE tractor_models (
  model_number TEXT PRIMARY KEY,        -- TX-300
  name         TEXT NOT NULL,
  horsepower   INTEGER NOT NULL,
  list_price   REAL NOT NULL,
  description  TEXT NOT NULL
);

-- Part catalog (the "type" of an inventory part).
CREATE TABLE part_types (
  part_number    TEXT PRIMARY KEY,      -- ENG-75
  name           TEXT NOT NULL,
  category       TEXT NOT NULL,         -- engine, door, door handle, lift, fasteners, ...
  serialized     INTEGER NOT NULL,      -- 1 = tracked per unit by serial, 0 = tracked per lot
  unit_cost      REAL NOT NULL,
  pack_size      INTEGER NOT NULL,      -- order in multiples of this
  min_order_qty  INTEGER NOT NULL
);

-- Bill of materials: which parts (and how many) go into each tractor model.
CREATE TABLE bom_items (
  model_number TEXT NOT NULL REFERENCES tractor_models(model_number),
  part_number  TEXT NOT NULL REFERENCES part_types(part_number),
  quantity     INTEGER NOT NULL,
  PRIMARY KEY (model_number, part_number)
);

-- One supplier supplies many part types; one part type can come from several suppliers.
CREATE TABLE supplier_parts (
  supplier_id      TEXT NOT NULL REFERENCES suppliers(id),
  part_number      TEXT NOT NULL REFERENCES part_types(part_number),
  is_primary       INTEGER NOT NULL DEFAULT 0,
  unit_cost        REAL NOT NULL,
  quoted_lead_days INTEGER NOT NULL,
  PRIMARY KEY (supplier_id, part_number)
);

-- Diagram: Customer Orders - Status, Quantity, Submission Date, Expected Delivery Date,
-- Actual Delivery Date, Customer, Delivery Address
CREATE TABLE customer_orders (
  id                     TEXT PRIMARY KEY,   -- SO-2026-0042
  customer_id            TEXT NOT NULL REFERENCES customers(id),
  model_number           TEXT NOT NULL REFERENCES tractor_models(model_number),
  quantity               INTEGER NOT NULL,
  status                 TEXT NOT NULL,      -- received | in_production | ready | shipping | partially_delivered | delivered | cancelled
  submission_date        TEXT NOT NULL,
  expected_delivery_date TEXT NOT NULL,
  actual_delivery_date   TEXT,
  delivery_address       TEXT NOT NULL,
  region                 TEXT NOT NULL,      -- Warehouse_Location in the source dataset
  unit_price             REAL NOT NULL,
  notes                  TEXT
);

-- Diagram: Inventory Orders - Part Number/ID, Quantity, Submission Date, Expected Delivery Date,
-- Actual Delivery Date, Supplier, Delivery Address
CREATE TABLE inventory_orders (
  id                     TEXT PRIMARY KEY,   -- PO-2026-00123
  part_number            TEXT NOT NULL REFERENCES part_types(part_number),
  supplier_id            TEXT NOT NULL REFERENCES suppliers(id),
  quantity               INTEGER NOT NULL,
  quantity_received      INTEGER NOT NULL DEFAULT 0,
  quantity_rejected      INTEGER NOT NULL DEFAULT 0,
  unit_cost              REAL NOT NULL,
  status                 TEXT NOT NULL,      -- submitted | confirmed | in_transit | received | cancelled
  submission_date        TEXT NOT NULL,
  expected_delivery_date TEXT NOT NULL,      -- supplier's quoted date
  actual_delivery_date   TEXT,
  delivery_address       TEXT NOT NULL,
  warehouse_id           TEXT NOT NULL REFERENCES warehouses(id),
  source                 TEXT NOT NULL,      -- history | manual | model_recommendation
  notes                  TEXT
);

-- Each part that goes (or will go) into a tractor. Serialized parts are one row per unit;
-- lot-tracked parts (fasteners, filters, tires, ...) are one row per received lot.
CREATE TABLE inventory_parts (
  id                 TEXT PRIMARY KEY,       -- IP-000123
  part_number        TEXT NOT NULL REFERENCES part_types(part_number),
  serial_number      TEXT,                   -- null for lot-tracked parts
  lot_number         TEXT NOT NULL,
  supplier_id        TEXT NOT NULL REFERENCES suppliers(id),
  inventory_order_id TEXT REFERENCES inventory_orders(id),
  warehouse_id       TEXT NOT NULL REFERENCES warehouses(id),
  quantity           INTEGER NOT NULL,       -- units received in this row
  quantity_on_hand   INTEGER NOT NULL,       -- units still available to build with
  status             TEXT NOT NULL,          -- in_stock | installed | consumed | scrapped | rejected
  tractor_id         TEXT REFERENCES tractors(id), -- serialized parts: the tractor it's installed in
  received_date      TEXT NOT NULL
);

-- Diagram: "Current inventory of tractors"
CREATE TABLE tractors (
  id                   TEXT PRIMARY KEY,     -- T-00042
  serial_number        TEXT NOT NULL UNIQUE,
  model_number         TEXT NOT NULL REFERENCES tractor_models(model_number),
  lot_number           TEXT NOT NULL,        -- build batch
  status               TEXT NOT NULL,        -- in_production | qc_hold | inventoried | earmarked | shipping | delivered
  customer_order_id    TEXT REFERENCES customer_orders(id),
  warehouse_id         TEXT NOT NULL REFERENCES warehouses(id),
  build_start_date     TEXT NOT NULL,
  build_complete_date  TEXT,
  ship_date            TEXT,
  delivered_date       TEXT,
  hold_part_number     TEXT REFERENCES part_types(part_number),
  failure_factor       REAL NOT NULL DEFAULT 1  -- Component_Failure_Rate context from the source dataset
);

-- Tractor <-> part traceability (works for both serialized units and lots).
CREATE TABLE tractor_parts (
  tractor_id        TEXT NOT NULL REFERENCES tractors(id),
  inventory_part_id TEXT NOT NULL REFERENCES inventory_parts(id),
  part_number       TEXT NOT NULL REFERENCES part_types(part_number),
  quantity          INTEGER NOT NULL,
  installed_date    TEXT NOT NULL,
  PRIMARY KEY (tractor_id, inventory_part_id)
);

CREATE TABLE shipments (
  id                    TEXT PRIMARY KEY,    -- SH-00123
  direction             TEXT NOT NULL,       -- inbound (parts) | outbound (tractors)
  inventory_order_id    TEXT REFERENCES inventory_orders(id),
  customer_order_id     TEXT REFERENCES customer_orders(id),
  carrier               TEXT NOT NULL,
  tracking_number       TEXT NOT NULL,
  origin                TEXT NOT NULL,
  origin_lat            REAL NOT NULL,
  origin_lng            REAL NOT NULL,
  destination           TEXT NOT NULL,
  destination_lat       REAL NOT NULL,
  destination_lng       REAL NOT NULL,
  shipped_date          TEXT NOT NULL,
  expected_arrival_date TEXT NOT NULL,       -- carrier ETA
  actual_arrival_date   TEXT,
  status                TEXT NOT NULL        -- in_transit | delivered
);

CREATE TABLE shipment_tractors (
  shipment_id TEXT NOT NULL REFERENCES shipments(id),
  tractor_id  TEXT NOT NULL REFERENCES tractors(id),
  PRIMARY KEY (shipment_id, tractor_id)
);

-- Failures and issues: at receiving (parts orders), in manufacturing, and in the field.
CREATE TABLE failure_reports (
  id                 TEXT PRIMARY KEY,       -- FR-00042
  reported_date      TEXT NOT NULL,
  stage              TEXT NOT NULL,          -- receiving | manufacturing | field
  failure_class      TEXT NOT NULL,          -- Mechanical, Hydraulic, Electrical, ...
  severity           TEXT NOT NULL,          -- low | medium | high | critical
  part_number        TEXT NOT NULL REFERENCES part_types(part_number),
  supplier_id        TEXT NOT NULL REFERENCES suppliers(id),
  inventory_part_id  TEXT REFERENCES inventory_parts(id),
  inventory_order_id TEXT REFERENCES inventory_orders(id),
  tractor_id         TEXT REFERENCES tractors(id),
  customer_id        TEXT REFERENCES customers(id),
  quantity           INTEGER NOT NULL DEFAULT 1,
  description        TEXT NOT NULL,
  status             TEXT NOT NULL,          -- open | investigating | resolved
  resolution         TEXT,
  resolved_date      TEXT
);

-- Monthly aggregates of the source dataset: economic + market context for the forecast.
CREATE TABLE market_signals (
  month              TEXT NOT NULL,          -- YYYY-MM
  model_number       TEXT NOT NULL,
  demand_units       INTEGER NOT NULL,
  avg_supplier_delay REAL NOT NULL,
  avg_failure_rate   REAL NOT NULL,
  avg_inventory      REAL NOT NULL,
  avg_inflation      REAL NOT NULL,
  avg_market_trend   REAL NOT NULL,
  observations       INTEGER NOT NULL,
  PRIMARY KEY (month, model_number)
);

-- Internal users can mark dashboard tasks done or snooze them.
CREATE TABLE task_state (
  task_key   TEXT PRIMARY KEY,
  status     TEXT NOT NULL,                  -- done | snoozed
  until_date TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE activity_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  action    TEXT NOT NULL,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  message   TEXT NOT NULL
);

CREATE INDEX idx_orders_status      ON customer_orders(status);
CREATE INDEX idx_orders_customer    ON customer_orders(customer_id);
CREATE INDEX idx_po_status          ON inventory_orders(status);
CREATE INDEX idx_po_part            ON inventory_orders(part_number);
CREATE INDEX idx_ip_part_status     ON inventory_parts(part_number, status);
CREATE INDEX idx_ip_tractor         ON inventory_parts(tractor_id);
CREATE INDEX idx_tractors_status    ON tractors(status);
CREATE INDEX idx_tractors_order     ON tractors(customer_order_id);
CREATE INDEX idx_tp_part            ON tractor_parts(inventory_part_id);
CREATE INDEX idx_fr_part_supplier   ON failure_reports(part_number, supplier_id);
CREATE INDEX idx_fr_tractor         ON failure_reports(tractor_id);
CREATE INDEX idx_ship_order         ON shipments(customer_order_id);
CREATE INDEX idx_ship_po            ON shipments(inventory_order_id);

-- Diagram: Inventory of Parts - Part Number/ID, Balance/Available Quantity, Pending Balance, Part Name
CREATE VIEW v_part_balances AS
SELECT
  pt.part_number,
  pt.name AS part_name,
  pt.category,
  pt.serialized,
  pt.unit_cost,
  COALESCE((SELECT SUM(ip.quantity_on_hand) FROM inventory_parts ip
            WHERE ip.part_number = pt.part_number AND ip.status = 'in_stock'), 0) AS available,
  COALESCE((SELECT SUM(io.quantity - io.quantity_received - io.quantity_rejected) FROM inventory_orders io
            WHERE io.part_number = pt.part_number AND io.status IN ('submitted','confirmed','in_transit')), 0) AS pending
FROM part_types pt;
