// Forecasting model (MOCK).
//
// Stands in for the ML forecasting model in the solutions doc: "historical model of past
// orders, seasonality, economic factors -> how many tractors we need at one time".
// It is a transparent statistical baseline, not a trained model:
//   demand(model, month) = (level + damped trend * k) x seasonality[month] x economic factor
//   - level / trend: deseasonalised tractor orders per month for that model (last 6 / 24 months)
//   - seasonality: month-of-year index pooled across models, shrunk toward 1
//   - economic factor: recent Market_Trend_Index and Inflation_Rate from the source dataset
// Uncertainty bands come from the spread of the deseasonalised history.

import { dayNum, isoDay, weekStart, clamp, round, sum } from '../lib/util.mjs';

const Z = { p10: -1.2816, p50: 0, p75: 0.6745, p90: 1.2816 };

function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function mean(a) {
  return a.length ? sum(a) / a.length : 0;
}

function sd(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(sum(a, (x) => (x - m) ** 2) / (a.length - 1));
}

function slope(a) {
  const n = a.length;
  if (n < 3) return 0;
  const xm = (n - 1) / 2;
  const ym = mean(a);
  let num = 0;
  let den = 0;
  a.forEach((y, x) => {
    num += (x - xm) * (y - ym);
    den += (x - xm) ** 2;
  });
  return num / den;
}

/** Seasonality index by month-of-year (0..11) from pooled monthly totals. */
export function seasonalityIndex(monthlyTotals) {
  const byMoy = Array.from({ length: 12 }, () => []);
  const overall = mean(monthlyTotals.map((m) => m.value));
  for (const m of monthlyTotals) byMoy[Number(m.month.slice(5, 7)) - 1].push(m.value);
  const raw = byMoy.map((v) => (v.length && overall ? mean(v) / overall : 1));
  const shrunk = raw.map((r) => 1 + 0.7 * (r - 1));
  const norm = mean(shrunk);
  return shrunk.map((s) => round(s / norm, 3));
}

/** Fit level/trend/spread on a model's monthly series (oldest first). */
export function fitSeries(series, season) {
  const z = series.map((p) => p.value / season[Number(p.month.slice(5, 7)) - 1]);
  const recent = z.slice(-6);
  const level = mean(recent);
  const trend = clamp(slope(z.slice(-24)) * 0.5, -0.05 * level, 0.05 * level);
  const spread = sd(z.slice(-12));
  return { level, trend, spread };
}

function economicFactor(signals) {
  const months = [...new Set(signals.map((s) => s.month))].sort().slice(-3);
  const recent = signals.filter((s) => months.includes(s.month));
  const marketTrend = mean(recent.map((s) => s.avg_market_trend));
  const inflation = mean(recent.map((s) => s.avg_inflation));
  const factor = clamp(1 + 0.3 * (marketTrend - 0.5) - 0.02 * (inflation - 3.75), 0.85, 1.15);
  return { months, marketTrend: round(marketTrend, 3), inflation: round(inflation, 2), factor: round(factor, 3) };
}

