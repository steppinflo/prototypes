// Static reference data for the prototype. Everything here is fictional.
// The source dataset names five tractor models (TX-100..TX-500), five suppliers
// (Supplier A..E) and five warehouse locations (CA, IL, FL, NY, TX); this file gives
// them the detail the portal needs (addresses, a bill of materials, a part catalog).

export const WAREHOUSES = [
  { id: 'WH-IL', name: 'Peoria Plant & Parts Warehouse', address: '4100 Industrial Pkwy, Peoria, IL 61604', city: 'Peoria', state: 'IL', lat: 40.69, lng: -89.59, is_plant: 1 },
  { id: 'WH-CA', name: 'Fresno Distribution Yard', address: '2250 S Cedar Ave, Fresno, CA 93725', city: 'Fresno', state: 'CA', lat: 36.70, lng: -119.75, is_plant: 0 },
  { id: 'WH-FL', name: 'Lakeland Distribution Yard', address: '900 Airport Rd, Lakeland, FL 33811', city: 'Lakeland', state: 'FL', lat: 27.99, lng: -82.02, is_plant: 0 },
  { id: 'WH-NY', name: 'Syracuse Distribution Yard', address: '6400 Court St Rd, Syracuse, NY 13206', city: 'Syracuse', state: 'NY', lat: 43.07, lng: -76.10, is_plant: 0 },
  { id: 'WH-TX', name: 'Amarillo Distribution Yard', address: '1500 N Lakeside Dr, Amarillo, TX 79107', city: 'Amarillo', state: 'TX', lat: 35.22, lng: -101.75, is_plant: 0 },
];

export const PLANT = WAREHOUSES[0];

export const TRACTOR_MODELS = [
  { model_number: 'TX-100', name: 'Compact 25', horsepower: 25, list_price: 28500, description: 'Compact utility tractor for small farms, orchards and grounds work.' },
  { model_number: 'TX-200', name: 'Utility 45', horsepower: 45, list_price: 46000, description: 'General-purpose utility tractor; loader and hay work.' },
  { model_number: 'TX-300', name: 'Row-Crop 75', horsepower: 75, list_price: 78000, description: 'Cab row-crop tractor for mid-size grain and vegetable operations.' },
  { model_number: 'TX-400', name: 'Row-Crop 120', horsepower: 120, list_price: 135000, description: 'High-horsepower row-crop tractor for planting and tillage.' },
  { model_number: 'TX-500', name: 'Harvest-Class 180', horsepower: 180, list_price: 215000, description: 'Flagship tractor for large acreage, heavy tillage and harvest logistics.' },
];

// Suppliers. delayFactor / failureFactor are seed-only knobs: the source dataset's
// delay and failure columns are uniform across suppliers, so these give each supplier
// a distinct track record for the performance tracker to discover.
export const SUPPLIERS = [
  { id: 'SUP-A', code: 'Supplier A', name: 'Prairie Powertrain Co.', primary_address: '1800 River Dr, Moline, IL 61265', city: 'Moline', state: 'IL', lat: 41.51, lng: -90.51, quoted_lead_days: 25, delayFactor: 0.45, failureFactor: 0.75 },
  { id: 'SUP-B', code: 'Supplier B', name: 'Great Lakes Hydraulics', primary_address: '3300 W Canal St, Milwaukee, WI 53208', city: 'Milwaukee', state: 'WI', lat: 43.03, lng: -87.95, quoted_lead_days: 26, delayFactor: 0.8, failureFactor: 0.95 },
  { id: 'SUP-C', code: 'Supplier C', name: 'Lone Star Fabrication', primary_address: '5100 Blue Mound Rd, Fort Worth, TX 76106', city: 'Fort Worth', state: 'TX', lat: 32.82, lng: -97.35, quoted_lead_days: 24, delayFactor: 0.95, failureFactor: 0.9 },
  { id: 'SUP-D', code: 'Supplier D', name: 'Sierra Controls & Electric', primary_address: '4700 E Jensen Ave, Fresno, CA 93725', city: 'Fresno', state: 'CA', lat: 36.71, lng: -119.71, quoted_lead_days: 28, delayFactor: 1.1, failureFactor: 1.4 },
  { id: 'SUP-E', code: 'Supplier E', name: 'Gulf Coast Rubber & Seating', primary_address: '2900 Halls Mill Rd, Mobile, AL 36606', city: 'Mobile', state: 'AL', lat: 30.65, lng: -88.10, quoted_lead_days: 24, delayFactor: 1.65, failureFactor: 1.6 },
];

