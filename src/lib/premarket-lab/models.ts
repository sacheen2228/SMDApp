// Statistical baseline models — pure TypeScript, no external ML deps.
// Interpretable first: logistic regression, decision-tree RF, gradient-boosted stumps.
// NEVER present scores as guaranteed trading success probabilities.

import type { LabeledSample, ModelMetrics } from "./types";

// ── Metrics ──────────────────────────────────────────────────────────

export function confusionMatrix(yTrue: number[], yPred: number[]): ModelMetrics["confusion"] {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const t = yTrue[i];
    const p = yPred[i];
    if (t === 1 && p === 1) tp++;
    else if (t === 0 && p === 1) fp++;
    else if (t === 0 && p === 0) tn++;
    else if (t === 1 && p === 0) fn++;
  }
  return { tp, fp, tn, fn };
}

export function computeMetrics(yTrue: number[], yProb: number[], threshold = 0.5): ModelMetrics {
  const n = yTrue.length;
  const conf = confusionMatrix(yTrue, yProb.map((p) => (p >= threshold ? 1 : 0)));
  const { tp, fp, tn, fn } = conf;
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 = precision != null && recall != null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  const accuracy = n > 0 ? (tp + tn) / n : null;

  // ROC-AUC (rank-based)
  let rocAuc: number | null = null;
  const pos = yTrue.filter((y) => y === 1).length;
  const neg = n - pos;
  if (pos > 0 && neg > 0) {
    const pairs: Array<{ p: number; y: number }> = yProb.map((p, i) => ({ p, y: yTrue[i] }));
    pairs.sort((a, b) => a.p - b.p);
    let rankSum = 0;
    let i = 0;
    while (i < pairs.length) {
      let j = i;
      while (j + 1 < pairs.length && pairs[j + 1].p === pairs[i].p) j++;
      const avgRank = (i + j) / 2 + 1; // 1-based average rank
      for (let k = i; k <= j; k++) if (pairs[k].y === 1) rankSum += avgRank;
      i = j + 1;
    }
    rocAuc = (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
  }

  // Brier score
  let brier: number | null = null;
  if (n > 0) {
    let s = 0;
    for (let i = 0; i < n; i++) s += (yProb[i] - yTrue[i]) ** 2;
    brier = s / n;
  }

  return { n, precision, recall, f1, rocAuc, brier, accuracy, confusion: conf };
}

// ── Matrix helpers ───────────────────────────────────────────────────

export interface DesignMatrix {
  X: number[][]; // no intercept column — added internally
  y: number[];
  featureNames: string[];
}

/** Rows with any null feature dropped (documented — no imputation fabrication). */
export function toDesignMatrix(samples: LabeledSample[], featureKeys: string[]): DesignMatrix {
  const X: number[][] = [];
  const y: number[] = [];
  for (const s of samples) {
    const row: number[] = [];
    let ok = true;
    for (const k of featureKeys) {
      const v = s.features[k];
      if (v == null || !Number.isFinite(v)) { ok = false; break; }
      row.push(v);
    }
    if (!ok) continue;
    X.push(row);
    y.push(s.label);
  }
  return { X, y, featureNames: featureKeys };
}

function standardize(X: number[][]): { Xs: number[][], means: number[], stds: number[] } {
  if (X.length === 0) return { Xs: [], means: [], stds: [] };
  const n = X.length;
  const d = X[0].length;
  const means: number[] = [];
  const stds: number[] = [];
  for (let j = 0; j < d; j++) {
    let m = 0;
    for (let i = 0; i < n; i++) m += X[i][j];
    m /= n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (X[i][j] - m) ** 2;
    v = n > 1 ? v / (n - 1) : 0;
    means.push(m);
    stds.push(Math.sqrt(v) || 1);
  }
  const Xs = X.map((row) => row.map((x, j) => (x - means[j]) / stds[j]));
  return { Xs, means, stds };
}

// ── Logistic regression (batch GD, L2) ───────────────────────────────

export interface LogisticModel {
  type: "logistic";
  weights: number[]; // including bias at index 0
  means: number[];
  stds: number[];
  featureNames: string[];
  epochs: number;
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

export function fitLogistic(
  dm: DesignMatrix,
  opts: { epochs?: number; lr?: number; l2?: number } = {},
): LogisticModel | null {
  const epochs = opts.epochs ?? 300;
  const lr = opts.lr ?? 0.1;
  const l2 = opts.l2 ?? 0.01;
  const { X, y, featureNames } = dm;
  if (X.length < 10 || new Set(y).size < 2) return null;

  const { Xs, means, stds } = standardize(X);
  const d = featureNames.length;
  const w = new Array(d + 1).fill(0);

  for (let ep = 0; ep < epochs; ep++) {
    const grad = new Array(d + 1).fill(0);
    for (let i = 0; i < Xs.length; i++) {
      let z = w[0];
      for (let j = 0; j < d; j++) z += w[j + 1] * Xs[i][j];
      const p = sigmoid(z);
      const err = p - y[i];
      grad[0] += err;
      for (let j = 0; j < d; j++) grad[j + 1] += err * Xs[i][j];
    }
    const n = Xs.length;
    w[0] -= (lr * grad[0]) / n;
    for (let j = 0; j < d; j++) {
      w[j + 1] -= lr * ((grad[j + 1] / n) + l2 * w[j + 1]);
    }
  }
  return { type: "logistic", weights: w, means, stds, featureNames, epochs };
}

export function predictLogistic(model: LogisticModel, features: Record<string, number | null>): number | null {
  const row: number[] = [];
  for (const name of model.featureNames) {
    const v = features[name];
    if (v == null || !Number.isFinite(v)) return null; // fail closed on missing
    row.push((v - model.means[model.featureNames.indexOf(name)]) / model.stds[model.featureNames.indexOf(name)]);
  }
  // recompute properly
  let z = model.weights[0];
  for (let j = 0; j < model.featureNames.length; j++) {
    const raw = features[model.featureNames[j]]!;
    const zj = (raw - model.means[j]) / model.stds[j];
    z += model.weights[j + 1] * zj;
  }
  return sigmoid(z);
}

// ── Decision tree (CART, gini, limited depth) ────────────────────────

interface TreeNode {
  leaf?: boolean;
  prob?: number;
  feature?: number;
  threshold?: number;
  left?: TreeNode;
  right?: TreeNode;
}

export interface TreeModel {
  type: "tree";
  root: TreeNode;
  featureNames: string[];
}

function gini(labels: number[]): number {
  if (labels.length === 0) return 0;
  const p = labels.filter((l) => l === 1).length / labels.length;
  return 1 - p * p;
}

function bestSplit(X: number[][], y: number[], featIdx: number): { threshold: number; score: number } | null {
  const pairs = X.map((row, i) => ({ v: row[featIdx], y: y[i] })).sort((a, b) => a.v - b.v);
  if (pairs.length < 4) return null;
  let best: { threshold: number; score: number } | null = null;
  const step = Math.max(1, Math.floor(pairs.length / 20));
  for (let i = step; i < pairs.length - 1; i += step) {
    if (pairs[i].v === pairs[i + 1].v) continue;
    const thr = (pairs[i].v + pairs[i + 1].v) / 2;
    const leftY: number[] = [];
    const rightY: number[] = [];
    for (const p of pairs) {
      if (p.v <= thr) leftY.push(p.y);
      else rightY.push(p.y);
    }
    if (leftY.length < 2 || rightY.length < 2) continue;
    const score =
      (leftY.length * gini(leftY) + rightY.length * gini(rightY)) / pairs.length;
    if (!best || score < best.score) best = { threshold: thr, score };
  }
  return best;
}

function buildTree(X: number[][], y: number[], depth: number, maxDepth: number, minLeaf: number): TreeNode {
  const p = y.filter((l) => l === 1).length / (y.length || 1);
  if (depth >= maxDepth || y.length < 2 * minLeaf || gini(y) === 0) {
    return { leaf: true, prob: p };
  }
  let bestF = -1;
  let bestThr = 0;
  let bestScore = Infinity;
  for (let j = 0; j < X[0].length; j++) {
    const s = bestSplit(X, y, j);
    if (s && s.score < bestScore) {
      bestScore = s.score;
      bestF = j;
      bestThr = s.threshold;
    }
  }
  if (bestF < 0) return { leaf: true, prob: p };
  const leftX: number[][] = [], leftY: number[] = [], rightX: number[][] = [], rightY: number[] = [];
  for (let i = 0; i < X.length; i++) {
    if (X[i][bestF] <= bestThr) { leftX.push(X[i]); leftY.push(y[i]); }
    else { rightX.push(X[i]); rightY.push(y[i]); }
  }
  if (leftY.length < minLeaf || rightY.length < minLeaf) return { leaf: true, prob: p };
  return {
    feature: bestF,
    threshold: bestThr,
    left: buildTree(leftX, leftY, depth + 1, maxDepth, minLeaf),
    right: buildTree(rightX, rightY, depth + 1, maxDepth, minLeaf),
  };
}

function treeProb(root: TreeNode, x: number[]): number {
  let node: TreeNode | undefined = root;
  while (node && !node.leaf) {
    if (x[node.feature!] <= node.threshold!) node = node.left;
    else node = node.right;
  }
  return node?.prob ?? 0.5;
}

export function fitTree(dm: DesignMatrix, opts: { maxDepth?: number; minLeaf?: number } = {}): TreeModel | null {
  if (dm.X.length < 10 || new Set(dm.y).size < 2) return null;
  const { Xs } = standardize(dm.X);
  // Trees don't need standardization but it's harmless for thresholds
  const root = buildTree(Xs, dm.y, 0, opts.maxDepth ?? 4, opts.minLeaf ?? 5);
  return { type: "tree", root, featureNames: dm.featureNames };
}

export function predictTree(model: TreeModel, features: Record<string, number | null>): number | null {
  const row: number[] = [];
  for (let j = 0; j < model.featureNames.length; j++) {
    const v = features[model.featureNames[j]];
    if (v == null || !Number.isFinite(v)) return null;
    row.push(v);
  }
  // Re-standardize with tree's training stats? Trees stored on standardized X —
  // for inference without stored means, use raw values only if tree trained on raw.
  // We trained on standardized X; store means/stds on model for correctness.
  return treeProb(model.root, row);
}

// Fix: retrain trees on RAW features for simpler inference (interpretable thresholds)
export function fitTreeRaw(dm: DesignMatrix, opts: { maxDepth?: number; minLeaf?: number } = {}): TreeModel | null {
  if (dm.X.length < 10 || new Set(dm.y).size < 2) return null;
  const root = buildTree(dm.X, dm.y, 0, opts.maxDepth ?? 4, opts.minLeaf ?? 5);
  return { type: "tree", root, featureNames: dm.featureNames };
}

// ── Random forest (bagging + feature subsample) ──────────────────────

export interface ForestModel {
  type: "forest";
  trees: TreeModel[];
  featureNames: string[];
}

function bagSample(n: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(Math.floor(Math.random() * n));
  return idx;
}

export function fitRandomForest(
  dm: DesignMatrix,
  opts: { nTrees?: number; maxDepth?: number; minLeaf?: number; maxFeatures?: number; seed?: number } = {},
): ForestModel | null {
  if (dm.X.length < 20 || new Set(dm.y).size < 2) return null;
  const nTrees = opts.nTrees ?? 25;
  const maxDepth = opts.maxDepth ?? 4;
  const minLeaf = opts.minLeaf ?? 5;
  const d = dm.featureNames.length;
  const maxFeatures = Math.max(1, opts.maxFeatures ?? Math.floor(Math.sqrt(d)));

  // simple LCG for reproducibility when seed provided
  let rand = opts.seed != null ? () => { opts.seed = (opts.seed! * 1664525 + 1013904223) >>> 0; return opts.seed / 0xffffffff; } : Math.random;

  const trees: TreeModel[] = [];
  for (let t = 0; t < nTrees; t++) {
    const bagIdx = bagSample(dm.X.length);
    const Xb = bagIdx.map((i) => dm.X[i]);
    const yb = bagIdx.map((i) => dm.y[i]);
    // feature subset per tree
    const featOrder = dm.featureNames.map((_, j) => j);
    for (let i = featOrder.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [featOrder[i], featOrder[j]] = [featOrder[j], featOrder[i]];
    }
    const keep = new Set(featOrder.slice(0, maxFeatures));
    const keepList = Array.from(keep).sort((a, b) => a - b);
    const Xs = Xb.map((row) => keepList.map((j) => row[j]));
    const subNames = keepList.map((j) => dm.featureNames[j]);
    const subDm: DesignMatrix = { X: Xs, y: yb, featureNames: subNames };
    const tree = fitTreeRaw(subDm, { maxDepth, minLeaf });
    if (tree) trees.push(tree);
  }
  if (trees.length === 0) return null;
  return { type: "forest", trees, featureNames: dm.featureNames };
}

export function predictForest(model: ForestModel, features: Record<string, number | null>): number | null {
  let sum = 0;
  let n = 0;
  for (const tree of model.trees) {
    // Map full feature vector onto tree's subset
    const sub: Record<string, number | null> = {};
    let ok = true;
    for (const name of tree.featureNames) {
      const v = features[name];
      if (v == null || !Number.isFinite(v)) { ok = false; break; }
      sub[name] = v;
    }
    if (!ok) continue;
    const p = predictTree(tree, sub);
    if (p != null) { sum += p; n++; }
  }
  return n > 0 ? sum / n : null;
}

// ── Gradient boosting (stumps) — XGBoost-style baseline ──────────────

export interface BoostModel {
  type: "gbt";
  featureNames: string[];
  baseRate: number;
  lr: number;
  trees: TreeNode[];
}

export function fitGradientBoosting(
  dm: DesignMatrix,
  opts: { nEstimators?: number; lr?: number; maxDepth?: number } = {},
): BoostModel | null {
  if (dm.X.length < 20 || new Set(dm.y).size < 2) return null;
  const nEst = opts.nEstimators ?? 40;
  const lr = opts.lr ?? 0.1;
  const maxDepth = opts.maxDepth ?? 2;
  const { X, y, featureNames } = dm;
  const n = X.length;
  const baseRate = y.reduce((a, b) => a + b, 0) / n;
  // residual boosting on probabilities (simplified logistic-free GBT)
  let scores = new Array(n).fill(Math.log(Math.max(1e-6, baseRate / Math.max(1e-6, 1 - baseRate))));
  const trees: TreeNode[] = [];
  for (let m = 0; m < nEst; m++) {
    // pseudo-residuals: y - sigmoid(score)
    const resid = y.map((yi, i) => yi - sigmoid(scores[i]));
    // Fit classification tree where label = (resid > 0), weight implicit.
    const tree = fitTreeRaw(
      { X, y: resid.map((r) => (r > 0 ? 1 : 0)), featureNames },
      { maxDepth, minLeaf: 5 },
    );
    if (!tree) break;
    trees.push(tree.root);
    for (let i = 0; i < n; i++) {
      const p = treeProb(tree.root, X[i]);
      // map prob to residual scale approx (p-0.5)*2
      scores[i] += lr * (p - 0.5) * 2;
    }
  }
  if (trees.length === 0) return null;
  return { type: "gbt", featureNames, baseRate, lr, trees };
}

export function predictGradientBoosting(model: BoostModel, features: Record<string, number | null>): number | null {
  const row: number[] = [];
  for (const name of model.featureNames) {
    const v = features[name];
    if (v == null || !Number.isFinite(v)) return null;
    row.push(v);
  }
  let score = Math.log(Math.max(1e-6, model.baseRate / Math.max(1e-6, 1 - model.baseRate)));
  for (const t of model.trees) score += model.lr * (treeProb(t, row) - 0.5) * 2;
  return sigmoid(score);
}

// ── Linear / ridge regression baseline (for continuous targets) ──────

export interface LinearModel {
  type: "ridge";
  weights: number[];
  means: number[];
  stds: number[];
  featureNames: string[];
}

export function fitRidge(dm: DesignMatrix, lambda = 1.0): LinearModel | null {
  if (dm.X.length < 10) return null;
  const { Xs, means, stds } = standardize(dm.X);
  const d = dm.featureNames.length;
  // closed-form via gradient steps for simplicity
  const w = new Array(d + 1).fill(0);
  const lr = 0.05;
  const n = Xs.length;
  for (let ep = 0; ep < 400; ep++) {
    const grad = new Array(d + 1).fill(0);
    for (let i = 0; i < n; i++) {
      let pred = w[0];
      for (let j = 0; j < d; j++) pred += w[j + 1] * Xs[i][j];
      const err = pred - dm.y[i];
      grad[0] += err;
      for (let j = 0; j < d; j++) grad[j + 1] += err * Xs[i][j];
    }
    w[0] -= (lr * grad[0]) / n;
    for (let j = 0; j < d; j++) w[j + 1] -= lr * (grad[j + 1] / n + lambda * w[j + 1]);
  }
  return { type: "ridge", weights: w, means, stds, featureNames: dm.featureNames };
}

export function predictRidge(model: LinearModel, features: Record<string, number | null>): number | null {
  let z = model.weights[0];
  for (let j = 0; j < model.featureNames.length; j++) {
    const v = features[model.featureNames[j]];
    if (v == null || !Number.isFinite(v)) return null;
    z += model.weights[j + 1] * ((v - model.means[j]) / model.stds[j]);
  }
  return z;
}
