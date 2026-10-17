// How the prototype works: the mocked models, the data, and the data model.

import { api, html, fmtDate, fmtNum, pageHead } from '../lib.js';

export async function aboutView() {
  const meta = await api('/meta');
  return html`
    ${pageHead({ title: 'How it works', sub: 'What is real, what is mocked, and where the numbers come from.' })}
    <div class="prose">
      <div class="callout">This is a <b>prototype</b>. The three models below are deterministic stand-ins with the same inputs and outputs a trained model would have, so the portal works end to end. Swap any of them for a real model behind the same function signature.</div>

      <h2>The flow</h2>
      <p><b>Forecasting model</b> → expected new orders by model and week → <b>Inventory prediction model</b> (with current orders, stock, open POs and supplier delays) → build plan + parts purchase recommendations → <b>"What do you need to do today"</b>. <b>Parts performance tracking</b> feeds the inventory model with scrap rates, supplier delivery slip and supplier choice.</p>

      <h2>1 · Forecasting model (mock)</h2>
      <p>For each tractor model: monthly tractors ordered over the last 36 months are de-seasonalised with a month-of-year index (pooled across models), giving a <i>level</i> (last 6 months) and a damped <i>trend</i> (last 24 months). The forecast is <code>(level + trend × months ahead) × seasonality × economic factor</code>, where the economic factor comes from the dataset's recent <code>Market_Trend_Index</code> and <code>Inflation_Rate</code>. The P10–P90 range comes from the historical spread plus count noise. A one-month-ahead backtest reports accuracy.</p>

      <h2>2 · Inventory prediction model (mock)</h2>
      <ol>
        <li><b>Firm demand</b>: every open customer order, minus tractors already built, building or earmarked for it.</li>
        <li><b>Forecast demand</b>: the forecast's expected new orders (at the chosen P50/P75/P90 level), shifted by the typical order-to-delivery lead time so only demand needing delivery inside the horizon counts.</li>
        <li><b>Don't double count</b>: unassigned tractors in stock or on the line are netted against that demand first and surfaced as "earmark" suggestions.</li>
        <li><b>Build schedule</b>: one tractor per bay per working day once parts are on hand. Firm orders are built up to 3 weeks early; forecast demand about a week before it's needed.</li>
        <li><b>Parts</b>: each build pulls its bill of materials, grossed up by the expected scrap/reject rate. Projected on-hand = stock + open POs at their <i>predicted</i> arrival (carrier ETA, or quoted date + that supplier's historical slip) − requirements.</li>
        <li><b>Recommendations</b>: when projected stock would fall below safety stock, buy enough to restore it and cover the next 30 days, from the best-scoring supplier that can still deliver in time (or the fastest, flagged to expedite). Order-by date = need date − quoted lead − typical slip − receiving time.</li>
        <li><b>Risk</b>: builds whose parts can't arrive before their latest start are flagged with the orders and customers they block.</li>
      </ol>

      <h2>3 · Parts performance tracking (formula)</h2>
      <p>For every part × supplier: failures at receiving inspection, in manufacturing/QC and in the field, normalised by units installed and compared with the average for that part category; plus on-time rate and average days late on that supplier's parts orders.</p>
      <p><code>score = 100 × (0.5 × quality + 0.3 × on-time rate + 0.2 × timeliness)</code>, with <code>quality = 1 − failure rate / (2 × category average)</code> and <code>timeliness = 1 − avg days late / 15</code>. Supplier reliability is the PO-weighted average of its part scores. The tracker flags parts failing at more than twice their category rate, and alternates that clearly outperform a primary supplier.</p>

      <h2>Escalations &amp; costs</h2>
      <p>Tasks carry the steps to resolve them: <b>rush</b> a parts order (+15%, half the quoted lead time) or expedite a late one, <b>rush</b> a customer order (its builds jump the queue, expedited freight),
      <b>notify</b> the plant, a supplier or a customer, and <b>arrange pickup &amp; repair</b> for a tractor down at a customer site. The <b>Cost &amp; efficiency</b> page compares parts bought with what the
      tractors customers actually ordered needed, for any date range, alongside inventory carrying cost (20%/yr), rush premiums, freight ($3.25/mile) and repair costs ($95/hour).
      Inventory value is rebuilt day by day from receipts, consumption and scrap, and reconciles to the stock on hand.</p>
      <p><b>Supplier quality</b> over any date range: monthly failure rate per 1,000 units installed and on-time delivery per supplier, recurring failure patterns (same part, supplier and symptom 3+ times),
      lots with repeated failures, and supplier/part pairs late 3+ times — each can be raised with the supplier in one click.</p>

      <h2>The prototype data set</h2>
      <p>Seeded from <code>docs/synthetic_supply_chain_dataset.csv</code> (2020–2023, 10,000 rows), shifted forward ${meta.datasetYearShift} years so it ends around today; ${fmtNum(meta.datasetRowsUsed)} rows fall on or before today and are used. Data last seeded ${fmtDate(meta.seedDate, { year: true })}.</p>
      <ul>
        <li><b>Customer orders</b>: a seasonal, model-weighted sample of dataset rows. <code>Demand_Units</code> sets order size, <code>Warehouse_Location</code> the customer's region, <code>Market_Trend_Index</code> nudges ordering likelihood.</li>
        <li><b>Supplier delays</b>: each supplier's parts orders arrive late according to that supplier's <code>Supplier_Delay_Days</code> rows, scaled by a per-supplier factor so suppliers differ (the raw column is uniform across suppliers). Average order-to-delivery is ≈30 days, as in the solutions doc.</li>
        <li><b>Failures</b>: each order's <code>Component_Failure_Rate</code> scales how failure-prone its tractors are; part category and supplier quality set the base rate. About 30% are caught in manufacturing/QC, the rest show up in the field.</li>
        <li><b>Economic context</b>: all rows are aggregated monthly into <code>market_signals</code> (inflation, market trend, supplier delay, failure rate) for the forecast.</li>
        <li>A day-by-day simulation then runs the business — weekly purchasing, receiving with inspection, builds (1 day each, 3 bays), QC, shipping, delivery and field failures — so every tractor traces to the parts, lots, POs and suppliers it was built from.</li>
        <li>Two scenarios are layered on top for the demo: a dealer fleet order for six TX-500s that outruns flagship-engine supply, and a tractor on QC hold waiting for a control unit.</li>
      </ul>
      <p>Names, addresses and suppliers are fictional. Use <b>Reset demo data</b> in the sidebar to rebuild everything.</p>

      <h2>Data model</h2>
      <ul>
        <li><b>customers</b> (name, id, primary address) — 1:n <b>customer_orders</b> (status, quantity, submission / expected / actual delivery date, delivery address)</li>
        <li><b>customer_orders</b> 1:n <b>tractors</b> (model & serial number, build lot, status: building / QC hold / in stock / earmarked / shipping / delivered)</li>
        <li><b>tractors</b> n:m <b>inventory_parts</b> via <b>tractor_parts</b> — serialized units or lots, each with part number, serial, lot, supplier and the parts order it arrived on</li>
        <li><b>suppliers</b> (name, id, address, lat/long, reliability score) n:m <b>part_types</b> via <b>supplier_parts</b> (primary/alternate, cost, quoted lead)</li>
        <li><b>inventory_orders</b> (part number, quantity, submission / expected / actual delivery date, supplier, delivery address) 1:n <b>inventory_parts</b></li>
        <li><b>tractor_models</b> 1:n <b>bom_items</b> → <b>part_types</b>; <b>shipments</b> (inbound parts, outbound tractors); <b>failure_reports</b> (receiving / manufacturing / field, linked to part, unit, supplier, PO, tractor, customer)</li>
        <li><b>v_part_balances</b> — the diagram's "Inventory of Parts": part number, part name, available balance, pending balance</li>
      </ul>
    </div>`;
}
