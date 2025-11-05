// solver-worker.js - Web Worker for parallel backtracking solver

'use strict';

// Import hex grid utilities (inline since workers can't share scope)
class Hex {
  constructor(q, r) {
    this.q = +q;
    this.r = +r;
    this.s = -this.q - this.r;
  }
  key() { return this.q + ',' + this.r; }
}

function axialToOddQ(h) {
  return { q: h.q, r: h.r + (h.q - (h.q & 1)) / 2 };
}

function oddQToAxial(h) {
  return new Hex(h.q, h.r - (h.q - (h.q & 1)) / 2);
}

function rotateHex(h, steps) {
  const ax = oddQToAxial(h);
  let q = ax.q, r = ax.r, s = ax.s;
  for (let i = 0; i < (steps % 6 + 6) % 6; i++) {
    [q, r, s] = [-r, -s, -q];
  }
  return axialToOddQ(new Hex(q, r));
}

function addHex(a, b) {
  const aa = oddQToAxial(a);
  const bb = oddQToAxial(b);
  const sum = new Hex(aa.q + bb.q, aa.r + bb.r);
  return axialToOddQ(sum);
}

const hexDirections = [
  new Hex(1, 0), new Hex(1, -1), new Hex(0, -1),
  new Hex(-1, 0), new Hex(-1, 1), new Hex(0, 1)
];

// Worker state
let shouldStop = false;
let searchCount = 0;
let bestCoverage = 0;
let topSolutions = []; // All solutions tied for best coverage

// Handle messages from main thread
self.onmessage = function(e) {
  const { type, data } = e.data;

  if (type === 'START') {
    shouldStop = false;
    searchCount = 0;
    bestCoverage = data.initialBestCoverage || 0;
    topSolutions = [];

    // Start searching
    solve(data);
  } else if (type === 'STOP') {
    shouldStop = true;
  } else if (type === 'UPDATE_BEST') {
    // Another worker found a better solution
    if (data.coverage > bestCoverage) {
      bestCoverage = data.coverage;
      topSolutions = []; // Clear our solutions as they're now suboptimal
    }
  }
};

