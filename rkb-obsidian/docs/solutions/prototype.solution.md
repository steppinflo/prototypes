# Initial Prototype

## Context

RKB Obsidian is in the business of making and selling tractors. You can learn more in the business docs.

We get orders periodically, and we need to make sure we have enough tractors to harvest the crops and fulfill the orders we have coming. To have enough tractors, we need to work with our suppliers of parts so we can build the tractors, so they can get to work. We want to optimize this so we can fulfill all orders without overspending on tractors and parts.


## Insights & Initial Requirements Gathering

lead time: suppliers can take 30 days on average to fulfill an order for parts
manufacturing: each tractor takes a day to build once all the parts are available.
 -predictive aspects of having tractors prepped

Forecasting Model
 - historical model of past orders, seasonality, economic factors
how many trackers we need in one time?

Inventory Prediction Model
 - answers: "how many of all the parts do we need at any time to meet our forecast?"
 - using the output of the forecasting and Past Performance Tracking
 - factor in our current orders, supplier delays
 - don't double count tractors, hence why current orders is really important

Parts Performance Tracking (could just be a formula, a metric, not necessarily a model)
 - inputs: past failures to predict future failures (record keeping of failure parts and classes of failures)
 - main supplier, different suppliers for the same part(s), can track performance of those parts and correlate with failures
 - include manufacturing failure and failures in the field

Initial Design Sketch/Diagram in rkb-obsidian/docs/solutions/sketch_diagram.prototype.pdf

Database Schemas/Tables (complements the diagram)
- Tractor
  - each tractor that we've built, whether it is inventoried/earmarked-for-a-customer/shipping/delivered/etc, model number and serial number, lot number (for batched manufacturing)
- Inventory Part
  - each part that goes into a tractor, it's model and serial number, the type of the part (e.g. door, door handle, lift, screws, etc), lot number (for batched manufacturing)
  - should be able to link each tractor to its part(s) and vice versa, have proper accounting and inventory management
- Customer
  - our company's customers, the ones requesting we deliver them tractors
- Supplier
  - one supplier can supply more than one type of part
- the necessary joins/associations between these different entities and more from the diagram and the business plan 

## Internal Inventory & Fulfilment Portal - User Scenarios
An internal user can
- can view a dashboard on a landing page that describes the most important next tasks to complete, with a due date and context about what it's blocking, which customer(s) are impacted, etc
- can review supply/demand projections in general, with guidance on how much inventory to purchase in parts, as well as how many tractors to have built and by when
- can review failures or issues with manufacturing, parts orders, and tractors in the field.
- can review shipping information about parts ordered, or tractors in transit.
- overall manage the inventory and fulfillment that make RKB Obsidian a successful business.