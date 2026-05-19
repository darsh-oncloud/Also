/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * Bike Dashboard Suitelet
 * ─────────────────────────────────────────────────────────────
 * Shows for each Non-Inventory parent bike:
 *   • Component breakdown (IDs from custitem_related_components)
 *   • Sum of avg cost across all components
 *   • On-hand qty per component
 *   • Max buildable bikes (MIN of component on-hand qtys)
 *   • Top selling bikes (by SO quantity)
 */

define([
  'N/search',
  'N/record',
  'N/log'
], (search, record, log) => {

  /* ─── CONSTANTS ─────────────────────────────────────────── */
  const CUSTOM_FIELD = 'custitem_related_components'; // Multiselect — getValue() returns array of internal IDs
  const TOP_N_BIKES  = 10; // how many top-selling bikes to show

  /* ══════════════════════════════════════════════════════════
     ENTRY POINT
  ══════════════════════════════════════════════════════════ */
  const onRequest = (context) => {
    const { request, response } = context;

    try {
      const dateFrom   = request.parameters.dateFrom || '';
      const dateTo     = request.parameters.dateTo   || '';
      const bikeData   = getBikeData();
      const topSelling = getTopSellingBikes(TOP_N_BIKES, dateFrom, dateTo, bikeData);
      const html       = buildHTML(bikeData, topSelling, dateFrom, dateTo);
      response.write(html);
    } catch (e) {
      log.error({ title: 'Bike Dashboard Error', details: e.toString() });
      response.write(`<h2 style="color:red">Error: ${e.message}</h2><pre>${e.stack}</pre>`);
    }
  };

  /* ══════════════════════════════════════════════════════════
     DATA LAYER
  ══════════════════════════════════════════════════════════ */

  /**
   * Fetch all parent bikes + their component IDs using SuiteQL.
   *
   * The multiselect custom field (custitem_related_components) stores values
   * in a junction table named after the field: item_custitem_related_components
   * Each row has: item (parent bike ID), value (component item ID)
   * This gives us one row per component — no record.load needed.
   *
   * Then a single second query fetches avg cost + on-hand for all components.
   */
  const getBikeData = () => {
    const bikes = [];

    // Hardcoded to 2 bikes for testing — replace with dynamic search once confirmed working
    const bikeStubs = [
      { id: '817' },
      { id: '827' }
    ];

    for (const stub of bikeStubs) {
      try {
        const itemRec = record.load({ type: 'noninventoryitem', id: stub.id, isDynamic: false });

        const componentIds = (itemRec.getValue({ fieldId: CUSTOM_FIELD }) || [])
          .map(v => String(v).trim())
          .filter(v => /^\d+$/.test(v));

        if (!componentIds.length) continue;

        bikes.push({
          id          : stub.id,
          itemId      : itemRec.getValue({ fieldId: 'itemid' }),
          displayName : itemRec.getValue({ fieldId: 'displayname' }) || itemRec.getValue({ fieldId: 'itemid' }),
          componentIds,
          components  : []
        });
      } catch (e) {
        log.error({ title: 'Failed to load bike ' + stub.id, details: e.toString() });
      }
    }

    // Resolve component details for all bikes
    const allComponentIds = [...new Set(bikes.flatMap(b => b.componentIds))];
    const componentMap    = getComponentDetails(allComponentIds);

    for (const bike of bikes) {
      bike.components   = bike.componentIds.map(id => componentMap[id] || {
        id, itemId: id, displayName: 'Item ' + id, avgCost: 0, onHandQty: 0
      });
      bike.totalAvgCost = bike.components.reduce((sum, c) => sum + (c.avgCost || 0), 0);
      bike.buildableQty = bike.components.length
        ? Math.min(...bike.components.map(c => c.onHandQty || 0))
        : 0;
    }

    return bikes;
  };

  /**
   * Given an array of component internal IDs, return details for each.
   * Uses a single search call for all IDs.
   */
  /**
   * Fetch avg cost + on-hand qty for ALL component IDs in a single search.
   * Returns a map keyed by internal ID: { '617': { id, itemId, displayName, avgCost, onHandQty }, ... }
   */
  const getComponentDetails = (ids) => {
    if (!ids.length) return {};

    const map = {};

    search.create({
      type   : search.Type.INVENTORY_ITEM,
      filters: [['internalid', 'anyof', ids]],
      columns: [
        search.createColumn({ name: 'internalid' }),
        search.createColumn({ name: 'itemid' }),
        search.createColumn({ name: 'displayname' }),
        search.createColumn({ name: 'averagecost' }),
        search.createColumn({ name: 'quantityonhand' })
      ]
    }).run().each(r => {
      map[String(r.id)] = {
        id         : String(r.id),
        itemId     : r.getValue({ name: 'itemid' }),
        displayName: r.getValue({ name: 'displayname' }) || r.getValue({ name: 'itemid' }),
        avgCost    : parseFloat(r.getValue({ name: 'averagecost' })    || '0') || 0,
        onHandQty  : parseFloat(r.getValue({ name: 'quantityonhand' }) || '0') || 0
      };
      return true;
    });

    return map;
  };

  /**
   * Top-selling bikes by quantity on closed/billed sales orders.
   * Joins SO lines back to the non-inventory item type.
   */
  const getTopSellingBikes = (limit, dateFrom, dateTo, bikeData) => {
    // Revenue is stored on component lines, not the parent bike line (parent price = 0).
    // custcol_parent_item on each component SO line points back to the parent bike.
    // So we group by custcol_parent_item to get qty sold + real revenue per bike.
    // Build filters upfront — cannot mutate soSearch.filters after search.create (throws _clone error)
    const filters = [
      ['mainline', 'is', 'F'],
      'AND',
      ['custcol_parent_item', 'isnotempty', ''],
      'AND',
      ['status', 'anyof', ['SalesOrd:B', 'SalesOrd:C', 'SalesOrd:D',
                            'SalesOrd:E', 'SalesOrd:F']]
    ];
    if (dateFrom) { filters.push('AND'); filters.push(['trandate', 'onorafter',  dateFrom]); }
    if (dateTo)   { filters.push('AND'); filters.push(['trandate', 'onorbefore', dateTo]);   }

    // Group by custcol_parent_item + tranid + item so each row = one component on one SO.
    // tranid is the SO number string (e.g. "SO-1234") — available directly on the line,
    // no join needed. This lets us dedup qty per SO+bike using the lowest item ID.
    const soSearch = search.create({
      type: search.Type.SALES_ORDER,
      filters,
      columns: [
        search.createColumn({ name: 'custcol_parent_item', summary: search.Summary.GROUP }),
        search.createColumn({ name: 'tranid',              summary: search.Summary.GROUP }),
        search.createColumn({ name: 'item',                summary: search.Summary.GROUP }),
        search.createColumn({ name: 'quantity',            summary: search.Summary.SUM }),
        search.createColumn({ name: 'amount',              summary: search.Summary.SUM })
      ]
    });

    // Build cost lookup from bikeData (parent item internalid -> totalAvgCost)
    const costMap = {};
    (bikeData || []).forEach(b => { costMap[b.id] = b.totalAvgCost || 0; });

    const bikeMap    = {};  // parentId -> { displayName, qtySold, revenue, cost }
    const seenSoBike = {};  // "tranid_parentId" -> { qty, itemId } — tracks lowest item per SO+bike

    // .each() is capped at 4000 rows — use getRange() pagination instead (1000 rows per call)
    const PAGE_SIZE = 1000;
    let   start     = 0;
    const resultSet = soSearch.run();

    const processRow = (r) => {
      const parentId   = r.getValue({ name: 'custcol_parent_item', summary: search.Summary.GROUP });
      const parentName = r.getText({  name: 'custcol_parent_item', summary: search.Summary.GROUP });
      const tranId     = r.getValue({ name: 'tranid',              summary: search.Summary.GROUP });
      const itemId     = r.getValue({ name: 'item',                summary: search.Summary.GROUP });
      const qty        = parseFloat(r.getValue({ name: 'quantity', summary: search.Summary.SUM }) || '0');
      const amount     = parseFloat(r.getValue({ name: 'amount',   summary: search.Summary.SUM }) || '0');

      if (!parentId) return;

      if (!bikeMap[parentId]) {
        bikeMap[parentId] = { itemId: parentId, displayName: parentName || parentId, qtySold: 0, revenue: 0, cost: 0 };
      }

      // Revenue: always add all component line amounts — each has its own price
      bikeMap[parentId].revenue += amount;

      // Qty: only count the line with the lowest item ID per SO+bike combo
      const soKey = tranId + '_' + parentId;
      if (!seenSoBike[soKey]) {
        seenSoBike[soKey] = { qty, itemId };
        bikeMap[parentId].qtySold += qty;
      } else if (itemId < seenSoBike[soKey].itemId) {
        bikeMap[parentId].qtySold -= seenSoBike[soKey].qty;
        bikeMap[parentId].qtySold += qty;
        seenSoBike[soKey] = { qty, itemId };
      }
    };

    while (true) {
      const page = resultSet.getRange({ start, end: start + PAGE_SIZE });
      if (!page || page.length === 0) break;
      page.forEach(processRow);
      if (page.length < PAGE_SIZE) break;  // last page
      start += PAGE_SIZE;
    }

    // Attach cost + margin per bike (cost = totalAvgCost * qty sold)
    Object.values(bikeMap).forEach(b => {
      b.cost   = (costMap[b.itemId] || 0) * b.qtySold;
      b.margin = b.revenue > 0 ? ((b.revenue - b.cost) / b.revenue) * 100 : 0;
    });

    return Object.values(bikeMap)
      .sort((a, b) => b.qtySold - a.qtySold)
      .slice(0, limit);
  };

  /* ══════════════════════════════════════════════════════════
     HTML RENDERER
  ══════════════════════════════════════════════════════════ */
  const buildHTML = (bikes, topSelling, dateFrom, dateTo) => {
    const totalBikes   = bikes.length;
    const buildableSum = bikes.reduce((s, b) => s + b.buildableQty, 0);
    const lowStock     = bikes.filter(b => b.buildableQty <= 2).length;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bike Inventory Dashboard</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Oracle Sans', 'Segoe UI', Arial, sans-serif;
         background: #F5F5F5; color: #222; }

  /* ── Header ─────────────────────────── */
  .ns-header {
    background: #003764;
    padding: 20px 28px;
    display: flex; align-items: center; justify-content: space-between;
  }
  .ns-header h1 { color: #fff; font-size: 20px; font-weight: 600; }
  .ns-header .sub { color: #B8D4E8; font-size: 13px; margin-top: 4px; }
  .ns-logo { color: #B8D4E8; font-size: 26px; }

  /* ── KPI Strip ──────────────────────── */
  .kpi-strip {
    display: flex; gap: 16px; padding: 20px 28px;
    flex-wrap: wrap;
  }
  .kpi-card {
    background: #fff; border: 1px solid #D9D9D9; border-radius: 8px;
    padding: 18px 24px; min-width: 160px; flex: 1;
  }
  .kpi-label {
    font-size: 11px; color: #6B6B6B; text-transform: uppercase;
    letter-spacing: .5px; margin-bottom: 8px;
  }
  .kpi-value { font-size: 30px; font-weight: 700; color: #003764; }
  .kpi-sub   { font-size: 12px; margin-top: 4px; }
  .green  { color: #3D7A41; } .red { color: #D64700; } .amber { color: #B95C00; }

  /* ── Section wrapper ────────────────── */
  .section {
    background: #fff; border: 1px solid #D9D9D9; border-radius: 8px;
    margin: 0 28px 24px; overflow: hidden;
  }
  .section-header {
    background: #003764; color: #fff;
    padding: 12px 20px; font-size: 14px; font-weight: 600;
    display: flex; align-items: center; gap: 8px;
  }
  .section-header .badge {
    background: #5B8DB1; color: #fff; border-radius: 12px;
    padding: 2px 10px; font-size: 11px; font-weight: 500;
  }

  /* ── Bike accordion card ────────────── */
  .bike-card { border-bottom: 1px solid #D9D9D9; }
  .bike-card:last-child { border-bottom: none; }

  .bike-header {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 20px; cursor: pointer; background: #fff;
    transition: background .15s;
  }
  .bike-header:hover { background: #f0f7ff; }

  .bike-icon { font-size: 22px; }
  .bike-name { font-weight: 600; font-size: 14px; color: #003764; flex: 1; }
  .bike-sku  { font-size: 11px; color: #888; }

  .bike-chips { display: flex; gap: 8px; margin-left: auto; flex-wrap: wrap; align-items: center; }
  .chip {
    border-radius: 20px; padding: 3px 12px;
    font-size: 11px; font-weight: 600; white-space: nowrap;
  }
  .chip-cost     { background: #E8F0FB; color: #003764; }
  .chip-build    { color: #fff; }
  .chip-build.good  { background: #3D7A41; }
  .chip-build.warn  { background: #B95C00; }
  .chip-build.crit  { background: #D64700; }

  .toggle-icon { color: #5B8DB1; font-size: 18px; margin-left: 8px; }

  /* ── Component table ────────────────── */
  .comp-panel { display: none; padding: 0 20px 16px 52px; }
  .comp-panel.open { display: block; }

  table.comp-table {
    width: 100%; border-collapse: collapse;
    font-size: 13px; margin-top: 8px;
  }
  .comp-table th {
    text-align: left; padding: 8px 12px;
    background: #EBF2F8; color: #003764;
    font-size: 11px; text-transform: uppercase; letter-spacing: .4px;
    border-bottom: 2px solid #B8D4E8;
  }
  .comp-table td { padding: 8px 12px; border-bottom: 1px solid #EBEBEB; }
  .comp-table tr:last-child td { border-bottom: none; }
  .comp-table tr:hover td { background: #F5FAFF; }

  .qty-pill {
    display: inline-block; border-radius: 12px; padding: 2px 10px;
    font-weight: 600; font-size: 12px;
  }
  .qty-pill.g { background: #DFEFD9; color: #3D7A41; }
  .qty-pill.a { background: #FFF0DC; color: #B95C00; }
  .qty-pill.r { background: #FFE5E0; color: #D64700; }

  .total-row td { font-weight: 700; background: #EBF2F8; color: #003764; }

  /* ── Top Selling table ──────────────── */
  table.top-table {
    width: 100%; border-collapse: collapse; font-size: 13px;
  }
  .top-table th {
    text-align: left; padding: 10px 16px;
    background: #EBF2F8; color: #003764;
    font-size: 11px; text-transform: uppercase; letter-spacing: .4px;
    border-bottom: 2px solid #B8D4E8;
  }
  .top-table td { padding: 10px 16px; border-bottom: 1px solid #EBEBEB; }
  .top-table tr:last-child td { border-bottom: none; }
  .top-table tr:hover td { background: #F5FAFF; }
  .rank-badge {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; border-radius: 50%;
    font-size: 11px; font-weight: 700;
  }
  .rank-1 { background: #FFD700; color: #7A5800; }
  .rank-2 { background: #C0C0C0; color: #555; }
  .rank-3 { background: #CD7F32; color: #fff; }
  .rank-n { background: #E8F0FB; color: #003764; }

  .bar-wrap { background: #EBEBEB; border-radius: 4px; height: 8px;
              width: 120px; display: inline-block; vertical-align: middle; margin-left: 8px; }
  .bar-fill { height: 8px; border-radius: 4px; background: #5B8DB1; }

  /* ── Chart ──────────────────────────── */
  .chart-wrap {
    padding: 24px 28px;
    border-bottom: 1px solid #D9D9D9;
  }
  .chart-tabs {
    display: flex; gap: 6px; margin-bottom: 16px;
  }
  .chart-tab {
    padding: 5px 16px; border-radius: 20px; font-size: 12px; font-weight: 600;
    border: 1px solid #D9D9D9; background: #fff; cursor: pointer; color: #555;
    transition: all .15s;
  }
  .chart-tab.active { background: #003764; color: #fff; border-color: #003764; }

  /* ── Footer ─────────────────────────── */
  .footer {
    text-align: center; padding: 16px; color: #aaa; font-size: 11px;
  }
</style>
</head>
<body>

<!-- ══ HEADER ══════════════════════════════════════════════ -->
<div class="ns-header">
  <div>
    <h1>🚲 Bike Inventory &amp; Cost Dashboard</h1>
    <div class="sub">Non-Inventory Parent Items · Component Stock · Buildable Qty · Top Sales</div>
  </div>
  <div class="ns-logo">🏢</div>
</div>

<!-- ══ KPI STRIP ════════════════════════════════════════════ -->
<div class="kpi-strip">
  <div class="kpi-card">
    <div class="kpi-label">Total Bike Models</div>
    <div class="kpi-value">${totalBikes}</div>
    <div class="kpi-sub" style="color:#5B8DB1">Active parent items</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">Total Buildable Units</div>
    <div class="kpi-value">${buildableSum}</div>
    <div class="kpi-sub green">Based on component stock</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">Low / No Stock Models</div>
    <div class="kpi-value ${lowStock > 0 ? 'red' : 'green'}">${lowStock}</div>
    <div class="kpi-sub ${lowStock > 0 ? 'red' : 'green'}">
      ${lowStock > 0 ? '⚠ 2 or fewer buildable' : '✓ All models stocked'}
    </div>
  </div>
</div>

<!-- ══ BIKE CARDS ════════════════════════════════════════════ -->
<div class="section">
  <div class="section-header">
    🚲 Bike Models — Component Costs &amp; Buildable Qty
    <span class="badge">${totalBikes} models</span>
  </div>

  ${bikes.length === 0
    ? `<div style="padding:24px;color:#888;text-align:center">
         No non-inventory items found with <code>${CUSTOM_FIELD}</code> populated.
       </div>`
    : bikes.map((bike, idx) => buildBikeCard(bike, idx)).join('')}
</div>

<!-- ══ DATE FILTER ═════════════════════════════════════════ -->
<div style="margin: 0 28px 16px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
  <form id="dateFilterForm" method="GET" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
    <!-- Preserve NS required URL params so the Suitelet URL stays valid on submit -->
    <input type="hidden" name="script"  id="f_script">
    <input type="hidden" name="deploy"  id="f_deploy">
    <label style="font-size:13px; font-weight:600; color:#003764;">📅 Date Range (Top Selling)</label>
    <input type="date" name="dateFrom" value="${dateFrom}"
      style="border:1px solid #ccc; border-radius:4px; padding:5px 10px; font-size:13px;">
    <span style="font-size:13px; color:#666;">to</span>
    <input type="date" name="dateTo" value="${dateTo}"
      style="border:1px solid #ccc; border-radius:4px; padding:5px 10px; font-size:13px;">
    <button type="submit"
      style="background:#003764; color:#fff; border:none; border-radius:4px;
             padding:6px 18px; font-size:13px; cursor:pointer; font-weight:600;">
      Apply
    </button>
    ${dateFrom || dateTo ? `<a id="clearLink" href="#" style="font-size:12px; color:#D64700; text-decoration:none;">✕ Clear</a>` : ''}
  </form>
  <script>
    // Pull script + deploy from current URL and inject into hidden fields
    (function() {
      const p = new URLSearchParams(window.location.search);
      document.getElementById('f_script').value = p.get('script') || '';
      document.getElementById('f_deploy').value = p.get('deploy') || '';
      // Clear link — keep script+deploy, drop date params
      const cl = document.getElementById('clearLink');
      if (cl) {
        cl.href = '?script=' + encodeURIComponent(p.get('script')||'') +
                  '&deploy=' + encodeURIComponent(p.get('deploy')||'');
      }
    })();
  </script>
  ${dateFrom || dateTo
    ? `<span style="font-size:12px; color:#3D7A41; font-weight:600;">
         ✓ Filtered: ${dateFrom || '…'} → ${dateTo || '…'}
       </span>`
    : `<span style="font-size:12px; color:#aaa;">Showing all time</span>`}
</div>

<!-- ══ TOP SELLING ══════════════════════════════════════════ -->
<div class="section">
  <div class="section-header">
    📈 Top ${TOP_N_BIKES} Best-Selling Bikes
    <span class="badge">by SO qty</span>
  </div>

  ${topSelling.length > 0 ? `
  <!-- Chart -->
  <div class="chart-wrap">
    <div class="chart-tabs">
      <button class="chart-tab active" onclick="switchChart('revenue', this)">Revenue vs Cost</button>
      <button class="chart-tab"        onclick="switchChart('qty',     this)">Qty Sold</button>
      <button class="chart-tab"        onclick="switchChart('margin',  this)">Margin %</button>
    </div>
    <canvas id="bikeChart" height="90"></canvas>
  </div>
  <script>
    const _labels  = ${JSON.stringify(topSelling.map(r => r.displayName || r.itemId))};
    const _revenue = ${JSON.stringify(topSelling.map(r => parseFloat(r.revenue.toFixed(2))))};
    const _cost    = ${JSON.stringify(topSelling.map(r => parseFloat((r.cost||0).toFixed(2))))};
    const _qty     = ${JSON.stringify(topSelling.map(r => r.qtySold))};
    const _margin  = ${JSON.stringify(topSelling.map(r => parseFloat((r.margin||0).toFixed(1))))};

    const chartConfigs = {
      revenue: {
        type: 'bar',
        data: {
          labels: _labels,
          datasets: [
            { label: 'Revenue',   data: _revenue, backgroundColor: '#003764', borderRadius: 4 },
            { label: 'Cost',      data: _cost,    backgroundColor: '#5B8DB1', borderRadius: 4 }
          ]
        },
        options: {
          responsive: true, plugins: { legend: { position: 'top' } },
          scales: { y: { ticks: { callback: v => '$' + v.toLocaleString() } } }
        }
      },
      qty: {
        type: 'bar',
        data: {
          labels: _labels,
          datasets: [{ label: 'Qty Sold', data: _qty, backgroundColor: '#3D7A41', borderRadius: 4 }]
        },
        options: {
          responsive: true, plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true } }
        }
      },
      margin: {
        type: 'bar',
        data: {
          labels: _labels,
          datasets: [{
            label: 'Margin %',
            data: _margin,
            backgroundColor: _margin.map(m => m >= 30 ? '#3D7A41' : m >= 10 ? '#B95C00' : '#D64700'),
            borderRadius: 4
          }]
        },
        options: {
          responsive: true, plugins: { legend: { display: false } },
          scales: { y: { ticks: { callback: v => v + '%' } } }
        }
      }
    };

    let _activeChart = null;
    function switchChart(type, btn) {
      document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      if (_activeChart) _activeChart.destroy();
      _activeChart = new Chart(document.getElementById('bikeChart'), chartConfigs[type]);
    }

    // Init with revenue chart on load
    window.addEventListener('load', () => {
      _activeChart = new Chart(document.getElementById('bikeChart'), chartConfigs.revenue);
    });
  </script>
  ` : ''}

  ${topSelling.length === 0
    ? `<div style="padding:24px;color:#888;text-align:center">
         No closed/billed sales orders found for non-inventory bike items.
       </div>`
    : buildTopTable(topSelling)}
</div>

<div class="footer">
  NetSuite Bike Dashboard · Generated ${new Date().toLocaleString()} ·
  Custom field: <code>${CUSTOM_FIELD}</code>
</div>

<script>
  // Accordion toggle
  document.querySelectorAll('.bike-header').forEach(header => {
    header.addEventListener('click', () => {
      const panel = header.nextElementSibling;
      const icon  = header.querySelector('.toggle-icon');
      const open  = panel.classList.toggle('open');
      icon.textContent = open ? '▲' : '▼';
    });
  });
</script>
</body>
</html>`;
  };

  /* ── Bike accordion card ────────────────────────────────── */
  const buildBikeCard = (bike, idx) => {
    const buildClass = bike.buildableQty === 0 ? 'crit'
                     : bike.buildableQty <= 2   ? 'warn'
                     : 'good';

    const compRows = bike.components.map((c, i) => {
      const qClass = c.onHandQty === 0 ? 'r'
                   : c.onHandQty <= 2   ? 'a'
                   : 'g';
      return `
        <tr>
          <td>${i + 1}</td>
          <td><strong>${escHtml(c.itemId)}</strong></td>
          <td>${escHtml(c.displayName)}</td>
          <td style="text-align:right">$${c.avgCost.toFixed(2)}</td>
          <td style="text-align:center">
            <span class="qty-pill ${qClass}">${c.onHandQty}</span>
          </td>
        </tr>`;
    }).join('');

    return `
<div class="bike-card">
  <div class="bike-header">
    <span class="bike-icon">🚲</span>
    <div>
      <div class="bike-name">${escHtml(bike.displayName)}</div>
      <div class="bike-sku">SKU: ${escHtml(bike.itemId)} &nbsp;|&nbsp; ID: ${bike.id}</div>
    </div>
    <div class="bike-chips">
      <span class="chip chip-cost">💰 Avg Cost: $${bike.totalAvgCost.toFixed(2)}</span>
      <span class="chip chip-build ${buildClass}">
        🔧 Can Build: ${bike.buildableQty}
      </span>
    </div>
    <span class="toggle-icon">▼</span>
  </div>
  <div class="comp-panel" id="panel-${idx}">
    <table class="comp-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Item ID</th>
          <th>Description</th>
          <th style="text-align:right">Avg Cost</th>
          <th style="text-align:center">On Hand</th>
        </tr>
      </thead>
      <tbody>
        ${compRows}
        <tr class="total-row">
          <td colspan="3" style="text-align:right">Total Cost &amp; Min Buildable Qty →</td>
          <td style="text-align:right">$${bike.totalAvgCost.toFixed(2)}</td>
          <td style="text-align:center">
            <span class="qty-pill ${bike.buildableQty === 0 ? 'r' : bike.buildableQty <= 2 ? 'a' : 'g'}">
              ${bike.buildableQty}
            </span>
          </td>
        </tr>
      </tbody>
    </table>
    <p style="font-size:11px;color:#888;margin-top:8px">
      ℹ Buildable qty = minimum on-hand across all components
    </p>
  </div>
</div>`;
  };

  /* ── Top selling table ──────────────────────────────────── */
  const buildTopTable = (rows) => {
    const maxQty = rows[0]?.qtySold || 1;
    const tableRows = rows.map((r, i) => {
      const rankClass = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : 'rank-n';
      const barPct    = Math.round((r.qtySold / maxQty) * 100);
      return `
        <tr>
          <td><span class="rank-badge ${rankClass}">${i + 1}</span></td>
          <td><strong>${escHtml(r.displayName || r.itemId)}</strong></td>
          <td style="text-align:right">
            ${r.qtySold.toLocaleString()} units
            <span class="bar-wrap">
              <span class="bar-fill" style="width:${barPct}%"></span>
            </span>
          </td>
          <td style="text-align:right">$${r.revenue.toLocaleString(undefined, { minimumFractionDigits:2, maximumFractionDigits:2 })}</td>
          <td style="text-align:right">$${(r.cost||0).toLocaleString(undefined, { minimumFractionDigits:2, maximumFractionDigits:2 })}</td>
          <td style="text-align:right">
            <span style="font-weight:700;color:${r.margin >= 30 ? '#3D7A41' : r.margin >= 10 ? '#B95C00' : '#D64700'}">
              ${(r.margin||0).toFixed(1)}%
            </span>
          </td>
        </tr>`;
    }).join('');

    return `
      <table class="top-table">
        <thead>
          <tr>
            <th style="width:40px">#</th>
            <th>Bike Model</th>
            <th style="text-align:right">Qty Sold</th>
            <th style="text-align:right">Total Revenue</th>
            <th style="text-align:right">Total Cost</th>
            <th style="text-align:right">Margin</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>`;
  };

  /* ── Utility ─────────────────────────────────────────────── */
  const escHtml = (str) => String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return { onRequest };
});