// Part catalog. failureRate = lifetime probability a single unit fails (manufacturing
// or field) at an average supplier; classes = failure modes seen for that part.
// suppliers[0] is the primary source; others are alternates (price premium).
export const PART_TYPES = [
  { part_number: 'ENG-25', name: 'Diesel Engine 25 hp', category: 'engine', serialized: 1, unit_cost: 3200, pack_size: 1, min_order_qty: 2, failureRate: 0.03, suppliers: ['SUP-A', 'SUP-B'] },
  { part_number: 'ENG-45', name: 'Diesel Engine 45 hp', category: 'engine', serialized: 1, unit_cost: 5400, pack_size: 1, min_order_qty: 2, failureRate: 0.03, suppliers: ['SUP-A', 'SUP-B'] },
  { part_number: 'ENG-75', name: 'Diesel Engine 75 hp', category: 'engine', serialized: 1, unit_cost: 9800, pack_size: 1, min_order_qty: 2, failureRate: 0.03, suppliers: ['SUP-A', 'SUP-B'] },
  { part_number: 'ENG-120', name: 'Diesel Engine 120 hp', category: 'engine', serialized: 1, unit_cost: 17500, pack_size: 1, min_order_qty: 2, failureRate: 0.035, suppliers: ['SUP-A'] },
  { part_number: 'ENG-180', name: 'Diesel Engine 180 hp', category: 'engine', serialized: 1, unit_cost: 28000, pack_size: 1, min_order_qty: 1, failureRate: 0.04, suppliers: ['SUP-A'] },
  { part_number: 'TRN-HST', name: 'Hydrostatic Transmission', category: 'transmission', serialized: 1, unit_cost: 2900, pack_size: 1, min_order_qty: 2, failureRate: 0.025, suppliers: ['SUP-A', 'SUP-B'] },
  { part_number: 'TRN-PSH', name: 'PowerShift Transmission', category: 'transmission', serialized: 1, unit_cost: 11500, pack_size: 1, min_order_qty: 2, failureRate: 0.03, suppliers: ['SUP-A'] },
  { part_number: 'AXL-FR', name: 'Front Axle Assembly', category: 'axle', serialized: 1, unit_cost: 2100, pack_size: 1, min_order_qty: 4, failureRate: 0.012, suppliers: ['SUP-A', 'SUP-C'] },
  { part_number: 'AXL-RR', name: 'Rear Axle Assembly', category: 'axle', serialized: 1, unit_cost: 3400, pack_size: 1, min_order_qty: 4, failureRate: 0.012, suppliers: ['SUP-A', 'SUP-C'] },
  { part_number: 'HYD-PMP', name: 'Hydraulic Pump', category: 'hydraulics', serialized: 1, unit_cost: 1150, pack_size: 1, min_order_qty: 4, failureRate: 0.04, suppliers: ['SUP-B', 'SUP-A'] },
  { part_number: 'HYD-LFT', name: '3-Point Hitch Lift Assembly', category: 'lift', serialized: 1, unit_cost: 1800, pack_size: 1, min_order_qty: 4, failureRate: 0.025, suppliers: ['SUP-B', 'SUP-C'] },
  { part_number: 'CAB-STD', name: 'Operator Cab', category: 'cab', serialized: 1, unit_cost: 7800, pack_size: 1, min_order_qty: 2, failureRate: 0.008, suppliers: ['SUP-C'] },
  { part_number: 'ROPS-01', name: 'Rollover Protection Frame', category: 'frame', serialized: 1, unit_cost: 650, pack_size: 1, min_order_qty: 4, failureRate: 0.004, suppliers: ['SUP-C', 'SUP-E'] },
  { part_number: 'DOR-CAB', name: 'Cab Door', category: 'door', serialized: 0, unit_cost: 640, pack_size: 4, min_order_qty: 4, failureRate: 0.012, suppliers: ['SUP-C', 'SUP-E'] },
  { part_number: 'DHL-01', name: 'Door Handle', category: 'door handle', serialized: 0, unit_cost: 38, pack_size: 20, min_order_qty: 20, failureRate: 0.025, suppliers: ['SUP-C', 'SUP-E'] },
  { part_number: 'ECU-01', name: 'Engine Control Unit', category: 'electronics', serialized: 1, unit_cost: 1450, pack_size: 1, min_order_qty: 4, failureRate: 0.045, suppliers: ['SUP-D'] },
  { part_number: 'HRN-01', name: 'Main Wiring Harness', category: 'electrical', serialized: 0, unit_cost: 420, pack_size: 5, min_order_qty: 5, failureRate: 0.03, suppliers: ['SUP-D', 'SUP-E'] },
  { part_number: 'BAT-12', name: '12V Heavy-Duty Battery', category: 'electrical', serialized: 0, unit_cost: 210, pack_size: 6, min_order_qty: 6, failureRate: 0.05, suppliers: ['SUP-D', 'SUP-E'] },
  { part_number: 'LGT-KIT', name: 'LED Work Light Kit', category: 'electrical', serialized: 0, unit_cost: 260, pack_size: 5, min_order_qty: 5, failureRate: 0.02, suppliers: ['SUP-D', 'SUP-E'] },
  { part_number: 'TIR-F', name: 'Front Tire', category: 'tire', serialized: 0, unit_cost: 310, pack_size: 4, min_order_qty: 8, failureRate: 0.025, suppliers: ['SUP-E', 'SUP-C'] },
  { part_number: 'TIR-R', name: 'Rear Tire', category: 'tire', serialized: 0, unit_cost: 780, pack_size: 4, min_order_qty: 8, failureRate: 0.025, suppliers: ['SUP-E', 'SUP-C'] },
  { part_number: 'SEAT-01', name: 'Suspension Operator Seat', category: 'seat', serialized: 0, unit_cost: 540, pack_size: 4, min_order_qty: 4, failureRate: 0.018, suppliers: ['SUP-E', 'SUP-C'] },
  { part_number: 'FLT-KIT', name: 'Engine & Hydraulic Filter Kit', category: 'filters', serialized: 0, unit_cost: 95, pack_size: 10, min_order_qty: 10, failureRate: 0.01, suppliers: ['SUP-B', 'SUP-E'] },
  { part_number: 'FST-M10', name: 'M10 Screw & Fastener Kit', category: 'screws', serialized: 0, unit_cost: 22, pack_size: 50, min_order_qty: 50, failureRate: 0.004, suppliers: ['SUP-C', 'SUP-E'] },
];

