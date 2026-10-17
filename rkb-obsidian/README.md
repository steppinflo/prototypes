# RKB Obsidian — Inventory & Fulfilment Portal (prototype)

Internal web portal for planning tractor builds, ordering parts and fulfilling customer
orders, built from [the solutions doc](docs/solutions/prototype.solution.md) and
[sketch diagram](docs/solutions/sketch_diagram.prototype.pdf). The AI/ML models are
mocked with transparent formulas so the whole system works end to end.

## Run it

**With Docker (any machine):**

```bash
docker compose up --build
```

**With Node 22.13+ (no `npm install` needed — zero dependencies):**

```bash
npm start
```

Then open **http://localhost:4300**. On first start the database is built from
`docs/synthetic_supply_chain_dataset.csv` (a few seconds; about 10 on a Raspberry Pi).

**Documentation:** every portal flow and user journey, the task rules, record lifecycles
and how each number is calculated are in
[docs/portal/user-journeys.md](docs/portal/user-journeys.md).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `RKB_PORT` | `4300` | HTTP port (`RKB_PORT` is the host port under Docker) |
| `RKB_RESEED` | `stale` | `stale` rebuilds demo data on start if it is older than `RKB_STALE_DAYS` (7); `always`; `never` |
| `RKB_TODAY` | machine date | Pin "today" (e.g. `2026-10-16`) for repeatable demos |
| `RKB_DB_PATH` | `data/rkb-obsidian.db` | SQLite file location |

Other commands: `npm test` (unit tests and end-to-end user-journey tests in `test/`),
`npm run seed` (rebuild the data).
The sidebar's **Reset demo data** does the same from the browser.

## What's in the portal

| Page | Solutions doc scenario |
|---|---|
| **Dashboard** | Landing page laid out like the sketch: inventory of parts, *What do you need to do today* (due date, what it blocks, customers impacted, one-click action), current tractors, current orders, demand for the next 90 days |
| **Supply & demand plan** | Forecast, how many tractors to build and by when, which parts to buy (qty, supplier, order-by date), orders at risk, planning assumptions you can change |
| **Cost & efficiency** | For any date range: parts bought vs. what actual demand needed (over/under spend), consumption, inventory value and carrying cost, rush premiums, freight, repair costs, late deliveries, forecast vs. actual |
| **Failures & issues** | Receiving, manufacturing and field failures for any date range; supplier trends (failure rate, on-time, days late), recurring failure patterns, lot clusters, repeat late deliveries, parts performance scores |
| **Service & repairs** | Damaged tractors collected from customer sites, repaired at the plant (replacement part traced), and returned |
| **Notifications** | Messages sent to the plant/yards, suppliers and customers from tasks and records |
| **Shipping** | Parts orders in transit from suppliers, tractors in transit to customers, service hauls |
| **Customer orders · Tractors · Parts inventory · Parts orders · Suppliers · Customers** | Day-to-day inventory and fulfilment management, with full tractor ↔ part traceability (serial and lot) |

Actions in the portal (place/receive POs, start and complete builds, clear QC holds,
earmark stock, ship and deliver, log and resolve failures, create orders) write to the
database and the models re-run immediately.

### Escalations

Critical tasks carry the steps to resolve them:

- **Rush a parts order** (+15%, half the quoted lead time, far less slip) — offered when a
  normal order would land after the parts are needed; **expedite** an existing late order.
- **Rush a customer order** — its builds move to the front of the queue and it ships with
  expedited freight.
- **Notify** the plant or a yard, a supplier or a customer (logged against the order, PO, failure or part).
- **Arrange pickup & repair** for a tractor down at a customer site: pickup → plant →
  repair (failed unit swapped from stock, traceability kept) → return, with haul, labour
  and parts costs recorded. If the part isn't in stock, the task offers a rush order for it.

Cost assumptions (placeholders, in `src/lib/costs.mjs`): 15% rush premium, $3.25/mile
freight, $95/hour repair labour, 20%/year inventory carrying cost.

## The mocked models

The flow is forecast → inventory plan → today's tasks, with parts performance feeding
the plan. *How it works* in the portal explains each in detail.

1. **Forecasting** (`src/models/forecast.mjs`) — per tractor model: de-seasonalised level
   + damped trend × month-of-year seasonality × an economic factor from the dataset's
   market trend and inflation. P10–P90 bands and a one-month-ahead backtest.
2. **Inventory prediction** (`src/models/inventoryPlan.mjs`) — firm demand (open orders
   minus tractors already assigned) + forecast demand, netted against unassigned stock so
   nothing is double counted; scheduled into build capacity (1 tractor/bay/day); parts
   projected from stock and open POs at their *predicted* arrival (supplier slip); purchase
   recommendations when stock would fall below safety stock.
3. **Parts performance** (`src/models/partsPerformance.mjs`) — a formula, per the doc:
   failure rates (receiving, manufacturing, field) vs. category average, on-time rate and
   days late → a 0–100 score per part × supplier and a supplier reliability score.
4. **Tasks** (`src/models/tasks.mjs`) — turns the plan and live state into the ranked
   "what to do today" list.

To replace a mock with a real model, keep the function signature and output shape.

## The prototype data set

`src/seed/` replays the CSV (2020–2023, 10k rows) shifted forward in whole years so it
ends around today:

- A seasonal, model-weighted sample of rows becomes customer orders (`Demand_Units` →
  order size, `Warehouse_Location` → customer region).
- `Supplier_Delay_Days` drives how late each supplier's parts arrive (scaled per supplier
  so they differ); `Component_Failure_Rate` drives how failure-prone each order's tractors are.
- All rows are aggregated monthly into `market_signals` for the forecast.
- A day-by-day simulation runs purchasing, receiving, building, QC, shipping, delivery
  and field failures, so every tractor traces to the parts, lots, POs and suppliers it
  was built from.
- Planners' history includes rush parts orders, outbound freight costs and completed
  pickup-and-repair jobs for serious field failures (one is mid-repair today).
- Two demo scenarios are added: a 6 × TX-500 dealer fleet order that outruns engine
  supply, and a tractor on QC hold waiting for a control unit.

Customers, suppliers, addresses and the part catalog are fictional (`src/seed/catalog.mjs`).

## Project layout

```
src/
  server.mjs          HTTP server (API + static files), seeds on first start
  db/                 schema.sql (tables from the doc/diagram) and SQLite helpers
  seed/               catalog, CSV replay simulation, scenario injection
  models/             forecast, parts performance, inventory plan, tasks
  analytics/          cost & efficiency report, supplier quality trends
  api/                routes (reads) and actions (writes)
public/               web app: vanilla JS, no build step
test/                 node --test suites
docs/                 business docs, solutions doc, diagram, source dataset
```

Built on Node's built-in `node:http` and `node:sqlite`; the front end uses no frameworks
or CDNs, so it runs offline.