export function forecastDemand(db, { today, horizonDays = 90 }) {
  const currentMonth = today.slice(0, 7);
  const models = db.prepare('SELECT model_number, name FROM tractor_models ORDER BY model_number').all();
  const rows = db.prepare(`
    SELECT substr(submission_date, 1, 7) AS month, model_number, SUM(quantity) AS qty
    FROM customer_orders WHERE status != 'cancelled' AND submission_date < ?
    GROUP BY 1, 2`).all(`${currentMonth}-01`);
  const months = [...new Set(rows.map((r) => r.month))].sort().slice(-36);
  const get = (model, month) => rows.find((r) => r.model_number === model && r.month === month)?.qty ?? 0;

  const totals = months.map((month) => ({ month, value: sum(models, (m) => get(m.model_number, month)) }));
  const season = seasonalityIndex(totals);
  const econ = economicFactor(db.prepare('SELECT * FROM market_signals WHERE month < ?').all(currentMonth));

  // Daily horizon (tomorrow .. today + horizon).
  const startN = dayNum(today) + 1;
  const days = Array.from({ length: horizonDays }, (_, i) => isoDay(startN + i));
  const lastMonth = months[months.length - 1];

  const out = models.map((m) => {
    const series = months.map((month) => ({ month, value: get(m.model_number, month) }));
    const fit = fitSeries(series, season);
    const monthMean = (ym) => {
      const k = Math.max(1, monthsBetween(lastMonth, ym));
      return Math.max(0, (fit.level + fit.trend * k) * season[Number(ym.slice(5, 7)) - 1] * econ.factor);
    };
    const daily = days.map((date) => {
      const ym = date.slice(0, 7);
      return { date, mean: monthMean(ym) / daysInMonth(ym) };
    });
    // Weekly buckets with uncertainty.
    const weeks = new Map();
    for (const d of daily) {
      const ws = isoDay(weekStart(dayNum(d.date)));
      if (!weeks.has(ws)) weeks.set(ws, { weekStart: ws, mean: 0, days: 0, seasonal: 0 });
      const w = weeks.get(ws);
      w.mean += d.mean;
      w.days += 1;
      w.seasonal += season[Number(d.date.slice(5, 7)) - 1];
    }
    const weekly = [...weeks.values()].map((w) => {
      const s = fit.spread * (w.seasonal / w.days) * econ.factor * Math.sqrt(w.days / 30.4);
      const sdW = Math.sqrt(s ** 2 + w.mean); // add Poisson noise for small counts
      const q = (z) => round(Math.max(0, w.mean + z * sdW), 2);
      return { weekStart: w.weekStart, days: w.days, mean: round(w.mean, 2), p10: q(Z.p10), p75: q(Z.p75), p90: q(Z.p90) };
    });
    const totalMean = sum(daily, (d) => d.mean);
    const totalSd = Math.sqrt((fit.spread * econ.factor * Math.sqrt(horizonDays / 30.4)) ** 2 + totalMean);
    const monthly = [...new Set(days.map((d) => d.slice(0, 7)))].map((ym) => ({ month: ym, mean: round(monthMean(ym), 1) }));
    return {
      model: m.model_number,
      name: m.name,
      history: series,
      level: round(fit.level, 2),
      trendPerMonth: round(fit.trend, 2),
      monthly,
      weekly,
      daily,
      total: {
        mean: round(totalMean, 1),
        p10: round(Math.max(0, totalMean + Z.p10 * totalSd), 1),
        p75: round(totalMean + Z.p75 * totalSd, 1),
        p90: round(totalMean + Z.p90 * totalSd, 1),
      },
      backtest: backtest(series, season),
    };
  });

  const weeklyTotals = out[0].weekly.map((w, i) => ({
    weekStart: w.weekStart,
    mean: round(sum(out, (m) => m.weekly[i].mean), 1),
    p10: round(sum(out, (m) => m.weekly[i].p10), 1),
    p90: round(sum(out, (m) => m.weekly[i].p90), 1),
  }));
  const totalSeries = totals.map((t) => ({ month: t.month, value: t.value }));
  const totalBacktest = backtest(totalSeries, season);

  return {
    asOf: today,
    horizonDays,
    historyMonths: months,
    seasonality: season,
    economic: econ,
    models: out,
    weeklyTotals,
    totals: {
      mean: round(sum(out, (m) => m.total.mean), 1),
      p10: round(sum(out, (m) => m.total.p10), 1),
      p75: round(sum(out, (m) => m.total.p75), 1),
      p90: round(sum(out, (m) => m.total.p90), 1),
    },
    accuracy: { mape: totalBacktest.mape, note: 'Mean absolute % error of one-month-ahead forecasts of total tractor orders over the last 6 months' },
    method: 'Mock model: deseasonalised level + damped trend per model, x month-of-year seasonality, x economic factor (market trend, inflation). Bands from historical spread plus count noise.',
  };
}

function monthsBetween(a, b) {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
}

/** One-month-ahead backtest over the last 6 months (re-fitting on data before each month). */
function backtest(series, season) {
  const errs = [];
  for (let i = series.length - 6; i < series.length; i++) {
    if (i < 12) continue;
    const fit = fitSeries(series.slice(0, i), season);
    const pred = (fit.level + fit.trend) * season[Number(series[i].month.slice(5, 7)) - 1];
    const actual = series[i].value;
    if (actual > 0) errs.push(Math.abs(pred - actual) / actual);
  }
  return { mape: errs.length ? round(mean(errs) * 100, 1) : null };
}