const ENGINE = { 'TX-100': 'ENG-25', 'TX-200': 'ENG-45', 'TX-300': 'ENG-75', 'TX-400': 'ENG-120', 'TX-500': 'ENG-180' };

/** Bill of materials per model: [part_number, quantity]. */
export const BOM = Object.fromEntries(TRACTOR_MODELS.map(({ model_number: m }) => {
  const cab = m === 'TX-300' || m === 'TX-400' || m === 'TX-500';
  const items = [
    [ENGINE[m], 1],
    [cab ? 'TRN-PSH' : 'TRN-HST', 1],
    ['AXL-FR', 1],
    ['AXL-RR', 1],
    ['HYD-PMP', 1],
    ['HYD-LFT', 1],
    ['ECU-01', 1],
    ['HRN-01', 1],
    ['BAT-12', m === 'TX-500' ? 2 : 1],
    ['LGT-KIT', 1],
    ['TIR-F', 2],
    ['TIR-R', m === 'TX-500' ? 4 : 2],
    ['SEAT-01', 1],
    ['FLT-KIT', 1],
    ['FST-M10', m === 'TX-100' ? 3 : 4],
  ];
  if (cab) items.push(['CAB-STD', 1], ['DOR-CAB', 2], ['DHL-01', 2]);
  else items.push(['ROPS-01', 1]);
  return [m, items];
}));

