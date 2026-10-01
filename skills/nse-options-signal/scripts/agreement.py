#!/usr/bin/env python3
"""4-of-8 group agreement + score-ceiling reporting for the NSE Options
Signal skill.

The 8 spec groups (references/scoring-rules.md):
  1 option_chain          25   2 fii/cash-futures        15
  3 greeks                10   4 heatmap (NSE+BSE)       10
  5 oi_spurts             12   6 breadth/gainers         10
  7 preopen/close          8   8 week52                  10

Rules:
  - A group counts only if its data is AVAILABLE and its score is computable.
  - Missing groups never count as agreement (not bullish, not bearish).
  - groups_available < 4            -> gate (no trade)
  - groups agreeing with direction < 4 -> gate (no trade)
  - SCORE_CEILING_DETECTED is reported, thresholds are NEVER altered.
"""

GROUPS = [
    {"key": "option_chain", "label": "Option chain / PCR", "spec_weight": 25, "spec_min": -25, "spec_max": 25, "impl_min": -24, "impl_max": 24},
    {"key": "fii", "label": "FII cash/futures", "spec_weight": 15, "spec_min": -15, "spec_max": 15, "impl_min": -9, "impl_max": 9},
    {"key": "greeks", "label": "Greeks / IV / GEX", "spec_weight": 10, "spec_min": -10, "spec_max": 10, "impl_min": -6, "impl_max": 6},
    {"key": "heatmap", "label": "Heatmap breadth", "spec_weight": 10, "spec_min": -10, "spec_max": 10, "impl_min": -10, "impl_max": 10},
    {"key": "oi_spurts", "label": "OI spurts", "spec_weight": 12, "spec_min": -12, "spec_max": 12, "impl_min": -12, "impl_max": 12},
    {"key": "breadth", "label": "Gainers/losers breadth", "spec_weight": 10, "spec_min": -10, "spec_max": 10, "impl_min": -10, "impl_max": 10},
    {"key": "preopen", "label": "Pre-open / close auction", "spec_weight": 8, "spec_min": -8, "spec_max": 8, "impl_min": -8, "impl_max": 8},
    {"key": "week52", "label": "52-week highs/lows", "spec_weight": 10, "spec_min": -10, "spec_max": 10, "impl_min": -10, "impl_max": 10},
]

GROUPS_TOTAL = len(GROUPS)

THRESHOLD_BUY_CE = 40
THRESHOLD_BUY_PE = -40
MIN_AVAILABLE = 4
MIN_AGREEING = 4


def _sign_direction(score):
    if score >= THRESHOLD_BUY_CE:
        return "BULLISH"
    if score <= THRESHOLD_BUY_PE:
        return "BEARISH"
    # prospective direction when score is positive/negative but below threshold
    return "BULLISH" if score > 0 else ("BEARISH" if score < 0 else "NEUTRAL")


def tally_groups(component_scores, availability):
    """component_scores: {group_key: numeric score|None}
    availability: {group_key: bool} - True only if data present AND score computed.
    Returns the `agreement` block (section 20)."""
    scores = dict(component_scores or {})
    avail_map = dict(availability or {})
    # direction computed from the sum of available group scores
    total = 0.0
    any_available = False
    for group in GROUPS:
        key = group["key"]
        value = scores.get(key)
        if avail_map.get(key) and isinstance(value, (int, float)):
            total += value
            any_available = True
    direction = _sign_direction(total) if any_available else "NEUTRAL"

    bullish = bearish = neutral = available = 0
    missing = []
    for group in GROUPS:
        key = group["key"]
        value = scores.get(key)
        if avail_map.get(key) and isinstance(value, (int, float)):
            available += 1
            if value > 0:
                bullish += 1
            elif value < 0:
                bearish += 1
            else:
                neutral += 1
        else:
            missing.append(key)

    agreeing = {"BULLISH": bullish, "BEARISH": bearish}.get(direction, 0)
    gate_passed = available >= MIN_AVAILABLE and agreeing >= MIN_AGREEING
    return {
        "groups_total": GROUPS_TOTAL,
        "groups_available": available,
        "groups_bullish": bullish,
        "groups_bearish": bearish,
        "groups_neutral": neutral,
        "groups_missing": missing,
        "direction": direction,
        "groups_agreeing": agreeing,
        "gate_passed": gate_passed,
        "gate": ("PASS %d/%d available, %d agreeing with %s"
                 % (available, GROUPS_TOTAL, agreeing, direction)) if gate_passed
                else ("FAIL %d/8 available (need >=4), %d agreeing with %s (need >=4)"
                      % (available, agreeing, direction)),
    }


