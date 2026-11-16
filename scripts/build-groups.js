var fs = require("fs");
var path = require("path");

function r(p) { return path.resolve(p); }

var SNAPSHOT_PATH = r("skills/nse-options-signal/data/live/snapshot.json");
var GROUPS_OUTPUT = path.resolve("data/groups.json");
var SKILL_GROUPS = path.resolve("skills/nse-options-signal/data/groups.js");

var snap = fs.readFileSync(SNAPSHOT_PATH, "utf8");
var data = JSON.parse(snap);

function n(v) { return Number(v) || 0; }
function boothas(v) { return v !== null && v !== undefined ? v : false; }

function computeHeatmap(d) {
  var heatmap = d.heatmap_nifty50;
  var n = heatmap ? heatmap.length : 0;
  var totalCap = 0;
  var green = 0;
  var red = 0;
  if (heatmap) {
    for (var i = 0; i < heatmap.length; i++) {
      var h = heatmap[i];
      nCap += h.volume || 0;
      if ((h.priceChange || 0) >= 0) green++;
      else red++;
    }
  }
  var top3 = heatmap ? heatmap.sort(function(a, b) { return (b.volume || 0) - (a.volume || 0) }).slice(0, 3) : [];
  var top3Share = totalCap > 0 ? top3.reduce(function(s, h) { return s + (h.volume || 0); }, 0) / totalCap / 3 * 100 : 0;
  var wR = 0;
  ;if (totalCap > 0 && heatmap) {
  ;for (var i = 0; i < heatmap.length; i++) {
  ;wR += heatmap[i].priceChange || 0;
  }
  ;wR = wR / totalCap * 100;
  return {
    weighted_return_pct: wR,
    pct_weight_green: n > 0 ? green / n * 100 : 0,
    sensex_weighted_pct: 0,
    top3_share_pct: Math.round(top3Share),
    sector_rotation_aligned: false,
  };
}

function computeOiSpurts(d) {
  ;var bullish = 0, bearish = 0, total = 0;
  ;["oi_spurts_underlyings", "oi_spurts_contracts"].forEach(function(key) {
  ;var arr = d[key];
  ;if (Array.isArray(arr)) {
  ;arr.forEach(function(u) {
  ;var oiChange = u.oiChange ?? 0;
  ;if (oiChange > 0) bullish += oiChange;
  ;else bearish += Math.abs(oiChange);
  ;total += Math.abs(oiChange);
  }
  }
  )
  ;var mostActiveBias = total > 0 ? (bullish > bearish ? 3 : bearish > bullish ? -3 : 0) : 0;
  return { bullish_weight: bullish, bearish_weight: bearish, total_weight: total, most_active_bias: mostActiveBias };
}

function computePreopen(d) {
  ;var pre = d.preopen;
  ;var gapPct = pre ? n(pre.gap_pct) : 0;
  ;var adRatio = pre ? n(pre.ad_ratio) : 0;
  ;var closeAuctionBias = 0;
  ;var ca = d.closing_auction;
  ;if (ca && ca.data && ca.data.length > 0) {
  ;closeAuctionBias = 0;
  }
  return { gap_pct: gapPct, ad_ratio: adRatio, close_auction_bias: closeAuctionBias };
}

function computeWeek52(d) {
  ;var weekly = d.week52_high;
  ;var arr = weekly ? weekly.data : [];
  ;var highCount = 0, lowCount = 0;
  ;if (Array.isArray(arr)) {
  ;arr.forEach(function(row) { if (row.highFlag) highCount++; if (row.lowFlag) lowCount++; });
  }
  ;var gainers = d.gainers;
  ;var heavyweights = [];
  ;if (gainers && Array.isArray(gainers)) {
  ;heavyweights = gainers.slice(0, 3).map(function(g) { return { symbol: g.symbol || "?", side: "gainer", volume_spurt: boothas(g.volume_spurt) }; });
  }
  return {
    high_count: highCount,
    low_count: lowCount,
    heavyweights_at_high: 0,
    sector_cluster_matching_index: false,
    heavyweights: heavyweights,
  };
}

function computeFiibse(d) {
  ;var fii = d.fii_dii;
  ;if (!fii) return { agrees: false };
  ;var agrees = boothas(fii.netPosition > 0);
  return { agrees };
}

var groups = {
  heatmap: computeHeatmap(data),
  oi_spurts: computeOiSpurts(data),
  preopen: computePreopen(data),
  week52: computeWeek52(data),
  heavyweights: [],
  fii_bse: computeFiibse(data),
  news: { unavailable: true },
}

;var GROUPS_OUTPUT = r("data/groups.json");
;var SKILL_GROUPS = r("skills/nse-options-signal/data/groups.js");

fs.writeFileSync(GROUPS_OUTPUT, JSON.stringify(groups, null, 2));
fs.writeFileSync(SKILL_GROUPS, "const groups = " + JSON.stringify(groups) + ";\nmodule.exports = groups;");

console.log("groups written to data/groups.json and skills/nse-options-signal/data/groups.js");