// Failure taxonomy: class + typical symptoms, by part category.
export const FAILURE_MODES = {
  engine: [['Mechanical', 'Loss of compression / low power'], ['Mechanical', 'Oil leak at rear main seal'], ['Electrical', 'Fuel injector fault code'], ['Thermal', 'Overheating under load']],
  transmission: [['Mechanical', 'Gear engagement slipping'], ['Hydraulic', 'Clutch pack pressure loss'], ['Mechanical', 'Excessive noise in range shift']],
  axle: [['Mechanical', 'Bearing wear / play'], ['Structural', 'Housing crack at mount']],
  hydraulics: [['Hydraulic', 'Pump flow below spec'], ['Hydraulic', 'Seal leak at pump shaft']],
  lift: [['Hydraulic', 'Lift drifts down under load'], ['Structural', 'Lift arm weld crack']],
  cab: [['Fit & Finish', 'Window seal leak'], ['Structural', 'Cab mount bushing failure']],
  frame: [['Structural', 'Weld porosity at upright']],
  door: [['Fit & Finish', 'Door misalignment / does not latch'], ['Fit & Finish', 'Hinge binding']],
  'door handle': [['Mechanical', 'Handle latch spring broken'], ['Fit & Finish', 'Handle cracked']],
  electronics: [['Electrical', 'ECU intermittent shutdown'], ['Electrical', 'CAN bus communication error'], ['Software', 'Firmware fault, needs reflash']],
  electrical: [['Electrical', 'Short circuit / blown fuse'], ['Electrical', 'Connector corrosion'], ['Electrical', 'Will not hold charge']],
  tire: [['Wear', 'Sidewall cracking'], ['Wear', 'Premature tread wear'], ['Mechanical', 'Bead leak']],
  seat: [['Mechanical', 'Suspension collapse'], ['Fit & Finish', 'Upholstery tear']],
  filters: [['Mechanical', 'Filter housing gasket leak']],
  screws: [['Structural', 'Fastener sheared / thread stripped']],
};

export const RECEIVING_ISSUES = [
  ['Damaged in Transit', 'Crate damaged in transit; units dented or cracked'],
  ['Dead on Arrival', 'Unit failed incoming inspection'],
  ['Wrong Spec', 'Units received do not match ordered revision'],
];

export const CARRIERS_OUTBOUND = ['Heartland Freight Lines', 'Great Plains Flatbed', 'Midland Ag Haulers'];
export const CARRIERS_INBOUND = ['Interstate LTL Express', 'Crossroads Freight', 'Northstar Logistics'];