def agreement_gate(tally):
    """Return (passed, gate_string)."""
    return bool(tally.get("gate_passed")), tally.get("gate", "")


def ceiling_report(component_scores, availability, threshold_up=THRESHOLD_BUY_CE,
                   threshold_down=THRESHOLD_BUY_PE):
    """SCORE_CEILING_DETECTED (report only - thresholds never change).

    achievable_max/min: sum of spec bounds over groups that are actually
    available+computable. If achievable_max < +40 (or achievable_min > -40)
    the corresponding BUY side is structurally unreachable at the mandated
    thresholds -> detected=True with the suppressing groups listed.
    """
    achievable_max = 0
    achievable_min = 0
    implemented_note = {}
    suppressors_up, suppressors_down, unavailable = [], [], []
    for group in GROUPS:
        key = group["key"]
        value = (component_scores or {}).get(key)
        if not (availability or {}).get(key) or not isinstance(value, (int, float)):
            unavailable.append({"group": key, "reason": "data unavailable -> score 0"})
            continue
        lo, hi = group["impl_min"], group["impl_max"]
        if group["impl_max"] < group["spec_max"] or group["impl_min"] > group["spec_min"]:
            implemented_note[key] = ("implemented %+d/%+d of spec %+d/%+d"
                                     % (group["impl_min"], group["impl_max"],
                                        group["spec_min"], group["spec_max"]))
        achievable_max += hi
        achievable_min += lo
        if value < hi:
            suppressors_up.append({"group": key, "value": value, "impl_max": hi})
        if value > lo:
            suppressors_down.append({"group": key, "value": value, "impl_min": lo})

    detected = achievable_max < threshold_up or achievable_min > -abs(threshold_down)
    return {
        "detected": detected,
        "threshold_up": threshold_up,
        "threshold_down": threshold_down,
        "achievable_max": achievable_max,
        "achievable_min": achievable_min,
        "unavailable_groups": unavailable,
        "partial_implementations": implemented_note,
        "below_up_threshold_components": suppressors_up,
        "above_down_threshold_components": suppressors_down,
        "suppressed_below_up_threshold": achievable_max < threshold_up,
        "suppressed_above_down_threshold": achievable_min > -abs(threshold_down),
        "note": ("SCORE_CEILING_DETECTED is informational: report it, do NOT "
                 "lower the +/-40 thresholds, do NOT change weights."),
    }


def ceiling_message(report):
    if not report.get("detected"):
        return None
    return ("SCORE_CEILING_DETECTED: with %d available group(s) the maximum "
            "achievable score is %+d (minimum %+d) against thresholds %+d/%+d. "
            "Buy side unreachable from available data - report only, "
            "thresholds unchanged."
            % (GROUPS_TOTAL - len(report.get("unavailable_groups", [])),
               report.get("achievable_max", 0), report.get("achievable_min", 0),
               report.get("threshold_up", THRESHOLD_BUY_CE),
               report.get("threshold_down", THRESHOLD_BUY_PE)))


if __name__ == "__main__":
    import json, sys
    payload = json.load(open(sys.argv[1]))
    tally = tally_groups(payload.get("components"), payload.get("availability"))
    ceiling = ceiling_report(payload.get("components"), payload.get("availability"))
    print(json.dumps({"agreement": tally, "score_ceiling": ceiling,
                      "ceiling_message": ceiling_message(ceiling)}, indent=2))