function solve(data) {
  // Expect packed typed arrays from main thread:
  // pieces: [{id,size}], placementsMeta: Int32Array (6 ints per placement), placementsTargets: Int32Array (concatenated targets),
  // piecePlacementStart: Int32Array, piecePlacementCount: Int32Array, assignedPlacementIndices: Int32Array, boardCells: [{q,r}], neighbors: [[idx,..],...]
  const { pieces, boardSize, pieceOrder, workerId, boardCells, neighbors } = data;
  // typed arrays (may arrive as Int32Array objects)
  const placementsMeta = data.placementsMeta instanceof Int32Array ? data.placementsMeta : new Int32Array(data.placementsMeta);
  const placementsTargets = data.placementsTargets instanceof Int32Array ? data.placementsTargets : new Int32Array(data.placementsTargets);
  const piecePlacementStart = data.piecePlacementStart instanceof Int32Array ? data.piecePlacementStart : new Int32Array(data.piecePlacementStart);
  const piecePlacementCount = data.piecePlacementCount instanceof Int32Array ? data.piecePlacementCount : new Int32Array(data.piecePlacementCount);
  const assignedPlacementIndices = data.assignedPlacementIndices instanceof Int32Array ? data.assignedPlacementIndices : new Int32Array(data.assignedPlacementIndices);

  console.log(`worker ${workerId} starting with ${assignedPlacementIndices.length} initial placements`);
  let lastReportTime = Date.now();

  // Occupancy arrays: occupancy holds pieceIdx or -1; depthStamp holds recursion depth when cell was set
  const occupancy = new Int16Array(boardSize);
  for (let i = 0; i < boardSize; i++) occupancy[i] = -1;
  const depthStamp = new Int32Array(boardSize);
  let depth = 0;

  function applyPlacementByIndex(pIdx, pieceIdx) {
    const base = pIdx * 6;
    const tStart = placementsMeta[base + 4];
    const tLen = placementsMeta[base + 5];
    depth++;
    for (let ti = tStart; ti < tStart + tLen; ti++) {
      const cellIdx = placementsTargets[ti];
      occupancy[cellIdx] = pieceIdx;
      depthStamp[cellIdx] = depth;
    }
  }

  function undoPlacementByIndex(pIdx) {
    const base = pIdx * 6;
    const tStart = placementsMeta[base + 4];
    const tLen = placementsMeta[base + 5];
    for (let ti = tStart; ti < tStart + tLen; ti++) {
      const cellIdx = placementsTargets[ti];
      if (depthStamp[cellIdx] === depth) {
        occupancy[cellIdx] = -1;
        depthStamp[cellIdx] = 0;
      }
    }
    depth--;
  }

  function neighborsOccupiedCount(idx) {
    let count = 0;
    const neigh = neighbors[idx] || [];
    for (let j = 0; j < neigh.length; j++) {
      if (occupancy[neigh[j]] !== -1) count++;
    }
    return count;
  }

  function sumRemainingSizes(remainingPieces) {
    let s = 0;
    for (let i = 0; i < remainingPieces.length; i++) s += pieces[remainingPieces[i]].size;
    return s;
  }

  function postProgress() {
    self.postMessage({ type: 'PROGRESS', data: { searchCount, bestCoverage, workerId } });
  }

  function exportSolution(sol) {
    // Convert internal solution items to { piece: pieceId, anchor: {q,r}, rot }
    return sol.map(p => ({ piece: p.pieceId, anchor: boardCells[p.anchorIdx], rot: p.rot }));
  }

  function getSolutionCellSignature(sol) {
    // Create a signature based on which cells are covered by which piece
    // Sort by cell index to create canonical ordering
    const cellToPiece = [];

    for (const placement of sol) {
      const base = placement.pIdx * 6;
      const tStart = placementsMeta[base + 4];
      const tLen = placementsMeta[base + 5];

      for (let ti = tStart; ti < tStart + tLen; ti++) {
        const cellIdx = placementsTargets[ti];
        cellToPiece.push([cellIdx, placement.pieceId]);
      }
    }

    // Sort by cell index to create canonical ordering
    cellToPiece.sort((a, b) => a[0] - b[0]);
    return JSON.stringify(cellToPiece);
  }

  const seenSignatures = new Set();

  function backtrack(remainingPieces, remainingSum, currentSolution, coverage) {
    if (shouldStop) return true;

    searchCount++;
    const now = Date.now();
    if (now - lastReportTime > 1000) {
      lastReportTime = now;
      postProgress();
    }

    if (coverage > bestCoverage) {
      bestCoverage = coverage;
      topSolutions = [exportSolution(currentSolution.slice())];
      seenSignatures.clear();
      seenSignatures.add(getSolutionCellSignature(currentSolution));
    } else if (coverage === bestCoverage && coverage > 0) {
      // Found another solution tied for best
      const signature = getSolutionCellSignature(currentSolution);
      if (!seenSignatures.has(signature)) {
        seenSignatures.add(signature);
        topSolutions.push(exportSolution(currentSolution.slice()));
      }
    }

    if (coverage >= boardSize) return true;    // optimistic bound
    if (coverage + remainingSum <= bestCoverage) return false;

    // Dynamic MRV: pick the remaining piece with the fewest currently-valid placements
    if (remainingPieces.length === 0) return false;

    let bestRi = -1;
    let bestCount = Infinity;

    // Find piece with minimum number of valid placements (stop early if count >= bestCount)
    for (let ri = 0; ri < remainingPieces.length; ri++) {
      const pi = remainingPieces[ri];
      const pStart = piecePlacementStart[pi];
      const pCount = piecePlacementCount[pi];
      let count = 0;
      for (let off = 0; off < pCount; off++) {
        const pIdx = pStart + off;
        const base = pIdx * 6;
        const tStart = placementsMeta[base + 4];
        const tLen = placementsMeta[base + 5];
        let ok = true;
        for (let ti = tStart; ti < tStart + tLen; ti++) {
          if (occupancy[placementsTargets[ti]] !== -1) { ok = false; break; }
        }
        if (ok) {
          count++;
          if (count >= bestCount) break; // no need to count further
        }
      }
      if (count > 0 && count < bestCount) {
        bestCount = count;
        bestRi = ri;
      }
    }

    // If no remaining piece has any valid placement, nothing more to place
    if (bestRi === -1) {
      return false;
    }

    // Compute full valid placement list for chosen piece (with adjacency scores)
    const chosenPi = remainingPieces[bestRi];
    const chosenStart = piecePlacementStart[chosenPi];
    const chosenCount = piecePlacementCount[chosenPi];
    const valid = [];
    for (let off = 0; off < chosenCount; off++) {
      const pIdx = chosenStart + off;
      const base = pIdx * 6;
      const tStart = placementsMeta[base + 4];
      const tLen = placementsMeta[base + 5];
      let ok = true;
      for (let ti = tStart; ti < tStart + tLen; ti++) {
        if (occupancy[placementsTargets[ti]] !== -1) { ok = false; break; }
      }
      if (!ok) continue;
      let adj = 0;
      for (let ti = tStart; ti < tStart + tLen; ti++) {
        adj += neighborsOccupiedCount(placementsTargets[ti]);
      }
      valid.push({ pIdx, adj });
    }

    if (valid.length === 0) return false;
    valid.sort((a, b) => b.adj - a.adj);

    // Try placements for the chosen (most constrained) piece
    for (let vi = 0; vi < valid.length; vi++) {
      if (shouldStop) return true;
      const pIdx = valid[vi].pIdx;
      applyPlacementByIndex(pIdx, chosenPi);
      const base = pIdx * 6;
      const pieceId = placementsMeta[base + 1];
      const anchorIdx = placementsMeta[base + 2];
      const rot = placementsMeta[base + 3];
      currentSolution.push({ pieceId, anchorIdx, rot, pIdx });
      const newRemaining = remainingPieces.slice(0, bestRi).concat(remainingPieces.slice(bestRi + 1));
      const newRemainingSum = remainingSum - pieces[chosenPi].size;
      const stopped = backtrack(newRemaining, newRemainingSum, currentSolution, coverage + placementsMeta[base + 5]);
      currentSolution.pop();
      undoPlacementByIndex(pIdx);
      if (stopped) return true;
    }
    return false;
  }

  // initial split: firstPiece
  const firstPieceIdx = pieceOrder[0];
  const remainingAfterFirst = pieceOrder.slice(1);
  const remainingAfterFirstSum = sumRemainingSizes(remainingAfterFirst);

  for (let ip = 0; ip < assignedPlacementIndices.length; ip++) {
    if (shouldStop) break;
    const pIdx = assignedPlacementIndices[ip];
    // apply initial placement by index
    applyPlacementByIndex(pIdx, firstPieceIdx);
    const base = pIdx * 6;
    const pieceId = placementsMeta[base + 1] || pieces[firstPieceIdx].id;
    const anchorIdx = placementsMeta[base + 2];
    const rot = placementsMeta[base + 3];
    const tLen = placementsMeta[base + 5];
    const initialSolution = [{ pieceId, anchorIdx, rot, pIdx }];
    backtrack(remainingAfterFirst, remainingAfterFirstSum, initialSolution, tLen);
    // undo initial placement fully
    undoPlacementByIndex(pIdx);
    // ensure depth reset
    depth = 0;
  }

  // final report
  self.postMessage({ type: 'COMPLETE', data: { solutions: topSolutions, coverage: bestCoverage, searchCount, workerId } });
}