// Customers by fulfilment region (the dataset's Warehouse_Location).
// weight = relative ordering frequency (key accounts order more often).
export const CUSTOMERS = [
  ['CA', 'Valley Oak Orchards', 'farm', 'Modesto', 'CA', 37.64, -120.99, 3],
  ['CA', 'Salinas Greens Cooperative', 'co-op', 'Salinas', 'CA', 36.68, -121.66, 4],
  ['CA', 'Kern Row Crop Partners', 'farm', 'Bakersfield', 'CA', 35.37, -119.02, 2],
  ['CA', 'Sacramento Delta Farms', 'farm', 'Stockton', 'CA', 37.96, -121.29, 2],
  ['CA', 'Imperial Sun Produce', 'farm', 'El Centro', 'CA', 32.79, -115.56, 1],
  ['CA', 'Willamette Ag Supply', 'dealer', 'Salem', 'OR', 44.94, -123.04, 3],
  ['CA', 'Yakima Basin Growers', 'co-op', 'Yakima', 'WA', 46.60, -120.51, 2],
  ['IL', 'Prairie Gold Grain Co-op', 'co-op', 'Champaign', 'IL', 40.12, -88.24, 5],
  ['IL', 'Hollis Family Farms', 'farm', 'Decatur', 'IL', 39.84, -88.95, 2],
  ['IL', 'Corn Belt Equipment Dealers', 'dealer', 'Des Moines', 'IA', 41.59, -93.62, 5],
  ['IL', 'Wabash Valley Growers', 'farm', 'Terre Haute', 'IN', 39.47, -87.41, 2],
  ['IL', 'Northwoods Dairy Collective', 'co-op', 'Eau Claire', 'WI', 44.81, -91.50, 2],
  ['IL', 'Big Muddy Soybean Partners', 'farm', 'Quincy', 'IL', 39.94, -91.41, 1],
  ['IL', 'Platte River Ranches', 'farm', 'Kearney', 'NE', 40.70, -99.08, 2],
  ['FL', 'Suncoast Citrus Growers', 'co-op', 'Lakeland', 'FL', 28.04, -81.95, 4],
  ['FL', 'Everglades Cane Cooperative', 'co-op', 'Belle Glade', 'FL', 26.68, -80.67, 3],
  ['FL', 'Peach State Peanut Co.', 'farm', 'Albany', 'GA', 31.58, -84.16, 2],
  ['FL', 'Panhandle Timber & Turf', 'contractor', 'Tallahassee', 'FL', 30.44, -84.28, 1],
  ['FL', 'Low Country Vegetable Farms', 'farm', 'Charleston', 'SC', 32.78, -79.93, 2],
  ['FL', 'Carolina Tobacco & Grain', 'farm', 'Wilson', 'NC', 35.72, -77.92, 2],
  ['NY', 'Finger Lakes Vineyards', 'farm', 'Geneva', 'NY', 42.87, -76.98, 2],
  ['NY', 'Hudson Valley Orchards', 'farm', 'Kingston', 'NY', 41.93, -74.00, 2],
  ['NY', 'Green Mountain Dairy Co-op', 'co-op', 'Burlington', 'VT', 44.48, -73.21, 3],
  ['NY', 'Lancaster Plain Farms', 'farm', 'Lancaster', 'PA', 40.04, -76.31, 3],
  ['NY', 'Genesee Valley Potato Growers', 'co-op', 'Batavia', 'NY', 43.00, -78.19, 2],
  ['NY', 'Garden State Produce Co.', 'dealer', 'Vineland', 'NJ', 39.49, -75.03, 2],
  ['TX', 'Lone Star Cotton Gin Co-op', 'co-op', 'Lubbock', 'TX', 33.58, -101.86, 4],
  ['TX', 'Rio Grande Valley Citrus', 'farm', 'McAllen', 'TX', 26.20, -98.23, 2],
  ['TX', 'Panhandle Wheat Partners', 'farm', 'Amarillo', 'TX', 35.22, -101.83, 3],
  ['TX', 'Brazos Bottom Farms', 'farm', 'Waco', 'TX', 31.55, -97.15, 2],
  ['TX', 'Red River Cattle & Hay', 'farm', 'Wichita Falls', 'TX', 33.91, -98.49, 2],
  ['TX', 'Sooner Plains Ag Supply', 'dealer', 'Enid', 'OK', 36.40, -97.88, 4],
  ['TX', 'Pecos Valley Growers', 'co-op', 'Roswell', 'NM', 33.39, -104.52, 1],
];

// Seasonality and model mix applied when sampling customer orders from the dataset
// (the dataset itself is uniform). Spring planting and fall harvest peaks.
export const SEASONALITY = [0.7, 0.85, 1.3, 1.45, 1.15, 0.9, 0.8, 0.95, 1.2, 1.15, 0.8, 0.65];
export const MODEL_POPULARITY = { 'TX-100': 1.0, 'TX-200': 1.35, 'TX-300': 1.15, 'TX-400': 0.75, 'TX-500': 0.45 };
